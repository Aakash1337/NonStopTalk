import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseJsonc } from "./drill-staging-outbox-rollback.mjs";
import { LOCAL_BEST_EFFORT_DELIVERY_WRANGLER_ARGS } from "./smoke-local-worker-policy.mjs";
import { isolatedChildEnv } from "./smoke-process-support.mjs";
import { DEFAULT_EXPECTED_ANALYTICS_DELIVERY } from "./smoke-production-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

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

test("both deployments share the reviewed static-asset test exclusion", async () => {
  const config = parseJsonc(await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  assert.equal(config.assets?.directory, "./cloudflare/public");
  assert.equal(config.env?.staging?.assets?.directory, "./cloudflare/public");

  const publicDirectory = path.join(root, "cloudflare", "public");
  assert.equal(
    await readFile(path.join(publicDirectory, ".assetsignore"), "utf8"),
    "*.test.js\n*.test.mjs\n",
    "The only ignored scripts must be recursively named JavaScript test modules.",
  );
  const entries = await readdir(publicDirectory, { withFileTypes: true });
  assert.ok(entries.some(
    (entry) => entry.isFile() && /\.test\.(?:js|mjs)$/iu.test(entry.name),
  ),
    "The exclusion contract must protect a non-empty checked-in test set.");
});

test("pinned Wrangler production dry-run explicitly ignores the case-variant setup test", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.devDependencies?.wrangler, "4.128.0");

  // Invoke the real CLI process directly so the timeout cannot leave the bin
  // wrapper's child running, and keep deployment/provider credentials out of
  // this packaging-only proof.
  const wranglerCli = path.join(root, "node_modules", "wrangler", "wrangler-dist", "cli.js");
  await readFile(wranglerCli);
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [wranglerCli, "deploy", "--dry-run", "--strict", "--env="],
    {
      cwd: root,
      env: isolatedChildEnv({ WRANGLER_LOG: "debug" }),
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    },
  );
  const output = `${stdout}\n${stderr}`;
  assert.match(
    output,
    /Ignoring asset:\s+setup-kits\.TEST\.mjs(?:\s|$)/u,
    "Wrangler's real production asset traversal must ignore the uppercase TEST marker.",
  );
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
