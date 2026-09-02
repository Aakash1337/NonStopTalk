import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PUBLIC_EXCLUDED_JAVASCRIPT_ASSET_MAX_COUNT,
  readPublicJavaScriptAssets,
} from "./public-javascript-assets.mjs";
import {
  PUBLIC_EXCLUDED_JAVASCRIPT_ATTEMPTS,
  PUBLIC_EXCLUDED_JAVASCRIPT_MAX_CONCURRENCY,
  PUBLIC_EXCLUDED_JAVASCRIPT_RETRY_MS,
  PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES,
  PUBLIC_JAVASCRIPT_ASSET_MAX_CONCURRENCY,
  PUBLIC_MODULE_GRAPH_ATTEMPTS,
  PUBLIC_MODULE_GRAPH_RETRY_MS,
  PRODUCTION_SMOKE_BUDGET_MS,
  assertExcludedJavaScriptResponse,
  readBoundedJavaScriptBody,
  readVerifiedJavaScriptResponse,
  waitForExcludedJavaScriptAssets,
  waitForExactPublicModuleGraph,
  waitForPublicModuleGraph,
} from "./smoke-production-support.mjs";
import {
  DEFAULT_EXPECTED_ANALYTICS_DELIVERY,
  OBSERVED_ANALYTICS_DELIVERY_LABEL_LIMIT,
  assertExpectedAnalyticsDelivery,
  formatObservedAnalyticsDelivery,
  resolveExpectedAnalyticsDelivery,
} from "./smoke-production-policy.mjs";

const workflowURL = new URL("../.github/workflows/production-health.yml", import.meta.url);
const workflow = await readFile(workflowURL, "utf8");
const packageJSON = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const productionProbe = await readFile(new URL("./smoke-production.mjs", import.meta.url), "utf8");
const productionProbeSupport = await readFile(
  new URL("./smoke-production-support.mjs", import.meta.url),
  "utf8",
);
const productionAssetDiscovery = await readFile(
  new URL("./public-javascript-assets.mjs", import.meta.url),
  "utf8",
);
const productionProbePolicy = await readFile(
  new URL("./smoke-production-policy.mjs", import.meta.url),
  "utf8",
);
const stagingProbe = await readFile(new URL("./smoke-staging.mjs", import.meta.url), "utf8");

const VALID_APP_MODULE_GRAPH = [
  "import * as coachingStorage from './coach-storage.js';",
  "import { createSetupKitStore } from './setup-kits.js';",
  "import { createMicrophoneSelection } from './microphone-selection.js';",
  "const setupKitStore = createSetupKitStore();",
  "const microphoneSelection = createMicrophoneSelection({ getStorage: () => null });",
  "let coachEnginePromise = null;",
  "let coachingRun = null;",
  "function loadCoachEngine() {",
  "  coachEnginePromise ||= import('./coach-engine.js');",
  "  return coachEnginePromise;",
  "}",
  "async function beginCoachingSession() {",
  "  const engine = await loadCoachEngine();",
  "  let run;",
  "  run = coachingRun = { engine };",
  "  run.calibrationReadiness = run.engine.assessCalibrationReadiness({});",
  "}",
].join("\n");
const VALID_COACH_STORAGE_MODULE = "export async function openCoachDatabase() {}";
const VALID_COACH_ENGINE_MODULE = "export function assessCalibrationReadiness() {}";
const VALID_SETUP_KITS_MODULE = "export function createSetupKitStore() {}";
const VALID_MICROPHONE_SELECTION_MODULE = "export function createMicrophoneSelection() {}";
const checkedOutJavaScriptAssets = await readPublicJavaScriptAssets();

function validPublicModuleSource(pathname) {
  if (pathname === "/app.js") return VALID_APP_MODULE_GRAPH;
  if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
  if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
  if (pathname === "/setup-kits.js") return VALID_SETUP_KITS_MODULE;
  if (pathname === "/microphone-selection.js") return VALID_MICROPHONE_SELECTION_MODULE;
  assert.fail(`unexpected public module path: ${pathname}`);
}

test("production health workflow stays scheduled, bounded, and manually runnable", () => {
  assert.match(workflow, /^  schedule:\n    - cron: "17,47 \* \* \* \*"$/mu);
  assert.match(workflow, /^  workflow_dispatch:$/mu);
  assert.match(workflow, /^  workflow_dispatch:\n\nconcurrency:$/mu);
  assert.doesNotMatch(workflow, /^\s+inputs\s*:/mu);
  assert.doesNotMatch(workflow, /\bcontinue-on-error\s*:/iu);
  assert.match(workflow, /^  group: production-health$/mu);
  assert.match(workflow, /^  cancel-in-progress: true$/mu);
  assert.match(workflow, /^    timeout-minutes: 5$/mu);
  const workflowTimeoutMs = 5 * 60_000;
  assert.equal(PRODUCTION_SMOKE_BUDGET_MS, 180_000);
  assert.ok(PRODUCTION_SMOKE_BUDGET_MS <= workflowTimeoutMs - 120_000,
    "the overall probe budget must leave at least two minutes of workflow headroom");
});

test("production health workflow has read-only repository access and no credentials", () => {
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.doesNotMatch(workflow, /^    permissions\s*:/mu,
    "jobs must not override the workflow's read-only permission boundary");
  assert.match(workflow, /^          persist-credentials: false$/mu);
  assert.doesNotMatch(workflow, /\b(?:secrets|token|password)\b/iu);
});

test("production health workflow runs only the existing read-only probe", () => {
  const jobsBlock = workflow.split(/^jobs:\s*$/mu)[1] || "";
  const jobNames = [...jobsBlock.matchAll(/^  ([a-z0-9_-]+):\s*$/gmu)]
    .map((match) => match[1]);
  const runCommands = [...workflow.matchAll(/^\s+run:\s*(.+)$/gmu)]
    .map((match) => match[1].trim());

  assert.deepEqual(jobNames, ["probe"], "the monitor must contain only its bounded probe job");
  assert.deepEqual(runCommands, ["npm run smoke:production"]);
  assert.equal(packageJSON.scripts["smoke:production"], "node scripts/smoke-production.mjs");
  assert.match(workflow,
    /^          NONSTOPTALK_PRODUCTION_ORIGIN: \$\{\{ matrix\.origin \}\}$/mu);
  assert.match(workflow,
    /^          NONSTOPTALK_EXPECTED_ANALYTICS_DELIVERY: \$\{\{ matrix\.expected_delivery \}\}$/mu);
  assert.doesNotMatch(workflow, /\bnpm\s+(?:ci|install|clean-install)\b/iu);
  assert.doesNotMatch(workflow, /\bwrangler\b|\b(?:deploy|migrate|rollback)\b/iu);
  for (const source of [
    productionProbe,
    productionProbeSupport,
    productionProbePolicy,
    productionAssetDiscovery,
  ]) {
    assert.doesNotMatch(source, /\b(?:POST|PUT|PATCH|DELETE)\b/iu);
    assert.doesNotMatch(source, /\bmethod\s*:/iu);
    assert.doesNotMatch(source, /\bAuthorization\b|ANALYTICS_ADMIN_TOKEN/u);
  }
});

test("production health workflow probes exactly the reviewed delivery policies", () => {
  const strategyBlock = workflow.match(/^    strategy:\n([\s\S]*?)^    steps:$/mu)?.[1];
  assert.equal(strategyBlock,
    "      fail-fast: false\n"
      + "      matrix:\n"
      + "        include:\n"
      + "          - environment: production\n"
      + "            origin: https://dontstoptalking.org\n"
      + "            expected_delivery: durable-outbox\n"
      + "          - environment: staging\n"
      + "            origin: https://nonstoptalk-staging.aakashplays656.workers.dev\n"
      + "            expected_delivery: durable-outbox\n",
    "the bounded two-row matrix must not gain another axis, entry, or key",
  );
  const entries = [...workflow.matchAll(
    /^          - environment: ([a-z]+)\n            origin: (https:\/\/[^\s]+)\n            expected_delivery: ([a-z-]+)$/gmu,
  )].map((match) => ({
    environment: match[1],
    origin: match[2],
    expectedDelivery: match[3],
  }));

  assert.deepEqual(entries, [
    {
      environment: "production",
      origin: "https://dontstoptalking.org",
      expectedDelivery: "durable-outbox",
    },
    {
      environment: "staging",
      origin: "https://nonstoptalk-staging.aakashplays656.workers.dev",
      expectedDelivery: "durable-outbox",
    },
  ]);
  assert.match(workflow, /^      fail-fast: false$/mu);
});

test("production probe defaults and accepts only reviewed analytics delivery policies", () => {
  assert.equal(DEFAULT_EXPECTED_ANALYTICS_DELIVERY, "durable-outbox");
  assert.equal(resolveExpectedAnalyticsDelivery(undefined, undefined), "durable-outbox");
  for (const value of ["best-effort", "durable-outbox"]) {
    assert.equal(resolveExpectedAnalyticsDelivery(value, undefined), value);
    assert.equal(resolveExpectedAnalyticsDelivery(undefined, value), value);
  }

  assert.equal(
    resolveExpectedAnalyticsDelivery("best-effort", "durable-outbox"),
    "best-effort",
    "the explicit command-line policy must override the environment",
  );
  assert.equal(
    resolveExpectedAnalyticsDelivery("best-effort", "not-reviewed"),
    "best-effort",
    "a valid command-line policy must fully replace an ambient environment value",
  );
  assert.throws(
    () => resolveExpectedAnalyticsDelivery("", "durable-outbox"),
    /expected analytics delivery policy .*must be exactly/iu,
    "an explicitly empty CLI value must not fall through to a valid environment value",
  );

  for (const value of [
    null,
    "",
    "outbox",
    "degraded-outbox",
    "BEST-EFFORT",
    " best-effort ",
    "durable-outbox\n",
    1,
    {},
  ]) {
    assert.throws(
      () => resolveExpectedAnalyticsDelivery(value, undefined),
      /expected analytics delivery policy .*must be exactly/iu,
    );
    assert.throws(
      () => resolveExpectedAnalyticsDelivery(undefined, value),
      /expected analytics delivery policy .*must be exactly/iu,
    );
  }
});

test("production probe checks and reports the observed analytics delivery policy", () => {
  assert.match(productionProbe,
    /process\.env\.NONSTOPTALK_EXPECTED_ANALYTICS_DELIVERY/u);
  assert.match(productionProbe,
    /resolveExpectedAnalyticsDelivery\(\s*process\.argv\[3\],\s*process\.env\.NONSTOPTALK_EXPECTED_ANALYTICS_DELIVERY,/u);
  assert.match(productionProbe,
    /assertExpectedAnalyticsDelivery\(\s*status\.capabilities\.aggregateAnalytics\.delivery,\s*expectedAnalyticsDelivery,/u);
  assert.match(productionProbe,
    /analyticsDelivery: observedAnalyticsDelivery/u);
  assert.match(packageJSON.scripts["smoke:staging"],
    /^node scripts\/smoke-production\.mjs https:\/\/nonstoptalk-staging\.aakashplays656\.workers\.dev durable-outbox && /u);
});

test("delivery-policy equality rejects mismatches and returns only a verified observation", () => {
  for (const value of ["best-effort", "durable-outbox"]) {
    assert.equal(assertExpectedAnalyticsDelivery(value, value), value);
  }
  assert.throws(
    () => assertExpectedAnalyticsDelivery("best-effort", "durable-outbox"),
    /expected "durable-outbox", observed "best-effort"/u,
  );
  assert.throws(
    () => assertExpectedAnalyticsDelivery("x".repeat(100_000), "best-effort"),
    new RegExp(`observed "${"x".repeat(OBSERVED_ANALYTICS_DELIVERY_LABEL_LIMIT)}…"$`, "u"),
  );
  assert.throws(
    () => assertExpectedAnalyticsDelivery("best-effort", "degraded-outbox"),
    /expectedValue must be a reviewed analytics delivery policy/u,
  );
});

test("delivery-policy diagnostics stay bounded and do not reflect non-string values", () => {
  assert.equal(formatObservedAnalyticsDelivery(undefined), "<missing or non-string>");
  assert.equal(formatObservedAnalyticsDelivery({ delivery: "secret-like" }),
    "<missing or non-string>");
  assert.equal(formatObservedAnalyticsDelivery("best-effort"), '"best-effort"');

  const longValue = "x".repeat(OBSERVED_ANALYTICS_DELIVERY_LABEL_LIMIT + 100_000);
  const formatted = formatObservedAnalyticsDelivery(longValue);
  assert.equal(formatted, `"${"x".repeat(OBSERVED_ANALYTICS_DELIVERY_LABEL_LIMIT)}…"`);
  assert.ok(formatted.length <= OBSERVED_ANALYTICS_DELIVERY_LABEL_LIMIT + 3);
  const controlCharacters = `"\\\n\r\t${"\u0000".repeat(100_000)}`;
  const sanitized = formatObservedAnalyticsDelivery(controlCharacters);
  assert.doesNotMatch(sanitized.slice(1, -1), /[\u0000-\u001f"\\]/u);
  assert.ok(sanitized.length <= OBSERVED_ANALYTICS_DELIVERY_LABEL_LIMIT + 3);
  assert.doesNotMatch(productionProbePolicy, /process\.env|console\.|fetch\(/u);
});

test("production health workflow pins its two third-party actions", () => {
  const uses = [...workflow.matchAll(/^\s+- uses:\s*(.+)$/gmu)]
    .map((match) => match[1].split(/\s+#/u)[0]);

  assert.deepEqual(uses, [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  ]);
});

test("production and staging probes accept only the reviewed schema window", () => {
  for (const probe of [productionProbe, stagingProbe]) {
    assert.match(probe,
      /^const SUPPORTED_PLATFORM_SCHEMA_VERSIONS = new Set\(\[5, 6\]\);$/mu);
  }
  assert.match(productionProbe,
    /assert\(SUPPORTED_PLATFORM_SCHEMA_VERSIONS\.has\(status\.schemaVersion\),/u);
  assert.match(stagingProbe,
    /assert\.ok\(SUPPORTED_PLATFORM_SCHEMA_VERSIONS\.has\(status\.payload\.schemaVersion\),/u);
});

test("production probe bounds only deployment-propagation status retries", () => {
  assert.match(productionProbe, /^const PLATFORM_STATUS_ATTEMPTS = 5;$/mu);
  assert.match(productionProbe, /^const PLATFORM_STATUS_RETRY_MS = 1_000;$/mu);
  assert.match(
    productionProbe,
    /const isCompatibilityPropagation = status\.schemaVersion === 5\s*&& status\.capabilities\?\.retentionCleanup === undefined;/u,
  );
  assert.match(productionProbe, /if \(!isCompatibilityPropagation\) \{\s*return \{ response, status \};/u);
  assert.doesNotMatch(
    productionProbe,
    /status\.capabilities\?\.retentionCleanup\?\.status\s*!==\s*"ready"/u,
    "a real stale or backlog status must not be retried as deployment propagation",
  );
});

test("production probe verifies every deployed JavaScript asset and the required module graph", () => {
  assert.match(
    productionProbe,
    /await waitForExactPublicModuleGraph\(\{\s*loadJavaScriptAsset: getJavaScriptAsset,\s*expectedJavaScriptAssets,\s*deadlineMs: probeDeadlineMs,\s*now: \(\) => performance\.now\(\),/u,
  );
  assert.match(productionProbe, /readPublicJavaScriptAssetInventory\(\)/u);
  assert.match(productionAssetDiscovery, /collectJavaScriptFiles\(/u);
  assert.match(productionAssetDiscovery,
    /segments\.some\(\(segment\) => JAVASCRIPT_TEST_NAME\.test\(segment\)\)/u);
  assert.match(productionAssetDiscovery,
    /\.assetsignore must contain exactly \$\{REQUIRED_ASSETS_IGNORE_RULE\}/u);
  for (const pathname of [
    "/app.js",
    "/coach-storage.js",
    "/coach-engine.js",
    "/setup-kits.js",
    "/microphone-selection.js",
  ]) {
    assert.match(productionProbeSupport, new RegExp(JSON.stringify(pathname).replace(".", "\\."), "u"));
  }
  assert.match(productionProbeSupport, /await runSettledPathSweep\(\{/u);
  assert.match(productionProbeSupport,
    /failures\.find\(\(failure\) => failure !== undefined\)/u);
  assert.equal(PUBLIC_JAVASCRIPT_ASSET_MAX_CONCURRENCY, 8);
  assert.match(productionProbe,
    /get\(pathname, "text\/javascript", 1, remainingAssetMs\)/u);
  assert.match(productionProbeSupport, /mediaType !== "text\/javascript"/u);
  assert.match(productionProbeSupport, /\^\\s\*\(\?:<!doctype\\s\+html\|<html\\b\)\/iu\.test\(source\)/u);
  assert.match(productionProbeSupport, /hasNamespaceModuleImport\(\s*appTokens,\s*"\.\/coach-storage\.js",\s*"coachingStorage",/u);
  assert.match(productionProbeSupport, /hasDynamicModuleLoader\(\s*appTokens,\s*"loadCoachEngine",\s*"coachEnginePromise",\s*"\.\/coach-engine\.js",/u);
  assert.match(productionProbeSupport, /hasAwaitedFactoryAssignment\(appTokens, "engine", "loadCoachEngine"\)/u);
  assert.match(productionProbeSupport, /hasAssignedObjectShorthand\(appTokens, \["run", "coachingRun"\], "engine"\)/u);
  assert.match(productionProbeSupport, /hasMemberCall\(appTokens, "assessCalibrationReadiness"\)/u);
  assert.match(productionProbeSupport, /hasNamedModuleImport\(\s*appTokens,\s*"\.\/setup-kits\.js",\s*"createSetupKitStore",/u);
  assert.match(productionProbeSupport, /hasAssignedFactoryCall\(appTokens, "setupKitStore", "createSetupKitStore"\)/u);
  assert.match(productionProbeSupport, /hasNamedModuleImport\(\s*appTokens,\s*"\.\/microphone-selection\.js",\s*"createMicrophoneSelection",/u);
  assert.match(productionProbeSupport, /hasAssignedFactoryCall\(\s*appTokens,\s*"microphoneSelection",\s*"createMicrophoneSelection",/u);
  assert.match(productionProbeSupport, /hasExportedFunction\(coachStorageTokens, "openCoachDatabase", \{ async: true \}\)/u);
  assert.match(productionProbeSupport, /hasExportedFunction\(coachEngineTokens, "assessCalibrationReadiness"\)/u);
  assert.match(productionProbeSupport, /hasExportedFunction\(setupKitsTokens, "createSetupKitStore"\)/u);
  assert.match(productionProbeSupport, /hasExportedFunction\(microphoneSelectionTokens, "createMicrophoneSelection"\)/u);
  assert.match(productionProbeSupport, /spawnSync\(process\.execPath, \["--check", "--input-type=module"\]/u);
  assert.match(productionAssetDiscovery, /PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES = 512 \* 1024/u);
  assert.match(productionProbe, /readVerifiedJavaScriptResponse\(response, pathname\)/u);
  assert.match(
    productionProbe,
    /async function getExcludedJavaScriptAsset\(pathname, remainingAssetMs\) \{[\s\S]*?return get\(pathname, "text\/javascript", 1, remainingAssetMs\);\s*\}/u,
  );
  assert.match(
    productionProbe,
    /const verifiedExcludedJavaScriptAssets = await waitForExcludedJavaScriptAssets\(\{\s*loadExcludedJavaScriptAsset: getExcludedJavaScriptAsset,\s*excludedJavaScriptAssetPaths,\s*deadlineMs: probeDeadlineMs,\s*now: \(\) => performance\.now\(\),/u,
  );
  assert.match(productionProbe,
    /const probeDeadlineMs = performance\.now\(\) \+ PRODUCTION_SMOKE_BUDGET_MS;/u);
  assert.match(productionProbe,
    /Math\.min\(timeoutMs, NETWORK_ATTEMPT_TIMEOUT_MS, remainingProbeMs\(\)\)/u);
  assert.match(productionProbe,
    /const body = await response\.(?:text|json)\(\);\s*remainingProbeMs\(\);/u);
  assert.match(productionProbeSupport,
    /timeout: Math\.max\(1, Math\.floor\(timeoutMs\)\)/u);
  assert.match(productionProbeSupport,
    /Math\.min\(JAVASCRIPT_SYNTAX_TIMEOUT_MS, remainingDeadlineMs\(deadlineMs, now\)\)/u);
  assert.match(productionProbeSupport, /const monotonicNow = \(\) => performance\.now\(\);/u);
  assert.match(productionProbeSupport, /assertExcludedJavaScriptResponse\(response, pathname\)/u);
  assert.match(productionProbe, /\.\.\.expectedJavaScriptAssets\.keys\(\)/u);
});

test("production probe requires the complete exact checked-out JavaScript generation", async () => {
  assert.equal(checkedOutJavaScriptAssets.size, 10);
  const result = await waitForExactPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => checkedOutJavaScriptAssets.get(pathname),
    expectedJavaScriptAssets: checkedOutJavaScriptAssets,
    sleep: async () => {},
    attempts: 1,
    retryMs: 0,
  });
  assert.equal(result.appSource, checkedOutJavaScriptAssets.get("/app.js"));
  assert.equal(result.setupKitsSource, checkedOutJavaScriptAssets.get("/setup-kits.js"));
  assert.equal(
    result.microphoneSelectionSource,
    checkedOutJavaScriptAssets.get("/microphone-selection.js"),
  );
  assert.deepEqual(result.observedJavaScriptAssets, checkedOutJavaScriptAssets);

  let calls = 0;
  await assert.rejects(
    waitForExactPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        const source = checkedOutJavaScriptAssets.get(pathname);
        return pathname === "/coach-audio-worklet.js" ? `${source}\n` : source;
      },
      expectedJavaScriptAssets: checkedOutJavaScriptAssets,
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /coach-audio-worklet\.js does not match the checked-out release source/u,
  );
  assert.equal(calls, checkedOutJavaScriptAssets.size);
  assert.throws(
    () => waitForExactPublicModuleGraph({ loadJavaScriptAsset: async () => "" }),
    /expectedJavaScriptAssets must be a Map/u,
  );

  const incompleteAssetMap = new Map(checkedOutJavaScriptAssets);
  incompleteAssetMap.delete("/microphone-selection.js");
  await assert.rejects(
    waitForExactPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => checkedOutJavaScriptAssets.get(pathname),
      expectedJavaScriptAssets: incompleteAssetMap,
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /must include every reviewed public module path/u,
  );
});

test("production probe refetches every discovered asset after a mixed generation", async () => {
  const calls = new Map([...checkedOutJavaScriptAssets.keys()].map((pathname) => [pathname, 0]));
  const delays = [];
  const result = await waitForExactPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      calls.set(pathname, calls.get(pathname) + 1);
      const source = checkedOutJavaScriptAssets.get(pathname);
      if (pathname === "/admin-analytics.js" && calls.get(pathname) === 1) return `${source}\n`;
      return source;
    },
    expectedJavaScriptAssets: checkedOutJavaScriptAssets,
    sleep: async (milliseconds) => delays.push(milliseconds),
    attempts: 2,
    retryMs: 7,
  });

  assert.deepEqual(result.observedJavaScriptAssets, checkedOutJavaScriptAssets);
  assert.deepEqual([...calls.values()], Array(checkedOutJavaScriptAssets.size).fill(2));
  assert.deepEqual(delays, [7]);
});

test("positive asset retries never overlap an unresolved previous sweep", async () => {
  const calls = new Map([
    "/app.js",
    "/coach-storage.js",
    "/coach-engine.js",
    "/setup-kits.js",
    "/microphone-selection.js",
  ].map((pathname) => [pathname, 0]));
  const delays = [];
  let releaseFirstApp;
  const firstApp = new Promise((resolve) => { releaseFirstApp = resolve; });
  const verification = waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      calls.set(pathname, calls.get(pathname) + 1);
      if (calls.get(pathname) === 1 && pathname === "/app.js") return firstApp;
      if (calls.get(pathname) === 1 && pathname === "/coach-storage.js") {
        throw new Error("temporary storage response failure");
      }
      return validPublicModuleSource(pathname);
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
    attempts: 2,
    retryMs: 7,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...calls.values()], [1, 1, 1, 1, 1],
    "attempt two must wait for every started attempt-one load and body read");
  assert.deepEqual(delays, []);
  releaseFirstApp(VALID_APP_MODULE_GRAPH);

  const result = await verification;
  assert.match(result.appSource, /coach-storage\.js/u);
  assert.deepEqual([...calls.values()], [2, 2, 2, 2, 2]);
  assert.deepEqual(delays, [7]);
});

test("positive asset sweep reports the first path error deterministically after settling", async () => {
  let rejectApp;
  const lateAppFailure = new Promise((_resolve, reject) => { rejectApp = reject; });
  const verification = waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      if (pathname === "/app.js") return lateAppFailure;
      if (pathname === "/coach-storage.js") throw new Error("later-path failure");
      return validPublicModuleSource(pathname);
    },
    attempts: 1,
  });

  await new Promise((resolve) => setImmediate(resolve));
  rejectApp(new Error("first-path failure"));
  await assert.rejects(verification, /first-path failure/u);
});

test("positive asset sweep caps concurrency at eight", async () => {
  let active = 0;
  let peakActive = 0;
  let calls = 0;
  await waitForExactPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      calls += 1;
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return checkedOutJavaScriptAssets.get(pathname);
    },
    expectedJavaScriptAssets: checkedOutJavaScriptAssets,
    attempts: 1,
  });

  assert.equal(calls, checkedOutJavaScriptAssets.size);
  assert.equal(peakActive, PUBLIC_JAVASCRIPT_ASSET_MAX_CONCURRENCY);
});

test("production probe streams JavaScript through a decompressed-byte ceiling", async () => {
  let declaredCancelCalls = 0;
  await assert.rejects(
    readBoundedJavaScriptBody({
      headers: new Headers({
        "content-length": String(PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES + 1),
      }),
      body: { cancel: async () => { declaredCancelCalls += 1; } },
    }, "/declared.js"),
    /declared\.js exceeds the reviewed JavaScript asset boundary/u,
  );
  assert.equal(declaredCancelCalls, 1);

  let streamedCancelCalls = 0;
  const oversizedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      streamedCancelCalls += 1;
    },
  });
  await assert.rejects(
    readBoundedJavaScriptBody(new Response(oversizedBody), "/streamed.js"),
    /streamed\.js exceeds the reviewed JavaScript asset boundary/u,
  );
  assert.equal(streamedCancelCalls, 1);

  const exactBoundary = new Uint8Array(PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES);
  exactBoundary.fill(0x20);
  assert.equal(
    (await readBoundedJavaScriptBody(new Response(exactBoundary), "/exact.js")).length,
    PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES,
  );
});

test("production probe verifies JavaScript response MIME, nosniff, encoding, and body shape", async () => {
  for (const contentType of [
    "text/javascript",
    "application/javascript; charset=utf-8",
    "TEXT/JAVASCRIPT",
  ]) {
    const source = await readVerifiedJavaScriptResponse(new Response("export {};\n", {
      headers: {
        "content-type": contentType,
        "x-content-type-options": "nosniff",
      },
    }), "/asset.js");
    assert.equal(source, "export {};\n");
  }

  for (const [headers, expectedError] of [
    [{ "x-content-type-options": "nosniff" }, /did not return JavaScript/u],
    [{ "content-type": "text/html", "x-content-type-options": "nosniff" }, /did not return JavaScript/u],
    [{ "content-type": "text/javascript" }, /missing MIME-sniffing protection/u],
    [{ "content-type": "text/javascript", "x-content-type-options": "invalid" }, /missing MIME-sniffing protection/u],
  ]) {
    await assert.rejects(
      readVerifiedJavaScriptResponse(new Response("export {};\n", { headers }), "/asset.js"),
      expectedError,
    );
  }

  for (const body of ["", "   \n", "<!doctype html><title>fallback</title>", "<html></html>"]) {
    await assert.rejects(
      readVerifiedJavaScriptResponse(new Response(body, {
        headers: {
          "content-type": "text/javascript",
          "x-content-type-options": "nosniff",
        },
      }), "/asset.js"),
      /empty or HTML fallback document/u,
    );
  }

  for (const [body, expectedError] of [
    [new Uint8Array([0xef, 0xbb, 0xbf, 0x65]), /byte-order mark/u],
    [new Uint8Array([0xc3, 0x28]), /not canonical UTF-8 JavaScript/u],
  ]) {
    await assert.rejects(
      readVerifiedJavaScriptResponse(new Response(body, {
        headers: {
          "content-type": "text/javascript",
          "x-content-type-options": "nosniff",
        },
      }), "/asset.js"),
      expectedError,
    );
  }

  for (const headers of [
    { "content-type": "text/html", "x-content-type-options": "nosniff" },
    { "content-type": "text/javascript" },
  ]) {
    let cancelCalls = 0;
    await assert.rejects(
      readVerifiedJavaScriptResponse({
        headers: new Headers(headers),
        body: { cancel: async () => { cancelCalls += 1; } },
      }, "/asset.js"),
    );
    assert.equal(cancelCalls, 1, "a rejected response must release its unread body");
  }
});

test("production probe requires ignored scripts to resolve only to protected HTML", async () => {
  let cancelCalls = 0;
  await assertExcludedJavaScriptResponse({
    headers: new Headers({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
    }),
    body: { cancel: async () => { cancelCalls += 1; } },
  }, "/runtime.test.js");
  assert.equal(cancelCalls, 1);

  for (const [headers, expectedError] of [
    [{ "content-type": "text/javascript", "x-content-type-options": "nosniff" }, /not excluded/u],
    [{ "content-type": "text/html" }, /missing MIME-sniffing protection/u],
  ]) {
    cancelCalls = 0;
    await assert.rejects(
      assertExcludedJavaScriptResponse({
        headers: new Headers(headers),
        body: { cancel: async () => { cancelCalls += 1; } },
      }, "/runtime.test.js"),
      expectedError,
    );
    assert.equal(cancelCalls, 1);
  }
});

test("excluded-script probe completes one normal bounded sweep", async () => {
  const pathnames = [
    "/zeta.TEST.MJS",
    "/suite.test.mjs/fixture.JS",
    "/alpha.test.js",
  ];
  const calls = [];
  let active = 0;
  let peakActive = 0;
  const verified = await waitForExcludedJavaScriptAssets({
    loadExcludedJavaScriptAsset: async (pathname) => {
      calls.push(pathname);
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return new Response("<!doctype html><title>NonStopTalk</title>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    },
    excludedJavaScriptAssetPaths: pathnames,
  });

  assert.deepEqual(verified, [...pathnames].sort());
  assert.deepEqual(calls, [...pathnames].sort());
  assert.equal(peakActive, pathnames.length);
  assert.equal(PUBLIC_EXCLUDED_JAVASCRIPT_ATTEMPTS, 8);
  assert.equal(PUBLIC_EXCLUDED_JAVASCRIPT_RETRY_MS, 1_000);
  assert.equal(PUBLIC_EXCLUDED_JAVASCRIPT_MAX_CONCURRENCY, 8);
});

test("excluded-script probe retries the complete set after a mixed generation", async () => {
  const pathnames = ["/alpha.test.js", "/bravo.test.mjs", "/charlie.TEST.JS"];
  const calls = new Map(pathnames.map((pathname) => [pathname, 0]));
  const delays = [];
  const verified = await waitForExcludedJavaScriptAssets({
    loadExcludedJavaScriptAsset: async (pathname) => {
      calls.set(pathname, calls.get(pathname) + 1);
      const firstMixedGeneration = pathname === "/bravo.test.mjs"
        && calls.get(pathname) === 1;
      return new Response(firstMixedGeneration ? "export {};" : "<!doctype html>", {
        headers: {
          "content-type": firstMixedGeneration ? "text/javascript" : "text/html",
          "x-content-type-options": "nosniff",
        },
      });
    },
    excludedJavaScriptAssetPaths: pathnames,
    sleep: async (milliseconds) => delays.push(milliseconds),
    attempts: 2,
    retryMs: 7,
    concurrency: 2,
  });

  assert.deepEqual(verified, pathnames);
  assert.deepEqual([...calls.values()], [2, 2, 2]);
  assert.deepEqual(delays, [7]);
});

test("excluded-script probe caps concurrency at eight", async () => {
  const pathnames = Array.from(
    { length: 19 },
    (_, index) => `/concurrency-${String(index).padStart(2, "0")}.test.js`,
  );
  let active = 0;
  let peakActive = 0;
  let calls = 0;
  await waitForExcludedJavaScriptAssets({
    loadExcludedJavaScriptAsset: async () => {
      calls += 1;
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return new Response("<!doctype html>", {
        headers: {
          "content-type": "text/html",
          "x-content-type-options": "nosniff",
        },
      });
    },
    excludedJavaScriptAssetPaths: pathnames,
  });

  assert.equal(calls, pathnames.length);
  assert.equal(peakActive, PUBLIC_EXCLUDED_JAVASCRIPT_MAX_CONCURRENCY);
});

test("excluded-script probe validates only canonical ignored JavaScript paths", async () => {
  let calls = 0;
  const loadExcludedJavaScriptAsset = async () => {
    calls += 1;
    throw new Error("must not fetch an invalid path");
  };
  for (const pathname of [
    "/app.js",
    "/runtime.test.ts",
    "/runtime.test.js?cache=1",
    "/../runtime.test.js",
    "/%72untime.test.js",
    "//runtime.test.js",
    "https://example.com/runtime.test.js",
  ]) {
    await assert.rejects(
      waitForExcludedJavaScriptAssets({
        loadExcludedJavaScriptAsset,
        excludedJavaScriptAssetPaths: [pathname],
      }),
      /invalid canonical ignored JavaScript path/u,
    );
  }
  await assert.rejects(
    waitForExcludedJavaScriptAssets({
      loadExcludedJavaScriptAsset,
      excludedJavaScriptAssetPaths: ["/runtime.test.js", "/runtime.test.js"],
    }),
    /must not contain duplicate paths/u,
  );
  await assert.rejects(
    waitForExcludedJavaScriptAssets({
      loadExcludedJavaScriptAsset,
      excludedJavaScriptAssetPaths: Array.from(
        { length: PUBLIC_EXCLUDED_JAVASCRIPT_ASSET_MAX_COUNT + 1 },
        (_, index) => `/over-count-${index}.test.js`,
      ),
    }),
    /exceeds the reviewed script-count boundary/u,
  );
  assert.equal(calls, 0);
});

test("excluded-script probe stops after a bounded persistent failure", async () => {
  const pathnames = ["/alpha.test.js", "/bravo.test.mjs"];
  const calls = new Map(pathnames.map((pathname) => [pathname, 0]));
  const delays = [];
  await assert.rejects(
    waitForExcludedJavaScriptAssets({
      loadExcludedJavaScriptAsset: async (pathname) => {
        calls.set(pathname, calls.get(pathname) + 1);
        return new Response("export {};", {
          headers: {
            "content-type": "text/javascript",
            "x-content-type-options": "nosniff",
          },
        });
      },
      excludedJavaScriptAssetPaths: pathnames,
      sleep: async (milliseconds) => delays.push(milliseconds),
      attempts: 3,
      retryMs: 5,
      concurrency: 2,
    }),
    /alpha\.test\.js was not excluded/u,
  );
  assert.deepEqual([...calls.values()], [3, 3]);
  assert.deepEqual(delays, [5, 10]);

  for (const options of [
    { attempts: PUBLIC_EXCLUDED_JAVASCRIPT_ATTEMPTS + 1 },
    { retryMs: PUBLIC_EXCLUDED_JAVASCRIPT_RETRY_MS + 1 },
    { concurrency: PUBLIC_EXCLUDED_JAVASCRIPT_MAX_CONCURRENCY + 1 },
  ]) {
    await assert.rejects(
      waitForExcludedJavaScriptAssets({
        loadExcludedJavaScriptAsset: async () => assert.fail("invalid bounds must not fetch"),
        excludedJavaScriptAssetPaths: ["/runtime.test.js"],
        ...options,
      }),
      /must be a safe integer from/u,
    );
  }
});

test("shared probe deadline bounds asset retries and their backoff", async () => {
  let currentTimeMs = 0;
  let calls = 0;
  const delays = [];
  await assert.rejects(
    waitForExcludedJavaScriptAssets({
      loadExcludedJavaScriptAsset: async (_pathname, remainingMs) => {
        calls += 1;
        assert.ok(remainingMs > 0 && remainingMs <= 6);
        return new Response("export {};", {
          headers: {
            "content-type": "text/javascript",
            "x-content-type-options": "nosniff",
          },
        });
      },
      excludedJavaScriptAssetPaths: ["/alpha.test.js", "/bravo.test.mjs"],
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        currentTimeMs += milliseconds;
      },
      attempts: PUBLIC_EXCLUDED_JAVASCRIPT_ATTEMPTS,
      retryMs: 5,
      deadlineMs: 6,
      now: () => currentTimeMs,
      concurrency: 2,
    }),
    /exceeded its shared deadline/u,
  );

  assert.equal(calls, 4, "the deadline must stop retries before the configured attempt cap");
  assert.deepEqual(delays, [5, 1], "the final backoff must be clamped to remaining time");
});

test("positive and excluded phases consume the same shared deadline", async () => {
  let currentTimeMs = 0;
  const positiveRemaining = [];
  const excludedRemaining = [];
  const deadlineMs = 100;
  await waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname, remainingMs) => {
      positiveRemaining.push(remainingMs);
      currentTimeMs += 1;
      return validPublicModuleSource(pathname);
    },
    attempts: 1,
    deadlineMs,
    now: () => currentTimeMs,
  });
  await waitForExcludedJavaScriptAssets({
    loadExcludedJavaScriptAsset: async (_pathname, remainingMs) => {
      excludedRemaining.push(remainingMs);
      currentTimeMs += 1;
      return new Response("<!doctype html>", {
        headers: {
          "content-type": "text/html",
          "x-content-type-options": "nosniff",
        },
      });
    },
    excludedJavaScriptAssetPaths: ["/alpha.test.js", "/bravo.test.mjs"],
    attempts: 1,
    deadlineMs,
    now: () => currentTimeMs,
  });

  assert.equal(positiveRemaining[0], deadlineMs);
  assert.ok(excludedRemaining[0] < positiveRemaining.at(-1),
    "the excluded phase must receive only the budget left by the positive phase");
});

test("production probe retries a mixed public asset generation as one module graph", async () => {
  const calls = { app: 0, storage: 0, engine: 0, setupKits: 0, microphoneSelection: 0 };
  const delays = [];

  const result = await waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      if (pathname === "/app.js") {
        calls.app += 1;
        return calls.app < 3
          ? "console.log('previous deployment');"
          : VALID_APP_MODULE_GRAPH;
      }
      if (pathname === "/coach-storage.js") {
        calls.storage += 1;
        return VALID_COACH_STORAGE_MODULE;
      }
      if (pathname === "/coach-engine.js") {
        calls.engine += 1;
        return VALID_COACH_ENGINE_MODULE;
      }
      if (pathname === "/setup-kits.js") {
        calls.setupKits += 1;
        return VALID_SETUP_KITS_MODULE;
      }
      assert.equal(pathname, "/microphone-selection.js");
      calls.microphoneSelection += 1;
      return VALID_MICROPHONE_SELECTION_MODULE;
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.appSource, /coach-storage\.js/u);
  assert.match(result.appSource, /coach-engine\.js/u);
  assert.match(result.coachEngineSource, /assessCalibrationReadiness/u);
  assert.match(result.appSource, /setup-kits\.js/u);
  assert.match(result.setupKitsSource, /createSetupKitStore/u);
  assert.match(result.appSource, /microphone-selection\.js/u);
  assert.match(result.microphoneSelectionSource, /createMicrophoneSelection/u);
  assert.equal(calls.app, 3);
  assert.equal(calls.storage, 3);
  assert.equal(calls.engine, 3);
  assert.equal(calls.setupKits, 3);
  assert.equal(calls.microphoneSelection, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.equal(PUBLIC_MODULE_GRAPH_ATTEMPTS, 8);
  assert.equal(PUBLIC_MODULE_GRAPH_RETRY_MS, 1_000);
});

test("production probe retries a temporary storage-asset SPA fallback", async () => {
  const calls = { app: 0, storage: 0, engine: 0, setupKits: 0, microphoneSelection: 0 };
  const delays = [];

  const result = await waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      if (pathname === "/app.js") {
        calls.app += 1;
        return VALID_APP_MODULE_GRAPH;
      }
      if (pathname === "/coach-storage.js") {
        calls.storage += 1;
        if (calls.storage === 1) {
          throw new Error("/coach-storage.js did not return JavaScript");
        }
        return VALID_COACH_STORAGE_MODULE;
      }
      if (pathname === "/coach-engine.js") {
        calls.engine += 1;
        return VALID_COACH_ENGINE_MODULE;
      }
      if (pathname === "/setup-kits.js") {
        calls.setupKits += 1;
        return VALID_SETUP_KITS_MODULE;
      }
      assert.equal(pathname, "/microphone-selection.js");
      calls.microphoneSelection += 1;
      return VALID_MICROPHONE_SELECTION_MODULE;
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.coachStorageSource, /openCoachDatabase/u);
  assert.equal(calls.app, 2);
  assert.equal(calls.storage, 2);
  assert.equal(calls.engine, 2);
  assert.equal(calls.setupKits, 2);
  assert.equal(calls.microphoneSelection, 2);
  assert.deepEqual(delays, [1_000]);
});

test("production probe retries a temporary coaching-engine SPA fallback", async () => {
  const calls = { app: 0, storage: 0, engine: 0, setupKits: 0, microphoneSelection: 0 };
  const delays = [];

  const result = await waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      if (pathname === "/app.js") {
        calls.app += 1;
        return VALID_APP_MODULE_GRAPH;
      }
      if (pathname === "/coach-storage.js") {
        calls.storage += 1;
        return VALID_COACH_STORAGE_MODULE;
      }
      if (pathname === "/coach-engine.js") {
        calls.engine += 1;
        if (calls.engine === 1) {
          throw new Error("/coach-engine.js did not return JavaScript");
        }
        return VALID_COACH_ENGINE_MODULE;
      }
      if (pathname === "/setup-kits.js") {
        calls.setupKits += 1;
        return VALID_SETUP_KITS_MODULE;
      }
      assert.equal(pathname, "/microphone-selection.js");
      calls.microphoneSelection += 1;
      return VALID_MICROPHONE_SELECTION_MODULE;
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.coachEngineSource, /assessCalibrationReadiness/u);
  assert.equal(calls.app, 2);
  assert.equal(calls.storage, 2);
  assert.equal(calls.engine, 2);
  assert.equal(calls.setupKits, 2);
  assert.equal(calls.microphoneSelection, 2);
  assert.deepEqual(delays, [1_000]);
});

test("production probe retries a temporary setup-kit SPA fallback", async () => {
  const calls = { app: 0, storage: 0, engine: 0, setupKits: 0, microphoneSelection: 0 };
  const delays = [];

  const result = await waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      if (pathname === "/app.js") {
        calls.app += 1;
        return VALID_APP_MODULE_GRAPH;
      }
      if (pathname === "/coach-storage.js") {
        calls.storage += 1;
        return VALID_COACH_STORAGE_MODULE;
      }
      if (pathname === "/coach-engine.js") {
        calls.engine += 1;
        return VALID_COACH_ENGINE_MODULE;
      }
      if (pathname === "/setup-kits.js") {
        calls.setupKits += 1;
        if (calls.setupKits === 1) {
          throw new Error("/setup-kits.js did not return JavaScript");
        }
        return VALID_SETUP_KITS_MODULE;
      }
      assert.equal(pathname, "/microphone-selection.js");
      calls.microphoneSelection += 1;
      return VALID_MICROPHONE_SELECTION_MODULE;
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.setupKitsSource, /createSetupKitStore/u);
  assert.equal(calls.app, 2);
  assert.equal(calls.storage, 2);
  assert.equal(calls.engine, 2);
  assert.equal(calls.setupKits, 2);
  assert.equal(calls.microphoneSelection, 2);
  assert.deepEqual(delays, [1_000]);
});

test("production probe retries a temporary microphone-selection SPA fallback", async () => {
  const calls = { app: 0, storage: 0, engine: 0, setupKits: 0, microphoneSelection: 0 };
  const delays = [];

  const result = await waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      if (pathname === "/app.js") {
        calls.app += 1;
        return VALID_APP_MODULE_GRAPH;
      }
      if (pathname === "/coach-storage.js") {
        calls.storage += 1;
        return VALID_COACH_STORAGE_MODULE;
      }
      if (pathname === "/coach-engine.js") {
        calls.engine += 1;
        return VALID_COACH_ENGINE_MODULE;
      }
      if (pathname === "/setup-kits.js") {
        calls.setupKits += 1;
        return VALID_SETUP_KITS_MODULE;
      }
      assert.equal(pathname, "/microphone-selection.js");
      calls.microphoneSelection += 1;
      if (calls.microphoneSelection === 1) {
        throw new Error("/microphone-selection.js did not return JavaScript");
      }
      return VALID_MICROPHONE_SELECTION_MODULE;
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.microphoneSelectionSource, /createMicrophoneSelection/u);
  assert.equal(calls.app, 2);
  assert.equal(calls.storage, 2);
  assert.equal(calls.engine, 2);
  assert.equal(calls.setupKits, 2);
  assert.equal(calls.microphoneSelection, 2);
  assert.deepEqual(delays, [1_000]);
});

test("production probe keeps a persistent module-graph defect bounded and visible", async () => {
  let calls = 0;
  const delays = [];

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") return "import './unrelated.js';";
        return validPublicModuleSource(pathname);
      },
      sleep: async (milliseconds) => delays.push(milliseconds),
      attempts: 3,
      retryMs: 7,
    }),
    /does not reference the required coaching storage module/u,
  );

  assert.equal(calls, 15);
  assert.deepEqual(delays, [7, 14]);
});

test("production probe ignores module-graph markers inside comments, strings, templates, and regexes", async () => {
  let calls = 0;
  const decoyApp = [
    "const commentMarker = \"import { openCoachDatabase } from './coach-storage.js';\";",
    "const setupMarker = 'const setupKitStore = createSetupKitStore();';",
    "const templateMarker = `import('./coach-engine.js'); engine.assessCalibrationReadiness({});`;",
    "const regexMarker = /createSetupKitStore().*assessCalibrationReadiness()/u;",
    "// import { createSetupKitStore } from './setup-kits.js';",
    "/* import { openCoachDatabase } from './coach-storage.js'; */",
  ].join("\n");

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") return decoyApp;
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js does not reference the required coaching storage module/u,
  );

  assert.equal(calls, 5);
});

test("production probe rejects import.meta ASI and side-effect import shadow decoys", async () => {
  const importMetaAsiDecoy = [
    "import.meta",
    "from",
    "'./coach-storage.js';",
    "import.meta",
    "from",
    "'./setup-kits.js';",
    "const createSetupKitStore = () => ({});",
    "const setupKitStore = createSetupKitStore();",
    "let coachEnginePromise;",
    "function loadCoachEngine() {",
    "  coachEnginePromise ||= import('./coach-engine.js');",
    "  return coachEnginePromise;",
    "}",
    "async function begin() {",
    "  const engine = await loadCoachEngine();",
    "  let run; let coachingRun;",
    "  run = coachingRun = { engine };",
    "  run.calibrationReadiness = run.engine.assessCalibrationReadiness({});",
    "}",
  ].join("\n");
  const sideEffectShadowDecoy = [
    "import './coach-storage.js';",
    "import './setup-kits.js';",
    "const createSetupKitStore = () => ({});",
    "const setupKitStore = createSetupKitStore();",
    "let coachEnginePromise;",
    "function loadCoachEngine() {",
    "  coachEnginePromise ||= import('./coach-engine.js');",
    "  return coachEnginePromise;",
    "}",
    "async function begin() {",
    "  const engine = await loadCoachEngine();",
    "  let run; let coachingRun;",
    "  run = coachingRun = { engine };",
    "  run.calibrationReadiness = run.engine.assessCalibrationReadiness({});",
    "}",
  ].join("\n");

  for (const source of [importMetaAsiDecoy, sideEffectShadowDecoy]) {
    let calls = 0;
    await assert.rejects(
      waitForPublicModuleGraph({
        loadJavaScriptAsset: async (pathname) => {
          calls += 1;
          if (pathname === "/app.js") return source;
          return validPublicModuleSource(pathname);
        },
        sleep: async () => {},
        attempts: 1,
        retryMs: 0,
      }),
      /app\.js does not reference the required coaching storage module/u,
    );
    assert.equal(calls, 5);
  }
});

test("production probe rejects nested setup shadows and dead inner engine loaders", async () => {
  const nestedSetupShadow = VALID_APP_MODULE_GRAPH.replace(
    "const setupKitStore = createSetupKitStore();",
    "{\n  const createSetupKitStore = () => ({ fake: true });\n  const setupKitStore = createSetupKitStore();\n}",
  );
  const deadInnerEngineLoader = VALID_APP_MODULE_GRAPH.replace(
    [
      "function loadCoachEngine() {",
      "  coachEnginePromise ||= import('./coach-engine.js');",
      "  return coachEnginePromise;",
      "}",
    ].join("\n"),
    [
      "function loadCoachEngine() {",
      "  function dead() {",
      "    coachEnginePromise ||= import('./coach-engine.js');",
      "    return coachEnginePromise;",
      "  }",
      "  return Promise.resolve({ assessCalibrationReadiness() { return {}; } });",
      "}",
    ].join("\n"),
  );

  for (const [source, expectedError] of [
    [nestedSetupShadow, /app\.js does not consume the setup-kit storage boundary/u],
    [deadInnerEngineLoader, /app\.js does not reference the required coaching engine module/u],
  ]) {
    await assert.rejects(
      waitForPublicModuleGraph({
        loadJavaScriptAsset: async (pathname) => {
          if (pathname === "/app.js") return source;
          return validPublicModuleSource(pathname);
        },
        sleep: async () => {},
        attempts: 1,
        retryMs: 0,
      }),
      expectedError,
    );
  }
});

test("production probe accepts ordinary division and increment syntax around the reviewed graph", async () => {
  const appSource = `${VALID_APP_MODULE_GRAPH}\nconst ratio = 10 / 2;\nlet counter = 0;\ncounter++ / ratio;`;
  const result = await waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      if (pathname === "/app.js") return appSource;
      return validPublicModuleSource(pathname);
    },
    sleep: async () => {},
    attempts: 1,
    retryMs: 0,
  });
  assert.match(result.appSource, /counter\+\+ \/ ratio/u);
});

test("production probe rejects oversized assets before tokenization", async () => {
  let calls = 0;
  const oversizedApp = VALID_APP_MODULE_GRAPH
    + " ".repeat(PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES + 1);
  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") return oversizedApp;
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js exceeds the reviewed JavaScript asset boundary/u,
  );
  assert.equal(calls, 5);
});

test("production probe ignores export markers inside non-code text", async () => {
  for (const [target, source, expected] of [
    ["/coach-storage.js", "// export async function openCoachDatabase() {}\nconst marker = 'export async function openCoachDatabase() {}';", /coach-storage\.js does not expose/u],
    ["/coach-engine.js", "const marker = `export function assessCalibrationReadiness() {}`;", /coach-engine\.js does not expose/u],
    ["/setup-kits.js", "const marker = /export function createSetupKitStore()/u;", /setup-kits\.js does not expose/u],
    ["/microphone-selection.js", "const marker = 'export function createMicrophoneSelection() {}';", /microphone-selection\.js does not expose/u],
  ]) {
    let calls = 0;
    await assert.rejects(
      waitForPublicModuleGraph({
        loadJavaScriptAsset: async (pathname) => {
          calls += 1;
          if (pathname === "/app.js") return VALID_APP_MODULE_GRAPH;
          if (pathname === target) return source;
          return validPublicModuleSource(pathname);
        },
        sleep: async () => {},
        attempts: 1,
        retryMs: 0,
      }),
      expected,
    );
    assert.equal(calls, 5);
  }
});

test("production probe rejects syntactically invalid assets even when every marker is present", async () => {
  let calls = 0;
  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") return `${VALID_APP_MODULE_GRAPH}\nconst broken = ;`;
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js is not valid JavaScript module syntax/u,
  );
  assert.equal(calls, 5);
});

test("production probe rejects an app without the required setup-kit import", async () => {
  let calls = 0;

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") {
          return VALID_APP_MODULE_GRAPH.replace(
            "import { createSetupKitStore } from './setup-kits.js';\n",
            "",
          );
        }
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js does not reference the required setup-kit module/u,
  );

  assert.equal(calls, 5);
});

test("production probe rejects an app that imports but does not consume setup-kit storage", async () => {
  let calls = 0;

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") {
          return VALID_APP_MODULE_GRAPH.replace(
            "const setupKitStore = createSetupKitStore();\n",
            "",
          );
        }
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js does not consume the setup-kit storage boundary/u,
  );

  assert.equal(calls, 5);
});

test("production probe rejects a setup-kit module without the exact store export", async () => {
  let calls = 0;

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/setup-kits.js") {
          return "export function createLegacySetupKitStore() {}";
        }
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /setup-kits\.js does not expose createSetupKitStore/u,
  );

  assert.equal(calls, 5);
});

test("production probe rejects microphone import markers hidden in non-code text", async () => {
  let calls = 0;
  const appSource = VALID_APP_MODULE_GRAPH.replace(
    "import { createMicrophoneSelection } from './microphone-selection.js';\n",
    [
      "const microphoneImportMarker = \"import { createMicrophoneSelection } from './microphone-selection.js';\";",
      "// import { createMicrophoneSelection } from './microphone-selection.js';",
    ].join("\n") + "\n",
  );

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") return appSource;
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js does not reference the required microphone-selection module/u,
  );

  assert.equal(calls, 5);
});

test("production probe rejects a nested microphone factory-call decoy", async () => {
  let calls = 0;
  const appSource = VALID_APP_MODULE_GRAPH.replace(
    "const microphoneSelection = createMicrophoneSelection({ getStorage: () => null });\n",
    [
      "function unusedMicrophoneFactory() {",
      "  const microphoneSelection = createMicrophoneSelection({ getStorage: () => null });",
      "  return microphoneSelection;",
      "}",
    ].join("\n") + "\n",
  );

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") return appSource;
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js does not consume the microphone-selection boundary/u,
  );

  assert.equal(calls, 5);
});

test("production probe rejects a microphone module without the exact factory export", async () => {
  let calls = 0;

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/microphone-selection.js") {
          return "export function createLegacyMicrophoneSelection() {}";
        }
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /microphone-selection\.js does not expose createMicrophoneSelection/u,
  );

  assert.equal(calls, 5);
});

test("production probe rejects a legacy app that imports but does not consume calibration readiness", async () => {
  let calls = 0;

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") {
          return VALID_APP_MODULE_GRAPH.replace(
            "  run.calibrationReadiness = run.engine.assessCalibrationReadiness({});\n",
            "",
          );
        }
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js does not consume the calibration-readiness boundary/u,
  );

  assert.equal(calls, 5);
});

test("production probe rejects a coaching engine without the exact readiness export", async () => {
  let calls = 0;

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") {
          return VALID_APP_MODULE_GRAPH;
        }
        if (pathname === "/coach-engine.js") return "export function assessCalibrationReadinessLegacy() {}";
        return validPublicModuleSource(pathname);
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /coach-engine\.js does not expose assessCalibrationReadiness/u,
  );

  assert.equal(calls, 5);
});
