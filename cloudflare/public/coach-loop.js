/**
 * Pure practice-loop relationships and goal-specific paired comparisons.
 *
 * This module deliberately consumes compact coaching summaries only. It never
 * accepts audio, captured transcript text, live frames, or external-model data.
 * Comparisons are descriptive paired measurements, not a universal score or a
 * claim that a speaker improved.
 */

export const ATTEMPT_ROLES = Object.freeze(["standalone", "baseline", "retry"]);
export const FEEDBACK_MODES = Object.freeze(["live-cues", "review-only"]);

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VALID_SCENARIOS = new Set(["interview", "presentation", "impromptu"]);
const VALID_GOALS = new Set(["pace", "pauses", "energy"]);
const MINIMUM_COMPARISON_DURATION_MS = 15_000;
const MAXIMUM_TARGET_DURATION_MS = 180_000;
const MINIMUM_COMPARISON_COVERAGE = 0.75;

export function createPracticeLoop(idFactory = randomOpaqueId) {
  const practiceLoopId = normalizeOpaqueId(idFactory(), "practiceLoopId");
  return {
    practiceLoopId,
    baselineAttemptId: null,
    attemptRole: "baseline",
    feedbackMode: "review-only",
  };
}

export function createRetryState(baseline) {
  const relationship = normalizeAttemptRelationship(baseline);
  if (!relationship.valid || relationship.attemptRole !== "baseline") {
    throw new TypeError("An unassisted retry requires a valid baseline summary.");
  }
  return {
    practiceLoopId: relationship.practiceLoopId,
    baselineAttemptId: relationship.baselineAttemptId,
    attemptRole: "retry",
    feedbackMode: "review-only",
  };
}

/** Resolve the relationship fields that are persisted with a finished summary. */
export function relationshipForSummary(state, sessionId) {
  const id = normalizeOpaqueId(sessionId, "sessionId");
  if (!state || state.attemptRole === "standalone") {
    return {
      practiceLoopId: null,
      baselineAttemptId: null,
      attemptRole: "standalone",
      feedbackMode: "live-cues",
    };
  }
  const practiceLoopId = normalizeOpaqueId(state.practiceLoopId, "practiceLoopId");
  if (state.attemptRole === "baseline") {
    return {
      practiceLoopId,
      baselineAttemptId: id,
      attemptRole: "baseline",
      feedbackMode: "review-only",
    };
  }
  if (state.attemptRole === "retry") {
    const baselineAttemptId = normalizeOpaqueId(state.baselineAttemptId, "baselineAttemptId");
    if (baselineAttemptId === id) throw new TypeError("A retry cannot point to itself as its baseline.");
    return {
      practiceLoopId,
      baselineAttemptId,
      attemptRole: "retry",
      feedbackMode: "review-only",
    };
  }
  throw new TypeError("attemptRole must be standalone, baseline, or retry.");
}

/**
 * Normalize summary relationship metadata without throwing. Local/cloud
 * history is untrusted input and malformed records must remain inspectable.
 */
export function normalizeAttemptRelationship(summary = {}) {
  const hasRelationshipFields = [
    "practiceLoopId",
    "baselineAttemptId",
    "attemptRole",
    "feedbackMode",
  ].some((key) => Object.hasOwn(summary || {}, key));

  if (!hasRelationshipFields) {
    return {
      valid: true,
      legacy: true,
      practiceLoopId: null,
      baselineAttemptId: null,
      attemptRole: "standalone",
      feedbackMode: "live-cues",
      reason: "",
    };
  }

  const attemptRole = summary?.attemptRole;
  const feedbackMode = summary?.feedbackMode;
  if (!ATTEMPT_ROLES.includes(attemptRole)) return invalidRelationship("Unknown attempt role.");
  if (!FEEDBACK_MODES.includes(feedbackMode)) return invalidRelationship("Unknown feedback mode.");

  if (attemptRole === "standalone") {
    if (summary.practiceLoopId !== null || summary.baselineAttemptId !== null || feedbackMode !== "live-cues") {
      return invalidRelationship("Standalone attempts cannot belong to a practice loop.");
    }
    return {
      valid: true,
      legacy: false,
      practiceLoopId: null,
      baselineAttemptId: null,
      attemptRole,
      feedbackMode,
      reason: "",
    };
  }

  if (!isOpaqueId(summary.practiceLoopId) || !isOpaqueId(summary.baselineAttemptId)) {
    return invalidRelationship("Paired attempts require valid loop and baseline IDs.");
  }
  if (feedbackMode !== "review-only") {
    return invalidRelationship("Paired attempts must not use live coaching feedback.");
  }
  if (!isOpaqueId(summary.id)) return invalidRelationship("Paired attempts require a valid session ID.");
  if (attemptRole === "baseline" && summary.baselineAttemptId !== summary.id) {
    return invalidRelationship("A baseline must point to its own session ID.");
  }
  if (attemptRole === "retry" && summary.baselineAttemptId === summary.id) {
    return invalidRelationship("A retry cannot point to itself.");
  }
  return {
    valid: true,
    legacy: false,
    practiceLoopId: summary.practiceLoopId,
    baselineAttemptId: summary.baselineAttemptId,
    attemptRole,
    feedbackMode,
    reason: "",
  };
}

export function validateComparablePair(baseline, retry) {
  const baselineRelationship = normalizeAttemptRelationship(baseline);
  const retryRelationship = normalizeAttemptRelationship(retry);
  const reasons = [...attemptSetupLimitations(baseline, "Baseline"), ...attemptSetupLimitations(retry, "Retry")];
  if (!baselineRelationship.valid || baselineRelationship.attemptRole !== "baseline") {
    reasons.push("The first attempt is not a valid baseline.");
  }
  if (!retryRelationship.valid || retryRelationship.attemptRole !== "retry") {
    reasons.push("The second attempt is not a valid retry.");
  }
  if (
    baselineRelationship.valid
    && retryRelationship.valid
    && baselineRelationship.practiceLoopId !== retryRelationship.practiceLoopId
  ) reasons.push("The attempts belong to different practice loops.");
  if (
    baselineRelationship.valid
    && retryRelationship.valid
    && retryRelationship.baselineAttemptId !== baseline?.id
  ) reasons.push("The retry points to a different baseline.");
  if (VALID_SCENARIOS.has(baseline?.scenario) && VALID_SCENARIOS.has(retry?.scenario) && baseline.scenario !== retry.scenario) {
    reasons.push("The speaking scenarios do not match.");
  }
  if (VALID_GOALS.has(baseline?.goal) && VALID_GOALS.has(retry?.goal) && baseline.goal !== retry.goal) {
    reasons.push("The coaching goals do not match.");
  }
  if (validTargetDuration(baseline?.targetDurationMs) && validTargetDuration(retry?.targetDurationMs)
    && Number(baseline.targetDurationMs) !== Number(retry.targetDurationMs)) {
    reasons.push("The target durations do not match.");
  }
  return { comparable: reasons.length === 0, reasons };
}

/** Build a transparent comparison containing only the selected goal's evidence. */
export function compareGoalAttempts(baseline, retry) {
  const validation = validateComparablePair(baseline, retry);
  if (!validation.comparable) {
    return {
      status: "invalid",
      goal: String(baseline?.goal || retry?.goal || ""),
      measures: [],
      guardrails: comparisonGuardrails(baseline, retry),
      reasons: validation.reasons,
      caveats: ["Only linked attempts with the same prompt category, goal, duration, and analysis version are compared."],
    };
  }

  const baselineMetrics = baseline.metrics || {};
  const retryMetrics = retry.metrics || {};
  const goal = baseline.goal;
  const measures = goal === "pace"
    ? paceMeasures(baselineMetrics, retryMetrics)
    : goal === "pauses"
      ? pauseMeasures(baselineMetrics, retryMetrics)
      : goal === "energy"
        ? energyMeasures(baselineMetrics, retryMetrics)
        : [];
  const reasons = evidenceLimitations(baselineMetrics, retryMetrics);
  if (measures.every((measure) => !measure.available)) reasons.push("The selected goal has no comparable measurement in both attempts.");
  return {
    status: reasons.length ? "limited" : "ready",
    goal,
    measures,
    guardrails: comparisonGuardrails(baseline, retry),
    reasons,
    caveats: goalCaveats(goal),
  };
}

/** Group relationships without pairing unrelated attempts by recency. */
export function groupPracticeLoops(sessions = []) {
  const unique = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session?.id || unique.has(session.id)) continue;
    unique.set(session.id, session);
  }

  const standalone = [];
  const unpaired = [];
  const baselineCandidates = new Map();
  const pendingRetries = [];
  for (const session of unique.values()) {
    const relationship = normalizeAttemptRelationship(session);
    if (!relationship.valid) {
      unpaired.push({ session, reason: relationship.reason });
    } else if (relationship.attemptRole === "standalone") {
      standalone.push(session);
    } else if (attemptSetupLimitations(session, "Attempt").length) {
      unpaired.push({ session, reason: attemptSetupLimitations(session, "Attempt").join(" ") });
    } else if (relationship.attemptRole === "baseline") {
      const candidates = baselineCandidates.get(relationship.practiceLoopId) || [];
      candidates.push(session);
      baselineCandidates.set(relationship.practiceLoopId, candidates);
    } else {
      pendingRetries.push(session);
    }
  }

  const baselines = new Map();
  for (const [loopId, candidates] of baselineCandidates) {
    candidates.sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
    const [baseline, ...duplicates] = candidates;
    baselines.set(loopId, { baseline, retries: [] });
    for (const duplicate of duplicates) {
      unpaired.push({ session: duplicate, reason: "This loop already has a baseline." });
    }
  }

  for (const retry of pendingRetries) {
    const relationship = normalizeAttemptRelationship(retry);
    const loop = baselines.get(relationship.practiceLoopId);
    if (!loop || relationship.baselineAttemptId !== loop.baseline.id) {
      unpaired.push({ session: retry, reason: "Its baseline is unavailable." });
      continue;
    }
    const comparison = compareGoalAttempts(loop.baseline, retry);
    if (comparison.status === "invalid") {
      unpaired.push({ session: retry, reason: comparison.reasons.join(" ") });
      continue;
    }
    loop.retries.push({ session: retry, comparison });
  }

  const loops = [...baselines.entries()].map(([id, loop]) => {
    loop.retries.sort((left, right) => compareCreatedAt(left.session, right.session));
    return {
      id,
      baseline: loop.baseline,
      retries: loop.retries,
      status: loop.retries.length ? "complete" : "awaiting-retry",
      latestAt: loop.retries[0]?.session.createdAt || loop.baseline.createdAt,
    };
  }).sort((left, right) => String(right.latestAt).localeCompare(String(left.latestAt)));
  standalone.sort(compareCreatedAt);
  unpaired.sort((left, right) => compareCreatedAt(left.session, right.session));
  return { loops, standalone, unpaired };
}

function paceMeasures(baseline, retry) {
  const baselineTranscript = eligibleTranscript(baseline);
  const retryTranscript = eligibleTranscript(retry);
  return [
    measure("estimated-pace", "Estimated pace", baselineTranscript?.wordsPerMinute, retryTranscript?.wordsPerMinute, "wpm", 0, 2_000),
    measure("longest-speaking-run", "Longest speaking run", baseline.longestSpeakingRunMs, retry.longestSpeakingRunMs, "ms", 0, 600_000),
    measure("median-pause", "Median measured pause", baseline.medianPauseMs, retry.medianPauseMs, "ms", 0, 600_000),
  ];
}

function pauseMeasures(baseline, retry) {
  const baselineRate = ratePerObservedMinute(baseline.pauseCount, baseline.observedDurationMs);
  const retryRate = ratePerObservedMinute(retry.pauseCount, retry.observedDurationMs);
  return [
    measure("pause-rate", "Measured pauses per observed minute", baselineRate, retryRate, "per min", 0, 40_000),
    measure("median-pause", "Median measured pause", baseline.medianPauseMs, retry.medianPauseMs, "ms", 0, 600_000),
    measure("longest-speaking-run", "Longest speaking run", baseline.longestSpeakingRunMs, retry.longestSpeakingRunMs, "ms", 0, 600_000),
  ];
}

function energyMeasures(baseline, retry) {
  return [
    measure("level-consistency", "Level consistency", baseline.levelConsistencyPct, retry.levelConsistencyPct, "%", 0, 100),
    measure("clipping-frames", "Clipping frames", baseline.clippingPct, retry.clippingPct, "%", 0, 100),
  ];
}

function measure(id, label, baseline, retry, unit, minimum, maximum) {
  const baselineNumber = boundedValue(baseline, minimum, maximum);
  const retryNumber = boundedValue(retry, minimum, maximum);
  const available = baselineNumber !== null && retryNumber !== null;
  const baselineValue = available ? round(baselineNumber, 2) : null;
  const retryValue = available ? round(retryNumber, 2) : null;
  return {
    id,
    label,
    unit,
    available,
    baseline: baselineValue,
    retry: retryValue,
    delta: available ? round(retryValue - baselineValue, 2) : null,
    interpretation: "descriptive",
  };
}

function eligibleTranscript(metrics) {
  const transcript = metrics?.transcriptMetrics;
  return transcript
    && boundedValue(metrics.durationMs, 0, 600_000) >= MINIMUM_COMPARISON_DURATION_MS
    && boundedInteger(transcript.wordCount, 0, 100_000) >= 25
    && boundedValue(transcript.wordsPerMinute, 0, 2_000) !== null
    ? transcript
    : null;
}

function ratePerObservedMinute(count, observedDurationMs) {
  const numerator = boundedInteger(count, 0, 10_000);
  const duration = boundedValue(observedDurationMs, 0, 600_000);
  if (numerator === null || duration === null || duration <= 0) return null;
  return numerator / (duration / 60_000);
}

function evidenceLimitations(baseline, retry) {
  const reasons = [];
  for (const [label, metrics] of [["Baseline", baseline], ["Retry", retry]]) {
    const duration = boundedValue(metrics.durationMs, 0, 600_000);
    const coverage = boundedValue(metrics.coverageRatio, 0, 1);
    const confidence = String(metrics.audioConfidence || "unknown");
    if (duration === null) {
      reasons.push(`${label} had an invalid analysis duration.`);
    } else if (duration < MINIMUM_COMPARISON_DURATION_MS) {
      reasons.push(`${label} contained less than 15 seconds of analysis.`);
    }
    if (coverage === null) {
      reasons.push(`${label} had invalid signal coverage.`);
    } else if (coverage < MINIMUM_COMPARISON_COVERAGE) {
      reasons.push(`${label} had less than 75% signal coverage.`);
    }
    if (!["high", "medium", "low", "unknown"].includes(confidence)) {
      reasons.push(`${label} had an invalid signal-confidence value.`);
    } else if (["low", "unknown"].includes(confidence)) {
      reasons.push(`${label} had limited signal confidence.`);
    }
  }
  return reasons;
}

function attemptSetupLimitations(summary, label) {
  const reasons = [];
  if (Number(summary?.analysisSchemaVersion) !== 2) reasons.push(`${label} does not use analysis schema 2.`);
  if (!VALID_SCENARIOS.has(summary?.scenario)) reasons.push(`${label} has an unsupported speaking scenario.`);
  if (!VALID_GOALS.has(summary?.goal)) reasons.push(`${label} has an unsupported coaching goal.`);
  if (!validTargetDuration(summary?.targetDurationMs)) reasons.push(`${label} has an invalid target duration.`);
  return reasons;
}

function validTargetDuration(value) {
  const number = Number(value);
  return Number.isSafeInteger(number)
    && number >= MINIMUM_COMPARISON_DURATION_MS
    && number <= MAXIMUM_TARGET_DURATION_MS;
}

function comparisonGuardrails(baseline, retry) {
  return {
    baseline: {
      durationMs: boundedValue(baseline?.metrics?.durationMs, 0, 600_000),
      coverageRatio: boundedValue(baseline?.metrics?.coverageRatio, 0, 1),
      audioConfidence: String(baseline?.metrics?.audioConfidence || "unknown"),
    },
    retry: {
      durationMs: boundedValue(retry?.metrics?.durationMs, 0, 600_000),
      coverageRatio: boundedValue(retry?.metrics?.coverageRatio, 0, 1),
      audioConfidence: String(retry?.metrics?.audioConfidence || "unknown"),
    },
  };
}

function goalCaveats(goal) {
  const general = "This comparison describes two attempts and does not produce a universal speaking score.";
  if (goal === "pace") {
    return [general, "Estimated WPM appears only when both on-device transcripts have enough evidence; slower or faster is not automatically better."];
  }
  if (goal === "pauses") {
    return [general, "More pauses or a different pause length is not automatically better; use the selected drill and listening context."];
  }
  return [general, "Level consistency and clipping also reflect microphone distance, gain, browser processing, and room conditions."];
}

function invalidRelationship(reason) {
  return {
    valid: false,
    legacy: false,
    practiceLoopId: null,
    baselineAttemptId: null,
    attemptRole: "standalone",
    feedbackMode: "live-cues",
    reason,
  };
}

function normalizeOpaqueId(value, name) {
  if (!isOpaqueId(value)) throw new TypeError(`${name} must be a 1-128 character opaque identifier.`);
  return value;
}

function isOpaqueId(value) {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function randomOpaqueId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== "function") throw new Error("Secure random IDs are unavailable.");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function finiteValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedValue(value, minimum, maximum) {
  const number = finiteValue(value);
  return number !== null && number >= minimum && number <= maximum ? number : null;
}

function boundedInteger(value, minimum, maximum) {
  const number = boundedValue(value, minimum, maximum);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

function compareCreatedAt(left, right) {
  return String(right?.createdAt || "").localeCompare(String(left?.createdAt || ""));
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
