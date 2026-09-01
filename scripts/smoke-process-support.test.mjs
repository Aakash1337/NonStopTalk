import assert from "node:assert/strict";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  getFreePort,
  isAddressInUse,
  isolatedChildEnv,
  runChecked,
  startCaptured,
  terminateProcessTree,
} from "./smoke-process-support.mjs";

test("isolated child environments cannot inherit deployment or provider credentials", () => {
  const secretNames = [
    "ANALYTICS_ADMIN_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLOUDFLARE_ACCESS_CLIENT_ID",
    "CLOUDFLARE_ACCESS_CLIENT_SECRET",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_USER_SERVICE_KEY",
    "CLOUDFLARE_API_TOKEN",
    "GEMINI_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "IDENTITY_HASH_KEY",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "ROOM_FACT_HASH_KEY",
    "WRANGLER_CF_AUTHORIZATION_TOKEN",
    "ZAI_API_KEY",
    "wRaNgLeR_Cf_AuThOrIzAtIoN_ToKeN",
  ];
  const env = isolatedChildEnv({
    ...Object.fromEntries(secretNames.map((name) => [name, "must-not-survive"])),
    SAFE_SMOKE_VALUE: "kept",
    WRANGLER_SEND_METRICS: "true",
    wRaNgLeR_sEnD_eRrOr_RePoRtS: "true",
  });
  for (const name of secretNames) assert.equal(env[name], undefined, `${name} must be removed`);
  assert.equal(env.SAFE_SMOKE_VALUE, "kept");
  assert.equal(env.CI, "1");
  assert.equal(env.CLOUDFLARE_INCLUDE_PROCESS_ENV, "false");
  assert.equal(env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
  assert.equal(env.WRANGLER_SEND_METRICS, "false");
  assert.equal(env.wRaNgLeR_sEnD_eRrOr_RePoRtS, undefined);
  assert.equal(env.WRANGLER_SEND_ERROR_REPORTS, "false");
});

test("captured commands are bounded, checked, and terminated on timeout", {
  skip: process.platform === "win32",
}, async () => {
  const output = await runChecked(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(4096) + "TAIL")'],
    { label: "bounded output fixture", logLimit: 512, timeoutMs: 5_000 },
  );
  assert.ok(output.length <= 512);
  assert.ok(output.endsWith("TAIL"));

  await assert.rejects(
    runChecked(
      process.execPath,
      ["-e", 'process.stderr.write("safe failure"); process.exit(7)'],
      { label: "failure fixture", timeoutMs: 5_000 },
    ),
    /failure fixture failed with exit 7.*safe failure/su,
  );

  const startedAt = Date.now();
  await assert.rejects(
    runChecked(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { label: "timeout fixture", timeoutMs: 50 },
    ),
    /timeout fixture exceeded its 50ms deadline/u,
  );
  assert.ok(Date.now() - startedAt < 3_000, "Timed-out children must be reaped promptly.");

  const controller = new AbortController();
  const aborted = runChecked(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    { label: "abort fixture", timeoutMs: 5_000, signal: controller.signal },
  );
  controller.abort(new Error("abort fixture was cancelled"));
  await assert.rejects(aborted, /abort fixture was cancelled/u);
});

test("POSIX cleanup reaps a SIGTERM-resistant descendant after its leader exits", {
  skip: process.platform === "win32",
}, async () => {
  const descendant = [
    'process.on("SIGTERM", () => {});',
    'process.stdout.write("CHILD_READY\\n");',
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const leader = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}],`,
    '  { stdio: ["ignore", "pipe", "ignore"] });',
    'child.stdout.once("data", () => process.stdout.write("READY\\n"));',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const started = startCaptured(process.execPath, ["-e", leader], {
    env: isolatedChildEnv(),
  });
  let cleaned = false;
  try {
    const deadline = Date.now() + 5_000;
    while (!started.output().includes("READY") && Date.now() < deadline) await delay(25);
    assert.match(started.output(), /\bREADY\b/u, "The resistant descendant fixture did not become ready.");
    await terminateProcessTree(started.child, 500);
    cleaned = true;
    assert.ok(started.child.exitCode !== null || started.child.signalCode !== null,
      "The process-group leader must settle during cleanup.");
  } finally {
    if (!cleaned) {
      try {
        process.kill(-started.child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      await terminateProcessTree(started.child, 1_000).catch(() => undefined);
    }
  }
});

test("port allocation and collision classification are explicit", async () => {
  const port = await getFreePort();
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535);
  assert.equal(isAddressInUse("listen EADDRINUSE: address already in use"), true);
  assert.equal(isAddressInUse("unrelated startup failure"), false);
});
