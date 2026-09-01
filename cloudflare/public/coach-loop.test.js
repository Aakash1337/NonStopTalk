import assert from "node:assert/strict";
import test from "node:test";

import {
  compareGoalAttempts,
  createPracticeLoop,
  createRetryState,
  groupPracticeLoops,
  normalizeAttemptRelationship,
  relationshipForSummary,
  validateComparablePair,
} from "./coach-loop.js";

function summary(overrides = {}) {
  const base = {
    analysisSchemaVersion: 2,
    id: "baseline-1",
    createdAt: "2026-09-01T12:00:00.000Z",
    scenario: "interview",
    goal: "pauses",
    targetDurationMs: 45_000,
    practiceLoopId: "loop-1",
    baselineAttemptId: "baseline-1",
    attemptRole: "baseline",
    feedbackMode: "review-only",
    metrics: {
      durationMs: 45_000,
      observedDurationMs: 44_000,
      coverageRatio: 0.98,
      pauseCount: 3,
      medianPauseMs: 600,
      longestSpeakingRunMs: 12_000,
      levelConsistencyPct: 70,
      clippingPct: 1,
      audioConfidence: "high",
      transcriptMetrics: { wordCount: 90, wordsPerMinute: 120 },
    },
  };
  return {
    ...base,
    ...overrides,
    metrics: { ...base.metrics, ...(overrides.metrics || {}) },
  };
}

function retry(overrides = {}) {
  return summary({
    id: "retry-1",
    createdAt: "2026-09-01T12:05:00.000Z",
    attemptRole: "retry",
    metrics: { pauseCount: 5, medianPauseMs: 800, longestSpeakingRunMs: 8_000 },
    ...overrides,
  });
}

test("legacy records remain valid standalone attempts", () => {
  const legacy = summary();
  for (const key of ["practiceLoopId", "baselineAttemptId", "attemptRole", "feedbackMode"]) delete legacy[key];
  assert.deepEqual(normalizeAttemptRelationship(legacy), {
    valid: true,
    legacy: true,
    practiceLoopId: null,
    baselineAttemptId: null,
    attemptRole: "standalone",
    feedbackMode: "live-cues",
    reason: "",
  });
});

test("creates secure loop state and resolves baseline/retry relationship fields", () => {
  const loop = createPracticeLoop(() => "loop-created");
  assert.deepEqual(relationshipForSummary(loop, "baseline-created"), {
    practiceLoopId: "loop-created",
    baselineAttemptId: "baseline-created",
    attemptRole: "baseline",
    feedbackMode: "review-only",
  });
  const baseline = summary({
    id: "baseline-created",
    practiceLoopId: "loop-created",
    baselineAttemptId: "baseline-created",
  });
  assert.deepEqual(createRetryState(baseline), {
    practiceLoopId: "loop-created",
    baselineAttemptId: "baseline-created",
    attemptRole: "retry",
    feedbackMode: "review-only",
  });
});

test("rejects incomplete, self-linked, or assisted paired relationships", () => {
  assert.equal(normalizeAttemptRelationship(summary({ practiceLoopId: null })).valid, false);
  assert.equal(normalizeAttemptRelationship(summary({ feedbackMode: "live-cues" })).valid, false);
  assert.equal(normalizeAttemptRelationship(retry({ baselineAttemptId: "retry-1" })).valid, false);
  assert.throws(() => relationshipForSummary({
    practiceLoopId: "loop-1",
    baselineAttemptId: "retry-1",
    attemptRole: "retry",
  }, "retry-1"), /cannot point to itself/i);
});

test("requires a matching relationship, scenario, goal, duration, and analysis version", () => {
  assert.equal(validateComparablePair(summary(), retry()).comparable, true);
  for (const mismatch of [
    { practiceLoopId: "loop-2" },
    { baselineAttemptId: "other-baseline" },
    { scenario: "presentation" },
    { goal: "pace" },
    { targetDurationMs: 60_000 },
    { analysisSchemaVersion: 1 },
  ]) {
    assert.equal(validateComparablePair(summary(), retry(mismatch)).comparable, false);
  }
  assert.equal(validateComparablePair(
    summary({ analysisSchemaVersion: 1 }),
    retry({ analysisSchemaVersion: 1 }),
  ).comparable, false, "Two equally obsolete schemas must not become comparable");
  assert.equal(validateComparablePair(
    summary({ scenario: "custom" }),
    retry({ scenario: "custom" }),
  ).comparable, false, "Matching but unsupported setup values must not become comparable");
});

test("pause comparison normalizes counts by observed duration without an improvement verdict", () => {
  const comparison = compareGoalAttempts(summary(), retry());
  assert.equal(comparison.status, "ready");
  assert.equal(comparison.goal, "pauses");
  assert.deepEqual(comparison.measures.map((item) => item.id), ["pause-rate", "median-pause", "longest-speaking-run"]);
  assert.equal(comparison.measures[0].baseline, 4.09);
  assert.equal(comparison.measures[0].retry, 6.82);
  assert.equal(comparison.measures[0].interpretation, "descriptive");
  assert.doesNotMatch(JSON.stringify(comparison), /improved|score:\s*\d/iu);
});

test("pace comparison uses WPM only when both transcripts have enough evidence", () => {
  const baseline = summary({ goal: "pace" });
  const next = retry({ goal: "pace", metrics: { transcriptMetrics: { wordCount: 100, wordsPerMinute: 110 } } });
  const ready = compareGoalAttempts(baseline, next);
  assert.equal(ready.measures[0].available, true);
  assert.equal(ready.measures[0].delta, -10);

  const unavailable = compareGoalAttempts(baseline, retry({
    goal: "pace",
    metrics: { transcriptMetrics: { wordCount: 12, wordsPerMinute: 90 } },
  }));
  assert.equal(unavailable.measures[0].available, false);
  assert.match(unavailable.caveats.join(" "), /on-device transcripts/i);
});

test("energy comparison handles unavailable consistency and retains setup caveats", () => {
  const baseline = summary({ goal: "energy", metrics: { levelConsistencyPct: null, clippingPct: 4 } });
  const next = retry({ goal: "energy", metrics: { levelConsistencyPct: 80, clippingPct: 1 } });
  const comparison = compareGoalAttempts(baseline, next);
  assert.equal(comparison.measures[0].available, false);
  assert.equal(comparison.measures[1].delta, -3);
  assert.match(comparison.caveats.join(" "), /microphone distance/i);
});

test("short, low-coverage, or low-confidence attempts are limited evidence", () => {
  const comparison = compareGoalAttempts(
    summary({ metrics: { durationMs: 10_000, coverageRatio: 0.5, audioConfidence: "low" } }),
    retry(),
  );
  assert.equal(comparison.status, "limited");
  assert.match(comparison.reasons.join(" "), /15 seconds|75%|limited signal confidence/i);
});

test("corrupted local metric ranges become unavailable instead of producing deltas", () => {
  const comparison = compareGoalAttempts(
    summary({
      metrics: {
        durationMs: 9_000_000,
        coverageRatio: 9,
        pauseCount: -1,
        observedDurationMs: 1,
        medianPauseMs: -50,
        longestSpeakingRunMs: 9_000_000,
        audioConfidence: "impossible",
      },
    }),
    retry(),
  );
  assert.equal(comparison.status, "limited");
  assert.equal(comparison.measures.every((measure) => !measure.available), true);
  assert.equal(comparison.guardrails.baseline.durationMs, null);
  assert.equal(comparison.guardrails.baseline.coverageRatio, null);
  assert.match(comparison.reasons.join(" "), /invalid analysis duration|invalid signal coverage|invalid signal-confidence/i);
});

test("grouping never pairs by recency and keeps duplicate/orphan records visible", () => {
  const baseline = summary();
  const validRetry = retry();
  const duplicateBaseline = summary({ id: "baseline-duplicate", baselineAttemptId: "baseline-duplicate", createdAt: "2026-09-01T12:01:00.000Z" });
  const orphan = retry({ id: "orphan", practiceLoopId: "missing-loop", baselineAttemptId: "missing" });
  const malformed = summary({
    id: "malformed-baseline",
    practiceLoopId: "malformed-loop",
    baselineAttemptId: "malformed-baseline",
    targetDurationMs: 0,
  });
  const standalone = summary({ id: "legacy" });
  for (const key of ["practiceLoopId", "baselineAttemptId", "attemptRole", "feedbackMode"]) delete standalone[key];
  const grouped = groupPracticeLoops([validRetry, orphan, malformed, standalone, duplicateBaseline, baseline]);
  assert.equal(grouped.loops.length, 1);
  assert.equal(grouped.loops[0].status, "complete");
  assert.equal(grouped.loops[0].retries[0].session.id, "retry-1");
  assert.deepEqual(grouped.standalone.map((item) => item.id), ["legacy"]);
  assert.deepEqual(grouped.unpaired.map((item) => item.session.id).sort(), ["baseline-duplicate", "malformed-baseline", "orphan"]);
});

test("grouping orders loops and retries by their newest retry", () => {
  const firstBaseline = summary();
  const firstOldRetry = retry({ id: "retry-old", createdAt: "2026-09-01T12:05:00.000Z" });
  const firstNewRetry = retry({ id: "retry-new", createdAt: "2026-09-01T12:20:00.000Z" });
  const secondBaseline = summary({
    id: "baseline-2",
    createdAt: "2026-09-01T12:10:00.000Z",
    practiceLoopId: "loop-2",
    baselineAttemptId: "baseline-2",
  });
  const secondRetry = retry({
    id: "retry-2",
    createdAt: "2026-09-01T12:15:00.000Z",
    practiceLoopId: "loop-2",
    baselineAttemptId: "baseline-2",
  });

  const grouped = groupPracticeLoops([
    secondRetry,
    firstOldRetry,
    secondBaseline,
    firstNewRetry,
    firstBaseline,
  ]);

  assert.deepEqual(grouped.loops.map((loop) => loop.id), ["loop-1", "loop-2"]);
  assert.deepEqual(
    grouped.loops[0].retries.map((item) => item.session.id),
    ["retry-new", "retry-old"],
  );
  assert.equal(grouped.loops[0].latestAt, firstNewRetry.createdAt);
});

test("comparison and grouping do not mutate summaries", () => {
  const baseline = summary();
  const next = retry();
  const before = JSON.stringify([baseline, next]);
  compareGoalAttempts(baseline, next);
  groupPracticeLoops([baseline, next]);
  assert.equal(JSON.stringify([baseline, next]), before);
});
