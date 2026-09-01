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
const adminToken = "6".repeat(64);
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
let port;
let origin;
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
        INSERT INTO consent_records (
          device_key, purpose, policy_version, granted, granted_at, revoked_at, updated_at
        ) VALUES (
          '${legacyActiveDevice}', 'cloud_summary', 'cloud-summary-v1', 1,
          '2026-01-01T00:00:00.000Z', NULL, '2026-08-01T00:00:00.000Z'
        );
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
  assert(legacyStatus.status === 503, "A schema-v1 database must not report ready to the schema-v5 Worker");
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

  const rejectedOutOfOrderProfileMigration = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--file", path.join(root, "cloudflare", "migrations", "0004_sync_profiles.sql"),
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  assert(rejectedOutOfOrderProfileMigration.status !== 0,
    "The profile foundation migration must reject a schema-v2 database");
  const rejectedMigrationCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--command", `SELECT
        schema_version AS schemaVersion,
        (SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table' AND name IN (
            'sync_profiles', 'sync_profile_devices',
            '_migration_0004_schema_guard', '_migration_0004_profile_backfill'
          )) AS profileTables
      FROM platform_meta WHERE id = 1`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (rejectedMigrationCheck.status !== 0) {
    throw new Error(`Could not verify the rejected out-of-order profile migration.\n${rejectedMigrationCheck.stdout}\n${rejectedMigrationCheck.stderr}`);
  }
  const rejectedMigration = JSON.parse(rejectedMigrationCheck.stdout)[0]?.results?.[0];
  assert(rejectedMigration?.schemaVersion === 2 && rejectedMigration?.profileTables === 0,
    `The rejected profile migration must leave schema v2 untouched: ${JSON.stringify(rejectedMigration)}`);

  const rejectedOutOfOrderHeartbeatMigration = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--file", path.join(root, "cloudflare", "migrations", "0005_cleanup_heartbeat.sql"),
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  assert(rejectedOutOfOrderHeartbeatMigration.status !== 0,
    "The cleanup-heartbeat migration must reject a schema-v2 database");
  const rejectedHeartbeatCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--command", `SELECT
        schema_version AS schemaVersion,
        (SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table' AND name IN (
            'platform_maintenance', '_migration_0005_schema_guard'
          )) AS heartbeatTables
      FROM platform_meta WHERE id = 1`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (rejectedHeartbeatCheck.status !== 0) {
    throw new Error(`Could not verify the rejected out-of-order heartbeat migration.\n${rejectedHeartbeatCheck.stdout}\n${rejectedHeartbeatCheck.stderr}`);
  }
  const rejectedHeartbeat = JSON.parse(rejectedHeartbeatCheck.stdout)[0]?.results?.[0];
  assert(rejectedHeartbeat?.schemaVersion === 2 && rejectedHeartbeat?.heartbeatTables === 0,
    `The rejected heartbeat migration must leave schema v2 untouched: ${JSON.stringify(rejectedHeartbeat)}`);

  const modelUsageUpgrade = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--file", path.join(root, "cloudflare", "migrations", "0003_model_usage.sql"),
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (modelUsageUpgrade.status !== 0) {
    throw new Error(`The v2-to-v3 migration failed.\n${modelUsageUpgrade.stdout}\n${modelUsageUpgrade.stderr}`);
  }

  const profileUpgrade = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--file", path.join(root, "cloudflare", "migrations", "0004_sync_profiles.sql"),
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (profileUpgrade.status !== 0) {
    throw new Error(`The v3-to-v4 profile foundation migration failed.\n${profileUpgrade.stdout}\n${profileUpgrade.stderr}`);
  }
  const profileUpgradeCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--command", `SELECT
        schema_version AS schemaVersion,
        (SELECT COUNT(*) FROM devices) AS devices,
        (SELECT COUNT(*) FROM consent_records) AS consents,
        (SELECT COUNT(*) FROM coaching_sessions) AS summaries,
        (SELECT COUNT(*) FROM sync_profiles) AS profiles,
        (SELECT COUNT(*) FROM sync_profile_devices) AS memberships,
        (SELECT COUNT(*) FROM sync_profile_devices AS membership
          JOIN sync_profiles AS profile ON profile.profile_id = membership.profile_id
          JOIN devices AS device ON device.device_key = membership.device_key
          WHERE profile.created_at <> device.created_at
            OR profile.last_seen_at <> device.last_seen_at
            OR profile.expires_at <> device.expires_at
            OR profile.sync_generation <> 1
            OR membership.joined_at <> device.created_at
            OR membership.last_seen_at <> device.last_seen_at) AS backfillMismatches,
        (SELECT COUNT(*) FROM sync_profile_devices AS membership
          WHERE membership.profile_id = membership.membership_id
            OR membership.profile_id = membership.device_key
            OR membership.membership_id = membership.device_key
            OR EXISTS (
              SELECT 1 FROM devices AS candidate
              WHERE candidate.device_key IN (membership.profile_id, membership.membership_id)
            )) AS reusedIdentifiers,
        (SELECT COUNT(*) FROM sync_profile_devices AS membership
          JOIN sync_profiles AS profile ON profile.profile_id = membership.profile_id
          WHERE length(profile.profile_id) <> 64
            OR profile.profile_id GLOB '*[^0-9a-f]*'
            OR length(membership.membership_id) <> 64
            OR membership.membership_id GLOB '*[^0-9a-f]*') AS invalidIdentifiers,
        (SELECT COUNT(*) FROM pragma_table_info('devices')) AS deviceColumns,
        (SELECT COUNT(*) FROM pragma_table_info('consent_records')) AS consentColumns,
        (SELECT COUNT(*) FROM pragma_table_info('coaching_sessions')) AS summaryColumns,
        (SELECT COUNT(*) FROM pragma_table_info('sync_profiles')) AS profileColumns,
        (SELECT COUNT(*) FROM pragma_table_info('sync_profile_devices')) AS membershipColumns,
        (SELECT "notnull" FROM pragma_table_info('sync_profiles')
          WHERE name = 'profile_id') AS profileIdNotNull,
        (SELECT "notnull" FROM pragma_table_info('sync_profile_devices')
          WHERE name = 'membership_id') AS membershipIdNotNull,
        (SELECT COUNT(*) FROM pragma_table_info('coaching_sessions')
          WHERE (name = 'device_key' AND pk = 1) OR (name = 'session_id' AND pk = 2)) AS summaryPrimaryKeyColumns,
        (SELECT COUNT(*) FROM pragma_foreign_key_list('coaching_sessions')
          WHERE "table" = 'devices' AND "from" = 'device_key' AND "to" = 'device_key'
            AND on_delete = 'CASCADE') AS summaryDeviceCascades,
        (SELECT COUNT(*) FROM pragma_foreign_key_list('sync_profile_devices')
          WHERE "table" = 'sync_profiles' AND "from" = 'profile_id' AND "to" = 'profile_id'
            AND on_delete = 'CASCADE') AS membershipProfileCascades,
        (SELECT COUNT(*) FROM pragma_foreign_key_list('sync_profile_devices')
          WHERE "table" = 'devices' AND "from" = 'device_key' AND "to" = 'device_key'
            AND on_delete = 'CASCADE') AS membershipDeviceCascades,
        (SELECT COUNT(*) FROM pragma_index_list('sync_profiles')
          WHERE name = 'sync_profiles_expires_at_idx') AS profileExpiryIndexes,
        (SELECT COUNT(*) FROM pragma_index_list('sync_profile_devices')
          WHERE name = 'sync_profile_devices_profile_idx') AS membershipProfileIndexes,
        (SELECT COUNT(*) FROM pragma_index_list('sync_profile_devices')
          WHERE "unique" = 1 AND origin = 'u') AS membershipDeviceUniqueIndexes,
        (SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table' AND name LIKE '_migration_0004_%') AS migrationScratchTables
      FROM platform_meta WHERE id = 1`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (profileUpgradeCheck.status !== 0) {
    throw new Error(`Could not verify the v3-to-v4 profile migration.\n${profileUpgradeCheck.stdout}\n${profileUpgradeCheck.stderr}`);
  }
  const profileUpgradeResult = JSON.parse(profileUpgradeCheck.stdout)[0]?.results?.[0];
  assert(profileUpgradeResult?.schemaVersion === 4, "The profile migration must advance the schema marker to 4");
  assert(profileUpgradeResult?.devices === 2
    && profileUpgradeResult?.profiles === profileUpgradeResult.devices
    && profileUpgradeResult?.memberships === profileUpgradeResult.devices,
  `Every existing device must receive exactly one profile membership: ${JSON.stringify(profileUpgradeResult)}`);
  assert(profileUpgradeResult?.consents === 1 && profileUpgradeResult?.summaries === 251,
    "The profile migration must preserve existing consent and coaching rows");
  assert(profileUpgradeResult?.backfillMismatches === 0
    && profileUpgradeResult?.reusedIdentifiers === 0
    && profileUpgradeResult?.invalidIdentifiers === 0,
  `Profile backfill identifiers and lease timestamps must be independent and exact: ${JSON.stringify(profileUpgradeResult)}`);
  assert(profileUpgradeResult?.deviceColumns === 4
    && profileUpgradeResult?.consentColumns === 7
    && profileUpgradeResult?.summaryColumns === 19
    && profileUpgradeResult?.profileColumns === 5
    && profileUpgradeResult?.membershipColumns === 5
    && profileUpgradeResult?.profileIdNotNull === 1
    && profileUpgradeResult?.membershipIdNotNull === 1
    && profileUpgradeResult?.summaryPrimaryKeyColumns === 2
    && profileUpgradeResult?.summaryDeviceCascades === 1
    && profileUpgradeResult?.membershipProfileCascades === 1
    && profileUpgradeResult?.membershipDeviceCascades === 1,
  `Schema v4 must not contract or reshape the v3 device/consent/session contract: ${JSON.stringify(profileUpgradeResult)}`);
  assert(profileUpgradeResult?.profileExpiryIndexes === 1
    && profileUpgradeResult?.membershipProfileIndexes === 1
    && profileUpgradeResult?.membershipDeviceUniqueIndexes === 1
    && profileUpgradeResult?.migrationScratchTables === 0,
  `Profile indexes or migration cleanup are incomplete: ${JSON.stringify(profileUpgradeResult)}`);

  const legacyV3WriteDevice = "d".repeat(64);
  const legacyV3WriteProfile = "1".repeat(64);
  const legacyV3WriteMembership = "2".repeat(64);
  const legacyV3Write = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--command", `
        INSERT INTO devices (device_key, created_at, last_seen_at, expires_at)
        VALUES ('${legacyV3WriteDevice}', '2026-08-10T00:00:00.000Z',
          '2026-08-11T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
        INSERT INTO consent_records (
          device_key, purpose, policy_version, granted, granted_at, revoked_at, updated_at
        ) VALUES (
          '${legacyV3WriteDevice}', 'cloud_summary', 'cloud-summary-v1', 1,
          '2026-08-10T00:00:00.000Z', NULL, '2026-08-11T00:00:00.000Z'
        ) ON CONFLICT(device_key, purpose) DO UPDATE SET updated_at = excluded.updated_at;
        INSERT INTO coaching_sessions (
          device_key, session_id, analysis_schema_version, client_created_at,
          received_at, updated_at, scenario, goal, target_duration_ms, duration_ms,
          speaking_ratio, pause_count, audio_confidence, transcript_metrics_used, summary_json
        ) VALUES (
          '${legacyV3WriteDevice}', 'legacy-v3-write', 2, '2026-08-10T00:00:00.000Z',
          '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', 'interview',
          'pauses', 45000, 44000, 0.7, 4, 'high', 0, '{}'
        ) ON CONFLICT(device_key, session_id) DO NOTHING;
        INSERT INTO sync_profiles (
          profile_id, created_at, last_seen_at, expires_at, sync_generation
        ) VALUES (
          '${legacyV3WriteProfile}', '2026-08-10T00:00:00.000Z',
          '2026-08-11T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 1
        );
        INSERT INTO sync_profile_devices (
          membership_id, profile_id, device_key, joined_at, last_seen_at
        ) VALUES (
          '${legacyV3WriteMembership}', '${legacyV3WriteProfile}', '${legacyV3WriteDevice}',
          '2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z'
        );
        DELETE FROM devices WHERE device_key = '${legacyV3WriteDevice}';
      `,
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (legacyV3Write.status !== 0) {
    throw new Error(`Schema v4 broke the schema-v3 SQL contract.\n${legacyV3Write.stdout}\n${legacyV3Write.stderr}`);
  }
  const legacyV3CascadeCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--command", `SELECT
        (SELECT COUNT(*) FROM devices WHERE device_key = '${legacyV3WriteDevice}') AS devices,
        (SELECT COUNT(*) FROM consent_records WHERE device_key = '${legacyV3WriteDevice}') AS consents,
        (SELECT COUNT(*) FROM coaching_sessions WHERE device_key = '${legacyV3WriteDevice}') AS summaries,
        (SELECT COUNT(*) FROM sync_profile_devices WHERE device_key = '${legacyV3WriteDevice}') AS memberships,
        (SELECT COUNT(*) FROM sync_profiles WHERE profile_id = '${legacyV3WriteProfile}') AS profiles`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (legacyV3CascadeCheck.status !== 0) {
    throw new Error(`Could not verify schema-v4 device cascades.\n${legacyV3CascadeCheck.stdout}\n${legacyV3CascadeCheck.stderr}`);
  }
  const legacyV3Cascade = JSON.parse(legacyV3CascadeCheck.stdout)[0]?.results?.[0];
  assert(legacyV3Cascade?.devices === 0
    && legacyV3Cascade?.consents === 0
    && legacyV3Cascade?.summaries === 0
    && legacyV3Cascade?.memberships === 0
    && legacyV3Cascade?.profiles === 1,
  `Device deletion must preserve v3 cascades and remove its membership only: ${JSON.stringify(legacyV3Cascade)}`);

  const profileCascade = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--command", `DELETE FROM sync_profiles WHERE profile_id = '${legacyV3WriteProfile}';`,
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (profileCascade.status !== 0) {
    throw new Error(`Could not clean the profile-cascade fixture.\n${profileCascade.stdout}\n${profileCascade.stderr}`);
  }

  const heartbeatUpgrade = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--file", path.join(root, "cloudflare", "migrations", "0005_cleanup_heartbeat.sql"),
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (heartbeatUpgrade.status !== 0) {
    throw new Error(`The v4-to-v5 cleanup-heartbeat migration failed.\n${heartbeatUpgrade.stdout}\n${heartbeatUpgrade.stderr}`);
  }
  const heartbeatUpgradeCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", upgradeStateDirectory,
      "--command", `SELECT
        schema_version AS schemaVersion,
        (SELECT COUNT(*) FROM platform_maintenance WHERE id = 1) AS heartbeatRows,
        (SELECT cleanup_backlog FROM platform_maintenance WHERE id = 1) AS cleanupBacklog,
        (SELECT cleanup_scheduled_at IS NOT NULL AND cleanup_completed_at IS NOT NULL
          FROM platform_maintenance WHERE id = 1) AS initialized,
        (SELECT COUNT(*) FROM pragma_table_info('platform_maintenance')) AS heartbeatColumns,
        (SELECT COUNT(*) FROM pragma_table_info('platform_maintenance')
          WHERE "notnull" = 1) AS heartbeatNotNullColumns,
        (SELECT COUNT(*) FROM devices) AS devices,
        (SELECT COUNT(*) FROM coaching_sessions) AS summaries,
        (SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table' AND name = '_migration_0005_schema_guard') AS migrationScratchTables
      FROM platform_meta WHERE id = 1`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (heartbeatUpgradeCheck.status !== 0) {
    throw new Error(`Could not verify the v4-to-v5 heartbeat migration.\n${heartbeatUpgradeCheck.stdout}\n${heartbeatUpgradeCheck.stderr}`);
  }
  const heartbeatUpgradeResult = JSON.parse(heartbeatUpgradeCheck.stdout)[0]?.results?.[0];
  assert(heartbeatUpgradeResult?.schemaVersion === 5
    && heartbeatUpgradeResult?.heartbeatRows === 1
    && heartbeatUpgradeResult?.cleanupBacklog === 0
    && heartbeatUpgradeResult?.initialized === 1
    && heartbeatUpgradeResult?.heartbeatColumns === 4
    && heartbeatUpgradeResult?.heartbeatNotNullColumns === 4
    && heartbeatUpgradeResult?.devices === 2
    && heartbeatUpgradeResult?.summaries === 251
    && heartbeatUpgradeResult?.migrationScratchTables === 0,
  `Schema v5 must add only one initialized cleanup heartbeat without changing user data: ${JSON.stringify(heartbeatUpgradeResult)}`);

  const migration = spawnSync(
    process.execPath,
    [wrangler, "d1", "migrations", "apply", "PLATFORM_DB", "--local", "--persist-to", stateDirectory],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (migration.status !== 0) {
    throw new Error(`Local D1 migration failed.\n${migration.stdout}\n${migration.stderr}`);
  }

  const initialHeartbeatCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", `SELECT
        meta.schema_version AS schemaVersion,
        maintenance.cleanup_scheduled_at AS cleanupScheduledAt,
        maintenance.cleanup_completed_at AS cleanupCompletedAt,
        maintenance.cleanup_backlog AS cleanupBacklog
      FROM platform_meta AS meta
      JOIN platform_maintenance AS maintenance ON maintenance.id = meta.id
      WHERE meta.id = 1`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (initialHeartbeatCheck.status !== 0) {
    throw new Error(`Could not verify the fresh cleanup heartbeat.\n${initialHeartbeatCheck.stdout}\n${initialHeartbeatCheck.stderr}`);
  }
  const initialHeartbeat = JSON.parse(initialHeartbeatCheck.stdout)[0]?.results?.[0];
  assert(initialHeartbeat?.schemaVersion === 5
    && typeof initialHeartbeat?.cleanupScheduledAt === "string"
    && typeof initialHeartbeat?.cleanupCompletedAt === "string"
    && initialHeartbeat?.cleanupBacklog === 0,
  `Fresh schema v5 must start inside its first-cron grace window: ${JSON.stringify(initialHeartbeat)}`);
  const malformedHeartbeat = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", `UPDATE platform_maintenance
        SET cleanup_scheduled_at = '${"z".repeat(24)}' WHERE id = 1;`,
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  assert(malformedHeartbeat.status !== 0,
    "Schema v5 must reject a non-canonical heartbeat timestamp before it can block monotonic repair");

  const expiredDevice = "f".repeat(64);
  const expiredProfile = "9".repeat(64);
  const expiredMembership = "8".repeat(64);
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
        INSERT INTO sync_profiles (
          profile_id, created_at, last_seen_at, expires_at, sync_generation
        ) VALUES (
          '${expiredProfile}', '2025-01-01T00:00:00.000Z',
          '2025-01-02T00:00:00.000Z', '2025-02-01T00:00:00.000Z', 1
        );
        INSERT INTO sync_profile_devices (
          membership_id, profile_id, device_key, joined_at, last_seen_at
        ) VALUES (
          '${expiredMembership}', '${expiredProfile}', '${expiredDevice}',
          '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z'
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
        WITH digits(value) AS (
          VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
        ), sequence(value) AS (
          SELECT ones.value
            + (10 * tens.value)
            + (100 * hundreds.value)
            + (1000 * thousands.value)
          FROM digits AS ones
          CROSS JOIN digits AS tens
          CROSS JOIN digits AS hundreds
          CROSS JOIN digits AS thousands
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
        FROM sequence WHERE value BETWEEN 1 AND 9999;
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

  // Exercise the compatibility Worker against the next schema marker without
  // introducing any schema-6 tables or columns. The exact fresh-head check
  // above must remain at 5 until migration 0006 exists.
  const compatibilityMarkerBump = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", "UPDATE platform_meta SET schema_version = 6 WHERE id = 1 AND schema_version = 5;",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (compatibilityMarkerBump.status !== 0) {
    throw new Error(`Could not advance the synthetic compatibility marker from 5 to 6.\n${compatibilityMarkerBump.stdout}\n${compatibilityMarkerBump.stderr}`);
  }
  const compatibilityMarkerCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", "SELECT schema_version AS schemaVersion FROM platform_meta WHERE id = 1;",
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (compatibilityMarkerCheck.status !== 0) {
    throw new Error(`Could not verify the synthetic schema-6 compatibility marker.\n${compatibilityMarkerCheck.stdout}\n${compatibilityMarkerCheck.stderr}`);
  }
  const compatibilityMarker = JSON.parse(compatibilityMarkerCheck.stdout)[0]?.results?.[0];
  assert(compatibilityMarker?.schemaVersion === 6,
    `Synthetic compatibility marker must advance exactly from schema 5 to 6: ${JSON.stringify(compatibilityMarker)}`);

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
  assert(degradedPayload.schemaVersion === 6,
    "The degraded compatibility Worker must report the synthetic schema-6 marker");
  assert(degradedPayload.degradedCapabilities?.includes("roomFacts"), "Status must report missing room-fact hashing");
  assert(degradedPayload.degradedCapabilities?.includes("adminAnalytics"), "Status must report missing admin analytics auth");
  await stopAndWait(auxiliaryChild);
  auxiliaryChild = undefined;

  port = await getFreePort();
  origin = `http://127.0.0.1:${port}`;
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
  assert(status.payload.schemaVersion === 6,
    "Platform status should report the synthetic schema-6 compatibility marker");
  assert(status.payload.capabilities?.retentionCleanup?.status === "ready",
    "Platform status should report a current, backlog-free retention cleanup heartbeat");
  assert(status.payload.capabilities?.cloudProgress?.newSaveLimit === 250, "Platform status should report the anonymous new-save cap");
  assert(status.payload.capabilities?.topicGeneration?.routine?.status === "offline",
    "Platform status should disclose the disabled-by-default routine provider without exposing a key");
  assert(status.payload.capabilities?.topicGeneration?.escalated?.externalAvailable === false,
    "Platform status should disclose that Gemma escalation is unavailable by default");
  assert(status.payload.capabilities?.aggregateAnalytics?.delivery === "best-effort", "Platform status must not overstate analytics delivery");

  const setLiveSchemaMarker = (from, to) => {
    const update = spawnSync(
      process.execPath,
      [
        wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
        "--command", `UPDATE platform_meta SET schema_version = ${to} WHERE id = 1 AND schema_version = ${from};`,
      ],
      { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
    );
    if (update.status !== 0) {
      throw new Error(`Could not change the live compatibility marker ${from}->${to}.\n${update.stdout}\n${update.stderr}`);
    }
  };

  // Keep the same Wrangler process and D1 binding alive across this transition
  // so a process-global readiness cache would be caught. Unsupported marker 7
  // must reject both reads and mutations before any schema-5 business SQL.
  setLiveSchemaMarker(6, 7);
  const unsupportedStatus = await request("/api/v1/platform/status");
  assert(unsupportedStatus.response.status === 503
    && unsupportedStatus.payload.error?.code === "DATABASE_UNAVAILABLE",
  `A running Worker must reject marker 7 immediately: ${JSON.stringify(unsupportedStatus.payload)}`);
  const blockedSaveID = "unsupported-schema-save";
  const blockedSave = await request("/api/v1/progress/sessions", {
    method: "POST",
    body: { session: completeSummary(blockedSaveID) },
  });
  assert(blockedSave.response.status === 503
    && blockedSave.payload.error?.code === "DATABASE_UNAVAILABLE",
  `Marker 7 must block progress writes: ${JSON.stringify(blockedSave.payload)}`);
  const blockedSaveCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", `SELECT COUNT(*) AS rows FROM coaching_sessions WHERE session_id = '${blockedSaveID}';`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (blockedSaveCheck.status !== 0) {
    throw new Error(`Could not verify the blocked marker-7 write.\n${blockedSaveCheck.stdout}\n${blockedSaveCheck.stderr}`);
  }
  const blockedRows = JSON.parse(blockedSaveCheck.stdout)[0]?.results?.[0]?.rows;
  assert(blockedRows === 0, `Marker 7 wrote a coaching row: ${JSON.stringify(blockedRows)}`);
  setLiveSchemaMarker(7, 6);
  const recoveredStatus = await request("/api/v1/platform/status");
  assert(recoveredStatus.response.ok && recoveredStatus.payload.schemaVersion === 6,
    `The same Worker must recover immediately after restoring marker 6: ${JSON.stringify(recoveredStatus.payload)}`);

  const concurrentToken = "c".repeat(64);
  const concurrentDeviceKey = createHash("sha256").update(concurrentToken).digest("hex");
  const saveConcurrentSummary = (id) => fetch(`${origin}/api/v1/progress/sessions`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: `nonstoptalk_token=${concurrentToken}`,
      Origin: origin,
    },
    body: JSON.stringify({ session: completeSummary(id) }),
  });
  const concurrentResponses = await Promise.all([
    saveConcurrentSummary("concurrent-first-touch-a"),
    saveConcurrentSummary("concurrent-first-touch-b"),
  ]);
  const concurrentPayloads = await Promise.all(concurrentResponses.map((response) => response.json()));
  assert(concurrentResponses.every((response) => response.status === 201),
    `Concurrent first-touch saves must both succeed: ${concurrentResponses.map((response) => response.status).join(", ")} ${JSON.stringify(concurrentPayloads)}`);
  assert(concurrentPayloads.every((payload) => payload.created === true),
    "Concurrent first-touch saves must create two distinct summaries");

  let concurrentAnalytics;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    concurrentAnalytics = await request("/api/v1/admin/analytics?days=1", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (concurrentAnalytics.payload.totals?.coaching_summary_saved?.events === 2) break;
    await delay(100);
  }
  assert(concurrentAnalytics?.payload.totals?.coaching_summary_saved?.events === 2,
    "Both concurrent saves must reach the best-effort D1 aggregate before the race fixture is inspected");

  const concurrentIdentityCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", `SELECT
        (SELECT COUNT(*) FROM devices WHERE device_key = '${concurrentDeviceKey}') AS devices,
        (SELECT COUNT(*) FROM sync_profile_devices WHERE device_key = '${concurrentDeviceKey}') AS memberships,
        (SELECT COUNT(DISTINCT profile_id) FROM sync_profile_devices
          WHERE device_key = '${concurrentDeviceKey}') AS profiles,
        (SELECT COUNT(*) FROM coaching_sessions
          WHERE device_key = '${concurrentDeviceKey}') AS summaries,
        (SELECT COUNT(*) FROM consent_records
          WHERE device_key = '${concurrentDeviceKey}' AND purpose = 'cloud_summary' AND granted = 1) AS consents,
        (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreignKeyViolations`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (concurrentIdentityCheck.status !== 0) {
    throw new Error(`Could not verify concurrent profile provisioning.\n${concurrentIdentityCheck.stdout}\n${concurrentIdentityCheck.stderr}`);
  }
  const concurrentIdentity = JSON.parse(concurrentIdentityCheck.stdout)[0]?.results?.[0];
  assert(concurrentIdentity?.devices === 1
    && concurrentIdentity?.memberships === 1
    && concurrentIdentity?.profiles === 1
    && concurrentIdentity?.summaries === 2
    && concurrentIdentity?.consents === 1
    && concurrentIdentity?.foreignKeyViolations === 0,
  `Concurrent first-touch provisioning must converge atomically: ${JSON.stringify(concurrentIdentity)}`);

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
    practiceLoopId: "smoke-loop-1",
    baselineAttemptId: "attempt-1",
    attemptRole: "baseline",
    feedbackMode: "review-only",
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
  assert(saved.payload.session?.practiceLoopId === "smoke-loop-1"
    && saved.payload.session?.baselineAttemptId === "attempt-1"
    && saved.payload.session?.attemptRole === "baseline"
    && saved.payload.session?.feedbackMode === "review-only",
  "The cloud save response must preserve explicit review-only loop relationships");

  const retried = await request("/api/v1/progress/sessions", {
    method: "POST",
    body: { session: validSummary },
  });
  assert(retried.response.status === 200, `Idempotent summary retry failed (${retried.response.status})`);
  assert(retried.payload.created === false, "Idempotent summary retry must not create a second record");

  const cookieSeparator = cookie.indexOf("=");
  assert(cookieSeparator > 0, "Cloud progress must establish an anonymous browser cookie");
  const browserToken = cookie.slice(cookieSeparator + 1);
  assert(browserToken.length > 0, "Cloud progress must establish an anonymous browser token");
  const browserDeviceKey = createHash("sha256").update(browserToken).digest("hex");
  const identityFoundationCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", `SELECT
        (SELECT COUNT(*) FROM sync_profile_devices
          WHERE device_key = '${quotaDevice}') AS quotaMemberships,
        (SELECT COUNT(*) FROM sync_profile_devices
          WHERE device_key = '${browserDeviceKey}') AS browserMemberships,
        (SELECT COUNT(DISTINCT profile_id) FROM sync_profile_devices
          WHERE device_key IN ('${quotaDevice}', '${browserDeviceKey}')) AS distinctProfiles,
        (SELECT COUNT(*) FROM sync_profile_devices AS membership
          JOIN sync_profiles AS profile ON profile.profile_id = membership.profile_id
          JOIN devices AS device ON device.device_key = membership.device_key
          WHERE membership.device_key IN ('${quotaDevice}', '${browserDeviceKey}')
            AND (profile.created_at <> device.created_at
              OR profile.last_seen_at <> device.last_seen_at
              OR profile.expires_at <> device.expires_at
              OR membership.joined_at <> device.created_at
              OR membership.last_seen_at <> device.last_seen_at
              OR profile.sync_generation <> 1)) AS leaseMismatches,
        (SELECT COUNT(*) FROM sync_profile_devices AS membership
          WHERE membership.device_key IN ('${quotaDevice}', '${browserDeviceKey}')
            AND (membership.profile_id = membership.membership_id
              OR membership.profile_id = membership.device_key
              OR membership.membership_id = membership.device_key)) AS reusedIdentifiers
      `,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (identityFoundationCheck.status !== 0) {
    throw new Error(`Could not verify runtime profile provisioning.\n${identityFoundationCheck.stdout}\n${identityFoundationCheck.stderr}`);
  }
  const identities = JSON.parse(identityFoundationCheck.stdout)[0]?.results?.[0];
  assert(identities?.quotaMemberships === 1
    && identities?.browserMemberships === 1
    && identities?.distinctProfiles === 2,
  `Existing and new devices must each self-heal to one independent profile: ${JSON.stringify(identities)}`);
  assert(identities?.leaseMismatches === 0 && identities?.reusedIdentifiers === 0,
    `Runtime-created profile metadata must match its device lease and use independent IDs: ${JSON.stringify(identities)}`);

  const listed = await request("/api/v1/progress/sessions");
  assert(listed.response.ok, `Summary list failed (${listed.response.status})`);
  assert(listed.payload.sessions?.length === 1, "Expected one cloud summary");
  const serialized = JSON.stringify(listed.payload);
  assert(!serialized.includes("capturedTranscript"), "Captured transcript fields must never be returned");
  assert(!serialized.includes("audioBytes"), "Local artifact metadata must never be persisted");
  assert(listed.payload.sessions[0]?.practiceLoopId === "smoke-loop-1"
    && listed.payload.sessions[0]?.baselineAttemptId === "attempt-1"
    && listed.payload.sessions[0]?.attemptRole === "baseline"
    && listed.payload.sessions[0]?.feedbackMode === "review-only",
  "Cloud list must round-trip the exact baseline relationship without synthesizing a pair");

  const relationshipCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", `SELECT practice_loop_id AS practiceLoopId,
        baseline_attempt_id AS baselineAttemptId, attempt_role AS attemptRole
        FROM coaching_sessions WHERE session_id = 'attempt-1'`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (relationshipCheck.status !== 0) {
    throw new Error(`Could not verify the practice relationship D1 columns.\n${relationshipCheck.stdout}\n${relationshipCheck.stderr}`);
  }
  const storedRelationship = JSON.parse(relationshipCheck.stdout)[0]?.results?.[0];
  assert(storedRelationship?.practiceLoopId === "smoke-loop-1"
    && storedRelationship?.baselineAttemptId === "attempt-1"
    && storedRelationship?.attemptRole === "baseline",
  `Reserved D1 relationship columns were not populated: ${JSON.stringify(storedRelationship)}`);

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
    if (analytics.payload.totals?.coaching_summary_saved?.events === 3 && analytics.payload.totals?.room_created?.events === 1) break;
    await delay(100);
  }
  assert(analytics.response.ok, `Admin analytics failed (${analytics.response.status})`);
  assert(analytics.payload.totals.coaching_summary_saved.events === 3, "Summary sync aggregates were not recorded");
  assert(analytics.payload.totals.cloud_consent_granted.events === 2, "Consent grant transitions were not recorded once per device");
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
  const identityAfterDeleteCheck = spawnSync(
    process.execPath,
    [
      wrangler, "d1", "execute", "PLATFORM_DB", "--local", "--persist-to", stateDirectory,
      "--command", `SELECT
        (SELECT COUNT(*) FROM devices WHERE device_key = '${browserDeviceKey}') AS devices,
        (SELECT COUNT(*) FROM sync_profile_devices
          WHERE device_key = '${browserDeviceKey}') AS memberships,
        (SELECT COUNT(*) FROM sync_profiles AS profile
          JOIN sync_profile_devices AS membership ON membership.profile_id = profile.profile_id
          WHERE membership.device_key = '${browserDeviceKey}') AS profiles,
        (SELECT COUNT(*) FROM coaching_sessions
          WHERE device_key = '${browserDeviceKey}') AS summaries,
        (SELECT COUNT(*) FROM consent_records
          WHERE device_key = '${browserDeviceKey}' AND purpose = 'cloud_summary'
            AND granted = 0 AND revoked_at IS NOT NULL) AS revokedConsents`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (identityAfterDeleteCheck.status !== 0) {
    throw new Error(`Could not verify identity preservation after progress deletion.\n${identityAfterDeleteCheck.stdout}\n${identityAfterDeleteCheck.stderr}`);
  }
  const identityAfterDelete = JSON.parse(identityAfterDeleteCheck.stdout)[0]?.results?.[0];
  assert(identityAfterDelete?.devices === 1
    && identityAfterDelete?.memberships === 1
    && identityAfterDelete?.profiles === 1
    && identityAfterDelete?.summaries === 0
    && identityAfterDelete?.revokedConsents === 1,
  `Deleting progress must retain the active anonymous identity foundation: ${JSON.stringify(identityAfterDelete)}`);
  let finalAnalytics;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    finalAnalytics = await request("/api/v1/admin/analytics?days=1", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (finalAnalytics.payload.totals?.coaching_summary_deleted?.events === 1
      && finalAnalytics.payload.totals?.cloud_consent_revoked?.events === 1) break;
    await delay(100);
  }
  assert(finalAnalytics?.response.ok, `Final admin analytics failed (${finalAnalytics?.response.status ?? "no response"})`);
  assert(finalAnalytics.payload.totals.coaching_summary_deleted.events === 1, "Real delete operation was not recorded once");
  assert(finalAnalytics.payload.totals.coaching_summary_deleted.value === 1, "Deleted-summary aggregate has the wrong value");
  assert(finalAnalytics.payload.totals.cloud_consent_revoked.events === 1, "Consent revocation transition was not recorded once");

  const scheduledTime = Date.now();
  const scheduled = await fetch(
    `${origin}/cdn-cgi/handler/scheduled?format=json&time=${scheduledTime}`,
  );
  assert(scheduled.ok, `Scheduled cleanup trigger failed (${scheduled.status})`);
  const scheduledOutcome = await scheduled.json();
  assert(scheduledOutcome.outcome === "ok",
    `Scheduled cleanup did not settle successfully: ${JSON.stringify(scheduledOutcome)}`);
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
        (SELECT COUNT(*) FROM sync_profile_devices
          WHERE membership_id = '${expiredMembership}') AS memberships,
        (SELECT COUNT(*) FROM sync_profiles
          WHERE profile_id = '${expiredProfile}') AS profiles,
        (SELECT COUNT(*) FROM room_facts WHERE expires_at <= '2025-02-01T00:00:00.000Z') AS rooms,
        (SELECT cleanup_scheduled_at FROM platform_maintenance WHERE id = 1) AS cleanupScheduledAt,
        (SELECT cleanup_completed_at FROM platform_maintenance WHERE id = 1) AS cleanupCompletedAt,
        (SELECT cleanup_backlog FROM platform_maintenance WHERE id = 1) AS cleanupBacklog`,
      "--json",
    ],
    { cwd: root, env: offlineWranglerEnv({ CI: "1", NO_COLOR: "1" }), encoding: "utf8" },
  );
  if (cleanupCheck.status !== 0) {
    throw new Error(`Could not verify scheduled D1 cleanup.\n${cleanupCheck.stdout}\n${cleanupCheck.stderr}`);
  }
  const cleanupPayload = JSON.parse(cleanupCheck.stdout);
  const cleaned = cleanupPayload[0]?.results?.[0];
  assert(cleaned?.devices === 0
    && cleaned?.consents === 0
    && cleaned?.summaries === 0
    && cleaned?.memberships === 0
    && cleaned?.profiles === 0
    && cleaned?.rooms === 0
    && cleaned?.cleanupBacklog === 0
    && typeof cleaned?.cleanupScheduledAt === "string"
    && typeof cleaned?.cleanupCompletedAt === "string"
    && cleaned.cleanupScheduledAt === new Date(scheduledTime).toISOString()
    && cleaned.cleanupCompletedAt !== initialHeartbeat.cleanupCompletedAt,
    `Scheduled cleanup left expired rows behind: ${JSON.stringify(cleaned)}`);

  console.log("Cloud platform D1/API privacy, profile-foundation, cleanup-heartbeat, and retention smoke test passed.");
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
