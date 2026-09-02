import assert from "node:assert/strict";
import test from "node:test";
import {
  coachingStoragePolicy,
  coachingStorageSchema,
  openCoachDatabase,
  readCoachingProgressSnapshot,
} from "./coach-storage.js";

test("the storage module exposes the required v3 lifecycle contract", () => {
  assert.deepEqual(coachingStorageSchema, {
    databaseName: "nonstoptalk-coaching",
    version: 3,
    summaryStore: "session-summaries",
    artifactStore: "session-artifacts",
    lifecycleStore: "artifact-lifecycle",
    lifecycleExpiryIndex: "expiresAtMs",
    lifecycleSchemaVersion: 1,
    artifactRetentionMs: 2_592_000_000,
    artifactMaxLogicalBytes: 134_217_728,
  });
});

test("the storage module fails explicitly when IndexedDB is unavailable", async () => {
  await assert.rejects(openCoachDatabase(null), /IndexedDB unavailable/u);
});

test("the storage module exposes the atomic progress snapshot reader", () => {
  assert.equal(typeof readCoachingProgressSnapshot, "function");
});

test("logical artifact bytes use Blob size plus exact UTF-8 transcript bytes", () => {
  assert.equal(coachingStoragePolicy.artifactLogicalBytes({
    audioBlob: new Blob([new Uint8Array(3)]),
    transcript: "é🙂",
  }), 9);
  assert.equal(coachingStoragePolicy.artifactLogicalBytes({
    audioBlob: new Blob([]),
    transcript: "",
  }), 0);
  assert.equal(coachingStoragePolicy.artifactLogicalBytes({ audioBlob: "not-a-blob", transcript: "" }), null);
  assert.equal(coachingStoragePolicy.artifactLogicalBytes({ audioBlob: null, transcript: 42 }), null);
  assert.equal(coachingStoragePolicy.artifactLogicalBytes({ audioBlob: null, transcript: "" }), null);
});

test("new and migrated lifecycle records share the exact 30-day boundary", () => {
  const retainedAtMs = 1_800_000_000_000;
  const artifact = { audioBlob: new Blob(["abc"]), transcript: "é" };
  const current = coachingStoragePolicy.artifactLifecycleRecord(
    artifact,
    "current",
    retainedAtMs,
    false,
  );
  const migrated = coachingStoragePolicy.artifactLifecycleRecord(
    artifact,
    "migrated",
    retainedAtMs,
    true,
  );

  assert.deepEqual(current, {
    id: "current",
    retainedAtMs,
    expiresAtMs: retainedAtMs + 2_592_000_000,
    logicalBytes: 5,
    lifecycleSchemaVersion: 1,
    legacyGrace: false,
  });
  assert.equal(migrated.legacyGrace, true);
  assert.equal(migrated.expiresAtMs - migrated.retainedAtMs, 2_592_000_000);
  assert.equal(coachingStoragePolicy.isArtifactLifecycleRecord(current, "current"), true);
  assert.equal(coachingStoragePolicy.isArtifactLifecycleRecord(migrated, "migrated"), true);
  assert.equal(coachingStoragePolicy.artifactLifecycleRecord(artifact, "invalid", retainedAtMs, "true"), null);
});

test("lifecycle validation is bounded, ID-matched, and conservative", () => {
  const base = {
    id: "artifact",
    retainedAtMs: 1_800_000_000_000,
    expiresAtMs: 1_802_592_000_000,
    logicalBytes: 134_217_728,
    lifecycleSchemaVersion: 1,
    legacyGrace: false,
  };
  const valid = (record) => coachingStoragePolicy.isArtifactLifecycleRecord(record, "artifact");

  assert.equal(valid(base), true, "the exact cap must remain valid");
  assert.equal(valid({ ...base, logicalBytes: 134_217_729 }), false);
  assert.equal(valid({ ...base, logicalBytes: 134_217_729, legacyGrace: true }), true,
    "over-cap legacy artifacts remain valid through their one-time grace");
  assert.equal(valid({ ...base, id: "other" }), false);
  assert.equal(valid({ ...base, retainedAtMs: -1 }), false);
  assert.equal(valid({ ...base, expiresAtMs: base.expiresAtMs + 1 }), false);
  assert.equal(valid({ ...base, logicalBytes: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(valid({ ...base, lifecycleSchemaVersion: 2 }), true,
    "a compatible future lifecycle version may retain the stable core fields");
  assert.equal(valid({ ...base, legacyGrace: "false" }), false);
});

test("summary scrubbing preserves compact analysis and loop relationships", () => {
  const summary = {
    id: "attempt",
    practiceLoopId: "loop",
    baselineAttemptId: "baseline",
    attemptRole: "retry",
    metrics: { durationMs: 30_000 },
    advice: { focus: "Keep this" },
    artifacts: {
      audioStored: true,
      audioBytes: 12,
      audioMimeType: "audio/webm",
      transcriptStored: true,
      transcriptMayBePartial: true,
    },
  };

  assert.deepEqual(coachingStoragePolicy.summaryWithoutArtifacts(summary), {
    ...summary,
    artifacts: {
      audioStored: false,
      audioBytes: 0,
      audioMimeType: "",
      transcriptStored: false,
      transcriptMayBePartial: false,
    },
  });
  assert.deepEqual(coachingStoragePolicy.summaryWithArtifactMetadata(summary, {
    audioBlob: new Blob(["abc"], { type: "audio/webm" }),
    audioMimeType: "audio/custom",
    transcript: "captured",
    transcriptMayBePartial: true,
  }), {
    ...summary,
    artifacts: {
      audioStored: true,
      audioBytes: 3,
      audioMimeType: "audio/custom",
      transcriptStored: true,
      transcriptMayBePartial: true,
    },
  }, "artifact-bearing saves must normalize truthful summary metadata");
});

test("quota detection follows a bounded nested cause chain", () => {
  const quota = new DOMException("full", "QuotaExceededError");
  assert.equal(coachingStoragePolicy.isQuotaExceededError({ cause: { cause: quota } }), true);
  assert.equal(coachingStoragePolicy.isQuotaExceededError({ cause: new Error("other") }), false);
});
