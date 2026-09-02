import assert from "node:assert/strict";
import test from "node:test";
import { coachingStorageSchema, openCoachDatabase } from "./coach-storage.js";

test("the compatibility storage module preserves the v2 schema contract", () => {
  assert.deepEqual(coachingStorageSchema, {
    databaseName: "nonstoptalk-coaching",
    version: 2,
    summaryStore: "session-summaries",
    artifactStore: "session-artifacts",
    optionalLifecycleStore: "artifact-lifecycle",
    artifactRetentionMs: 2_592_000_000,
    artifactMaxLogicalBytes: 134_217_728,
  });
});

test("the storage module fails explicitly when IndexedDB is unavailable", async () => {
  await assert.rejects(openCoachDatabase(null), /IndexedDB unavailable/u);
});
