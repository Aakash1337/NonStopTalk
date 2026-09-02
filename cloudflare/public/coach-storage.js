const COACH_DB_NAME = "nonstoptalk-coaching";
const COACH_STORE = "session-summaries";
const COACH_ARTIFACT_STORE = "session-artifacts";
const COACH_ARTIFACT_LIFECYCLE_STORE = "artifact-lifecycle";
const COACH_ARTIFACT_EXPIRY_INDEX = "expiresAtMs";
const COACH_DB_VERSION = 3;
const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ARTIFACT_MAX_LOGICAL_BYTES = 128 * 1_024 * 1_024;
const ARTIFACT_LIFECYCLE_SCHEMA_VERSION = 1;
const transactionFailureCauses = new WeakMap();

const EMPTY_ARTIFACT_METADATA = Object.freeze({
  audioStored: false,
  audioBytes: 0,
  audioMimeType: "",
  transcriptStored: false,
  transcriptMayBePartial: false,
});

function artifactLogicalBytes(artifact) {
  if (!artifact || typeof artifact !== "object") return null;
  let audioBytes = 0;
  let hasAudioBlob = false;
  if (artifact.audioBlob !== undefined && artifact.audioBlob !== null) {
    if (typeof globalThis.Blob !== "function" || !(artifact.audioBlob instanceof globalThis.Blob)) {
      return null;
    }
    hasAudioBlob = true;
    audioBytes = artifact.audioBlob.size;
  }
  const transcript = artifact.transcript === undefined || artifact.transcript === null
    ? ""
    : artifact.transcript;
  if (typeof transcript !== "string") return null;
  if (!hasAudioBlob && transcript.length === 0) return null;
  const transcriptBytes = new TextEncoder().encode(transcript).byteLength;
  const logicalBytes = audioBytes + transcriptBytes;
  return Number.isSafeInteger(audioBytes)
    && audioBytes >= 0
    && Number.isSafeInteger(transcriptBytes)
    && transcriptBytes >= 0
    && Number.isSafeInteger(logicalBytes)
    && logicalBytes >= 0
    ? logicalBytes
    : null;
}

function artifactLifecycleRecord(artifact, sessionId, retainedAtMs = Date.now(), legacyGrace = false) {
  const logicalBytes = artifactLogicalBytes(artifact);
  const expiresAtMs = retainedAtMs + ARTIFACT_RETENTION_MS;
  if (typeof sessionId !== "string"
    || sessionId.length === 0
    || logicalBytes === null
    || !Number.isSafeInteger(retainedAtMs)
    || retainedAtMs < 0
    || !Number.isSafeInteger(expiresAtMs)
    || typeof legacyGrace !== "boolean") {
    return null;
  }
  return {
    id: sessionId,
    retainedAtMs,
    expiresAtMs,
    logicalBytes,
    lifecycleSchemaVersion: ARTIFACT_LIFECYCLE_SCHEMA_VERSION,
    legacyGrace,
  };
}

function isArtifactLifecycleRecord(record, expectedId = record?.id) {
  // Later lifecycle schemas may add fields, but the v1 core fields and their
  // retention/accounting semantics are the forward-compatibility contract.
  if (!record
    || typeof expectedId !== "string"
    || expectedId.length === 0
    || record.id !== expectedId
    || !Number.isSafeInteger(record.retainedAtMs)
    || record.retainedAtMs < 0
    || !Number.isSafeInteger(record.expiresAtMs)
    || record.expiresAtMs <= record.retainedAtMs
    || !Number.isSafeInteger(record.logicalBytes)
    || record.logicalBytes < 0
    || !Number.isSafeInteger(record.lifecycleSchemaVersion)
    || record.lifecycleSchemaVersion < ARTIFACT_LIFECYCLE_SCHEMA_VERSION
    || typeof record.legacyGrace !== "boolean") {
    return false;
  }
  const maximumExpiry = record.retainedAtMs + ARTIFACT_RETENTION_MS;
  if (!Number.isSafeInteger(maximumExpiry) || record.expiresAtMs > maximumExpiry) return false;
  return record.logicalBytes <= ARTIFACT_MAX_LOGICAL_BYTES || record.legacyGrace;
}

function summaryWithoutArtifacts(summary) {
  return { ...summary, artifacts: { ...EMPTY_ARTIFACT_METADATA } };
}

function summaryClaimsArtifacts(summary) {
  return summary?.artifacts?.audioStored === true || summary?.artifacts?.transcriptStored === true;
}

function abortTransaction(transaction, cause) {
  if (cause && !transactionFailureCauses.has(transaction)) {
    transactionFailureCauses.set(transaction, cause);
  }
  try {
    transaction.abort();
    return true;
  } catch {
    return false;
  }
}

function scrubSummaryArtifacts(store, id, transaction) {
  try {
    const request = store.get(id);
    request.onsuccess = () => {
      try {
        if (request.result) store.put(summaryWithoutArtifacts(request.result));
      } catch (error) {
        abortTransaction(transaction, error);
      }
    };
  } catch (error) {
    abortTransaction(transaction, error);
  }
}

function isActiveArtifactLifecycleRecord(record, expectedId, nowMs) {
  return isArtifactLifecycleRecord(record, expectedId)
    && record.retainedAtMs <= nowMs
    && record.expiresAtMs > nowMs;
}

function upgradeCoachDatabase(request, event) {
  const database = request.result;
  const transaction = request.transaction;
  if (!transaction) throw new Error("The coaching storage upgrade transaction is unavailable.");

  const summaries = database.objectStoreNames.contains(COACH_STORE)
    ? transaction.objectStore(COACH_STORE)
    : database.createObjectStore(COACH_STORE, { keyPath: "id" });
  if (!summaries.indexNames.contains("createdAt")) summaries.createIndex("createdAt", "createdAt");

  const artifacts = database.objectStoreNames.contains(COACH_ARTIFACT_STORE)
    ? transaction.objectStore(COACH_ARTIFACT_STORE)
    : database.createObjectStore(COACH_ARTIFACT_STORE, { keyPath: "id" });
  if (!artifacts.indexNames.contains("createdAt")) artifacts.createIndex("createdAt", "createdAt");

  const lifecycle = database.objectStoreNames.contains(COACH_ARTIFACT_LIFECYCLE_STORE)
    ? transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE)
    : database.createObjectStore(COACH_ARTIFACT_LIFECYCLE_STORE, { keyPath: "id" });
  if (summaries.keyPath !== "id" || artifacts.keyPath !== "id" || lifecycle.keyPath !== "id") {
    abortTransaction(transaction, new Error("The coaching history database has incompatible store key paths."));
    return;
  }
  if (lifecycle.indexNames.contains(COACH_ARTIFACT_EXPIRY_INDEX)) {
    const existingIndex = lifecycle.index(COACH_ARTIFACT_EXPIRY_INDEX);
    if (existingIndex.keyPath !== COACH_ARTIFACT_EXPIRY_INDEX
      || existingIndex.unique
      || existingIndex.multiEntry) {
      lifecycle.deleteIndex(COACH_ARTIFACT_EXPIRY_INDEX);
      lifecycle.createIndex(COACH_ARTIFACT_EXPIRY_INDEX, COACH_ARTIFACT_EXPIRY_INDEX);
    }
  } else {
    lifecycle.createIndex(COACH_ARTIFACT_EXPIRY_INDEX, COACH_ARTIFACT_EXPIRY_INDEX);
  }
  if (event.oldVersion >= COACH_DB_VERSION) return;

  const retainedAtMs = Date.now();
  if (!Number.isSafeInteger(retainedAtMs) || retainedAtMs < 0) {
    abortTransaction(transaction, new TypeError("The coaching artifact migration time is invalid."));
    return;
  }
  const cursorRequest = artifacts.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    try {
      const id = cursor.primaryKey;
      const artifact = cursor.value;
      const record = typeof id === "string" && id.length > 0 && artifact?.id === id
        ? artifactLifecycleRecord(artifact, id, retainedAtMs, true)
        : null;
      if (!record) {
        cursor.delete();
        lifecycle.delete(id);
        scrubSummaryArtifacts(summaries, id, transaction);
        cursor.continue();
        return;
      }

      const summaryRequest = summaries.get(id);
      summaryRequest.onsuccess = () => {
        try {
          if (!summaryClaimsArtifacts(summaryRequest.result)) {
            cursor.delete();
            lifecycle.delete(id);
            scrubSummaryArtifacts(summaries, id, transaction);
            cursor.continue();
            return;
          }
          const existingRequest = lifecycle.get(id);
          existingRequest.onsuccess = () => {
            try {
              const existing = existingRequest.result;
              if (isArtifactLifecycleRecord(existing, id)
                && existing.retainedAtMs <= retainedAtMs) {
                if (existing.expiresAtMs <= retainedAtMs) {
                  cursor.delete();
                  lifecycle.delete(id);
                  scrubSummaryArtifacts(summaries, id, transaction);
                } else {
                  // A nonstandard v2 database may already contain a valid
                  // lifecycle row. Preserve its earlier policy instead of
                  // extending retention, while recomputing byte accounting
                  // from the artifact being migrated.
                  lifecycle.put({
                    ...existing,
                    logicalBytes: record.logicalBytes,
                    legacyGrace: true,
                  });
                }
              } else {
                lifecycle.put(record);
              }
              cursor.continue();
            } catch (error) {
              abortTransaction(transaction, error);
            }
          };
        } catch (error) {
          abortTransaction(transaction, error);
        }
      };
    } catch (error) {
      abortTransaction(transaction, error);
    }
  };
}

function hasRequiredCoachSchema(database) {
  if (database.version < COACH_DB_VERSION
    || !database.objectStoreNames.contains(COACH_STORE)
    || !database.objectStoreNames.contains(COACH_ARTIFACT_STORE)
    || !database.objectStoreNames.contains(COACH_ARTIFACT_LIFECYCLE_STORE)) {
    return false;
  }
  try {
    const transaction = database.transaction(
      [COACH_STORE, COACH_ARTIFACT_STORE, COACH_ARTIFACT_LIFECYCLE_STORE],
      "readonly",
    );
    const summaries = transaction.objectStore(COACH_STORE);
    const artifacts = transaction.objectStore(COACH_ARTIFACT_STORE);
    const lifecycle = transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE);
    if (summaries.keyPath !== "id"
      || artifacts.keyPath !== "id"
      || lifecycle.keyPath !== "id"
      || !lifecycle.indexNames.contains(COACH_ARTIFACT_EXPIRY_INDEX)) {
      return false;
    }
    const expiry = lifecycle.index(COACH_ARTIFACT_EXPIRY_INDEX);
    return expiry.keyPath === COACH_ARTIFACT_EXPIRY_INDEX
      && !expiry.unique
      && !expiry.multiEntry;
  } catch {
    return false;
  }
}

function openRequest(databaseFactory, version) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let upgradeTransaction;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = version === undefined
      ? databaseFactory.open(COACH_DB_NAME)
      : databaseFactory.open(COACH_DB_NAME, version);

    request.onupgradeneeded = (event) => {
      upgradeTransaction = request.transaction;
      if (upgradeTransaction) {
        upgradeTransaction.onerror = (errorEvent) => {
          const cause = errorEvent.target?.error || upgradeTransaction.error;
          if (cause && !transactionFailureCauses.has(upgradeTransaction)) {
            transactionFailureCauses.set(upgradeTransaction, cause);
          }
        };
      }
      if (settled) {
        if (upgradeTransaction) {
          abortTransaction(upgradeTransaction, new Error("The blocked coaching storage upgrade was cancelled."));
        }
        return;
      }
      try {
        upgradeCoachDatabase(request, event);
      } catch (error) {
        if (!upgradeTransaction || !abortTransaction(upgradeTransaction, error)) fail(error);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      if (!hasRequiredCoachSchema(database)) {
        database.close();
        fail(new Error("The coaching history database is missing required stores or indexes."));
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => fail(
      (upgradeTransaction && transactionFailureCauses.get(upgradeTransaction))
      || request.error
      || new Error("Could not open coaching history"),
    );
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

export async function withCoachTransaction(storeNames, mode, callback) {
  const database = await openCoachDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeNames, mode);
      let result;
      let pendingError;
      let settled = false;
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        const isRequest = typeof globalThis.IDBRequest === "function"
          && result instanceof globalThis.IDBRequest;
        resolve(isRequest ? result.result : result);
      };
      transaction.onerror = (event) => {
        pendingError ||= event.target?.error || transaction.error;
      };
      transaction.onabort = () => rejectOnce(
        transactionFailureCauses.get(transaction)
        || transaction.error
        || pendingError
        || new Error("Coaching history operation was cancelled"),
      );
      try {
        result = callback(transaction);
      } catch (error) {
        if (!abortTransaction(transaction, error)) rejectOnce(error);
      }
    });
  } finally {
    database.close();
  }
}

function withCoachStore(storeName, mode, callback) {
  return withCoachTransaction([storeName], mode, (transaction) => callback(transaction.objectStore(storeName)));
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
    [COACH_STORE, COACH_ARTIFACT_STORE, COACH_ARTIFACT_LIFECYCLE_STORE],
    "readwrite",
    (transaction) => {
      const nowMs = Date.now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError("The coaching artifact expiry time is invalid.");
      }
      reconcileArtifactState(transaction, nowMs, () => {
        transaction.objectStore(COACH_STORE).put(summaryWithoutArtifacts(summary));
        transaction.objectStore(COACH_ARTIFACT_STORE).delete(sessionId);
        transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE).delete(sessionId);
      });
    },
  );
}

function reconcileArtifactState(transaction, nowMs, done) {
  const summaries = transaction.objectStore(COACH_STORE);
  const artifacts = transaction.objectStore(COACH_ARTIFACT_STORE);
  const lifecycle = transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE);
  const artifactKeysRequest = artifacts.getAllKeys();
  const summariesRequest = summaries.getAll();
  const lifecycleEntries = [];
  let completedReads = 0;

  const finishRead = () => {
    completedReads += 1;
    if (completedReads !== 3) return;
    try {
      const artifactIds = new Set();
      for (const key of artifactKeysRequest.result) {
        if (typeof key === "string" && key.length > 0) artifactIds.add(key);
        else artifacts.delete(key);
      }
      const artifactSummaryIds = new Set();
      for (const summary of summariesRequest.result) {
        if (typeof summary?.id === "string"
          && summary.id.length > 0
          && summaryClaimsArtifacts(summary)) {
          artifactSummaryIds.add(summary.id);
        }
      }

      const retainedById = new Map();
      let retainedBytes = 0;
      let retainedBytesOverflow = false;
      let expiredCount = 0;
      for (const { key, value } of lifecycleEntries) {
        const validKey = typeof key === "string" && key.length > 0;
        const validRecord = validKey && isArtifactLifecycleRecord(value, key);
        const artifactExists = validKey && artifactIds.has(key);
        const summaryExists = validKey && artifactSummaryIds.has(key);
        if (!validRecord
          || value.retainedAtMs > nowMs
          || value.expiresAtMs <= nowMs
          || !artifactExists
          || !summaryExists) {
          lifecycle.delete(key);
          artifacts.delete(key);
          if (validRecord
            && value.retainedAtMs <= nowMs
            && value.expiresAtMs <= nowMs
            && artifactExists) {
            expiredCount += 1;
          }
          continue;
        }
        retainedById.set(key, value.logicalBytes);
        const nextBytes = retainedBytes + value.logicalBytes;
        if (!Number.isSafeInteger(nextBytes)) retainedBytesOverflow = true;
        else retainedBytes = nextBytes;
      }

      for (const key of artifactKeysRequest.result) {
        if (typeof key !== "string" || key.length === 0 || !retainedById.has(key)) {
          artifacts.delete(key);
          lifecycle.delete(key);
        }
      }
      for (const summary of summariesRequest.result) {
        if (summaryClaimsArtifacts(summary)
          && (typeof summary?.id !== "string" || !retainedById.has(summary.id))) {
          summaries.put(summaryWithoutArtifacts(summary));
        }
      }

      done({ retainedById, retainedBytes, retainedBytesOverflow, expiredCount });
    } catch (error) {
      abortTransaction(transaction, error);
    }
  };

  artifactKeysRequest.onsuccess = finishRead;
  summariesRequest.onsuccess = finishRead;
  const lifecycleCursorRequest = lifecycle.openCursor();
  lifecycleCursorRequest.onsuccess = () => {
    try {
      const cursor = lifecycleCursorRequest.result;
      if (!cursor) {
        finishRead();
        return;
      }
      lifecycleEntries.push({ key: cursor.primaryKey, value: cursor.value });
      cursor.continue();
    } catch (error) {
      abortTransaction(transaction, error);
    }
  };
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

  if (artifactLogicalBytes(records.artifact) === null) {
    throw new TypeError("The coaching artifact payload is invalid.");
  }
  try {
    return await withCoachTransaction(
      [COACH_STORE, COACH_ARTIFACT_STORE, COACH_ARTIFACT_LIFECYCLE_STORE],
      "readwrite",
      (transaction) => {
        // Timestamp only after openCoachDatabase has finished any v2→v3
        // migration. Otherwise a first save can predate the shared migration
        // timestamp by a few milliseconds and misclassify its backfill as
        // future-dated corruption.
        const record = artifactLifecycleRecord(records.artifact, records.sessionId);
        if (!record) throw new TypeError("The coaching artifact payload is invalid.");
        const outcome = { summarySaved: true, artifactStatus: "stored" };
        const summaries = transaction.objectStore(COACH_STORE);
        const artifacts = transaction.objectStore(COACH_ARTIFACT_STORE);
        const lifecycle = transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE);
        reconcileArtifactState(transaction, record.retainedAtMs, (state) => {
          const replacedBytes = state.retainedById.get(record.id) || 0;
          const otherBytes = state.retainedBytes - replacedBytes;
          if (record.logicalBytes > ARTIFACT_MAX_LOGICAL_BYTES
            || state.retainedBytesOverflow
            || !Number.isSafeInteger(otherBytes)
            || otherBytes < 0
            || otherBytes > ARTIFACT_MAX_LOGICAL_BYTES - record.logicalBytes) {
            outcome.artifactStatus = "app-limit";
            summaries.put(summaryWithoutArtifacts(records.summary));
            artifacts.delete(record.id);
            lifecycle.delete(record.id);
            return;
          }
          summaries.put(records.summary);
          artifacts.put(records.artifact);
          lifecycle.put(record);
        });
        return outcome;
      },
    );
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error;
    await saveSummaryOnly(records.summary, records.sessionId);
    return { summarySaved: true, artifactStatus: "browser-quota" };
  }
}

async function cleanupExpiredCoachingArtifacts() {
  const outcome = { expiredCount: 0 };
  await withCoachTransaction(
    [COACH_STORE, COACH_ARTIFACT_STORE, COACH_ARTIFACT_LIFECYCLE_STORE],
    "readwrite",
    (transaction) => {
      const nowMs = Date.now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError("The coaching artifact expiry time is invalid.");
      }
      reconcileArtifactState(transaction, nowMs, (state) => {
        outcome.expiredCount = state.expiredCount;
      });
      return outcome;
    },
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
    [COACH_STORE, COACH_ARTIFACT_STORE, COACH_ARTIFACT_LIFECYCLE_STORE],
    "readwrite",
    (transaction) => {
      const nowMs = Date.now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError("The coaching artifact expiry time is invalid.");
      }
      const summaries = transaction.objectStore(COACH_STORE);
      const artifacts = transaction.objectStore(COACH_ARTIFACT_STORE);
      const lifecycle = transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE);
      const discardArtifact = () => {
        artifacts.delete(sessionId);
        lifecycle.delete(sessionId);
        scrubSummaryArtifacts(summaries, sessionId, transaction);
      };

      const lifecycleRequest = lifecycle.get(sessionId);
      lifecycleRequest.onsuccess = () => {
        try {
          const record = lifecycleRequest.result;
          if (!isActiveArtifactLifecycleRecord(record, sessionId, nowMs)) {
            discardArtifact();
            return;
          }
          const summaryRequest = summaries.get(sessionId);
          summaryRequest.onsuccess = () => {
            try {
              if (!summaryClaimsArtifacts(summaryRequest.result)) {
                discardArtifact();
                return;
              }
              const artifactRequest = artifacts.get(sessionId);
              artifactRequest.onsuccess = () => {
                try {
                  const artifact = artifactRequest.result;
                  const logicalBytes = artifactLogicalBytes(artifact);
                  if (!artifact || artifact.id !== sessionId || logicalBytes !== record.logicalBytes) {
                    discardArtifact();
                    return;
                  }
                  outcome.artifact = artifact;
                } catch (error) {
                  abortTransaction(transaction, error);
                }
              };
            } catch (error) {
              abortTransaction(transaction, error);
            }
          };
        } catch (error) {
          abortTransaction(transaction, error);
        }
      };
      return outcome;
    },
  );
  return outcome.artifact;
}

export function deleteCoachingArtifacts(id) {
  const sessionId = String(id || "");
  return withCoachTransaction(
    [COACH_STORE, COACH_ARTIFACT_STORE, COACH_ARTIFACT_LIFECYCLE_STORE],
    "readwrite",
    (transaction) => {
      const summaries = transaction.objectStore(COACH_STORE);
      const artifacts = transaction.objectStore(COACH_ARTIFACT_STORE);
      const request = summaries.get(sessionId);
      request.onsuccess = () => {
        try {
          if (request.result) summaries.put(summaryWithoutArtifacts(request.result));
          artifacts.delete(sessionId);
          transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE).delete(sessionId);
        } catch (error) {
          abortTransaction(transaction, error);
        }
      };
    },
  );
}

export function clearCoachingSummaries() {
  return withCoachTransaction(
    [COACH_STORE, COACH_ARTIFACT_STORE, COACH_ARTIFACT_LIFECYCLE_STORE],
    "readwrite",
    (transaction) => {
      transaction.objectStore(COACH_STORE).clear();
      transaction.objectStore(COACH_ARTIFACT_STORE).clear();
      transaction.objectStore(COACH_ARTIFACT_LIFECYCLE_STORE).clear();
    },
  );
}

export const coachingStorageSchema = Object.freeze({
  databaseName: COACH_DB_NAME,
  version: COACH_DB_VERSION,
  summaryStore: COACH_STORE,
  artifactStore: COACH_ARTIFACT_STORE,
  lifecycleStore: COACH_ARTIFACT_LIFECYCLE_STORE,
  lifecycleExpiryIndex: COACH_ARTIFACT_EXPIRY_INDEX,
  lifecycleSchemaVersion: ARTIFACT_LIFECYCLE_SCHEMA_VERSION,
  artifactRetentionMs: ARTIFACT_RETENTION_MS,
  artifactMaxLogicalBytes: ARTIFACT_MAX_LOGICAL_BYTES,
});

export const coachingStoragePolicy = Object.freeze({
  artifactLogicalBytes,
  artifactLifecycleRecord,
  isArtifactLifecycleRecord,
  isQuotaExceededError,
  summaryWithoutArtifacts,
});
