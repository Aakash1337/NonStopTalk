import assert from "node:assert/strict";
import test from "node:test";

import {
  COACHING_KNOWLEDGE_CARDS,
  COACHING_THRESHOLDS,
  CoachingAnalyzer,
  CoachingTipPolicy,
  analyzeTranscript,
  assessCalibrationReadiness,
  buildAdvice,
  deriveCalibration,
  retrieveCoachingGuidance,
} from "./coach-engine.js";

function calibrationSamples(value, count = 16, spread = 0.001) {
  return Array.from({ length: count }, (_, index) => ({
    rms: value + ((index % 3) - 1) * spread,
    peak: value * 1.7,
  }));
}

function calibratedAnalyzer(options = {}) {
  const calibration = deriveCalibration({
    quietSamples: calibrationSamples(0.006),
    voiceSamples: calibrationSamples(0.12, 16, 0.01),
  });
  return new CoachingAnalyzer({ calibration, targetDurationMs: 30_000, ...options });
}

function ingestRange(analyzer, startMs, endMs, rms, peak = rms * 1.6, stepMs = 100) {
  for (let atMs = startMs; atMs < endMs; atMs += stepMs) {
    analyzer.ingest({ atMs, rms, peak });
  }
}

function assertClose(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message || `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test("deriveCalibration separates quiet and voice levels and exposes UI aliases", () => {
  const calibration = deriveCalibration({
    quietSamples: calibrationSamples(0.005),
    voiceSamples: calibrationSamples(0.14, 16, 0.012),
  });

  assert.ok(calibration.speechOffThreshold < calibration.speechOnThreshold);
  assert.ok(calibration.speechOnThreshold > calibration.quietCeilingRms);
  assert.ok(calibration.speechOnThreshold < calibration.voiceFloorRms);
  assert.ok(calibration.targetRmsRange.low < calibration.targetRmsRange.high);
  assert.equal(calibration.noiseFloor, calibration.quietMedianRms);
  assert.equal(calibration.quietRms, calibration.quietMedianRms);
  assert.equal(calibration.referenceRms, calibration.voiceMedianRms);
  assert.equal(calibration.voiceRms, calibration.voiceMedianRms);
  assert.equal(calibration.speechLevel, calibration.voiceMedianRms);
  assert.equal(calibration.confidence.level, "high");
  assert.match(calibration.confidence.meaning, /measurement evidence/i);
});

test("deriveCalibration accepts numbers and marks weak evidence as low confidence", () => {
  const calibration = deriveCalibration({
    quietSamples: [0.01, 0.011],
    voiceSamples: [0.011, 0.012],
  });

  assert.equal(calibration.quietSampleCount, 2);
  assert.equal(calibration.voiceSampleCount, 2);
  assert.equal(calibration.confidence.level, "low");
  assert.ok(calibration.confidence.reasons.length > 0);
  assert.ok(calibration.speechOffThreshold < calibration.speechOnThreshold);
});

test("calibration readiness auto-starts medium and high evidence but pauses low evidence", () => {
  for (const [level, score] of [["medium", 0.6], ["high", 0.9]]) {
    const readiness = assessCalibrationReadiness({ confidence: { score, level, reasons: [] } });
    assert.equal(readiness.status, "ready");
    assert.equal(readiness.canStartAutomatically, true);
    assert.equal(readiness.requiresConfirmation, false);
    assert.equal(readiness.confidence.level, level);
  }

  const limited = assessCalibrationReadiness({
    confidence: {
      score: 0.2,
      level: "low",
      reasons: [" Quiet and speaking levels were not clearly separated. "],
    },
  });
  assert.equal(limited.status, "needs-confirmation");
  assert.equal(limited.canStartAutomatically, false);
  assert.equal(limited.requiresConfirmation, true);
  assert.deepEqual(limited.confidence.reasons, ["Quiet and speaking levels were not clearly separated."]);
  assert.match(limited.confidence.meaning, /not the speaker/i);
});

test("calibration readiness fails closed when confidence metadata is absent", () => {
  const readiness = assessCalibrationReadiness();
  assert.equal(readiness.status, "needs-confirmation");
  assert.equal(readiness.confidence.level, "low");
  assert.equal(readiness.confidence.score, 0);
  assert.ok(readiness.confidence.reasons.length > 0);

  const partial = assessCalibrationReadiness({ confidence: { level: "high" } });
  assert.equal(partial.status, "needs-confirmation");
  assert.equal(partial.confidence.level, "low");

  const inconsistent = assessCalibrationReadiness({ confidence: { score: 0.2, level: "high" } });
  assert.equal(inconsistent.status, "needs-confirmation");
  assert.equal(inconsistent.confidence.level, "low");

  for (const invalidScore of [Number.NaN, -0.01, 1.01, true, "0.9", [0.9], { valueOf: () => 0.9 }]) {
    const invalid = assessCalibrationReadiness({ confidence: { score: invalidScore, level: "high" } });
    assert.equal(invalid.status, "needs-confirmation");
    assert.equal(invalid.confidence.score, 0);
  }

  const roundedBoundary = assessCalibrationReadiness({ confidence: { score: 0.4996 } });
  assert.equal(roundedBoundary.confidence.score, 0.5);
  assert.equal(roundedBoundary.confidence.level, "medium");
});

test("medium calibration keeps its known limitation in the ephemeral report", () => {
  const calibration = deriveCalibration({
    quietSamples: calibrationSamples(0.01),
    voiceSamples: calibrationSamples(0.013),
  });
  const readiness = assessCalibrationReadiness(calibration);
  const analyzer = new CoachingAnalyzer({ calibration, targetDurationMs: 30_000 });
  ingestRange(analyzer, 0, 30_000, 0.12);
  const report = analyzer.finish(30_000);

  assert.equal(readiness.status, "ready");
  assert.equal(calibration.confidence.level, "medium");
  assert.match(calibration.confidence.reasons.join(" "), /not clearly separated/i);
  assert.deepEqual(report.calibrationConfidence.reasons, calibration.confidence.reasons);
});

test("analyzer measures speaking ratio, completed pauses, and bridged speaking runs", () => {
  const analyzer = calibratedAnalyzer();
  ingestRange(analyzer, 0, 1_000, 0.004);
  ingestRange(analyzer, 1_000, 4_000, 0.12);
  ingestRange(analyzer, 4_000, 4_200, 0.004);
  ingestRange(analyzer, 4_200, 7_000, 0.12);
  ingestRange(analyzer, 7_000, 7_600, 0.004);
  ingestRange(analyzer, 7_600, 10_000, 0.12);

  const report = analyzer.snapshot(10_000);

  assert.equal(report.durationMs, 10_000);
  assert.equal(report.speakingMs, 8_200);
  assert.equal(report.voicedMs, report.speakingMs);
  assert.equal(report.silenceMs, 1_800);
  assert.equal(report.speakingRatio, 0.82);
  assert.equal(report.pauseCount, 1, "the 200ms break is bridged and is not a measured pause");
  assert.equal(report.medianPauseMs, 600);
  assert.equal(report.longestPauseMs, 600);
  assert.equal(report.longestSpeakingRunMs, 6_000, "the first two voice spans bridge a 200ms gap");
  assert.equal(report.currentSpeakingRunMs, 2_400);
  assert.equal(report.currentSilenceMs, 0);
  assert.deepEqual(report.segments.map(({ kind, durationMs }) => ({ kind, durationMs })), [
    { kind: "silence", durationMs: 1_000 },
    { kind: "voice", durationMs: 3_000 },
    { kind: "silence", durationMs: 200 },
    { kind: "voice", durationMs: 2_800 },
    { kind: "silence", durationMs: 600 },
    { kind: "voice", durationMs: 2_400 },
  ]);
  assert.equal(report.segments[0].voiced, false);
  assert.equal(report.segments[1].voiced, true);
  assert.equal(report.pauseThresholdMs, 400);
  assert.equal(report.speakingRunBridgeMs, 250);
});

test("analyzer reports calibrated level consistency and clipping without a quality score", () => {
  const analyzer = calibratedAnalyzer();
  for (let atMs = 0; atMs < 10_000; atMs += 100) {
    const clipping = atMs >= 2_000 && atMs < 2_300;
    analyzer.ingest({ atMs, rms: 0.12 + (atMs % 300 === 0 ? 0.005 : 0), peak: clipping ? 0.99 : 0.3 });
  }
  const report = analyzer.snapshot(10_000);

  assert.equal(report.inputLevel.status, "consistent");
  assert.ok(report.inputLevelConsistency > 0.9);
  assertClose(report.levelConsistencyPct, report.inputLevelConsistency * 100, 0.11);
  assert.equal(report.clippingCount, 3);
  assert.equal(report.clipping.eventCount, 1);
  assert.equal(report.clipping.durationMs, 300);
  assertClose(report.clippingPct, report.clippingRatio * 100, 0.011);
  assert.equal(report.audioConfidence, report.confidence.level);
  assert.equal(report.calibrationConfidence.level, "high");
  assert.match(report.calibrationConfidence.meaning, /not the speaker/i);
  assert.equal("score" in report, false, "there is deliberately no universal speaker score");
  assert.match(report.confidence.meaning, /not a rating of the speaker/i);
});

test("analyzer ignores leading and unfinished trailing silence as completed pauses", () => {
  const analyzer = calibratedAnalyzer();
  ingestRange(analyzer, 0, 1_000, 0.004);
  ingestRange(analyzer, 1_000, 4_000, 0.12);
  ingestRange(analyzer, 4_000, 7_000, 0.004);

  const live = analyzer.snapshot(7_000);
  assert.equal(live.pauseCount, 0);
  assert.equal(live.currentSilenceMs, 3_000);
  assert.equal(live.longestPauseMs, 0);
});

test("callback gaps beyond 250ms become unknown instead of voice, silence, or clipping", () => {
  const analyzer = calibratedAnalyzer();
  analyzer.ingest({ atMs: 0, rms: 0.12, peak: 0.99 });
  analyzer.ingest({ atMs: 100, rms: 0.12, peak: 0.99 });

  const report = analyzer.snapshot(1_000);

  assert.equal(report.durationMs, 1_000);
  assert.equal(report.speakingMs, 350, "the last frame describes at most the next 250ms");
  assert.equal(report.silenceMs, 0);
  assert.equal(report.unknownMs, 650);
  assert.equal(report.unobservedMs, 650);
  assert.equal(report.observedDurationMs, 350);
  assert.equal(report.coverageRatio, 0.35);
  assert.equal(report.clipping.durationMs, 350, "clipping duration is capped at the same frame hold boundary");
  assert.deepEqual(report.segments.map(({ kind, voiced, durationMs }) => ({ kind, voiced, durationMs })), [
    { kind: "voice", voiced: true, durationMs: 350 },
    { kind: "unknown", voiced: null, durationMs: 650 },
  ]);
});

test("an internal callback gap breaks speaking runs and preserves unknown time", () => {
  const analyzer = calibratedAnalyzer();
  analyzer.ingest({ atMs: 0, rms: 0.12, peak: 0.99 });
  analyzer.ingest({ atMs: 100, rms: 0.12, peak: 0.2 });
  analyzer.ingest({ atMs: 1_000, rms: 0.12, peak: 0.99 });

  const report = analyzer.snapshot(1_100);

  assert.equal(report.speakingMs, 450);
  assert.equal(report.unknownMs, 650);
  assert.equal(report.longestSpeakingRunMs, 350, "unknown time must not bridge two voice regions");
  assert.equal(report.clipping.eventCount, 2, "unknown time separates otherwise clipped samples into distinct events");
  assert.deepEqual(report.segments.map(({ kind, durationMs }) => ({ kind, durationMs })), [
    { kind: "voice", durationMs: 350 },
    { kind: "unknown", durationMs: 650 },
    { kind: "voice", durationMs: 100 },
  ]);
});

test("poor continuity caps confidence and prioritizes restoring input over false delivery advice", () => {
  const analyzer = calibratedAnalyzer({ goal: "pauses" });
  ingestRange(analyzer, 0, 1_000, 0.12);

  const report = analyzer.snapshot(30_000);
  const advice = buildAdvice(report);

  assert.equal(report.unknownMs, 28_850);
  assert.equal(report.speakingMs, 1_150);
  assert.equal(report.longestSpeakingRunMs, 1_150);
  assert.equal(report.confidence.level, "low");
  assert.ok(report.confidence.score <= report.continuity.score);
  assert.equal(advice.priorities[0].id, "restore-stable-input");
  assert.ok(!advice.priorities.some((item) => item.id === "add-intentional-pause"));
  assert.equal(advice.grounding.retrieved[0].id, "protect-input-level");
  assert.equal(advice.grounding.usedCardId, null);
  assert.match(advice.summary, /no reliable level frames/i);
});

test("an attempt with no level callbacks is entirely unknown and receives input-recovery advice", () => {
  const analyzer = calibratedAnalyzer({ goal: "pace" });
  const report = analyzer.snapshot(5_000);
  const advice = buildAdvice(report);

  assert.equal(report.durationMs, 5_000);
  assert.equal(report.observedDurationMs, 0);
  assert.equal(report.unknownMs, 5_000);
  assert.equal(report.coverageRatio, 0);
  assert.deepEqual(report.segments, [{
    kind: "unknown",
    voiced: null,
    startMs: 0,
    endMs: 5_000,
    durationMs: 5_000,
  }]);
  assert.equal(report.confidence.score, 0);
  assert.equal(advice.priorities[0].id, "restore-stable-input");
});

test("continuing after limited calibration keeps the finished attempt confidence low", () => {
  const analyzer = new CoachingAnalyzer({
    calibration: deriveCalibration({
      quietSamples: calibrationSamples(0.01),
      voiceSamples: calibrationSamples(0.011),
    }),
    targetDurationMs: 30_000,
  });
  ingestRange(analyzer, 0, 30_000, 0.12);

  const report = analyzer.finish(30_000);

  assert.equal(report.calibrationConfidence.level, "low");
  assert.equal(report.confidence.level, "low");
  assert.ok(report.confidence.score < 0.5);
  assert.match(report.confidence.reasons.join(" "), /calibration had limited evidence/i);
});

test("analyzer rejects out-of-order input and ingest after finish", () => {
  const analyzer = calibratedAnalyzer();
  analyzer.ingest({ atMs: 100, rms: 0.1, peak: 0.2 });
  assert.throws(() => analyzer.ingest({ atMs: 99, rms: 0.1, peak: 0.2 }), /timestamp order/);
  const report = analyzer.finish(1_000);
  assert.equal(report, analyzer.finish(2_000), "finish is idempotent");
  assert.throws(() => analyzer.ingest({ atMs: 1_100, rms: 0.1, peak: 0.2 }), /after finish/);
});

test("finish does not claim transcript use for empty or whitespace-only input", () => {
  const analyzer = calibratedAnalyzer();
  ingestRange(analyzer, 0, 2_000, 0.12);
  const report = analyzer.finish(2_000, "   \n\t ");
  assert.equal(report.transcriptMetrics, null);
});

test("tip policy requires evidence and enforces an eight-second global cooldown", () => {
  const policy = new CoachingTipPolicy();
  const clippingSnapshot = {
    goal: "steady-volume",
    observedAtMs: 10_000,
    durationMs: 10_000,
    sampleCount: 100,
    speakingMs: 8_000,
    currentSilenceMs: 0,
    currentSpeakingRunMs: 2_000,
    clippingCount: 4,
    clippingRatio: 0.04,
    inputLevel: { status: "consistent", voicedSampleCount: 80, withinCalibrationBandRatio: 0.9 },
  };

  const first = policy.evaluate(clippingSnapshot, 10_000);
  assert.equal(first.id, "clipping");
  assert.equal(first.text, first.message);
  assert.match(first.evidence, /4/);
  assert.equal(policy.evaluate(clippingSnapshot, 17_999), null);
  assert.equal(policy.evaluate(clippingSnapshot, 18_000).id, "clipping");

  const tooLittleEvidence = { ...clippingSnapshot, sampleCount: 5, clippingCount: 3, clippingRatio: 0.6 };
  assert.equal(new CoachingTipPolicy().evaluate(tooLittleEvidence, 1_000), null);
  assert.equal(COACHING_THRESHOLDS.tipCooldownMs, 8_000);
});

test("tip policy can cue recovery from a long live gap and an intentional pause", () => {
  const silencePolicy = new CoachingTipPolicy();
  const silenceTip = silencePolicy.evaluate({
    goal: "flow",
    sampleCount: 100,
    durationMs: 20_000,
    speakingMs: 12_000,
    currentSilenceMs: 3_200,
    currentSpeakingRunMs: 0,
    clippingCount: 0,
    clippingRatio: 0,
    inputLevel: { status: "consistent", voicedSampleCount: 60, withinCalibrationBandRatio: 0.9 },
  }, 20_000);
  assert.equal(silenceTip.id, "resume-after-pause");
  assert.match(silenceTip.evidence, /3.2 seconds/);

  const pausePolicy = new CoachingTipPolicy();
  const pauseTip = pausePolicy.evaluate({
    goal: "intentional-pauses",
    sampleCount: 220,
    durationMs: 22_000,
    speakingMs: 21_000,
    currentSilenceMs: 0,
    currentSpeakingRunMs: 19_000,
    clippingCount: 0,
    clippingRatio: 0,
    inputLevel: { status: "consistent", voicedSampleCount: 200, withinCalibrationBandRatio: 0.9 },
  }, 22_000);
  assert.equal(pauseTip.id, "intentional-pause");
});

test("analyzeTranscript estimates pace, configured filler markers, and immediate repetitions", () => {
  const metrics = analyzeTranscript("Um, I I think, you know, this is is useful.", 30_000);

  assert.equal(metrics.wordCount, 10);
  assert.equal(metrics.wordsPerMinute, 20);
  assert.equal(metrics.wpm, 20);
  assert.equal(metrics.fillerCount, 2);
  assert.deepEqual(metrics.fillerOccurrences, [
    { phrase: "you know", count: 1 },
    { phrase: "um", count: 1 },
  ]);
  assert.equal(metrics.repeatedWordCount, 2);
  assert.deepEqual(metrics.repeatedWords, [
    { word: "i", count: 1 },
    { word: "is", count: 1 },
  ]);
  assert.equal(metrics.isEstimate, true);
  assert.match(metrics.caveats.join(" "), /intentional/i);
});

test("analyzeTranscript supports Unicode words and empty transcripts", () => {
  const unicode = analyzeTranscript("Café déjà vu. Café!", 12_000);
  assert.equal(unicode.wordCount, 4);
  assert.equal(unicode.wordsPerMinute, 20);

  const empty = analyzeTranscript("", 0);
  assert.equal(empty.available, false);
  assert.equal(empty.wordCount, 0);
  assert.equal(empty.wordsPerMinute, null);
  assert.equal(empty.fillerRatePer100Words, 0);
});

test("local RAG retrieves a pause card from the real UI goal and aggregate evidence", () => {
  const retrieved = retrieveCoachingGuidance({
    goal: "pauses",
    report: {
      goal: "pauses",
      durationMs: 30_000,
      pauseCount: 0,
      longestSpeakingRunMs: 26_000,
      clippingCount: 0,
      inputLevel: { status: "consistent" },
    },
  });

  assert.equal(retrieved[0].id, "idea-boundary-pause");
  assert.match(retrieved[0].source, /NonStopTalk Coaching Library/);
  assert.ok(retrieved[0].matchedTerms.includes("pause"));
  assert.equal(Object.isFrozen(COACHING_KNOWLEDGE_CARDS), true);
  assert.equal(new Set(COACHING_KNOWLEDGE_CARDS.map((card) => card.id)).size, COACHING_KNOWLEDGE_CARDS.length);
});

test("local RAG prioritizes microphone guidance for the energy goal and clipping evidence", () => {
  const retrieved = retrieveCoachingGuidance({
    goal: "energy",
    report: {
      goal: "energy",
      durationMs: 30_000,
      clippingCount: 5,
      clippingRatio: 0.04,
      inputLevel: { status: "variable" },
    },
  });

  assert.equal(retrieved[0].id, "protect-input-level");
  assert.ok(!retrieved[1] || retrieved[0].score > retrieved[1].score);
  assert.match(retrieved[0].drill, /microphone/i);
});

test("missing callback recovery is not replaced by unsupported microphone-level guidance", () => {
  const missingCallbacks = {
    goal: "pauses",
    durationMs: 15_000,
    speakingRatio: 0.5,
    sampleCount: 20,
    clippingCount: 0,
    clippingRatio: 0,
    inputLevel: { status: "insufficient-data", withinCalibrationBandRatio: null },
    pauseCount: 0,
    medianPauseMs: 0,
    longestPauseMs: 0,
    longestSpeakingRunMs: 1_000,
    unknownMs: 12_000,
    continuity: { score: 0.2 },
    confidence: { level: "low" },
  };
  const advice = buildAdvice(missingCallbacks);

  assert.equal(advice.primary.id, "restore-stable-input");
  assert.equal(advice.grounding.retrieved[0].id, "protect-input-level");
  assert.equal(advice.grounding.usedCardId, null, "retrieval alone must not be reported as drill generation");
  assert.match(advice.grounding.note, /evidence-safety rule/i);
  assert.ok(advice.nextAttempt.startsWith(advice.primary.drill));
  assert.doesNotMatch(advice.nextAttempt, /one hand-span/i);

  const supportedInputAdvice = buildAdvice({
    ...missingCallbacks,
    sampleCount: 50,
    clippingCount: 4,
    clippingRatio: 0.08,
  });
  assert.equal(supportedInputAdvice.primary.id, "restore-stable-input");
  assert.equal(supportedInputAdvice.grounding.usedCardId, "protect-input-level");
  assert.ok(supportedInputAdvice.nextAttempt.startsWith(supportedInputAdvice.grounding.retrieved[0].drill));
});

test("local RAG does not turn below-threshold evidence into adjustment advice", () => {
  const belowClippingGate = retrieveCoachingGuidance({
    goal: "balanced-delivery",
    limit: 1,
    report: {
      goal: "balanced-delivery",
      durationMs: 10_000,
      sampleCount: 10,
      clippingCount: 3,
      clippingRatio: 0.3,
      inputLevel: { status: "mixed" },
    },
  });
  assert.equal(belowClippingGate[0].id, "repeat-and-compare");

  const belowTranscriptGate = retrieveCoachingGuidance({
    goal: "balanced-delivery",
    limit: 1,
    report: {
      goal: "balanced-delivery",
      durationMs: 14_000,
      sampleCount: 140,
      transcriptMetrics: {
        available: true,
        wordCount: 10,
        wordsPerMinute: 200,
        fillerCount: 4,
        fillerRatePer100Words: 40,
        repeatedWordCount: 3,
        repetitionRatePer100Words: 30,
      },
    },
  });
  assert.equal(belowTranscriptGate[0].id, "repeat-and-compare");
});

test("finish attaches transcript metrics and bounded, evidence-based advice", () => {
  const analyzer = calibratedAnalyzer({ goal: "pace-and-fillers" });
  for (let atMs = 0; atMs < 20_000; atMs += 100) {
    analyzer.ingest({ atMs, rms: 0.12, peak: atMs < 500 ? 0.99 : 0.3 });
  }
  const transcript = `${"clear ".repeat(56)}um um um`;
  const report = analyzer.finish(20_000, transcript);

  assert.ok(report.transcriptMetrics.wordsPerMinute > 170);
  assert.equal(report.transcriptMetrics.fillerCount, 3);
  assert.ok(report.advice.priorities.length <= 2);
  assert.equal(report.advice.primary, report.advice.priorities[0]);
  assert.equal(report.advice.priorities[0].id, "reduce-clipping");
  assert.match(report.advice.priorities[0].evidence, /samples/);
  assert.equal(report.advice.grounding.mode, "local-lexical-rag");
  assert.equal(report.advice.grounding.usedCardId, "protect-input-level");
  assert.ok(report.advice.nextAttempt.startsWith(report.advice.grounding.retrieved[0].drill));
  assert.match(report.advice.nextAttempt, /clipping-frame percentage/i);
  assert.doesNotMatch(JSON.stringify(report.advice.grounding), /clear clear|um um/i);
  assert.match(report.advice.caveats.join(" "), /do not infer confidence/i);
  assert.equal("score" in report.advice, false);
});

test("buildAdvice recommends a longer baseline when evidence is too short", () => {
  const report = calibratedAnalyzer().snapshot(0);
  const advice = buildAdvice({
    ...report,
    goal: "pauses",
    durationMs: 5_000,
    continuity: { score: 1 },
    speakingRatio: 0.7,
    transcriptMetrics: {
      available: true,
      wordCount: 30,
      wordsPerMinute: 240,
      fillerCount: 4,
      repeatedWordCount: 0,
    },
  });
  assert.equal(advice.priorities[0].id, "longer-baseline");
  assert.equal(advice.grounding.usedCardId, "repeat-and-compare");
  assert.ok(advice.nextAttempt.startsWith(advice.grounding.retrieved[0].drill));
  assert.match(advice.nextAttempt, /comparable retry/i);
  assert.match(advice.nextAttempt, /at least 20 seconds/i);
});
