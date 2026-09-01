import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowURL = new URL("../.github/workflows/production-health.yml", import.meta.url);
const workflow = await readFile(workflowURL, "utf8");
const packageJSON = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const productionProbe = await readFile(new URL("./smoke-production.mjs", import.meta.url), "utf8");

test("production health workflow stays scheduled, bounded, and manually runnable", () => {
  assert.match(workflow, /^  schedule:\n    - cron: "17,47 \* \* \* \*"$/mu);
  assert.match(workflow, /^  workflow_dispatch:$/mu);
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
  assert.match(
    workflow,
    /^          NONSTOPTALK_PRODUCTION_ORIGIN: https:\/\/dontstoptalking\.org$/mu,
  );
  assert.doesNotMatch(workflow, /\bnpm\s+(?:ci|install|clean-install)\b/iu);
  assert.doesNotMatch(workflow, /\bwrangler\b|\b(?:deploy|migrate|rollback)\b/iu);
  assert.doesNotMatch(productionProbe, /\b(?:POST|PUT|PATCH|DELETE)\b/u);
  assert.doesNotMatch(productionProbe, /\bAuthorization\b|ANALYTICS_ADMIN_TOKEN/u);
});

test("production health workflow pins its two third-party actions", () => {
  const uses = [...workflow.matchAll(/^\s+- uses:\s*(.+)$/gmu)]
    .map((match) => match[1].split(/\s+#/u)[0]);

  assert.deepEqual(uses, [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  ]);
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
