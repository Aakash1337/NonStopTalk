import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseJsonc } from "./drill-staging-outbox-rollback.mjs";
import { LOCAL_BEST_EFFORT_DELIVERY_WRANGLER_ARGS } from "./smoke-local-worker-policy.mjs";
import { DEFAULT_EXPECTED_ANALYTICS_DELIVERY } from "./smoke-production-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production and staging deploy only after their matching D1 migration", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts?.deploy,
    "npm run db:migrate:remote && wrangler deploy --strict --env= && npm run smoke:production",
    "Production must migrate, then deploy, then run its read-only probe.",
  );
  assert.equal(
    packageJson.scripts?.["deploy:staging"],
    "npm run db:migrate:staging && wrangler deploy --strict --env staging && npm run smoke:staging",
    "Staging must migrate, then deploy, then run its read-only and mutating probes.",
  );
});

test("production config, default probe, and scheduled monitor activate one exact outbox policy", async () => {
  const config = parseJsonc(await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "production-health.yml"),
    "utf8",
  );
  const monitoredPolicies = Object.fromEntries([...workflow.matchAll(
    /^          - environment: (production|staging)\n            origin: https:\/\/[^\s]+\n            expected_delivery: ([a-z-]+)$/gmu,
  )].map((match) => [match[1], match[2]]));

  assert.equal(config.vars?.ROOM_MILESTONE_DELIVERY_MODE, "outbox",
    "Production must explicitly enable the reviewed durable room outbox.");
  assert.equal(config.env?.staging?.vars?.ROOM_MILESTONE_DELIVERY_MODE, "outbox",
    "Staging must retain the reviewed durable room outbox.");
  assert.equal(DEFAULT_EXPECTED_ANALYTICS_DELIVERY, "durable-outbox",
    "The no-argument production probe must expect the deployed outbox capability label.");
  assert.deepEqual(monitoredPolicies, {
    production: "durable-outbox",
    staging: "durable-outbox",
  }, "The scheduled monitor must probe both deployed environments as durable outbox.");
});

test("local Wrangler smoke Workers explicitly retain reviewed best-effort delivery", async () => {
  assert.deepEqual([...LOCAL_BEST_EFFORT_DELIVERY_WRANGLER_ARGS], [
    "--var",
    "ROOM_MILESTONE_DELIVERY_MODE:best-effort",
  ]);

  const platformSource = await readFile(path.join(root, "scripts", "smoke-platform.mjs"), "utf8");
  assert.match(platformSource,
    /const localWorkerPolicyWranglerArgs = \[\s*\.\.\.LOCAL_BEST_EFFORT_DELIVERY_WRANGLER_ARGS,/u);
  assert.equal([...platformSource.matchAll(/\bwrangler,\s*"dev"/gu)].length, 3,
    "The platform smoke launch count changed; review every local Worker policy boundary.");
  assert.equal([...platformSource.matchAll(/\.\.\.localWorkerPolicyWranglerArgs/gu)].length, 3,
    "Every platform smoke Worker must use the explicit best-effort policy bundle.");

  for (const filename of [
    "smoke-cloudflare-multiplayer.mjs",
    "smoke-accessibility.mjs",
    "smoke-admin.mjs",
    "smoke-coach-storage.mjs",
  ]) {
    const source = await readFile(path.join(root, "scripts", filename), "utf8");
    assert.equal([...source.matchAll(/\bwrangler,\s*"dev"/gu)].length, 1,
      `${filename} local Worker launch count changed; review its delivery policy.`);
    assert.equal(
      [...source.matchAll(/\.\.\.LOCAL_BEST_EFFORT_DELIVERY_WRANGLER_ARGS/gu)].length,
      1,
      `${filename} must pass the exact local best-effort policy bundle.`,
    );
  }
});
