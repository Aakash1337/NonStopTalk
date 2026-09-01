import assert from "node:assert/strict";
import test from "node:test";

import {
  createCloudProgressClient,
  mergeCoachingSummaries,
  sanitizeCloudSummary,
} from "./cloud-progress.js";

test("cloud summary allowlist excludes raw media and captured transcript text", () => {
  const summary = sanitizeCloudSummary({
    analysisSchemaVersion: 2,
    id: "attempt-1",
    createdAt: "2026-08-30T12:00:00.000Z",
    scenario: "interview",
    goal: "pauses",
    targetDurationMs: 45_000,
    practiceLoopId: "loop-1",
    baselineAttemptId: "attempt-1",
    attemptRole: "baseline",
    feedbackMode: "review-only",
    metrics: {
      durationMs: 44_000,
      speakingRatio: 0.72,
      transcriptMetrics: {
        wordCount: 90,
        fillerOccurrences: [{ phrase: "um", count: 2 }],
        capturedTranscript: "this must not leave the browser",
      },
      samples: [1, 2, 3],
    },
    advice: { focus: "Pause once.", hiddenPrompt: "not allowed" },
    artifacts: { audioBlob: "not allowed", transcript: "not allowed" },
    transcript: "not allowed",
  });
  assert.equal(summary.metrics.speakingRatio, 0.72);
  assert.deepEqual(summary.metrics.transcriptMetrics.fillerOccurrences, [{ phrase: "um", count: 2 }]);
  assert.equal(summary.advice.focus, "Pause once.");
  assert.deepEqual({
    practiceLoopId: summary.practiceLoopId,
    baselineAttemptId: summary.baselineAttemptId,
    attemptRole: summary.attemptRole,
    feedbackMode: summary.feedbackMode,
  }, {
    practiceLoopId: "loop-1",
    baselineAttemptId: "attempt-1",
    attemptRole: "baseline",
    feedbackMode: "review-only",
  });
  assert.equal(JSON.stringify(summary).includes("must not leave"), false);
  assert.equal("artifacts" in summary, false);
  assert.equal("samples" in summary.metrics, false);
  assert.equal("hiddenPrompt" in summary.advice, false);
});

test("legacy cloud summaries remain relationship-free", () => {
  const summary = sanitizeCloudSummary({
    analysisSchemaVersion: 2,
    id: "legacy",
    createdAt: "2026-08-30T12:00:00.000Z",
    scenario: "interview",
    goal: "pauses",
    targetDurationMs: 45_000,
    metrics: {},
    advice: {},
  });
  assert.equal("practiceLoopId" in summary, false);
  assert.equal("attemptRole" in summary, false);
});

test("cloud client is opt-in and sends only the sanitized summary", async () => {
  const values = new Map();
  const calls = [];
  const client = createCloudProgressClient({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return { ok: true, status: 200, json: async () => ({ session: { id: "a" } }), headers: new Headers() };
    },
  });
  assert.equal(client.isEnabled(), false);
  await client.save({ id: "a", transcript: "secret", metrics: {}, advice: {} });
  assert.equal(client.isEnabled(), true);
  assert.equal(calls[0].path, "/api/v1/progress/sessions");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body.includes("secret"), false);
});

test("merge keeps cloud-only records and lets local artifact metadata win", () => {
  const merged = mergeCoachingSummaries(
    [{ id: "same", createdAt: "2026-01-01", artifacts: { audioStored: true } }],
    [{ id: "cloud", createdAt: "2026-02-01" }, { id: "same", createdAt: "2026-01-01" }],
  );
  assert.deepEqual(merged.map((item) => item.id), ["cloud", "same"]);
  assert.equal(merged[1].artifacts.audioStored, true);
});

test("cloud list follows opaque cursors instead of silently stopping at one page", async () => {
  const paths = [];
  const client = createCloudProgressClient({
    storage: null,
    fetchImpl: async (path) => {
      paths.push(path);
      const secondPage = path.includes("cursor=page-2");
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => secondPage
          ? { sessions: [{ id: "older" }], nextCursor: null }
          : { sessions: [{ id: "newer" }], nextCursor: "page-2" },
      };
    },
  });
  assert.deepEqual((await client.list()).map((item) => item.id), ["newer", "older"]);
  assert.equal(paths.length, 2);
  assert.match(paths[0], /limit=100/u);
  assert.match(paths[1], /cursor=page-2/u);
});
