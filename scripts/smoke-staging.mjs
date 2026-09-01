import assert from "node:assert/strict";
import crypto from "node:crypto";

const origin = new URL(process.argv[2] || "https://nonstoptalk-staging.aakashplays656.workers.dev").origin;
const hostname = new URL(origin).hostname;
const STAGING_HOSTNAME = "nonstoptalk-staging.aakashplays656.workers.dev";

if (new URL(origin).protocol !== "https:"
  || hostname !== STAGING_HOSTNAME) {
  throw new Error(`Refusing to run the mutating staging probe against ${hostname}.`);
}

let cookie = "";
let cleanupRequired = false;

async function request(pathname, options = {}) {
  const method = options.method || "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (cookie) headers.set("Cookie", cookie);
  if (!["GET", "HEAD"].includes(method)) headers.set("Origin", origin);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Status and response shape are asserted by each caller.
  }
  return { response, payload };
}

function stagingSummary(id, practiceLoopId) {
  return {
    analysisSchemaVersion: 2,
    id,
    createdAt: new Date().toISOString(),
    scenario: "interview",
    goal: "pauses",
    targetDurationMs: 30_000,
    metrics: {
      durationMs: 28_000,
      voicedMs: 18_000,
      speakingRatio: 0.6429,
      pauseCount: 3,
      observedDurationMs: 27_500,
      unknownMs: 500,
      coverageRatio: 0.9821,
      maxSampleGapMs: 120,
      medianPauseMs: 650,
      longestPauseMs: 1_200,
      longestSpeakingRunMs: 7_500,
      levelConsistencyPct: 80,
      clippingPct: 0,
      audioConfidence: "high",
      transcriptMetrics: null,
    },
    advice: {
      strength: "Measured baseline",
      strengthEvidence: "The staging probe produced bounded synthetic evidence.",
      focus: "Keep one deliberate pause.",
      focusEvidence: "Three pauses were represented in the fixture.",
      drill: "Pause between two ideas.",
      drillDetail: "This synthetic summary validates storage, not speech quality.",
    },
    practiceLoopId,
    baselineAttemptId: id,
    attemptRole: "baseline",
    feedbackMode: "review-only",
  };
}

try {
  const status = await request("/api/v1/platform/status");
  assert.equal(status.response.status, 200, "Staging status must be healthy before a write probe.");
  assert.equal(status.payload.status, "ok");
  assert.equal(status.payload.schemaVersion, 4);

  const suffix = crypto.randomBytes(12).toString("hex");
  const sessionId = `staging-${suffix}`;
  const loopId = `staging-loop-${suffix}`;
  const saved = await request("/api/v1/progress/sessions", {
    method: "POST",
    body: { session: stagingSummary(sessionId, loopId) },
  });
  // A successful write may already exist even if a later response assertion
  // fails, so arm cleanup as soon as the POST returns with an identity cookie.
  cleanupRequired = Boolean(cookie);
  assert.equal(saved.response.status, 201, "Staging must accept a consented compact summary.");
  assert.equal(saved.payload.created, true);
  assert.equal(saved.payload.session?.id, sessionId);
  assert.equal(saved.payload.session?.practiceLoopId, loopId);
  assert.equal(saved.payload.session?.feedbackMode, "review-only");
  assert.ok(saved.response.headers.get("x-request-id"), "Staging writes must expose a request ID.");
  const listed = await request("/api/v1/progress/sessions");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.payload.sessions?.length, 1);
  assert.equal(listed.payload.sessions?.[0]?.id, sessionId);

  const removed = await request("/api/v1/progress/sessions", { method: "DELETE" });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.payload.deletedCount, 1);
  assert.equal(removed.payload.consentRevoked, true);
  cleanupRequired = false;

  const empty = await request("/api/v1/progress/sessions");
  assert.equal(empty.response.status, 200);
  assert.equal(empty.payload.sessions?.length, 0);

  console.log(JSON.stringify({
    status: "ok",
    origin,
    checks: ["d1-write", "profile-foundation-round-trip", "relationship-round-trip", "device-scoped-delete"],
  }));
} finally {
  if (cleanupRequired && cookie) {
    const cleanup = await request("/api/v1/progress/sessions", { method: "DELETE" });
    if (!cleanup.response.ok) {
      throw new Error(`Staging cleanup failed with HTTP ${cleanup.response.status}.`);
    }
  }
}
