import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  getFreePort,
  isolatedChildEnv,
  startCaptured,
  terminateProcessTree,
} from "./smoke-process-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const releaseAFixturePath = path.join(root, "scripts", "fixtures", "coach-storage-release-a.js");
const RELEASE_A_SHA256 = "bd3d0db9665cbbd8ab39c63ba6edbcc665f9a388ab49db95948e9dcacea4ebc5";
const DB_NAME = "nonstoptalk-coaching";
const SUMMARY_STORE = "session-summaries";
const ARTIFACT_STORE = "session-artifacts";
const LIFECYCLE_STORE = "artifact-lifecycle";
const RETENTION_MS = 2_592_000_000;
const MAX_LOGICAL_BYTES = 134_217_728;

function installStorageSmokeHelpers() {
  const databaseName = "nonstoptalk-coaching";

  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });

  const transactionDone = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
  });

  const openRaw = (version) => new Promise((resolve, reject) => {
    const request = version === undefined
      ? indexedDB.open(databaseName)
      : indexedDB.open(databaseName, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open IndexedDB"));
    request.onblocked = () => reject(new Error("Raw IndexedDB open was blocked"));
  });

  const normalizedArtifact = (artifact) => ({
    id: artifact?.id,
    createdAt: artifact?.createdAt,
    audioSize: artifact?.audioBlob instanceof Blob ? artifact.audioBlob.size : -1,
    audioType: artifact?.audioBlob instanceof Blob ? artifact.audioBlob.type : "",
    transcript: artifact?.transcript,
    transcriptMayBePartial: artifact?.transcriptMayBePartial,
  });

  const schemaForStore = (store) => ({
    keyPath: store.keyPath,
    indexes: [...store.indexNames].sort().map((name) => {
      const index = store.index(name);
      return {
        name,
        keyPath: index.keyPath,
        unique: index.unique,
        multiEntry: index.multiEntry,
      };
    }),
  });

  globalThis.__coachStorageSmoke = {
    requestResult,
    transactionDone,
    openRaw,
    async inspect() {
      const database = await openRaw();
      try {
        const stores = [...database.objectStoreNames].sort();
        const transaction = database.transaction(stores, "readonly");
        const schema = Object.fromEntries(stores.map((name) => [
          name,
          schemaForStore(transaction.objectStore(name)),
        ]));
        const requests = Object.fromEntries(stores.map((name) => [
          name,
          transaction.objectStore(name).getAll(),
        ]));
        await transactionDone(transaction);
        return {
          version: database.version,
          stores,
          schema,
          summaries: (requests["session-summaries"]?.result || [])
            .sort((left, right) => String(left.id).localeCompare(String(right.id))),
          artifacts: (requests["session-artifacts"]?.result || [])
            .map(normalizedArtifact)
            .sort((left, right) => String(left.id).localeCompare(String(right.id))),
          lifecycle: (requests["artifact-lifecycle"]?.result || [])
            .sort((left, right) => String(left.id).localeCompare(String(right.id))),
        };
      } finally {
        database.close();
      }
    },
  };
}

async function launchBrowser() {
  const chromiumSandbox = process.getuid?.() === 0 ? false : undefined;
  const attempts = [{}, { channel: "chrome" }, { channel: "msedge" }];
  if (process.env.SMOKE_CHROMIUM) attempts.unshift({ executablePath: process.env.SMOKE_CHROMIUM });
  let lastError;
  for (const attempt of attempts) {
    try {
      return await chromium.launch({
        headless: process.env.HEADED !== "1",
        chromiumSandbox,
        ...attempt,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function waitForAsset(origin, child, output) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Wrangler exited before readiness (${String(child.exitCode ?? child.signalCode)}).\n${output()}`);
    }
    try {
      const response = await fetch(`${origin}/coach-storage.js`, {
        headers: { Accept: "text/javascript" },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200 && (response.headers.get("content-type") || "").includes("javascript")) return;
      lastError = new Error(`unexpected HTTP ${response.status} ${response.headers.get("content-type") || ""}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Wrangler did not serve coach-storage.js: ${lastError?.message || "timeout"}.\n${output()}`);
}

async function createContext(browser, origin, releaseASource) {
  const context = await browser.newContext();
  await context.addInitScript(installStorageSmokeHelpers);
  if (releaseASource) {
    await context.route("**/__storage-fixtures__/coach-storage-release-a.js*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
        body: releaseASource,
      });
    });
  }
  return context;
}

async function openHome(context, origin) {
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  return page;
}

function byId(records, id) {
  return records.find((record) => record.id === id);
}

async function withCaseDeadline(label, task, timeoutMs = 180_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its ${timeoutMs}ms deadline`)), timeoutMs);
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function assertEmptyArtifactMetadata(summary, label) {
  assert.deepEqual(summary?.artifacts, {
    audioStored: false,
    audioBytes: 0,
    audioMimeType: "",
    transcriptStored: false,
    transcriptMayBePartial: false,
  }, label);
}

async function runFreshSchemaAndTriad(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const retainedAtMs = 1_800_000_000_000;
    const result = await page.evaluate(async ({ retainedAtMs }) => {
      const nativeNow = Date.now;
      Date.now = () => retainedAtMs;
      try {
        const storage = await import("/coach-storage.js?storage-smoke=fresh");
        const database = await storage.openCoachDatabase();
        database.close();
        const id = "fresh-triad";
        const summary = {
          id,
          createdAt: "2026-09-02T00:00:00.000Z",
          scenario: "interview",
          goal: "pace",
          practiceLoopId: null,
          baselineAttemptId: null,
          attemptRole: "standalone",
          feedbackMode: "live-cues",
          artifacts: {
            audioStored: false,
            audioBytes: 0,
            audioMimeType: "",
            transcriptStored: false,
            transcriptMayBePartial: false,
          },
        };
        const artifact = {
          id,
          createdAt: summary.createdAt,
          audioBlob: new Blob(["abc"], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "é🙂",
          transcriptMayBePartial: false,
        };
        const save = await storage.saveCoachingSession(summary, artifact);
        return { save, schema: { ...storage.coachingStorageSchema }, snapshot: await globalThis.__coachStorageSmoke.inspect() };
      } finally {
        Date.now = nativeNow;
      }
    }, { retainedAtMs });

    assert.deepEqual(result.save, { summarySaved: true, artifactStatus: "stored" });
    assert.equal(result.schema.version, 3);
    assert.deepEqual(result.snapshot.stores, [ARTIFACT_STORE, LIFECYCLE_STORE, SUMMARY_STORE].sort());
    assert.equal(result.snapshot.version, 3);
    assert.equal(result.snapshot.schema[SUMMARY_STORE].keyPath, "id");
    assert.equal(result.snapshot.schema[ARTIFACT_STORE].keyPath, "id");
    assert.equal(result.snapshot.schema[LIFECYCLE_STORE].keyPath, "id");
    assert.deepEqual(result.snapshot.schema[LIFECYCLE_STORE].indexes, [{
      name: "expiresAtMs",
      keyPath: "expiresAtMs",
      unique: false,
      multiEntry: false,
    }]);
    assert.equal(result.snapshot.artifacts[0]?.audioSize, 3);
    assert.equal(result.snapshot.artifacts[0]?.transcript, "é🙂");
    assert.deepEqual(result.snapshot.summaries[0]?.artifacts, {
      audioStored: true,
      audioBytes: 3,
      audioMimeType: "audio/webm",
      transcriptStored: true,
      transcriptMayBePartial: false,
    }, "artifact-bearing saves must commit truthful summary metadata atomically");
    assert.deepEqual(result.snapshot.lifecycle[0], {
      id: "fresh-triad",
      retainedAtMs,
      expiresAtMs: retainedAtMs + RETENTION_MS,
      logicalBytes: 9,
      lifecycleSchemaVersion: 1,
      legacyGrace: false,
    });
    console.log("  fresh v3 schema and atomic triad passed");
  } finally {
    await context.close();
  }
}

async function runProgressSnapshot(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const result = await page.evaluate(async ({ retentionMs }) => {
      const storage = await import("/coach-storage.js?storage-smoke=progress-snapshot");
      const helpers = globalThis.__coachStorageSmoke;
      const empty = await storage.readCoachingProgressSnapshot();
      const retainedAtMs = 1_800_050_000_000;
      const activeRetainedAtMs = retainedAtMs + 1_000;
      const expiryBoundaryMs = retainedAtMs + retentionMs;
      const makeSummary = (id) => ({
        id,
        createdAt: "2026-09-02T00:00:00.000Z",
        scenario: "interview",
        goal: "pace",
        advice: { focus: `Preserve ${id}` },
        artifacts: {
          audioStored: true,
          audioBytes: 1,
          audioMimeType: "audio/webm",
          transcriptStored: false,
          transcriptMayBePartial: false,
        },
      });
      const makeArtifact = (id, contents = id) => ({
        id,
        createdAt: "2026-09-02T00:00:00.000Z",
        audioBlob: new Blob([contents], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: "",
        transcriptMayBePartial: false,
      });

      const nativeNow = Date.now;
      let artifactGetAllCalls = 0;
      let artifactCursorCalls = 0;
      let clockCalls = 0;
      let snapshot;
      try {
        Date.now = () => retainedAtMs;
        await storage.saveCoachingSession(
          makeSummary("crosses-snapshot-expiry"),
          makeArtifact("crosses-snapshot-expiry", "x"),
        );

        Date.now = () => activeRetainedAtMs;
        await storage.saveCoachingSession(makeSummary("unicode-blob"), {
          id: "unicode-blob",
          createdAt: "2026-09-02T00:00:00.000Z",
          audioBlob: new Blob(["abc"], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "é🙂",
          transcriptMayBePartial: false,
        });
        await storage.saveCoachingSession(makeSummary("transcript-only"), {
          id: "transcript-only",
          createdAt: "2026-09-02T00:00:00.000Z",
          audioBlob: null,
          audioMimeType: "",
          transcript: "plain",
          transcriptMayBePartial: true,
        });
        await storage.saveCoachingSession(
          makeSummary("corrupt-payload"),
          makeArtifact("corrupt-payload", "c"),
        );
        await storage.saveCoachingSession(
          makeSummary("mismatched-ledger"),
          makeArtifact("mismatched-ledger", "m"),
        );

        const database = await helpers.openRaw();
        const transaction = database.transaction(
          ["session-summaries", "session-artifacts", "artifact-lifecycle"],
          "readwrite",
        );
        const summaries = transaction.objectStore("session-summaries");
        const artifacts = transaction.objectStore("session-artifacts");
        const lifecycle = transaction.objectStore("artifact-lifecycle");

        const unicodeSummary = summaries.get("unicode-blob");
        unicodeSummary.onsuccess = () => summaries.put({
          ...unicodeSummary.result,
          artifacts: {
            audioStored: false,
            audioBytes: 999,
            audioMimeType: "audio/wrong",
            transcriptStored: true,
            transcriptMayBePartial: true,
          },
        });
        const transcriptOnlySummary = summaries.get("transcript-only");
        transcriptOnlySummary.onsuccess = () => summaries.put({
          ...transcriptOnlySummary.result,
          artifacts: {
            ...transcriptOnlySummary.result.artifacts,
            unexpectedSensitiveField: "must not survive normalization",
          },
        });
        summaries.put({
          id: "metadata-only-corruption",
          createdAt: "2026-09-02T00:00:00.000Z",
          advice: { focus: "Preserve compact analysis" },
          artifacts: {
            audioStored: false,
            audioBytes: 999,
            audioMimeType: "audio/stale",
            transcriptStored: false,
            transcriptMayBePartial: true,
          },
        });
        artifacts.put({
          id: "corrupt-payload",
          createdAt: "2026-09-02T00:00:00.000Z",
          audioBlob: "not-a-blob",
          audioMimeType: "audio/webm",
          transcript: "",
          transcriptMayBePartial: false,
        });
        artifacts.put(makeArtifact("orphan-payload", "o"));
        const futureDuringSnapshotId = "future-during-snapshot";
        summaries.put(makeSummary(futureDuringSnapshotId));
        artifacts.put(makeArtifact(futureDuringSnapshotId, "f"));
        lifecycle.put({
          id: futureDuringSnapshotId,
          retainedAtMs: expiryBoundaryMs,
          expiresAtMs: expiryBoundaryMs + retentionMs,
          logicalBytes: 1,
          lifecycleSchemaVersion: 1,
          legacyGrace: false,
        });

        const mismatchedLedger = lifecycle.get("mismatched-ledger");
        mismatchedLedger.onsuccess = () => lifecycle.put({
          ...mismatchedLedger.result,
          logicalBytes: mismatchedLedger.result.logicalBytes + 1,
        });
        const unicodeLifecycle = lifecycle.get("unicode-blob");
        unicodeLifecycle.onsuccess = () => lifecycle.put({
          ...unicodeLifecycle.result,
          lifecycleSchemaVersion: 2,
          futureCompatibleField: "ignored",
        });
        lifecycle.put({
          id: "orphan-lifecycle",
          retainedAtMs: activeRetainedAtMs,
          expiresAtMs: activeRetainedAtMs + retentionMs,
          logicalBytes: 1,
          lifecycleSchemaVersion: 1,
          legacyGrace: false,
        });
        await helpers.transactionDone(transaction);
        database.close();

        const nativeArtifactGetAll = IDBObjectStore.prototype.getAll;
        const nativeArtifactOpenCursor = IDBObjectStore.prototype.openCursor;
        IDBObjectStore.prototype.getAll = function guardedGetAll(...args) {
          if (this.name === "session-artifacts") {
            artifactGetAllCalls += 1;
            throw new Error("Progress snapshots must not materialize the complete artifact store");
          }
          return nativeArtifactGetAll.apply(this, args);
        };
        IDBObjectStore.prototype.openCursor = function countedOpenCursor(...args) {
          if (this.name === "session-artifacts") artifactCursorCalls += 1;
          return nativeArtifactOpenCursor.apply(this, args);
        };
        Date.now = () => {
          clockCalls += 1;
          return clockCalls === 1 ? expiryBoundaryMs - 1 : expiryBoundaryMs;
        };
        try {
          snapshot = await storage.readCoachingProgressSnapshot();
        } finally {
          IDBObjectStore.prototype.getAll = nativeArtifactGetAll;
          IDBObjectStore.prototype.openCursor = nativeArtifactOpenCursor;
        }
      } finally {
        Date.now = nativeNow;
      }
      return {
        empty,
        snapshot,
        stored: await helpers.inspect(),
        artifactGetAllCalls,
        artifactCursorCalls,
        clockCalls,
        retainedAtMs,
        activeRetainedAtMs,
      };
    }, { retentionMs: RETENTION_MS });

    assert.deepEqual(result.empty, {
      summaries: [],
      artifactUsage: {
        logicalBytes: 0,
        limitBytes: MAX_LOGICAL_BYTES,
        artifactCount: 0,
        nextExpiresAtMs: null,
        legacyGraceCount: 0,
        cleanedCount: 0,
        sessions: [],
      },
    });
    assert.equal(result.artifactGetAllCalls, 0,
      "a progress snapshot must never load the complete Blob store with getAll");
    assert.equal(result.artifactCursorCalls, 1,
      "a progress snapshot must validate actual payload bytes in exactly one artifact cursor pass");
    assert.equal(result.clockCalls, 2,
      "a progress snapshot must recheck expiry after its payload cursor finishes");
    assert.deepEqual(result.snapshot.artifactUsage, {
      logicalBytes: 14,
      limitBytes: MAX_LOGICAL_BYTES,
      artifactCount: 2,
      nextExpiresAtMs: result.activeRetainedAtMs + RETENTION_MS,
      legacyGraceCount: 0,
      cleanedCount: 5,
      sessions: [
        {
          id: "transcript-only",
          logicalBytes: 5,
          retainedAtMs: result.activeRetainedAtMs,
          expiresAtMs: result.activeRetainedAtMs + RETENTION_MS,
          legacyGrace: false,
        },
        {
          id: "unicode-blob",
          logicalBytes: 9,
          retainedAtMs: result.activeRetainedAtMs,
          expiresAtMs: result.activeRetainedAtMs + RETENTION_MS,
          legacyGrace: false,
        },
      ],
    });
    assert.deepEqual(byId(result.snapshot.summaries, "unicode-blob")?.artifacts, {
      audioStored: true,
      audioBytes: 3,
      audioMimeType: "audio/webm",
      transcriptStored: true,
      transcriptMayBePartial: false,
    }, "the snapshot must normalize summary metadata from actual Blob and transcript content");
    assert.deepEqual(byId(result.snapshot.summaries, "transcript-only")?.artifacts, {
      audioStored: false,
      audioBytes: 0,
      audioMimeType: "",
      transcriptStored: true,
      transcriptMayBePartial: true,
    });
    for (const id of [
      "crosses-snapshot-expiry",
      "corrupt-payload",
      "future-during-snapshot",
      "mismatched-ledger",
      "metadata-only-corruption",
    ]) {
      assertEmptyArtifactMetadata(byId(result.snapshot.summaries, id),
        `${id} must return truthful content-free artifact metadata`);
    }
    assert.equal(byId(result.snapshot.summaries, "metadata-only-corruption")?.advice?.focus,
      "Preserve compact analysis");
    assert.deepEqual(result.stored.artifacts.map((artifact) => artifact.id), ["transcript-only", "unicode-blob"]);
    assert.deepEqual(result.stored.lifecycle.map((record) => record.id), ["transcript-only", "unicode-blob"]);
    assert.equal(byId(result.stored.lifecycle, "unicode-blob")?.lifecycleSchemaVersion, 2,
      "compatible future lifecycle rows must retain their schema version");
    assert.equal(byId(result.stored.lifecycle, "unicode-blob")?.futureCompatibleField, "ignored");
    assert.deepEqual(
      byId(result.stored.summaries, "unicode-blob")?.artifacts,
      byId(result.snapshot.summaries, "unicode-blob")?.artifacts,
      "the returned truthful summary and atomically committed summary must match",
    );
    assertEmptyArtifactMetadata(byId(result.stored.summaries, "metadata-only-corruption"),
      "summary metadata normalization must commit in the snapshot transaction");
    assert.equal(Object.hasOwn(result.snapshot.artifactUsage.sessions[0], "transcript"), false);
    assert.equal(Object.hasOwn(result.snapshot.artifactUsage.sessions[0], "audioBlob"), false);
    console.log("  one-pass truthful progress snapshot accounting and cleanup passed");
  } finally {
    await context.close();
  }
}

async function runVersionTwoBackfill(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const retainedAtMs = 1_800_100_000_000;
    const result = await page.evaluate(async ({ retainedAtMs }) => {
      const helpers = globalThis.__coachStorageSmoke;
      const request = indexedDB.open("nonstoptalk-coaching", 2);
      request.onupgradeneeded = () => {
        const summaries = request.result.createObjectStore("session-summaries", { keyPath: "id" });
        summaries.createIndex("createdAt", "createdAt");
        const artifacts = request.result.createObjectStore("session-artifacts", { keyPath: "id" });
        artifacts.createIndex("createdAt", "createdAt");
      };
      const database = await helpers.requestResult(request);
      const transaction = database.transaction(["session-summaries", "session-artifacts"], "readwrite");
      const summaries = transaction.objectStore("session-summaries");
      const artifacts = transaction.objectStore("session-artifacts");
      summaries.put({
        id: "legacy-a",
        createdAt: "2019-01-01T00:00:00.000Z",
        scenario: "interview",
        goal: "pace",
        advice: { focus: "Preserve this summary" },
        artifacts: { audioStored: true, audioBytes: 3, audioMimeType: "audio/webm", transcriptStored: true, transcriptMayBePartial: false },
      });
      summaries.put({
        id: "legacy-b",
        createdAt: "2020-01-01T00:00:00.000Z",
        scenario: "presentation",
        goal: "energy",
        advice: { focus: "Preserve transcript only" },
        artifacts: { audioStored: false, audioBytes: 0, audioMimeType: "", transcriptStored: true, transcriptMayBePartial: true },
      });
      artifacts.put({
        id: "legacy-a",
        createdAt: "2019-01-01T00:00:00.000Z",
        audioBlob: new Blob(["abc"], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: "é🙂",
        transcriptMayBePartial: false,
      });
      artifacts.put({
        id: "legacy-b",
        createdAt: "2020-01-01T00:00:00.000Z",
        audioBlob: null,
        audioMimeType: "",
        transcript: "plain",
        transcriptMayBePartial: true,
      });
      artifacts.put({
        id: "legacy-orphan",
        createdAt: "2018-01-01T00:00:00.000Z",
        audioBlob: new Blob(["z"], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: "",
        transcriptMayBePartial: false,
      });
      await helpers.transactionDone(transaction);
      database.close();

      const nativeNow = Date.now;
      let clockMs = retainedAtMs;
      let clockCalls = 0;
      Date.now = () => {
        clockCalls += 1;
        return clockMs++;
      };
      try {
        const storage = await import("/coach-storage.js?storage-smoke=v2-backfill");
        const upgraded = await storage.openCoachDatabase();
        upgraded.close();
        return { ...(await helpers.inspect()), clockCalls };
      } finally {
        Date.now = nativeNow;
      }
    }, { retainedAtMs });

    assert.equal(result.version, 3);
    assert.equal(result.clockCalls, 1, "a multi-artifact backfill must capture one shared migration time");
    assert.deepEqual(result.artifacts.map((item) => item.id), ["legacy-a", "legacy-b"]);
    assert.equal(byId(result.artifacts, "legacy-a").audioSize, 3);
    assert.equal(byId(result.artifacts, "legacy-a").transcript, "é🙂");
    assert.equal(byId(result.artifacts, "legacy-b").audioSize, -1);
    assert.equal(byId(result.artifacts, "legacy-b").transcript, "plain");
    assert.equal(byId(result.summaries, "legacy-a").advice.focus, "Preserve this summary");
    assert.equal(byId(result.summaries, "legacy-b").artifacts.transcriptMayBePartial, true);
    assert.deepEqual(result.lifecycle.map((item) => item.id), ["legacy-a", "legacy-b"]);
    assert.deepEqual(Object.fromEntries(result.lifecycle.map((item) => [item.id, item.logicalBytes])), {
      "legacy-a": 9,
      "legacy-b": 5,
    });
    for (const record of result.lifecycle) {
      assert.equal(record.retainedAtMs, retainedAtMs, "all backfilled artifacts must share one upgrade timestamp");
      assert.equal(record.expiresAtMs, retainedAtMs + RETENTION_MS);
      assert.equal(record.legacyGrace, true);
      assert.equal(record.lifecycleSchemaVersion, 1);
      assert.deepEqual(Object.keys(record).sort(), [
        "expiresAtMs", "id", "legacyGrace", "lifecycleSchemaVersion", "logicalBytes", "retainedAtMs",
      ]);
    }
    console.log("  real v2→v3 shared-timestamp Unicode backfill passed");
  } finally {
    await context.close();
  }
}

async function runFirstOperationMigrationTiming(browser, origin) {
  const operations = [
    "artifact-save",
    "summary-only-save",
    "read-summaries",
    "read-summary",
    "read-artifact",
  ];

  for (const operation of operations) {
    const context = await createContext(browser, origin);
    try {
      const page = await openHome(context, origin);
      const migrationAtMs = 1_800_125_000_000;
      const result = await page.evaluate(async ({ migrationAtMs, operation, retentionMs }) => {
        const helpers = globalThis.__coachStorageSmoke;
        const legacyId = "legacy-first-operation";
        const request = indexedDB.open("nonstoptalk-coaching", 2);
        request.onupgradeneeded = () => {
          const summaries = request.result.createObjectStore("session-summaries", { keyPath: "id" });
          summaries.createIndex("createdAt", "createdAt");
          const artifacts = request.result.createObjectStore("session-artifacts", { keyPath: "id" });
          artifacts.createIndex("createdAt", "createdAt");
        };
        const database = await helpers.requestResult(request);
        const transaction = database.transaction(["session-summaries", "session-artifacts"], "readwrite");
        transaction.objectStore("session-summaries").put({
          id: legacyId,
          createdAt: "2026-09-02T00:00:00.000Z",
          advice: { focus: "Preserve the first-operation migration artifact" },
          artifacts: {
            audioStored: true,
            audioBytes: 3,
            audioMimeType: "audio/webm",
            transcriptStored: true,
            transcriptMayBePartial: false,
          },
        });
        transaction.objectStore("session-artifacts").put({
          id: legacyId,
          createdAt: "2026-09-02T00:00:00.000Z",
          audioBlob: new Blob(["abc"], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "é🙂",
          transcriptMayBePartial: false,
        });
        await helpers.transactionDone(transaction);
        database.close();

        const nativeNow = Date.now;
        let clockMs = migrationAtMs;
        let clockCalls = 0;
        Date.now = () => {
          clockCalls += 1;
          return clockMs++;
        };
        try {
          const storage = await import(`/coach-storage.js?storage-smoke=first-operation-${operation}`);
          let operationResult;
          if (operation === "artifact-save") {
            operationResult = await storage.saveCoachingSession({
              id: "new-artifact-save",
              createdAt: "2026-09-02T00:01:00.000Z",
              artifacts: {
                audioStored: true,
                audioBytes: 1,
                audioMimeType: "audio/webm",
                transcriptStored: false,
                transcriptMayBePartial: false,
              },
            }, {
              id: "new-artifact-save",
              createdAt: "2026-09-02T00:01:00.000Z",
              audioBlob: new Blob(["x"], { type: "audio/webm" }),
              audioMimeType: "audio/webm",
              transcript: "",
              transcriptMayBePartial: false,
            });
          } else if (operation === "summary-only-save") {
            operationResult = await storage.saveCoachingSession({
              id: "new-summary-only-save",
              createdAt: "2026-09-02T00:01:00.000Z",
              artifacts: {
                audioStored: false,
                audioBytes: 0,
                audioMimeType: "",
                transcriptStored: false,
                transcriptMayBePartial: false,
              },
            }, null);
          } else if (operation === "read-summaries") {
            operationResult = (await storage.readCoachingSummaries()).map((summary) => summary.id);
          } else if (operation === "read-summary") {
            operationResult = (await storage.readCoachingSummary(legacyId))?.id || null;
          } else if (operation === "read-artifact") {
            const artifact = await storage.readCoachingArtifact(legacyId);
            operationResult = artifact ? {
              id: artifact.id,
              audioSize: artifact.audioBlob?.size,
              transcript: artifact.transcript,
            } : null;
          } else {
            throw new Error(`Unexpected first operation: ${operation}`);
          }
          return {
            clockCalls,
            operationResult,
            snapshot: await helpers.inspect(),
            expectedExpiryMs: migrationAtMs + retentionMs,
          };
        } finally {
          Date.now = nativeNow;
        }
      }, { migrationAtMs, operation, retentionMs: RETENTION_MS });

      assert.ok(result.clockCalls >= 2, `${operation} must timestamp migration before its operation`);
      assert.equal(byId(result.snapshot.artifacts, "legacy-first-operation")?.audioSize, 3,
        `${operation} must preserve the migrated artifact`);
      assert.equal(byId(result.snapshot.artifacts, "legacy-first-operation")?.transcript, "é🙂");
      assert.equal(byId(result.snapshot.summaries, "legacy-first-operation")?.artifacts?.audioStored, true);
      assert.deepEqual(byId(result.snapshot.lifecycle, "legacy-first-operation"), {
        id: "legacy-first-operation",
        retainedAtMs: migrationAtMs,
        expiresAtMs: result.expectedExpiryMs,
        logicalBytes: 9,
        lifecycleSchemaVersion: 1,
        legacyGrace: true,
      });

      if (operation === "artifact-save") {
        assert.deepEqual(result.operationResult, { summarySaved: true, artifactStatus: "stored" });
        assert.equal(byId(result.snapshot.artifacts, "new-artifact-save")?.audioSize, 1);
      } else if (operation === "summary-only-save") {
        assert.deepEqual(result.operationResult, { summarySaved: true, artifactStatus: "not-requested" });
        assertEmptyArtifactMetadata(byId(result.snapshot.summaries, "new-summary-only-save"),
          "the first summary-only save must remain compact");
      } else if (operation === "read-summaries") {
        assert.deepEqual(result.operationResult, ["legacy-first-operation"]);
      } else if (operation === "read-summary") {
        assert.equal(result.operationResult, "legacy-first-operation");
      } else {
        assert.deepEqual(result.operationResult, {
          id: "legacy-first-operation",
          audioSize: 3,
          transcript: "é🙂",
        });
      }
    } finally {
      await context.close();
    }
  }
  console.log("  every first-operation v2→v3 migration clock ordering passed");
}

async function runExpiryBoundary(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const retainedAtMs = 1_800_200_000_000;
    const result = await page.evaluate(async ({ retainedAtMs, retentionMs }) => {
      const nativeNow = Date.now;
      Date.now = () => retainedAtMs;
      const storage = await import("/coach-storage.js?storage-smoke=expiry");
      const id = "expiring-baseline";
      const summary = {
        id,
        createdAt: "2026-09-02T00:00:00.000Z",
        scenario: "interview",
        goal: "pauses",
        practiceLoopId: "loop-preserved",
        baselineAttemptId: id,
        attemptRole: "baseline",
        feedbackMode: "review-only",
        advice: { focus: "Relationship survives expiry" },
        artifacts: { audioStored: true, audioBytes: 1, audioMimeType: "audio/webm", transcriptStored: true, transcriptMayBePartial: false },
      };
      await storage.saveCoachingSession(summary, {
        id,
        createdAt: summary.createdAt,
        audioBlob: new Blob(["x"], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: "kept until the boundary",
        transcriptMayBePartial: false,
      });
      const crossingId = "crosses-during-read";
      await storage.saveCoachingSession({
        ...summary,
        id: crossingId,
        baselineAttemptId: crossingId,
        advice: { focus: "Do not return content after the read crosses expiry" },
      }, {
        id: crossingId,
        createdAt: summary.createdAt,
        audioBlob: new Blob(["z"], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: "crossing",
        transcriptMayBePartial: false,
      });
      Date.now = () => retainedAtMs + 1_000;
      await storage.saveCoachingSession({
        ...summary,
        id: "healthy-after-boundary",
        baselineAttemptId: "healthy-after-boundary",
        advice: { focus: "Unrelated healthy artifact survives" },
      }, {
        id: "healthy-after-boundary",
        createdAt: summary.createdAt,
        audioBlob: new Blob(["y"], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: "still active",
        transcriptMayBePartial: false,
      });
      let before;
      let crossing;
      let atBoundary;
      try {
        Date.now = () => retainedAtMs + retentionMs - 1;
        before = await storage.readCoachingArtifact(id);
        let crossingClockMs = retainedAtMs + retentionMs - 1;
        Date.now = () => crossingClockMs++;
        crossing = await storage.readCoachingArtifact(crossingId);
        Date.now = () => retainedAtMs + retentionMs;
        atBoundary = await storage.readCoachingArtifact(id);
      } finally {
        Date.now = nativeNow;
      }
      return {
        before: before ? { id: before.id, transcript: before.transcript } : null,
        crossing: crossing ? { id: crossing.id } : null,
        atBoundary: atBoundary ? { id: atBoundary.id } : null,
        snapshot: await globalThis.__coachStorageSmoke.inspect(),
      };
    }, { retainedAtMs, retentionMs: RETENTION_MS });

    assert.equal(result.before?.id, "expiring-baseline");
    assert.equal(result.before?.transcript, "kept until the boundary");
    assert.equal(result.crossing, null, "an artifact must not cross its deadline while its payload is read");
    assert.equal(result.atBoundary, null);
    assert.deepEqual(result.snapshot.artifacts.map((artifact) => artifact.id), ["healthy-after-boundary"]);
    assert.deepEqual(result.snapshot.lifecycle.map((record) => record.id), ["healthy-after-boundary"]);
    assert.equal(byId(result.snapshot.artifacts, "healthy-after-boundary")?.transcript, "still active");
    const summary = byId(result.snapshot.summaries, "expiring-baseline");
    assert.equal(summary.practiceLoopId, "loop-preserved");
    assert.equal(summary.baselineAttemptId, "expiring-baseline");
    assert.equal(summary.advice.focus, "Relationship survives expiry");
    assertEmptyArtifactMetadata(summary, "expiry must scrub only artifact metadata");
    assertEmptyArtifactMetadata(byId(result.snapshot.summaries, "crosses-during-read"),
      "a read that crosses expiry must scrub only artifact metadata");
    console.log("  exact 30-day expiry boundary and summary preservation passed");
  } finally {
    await context.close();
  }
}

async function runCorruptionFailClosed(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const result = await page.evaluate(async () => {
      const storage = await import("/coach-storage.js?storage-smoke=corruption");
      const makeSummary = (id) => ({
        id,
        createdAt: new Date().toISOString(),
        scenario: "interview",
        goal: "pace",
        advice: { focus: `Preserve ${id}` },
        artifacts: { audioStored: true, audioBytes: 1, audioMimeType: "audio/webm", transcriptStored: true, transcriptMayBePartial: false },
      });
      const makeArtifact = (id) => ({
        id,
        createdAt: new Date().toISOString(),
        audioBlob: new Blob(["x"], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: id,
        transcriptMayBePartial: false,
      });
      for (const id of [
        "healthy-ledger",
        "malformed-payload",
        "missing-ledger",
        "wrong-ledger",
        "stale-ledger",
      ]) {
        await storage.saveCoachingSession(makeSummary(id), makeArtifact(id));
      }

      const helpers = globalThis.__coachStorageSmoke;
      const database = await helpers.openRaw();
      const transaction = database.transaction(["session-artifacts", "artifact-lifecycle"], "readwrite");
      const artifacts = transaction.objectStore("session-artifacts");
      const lifecycle = transaction.objectStore("artifact-lifecycle");
      lifecycle.delete("missing-ledger");
      const wrongRequest = lifecycle.get("wrong-ledger");
      wrongRequest.onsuccess = () => lifecycle.put({ ...wrongRequest.result, logicalBytes: wrongRequest.result.logicalBytes + 1 });
      artifacts.delete("stale-ledger");
      artifacts.put({
        id: "malformed-payload",
        createdAt: "2026-09-02T00:00:00.000Z",
        audioBlob: "not-a-blob",
        audioMimeType: "audio/webm",
        transcript: "",
        transcriptMayBePartial: false,
      });
      await helpers.transactionDone(transaction);
      database.close();

      const missing = await storage.readCoachingArtifact("missing-ledger");
      const wrong = await storage.readCoachingArtifact("wrong-ledger");
      await storage.readCoachingSummaries();
      const healthy = await storage.readCoachingArtifact("healthy-ledger");
      return {
        healthy: healthy ? { id: healthy.id, transcript: healthy.transcript } : null,
        missing: Boolean(missing),
        wrong: Boolean(wrong),
        snapshot: await helpers.inspect(),
      };
    });

    assert.equal(result.missing, false);
    assert.equal(result.wrong, false);
    assert.deepEqual(result.healthy, { id: "healthy-ledger", transcript: "healthy-ledger" });
    assert.deepEqual(result.snapshot.artifacts.map((artifact) => artifact.id), ["healthy-ledger"]);
    assert.deepEqual(result.snapshot.lifecycle.map((record) => record.id), ["healthy-ledger"]);
    for (const id of ["malformed-payload", "missing-ledger", "wrong-ledger", "stale-ledger"]) {
      const summary = byId(result.snapshot.summaries, id);
      assert.equal(summary.advice.focus, `Preserve ${id}`);
      assertEmptyArtifactMetadata(summary, `${id} must fail closed and preserve its compact summary`);
    }
    console.log("  malformed, missing, mismatched, and stale artifact state fails closed");
  } finally {
    await context.close();
  }
}

async function runLedgerByteMismatchReconciliation(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const result = await page.evaluate(async () => {
      const storage = await import("/coach-storage.js?storage-smoke=ledger-byte-mismatch");
      const makeSummary = (id, bytes) => ({
        id,
        createdAt: "2026-09-02T00:00:00.000Z",
        advice: { focus: `Preserve ${id}` },
        artifacts: {
          audioStored: true,
          audioBytes: bytes,
          audioMimeType: "audio/webm",
          transcriptStored: false,
          transcriptMayBePartial: false,
        },
      });
      const makeArtifact = (id, contents) => ({
        id,
        createdAt: "2026-09-02T00:00:00.000Z",
        audioBlob: new Blob([contents], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: "",
        transcriptMayBePartial: false,
      });
      await storage.saveCoachingSession(
        makeSummary("underreported-ledger", 2),
        makeArtifact("underreported-ledger", "xx"),
      );
      await storage.saveCoachingSession(
        makeSummary("healthy-ledger-control", 1),
        makeArtifact("healthy-ledger-control", "h"),
      );

      const helpers = globalThis.__coachStorageSmoke;
      const database = await helpers.openRaw();
      const transaction = database.transaction("artifact-lifecycle", "readwrite");
      const lifecycle = transaction.objectStore("artifact-lifecycle");
      const request = lifecycle.get("underreported-ledger");
      request.onsuccess = () => lifecycle.put({ ...request.result, logicalBytes: 1 });
      await helpers.transactionDone(transaction);
      database.close();

      const candidate = await storage.saveCoachingSession(
        makeSummary("after-ledger-reconciliation", 1),
        makeArtifact("after-ledger-reconciliation", "n"),
      );
      return { candidate, snapshot: await helpers.inspect() };
    });

    assert.deepEqual(result.candidate, { summarySaved: true, artifactStatus: "stored" });
    assert.equal(byId(result.snapshot.artifacts, "underreported-ledger"), undefined);
    assert.equal(byId(result.snapshot.lifecycle, "underreported-ledger"), undefined);
    assertEmptyArtifactMetadata(byId(result.snapshot.summaries, "underreported-ledger"),
      "an underreported lifecycle row must fail closed during capacity reconciliation");
    assert.equal(byId(result.snapshot.artifacts, "healthy-ledger-control")?.audioSize, 1);
    assert.equal(byId(result.snapshot.lifecycle, "healthy-ledger-control")?.logicalBytes, 1);
    assert.equal(byId(result.snapshot.artifacts, "after-ledger-reconciliation")?.audioSize, 1);
    console.log("  streamed payload-byte validation rejects an underreported lifecycle ledger");
  } finally {
    await context.close();
  }
}

async function runSummaryOnlyRetentionCleanup(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const nowMs = 1_800_150_000_000;
    const result = await page.evaluate(async ({ nowMs, retentionMs }) => {
      const nativeNow = Date.now;
      Date.now = () => nowMs;
      try {
        const storage = await import("/coach-storage.js?storage-smoke=summary-only-cleanup");
        const makeSummary = (id) => ({
          id,
          createdAt: "2026-09-02T00:00:00.000Z",
          advice: { focus: `Preserve ${id}` },
          artifacts: {
            audioStored: true,
            audioBytes: 1,
            audioMimeType: "audio/webm",
            transcriptStored: false,
            transcriptMayBePartial: false,
          },
        });
        const makeArtifact = (id) => ({
          id,
          createdAt: "2026-09-02T00:00:00.000Z",
          audioBlob: new Blob([id.slice(0, 1)], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "",
          transcriptMayBePartial: false,
        });
        for (const id of ["expired-on-save", "future-on-save", "orphan-on-save"]) {
          await storage.saveCoachingSession(makeSummary(id), makeArtifact(id));
        }

        const helpers = globalThis.__coachStorageSmoke;
        const database = await helpers.openRaw();
        const transaction = database.transaction(
          ["session-summaries", "artifact-lifecycle"],
          "readwrite",
        );
        const summaries = transaction.objectStore("session-summaries");
        const lifecycle = transaction.objectStore("artifact-lifecycle");
        const expired = lifecycle.get("expired-on-save");
        expired.onsuccess = () => lifecycle.put({
          ...expired.result,
          retainedAtMs: nowMs - retentionMs,
          expiresAtMs: nowMs,
        });
        const future = lifecycle.get("future-on-save");
        future.onsuccess = () => lifecycle.put({
          ...future.result,
          retainedAtMs: nowMs + 1,
          expiresAtMs: nowMs + 1 + retentionMs,
        });
        summaries.delete("orphan-on-save");
        await helpers.transactionDone(transaction);
        database.close();

        const save = await storage.saveCoachingSession({
          id: "summary-only-trigger",
          createdAt: "2026-09-02T00:01:00.000Z",
          advice: { focus: "New compact summary survives" },
          artifacts: {
            audioStored: false,
            audioBytes: 0,
            audioMimeType: "",
            transcriptStored: false,
            transcriptMayBePartial: false,
          },
        }, null);
        return { save, snapshot: await helpers.inspect() };
      } finally {
        Date.now = nativeNow;
      }
    }, { nowMs, retentionMs: RETENTION_MS });

    assert.deepEqual(result.save, { summarySaved: true, artifactStatus: "not-requested" });
    assert.equal(result.snapshot.artifacts.length, 0);
    assert.equal(result.snapshot.lifecycle.length, 0);
    assert.equal(byId(result.snapshot.summaries, "orphan-on-save"), undefined);
    for (const id of ["expired-on-save", "future-on-save"]) {
      const summary = byId(result.snapshot.summaries, id);
      assert.equal(summary.advice.focus, `Preserve ${id}`);
      assertEmptyArtifactMetadata(summary, `${id} must be scrubbed by a later summary-only save`);
    }
    assert.equal(byId(result.snapshot.summaries, "summary-only-trigger").advice.focus,
      "New compact summary survives");
    console.log("  summary-only practice saves enforce retention and orphan cleanup");
  } finally {
    await context.close();
  }
}

async function runCapBoundaries(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const result = await page.evaluate(async ({ maximum }) => {
      const storage = await import("/coach-storage.js?storage-smoke=cap");
      const helpers = globalThis.__coachStorageSmoke;
      const summary = (id, bytes) => ({
        id,
        createdAt: new Date().toISOString(),
        scenario: "interview",
        goal: "pace",
        artifacts: { audioStored: true, audioBytes: bytes, audioMimeType: "audio/webm", transcriptStored: false, transcriptMayBePartial: false },
      });
      const exactId = "exact-cap";
      const exact = await storage.saveCoachingSession(summary(exactId, maximum), {
        id: exactId,
        createdAt: new Date().toISOString(),
        audioBlob: new Blob([new ArrayBuffer(maximum)], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: "",
        transcriptMayBePartial: false,
      });

      const boundaryDatabase = await helpers.openRaw();
      const boundaryTransaction = boundaryDatabase.transaction(
        ["session-artifacts", "artifact-lifecycle"],
        "readonly",
      );
      const exactArtifactKeyAtBoundary = boundaryTransaction
        .objectStore("session-artifacts").getKey(exactId);
      const exactLifecycleAtBoundary = boundaryTransaction
        .objectStore("artifact-lifecycle").get(exactId);
      await helpers.transactionDone(boundaryTransaction);
      boundaryDatabase.close();

      const nativeArtifactGetAll = IDBObjectStore.prototype.getAll;
      let artifactGetAllCalls = 0;
      IDBObjectStore.prototype.getAll = function guardedGetAll(...args) {
        if (this.name === "session-artifacts") {
          artifactGetAllCalls += 1;
          throw new Error("Artifact reconciliation must stream instead of loading the complete blob store");
        }
        return nativeArtifactGetAll.apply(this, args);
      };
      const overId = "one-over-total";
      let over;
      let replacement;
      try {
        over = await storage.saveCoachingSession(summary(overId, 1), {
          id: overId,
          createdAt: new Date().toISOString(),
          audioBlob: new Blob([new Uint8Array([1])], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "",
          transcriptMayBePartial: false,
        });
        replacement = await storage.saveCoachingSession(summary(exactId, 1), {
          id: exactId,
          createdAt: new Date().toISOString(),
          audioBlob: new Blob([new Uint8Array([2])], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "",
          transcriptMayBePartial: false,
        });
      } finally {
        IDBObjectStore.prototype.getAll = nativeArtifactGetAll;
      }

      const database = await helpers.openRaw();
      const transaction = database.transaction(["session-summaries", "session-artifacts", "artifact-lifecycle"], "readonly");
      const replacementArtifact = transaction.objectStore("session-artifacts").get(exactId);
      const overArtifactKey = transaction.objectStore("session-artifacts").getKey(overId);
      const replacementLifecycle = transaction.objectStore("artifact-lifecycle").get(exactId);
      const overLifecycle = transaction.objectStore("artifact-lifecycle").get(overId);
      const overSummary = transaction.objectStore("session-summaries").get(overId);
      await helpers.transactionDone(transaction);
      database.close();
      return {
        exact,
        over,
        replacement,
        artifactGetAllCalls,
        exactArtifactKeyAtBoundary: exactArtifactKeyAtBoundary.result,
        exactLifecycleAtBoundary: exactLifecycleAtBoundary.result,
        replacementArtifactSize: replacementArtifact.result?.audioBlob?.size,
        replacementLifecycle: replacementLifecycle.result,
        overArtifactKey: overArtifactKey.result,
        overLifecycle: overLifecycle.result,
        overSummary: overSummary.result,
      };
    }, { maximum: MAX_LOGICAL_BYTES });

    assert.equal(result.exact.artifactStatus, "stored");
    assert.equal(result.exactLifecycleAtBoundary.logicalBytes, MAX_LOGICAL_BYTES);
    assert.equal(result.exactArtifactKeyAtBoundary, "exact-cap");
    assert.equal(result.over.artifactStatus, "app-limit");
    assert.equal(result.overArtifactKey, undefined);
    assert.equal(result.overLifecycle, undefined);
    assertEmptyArtifactMetadata(result.overSummary, "the +1 attempt must fall back to a truthful compact summary");
    assert.equal(result.replacement.artifactStatus, "stored");
    assert.equal(result.replacementArtifactSize, 1);
    assert.equal(result.replacementLifecycle.logicalBytes, 1,
      "a same-ID artifact replacement must subtract the prior ledger bytes before applying the cap");
    assert.equal(result.artifactGetAllCalls, 0,
      "cap reconciliation must never materialize the complete artifact/blob store at once");
    console.log("  native cap boundaries, same-ID replacement, and streamed blob validation passed");
  } finally {
    await context.close();
  }
}

async function runLegacyOverCap(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const result = await page.evaluate(async ({ maximum }) => {
      const helpers = globalThis.__coachStorageSmoke;
      const id = "grandfathered-over-cap";
      const request = indexedDB.open("nonstoptalk-coaching", 2);
      request.onupgradeneeded = () => {
        const summaries = request.result.createObjectStore("session-summaries", { keyPath: "id" });
        summaries.createIndex("createdAt", "createdAt");
        const artifacts = request.result.createObjectStore("session-artifacts", { keyPath: "id" });
        artifacts.createIndex("createdAt", "createdAt");
      };
      const database = await helpers.requestResult(request);
      const transaction = database.transaction(["session-summaries", "session-artifacts"], "readwrite");
      transaction.objectStore("session-summaries").put({
        id,
        createdAt: new Date().toISOString(),
        artifacts: { audioStored: true, audioBytes: maximum + 1, audioMimeType: "audio/webm", transcriptStored: false, transcriptMayBePartial: false },
      });
      transaction.objectStore("session-artifacts").put({
        id,
        createdAt: new Date().toISOString(),
        audioBlob: new Blob([new ArrayBuffer(maximum + 1)], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: "",
        transcriptMayBePartial: false,
      });
      await helpers.transactionDone(transaction);
      database.close();

      const storage = await import("/coach-storage.js?storage-smoke=legacy-over-cap");
      const candidateId = "blocked-by-grandfathered";
      const nativeNow = Date.now;
      let clockMs = 1_800_225_000_000;
      Date.now = () => clockMs++;
      let candidate;
      let progressSnapshot;
      try {
        progressSnapshot = await storage.readCoachingProgressSnapshot();
        candidate = await storage.saveCoachingSession({
          id: candidateId,
          createdAt: new Date().toISOString(),
          artifacts: { audioStored: true, audioBytes: 0, audioMimeType: "audio/webm", transcriptStored: false, transcriptMayBePartial: false },
        }, {
          id: candidateId,
          createdAt: new Date().toISOString(),
          audioBlob: new Blob([], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "",
          transcriptMayBePartial: false,
        });
      } finally {
        Date.now = nativeNow;
      }
      const check = await helpers.openRaw();
      const read = check.transaction(["session-summaries", "session-artifacts", "artifact-lifecycle"], "readonly");
      const legacyArtifact = read.objectStore("session-artifacts").getKey(id);
      const legacyLifecycle = read.objectStore("artifact-lifecycle").get(id);
      const candidateArtifact = read.objectStore("session-artifacts").getKey(candidateId);
      const candidateSummary = read.objectStore("session-summaries").get(candidateId);
      await helpers.transactionDone(read);
      check.close();
      return {
        candidate,
        progressSnapshot,
        legacyArtifact: legacyArtifact.result,
        legacyLifecycle: legacyLifecycle.result,
        candidateArtifact: candidateArtifact.result,
        candidateSummary: candidateSummary.result,
      };
    }, { maximum: MAX_LOGICAL_BYTES });

    assert.equal(result.candidate.artifactStatus, "app-limit");
    assert.equal(result.progressSnapshot.artifactUsage.logicalBytes, MAX_LOGICAL_BYTES + 1);
    assert.equal(result.progressSnapshot.artifactUsage.limitBytes, MAX_LOGICAL_BYTES);
    assert.equal(result.progressSnapshot.artifactUsage.artifactCount, 1);
    assert.equal(result.progressSnapshot.artifactUsage.legacyGraceCount, 1);
    assert.equal(result.progressSnapshot.artifactUsage.cleanedCount, 0);
    assert.deepEqual(result.progressSnapshot.artifactUsage.sessions.map((session) => session.id), [
      "grandfathered-over-cap",
    ]);
    assert.equal(result.legacyArtifact, "grandfathered-over-cap");
    assert.equal(result.legacyLifecycle.logicalBytes, MAX_LOGICAL_BYTES + 1);
    assert.equal(result.legacyLifecycle.legacyGrace, true);
    assert.equal(result.candidateArtifact, undefined);
    assertEmptyArtifactMetadata(result.candidateSummary, "legacy over-cap data must be preserved while the new artifact is refused");
    console.log("  migrated over-cap artifact grace and no-eviction behavior passed");
  } finally {
    await context.close();
  }
}

async function runTwoTabCapRace(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const first = await openHome(context, origin);
    const second = await openHome(context, origin);
    const perArtifactBytes = Math.floor(MAX_LOGICAL_BYTES / 2) + 1;
    const arm = async (page, id, moduleKey) => page.evaluate(({ id, bytes, moduleKey }) => {
      globalThis.__storageRaceReady = false;
      globalThis.__storageRacePromise = (async () => {
        const storage = await import(`/coach-storage.js?storage-smoke=race-${moduleKey}`);
        const artifact = {
          id,
          createdAt: new Date().toISOString(),
          audioBlob: new Blob([new ArrayBuffer(bytes)], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "",
          transcriptMayBePartial: false,
        };
        const channel = new BroadcastChannel("coach-storage-cap-race");
        await new Promise((resolve) => {
          channel.onmessage = (event) => {
            if (event.data === "go") resolve();
          };
          globalThis.__storageRaceReady = true;
        });
        try {
          return await storage.saveCoachingSession({
            id,
            createdAt: artifact.createdAt,
            artifacts: { audioStored: true, audioBytes: bytes, audioMimeType: "audio/webm", transcriptStored: false, transcriptMayBePartial: false },
          }, artifact);
        } finally {
          channel.close();
        }
      })();
    }, { id, bytes: perArtifactBytes, moduleKey });

    await Promise.all([arm(first, "race-a", "a"), arm(second, "race-b", "b")]);
    await Promise.all([
      first.waitForFunction(() => globalThis.__storageRaceReady === true, null, { timeout: 20_000 }),
      second.waitForFunction(() => globalThis.__storageRaceReady === true, null, { timeout: 20_000 }),
    ]);
    await first.evaluate(() => {
      const trigger = new BroadcastChannel("coach-storage-cap-race");
      trigger.postMessage("go");
      trigger.close();
    });
    const [firstResult, secondResult] = await Promise.all([
      first.evaluate(() => globalThis.__storageRacePromise),
      second.evaluate(() => globalThis.__storageRacePromise),
    ]);
    assert.deepEqual([firstResult.artifactStatus, secondResult.artifactStatus].sort(), ["app-limit", "stored"]);

    const state = await first.evaluate(async () => {
      const helpers = globalThis.__coachStorageSmoke;
      const database = await helpers.openRaw();
      const transaction = database.transaction(["session-summaries", "session-artifacts", "artifact-lifecycle"], "readonly");
      const summaries = transaction.objectStore("session-summaries").getAll();
      const artifactKeys = transaction.objectStore("session-artifacts").getAllKeys();
      const lifecycle = transaction.objectStore("artifact-lifecycle").getAll();
      await helpers.transactionDone(transaction);
      database.close();
      return { summaries: summaries.result, artifactKeys: artifactKeys.result, lifecycle: lifecycle.result };
    });
    assert.equal(state.summaries.length, 2);
    assert.equal(state.artifactKeys.length, 1);
    assert.equal(state.lifecycle.length, 1);
    assert.equal(state.lifecycle[0].logicalBytes, perArtifactBytes);
    assert(state.lifecycle.reduce((total, row) => total + row.logicalBytes, 0) <= MAX_LOGICAL_BYTES);
    const loser = state.summaries.find((summary) => summary.id !== state.artifactKeys[0]);
    assertEmptyArtifactMetadata(loser, "the serialized race loser must retain only its compact summary");
    console.log("  genuine two-tab serialized cap race passed");
  } finally {
    await context.close();
  }
}

async function runUpgradeAbortAndRetry(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const result = await page.evaluate(async () => {
      const helpers = globalThis.__coachStorageSmoke;
      const seedRequest = indexedDB.open("nonstoptalk-coaching", 2);
      seedRequest.onupgradeneeded = () => {
        const summaries = seedRequest.result.createObjectStore("session-summaries", { keyPath: "id" });
        summaries.createIndex("createdAt", "createdAt");
        const artifacts = seedRequest.result.createObjectStore("session-artifacts", { keyPath: "id" });
        artifacts.createIndex("createdAt", "createdAt");
      };
      const seeded = await helpers.requestResult(seedRequest);
      const write = seeded.transaction(["session-summaries", "session-artifacts"], "readwrite");
      write.objectStore("session-summaries").put({
        id: "atomic-upgrade",
        createdAt: "2026-09-02T00:00:00.000Z",
        advice: { focus: "Must survive aborted upgrade" },
        artifacts: { audioStored: true, audioBytes: 1, audioMimeType: "audio/webm", transcriptStored: false, transcriptMayBePartial: false },
      });
      write.objectStore("session-artifacts").put({
        id: "atomic-upgrade",
        createdAt: "2026-09-02T00:00:00.000Z",
        audioBlob: new Blob(["x"], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: "",
        transcriptMayBePartial: false,
      });
      await helpers.transactionDone(write);
      seeded.close();

      const storage = await import("/coach-storage.js?storage-smoke=abort-retry");
      const nativePut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function injectedLifecycleFailure(...args) {
        if (this.name === "artifact-lifecycle") {
          throw new DOMException("Injected lifecycle backfill failure", "QuotaExceededError");
        }
        return nativePut.apply(this, args);
      };
      let rejected;
      try {
        await storage.openCoachDatabase();
        rejected = null;
      } catch (error) {
        rejected = { name: error?.name, message: error?.message };
      } finally {
        IDBObjectStore.prototype.put = nativePut;
      }
      const afterAbort = await helpers.inspect();
      const retried = await storage.openCoachDatabase();
      retried.close();
      const afterRetry = await helpers.inspect();
      return { rejected, afterAbort, afterRetry };
    });

    assert(result.rejected, "the injected upgrade failure must reject the v3 open");
    assert.equal(result.afterAbort.version, 2);
    assert.deepEqual(result.afterAbort.stores, [ARTIFACT_STORE, SUMMARY_STORE].sort());
    assert.equal(byId(result.afterAbort.summaries, "atomic-upgrade").advice.focus, "Must survive aborted upgrade");
    assert.equal(byId(result.afterAbort.artifacts, "atomic-upgrade").audioSize, 1);
    assert.equal(result.afterRetry.version, 3);
    assert.equal(byId(result.afterRetry.lifecycle, "atomic-upgrade").legacyGrace, true);
    console.log("  upgrade abort atomicity and clean retry passed");
  } finally {
    await context.close();
  }
}

async function runMalformedUpgradeSchemas(browser, origin) {
  const repairContext = await createContext(browser, origin);
  try {
    const page = await openHome(repairContext, origin);
    const repairAtMs = 1_800_250_000_000;
    const repaired = await page.evaluate(async ({ repairAtMs, retentionMs }) => {
      const helpers = globalThis.__coachStorageSmoke;
      const request = indexedDB.open("nonstoptalk-coaching", 2);
      request.onupgradeneeded = () => {
        const id = "mismatched-v2-ledger";
        const summaries = request.result.createObjectStore("session-summaries", { keyPath: "id" });
        summaries.createIndex("createdAt", "createdAt");
        const artifacts = request.result.createObjectStore("session-artifacts", { keyPath: "id" });
        artifacts.createIndex("createdAt", "createdAt");
        const lifecycle = request.result.createObjectStore("artifact-lifecycle", { keyPath: "id" });
        lifecycle.createIndex("expiresAtMs", "wrongExpiry", { unique: true });
        summaries.put({
          id,
          createdAt: "2026-09-02T00:00:00.000Z",
          artifacts: { audioStored: true, audioBytes: 1, audioMimeType: "audio/webm", transcriptStored: true, transcriptMayBePartial: false },
        });
        artifacts.put({
          id,
          createdAt: "2026-09-02T00:00:00.000Z",
          audioBlob: new Blob(["x"], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "bytes",
          transcriptMayBePartial: false,
        });
        lifecycle.put({
          id,
          retainedAtMs: repairAtMs - 1_000,
          expiresAtMs: repairAtMs - 1_000 + retentionMs,
          logicalBytes: 1,
          lifecycleSchemaVersion: 1,
          legacyGrace: false,
        });
      };
      const seeded = await helpers.requestResult(request);
      seeded.close();
      const nativeNow = Date.now;
      Date.now = () => repairAtMs;
      try {
        const storage = await import("/coach-storage.js?storage-smoke=repair-v2-index");
        const upgraded = await storage.openCoachDatabase();
        upgraded.close();
      } finally {
        Date.now = nativeNow;
      }
      return helpers.inspect();
    }, { repairAtMs, retentionMs: RETENTION_MS });
    assert.equal(repaired.version, 3);
    assert.deepEqual(repaired.schema[LIFECYCLE_STORE].indexes, [{
      name: "expiresAtMs",
      keyPath: "expiresAtMs",
      unique: false,
      multiEntry: false,
    }]);
    assert.equal(byId(repaired.lifecycle, "mismatched-v2-ledger").logicalBytes, 6);
    assert.equal(byId(repaired.lifecycle, "mismatched-v2-ledger").legacyGrace, true);
    assert.equal(byId(repaired.lifecycle, "mismatched-v2-ledger").retainedAtMs,
      repairAtMs - 1_000);
  } finally {
    await repairContext.close();
  }

  const abortContext = await createContext(browser, origin);
  try {
    const page = await openHome(abortContext, origin);
    const rejected = await page.evaluate(async () => {
      const helpers = globalThis.__coachStorageSmoke;
      const request = indexedDB.open("nonstoptalk-coaching", 2);
      request.onupgradeneeded = () => {
        const summaries = request.result.createObjectStore("session-summaries", { keyPath: "wrongId" });
        summaries.createIndex("createdAt", "createdAt");
        const artifacts = request.result.createObjectStore("session-artifacts", { keyPath: "id" });
        artifacts.createIndex("createdAt", "createdAt");
      };
      const seeded = await helpers.requestResult(request);
      seeded.close();
      const storage = await import("/coach-storage.js?storage-smoke=reject-v2-keypath");
      let failure;
      try {
        const opened = await storage.openCoachDatabase();
        opened.close();
      } catch (error) {
        failure = { name: error?.name, message: error?.message };
      }
      return { failure, snapshot: await helpers.inspect() };
    });
    assert.match(rejected.failure?.message || "", /incompatible store key paths/iu);
    assert.equal(rejected.snapshot.version, 2);
    assert.deepEqual(rejected.snapshot.stores, [ARTIFACT_STORE, SUMMARY_STORE].sort());
    assert.equal(rejected.snapshot.schema[SUMMARY_STORE].keyPath, "wrongId");
    console.log("  malformed v2 indexes repair and incompatible key paths abort atomically");
  } finally {
    await abortContext.close();
  }
}

async function runBlockedUpgrade(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const result = await page.evaluate(async () => {
      const helpers = globalThis.__coachStorageSmoke;
      const request = indexedDB.open("nonstoptalk-coaching", 2);
      request.onupgradeneeded = () => {
        const summaries = request.result.createObjectStore("session-summaries", { keyPath: "id" });
        summaries.createIndex("createdAt", "createdAt");
        const artifacts = request.result.createObjectStore("session-artifacts", { keyPath: "id" });
        artifacts.createIndex("createdAt", "createdAt");
      };
      const held = await helpers.requestResult(request);
      const storage = await import("/coach-storage.js?storage-smoke=blocked");
      const openPromise = storage.openCoachDatabase().then(
        (database) => {
          database.close();
          return { resolved: true };
        },
        (error) => ({ resolved: false, name: error?.name, message: error?.message }),
      );
      const blocked = await openPromise;
      const versionWhileHeld = held.version;
      const storesWhileHeld = [...held.objectStoreNames].sort();
      held.close();
      // A blocked request cannot be cancelled. Give the settled request time to
      // unblock, then prove its guarded upgrade aborts without hidden mutation.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const observed = await helpers.inspect();
      return { blocked, versionWhileHeld, storesWhileHeld, observed };
    });

    assert.equal(result.blocked.resolved, false);
    assert.match(result.blocked.message, /blocking the coaching storage upgrade/iu);
    assert.equal(result.versionWhileHeld, 2);
    assert.deepEqual(result.storesWhileHeld, [ARTIFACT_STORE, SUMMARY_STORE].sort());
    assert.equal(result.observed.version, 2, "a rejected blocked request must not migrate later");
    assert.deepEqual(result.observed.stores, [ARTIFACT_STORE, SUMMARY_STORE].sort());
    console.log("  blocked upgrade rejects without later hidden migration");
  } finally {
    await context.close();
  }
}

async function runIncompatibleFutureSchema(browser, origin) {
  const context = await createContext(browser, origin);
  try {
    const page = await openHome(context, origin);
    const result = await page.evaluate(async () => {
      const helpers = globalThis.__coachStorageSmoke;
      const request = indexedDB.open("nonstoptalk-coaching", 4);
      request.onupgradeneeded = () => {
        const summaries = request.result.createObjectStore("session-summaries", { keyPath: "id" });
        summaries.createIndex("createdAt", "createdAt");
        const artifacts = request.result.createObjectStore("session-artifacts", { keyPath: "id" });
        artifacts.createIndex("createdAt", "createdAt");
      };
      const database = await helpers.requestResult(request);
      database.close();
      const storage = await import("/coach-storage.js?storage-smoke=incompatible-v4");
      try {
        const opened = await storage.openCoachDatabase();
        opened.close();
        return { rejected: false };
      } catch (error) {
        return { rejected: true, name: error?.name, message: error?.message };
      }
    });
    assert.equal(result.rejected, true);
    assert.match(result.message, /missing required stores/iu);
    console.log("  incompatible future schema fails explicitly");
  } finally {
    await context.close();
  }
}

async function runReleaseRollbackRestore(browser, origin, releaseASource) {
  const context = await createContext(browser, origin, releaseASource);
  try {
    const releaseAPage = await openHome(context, origin);
    const releaseBPage = await openHome(context, origin);
    const upgradeAtMs = 1_800_300_000_000;
    await releaseAPage.evaluate(async () => {
      const releaseA = await import("/__storage-fixtures__/coach-storage-release-a.js?phase=seed");
      globalThis.__releaseACoachStorage = releaseA;
      const makeSummary = (id) => ({
        id,
        createdAt: "2026-09-02T00:00:00.000Z",
        scenario: "interview",
        goal: "pace",
        practiceLoopId: "rollback-loop",
        baselineAttemptId: id,
        attemptRole: "baseline",
        feedbackMode: "review-only",
        advice: { focus: `Preserve ${id}` },
        artifacts: { audioStored: true, audioBytes: 1, audioMimeType: "audio/webm", transcriptStored: true, transcriptMayBePartial: false },
      });
      const makeArtifact = (id) => ({
        id,
        createdAt: "2026-09-02T00:00:00.000Z",
        audioBlob: new Blob(["x"], { type: "audio/webm" }),
        audioMimeType: "audio/webm",
        transcript: id,
        transcriptMayBePartial: false,
      });
      for (const id of ["rollback-preserve", "rollback-delete", "rollback-expire"]) {
        await releaseA.saveCoachingSession(makeSummary(id), makeArtifact(id));
      }
      globalThis.__releaseAHeldDatabase = await releaseA.openCoachDatabase();
    });

    await releaseBPage.evaluate(async ({ upgradeAtMs }) => {
      const nativeNow = Date.now;
      Date.now = () => upgradeAtMs;
      try {
        const releaseB = await import("/coach-storage.js?storage-smoke=rollback-upgrade-b");
        globalThis.__releaseBCoachStorage = releaseB;
        const database = await releaseB.openCoachDatabase();
        database.close();
      } finally {
        Date.now = nativeNow;
      }
    }, { upgradeAtMs });

    const oldConnectionClosed = await releaseAPage.evaluate(() => {
      try {
        globalThis.__releaseAHeldDatabase.transaction("session-summaries", "readonly");
        return false;
      } catch (error) {
        return error?.name === "InvalidStateError";
      }
    });
    assert.equal(oldConnectionClosed, true, "Release A must close its v2 connection for B's upgrade");

    const rollbackResult = await releaseAPage.evaluate(async ({ upgradeAtMs, retentionMs }) => {
      const releaseA = globalThis.__releaseACoachStorage;
      const nativeNow = Date.now;
      Date.now = () => upgradeAtMs + 1_000;
      try {
        const preserved = await releaseA.readCoachingArtifact("rollback-preserve");
        await releaseA.deleteCoachingArtifacts("rollback-delete");
        const id = "rollback-created-by-a";
        const save = await releaseA.saveCoachingSession({
          id,
          createdAt: "2026-09-02T00:01:00.000Z",
          scenario: "presentation",
          goal: "energy",
          advice: { focus: "A-created row survives B restore" },
          artifacts: { audioStored: true, audioBytes: 1, audioMimeType: "audio/webm", transcriptStored: true, transcriptMayBePartial: false },
        }, {
          id,
          createdAt: "2026-09-02T00:01:00.000Z",
          audioBlob: new Blob(["a"], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "created during rollback",
          transcriptMayBePartial: false,
        });

        const helpers = globalThis.__coachStorageSmoke;
        const database = await helpers.openRaw();
        const transaction = database.transaction("artifact-lifecycle", "readwrite");
        const lifecycle = transaction.objectStore("artifact-lifecycle");
        const expiry = lifecycle.get("rollback-expire");
        expiry.onsuccess = () => lifecycle.put({
          ...expiry.result,
          retainedAtMs: upgradeAtMs - retentionMs,
          expiresAtMs: upgradeAtMs,
        });
        await helpers.transactionDone(transaction);
        database.close();
        const expired = await releaseA.readCoachingArtifact("rollback-expire");
        return {
          preserved: preserved ? { id: preserved.id, transcript: preserved.transcript } : null,
          save,
          expired: Boolean(expired),
        };
      } finally {
        Date.now = nativeNow;
      }
    }, { upgradeAtMs, retentionMs: RETENTION_MS });

    assert.equal(rollbackResult.preserved?.id, "rollback-preserve");
    assert.equal(rollbackResult.save.artifactStatus, "stored");
    assert.equal(rollbackResult.expired, false);

    const restored = await releaseBPage.evaluate(async ({ restoreAtMs }) => {
      const releaseB = globalThis.__releaseBCoachStorage;
      const nativeNow = Date.now;
      Date.now = () => restoreAtMs;
      try {
        const preserve = await releaseB.readCoachingArtifact("rollback-preserve");
        const created = await releaseB.readCoachingArtifact("rollback-created-by-a");
        const deleted = await releaseB.readCoachingArtifact("rollback-delete");
        const expired = await releaseB.readCoachingArtifact("rollback-expire");
        const id = "restored-b-write";
        const save = await releaseB.saveCoachingSession({
          id,
          createdAt: new Date().toISOString(),
          artifacts: { audioStored: true, audioBytes: 1, audioMimeType: "audio/webm", transcriptStored: false, transcriptMayBePartial: false },
        }, {
          id,
          createdAt: new Date().toISOString(),
          audioBlob: new Blob(["b"], { type: "audio/webm" }),
          audioMimeType: "audio/webm",
          transcript: "",
          transcriptMayBePartial: false,
        });
        await releaseB.deleteCoachingArtifacts(id);
        return {
          preserve: preserve ? { id: preserve.id } : null,
          created: created ? { id: created.id, transcript: created.transcript } : null,
          deleted: Boolean(deleted),
          expired: Boolean(expired),
          save,
          snapshot: await globalThis.__coachStorageSmoke.inspect(),
        };
      } finally {
        Date.now = nativeNow;
      }
    }, { restoreAtMs: upgradeAtMs + 2_000 });

    assert.equal(restored.preserve?.id, "rollback-preserve");
    assert.equal(restored.created?.transcript, "created during rollback");
    assert.equal(restored.deleted, false);
    assert.equal(restored.expired, false);
    assert.equal(restored.save.artifactStatus, "stored");
    assert.equal(restored.snapshot.version, 3);
    assert.equal(byId(restored.snapshot.lifecycle, "rollback-preserve").legacyGrace, true);
    assert.equal(byId(restored.snapshot.lifecycle, "rollback-created-by-a").legacyGrace, false);
    assertEmptyArtifactMetadata(byId(restored.snapshot.summaries, "rollback-delete"), "A deletion must survive B restore");
    assertEmptyArtifactMetadata(byId(restored.snapshot.summaries, "rollback-expire"), "A expiry must survive B restore");
    assertEmptyArtifactMetadata(byId(restored.snapshot.summaries, "restored-b-write"), "B must remain able to save and delete after restore");
    console.log("  hash-pinned same-origin B→A→B rollback/restore passed");
  } finally {
    await context.close();
  }
}

const releaseASource = await readFile(releaseAFixturePath, "utf8");
const releaseAHash = createHash("sha256").update(releaseASource, "utf8").digest("hex");
assert.equal(releaseAHash, RELEASE_A_SHA256, "The immutable Release-A storage fixture hash changed");

const port = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
const { child, output } = startCaptured(process.execPath, [
  wrangler,
  "dev",
  "--local",
  "--ip",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: root,
  env: isolatedChildEnv(),
  logLimit: 32 * 1024,
});

let browser;
let primaryError;
try {
  await waitForAsset(origin, child, output);
  browser = await launchBrowser();
  console.log("IndexedDB v3 native browser storage smoke:");
  await withCaseDeadline("fresh schema and triad", runFreshSchemaAndTriad(browser, origin));
  await withCaseDeadline("progress snapshot", runProgressSnapshot(browser, origin));
  await withCaseDeadline("v2 backfill", runVersionTwoBackfill(browser, origin));
  await withCaseDeadline("first-operation migration timing", runFirstOperationMigrationTiming(browser, origin));
  await withCaseDeadline("expiry boundary", runExpiryBoundary(browser, origin));
  await withCaseDeadline("corruption handling", runCorruptionFailClosed(browser, origin));
  await withCaseDeadline("ledger byte mismatch", runLedgerByteMismatchReconciliation(browser, origin));
  await withCaseDeadline("summary-only cleanup", runSummaryOnlyRetentionCleanup(browser, origin));
  await withCaseDeadline("cap boundaries", runCapBoundaries(browser, origin));
  await withCaseDeadline("legacy over-cap migration", runLegacyOverCap(browser, origin));
  await withCaseDeadline("two-tab cap race", runTwoTabCapRace(browser, origin));
  await withCaseDeadline("upgrade abort and retry", runUpgradeAbortAndRetry(browser, origin));
  await withCaseDeadline("malformed upgrade schemas", runMalformedUpgradeSchemas(browser, origin));
  await withCaseDeadline("blocked upgrade", runBlockedUpgrade(browser, origin));
  await withCaseDeadline("future schema rejection", runIncompatibleFutureSchema(browser, origin));
  await withCaseDeadline("rollback and restore", runReleaseRollbackRestore(browser, origin, releaseASource));
  console.log("IndexedDB v3 native browser storage smoke passed.");
} catch (error) {
  primaryError = error;
  if (output()) console.error(`Wrangler output captured before failure:\n${output()}`);
} finally {
  try {
    await browser?.close();
  } catch (error) {
    primaryError ||= error;
  }
  try {
    await terminateProcessTree(child);
  } catch (error) {
    primaryError = primaryError
      ? new AggregateError([primaryError, error], "Storage smoke failed and Wrangler cleanup also failed")
      : error;
  }
}

if (primaryError) throw primaryError;
