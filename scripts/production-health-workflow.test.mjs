import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PUBLIC_MODULE_GRAPH_ATTEMPTS,
  PUBLIC_MODULE_GRAPH_RETRY_MS,
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
    /waitForPublicModuleGraph\(\{ loadJavaScriptAsset: getJavaScriptAsset \}\)/u,
  );
  assert.match(productionProbeSupport, /loadJavaScriptAsset\("\/app\.js"\)/u);
  assert.match(productionProbeSupport, /loadJavaScriptAsset\("\/coach-storage\.js"\)/u);
  assert.match(productionProbe, /get\(pathname, "text\/javascript", 1\)/u);
  assert.match(productionProbe, /mediaType === "text\/javascript"/u);
  assert.match(productionProbe, /!\/\^\\s\*\(\?:<!doctype\\s\+html\|<html\\b\)\/iu\.test\(source\)/u);
  assert.match(productionProbeSupport, /from\\s\+\["'\]\\\.\\\/coach-storage\\\.js\["'\]/u);
  assert.match(productionProbeSupport, /export async function openCoachDatabase/u);
});

test("production probe retries a mixed public asset generation as one module graph", async () => {
  const calls = { app: 0, storage: 0 };
  const delays = [];

  const result = await waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      if (pathname === "/app.js") {
        calls.app += 1;
        return calls.app < 3
          ? "console.log('previous deployment');"
          : "import { openCoachDatabase } from './coach-storage.js';";
      }
      assert.equal(pathname, "/coach-storage.js");
      calls.storage += 1;
      return "export async function openCoachDatabase() {}";
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.appSource, /coach-storage\.js/u);
  assert.equal(calls.app, 3);
  assert.equal(calls.storage, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.equal(PUBLIC_MODULE_GRAPH_ATTEMPTS, 8);
  assert.equal(PUBLIC_MODULE_GRAPH_RETRY_MS, 1_000);
});

test("production probe retries a temporary storage-asset SPA fallback", async () => {
  const calls = { app: 0, storage: 0 };
  const delays = [];

  const result = await waitForPublicModuleGraph({
    loadJavaScriptAsset: async (pathname) => {
      if (pathname === "/app.js") {
        calls.app += 1;
        return "import { openCoachDatabase } from './coach-storage.js';";
      }
      assert.equal(pathname, "/coach-storage.js");
      calls.storage += 1;
      if (calls.storage === 1) {
        throw new Error("/coach-storage.js did not return JavaScript");
      }
      return "export async function openCoachDatabase() {}";
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.match(result.coachStorageSource, /openCoachDatabase/u);
  assert.equal(calls.app, 2);
  assert.equal(calls.storage, 2);
  assert.deepEqual(delays, [1_000]);
});

test("production probe keeps a persistent module-graph defect bounded and visible", async () => {
  let calls = 0;
  const delays = [];

  await assert.rejects(
    waitForPublicModuleGraph({
      loadJavaScriptAsset: async (pathname) => {
        calls += 1;
        return pathname === "/app.js"
          ? "import './unrelated.js';"
          : "export async function openCoachDatabase() {}";
      },
      sleep: async (milliseconds) => delays.push(milliseconds),
      attempts: 3,
      retryMs: 7,
    }),
    /does not reference the required coaching storage module/u,
  );

  assert.equal(calls, 6);
  assert.deepEqual(delays, [7, 14]);
});
