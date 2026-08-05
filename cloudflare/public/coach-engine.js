/**
 * Dependency-free, deterministic speech-coaching measurements.
 *
 * The engine consumes low-cost level readings rather than raw audio. It reports
 * observable delivery signals only: speaking time, pauses, input level, clipping,
 * and (when supplied) transcript-derived pace and word-pattern estimates. It does
 * not assign a universal quality score or infer emotion, personality, confidence,
 * accent quality, or health.
 */

export const COACHING_THRESHOLDS = Object.freeze({
  pauseMs: 400,
  bridgeGapMs: 250,
  frameHoldMs: 250,
  glitchMs: 120,
  clippingPeak: 0.98,
  tipCooldownMs: 8_000,
  longSilenceTipMs: 2_500,
  longSpeakingRunTipMs: 28_000,
  focusedPauseRunTipMs: 18_000,
  minimumReliableDurationMs: 15_000,
  minimumLevelSamples: 8,
});

/**
 * A deliberately small, product-authored corpus for the prototype's local RAG path.
 * These are product-owned coaching prompts, not clinical guidance or universal
 * speaking norms. The versioned source label makes provenance visible in UI.
 */
export const COACHING_KNOWLEDGE_CARDS = Object.freeze([
  {
    id: "idea-boundary-pause",
    title: "Use a pause as an idea boundary",
    source: "NonStopTalk Coaching Library · Delivery foundations v1",
    tags: ["pause", "pace", "intentional", "idea", "boundary", "breath", "presentation", "run"],
    excerpt: "A short planned pause can separate complete ideas and give the next sentence a clear starting point.",
    drill: "Mark one slash where your first idea ends, pause for one comfortable breath there, then deliver the next idea.",
  },
  {
    id: "recover-after-gap",
    title: "Recover with one landing sentence",
    source: "NonStopTalk Coaching Library · Delivery foundations v1",
    tags: ["silence", "gap", "flow", "continuity", "outline", "recovery", "cue"],
    excerpt: "When a gap becomes long, a compact cue can restart the answer without forcing the speaker to rush.",
    drill: "Write three cue words for the answer; after a long gap, choose one and restart with a single complete sentence.",
  },
  {
    id: "protect-input-level",
    title: "Protect a clean microphone signal",
    source: "NonStopTalk Coaching Library · Recording basics v1",
    tags: ["clipping", "energy", "level", "volume", "microphone", "gain", "distance", "steady", "input"],
    excerpt: "Clipping and large level changes can come from gain or microphone distance, so stabilize the setup before judging delivery.",
    drill: "Move one hand-span from the microphone, lower input gain if available, and repeat one sentence while keeping that distance steady.",
  },
  {
    id: "pace-with-breaths",
    title: "Shape pace at sentence boundaries",
    source: "NonStopTalk Coaching Library · Delivery foundations v1",
    tags: ["pace", "fast", "wpm", "sentence", "phrase", "breath", "rushed"],
    excerpt: "Pace becomes easier to control when a speaker changes it at phrase or sentence boundaries instead of stretching every word.",
    drill: "Repeat the answer and take a small breath after each complete sentence while keeping the wording the same.",
  },
  {
    id: "replace-fillers-with-silence",
    title: "Trade one filler pattern for silence",
    source: "NonStopTalk Coaching Library · Delivery foundations v1",
    tags: ["filler", "repetition", "transcript", "word", "pause", "silence", "pace"],
    excerpt: "A brief silent beat can replace a recurring filler or immediate repetition without changing the speaker's idea.",
    drill: "On the next attempt, notice one recurring filler pattern and replace only that pattern with a short silent beat.",
  },
  {
    id: "repeat-and-compare",
    title: "Build a comparable baseline",
    source: "NonStopTalk Coaching Library · Practice method v1",
    tags: ["baseline", "retry", "short", "evidence", "compare", "practice", "measurement"],
    excerpt: "One longer attempt and one comparable retry reveal more than a judgment drawn from a few seconds of signal.",
    drill: "Use the same prompt for at least 20 seconds, review one measurement, then repeat once with only that change in mind.",
  },
].map((card) => Object.freeze({ ...card, tags: Object.freeze([...card.tags]) })));

const EPSILON = 1e-9;
const RETRIEVAL_STOP_WORDS = new Set(["a", "an", "and", "as", "at", "for", "from", "in", "of", "on", "or", "the", "to", "with", "your"]);

/**
 * Learn thresholds from a short quiet recording and a short speaking recording.
 * Samples may be RMS numbers or objects shaped like `{ rms, peak }`.
 */
export function deriveCalibration({ quietSamples = [], voiceSamples = [] } = {}) {
  const quiet = levelsFrom(quietSamples);
  const voice = levelsFrom(voiceSamples);

  const quietMedianRms = quantile(quiet, 0.5) ?? 0.006;
  const quietCeilingRms = quantile(quiet, 0.9) ?? Math.max(0.012, quietMedianRms * 1.8);
  const voiceFloorRms = quantile(voice, 0.2) ?? 0.06;
  const voiceMedianRms = quantile(voice, 0.5) ?? 0.12;
  const voiceUpperRms = quantile(voice, 0.8) ?? Math.max(voiceMedianRms, 0.18);
  const separationRms = voiceFloorRms - quietCeilingRms;
  const usableSeparation = Math.max(0, separationRms);

  let speechOnThreshold;
  let speechOffThreshold;
  if (usableSeparation >= 0.002) {
    // Hysteresis avoids switching between voice and silence around one boundary.
    speechOnThreshold = quietCeilingRms + usableSeparation * 0.45;
    speechOffThreshold = quietCeilingRms + usableSeparation * 0.2;
  } else {
    // A conservative fallback keeps calibration usable while marking confidence low.
    speechOnThreshold = Math.max(0.015, quietCeilingRms * 1.8, voiceMedianRms * 0.55);
    speechOffThreshold = Math.max(0.01, speechOnThreshold * 0.72);
  }
  speechOnThreshold = clamp(speechOnThreshold, 0.005, 0.8);
  speechOffThreshold = clamp(Math.min(speechOffThreshold, speechOnThreshold * 0.92), 0.003, 0.75);

  const targetLow = clamp(
    Math.max(speechOnThreshold * 1.08, voiceFloorRms * 0.72, voiceMedianRms * 0.48),
    speechOnThreshold,
    0.75,
  );
  const targetHigh = clamp(
    Math.max(targetLow * 1.35, voiceUpperRms * 1.35, voiceMedianRms * 1.65),
    targetLow + 0.005,
    0.92,
  );

  const sampleEvidence = clamp(Math.min(quiet.length, voice.length) / 12, 0, 1);
  const relativeSeparation = clamp(
    usableSeparation / Math.max(voiceMedianRms, quietCeilingRms + 0.01),
    0,
    1,
  );
  const confidenceScore = round(0.45 * sampleEvidence + 0.55 * clamp(relativeSeparation / 0.45, 0, 1), 3);
  const confidence = {
    score: confidenceScore,
    level: confidenceLabel(confidenceScore),
    reasons: [
      ...(quiet.length < 8 || voice.length < 8 ? ["Calibration used fewer than eight quiet or voice samples."] : []),
      ...(usableSeparation < 0.002 ? ["Quiet and speaking levels were not clearly separated."] : []),
    ],
    meaning: "Confidence describes measurement evidence, not the speaker.",
  };

  return {
    version: 1,
    quietSampleCount: quiet.length,
    voiceSampleCount: voice.length,
    quietMedianRms: round(quietMedianRms, 6),
    quietCeilingRms: round(quietCeilingRms, 6),
    voiceFloorRms: round(voiceFloorRms, 6),
    voiceMedianRms: round(voiceMedianRms, 6),
    separationRms: round(separationRms, 6),
    speechOnThreshold: round(speechOnThreshold, 6),
    speechOffThreshold: round(speechOffThreshold, 6),
    targetRmsRange: {
      low: round(targetLow, 6),
      high: round(targetHigh, 6),
    },
    clippingThreshold: COACHING_THRESHOLDS.clippingPeak,
    confidence,

    // Friendly aliases keep UI adapters small while canonical names stay explicit.
    noiseFloor: round(quietMedianRms, 6),
    quietRms: round(quietMedianRms, 6),
    referenceRms: round(voiceMedianRms, 6),
    voiceRms: round(voiceMedianRms, 6),
    speechLevel: round(voiceMedianRms, 6),
    threshold: round(speechOnThreshold, 6),
  };
}

export class CoachingAnalyzer {
  constructor({ calibration, goal = "balanced-delivery", targetDurationMs = 60_000 } = {}) {
    this.calibration = normalizeCalibration(calibration);
    this.goal = typeof goal === "string" && goal.trim() ? goal.trim() : "balanced-delivery";
    this.targetDurationMs = positiveNumber(targetDurationMs, 60_000);

    this._segments = [];
    this._voiceRmsSamples = [];
    this._sampleCount = 0;
    this._clippingSampleCount = 0;
    this._clippingEventCount = 0;
    this._clippingDurationMs = 0;
    this._maxSampleGapMs = 0;
    // Analyzer timestamps are elapsed attempt time, so the evidence window starts
    // at zero even when the first audio callback arrives later.
    this._startMs = 0;
    this._lastAtMs = null;
    this._lastRms = 0;
    this._lastPeak = 0;
    this._lastWasVoice = false;
    this._lastWasClipping = false;
    this._finished = false;
    this._finishedReport = null;
  }

  /** Add one timestamped level sample. Timestamps must not move backwards. */
  ingest({ atMs, rms, peak = rms } = {}) {
    if (this._finished) throw new Error("Cannot ingest samples after finish().");
    const timestamp = finiteNonNegative(atMs, "atMs");
    const level = clamp(finiteNumber(rms, 0), 0, 1);
    const peakLevel = clamp(Math.max(level, finiteNumber(peak, level)), 0, 1);
    let resumedAfterUnknown = false;

    if (this._lastAtMs !== null && timestamp < this._lastAtMs) {
      throw new RangeError("Coaching samples must be ingested in timestamp order.");
    }

    if (this._lastAtMs === null) {
      this._lastAtMs = timestamp;
      this._lastWasVoice = level >= this.calibration.speechOnThreshold;
      if (timestamp > 0) {
        this._segments.push({ kind: "unknown", startMs: 0, endMs: timestamp });
      }
      this._segments.push({
        kind: this._lastWasVoice ? "voice" : "silence",
        startMs: timestamp,
        endMs: timestamp,
      });
    } else {
      const gap = timestamp - this._lastAtMs;
      const observedGap = Math.min(gap, COACHING_THRESHOLDS.frameHoldMs);
      const observedEnd = this._lastAtMs + observedGap;
      this._maxSampleGapMs = Math.max(this._maxSampleGapMs, gap);
      this._segments[this._segments.length - 1].endMs = observedEnd;
      if (this._lastWasClipping) this._clippingDurationMs += observedGap;

      if (observedEnd < timestamp) {
        resumedAfterUnknown = true;
        this._segments.push({
          kind: "unknown",
          startMs: observedEnd,
          endMs: timestamp,
        });
      }

      const isVoice = gap > COACHING_THRESHOLDS.frameHoldMs
        ? level >= this.calibration.speechOnThreshold
        : this._lastWasVoice
        ? level >= this.calibration.speechOffThreshold
        : level >= this.calibration.speechOnThreshold;
      if (isVoice !== this._lastWasVoice || observedEnd < timestamp) {
        this._segments.push({
          kind: isVoice ? "voice" : "silence",
          startMs: timestamp,
          endMs: timestamp,
        });
      }
      this._lastWasVoice = isVoice;
      this._lastAtMs = timestamp;
    }

    const isClipping = peakLevel >= this.calibration.clippingThreshold;
    if (isClipping) {
      this._clippingSampleCount += 1;
      if (!this._lastWasClipping || resumedAfterUnknown) this._clippingEventCount += 1;
    }
    if (this._lastWasVoice) this._voiceRmsSamples.push(level);

    this._lastRms = level;
    this._lastPeak = peakLevel;
    this._lastWasClipping = isClipping;
    this._sampleCount += 1;
    return this;
  }

  /** Return a non-destructive report projected to `atMs` (or the latest sample). */
  snapshot(atMs = this._lastAtMs ?? 0) {
    const requestedAt = finiteNonNegative(atMs, "atMs");
    const endAt = this._lastAtMs === null ? requestedAt : Math.max(requestedAt, this._lastAtMs);
    const startAt = this._startMs;
    const durationMs = Math.max(0, endAt - startAt);
    const segments = this._projectSegments(endAt, startAt);
    const speakingMs = sumDurations(segments, "voice");
    const silenceMs = sumDurations(segments, "silence");
    const unknownMs = sumDurations(segments, "unknown");
    const observedDurationMs = speakingMs + silenceMs;
    const speakingRatio = observedDurationMs > 0 ? speakingMs / observedDurationMs : 0;
    const pauses = findPauses(segments);
    const pauseDurations = pauses.map((pause) => pause.durationMs);
    const inputLevel = inputLevelMetrics(this._voiceRmsSamples, this.calibration, speakingMs);
    const projectedClippingDuration = this._clippingDurationMs
      + (this._lastWasClipping && this._lastAtMs !== null
        ? Math.min(endAt - this._lastAtMs, COACHING_THRESHOLDS.frameHoldMs)
        : 0);
    const projectedGapMs = this._lastAtMs === null ? 0 : endAt - this._lastAtMs;
    const maxSampleGapMs = Math.max(this._maxSampleGapMs, projectedGapMs);
    const continuity = durationMs > 0 ? clamp(observedDurationMs / durationMs, 0, 1) : 0;
    const confidence = measurementConfidence({
      calibration: this.calibration,
      durationMs,
      observedDurationMs,
      speakingMs,
      sampleCount: this._sampleCount,
      continuity,
    });

    return {
      version: 1,
      goal: this.goal,
      targetDurationMs: this.targetDurationMs,
      startedAtMs: this._startMs,
      observedAtMs: endAt,
      durationMs: round(durationMs, 1),
      progressRatio: round(clamp(durationMs / this.targetDurationMs, 0, 1), 3),
      sampleCount: this._sampleCount,
      speakingMs: round(speakingMs, 1),
      voicedMs: round(speakingMs, 1),
      silenceMs: round(silenceMs, 1),
      observedDurationMs: round(observedDurationMs, 1),
      unknownMs: round(unknownMs, 1),
      unobservedMs: round(unknownMs, 1),
      coverageRatio: round(continuity, 4),
      speakingRatio: round(speakingRatio, 4),
      pauseThresholdMs: COACHING_THRESHOLDS.pauseMs,
      pauseCount: pauses.length,
      pauses,
      medianPauseMs: round(median(pauseDurations) ?? 0, 1),
      longestPauseMs: round(Math.max(0, ...pauseDurations), 1),
      speakingRunBridgeMs: COACHING_THRESHOLDS.bridgeGapMs,
      longestSpeakingRunMs: round(longestSpeakingRun(segments), 1),
      currentSilenceMs: round(currentSilence(segments), 1),
      currentSpeakingRunMs: round(currentSpeakingRun(segments), 1),
      inputLevel,
      inputLevelConsistency: inputLevel.consistency,
      levelConsistencyPct: inputLevel.consistency === null ? null : round(inputLevel.consistency * 100, 1),
      clippingCount: this._clippingSampleCount,
      clippingRatio: round(this._sampleCount > 0 ? this._clippingSampleCount / this._sampleCount : 0, 4),
      clippingPct: round(this._sampleCount > 0 ? this._clippingSampleCount / this._sampleCount * 100 : 0, 2),
      clipping: {
        threshold: this.calibration.clippingThreshold,
        sampleCount: this._clippingSampleCount,
        eventCount: this._clippingEventCount,
        sampleRatio: round(this._sampleCount > 0 ? this._clippingSampleCount / this._sampleCount : 0, 4),
        durationMs: round(projectedClippingDuration, 1),
        durationRatio: round(durationMs > 0 ? projectedClippingDuration / durationMs : 0, 4),
      },
      continuity: {
        score: round(continuity, 3),
        maxSampleGapMs: round(maxSampleGapMs, 1),
        unknownMs: round(unknownMs, 1),
        note: "A level frame is held for at most 250 ms; longer callback gaps are unknown and reduce measurement confidence.",
      },
      confidence,
      measurementConfidence: confidence,
      audioConfidence: confidence.level,
      segments,
      transcriptMetrics: null,
      advice: null,
    };
  }

  /** Finish the attempt and optionally add estimates derived from an ephemeral transcript. */
  finish(atMs = this._lastAtMs ?? 0, transcriptText) {
    if (this._finishedReport) return this._finishedReport;
    const report = this.snapshot(atMs);
    if (typeof transcriptText === "string" && transcriptText.trim()) {
      report.transcriptMetrics = analyzeTranscript(transcriptText, report.durationMs);
    }
    report.advice = buildAdvice(report);
    this._finished = true;
    this._finishedReport = report;
    return report;
  }

  _projectSegments(endAt, startAt) {
    if (endAt <= startAt) return [];
    if (this._segments.length === 0) {
      return [{
        kind: "unknown",
        voiced: null,
        startMs: 0,
        endMs: round(endAt - startAt, 1),
        durationMs: round(endAt - startAt, 1),
      }];
    }
    const projected = this._segments.map((segment) => ({ ...segment }));
    const observedEnd = Math.min(endAt, this._lastAtMs + COACHING_THRESHOLDS.frameHoldMs);
    projected[projected.length - 1].endMs = observedEnd;
    if (observedEnd < endAt) {
      projected.push({ kind: "unknown", startMs: observedEnd, endMs: endAt });
    }
    return compressSegments(projected).map((segment) => ({
      kind: segment.kind,
      voiced: segment.kind === "unknown" ? null : segment.kind === "voice",
      startMs: round(segment.startMs - startAt, 1),
      endMs: round(segment.endMs - startAt, 1),
      durationMs: round(segment.endMs - segment.startMs, 1),
    }));
  }
}

/**
 * Stateful policy for sparse live tips. A qualifying observation must have enough
 * evidence, and no tip can be emitted less than eight seconds after another.
 */
export class CoachingTipPolicy {
  constructor({ cooldownMs = COACHING_THRESHOLDS.tipCooldownMs } = {}) {
    this.cooldownMs = Math.max(COACHING_THRESHOLDS.tipCooldownMs, positiveNumber(cooldownMs, 8_000));
    this._lastTipAt = -Infinity;
  }

  evaluate(snapshot, nowMs = snapshot?.observedAtMs ?? 0) {
    const now = finiteNonNegative(nowMs, "nowMs");
    if (!snapshot || now - this._lastTipAt < this.cooldownMs) return null;

    const candidates = tipCandidates(snapshot);
    if (candidates.length === 0) return null;
    const tip = candidates.sort((a, b) => b.priority - a.priority)[0];
    this._lastTipAt = now;
    return {
      id: tip.id,
      kind: "adjustment",
      text: tip.message,
      message: tip.message,
      evidence: tip.evidence,
    };
  }
}

/** Derive approximate pace, filler-marker, and immediate-repetition metrics. */
export function analyzeTranscript(text, durationMs) {
  const source = typeof text === "string" ? text.normalize("NFKC") : "";
  const tokens = (source.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [])
    .map((token) => token.toLowerCase().replaceAll("’", "'"));
  const elapsed = Math.max(0, finiteNumber(durationMs, 0));
  const wordCount = tokens.length;
  const wordsPerMinute = elapsed > 0 ? round(wordCount / (elapsed / 60_000), 1) : null;

  const fillerPatterns = [
    ["you", "know"],
    ["i", "mean"],
    ["kind", "of"],
    ["sort", "of"],
    ["um"],
    ["uh"],
    ["erm"],
    ["er"],
    ["hmm"],
  ];
  const occupied = new Set();
  const fillerCounts = new Map();
  for (const pattern of fillerPatterns) {
    for (let index = 0; index <= tokens.length - pattern.length; index += 1) {
      if (pattern.some((token, offset) => tokens[index + offset] !== token || occupied.has(index + offset))) continue;
      pattern.forEach((_, offset) => occupied.add(index + offset));
      const phrase = pattern.join(" ");
      fillerCounts.set(phrase, (fillerCounts.get(phrase) ?? 0) + 1);
    }
  }
  const fillerOccurrences = [...fillerCounts.entries()].map(([phrase, count]) => ({ phrase, count }));
  const fillerCount = fillerOccurrences.reduce((sum, item) => sum + item.count, 0);

  const repeated = new Map();
  let repeatedWordCount = 0;
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index] !== tokens[index - 1]) continue;
    repeatedWordCount += 1;
    repeated.set(tokens[index], (repeated.get(tokens[index]) ?? 0) + 1);
  }
  const repeatedWords = [...repeated.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

  return {
    available: wordCount > 0,
    durationMs: round(elapsed, 1),
    wordCount,
    wordsPerMinute,
    wpm: wordsPerMinute,
    fillerCount,
    fillerRatePer100Words: round(wordCount > 0 ? fillerCount / wordCount * 100 : 0, 2),
    fillerOccurrences,
    repeatedWordCount,
    repetitionCount: repeatedWordCount,
    repetitionRatePer100Words: round(wordCount > 0 ? repeatedWordCount / wordCount * 100 : 0, 2),
    repeatedWords,
    isEstimate: true,
    caveats: [
      "Pace depends on transcript completeness and attempt duration.",
      "Filler markers and immediate repeated words can be intentional; treat these counts as prompts for self-review, not proof of a problem.",
    ],
  };
}

/**
 * Retrieve locally from the bundled coaching corpus. The query is constructed
 * only from the selected goal and aggregate measurements; transcript text is
 * never an input to retrieval. Weighted lexical matching keeps every result
 * inspectable and deterministic for the presentation prototype.
 */
export function retrieveCoachingGuidance({ goal = "", report = {}, limit = 2 } = {}) {
  const queryParts = [String(goal || report.goal || "")];
  const durationMs = finiteNumber(report.durationMs, 0);
  const clippingRatio = finiteNumber(report.clippingRatio, finiteNumber(report.clippingPct, 0) / 100);
  const levelStatus = String(report.inputLevel?.status || "");
  const transcript = report.transcriptMetrics;
  const continuityScore = finiteNumber(report.continuity?.score, 1);
  const unknownMs = finiteNumber(report.unknownMs ?? report.unobservedMs, 0);

  if (durationMs > 0 && durationMs < 8_000) {
    queryParts.push(
      "short baseline retry evidence compare measurement",
      "short baseline retry evidence compare measurement",
      "short baseline retry evidence compare measurement",
    );
  }
  // Repeating a high-priority signal is the transparent lexical equivalent of
  // a query boost: recording validity should outrank delivery style advice.
  if (report.sampleCount >= 20 && report.clippingCount >= 3 && clippingRatio >= 0.02) {
    queryParts.push(
      "clipping microphone input gain level distance",
      "clipping microphone input gain level distance",
      "clipping microphone input gain level distance",
      "clipping microphone input gain level distance",
    );
  }
  if (levelStatus === "variable") {
    queryParts.push("variable level energy microphone distance steady", "variable level energy microphone distance steady");
  }
  if (unknownMs >= 1_000 || (durationMs >= 3_000 && continuityScore < 0.75)) {
    queryParts.push(
      "microphone input steady signal measurement",
      "microphone input steady signal measurement",
      "microphone input steady signal measurement",
    );
  }
  if (report.longestSpeakingRunMs >= 25_000 && report.pauseCount === 0) {
    queryParts.push("long speaking run intentional pause idea boundary breath");
  }
  if (report.longestPauseMs >= 3_000 && report.pauseCount >= 1) queryParts.push("long silence gap flow recovery outline cue");
  const transcriptEligible = transcript?.available && durationMs >= 15_000 && transcript.wordCount >= 25;
  if (transcriptEligible && transcript.wordsPerMinute > 180) queryParts.push("fast pace wpm sentence phrase breath");
  if (transcriptEligible && transcript.fillerCount >= 3 && transcript.fillerRatePer100Words >= 4) {
    queryParts.push("filler word silence pause");
  }
  if (transcriptEligible && transcript.repeatedWordCount >= 2 && transcript.repetitionRatePer100Words >= 2) {
    queryParts.push("repetition word silence pause");
  }
  if (queryParts.every((part) => !String(part).trim())) queryParts.push("practice baseline retry evidence");

  const queryTokens = lexicalTokens(queryParts.join(" "));
  const ranked = COACHING_KNOWLEDGE_CARDS.map((card, index) => {
    const tagTokens = new Set(card.tags.flatMap((tag) => lexicalTokens(tag)));
    const titleTokens = new Set(lexicalTokens(card.title));
    const excerptTokens = new Set(lexicalTokens(card.excerpt));
    const drillTokens = new Set(lexicalTokens(card.drill));
    const matchedTerms = new Set();
    let score = 0;
    for (const token of queryTokens) {
      if (tagTokens.has(token)) {
        score += 4;
        matchedTerms.add(token);
      }
      if (titleTokens.has(token)) {
        score += 2;
        matchedTerms.add(token);
      }
      if (excerptTokens.has(token)) {
        score += 1;
        matchedTerms.add(token);
      }
      if (drillTokens.has(token)) {
        score += 0.5;
        matchedTerms.add(token);
      }
    }
    return { card, index, score: round(score, 2), matchedTerms: [...matchedTerms].sort() };
  }).sort((left, right) => right.score - left.score || left.index - right.index);

  const requestedLimit = clamp(Math.floor(positiveNumber(limit, 2)), 1, 3);
  // One incidental prose-token match is not enough to claim grounding. A
  // result must at least equal one exact tag match before it can outrank the
  // general repeat-and-compare fallback.
  const matches = ranked.filter((item) => item.score >= 4).slice(0, requestedLimit);
  if (matches.length === 0) {
    const fallback = COACHING_KNOWLEDGE_CARDS.find((card) => card.id === "repeat-and-compare");
    matches.push({ card: fallback, score: 0, matchedTerms: [] });
  }
  return matches.map(({ card, score, matchedTerms }) => ({
    id: card.id,
    title: card.title,
    excerpt: card.excerpt,
    drill: card.drill,
    source: card.source,
    score,
    matchedTerms,
  }));
}

/** Turn a finished measurement report into one strength and at most two priorities. */
export function buildAdvice(report) {
  if (!report) throw new TypeError("buildAdvice requires a coaching report.");
  const confidence = report.confidence?.level ?? "low";
  const durationSeconds = round((report.durationMs ?? 0) / 1_000, 1);
  const unknownMs = finiteNumber(report.unknownMs ?? report.unobservedMs, 0);
  const continuityScore = finiteNumber(report.continuity?.score, unknownMs > 0 ? 0 : 1);
  const unstableInput = report.durationMs >= 3_000 && (unknownMs >= 1_000 || continuityScore < 0.75);
  const summary = report.durationMs > 0
    ? unknownMs > 0
      ? `${formatPercent(report.speakingRatio)} of the observed audio was speech; ${formatSeconds(unknownMs)} had no reliable level frames. Measurement confidence is ${confidence}.`
      : `You spoke for ${formatPercent(report.speakingRatio)} of this ${durationSeconds}-second attempt. Measurement confidence is ${confidence}.`
    : "Record a short attempt to create an evidence-based coaching review.";

  const strengths = [];
  if (report.sampleCount >= 20 && report.clippingCount === 0) {
    strengths.push(adviceItem(
      "clean-input",
      "Clean microphone input",
      "The sampled input stayed below the clipping boundary.",
      `0 of ${report.sampleCount} level samples clipped.`,
    ));
  }
  if (!unstableInput && report.inputLevel?.status === "consistent") {
    strengths.push(adviceItem(
      "steady-level",
      "Steady delivery level",
      "Your voiced samples stayed close to the level learned during calibration.",
      `${formatPercent(report.inputLevel.withinCalibrationBandRatio)} of voiced samples were in your calibrated range.`,
    ));
  }
  if (report.pauseCount > 0 && report.medianPauseMs >= 400 && report.medianPauseMs <= 1_500) {
    strengths.push(adviceItem(
      "intentional-pauses",
      "Usable pause length",
      "Your typical measured pause was long enough to separate ideas without becoming an extended gap.",
      `Median measured pause: ${formatSeconds(report.medianPauseMs)} across ${report.pauseCount} pause${report.pauseCount === 1 ? "" : "s"}.`,
    ));
  }

  const candidates = [];
  if (unstableInput) {
    candidates.push(priorityItem(
      "restore-stable-input",
      110,
      "Restore a stable input signal",
      "The coach did not receive continuous level frames, so delivery advice from the missing interval would be unreliable.",
      `${formatSeconds(unknownMs)} lacked reliable level frames (${formatPercent(continuityScore)} coverage).`,
      "Confirm that the live microphone meter moves continuously, then repeat the same prompt before changing your delivery.",
    ));
  }
  if (report.sampleCount >= 20 && report.clippingCount >= 3 && report.clippingRatio >= 0.02) {
    candidates.push(priorityItem(
      "reduce-clipping",
      100,
      "Protect the recording",
      "Lower the input gain or move slightly farther from the microphone.",
      `${report.clippingCount} samples (${formatPercent(report.clippingRatio)}) reached the clipping boundary.`,
      "Repeat one sentence after reducing the input level, then confirm that the clipping count stays at zero.",
    ));
  }
  if (report.inputLevel?.status === "variable") {
    candidates.push(priorityItem(
      "steady-input-level",
      goalPriority(report.goal, ["volume", "level", "energy"], 72),
      "Keep microphone distance steady",
      "Large level changes can make delivery harder to follow even when the words are clear.",
      `${formatPercent(report.inputLevel.withinCalibrationBandRatio)} of voiced samples were inside your calibrated range.`,
      "Place the microphone a hand-span away and repeat without leaning toward or away from it.",
    ));
  }
  if (!unstableInput && report.longestSpeakingRunMs >= 25_000 && report.pauseCount === 0) {
    candidates.push(priorityItem(
      "add-intentional-pause",
      goalPriority(report.goal, "pause", 68),
      "Create an idea boundary",
      "Try one short, deliberate pause between two main ideas.",
      `Your longest speaking run was ${formatSeconds(report.longestSpeakingRunMs)}, with no pauses of at least 0.4 seconds.`,
      "Mark one slash in your notes where the first idea ends; pause there, breathe, and deliver the second idea.",
    ));
  }
  if (!unstableInput && report.longestPauseMs >= 3_000 && report.pauseCount >= 1) {
    candidates.push(priorityItem(
      "shorten-long-gap",
      goalPriority(report.goal, "flow", 62),
      "Plan the next landing point",
      "Use a three-word outline so you know which idea follows the pause.",
      `The longest measured pause was ${formatSeconds(report.longestPauseMs)}.`,
      "Write three cue words, answer again, and use the cue words only when changing ideas.",
    ));
  }

  const transcript = report.transcriptMetrics;
  if (transcript?.available && report.durationMs >= 15_000 && transcript.wordCount >= 25) {
    if (transcript.wordsPerMinute > 180) {
      candidates.push(priorityItem(
        "reduce-pace",
        goalPriority(report.goal, "pace", 75),
        "Leave more room between phrases",
        "Try a slightly slower retry while keeping the same wording.",
        `Estimated pace: ${transcript.wordsPerMinute} words per minute from ${transcript.wordCount} transcribed words.`,
        "Repeat the answer and take a small breath after each complete sentence.",
      ));
    }
    if (transcript.fillerCount >= 3 && transcript.fillerRatePer100Words >= 4) {
      candidates.push(priorityItem(
        "replace-fillers",
        goalPriority(report.goal, "filler", 64),
        "Replace one filler pattern",
        "Choose the most frequent marker and replace it with a silent beat on the next attempt.",
        `${transcript.fillerCount} possible filler markers were found (${transcript.fillerRatePer100Words} per 100 words).`,
        "Repeat the same answer and replace one recurring filler pattern with a short silent pause.",
      ));
    }
    if (transcript.repeatedWordCount >= 2 && transcript.repetitionRatePer100Words >= 2) {
      candidates.push(priorityItem(
        "reduce-immediate-repetition",
        55,
        "Finish the word, then continue",
        "A brief pause can replace an immediate repeated word without changing your idea.",
        `${transcript.repeatedWordCount} immediate repeated-word instances were found.`,
        "Repeat the answer and use a half-second pause when you notice an immediate repetition beginning.",
      ));
    }
  }

  if (report.durationMs > 0 && report.durationMs < 8_000) {
    candidates.push(priorityItem(
      "longer-baseline",
      90,
      "Collect a longer baseline",
      "A longer attempt gives pause and level patterns enough time to emerge.",
      `This attempt lasted ${durationSeconds} seconds.`,
      "Speak on the same prompt for at least 20 seconds before reviewing the measurements.",
    ));
  }

  const priorities = candidates
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 2)
    .map(({ priority: _priority, ...item }) => item);
  const retrieved = retrieveCoachingGuidance({ goal: report.goal, report, limit: 2 });
  const nextAttempt = generateGroundedNextAttempt(retrieved[0], priorities[0]);
  const caveats = [
    "These measurements describe this attempt; they do not infer confidence, emotion, personality, accent quality, or health.",
    ...(confidence === "low" ? ["Treat this review as provisional because the measurement evidence is limited."] : []),
    ...(transcript?.available ? ["Transcript-derived pace, filler, and repetition estimates depend on transcription accuracy and context."] : []),
  ];

  return {
    summary,
    strengths: strengths.slice(0, 2),
    priorities,
    primary: priorities[0] ?? null,
    nextAttempt,
    grounding: {
      mode: "local-lexical-rag",
      generation: "deterministic-template",
      libraryVersion: "v1",
      usedCardId: retrieved[0]?.id ?? null,
      retrieved,
      note: "Selected locally from product-authored coaching cards using the goal and aggregate measurements, then assembled with a metric-specific comparison prompt; no transcript text, model, or network call is used.",
    },
    caveats,
  };
}

function generateGroundedNextAttempt(card, priority) {
  const base = card?.drill
    ?? priority?.drill
    ?? "Repeat the same prompt once with one selected change.";
  const comparison = {
    "restore-stable-input": "Then confirm that signal coverage is stable before comparing delivery measurements.",
    "reduce-clipping": "Then compare the clipping-frame percentage with this attempt.",
    "steady-input-level": "Then compare level consistency with this attempt.",
    "add-intentional-pause": "Then compare the longest speaking run and measured pause count.",
    "shorten-long-gap": "Then compare the longest measured pause with this attempt.",
    "reduce-pace": "Then compare estimated words per minute, treating it as a transcript-dependent estimate.",
    "replace-fillers": "Then compare possible filler markers per 100 words.",
    "reduce-immediate-repetition": "Then compare immediate repetitions per 100 words.",
    "longer-baseline": "Use that longer attempt as the baseline for one comparable retry.",
  }[priority?.id] ?? "Then compare the same selected measurement with this attempt.";
  return `${base} ${comparison}`;
}

function tipCandidates(snapshot) {
  const candidates = [];
  const goal = String(snapshot.goal ?? "").toLowerCase();
  const enoughLevelEvidence = snapshot.sampleCount >= 20 && snapshot.durationMs >= 3_000;
  if (enoughLevelEvidence && snapshot.clippingCount >= 3 && snapshot.clippingRatio >= 0.02) {
    candidates.push({
      id: "clipping",
      priority: 100,
      message: "Lower the mic level or move back slightly.",
      evidence: `${snapshot.clippingCount} recent level samples reached the clipping boundary.`,
    });
  }
  if (snapshot.currentSilenceMs >= COACHING_THRESHOLDS.longSilenceTipMs && snapshot.speakingMs >= 1_500) {
    candidates.push({
      id: "resume-after-pause",
      priority: goalMatches(goal, "flow", "continuity") ? 88 : 65,
      message: "Restart with your main point—one clear sentence is enough.",
      evidence: `The current quiet gap has lasted ${formatSeconds(snapshot.currentSilenceMs)}.`,
    });
  }
  const focusedPauseGoal = goalMatches(goal, "pause", "pace", "presentation");
  const runThreshold = focusedPauseGoal
    ? COACHING_THRESHOLDS.focusedPauseRunTipMs
    : COACHING_THRESHOLDS.longSpeakingRunTipMs;
  if (snapshot.currentSpeakingRunMs >= runThreshold) {
    candidates.push({
      id: "intentional-pause",
      priority: focusedPauseGoal ? 84 : 58,
      message: "Land this idea, then take one intentional breath.",
      evidence: `This speaking run has continued for ${formatSeconds(snapshot.currentSpeakingRunMs)}.`,
    });
  }
  if (
    snapshot.inputLevel?.status === "variable"
    && snapshot.speakingMs >= 8_000
    && snapshot.inputLevel.voicedSampleCount >= 20
  ) {
    candidates.push({
      id: "steady-mic-distance",
      priority: goalMatches(goal, "volume", "level", "presence", "energy") ? 82 : 52,
      message: "Keep a steady distance from the microphone.",
      evidence: `${formatPercent(snapshot.inputLevel.withinCalibrationBandRatio)} of voiced samples are in your calibrated range.`,
    });
  }
  return candidates;
}

function normalizeCalibration(calibration) {
  if (!calibration) return deriveCalibration();
  const voiceReference = finiteNumber(
    calibration.voiceMedianRms ?? calibration.referenceRms ?? calibration.voiceRms ?? calibration.speechLevel,
    0.12,
  );
  const on = clamp(finiteNumber(calibration.speechOnThreshold ?? calibration.threshold, Math.max(0.015, voiceReference * 0.5)), 0.005, 0.8);
  const off = clamp(finiteNumber(calibration.speechOffThreshold, on * 0.72), 0.003, on * 0.95);
  const target = calibration.targetRmsRange ?? {};
  const low = clamp(finiteNumber(target.low, Math.max(on * 1.08, voiceReference * 0.48)), on, 0.75);
  const high = clamp(finiteNumber(target.high, Math.max(low * 1.35, voiceReference * 1.65)), low + 0.005, 0.92);
  return {
    ...calibration,
    speechOnThreshold: on,
    speechOffThreshold: off,
    targetRmsRange: { low, high },
    clippingThreshold: clamp(finiteNumber(calibration.clippingThreshold, COACHING_THRESHOLDS.clippingPeak), 0.5, 1),
    confidence: calibration.confidence ?? {
      score: 0.35,
      level: "low",
      reasons: ["Calibration confidence was not provided."],
      meaning: "Confidence describes measurement evidence, not the speaker.",
    },
  };
}

function inputLevelMetrics(samples, calibration, speakingMs) {
  if (samples.length === 0) {
    return {
      voicedSampleCount: 0,
      meanRms: null,
      medianRms: null,
      coefficientOfVariation: null,
      withinCalibrationBandRatio: null,
      consistency: null,
      status: "insufficient-data",
      calibratedRange: { ...calibration.targetRmsRange },
    };
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const coefficientOfVariation = Math.sqrt(variance) / Math.max(mean, EPSILON);
  const inRange = samples.filter((value) => (
    value >= calibration.targetRmsRange.low && value <= calibration.targetRmsRange.high
  )).length;
  const withinRatio = inRange / samples.length;
  const stability = clamp(1 - coefficientOfVariation / 0.75, 0, 1);
  const consistency = 0.7 * withinRatio + 0.3 * stability;
  const enoughEvidence = samples.length >= COACHING_THRESHOLDS.minimumLevelSamples && speakingMs >= 1_000;
  const status = !enoughEvidence
    ? "insufficient-data"
    : consistency >= 0.75
      ? "consistent"
      : consistency >= 0.5
        ? "mixed"
        : "variable";
  return {
    voicedSampleCount: samples.length,
    meanRms: round(mean, 5),
    medianRms: round(median(samples) ?? 0, 5),
    coefficientOfVariation: round(coefficientOfVariation, 3),
    withinCalibrationBandRatio: round(withinRatio, 4),
    consistency: enoughEvidence ? round(consistency, 3) : null,
    status,
    calibratedRange: { ...calibration.targetRmsRange },
  };
}

function measurementConfidence({ calibration, durationMs, observedDurationMs, speakingMs, sampleCount, continuity }) {
  const calibrationScore = clamp(finiteNumber(calibration.confidence?.score, 0.35), 0, 1);
  const expectedMinimumSamples = Math.max(8, observedDurationMs / COACHING_THRESHOLDS.frameHoldMs);
  const sampleDensity = clamp(sampleCount / expectedMinimumSamples, 0, 1);
  const durationEvidence = clamp(observedDurationMs / COACHING_THRESHOLDS.minimumReliableDurationMs, 0, 1);
  const voiceEvidence = clamp(speakingMs / 5_000, 0, 1);
  const weightedScore =
    calibrationScore * 0.25
      + sampleDensity * 0.2
      + durationEvidence * 0.25
      + voiceEvidence * 0.25
      + continuity * 0.05;
  // Missing frames are not evidence. Coverage therefore acts as a hard ceiling,
  // preventing projected duration from producing a high-confidence label.
  const score = round(Math.min(weightedScore, continuity), 3);
  const reasons = [
    ...(durationMs < COACHING_THRESHOLDS.minimumReliableDurationMs ? ["The attempt is shorter than 15 seconds."] : []),
    ...(speakingMs < 5_000 ? ["Fewer than five seconds of voice were observed."] : []),
    ...(sampleDensity < 0.75 ? ["Level samples were sparse for the observed duration."] : []),
    ...(continuity < 0.9 ? ["One or more long audio-callback gaps were observed."] : []),
    ...(calibration.confidence?.level === "low" ? ["The quiet and speaking calibration had limited evidence."] : []),
  ];
  return {
    score,
    level: confidenceLabel(score),
    reasons,
    meaning: "Confidence describes how much measurement evidence was available; it is not a rating of the speaker.",
  };
}

function compressSegments(input) {
  const segments = [];
  for (const candidate of input) {
    if (candidate.endMs <= candidate.startMs) continue;
    const last = segments[segments.length - 1];
    if (last?.kind === candidate.kind) last.endMs = candidate.endMs;
    else segments.push({ ...candidate });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 1; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (
        segment.kind !== "unknown"
        &&
        segment.endMs - segment.startMs < COACHING_THRESHOLDS.glitchMs
        && segments[index - 1].kind === segments[index + 1].kind
        && segments[index - 1].kind !== "unknown"
      ) {
        segments[index - 1].endMs = segments[index + 1].endMs;
        segments.splice(index, 2);
        changed = true;
        break;
      }
    }
  }
  return segments;
}

function findPauses(segments) {
  const pauses = [];
  for (let index = 1; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const durationMs = segment.durationMs;
    if (
      segment.kind === "silence"
      && segments[index - 1].kind === "voice"
      && segments[index + 1].kind === "voice"
      && durationMs >= COACHING_THRESHOLDS.pauseMs
    ) {
      pauses.push({
        startMs: segment.startMs,
        endMs: segment.endMs,
        durationMs,
      });
    }
  }
  return pauses;
}

function longestSpeakingRun(segments) {
  let longest = 0;
  let run = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.kind === "voice") {
      run += segment.durationMs;
      longest = Math.max(longest, run);
      continue;
    }
    const bridgesVoice = segment.durationMs <= COACHING_THRESHOLDS.bridgeGapMs
      && segments[index - 1]?.kind === "voice"
      && segments[index + 1]?.kind === "voice";
    if (bridgesVoice) run += segment.durationMs;
    else run = 0;
  }
  return longest;
}

function currentSilence(segments) {
  const last = segments[segments.length - 1];
  if (last?.kind !== "silence" || !segments.slice(0, -1).some((segment) => segment.kind === "voice")) return 0;
  return last.durationMs;
}

function currentSpeakingRun(segments) {
  const last = segments[segments.length - 1];
  if (last?.kind !== "voice") return 0;
  let run = last.durationMs;
  for (let index = segments.length - 2; index >= 1; index -= 2) {
    const gap = segments[index];
    const voice = segments[index - 1];
    if (gap.kind !== "silence" || voice?.kind !== "voice" || gap.durationMs > COACHING_THRESHOLDS.bridgeGapMs) break;
    run += gap.durationMs + voice.durationMs;
  }
  return run;
}

function sumDurations(segments, kind) {
  return segments.reduce((sum, segment) => sum + (segment.kind === kind ? segment.durationMs : 0), 0);
}

function levelsFrom(samples) {
  if (!Array.isArray(samples)) return [];
  return samples
    .map((sample) => typeof sample === "number" ? sample : sample?.rms)
    .filter((value) => Number.isFinite(value))
    .map((value) => clamp(value, 0, 1));
}

function lexicalTokens(value) {
  return (String(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((token) => token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token)
    .filter((token) => token.length > 1 && !RETRIEVAL_STOP_WORDS.has(token));
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values) {
  return quantile(values, 0.5);
}

function confidenceLabel(score) {
  return score >= 0.75 ? "high" : score >= 0.5 ? "medium" : "low";
}

function goalMatches(goal, ...keywords) {
  return keywords.some((keyword) => goal.includes(keyword));
}

function goalPriority(goal, keywords, base) {
  const values = Array.isArray(keywords) ? keywords : [keywords];
  return goalMatches(String(goal ?? "").toLowerCase(), ...values) ? base + 20 : base;
}

function adviceItem(id, title, message, evidence) {
  return { id, title, message, evidence };
}

function priorityItem(id, priority, title, message, evidence, drill) {
  return { id, priority, title, message, evidence, drill };
}

function formatPercent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function formatSeconds(milliseconds) {
  return `${round((milliseconds ?? 0) / 1_000, 1)} seconds`;
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite, non-negative number.`);
  return value;
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
