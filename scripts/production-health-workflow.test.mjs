import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES,
  PUBLIC_MODULE_GRAPH_ATTEMPTS,
  PUBLIC_MODULE_GRAPH_RETRY_MS,
  readBoundedJavaScriptBody,
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
const productionProbePolicy = await readFile(
  new URL("./smoke-production-policy.mjs", import.meta.url),
  "utf8",
);
const stagingProbe = await readFile(new URL("./smoke-staging.mjs", import.meta.url), "utf8");

const VALID_APP_MODULE_GRAPH = [
  "import * as coachingStorage from './coach-storage.js';",
  "import { createSetupKitStore } from './setup-kits.js';",
  "const setupKitStore = createSetupKitStore();",
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
const PUBLIC_JAVASCRIPT_ASSET_PATHS = [
  "/app.js",
  "/coach-storage.js",
  "/coach-engine.js",
  "/setup-kits.js",
];
const checkedOutJavaScriptAssets = new Map(await Promise.all(
  PUBLIC_JAVASCRIPT_ASSET_PATHS.map(async (pathname) => [
    pathname,
    await readFile(new URL(`../cloudflare/public${pathname}`, import.meta.url), "utf8"),
  ]),
));

test("production health workflow stays scheduled, bounded, and manually runnable", () => {
  assert.match(workflow, /^  schedule:\n    - cron: "17,47 \* \* \* \*"$/mu);
  assert.match(workflow, /^  workflow_dispatch:$/mu);
  assert.match(workflow, /^  workflow_dispatch:\n\nconcurrency:$/mu);
  assert.doesNotMatch(workflow, /^\s+inputs\s*:/mu);
  assert.doesNotMatch(workflow, /\bcontinue-on-error\s*:/iu);
  assert.match(workflow, /^  group: production-health$/mu);
  assert.match(workflow, /^  cancel-in-progress: true$/mu);
  assert.match(workflow, /^    timeout-minutes: 5$/mu);
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
  for (const source of [productionProbe, productionProbeSupport, productionProbePolicy]) {
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
      + "            expected_delivery: best-effort\n"
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
      expectedDelivery: "best-effort",
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
  assert.equal(DEFAULT_EXPECTED_ANALYTICS_DELIVERY, "best-effort");
  assert.equal(resolveExpectedAnalyticsDelivery(undefined, undefined), "best-effort");
  for (const value of ["best-effort", "durable-outbox"]) {
    assert.equal(resolveExpectedAnalyticsDelivery(value, undefined), value);
    assert.equal(resolveExpectedAnalyticsDelivery(undefined, value), value);
  }

  assert.equal(
    resolveExpectedAnalyticsDelivery("durable-outbox", "best-effort"),
    "durable-outbox",
    "the explicit command-line policy must override the environment",
  );
  assert.equal(
    resolveExpectedAnalyticsDelivery("best-effort", "not-reviewed"),
    "best-effort",
    "a valid command-line policy must fully replace an ambient environment value",
  );
  assert.throws(
    () => resolveExpectedAnalyticsDelivery("", "best-effort"),
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

test("production probe verifies the required public JavaScript module graph", () => {
  assert.match(
    productionProbe,
    /waitForExactPublicModuleGraph\(\{\s*loadJavaScriptAsset: getJavaScriptAsset,\s*expectedJavaScriptAssets,/u,
  );
  assert.match(productionProbe, /readFile\(new URL\(`\.\.\/cloudflare\/public\$\{pathname\}`/u);
  assert.match(productionProbeSupport, /loadJavaScriptAsset\("\/app\.js"\)/u);
  assert.match(productionProbeSupport, /loadJavaScriptAsset\("\/coach-storage\.js"\)/u);
  assert.match(productionProbeSupport, /loadJavaScriptAsset\("\/coach-engine\.js"\)/u);
  assert.match(productionProbeSupport, /loadJavaScriptAsset\("\/setup-kits\.js"\)/u);
  assert.match(productionProbe, /get\(pathname, "text\/javascript", 1\)/u);
  assert.match(productionProbe, /mediaType === "text\/javascript"/u);
  assert.match(productionProbe, /!\/\^\\s\*\(\?:<!doctype\\s\+html\|<html\\b\)\/iu\.test\(source\)/u);
  assert.match(productionProbeSupport, /hasNamespaceModuleImport\(\s*appTokens,\s*"\.\/coach-storage\.js",\s*"coachingStorage",/u);
  assert.match(productionProbeSupport, /hasDynamicModuleLoader\(\s*appTokens,\s*"loadCoachEngine",\s*"coachEnginePromise",\s*"\.\/coach-engine\.js",/u);
  assert.match(productionProbeSupport, /hasAwaitedFactoryAssignment\(appTokens, "engine", "loadCoachEngine"\)/u);
  assert.match(productionProbeSupport, /hasAssignedObjectShorthand\(appTokens, \["run", "coachingRun"\], "engine"\)/u);
  assert.match(productionProbeSupport, /hasMemberCall\(appTokens, "assessCalibrationReadiness"\)/u);
  assert.match(productionProbeSupport, /hasNamedModuleImport\(\s*appTokens,\s*"\.\/setup-kits\.js",\s*"createSetupKitStore",/u);
  assert.match(productionProbeSupport, /hasAssignedFactoryCall\(appTokens, "setupKitStore", "createSetupKitStore"\)/u);
  assert.match(productionProbeSupport, /hasExportedFunction\(coachStorageTokens, "openCoachDatabase", \{ async: true \}\)/u);
  assert.match(productionProbeSupport, /hasExportedFunction\(coachEngineTokens, "assessCalibrationReadiness"\)/u);
  assert.match(productionProbeSupport, /hasExportedFunction\(setupKitsTokens, "createSetupKitStore"\)/u);
  assert.match(productionProbeSupport, /spawnSync\(process\.execPath, \["--check", "--input-type=module"\]/u);
  assert.match(productionProbeSupport, /PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES = 512 \* 1024/u);
  assert.match(productionProbe, /readBoundedJavaScriptBody\(response, pathname\)/u);
  assert.match(productionProbe, /"\/setup-kits\.js"/u);
});

test("production probe requires an exact checked-out four-asset generation", async () => {
  const result = await waitForExactPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => checkedOutJavaScriptAssets.get(pathname),
    expectedJavaScriptAssets: checkedOutJavaScriptAssets,
    sleep: async () => {},
    attempts: 1,
    retryMs: 0,
  });
  assert.equal(result.appSource, checkedOutJavaScriptAssets.get("/app.js"));
  assert.equal(result.setupKitsSource, checkedOutJavaScriptAssets.get("/setup-kits.js"));

  let calls = 0;
  await assert.rejects(
    waitForExactPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        const source = checkedOutJavaScriptAssets.get(pathname);
        return pathname === "/setup-kits.js" ? `${source}\n` : source;
      },
      expectedJavaScriptAssets: checkedOutJavaScriptAssets,
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /setup-kits\.js does not match the checked-out release source/u,
  );
  assert.equal(calls, 4);
  assert.throws(
    () => waitForExactPublicModuleGraph({ loadJavaScriptAsset: async () => "" }),
    /expectedJavaScriptAssets must be a Map/u,
  );
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

test("production probe retries a mixed public asset generation as one module graph", async () => {
  const calls = { app: 0, storage: 0, engine: 0, setupKits: 0 };
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
      assert.equal(pathname, "/setup-kits.js");
      calls.setupKits += 1;
      return VALID_SETUP_KITS_MODULE;
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.appSource, /coach-storage\.js/u);
  assert.match(result.appSource, /coach-engine\.js/u);
  assert.match(result.coachEngineSource, /assessCalibrationReadiness/u);
  assert.match(result.appSource, /setup-kits\.js/u);
  assert.match(result.setupKitsSource, /createSetupKitStore/u);
  assert.equal(calls.app, 3);
  assert.equal(calls.storage, 3);
  assert.equal(calls.engine, 3);
  assert.equal(calls.setupKits, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.equal(PUBLIC_MODULE_GRAPH_ATTEMPTS, 8);
  assert.equal(PUBLIC_MODULE_GRAPH_RETRY_MS, 1_000);
});

test("production probe retries a temporary storage-asset SPA fallback", async () => {
  const calls = { app: 0, storage: 0, engine: 0, setupKits: 0 };
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
      assert.equal(pathname, "/setup-kits.js");
      calls.setupKits += 1;
      return VALID_SETUP_KITS_MODULE;
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.coachStorageSource, /openCoachDatabase/u);
  assert.equal(calls.app, 2);
  assert.equal(calls.storage, 2);
  assert.equal(calls.engine, 2);
  assert.equal(calls.setupKits, 2);
  assert.deepEqual(delays, [1_000]);
});

test("production probe retries a temporary coaching-engine SPA fallback", async () => {
  const calls = { app: 0, storage: 0, engine: 0, setupKits: 0 };
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
      assert.equal(pathname, "/setup-kits.js");
      calls.setupKits += 1;
      return VALID_SETUP_KITS_MODULE;
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.coachEngineSource, /assessCalibrationReadiness/u);
  assert.equal(calls.app, 2);
  assert.equal(calls.storage, 2);
  assert.equal(calls.engine, 2);
  assert.equal(calls.setupKits, 2);
  assert.deepEqual(delays, [1_000]);
});

test("production probe retries a temporary setup-kit SPA fallback", async () => {
  const calls = { app: 0, storage: 0, engine: 0, setupKits: 0 };
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
      assert.equal(pathname, "/setup-kits.js");
      calls.setupKits += 1;
      if (calls.setupKits === 1) {
        throw new Error("/setup-kits.js did not return JavaScript");
      }
      return VALID_SETUP_KITS_MODULE;
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.setupKitsSource, /createSetupKitStore/u);
  assert.equal(calls.app, 2);
  assert.equal(calls.storage, 2);
  assert.equal(calls.engine, 2);
  assert.equal(calls.setupKits, 2);
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
        if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
        if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
        return VALID_SETUP_KITS_MODULE;
      },
      sleep: async (milliseconds) => delays.push(milliseconds),
      attempts: 3,
      retryMs: 7,
    }),
    /does not reference the required coaching storage module/u,
  );

  assert.equal(calls, 12);
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
        if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
        if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
        return VALID_SETUP_KITS_MODULE;
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js does not reference the required coaching storage module/u,
  );

  assert.equal(calls, 4);
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
          if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
          if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
          return VALID_SETUP_KITS_MODULE;
        },
        sleep: async () => {},
        attempts: 1,
        retryMs: 0,
      }),
      /app\.js does not reference the required coaching storage module/u,
    );
    assert.equal(calls, 4);
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
          if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
          if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
          return VALID_SETUP_KITS_MODULE;
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
      if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
      if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
      return VALID_SETUP_KITS_MODULE;
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
        if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
        if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
        return VALID_SETUP_KITS_MODULE;
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js exceeds the reviewed JavaScript asset boundary/u,
  );
  assert.equal(calls, 4);
});

test("production probe ignores export markers inside non-code text", async () => {
  for (const [target, source, expected] of [
    ["/coach-storage.js", "// export async function openCoachDatabase() {}\nconst marker = 'export async function openCoachDatabase() {}';", /coach-storage\.js does not expose/u],
    ["/coach-engine.js", "const marker = `export function assessCalibrationReadiness() {}`;", /coach-engine\.js does not expose/u],
    ["/setup-kits.js", "const marker = /export function createSetupKitStore()/u;", /setup-kits\.js does not expose/u],
  ]) {
    let calls = 0;
    await assert.rejects(
      waitForPublicModuleGraph({
        loadJavaScriptAsset: async (pathname) => {
          calls += 1;
          if (pathname === "/app.js") return VALID_APP_MODULE_GRAPH;
          if (pathname === target) return source;
          if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
          if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
          return VALID_SETUP_KITS_MODULE;
        },
        sleep: async () => {},
        attempts: 1,
        retryMs: 0,
      }),
      expected,
    );
    assert.equal(calls, 4);
  }
});

test("production probe rejects syntactically invalid assets even when every marker is present", async () => {
  let calls = 0;
  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") return `${VALID_APP_MODULE_GRAPH}\nconst broken = ;`;
        if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
        if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
        return VALID_SETUP_KITS_MODULE;
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js is not valid JavaScript module syntax/u,
  );
  assert.equal(calls, 4);
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
        if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
        if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
        return VALID_SETUP_KITS_MODULE;
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js does not reference the required setup-kit module/u,
  );

  assert.equal(calls, 4);
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
        if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
        if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
        return VALID_SETUP_KITS_MODULE;
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js does not consume the setup-kit storage boundary/u,
  );

  assert.equal(calls, 4);
});

test("production probe rejects a setup-kit module without the exact store export", async () => {
  let calls = 0;

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        if (pathname === "/app.js") return VALID_APP_MODULE_GRAPH;
        if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
        if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
        return "export function createLegacySetupKitStore() {}";
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /setup-kits\.js does not expose createSetupKitStore/u,
  );

  assert.equal(calls, 4);
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
        if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
        if (pathname === "/coach-engine.js") return VALID_COACH_ENGINE_MODULE;
        return VALID_SETUP_KITS_MODULE;
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /app\.js does not consume the calibration-readiness boundary/u,
  );

  assert.equal(calls, 4);
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
        if (pathname === "/coach-storage.js") return VALID_COACH_STORAGE_MODULE;
        if (pathname === "/coach-engine.js") return "export function assessCalibrationReadinessLegacy() {}";
        return VALID_SETUP_KITS_MODULE;
      },
      sleep: async () => {},
      attempts: 1,
      retryMs: 0,
    }),
    /coach-engine\.js does not expose assessCalibrationReadiness/u,
  );

  assert.equal(calls, 4);
});
