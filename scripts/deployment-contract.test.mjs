import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
