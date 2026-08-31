import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const adminToken = "local-platform-smoke-token-32-chars";
const roomFactHashKey = "local-room-fact-hmac-key-32-characters-minimum";
const offlineModelWranglerArgs = [
  "--var", "TOPIC_ROUTINE_PROVIDER:offline",
  "--var", "TOPIC_ESCALATION_PROVIDER:off",
];

function offlineWranglerEnv(extra = {}) {
  const env = {
    ...process.env,
    ...extra,
    TOPIC_ROUTINE_PROVIDER: "offline",
    TOPIC_ESCALATION_PROVIDER: "off",
  };
  delete env.ZAI_API_KEY;
  delete env.GEMINI_API_KEY;
  return env;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function stopProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

async function stopAndWait(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  stopProcessTree(child);
  await Promise.race([exited, delay(5_000)]);
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited before startup (${child.exitCode}).\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* Server is still starting. */ }
    await delay(250);
  }
  throw new Error(`Wrangler did not start.\n${output()}`);
}

async function waitForResponse(url, child, output) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited before startup (${child.exitCode}).\n${output()}`);
    try {
      return await fetch(url);
    } catch { /* Server is still starting. */ }
    await delay(250);
  }
  throw new Error(`Wrangler did not start.\n${output()}`);
}

function completeSummary(id, extra = {}) {
  return {
    analysisSchemaVersion: 2,
    id,
    createdAt: new Date().toISOString(),
    scenario: "interview",
    goal: "pauses",
    targetDurationMs: 45_000,
    metrics: {
      durationMs: 44_000,
      voicedMs: 31_000,
      speakingRatio: 0.7045,
      pauseCount: 4,
      observedDurationMs: 43_500,
      unknownMs: 500,
      coverageRatio: 0.9886,
      maxSampleGapMs: 130,
      medianPauseMs: 700,
      longestPauseMs: 1_400,
      longestSpeakingRunMs: 9_500,
      levelConsistencyPct: 82,
      clippingPct: 0,
      audioConfidence: "high",
      transcriptMetrics: {
        wordCount: 86,
        wordsPerMinute: 117,
        fillerCount: 2,
        repeatedWordCount: 1,
        fillerRatePer100Words: 2.33,
        repetitionRatePer100Words: 1.16,
        fillerOccurrences: [{ phrase: "um", count: 2 }],
        repeatedWords: [{ word: "the", count: 1 }],
      },
    },
    advice: {
      strength: "Clear opening",
      strengthEvidence: "Your first thought was easy to follow.",
      focus: "Leave one deliberate pause.",
      focusEvidence: "Four pauses were measured.",
      drill: "Breathe between ideas.",
      drillDetail: "Repeat once with a full breath after the first sentence.",
    },
    ...extra,
  };
}

const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "nonstoptalk-platform-"));
const upgradeStateDirectory = await mkdtemp(path.join(os.tmpdir(), "nonstoptalk-platform-upgrade-"));
const port = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
let logs = "";
let auxiliaryLogs = "";
let child;
let auxiliaryChild;

try {
  const legacyActiveDevice = "b".repeat(64);
  const legacyExpiredDevice = "c".repeat(64);
  const legacySchema = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--file", path.join(root, "cloudflare", "migrations", "0001_platform.sql"),
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (legacySchema.status !== 0) {
    throw new Error(`Could not initialize the v1 migration fixture.\n${legacySchema.stdout}\n${legacySchema.stderr}`);
  }
  const legacySeed = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--command", `
        INSERT INTO devices (device_key, created_at, last_seen_at, expires_at) VALUES
          ('${legacyActiveDevice}', '2026-01-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'),
          ('${legacyExpiredDevice}', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', '2025-02-01T00:00:00.000Z');
        INSERT INTO coaching_sessions (
          device_key, session_id, analysis_schema_version, client_created_at,
          received_at, updated_at, expires_at, scenario, goal, target_duration_ms,
          duration_ms, speaking_ratio, pause_count, audio_confidence,
          transcript_metrics_used, summary_json
        ) VALUES
          ('${legacyActiveDevice}', 'already-expired', 2, '2025-01-01T00:00:00.000Z',
            '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z',
            'interview', 'pauses', 45000, 44000, 0.7, 4, 'high', 0, '{}'),
          ('${legacyExpiredDevice}', 'inactive-device-row', 2, '2025-01-01T00:00:00.000Z',
            '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
            'interview', 'pauses', 45000, 44000, 0.7, 4, 'high', 0, '{}');
        WITH RECURSIVE sequence(value) AS (
          VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 251
        )
        INSERT INTO coaching_sessions (
          device_key, session_id, analysis_schema_version, client_created_at,
          received_at, updated_at, expires_at, scenario, goal, target_duration_ms,
          duration_ms, speaking_ratio, pause_count, audio_confidence,
          transcript_metrics_used, summary_json
        ) SELECT
          '${legacyActiveDevice}', printf('grandfathered-%03d', value), 2,
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
          'interview', 'pauses', 45000, 44000, 0.7, 4, 'high', 0, '{}'
        FROM sequence;
      `,
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (legacySeed.status !== 0) {
    throw new Error(`Could not seed the v1 migration fixture.\n${legacySeed.stdout}\n${legacySeed.stderr}`);
  }
  const legacyPort = await getFreePort();
  auxiliaryChild = spawn(
    process.execPath,
    [
      wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(legacyPort),
      "--persist-to", upgradeStateDirectory,
      "--var", `ANALYTICS_ADMIN_TOKEN:${adminToken}`,
      "--var", `ROOM_FACT_HASH_KEY:${roomFactHashKey}`,
      ...offlineModelWranglerArgs,
    ],
    {
      cwd: root,
      detached: process.platform !== "win32",
      env: offlineWranglerEnv({ NO_COLOR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [auxiliaryChild.stdout, auxiliaryChild.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { auxiliaryLogs = `${auxiliaryLogs}${chunk}`.slice(-30_000); });
  }
  const legacyStatus = await waitForResponse(
    `http://127.0.0.1:${legacyPort}/api/v1/platform/status`,
    auxiliaryChild,
    () => auxiliaryLogs,
  );
  const legacyStatusPayload = await legacyStatus.json();
  assert(legacyStatus.status === 503, "A schema-v1 database must not report ready to the schema-v3 Worker");
  assert(legacyStatusPayload.error?.code === "DATABASE_UNAVAILABLE", "Schema skew needs a stable status error");
  await stopAndWait(auxiliaryChild);
  auxiliaryChild = undefined;
  const upgrade = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--file", path.join(root, "cloudflare", "migrations", "0002_device_lease.sql"),
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (upgrade.status !== 0) {
    throw new Error(`The v1-to-v2 migration failed.\n${upgrade.stdout}\n${upgrade.stderr}`);
  }
  const upgradeCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--command", `SELECT
        schema_version AS schemaVersion,
        (SELECT COUNT(*) FROM coaching_sessions WHERE device_key = '${legacyActiveDevice}') AS grandfathered,
        (SELECT COUNT(*) FROM coaching_sessions WHERE session_id = 'already-expired') AS expiredRows,
        (SELECT COUNT(*) FROM coaching_sessions WHERE device_key = '${legacyExpiredDevice}') AS inactiveDeviceRows,
        (SELECT COUNT(*) FROM pragma_table_info('coaching_sessions') WHERE name = 'expires_at') AS expiryColumns
      FROM platform_meta WHERE id = 1`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (upgradeCheck.status !== 0) {
    throw new Error(`Could not verify the v1-to-v2 migration.\n${upgradeCheck.stdout}\n${upgradeCheck.stderr}`);
  }
  const upgraded = JSON.parse(upgradeCheck.stdout)[0]?.results?.[0];
  assert(upgraded?.schemaVersion === 2, "The device-lease migration must advance the schema marker");
  assert(upgraded?.grandfathered === 251, "The device-lease migration must preserve valid legacy summaries");
  assert(upgraded?.expiredRows === 0 && upgraded?.inactiveDeviceRows === 0,
    "The device-lease migration must not revive expired legacy summaries");
  assert(upgraded?.expiryColumns === 0, "The device-lease migration must remove per-summary expiry");

  const migration = spawnSync(
    process.execPath,
    [wrangler, "d1", "migrations", "apply", "PLATFORM_DB", "--local", "--persist-to", stateDirectory],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (migration.status !== 0) {
    throw new Error(`Local D1 migration failed.\n${migration.stdout}\n${migration.stderr}`);
  }

  const expiredDevice = "f".repeat(64);
  const expiredRoom = "e".repeat(64);
  const quotaToken = "a".repeat(64);
  const quotaDevice = createHash("sha256").update(quotaToken).digest("hex");
  const quotaSummary = completeSummary("quota-001");
  const quotaSummaryJson = JSON.stringify(quotaSummary).replaceAll("'", "''");
  const seed = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", `
        INSERT INTO devices (device_key, created_at, last_seen_at, expires_at)
        VALUES ('${expiredDevice}', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', '2025-02-01T00:00:00.000Z');
        INSERT INTO consent_records (
          device_key, purpose, policy_version, granted, granted_at, revoked_at, updated_at
        ) VALUES (
          '${expiredDevice}', 'cloud_summary', 'cloud-summary-v1', 1,
          '2025-01-01T00:00:00.000Z', NULL, '2025-01-01T00:00:00.000Z'
        );
        INSERT INTO coaching_sessions (
          device_key, session_id, analysis_schema_version, client_created_at,
          received_at, updated_at, scenario, goal, target_duration_ms, duration_ms,
          speaking_ratio, pause_count, audio_confidence, transcript_metrics_used, summary_json
        ) VALUES (
          '${expiredDevice}', 'expired-smoke-summary', 2, '2025-01-01T00:00:00.000Z',
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 'interview', 'pauses',
          45000, 44000, 0.7, 4, 'high', 0, '{}'
        );
        INSERT INTO room_facts (
          room_key, first_observed_at, last_observed_at, expires_at, state_version,
          last_milestone, phase, player_count, online_player_count, configured_rounds,
          turn_duration_seconds, topic_pack, completed_turn_count, finished_game_count,
          total_score, last_turn_spoken_seconds
        ) VALUES (
          '${expiredRoom}', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z',
          '2025-02-01T00:00:00.000Z', 1, 'created', 'setup', 0, 0, 1, 60,
          'everyday', 0, 0, 0, 0
        );
        WITH RECURSIVE sequence(value) AS (
          VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 500
        )
        INSERT INTO room_facts (
          room_key, first_observed_at, last_observed_at, expires_at, state_version,
          last_milestone, phase, player_count, online_player_count, configured_rounds,
          turn_duration_seconds, topic_pack, completed_turn_count, finished_game_count,
          total_score, last_turn_spoken_seconds
        ) SELECT
          printf('%064x', value), '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z',
          '2025-02-01T00:00:00.000Z', 1, 'created', 'setup', 0, 0, 1, 60,
          'everyday', 0, 0, 0, 0
        FROM sequence;
        INSERT INTO devices (device_key, created_at, last_seen_at, expires_at)
        VALUES ('${quotaDevice}', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
        INSERT INTO consent_records (
          device_key, purpose, policy_version, granted, granted_at, revoked_at, updated_at
        ) VALUES (
          '${quotaDevice}', 'cloud_summary', 'cloud-summary-v1', 1,
          '2026-08-01T00:00:00.000Z', NULL, '2026-08-01T00:00:00.000Z'
        );
        WITH RECURSIVE sequence(value) AS (
          VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 250
        )
        INSERT INTO coaching_sessions (
          device_key, session_id, analysis_schema_version, client_created_at,
          received_at, updated_at, scenario, goal, target_duration_ms, duration_ms,
          speaking_ratio, pause_count, audio_confidence, transcript_metrics_used, summary_json
        ) SELECT
          '${quotaDevice}', printf('quota-%03d', value), 2, '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'interview', 'pauses',
          45000, 44000, 0.7, 4, 'high', 0,
          CASE WHEN value = 1 THEN '${quotaSummaryJson}' ELSE '{}' END
        FROM sequence;
      `,
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (seed.status !== 0) {
    throw new Error(`Could not seed expired D1 rows.\n${seed.stdout}\n${seed.stderr}`);
  }

  const degradedPort = await getFreePort();
  auxiliaryChild = spawn(
    process.execPath,
    [
      wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(degradedPort),
      "--persist-to", stateDirectory,
      ...offlineModelWranglerArgs,
    ],
    {
      cwd: root,
      detached: process.platform !== "win32",
      env: offlineWranglerEnv({ NO_COLOR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [auxiliaryChild.stdout, auxiliaryChild.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { auxiliaryLogs = `${auxiliaryLogs}${chunk}`.slice(-30_000); });
  }
  const degradedStatus = await waitForResponse(
    `http://127.0.0.1:${degradedPort}/api/v1/platform/status`,
    auxiliaryChild,
    () => auxiliaryLogs,
  );
  const degradedPayload = await degradedStatus.json();
  assert(degradedStatus.ok && degradedPayload.status === "degraded", "Missing optional secrets must produce a usable degraded status");
  assert(degradedPayload.degradedCapabilities?.includes("roomFacts"), "Status must report missing room-fact hashing");
  assert(degradedPayload.degradedCapabilities?.includes("adminAnalytics"), "Status must report missing admin analytics auth");
  await stopAndWait(auxiliaryChild);
  auxiliaryChild = undefined;

  child = spawn(
    process.execPath,
    [
      wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
      "--persist-to", stateDirectory,
      "--var", `ANALYTICS_ADMIN_TOKEN:${adminToken}`,
      "--var", `ROOM_FACT_HASH_KEY:${roomFactHashKey}`,
      ...offlineModelWranglerArgs,
    ],
    {
      cwd: root,
      detached: process.platform !== "win32",
      env: offlineWranglerEnv({ NO_COLOR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-30_000); });
  }
  await waitForServer(`${origin}/api/v1/platform/status`, child, () => logs);

  let cookie = "";
  const request = async (pathname, options = {}) => {
    const method = options.method || "GET";
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
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
    try { payload = await response.json(); } catch { /* Assert status below. */ }
    return { response, payload };
  };

  const status = await request("/api/v1/platform/status");
  assert(status.response.ok, `Platform status failed (${status.response.status})`);
  assert(status.payload.status === "ok", "Configured platform status should be ok");
  assert(status.payload.schemaVersion === 3, "Platform status should report the supported D1 schema");
  assert(status.payload.capabilities?.cloudProgress?.newSaveLimit === 250, "Platform status should report the anonymous new-save cap");
  assert(status.payload.capabilities?.topicGeneration?.routine?.status === "offline",
    "Platform status should disclose the disabled-by-default routine provider without exposing a key");
  assert(status.payload.capabilities?.topicGeneration?.escalated?.externalAvailable === false,
    "Platform status should disclose that Gemma escalation is unavailable by default");
  assert(status.payload.capabilities?.aggregateAnalytics?.delivery === "best-effort", "Platform status must not overstate analytics delivery");

  const quotaRetryResponse = await fetch(`${origin}/api/v1/progress/sessions`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: `nonstoptalk_token=${quotaToken}`,
      Origin: origin,
    },
    body: JSON.stringify({ session: quotaSummary }),
  });
  const quotaRetryPayload = await quotaRetryResponse.json();
  assert(quotaRetryResponse.status === 200, `An idempotent retry must work at the cloud quota (${quotaRetryResponse.status})`);
  assert(quotaRetryPayload.created === false, "A retry at the cloud quota must not create a duplicate");

  const quotaResponse = await fetch(`${origin}/api/v1/progress/sessions`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: `nonstoptalk_token=${quotaToken}`,
      Origin: origin,
    },
    body: JSON.stringify({ session: completeSummary("quota-overflow") }),
  });
  const quotaPayload = await quotaResponse.json();
  assert(quotaResponse.status === 409, `Cloud quota should reject summary 251 (${quotaResponse.status})`);
  assert(quotaPayload.error?.code === "STORAGE_LIMIT_REACHED", "Cloud quota needs a stable error code");

  const initiallyEmpty = await request("/api/v1/progress/sessions");
  assert(initiallyEmpty.response.ok, `Initial summary list failed (${initiallyEmpty.response.status})`);
  assert(initiallyEmpty.payload.sessions?.length === 0, "A new browser identity must start with no cloud summaries");

  const forbidden = await request("/api/v1/progress/sessions", {
    method: "POST",
    body: { session: completeSummary("forbidden-attempt", { capturedTranscript: "never store me" }) },
  });
  assert(forbidden.response.status === 422, `Raw transcript field should be rejected, got ${forbidden.response.status}`);
  assert(forbidden.payload.error?.code === "FORBIDDEN_CLOUD_DATA", "Privacy rejection needs a stable error code");

  const validSummary = completeSummary("attempt-1", {
    artifacts: {
      audioStored: true,
      audioBytes: 12345,
      audioMimeType: "audio/webm",
      transcriptStored: true,
      transcriptMayBePartial: false,
    },
  });
  const saved = await request("/api/v1/progress/sessions", {
    method: "POST",
    body: { session: validSummary },
  });
  assert(saved.response.status === 201, `Summary save failed (${saved.response.status}): ${JSON.stringify(saved.payload)}`);
  assert(saved.response.headers.get("x-request-id"), "Platform responses must include a request ID");
  assert(!JSON.stringify(saved.payload).includes("audioBytes"), "Local artifact metadata must not be returned from cloud storage");

  const retried = await request("/api/v1/progress/sessions", {
    method: "POST",
    body: { session: validSummary },
  });
  assert(retried.response.status === 200, `Idempotent summary retry failed (${retried.response.status})`);
  assert(retried.payload.created === false, "Idempotent summary retry must not create a second record");

  const listed = await request("/api/v1/progress/sessions");
  assert(listed.response.ok, `Summary list failed (${listed.response.status})`);
  assert(listed.payload.sessions?.length === 1, "Expected one cloud summary");
  const serialized = JSON.stringify(listed.payload);
  assert(!serialized.includes("capturedTranscript"), "Captured transcript fields must never be returned");
  assert(!serialized.includes("audioBytes"), "Local artifact metadata must never be persisted");

  const roomCreated = await request("/api/rooms", { method: "POST", body: { name: "Smoke host" } });
  assert(roomCreated.response.status === 201, `Room creation failed (${roomCreated.response.status})`);
  assert(!roomCreated.response.headers.has("x-nonstoptalk-room-milestones"), "Internal telemetry headers must not leak");
  const roomCode = roomCreated.payload.room?.code;
  const generatedTopics = await request("/api/v1/models/topics", {
    method: "POST",
    body: {
      roomCode,
      theme: "friendly robots",
      tier: "routine",
      externalConsent: false,
    },
  });
  assert(generatedTopics.response.ok, `Offline topic generation failed (${generatedTopics.response.status})`);
  assert(generatedTopics.payload.provider === "offline" && generatedTopics.payload.external === false,
    "The default topic generator must make no external provider claim");
  assert(generatedTopics.payload.fallbackCode === null, "The configured offline path is not a provider failure");
  assert(generatedTopics.payload.topics?.length === 10, "Offline topic generation must return ten editable prompts");
  assert(Number.isSafeInteger(generatedTopics.payload.topicGeneration),
    "Topic generation must return an authoritative stale-result guard");
  assert(generatedTopics.payload.topics.every((topic) => topic.includes("friendly robots")),
    "Offline prompts should be grounded in the host theme");
  const appliedTopics = await request(`/api/rooms/${roomCode}/action`, {
    method: "POST",
    body: {
      type: "custom-topics",
      topics: generatedTopics.payload.topics,
      topicGeneration: generatedTopics.payload.topicGeneration,
    },
  });
  assert(appliedTopics.response.ok, `Generated topics could not be applied (${appliedTopics.response.status})`);
  assert(appliedTopics.payload.room?.settings?.topicPack === "custom",
    "Generated topics must still pass through the authoritative host room action");
  const modelUsage = await request("/api/v1/admin/model-usage?days=1", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert(modelUsage.response.ok, `Model usage analytics failed (${modelUsage.response.status})`);
  assert(modelUsage.payload.totals?.reservedCalls === 0,
    "Deterministic topic generation must not consume the external model budget");
  assert(!JSON.stringify(modelUsage.payload).includes("friendly robots"),
    "Model usage analytics must not retain the host theme");

  let analytics;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    analytics = await request("/api/v1/admin/analytics?days=1", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (analytics.payload.totals?.coaching_summary_saved?.events === 1 && analytics.payload.totals?.room_created?.events === 1) break;
    await delay(100);
  }
  assert(analytics.response.ok, `Admin analytics failed (${analytics.response.status})`);
  assert(analytics.payload.totals.coaching_summary_saved.events === 1, "Summary sync aggregate was not recorded");
  assert(analytics.payload.totals.cloud_consent_granted.events === 1, "Consent grant transition was not recorded once");
  assert(analytics.payload.totals.room_created.events === 1, "Room milestone aggregate was not recorded");
  assert(!JSON.stringify(analytics.payload).includes("Smoke host"), "Analytics response must not contain player names");

  const removed = await request("/api/v1/progress/sessions", { method: "DELETE" });
  assert(removed.response.ok, `Cloud delete failed (${removed.response.status})`);
  assert(removed.payload.deletedCount === 1, "Cloud delete must report the one removed summary");
  assert(removed.payload.consentRevoked === true, "Cloud delete must report the granted-to-revoked transition");
  const empty = await request("/api/v1/progress/sessions");
  assert(empty.payload.sessions?.length === 0, "Cloud delete must remove every summary for this browser");

  const repeatedDelete = await request("/api/v1/progress/sessions", { method: "DELETE" });
  assert(repeatedDelete.payload.deletedCount === 0, "Repeated cloud delete must not invent deleted records");
  assert(repeatedDelete.payload.consentRevoked === false, "Repeated cloud delete must not invent consent transitions");
  const finalAnalytics = await request("/api/v1/admin/analytics?days=1", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert(finalAnalytics.payload.totals.coaching_summary_deleted.events === 1, "Real delete operation was not recorded once");
  assert(finalAnalytics.payload.totals.coaching_summary_deleted.value === 1, "Deleted-summary aggregate has the wrong value");
  assert(finalAnalytics.payload.totals.cloud_consent_revoked.events === 1, "Consent revocation transition was not recorded once");

  const scheduled = await fetch(`${origin}/cdn-cgi/local/scheduled`);
  assert(scheduled.ok, `Scheduled cleanup trigger failed (${scheduled.status})`);
  await delay(250);
  await stopAndWait(child);
  child = undefined;

  const cleanupCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", `SELECT
        (SELECT COUNT(*) FROM devices WHERE device_key = '${expiredDevice}') AS devices,
        (SELECT COUNT(*) FROM consent_records WHERE device_key = '${expiredDevice}') AS consents,
        (SELECT COUNT(*) FROM coaching_sessions WHERE device_key = '${expiredDevice}') AS summaries,
        (SELECT COUNT(*) FROM room_facts WHERE expires_at <= '2025-02-01T00:00:00.000Z') AS rooms`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (cleanupCheck.status !== 0) {
    throw new Error(`Could not verify scheduled D1 cleanup.\n${cleanupCheck.stdout}\n${cleanupCheck.stderr}`);
  }
  const cleanupPayload = JSON.parse(cleanupCheck.stdout);
  const cleaned = cleanupPayload[0]?.results?.[0];
  assert(cleaned?.devices === 0 && cleaned?.consents === 0 && cleaned?.summaries === 0 && cleaned?.rooms === 0,
    `Scheduled cleanup left expired rows behind: ${JSON.stringify(cleaned)}`);

  console.log("Cloud platform D1/API privacy and retention smoke test passed.");
} catch (error) {
  if (logs.trim()) console.error(`Wrangler output captured before failure:\n${logs.trim()}`);
  if (auxiliaryLogs.trim()) console.error(`Auxiliary Wrangler output captured before failure:\n${auxiliaryLogs.trim()}`);
  throw error;
} finally {
  await stopAndWait(child);
  await stopAndWait(auxiliaryChild);
  await rm(stateDirectory, { recursive: true, force: true });
  await rm(upgradeStateDirectory, { recursive: true, force: true });
}
