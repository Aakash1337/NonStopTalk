const COACH_DB_NAME = "nonstoptalk-coaching";
const COACH_STORE = "session-summaries";
const COACH_ARTIFACT_STORE = "session-artifacts";
const COACH_ARTIFACT_LIFECYCLE_STORE = "artifact-lifecycle";
const COACH_DB_VERSION = 2;
const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ARTIFACT_MAX_LOGICAL_BYTES = 128 * 1_024 * 1_024;

const EMPTY_ARTIFACT_METADATA = Object.freeze({
  audioStored: false,
  audioBytes: 0,
  audioMimeType: "",
  transcriptStored: false,
  transcriptMayBePartial: false,
});

function openRequest(databaseFactory, version) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = version === undefined
      ? databaseFactory.open(COACH_DB_NAME)
      : databaseFactory.open(COACH_DB_NAME, version);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(COACH_STORE)) {
        const store = database.createObjectStore(COACH_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!database.objectStoreNames.contains(COACH_ARTIFACT_STORE)) {
        const store = database.createObjectStore(COACH_ARTIFACT_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      if (database.version < COACH_DB_VERSION
        || !database.objectStoreNames.contains(COACH_STORE)
        || !database.objectStoreNames.contains(COACH_ARTIFACT_STORE)) {
        database.close();
        fail(new Error("The coaching history database is missing required stores."));
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => fail(request.error || new Error("Could not open coaching history"));
    request.onblocked = () => fail(new Error("A previous NonStopTalk tab is blocking the coaching storage upgrade."));
  });
}

export async function openCoachDatabase(databaseFactory = globalThis.indexedDB) {
  if (!databaseFactory) throw new Error("IndexedDB unavailable");
  try {
    return await openRequest(databaseFactory, COACH_DB_VERSION);
  } catch (error) {
    if (error?.name !== "VersionError") throw error;
    // A newer compatible release may already have upgraded this origin. Opening
    // the current version keeps this release usable as the rollback floor.
    return openRequest(databaseFactory, undefined);
  }
}

export async function withCoachTransaction(storeNames, mode, callback, optionalStoreNames = []) {
  const database = await openCoachDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const availableOptionalStores = optionalStoreNames.filter((name) => database.objectStoreNames.contains(name));
      const transaction = database.transaction([...storeNames, ...availableOptionalStores], mode);
      let result;
      try {
        result = callback(transaction, new Set(availableOptionalStores));
      } catch (error) {
        transaction.abort();
        reject(error);
        return;
      }
      const isRequest = typeof globalThis.IDBRequest === "function" && result instanceof globalThis.IDBRequest;
      transaction.oncomplete = () => resolve(isRequest ? result.result : result);
      transaction.onerror = () => reject(transaction.error || new Error("Coaching history operation failed"));
      transaction.onabort = () => reject(transaction.error || new Error("Coaching history operation was cancelled"));
    });
  } finally {
    database.close();
  }
}

function withCoachStore(storeName, mode, callback) {
  return withCoachTransaction([storeName], mode, (transaction) => callback(transaction.objectStore(storeName)));
}

function artifactLogicalBytes(artifact) {
  const audioBytes = artifact?.audioBlob instanceof Blob ? artifact.audioBlob.size : 0;
  const transcriptBytes = artifact?.transcript ? new Blob([String(artifact.transcript)]).size : 0;
  return audioBytes + transcriptBytes;
}

function requireSessionId(record, label) {
  if (typeof record?.id !== "string" || record.id.length === 0) {
    throw new TypeError(`${label} must have a nonempty string ID.`);
  }
  return record.id;
}

function normalizedSaveRecords(summary, artifact) {
  const sessionId = requireSessionId(summary, "Coaching summary");
  if (!artifact) return { sessionId, summary: { ...summary, id: sessionId }, artifact: null };
  const artifactId = requireSessionId(artifact, "Coaching artifact");
  if (artifactId !== sessionId) {
    throw new TypeError("Coaching summary and artifact IDs must match.");
  }
  return {
    sessionId,
    summary: { ...summary, id: sessionId },
    artifact: { ...artifact, id: sessionId },
  };
}

function artifactLifecycleRecord(artifact, sessionId, retainedAtMs = Date.now()) {
  return {
    id: sessionId,
    retainedAtMs,
    expiresAtMs: retainedAtMs + ARTIFACT_RETENTION_MS,
    logicalBytes: artifactLogicalBytes(artifact),
    lifecycleSchemaVersion: 1,
    legacyGrace: false,
  };
}

function summaryWithoutArtifacts(summary) {
  return { ...summary, artifacts: { ...EMPTY_ARTIFACT_METADATA } };
}

function isQuotaExceededError(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current.name === "QuotaExceededError") return true;
    current = current.cause;
  }
  return false;
}

async function saveSummaryOnly(summary, sessionId) {
  await withCoachTransaction(
    [COACH_STORE, COACH_ARTIFACT_STORE],
    "readwrite",
    (transaction, optionalStores) => {
      transaction.objectStore(COACH_STORE).put(summaryWithoutArtifacts(summary));
      transaction.objectStore(COACH_ARTIFACT_STORE).delete(sessionId);
      if (optionalStores.has(COACH_ARTIFACT_LIFECYCLE_STORE)) {
        transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE).delete(sessionId);
      }
    },
    [COACH_ARTIFACT_LIFECYCLE_STORE],
  );
}

export async function saveCoachingSession(summary, artifact) {
  const records = normalizedSaveRecords(summary, artifact);
  if (!records.artifact) {
    // Session IDs are normally single-use, but treating a summary-only write as
    // an authoritative replacement prevents stale sensitive data if an ID is
    // ever reused by an import, repair, or future caller.
    await saveSummaryOnly(records.summary, records.sessionId);
    return { summarySaved: true, artifactStatus: "not-requested" };
  }

  try {
    return await withCoachTransaction(
      [COACH_STORE, COACH_ARTIFACT_STORE],
      "readwrite",
      (transaction, optionalStores) => {
        const outcome = { summarySaved: true, artifactStatus: "stored" };
        const summaries = transaction.objectStore(COACH_STORE);
        const artifacts = transaction.objectStore(COACH_ARTIFACT_STORE);
        if (!optionalStores.has(COACH_ARTIFACT_LIFECYCLE_STORE)) {
          summaries.put(records.summary);
          artifacts.put(records.artifact);
          return outcome;
        }

        const lifecycle = transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE);
        const record = artifactLifecycleRecord(records.artifact, records.sessionId);
        if (!Number.isSafeInteger(record.logicalBytes)
          || record.logicalBytes < 0
          || record.logicalBytes > ARTIFACT_MAX_LOGICAL_BYTES) {
          outcome.artifactStatus = "app-limit";
          summaries.put(summaryWithoutArtifacts(records.summary));
          artifacts.delete(record.id);
          lifecycle.delete(record.id);
          return outcome;
        }
        const request = lifecycle.getAll();
        request.onsuccess = () => {
          let retainedBytes = 0;
          let ledgerValid = true;
          for (const item of request.result) {
            if (!item || typeof item.id !== "string" || !item.id
              || !Number.isSafeInteger(item.logicalBytes) || item.logicalBytes < 0
              || item.logicalBytes > ARTIFACT_MAX_LOGICAL_BYTES
              || !Number.isSafeInteger(item.expiresAtMs) || item.expiresAtMs < 0) {
              ledgerValid = false;
              break;
            }
            if (item.id === record.id) continue;
            if (item.expiresAtMs <= record.retainedAtMs) {
              artifacts.delete(item.id);
              lifecycle.delete(item.id);
              const expiredSummary = summaries.get(item.id);
              expiredSummary.onsuccess = () => {
                if (expiredSummary.result) {
                  summaries.put(summaryWithoutArtifacts(expiredSummary.result));
                }
              };
              continue;
            }
            retainedBytes += item.logicalBytes;
            if (!Number.isSafeInteger(retainedBytes) || retainedBytes > ARTIFACT_MAX_LOGICAL_BYTES) {
              ledgerValid = false;
              break;
            }
          }
          if (!ledgerValid || retainedBytes > ARTIFACT_MAX_LOGICAL_BYTES - record.logicalBytes) {
            outcome.artifactStatus = "app-limit";
            summaries.put(summaryWithoutArtifacts(records.summary));
            artifacts.delete(record.id);
            lifecycle.delete(record.id);
            return;
          }
          summaries.put(records.summary);
          artifacts.put(records.artifact);
          lifecycle.put(record);
        };
        return outcome;
      },
      [COACH_ARTIFACT_LIFECYCLE_STORE],
    );
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error;
    await saveSummaryOnly(records.summary, records.sessionId);
    return { summarySaved: true, artifactStatus: "browser-quota" };
  }
}

async function cleanupExpiredCoachingArtifacts(nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("The coaching artifact expiry time is invalid.");
  }
  const outcome = { expiredCount: 0 };
  await withCoachTransaction(
    [COACH_STORE, COACH_ARTIFACT_STORE],
    "readwrite",
    (transaction, optionalStores) => {
      if (!optionalStores.has(COACH_ARTIFACT_LIFECYCLE_STORE)) return outcome;
      const summaries = transaction.objectStore(COACH_STORE);
      const artifacts = transaction.objectStore(COACH_ARTIFACT_STORE);
      const lifecycle = transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE);
      const expiryIndex = lifecycle.indexNames.contains("expiresAtMs")
        ? lifecycle.index("expiresAtMs")
        : null;
      const range = typeof globalThis.IDBKeyRange?.upperBound === "function"
        ? globalThis.IDBKeyRange.upperBound(nowMs)
        : null;
      const request = expiryIndex && range ? expiryIndex.getAll(range) : lifecycle.getAll();
      request.onsuccess = () => {
        for (const item of request.result) {
          if (!item || typeof item.id !== "string" || item.id.length === 0
            || !Number.isSafeInteger(item.expiresAtMs) || item.expiresAtMs > nowMs) continue;
          outcome.expiredCount += 1;
          artifacts.delete(item.id);
          lifecycle.delete(item.id);
          const summaryRequest = summaries.get(item.id);
          summaryRequest.onsuccess = () => {
            if (summaryRequest.result) {
              summaries.put(summaryWithoutArtifacts(summaryRequest.result));
            }
          };
        }
      };
      return outcome;
    },
    [COACH_ARTIFACT_LIFECYCLE_STORE],
  );
  return outcome.expiredCount;
}

export async function readCoachingSummaries() {
  await cleanupExpiredCoachingArtifacts();
  return withCoachStore(COACH_STORE, "readonly", (store) => store.getAll());
}

export async function readCoachingSummary(id) {
  await cleanupExpiredCoachingArtifacts();
  return withCoachStore(COACH_STORE, "readonly", (store) => store.get(String(id || "")));
}

export async function readCoachingArtifact(id) {
  const sessionId = String(id || "");
  const outcome = { artifact: undefined };
  await withCoachTransaction(
    [COACH_STORE, COACH_ARTIFACT_STORE],
    "readwrite",
    (transaction, optionalStores) => {
      const summaries = transaction.objectStore(COACH_STORE);
      const artifacts = transaction.objectStore(COACH_ARTIFACT_STORE);
      const expireArtifact = (lifecycle) => {
        artifacts.delete(sessionId);
        lifecycle.delete(sessionId);
        const summaryRequest = summaries.get(sessionId);
        summaryRequest.onsuccess = () => {
          if (summaryRequest.result) {
            summaries.put(summaryWithoutArtifacts(summaryRequest.result));
          }
        };
      };
      const readArtifact = (lifecycle, record) => {
        const request = artifacts.get(sessionId);
        request.onsuccess = () => {
          if (record && record.expiresAtMs <= Date.now()) {
            expireArtifact(lifecycle);
          } else {
            outcome.artifact = request.result;
          }
        };
      };
      if (!optionalStores.has(COACH_ARTIFACT_LIFECYCLE_STORE)) {
        readArtifact(null, null);
        return outcome;
      }

      const lifecycle = transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE);
      const lifecycleRequest = lifecycle.get(sessionId);
      lifecycleRequest.onsuccess = () => {
        const record = lifecycleRequest.result;
        if (record
          && record.id === sessionId
          && Number.isSafeInteger(record.expiresAtMs)
          && record.expiresAtMs > Date.now()) {
          readArtifact(lifecycle, record);
          return;
        }
        // Once a newer schema owns lifecycle data, missing, malformed, and
        // expired rows all fail closed so sensitive content cannot be returned
        // without a valid unexpired retention record.
        expireArtifact(lifecycle);
      };
      return outcome;
    },
    [COACH_ARTIFACT_LIFECYCLE_STORE],
  );
  return outcome.artifact;
}

export function deleteCoachingArtifacts(id) {
  const sessionId = String(id || "");
  return withCoachTransaction([COACH_STORE, COACH_ARTIFACT_STORE], "readwrite", (transaction, optionalStores) => {
    const summaries = transaction.objectStore(COACH_STORE);
    const artifacts = transaction.objectStore(COACH_ARTIFACT_STORE);
    const request = summaries.get(sessionId);
    request.onsuccess = () => {
      if (request.result) summaries.put({ ...request.result, artifacts: { ...EMPTY_ARTIFACT_METADATA } });
      artifacts.delete(sessionId);
      if (optionalStores.has(COACH_ARTIFACT_LIFECYCLE_STORE)) {
        transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE).delete(sessionId);
      }
    };
  }, [COACH_ARTIFACT_LIFECYCLE_STORE]);
}

export function clearCoachingSummaries() {
  return withCoachTransaction([COACH_STORE, COACH_ARTIFACT_STORE], "readwrite", (transaction, optionalStores) => {
    transaction.objectStore(COACH_STORE).clear();
    transaction.objectStore(COACH_ARTIFACT_STORE).clear();
    if (optionalStores.has(COACH_ARTIFACT_LIFECYCLE_STORE)) {
      transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE).clear();
    }
  }, [COACH_ARTIFACT_LIFECYCLE_STORE]);
}

export const coachingStorageSchema = Object.freeze({
  databaseName: COACH_DB_NAME,
  version: COACH_DB_VERSION,
  summaryStore: COACH_STORE,
  artifactStore: COACH_ARTIFACT_STORE,
  optionalLifecycleStore: COACH_ARTIFACT_LIFECYCLE_STORE,
  artifactRetentionMs: ARTIFACT_RETENTION_MS,
  artifactMaxLogicalBytes: ARTIFACT_MAX_LOGICAL_BYTES,
});
