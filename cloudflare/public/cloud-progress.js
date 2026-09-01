const PREFERENCE_KEY = "nonstoptalk-cloud-progress-v1";
const API_PATH = "/api/v1/progress/sessions";
const PAGE_SIZE = 100;
const MAX_LISTED_SUMMARIES = 5_000;

const METRIC_KEYS = [
  "durationMs", "voicedMs", "speakingRatio", "pauseCount", "observedDurationMs",
  "unknownMs", "coverageRatio", "maxSampleGapMs", "medianPauseMs", "longestPauseMs",
  "longestSpeakingRunMs", "levelConsistencyPct", "clippingPct",
];
const ADVICE_KEYS = ["strength", "strengthEvidence", "focus", "focusEvidence", "drill", "drillDetail"];

export function sanitizeCloudSummary(value = {}) {
  const metrics = value.metrics && typeof value.metrics === "object" ? value.metrics : {};
  const advice = value.advice && typeof value.advice === "object" ? value.advice : {};
  const transcript = metrics.transcriptMetrics && typeof metrics.transcriptMetrics === "object"
    ? metrics.transcriptMetrics
    : null;
  const cleanMetrics = Object.fromEntries(METRIC_KEYS.map((key) => [key, finiteOrNull(metrics[key])]));
  cleanMetrics.audioConfidence = shortText(metrics.audioConfidence, 24);
  cleanMetrics.transcriptMetrics = transcript ? {
    wordCount: finiteOrNull(transcript.wordCount),
    wordsPerMinute: finiteOrNull(transcript.wordsPerMinute),
    fillerCount: finiteOrNull(transcript.fillerCount),
    repeatedWordCount: finiteOrNull(transcript.repeatedWordCount),
    fillerRatePer100Words: finiteOrNull(transcript.fillerRatePer100Words),
    repetitionRatePer100Words: finiteOrNull(transcript.repetitionRatePer100Words),
    fillerOccurrences: sanitizePatterns(transcript.fillerOccurrences, "phrase"),
    repeatedWords: sanitizePatterns(transcript.repeatedWords, "word"),
  } : null;
  const relationship = sanitizePracticeRelationship(value);
  return {
    analysisSchemaVersion: Math.max(1, Math.trunc(Number(value.analysisSchemaVersion) || 1)),
    id: shortText(value.id, 80),
    createdAt: shortText(value.createdAt, 40),
    scenario: shortText(value.scenario, 32),
    goal: shortText(value.goal, 32),
    targetDurationMs: finiteOrNull(value.targetDurationMs),
    metrics: cleanMetrics,
    advice: Object.fromEntries(ADVICE_KEYS.map((key) => [key, shortText(advice[key], 600)])),
    ...relationship,
  };
}

export function mergeCoachingSummaries(localSessions = [], cloudSessions = []) {
  const byId = new Map();
  for (const item of cloudSessions) if (item?.id) byId.set(item.id, item);
  // Local records win so local-only artifact metadata and download controls survive.
  for (const item of localSessions) if (item?.id) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createCloudProgressClient({ fetchImpl = globalThis.fetch, storage = globalThis.localStorage } = {}) {
  const isEnabled = () => {
    try { return storage?.getItem(PREFERENCE_KEY) === "enabled"; } catch { return false; }
  };
  const setEnabled = (enabled) => {
    try {
      if (enabled) storage?.setItem(PREFERENCE_KEY, "enabled");
      else storage?.removeItem(PREFERENCE_KEY);
    } catch { /* The preference is only a local convenience flag. */ }
  };
  const request = async (method, body, path = API_PATH) => {
    if (typeof fetchImpl !== "function") throw new Error("Cloud progress is unavailable.");
    const options = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetchImpl(path, options);
    let payload = {};
    try { payload = await response.json(); } catch { /* Handled by status below. */ }
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
      const error = new Error(message || `Cloud progress request failed (${response.status}).`);
      error.status = response.status;
      error.requestId = payload.requestId || response.headers?.get?.("X-Request-ID") || "";
      throw error;
    }
    return payload;
  };
  return {
    isEnabled,
    setEnabled,
    async save(session) {
      const payload = await request("POST", { session: sanitizeCloudSummary(session) });
      setEnabled(true);
      return payload.session;
    },
    async list() {
      const sessions = [];
      const seenCursors = new Set();
      let cursor = null;
      do {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (cursor) query.set("cursor", cursor);
        const payload = await request("GET", undefined, `${API_PATH}?${query}`);
        if (Array.isArray(payload.sessions)) sessions.push(...payload.sessions);
        const next = typeof payload.nextCursor === "string" && payload.nextCursor ? payload.nextCursor : null;
        if (!next) return sessions;
        if (seenCursors.has(next)) throw new Error("Cloud progress returned a repeated page cursor.");
        seenCursors.add(next);
        cursor = next;
      } while (sessions.length < MAX_LISTED_SUMMARIES);
      throw new Error(`Cloud progress contains more than ${MAX_LISTED_SUMMARIES} summaries; use the server export endpoint.`);
    },
    async clear() {
      const payload = await request("DELETE");
      setEnabled(false);
      return payload;
    },
  };
}

function sanitizePatterns(items, key) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 50).flatMap((item) => {
    const label = shortText(item?.[key], 64);
    return label ? [{ [key]: label, count: finiteOrNull(item?.count) ?? 0 }] : [];
  });
}

function sanitizePracticeRelationship(value) {
  const fields = ["practiceLoopId", "baselineAttemptId", "attemptRole", "feedbackMode"];
  if (!fields.some((key) => Object.hasOwn(value || {}, key))) return {};
  return {
    practiceLoopId: value.practiceLoopId === null ? null : shortText(value.practiceLoopId, 128),
    baselineAttemptId: value.baselineAttemptId === null ? null : shortText(value.baselineAttemptId, 128),
    attemptRole: shortText(value.attemptRole, 16),
    feedbackMode: shortText(value.feedbackMode, 20),
  };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export const cloudProgress = createCloudProgressClient();
