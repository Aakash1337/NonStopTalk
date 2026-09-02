import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  PUBLIC_EXCLUDED_JAVASCRIPT_ASSET_MAX_COUNT,
  PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES,
  PUBLIC_JAVASCRIPT_ASSET_MAX_COUNT,
  PUBLIC_JAVASCRIPT_ASSET_MAX_TOTAL_BYTES,
  PUBLIC_JAVASCRIPT_ASSET_PATH_MAX_BYTES,
  isReviewedExcludedJavaScriptPath,
  isReviewedProductionJavaScriptPath,
  readPublicJavaScriptAssetInventory,
  readPublicJavaScriptAssets,
} from "./public-javascript-assets.mjs";

const EXPECTED_DEPLOYED_JAVASCRIPT_PATHS = [
  "/admin-analytics-page.js",
  "/admin-analytics.js",
  "/app.js",
  "/cloud-progress.js",
  "/coach-audio-worklet.js",
  "/coach-engine.js",
  "/coach-loop.js",
  "/coach-storage.js",
  "/microphone-selection.js",
  "/setup-kits.js",
  "/sound-cues.js",
  "/turn-transcription.js",
];
const EXPECTED_EXCLUDED_JAVASCRIPT_PATHS = [
  "/admin-analytics.test.js",
  "/cloud-progress.test.js",
  "/coach-engine.test.js",
  "/coach-loop.test.js",
  "/coach-storage.test.js",
  "/microphone-selection.test.js",
  "/setup-kits.TEST.mjs",
  "/sound-cues.test.js",
  "/turn-transcription.test.js",
];

async function temporaryAssets(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nonstoptalk-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, ".assetsignore"), "*.test.js\n*.test.mjs\n");
  return {
    directory,
    url: pathToFileURL(`${directory}${path.sep}`),
  };
}

test("checked-out production JavaScript inventory is complete and deterministic", async () => {
  const { productionAssets: assets, excludedJavaScriptAssetPaths } =
    await readPublicJavaScriptAssetInventory();
  assert.deepEqual([...assets.keys()], EXPECTED_DEPLOYED_JAVASCRIPT_PATHS);
  assert.deepEqual(excludedJavaScriptAssetPaths, EXPECTED_EXCLUDED_JAVASCRIPT_PATHS);
  assert.ok([...assets.values()].every((source) => source.length > 0));
  for (const pathname of excludedJavaScriptAssetPaths) {
    assert.equal(assets.has(pathname), false);
  }
});

test("asset discovery mirrors Wrangler ignore casing, directories, metadata, and extensions", async (t) => {
  const fixture = await temporaryAssets(t);
  await Promise.all([
    mkdir(path.join(fixture.directory, "nested tools")),
    mkdir(path.join(fixture.directory, "Suite.Test.js")),
    mkdir(path.join(fixture.directory, "Suite.Test.MJS")),
    mkdir(path.join(fixture.directory, "_headers")),
  ]);
  await Promise.all([
    writeFile(path.join(fixture.directory, "root.js"), "export {};\n"),
    writeFile(path.join(fixture.directory, "module.mjs"), "export {};\n"),
    writeFile(path.join(fixture.directory, "Module.MJS"), "export {};\n"),
    writeFile(path.join(fixture.directory, "Runtime.JS"), "export {};\n"),
    writeFile(path.join(fixture.directory, "root.test.js"), "throw new Error('not shipped');\n"),
    writeFile(path.join(fixture.directory, "root.TEST.JS"), "throw new Error('not shipped');\n"),
    writeFile(path.join(fixture.directory, "root.test.mjs"), "throw new Error('not shipped');\n"),
    writeFile(path.join(fixture.directory, "root.TEST.MJS"), "throw new Error('not shipped');\n"),
    writeFile(path.join(fixture.directory, "bundle.js.map"), "{}\n"),
    writeFile(path.join(fixture.directory, "bang!.js"), "export {};\n"),
    writeFile(path.join(fixture.directory, "paren().js"), "export {};\n"),
    writeFile(path.join(fixture.directory, "quote'.js"), "export {};\n"),
    writeFile(path.join(fixture.directory, "star*.js"), "export {};\n"),
    writeFile(path.join(fixture.directory, "nested tools", "runtime file.js"), "export {};\n"),
    writeFile(
      path.join(fixture.directory, "nested tools", "runtime.test.js"),
      "throw new Error('not shipped');\n",
    ),
    writeFile(
      path.join(fixture.directory, "nested tools", "runtime.TeSt.MjS"),
      "throw new Error('not shipped');\n",
    ),
    writeFile(path.join(fixture.directory, "Suite.Test.js", "runtime.js"), "export {};\n"),
    writeFile(path.join(fixture.directory, "Suite.Test.MJS", "runtime.MJS"), "export {};\n"),
    writeFile(path.join(fixture.directory, "_headers", "metadata.js"), "export {};\n"),
  ]);

  const { productionAssets, excludedJavaScriptAssetPaths } =
    await readPublicJavaScriptAssetInventory({ assetsDirectoryURL: fixture.url });
  assert.deepEqual([...productionAssets.keys()], [
    "/Module.MJS",
    "/Runtime.JS",
    "/bang%21.js",
    "/module.mjs",
    "/nested%20tools/runtime%20file.js",
    "/paren%28%29.js",
    "/quote%27.js",
    "/root.js",
    "/star%2A.js",
  ]);
  assert.deepEqual(excludedJavaScriptAssetPaths, [
    "/Suite.Test.MJS/runtime.MJS",
    "/Suite.Test.js/runtime.js",
    "/_headers/metadata.js",
    "/nested%20tools/runtime.TeSt.MjS",
    "/nested%20tools/runtime.test.js",
    "/root.TEST.JS",
    "/root.TEST.MJS",
    "/root.test.js",
    "/root.test.mjs",
  ]);
});

test("reviewed JavaScript paths are canonical, traversal-safe, and deployable", () => {
  for (const pathname of [
    "/app.js",
    "/Runtime.JS",
    "/nested/runtime.mjs",
    "/bang%21.js",
    "/unicode-%E2%9C%93.js",
  ]) assert.equal(isReviewedProductionJavaScriptPath(pathname), true, pathname);

  for (const pathname of [
    "/bang!.js",
    "/nested/%2E%2E/alias.js",
    "/nested/%2e%2e/alias.js",
    "/nested/%2F/alias.js",
    "/nested/%5C/alias.js",
    "/nested/%00/alias.js",
    "/suite.test.js/runtime.js",
    "/suite.test.mjs/runtime.js",
    "/runtime.TEST.MJS",
    "/_headers/runtime.js",
    "/runtime.cjs",
    "//runtime.js",
  ]) assert.equal(isReviewedProductionJavaScriptPath(pathname), false, pathname);

  for (const pathname of [
    "/runtime.test.js",
    "/runtime.TEST.MJS",
    "/nested/suite.test.mjs/runtime.js",
    "/_headers/runtime.MJS",
  ]) assert.equal(isReviewedExcludedJavaScriptPath(pathname), true, pathname);

  for (const pathname of [
    "/runtime.js",
    "/nested/%2E%2E/runtime.test.js",
    "/runtime.test.cjs",
    "/runtime.test.mjs?source",
  ]) assert.equal(isReviewedExcludedJavaScriptPath(pathname), false, pathname);
});

test("asset discovery requires the two reviewed recursive test exclusions", async (t) => {
  const fixture = await temporaryAssets(t);
  await writeFile(path.join(fixture.directory, "app.js"), "export {};\n");

  for (const policy of [
    "",
    "*.test.js",
    "*.test.js\n",
    "*.test.mjs\n",
    "*.test.mjs\n*.test.js\n",
    "*.test.js\n*.test.mjs",
    "**/*.test.js\n*.test.mjs\n",
    "*.test.js\n*.test.mjs\n!public.test.mjs\n",
    "*.test.js\n*.test.mjs\n\n",
  ]) {
    await writeFile(path.join(fixture.directory, ".assetsignore"), policy);
    await assert.rejects(
      readPublicJavaScriptAssets({ assetsDirectoryURL: fixture.url }),
      /\.assetsignore must contain exactly \*\.test\.js\s+\*\.test\.mjs/u,
    );
  }
});

test("asset discovery rejects symbolic links instead of silently changing the upload set", async (t) => {
  const fixture = await temporaryAssets(t);
  await writeFile(path.join(fixture.directory, "app.js"), "export {};\n");
  await symlink(path.join(fixture.directory, "app.js"), path.join(fixture.directory, "alias.js"));

  await assert.rejects(
    readPublicJavaScriptAssets({ assetsDirectoryURL: fixture.url }),
    /alias\.js must not be a symbolic-link asset/u,
  );
});

test("asset discovery exposes finite path, count, per-file, and aggregate ceilings", () => {
  assert.equal(PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES, 512 * 1024);
  assert.equal(PUBLIC_JAVASCRIPT_ASSET_MAX_COUNT, 64);
  assert.equal(PUBLIC_JAVASCRIPT_ASSET_MAX_TOTAL_BYTES, 4 * 1024 * 1024);
  assert.equal(PUBLIC_JAVASCRIPT_ASSET_PATH_MAX_BYTES, 512);
  assert.equal(PUBLIC_EXCLUDED_JAVASCRIPT_ASSET_MAX_COUNT, 128);
});

test("asset discovery rejects more than the reviewed number of scripts before reading them", async (t) => {
  const fixture = await temporaryAssets(t);
  await Promise.all(Array.from(
    { length: PUBLIC_JAVASCRIPT_ASSET_MAX_COUNT + 1 },
    (_, index) => writeFile(path.join(fixture.directory, `asset-${index}.js`), "export {};\n"),
  ));

  await assert.rejects(
    readPublicJavaScriptAssets({ assetsDirectoryURL: fixture.url }),
    /exceeds the reviewed 64-script boundary/u,
  );
});

test("asset discovery rejects more than the reviewed number of excluded scripts", async (t) => {
  const fixture = await temporaryAssets(t);
  await writeFile(path.join(fixture.directory, "app.js"), "export {};\n");
  await Promise.all(Array.from(
    { length: PUBLIC_EXCLUDED_JAVASCRIPT_ASSET_MAX_COUNT + 1 },
    (_, index) => writeFile(
      path.join(fixture.directory, `excluded-${index}.test.mjs`),
      "throw new Error('not shipped');\n",
    ),
  ));

  await assert.rejects(
    readPublicJavaScriptAssetInventory({ assetsDirectoryURL: fixture.url }),
    /exceeds the reviewed 128-excluded-script boundary/u,
  );
});

test("asset discovery rejects an oversized checked-out script", async (t) => {
  const fixture = await temporaryAssets(t);
  await writeFile(
    path.join(fixture.directory, "oversized.js"),
    " ".repeat(PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES + 1),
  );

  await assert.rejects(
    readPublicJavaScriptAssets({ assetsDirectoryURL: fixture.url }),
    /oversized\.js exceeds the reviewed JavaScript asset boundary/u,
  );
});

test("asset discovery rejects BOM and invalid UTF-8 instead of weakening byte equality", async (t) => {
  const fixture = await temporaryAssets(t);
  for (const [filename, bytes, expectedError] of [
    ["bom.js", new Uint8Array([0xef, 0xbb, 0xbf, 0x65]), /byte-order mark/u],
    ["invalid.js", new Uint8Array([0xc3, 0x28]), /not canonical UTF-8 JavaScript/u],
  ]) {
    await writeFile(path.join(fixture.directory, filename), bytes);
    await assert.rejects(
      readPublicJavaScriptAssets({ assetsDirectoryURL: fixture.url }),
      expectedError,
    );
    await rm(path.join(fixture.directory, filename));
  }
});

test("asset discovery rejects an oversized aggregate script generation", async (t) => {
  const fixture = await temporaryAssets(t);
  const source = " ".repeat(500 * 1024);
  await Promise.all(Array.from(
    { length: 9 },
    (_, index) => writeFile(path.join(fixture.directory, `asset-${index}.js`), source),
  ));

  await assert.rejects(
    readPublicJavaScriptAssets({ assetsDirectoryURL: fixture.url }),
    /exceeds the reviewed aggregate JavaScript boundary/u,
  );
});

test("asset discovery rejects an oversized encoded public path", async (t) => {
  const fixture = await temporaryAssets(t);
  const segment = "a".repeat(200);
  const nested = path.join(fixture.directory, segment, segment, segment);
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "runtime.js"), "export {};\n");

  await assert.rejects(
    readPublicJavaScriptAssets({ assetsDirectoryURL: fixture.url }),
    /exceeds the reviewed JavaScript asset-path boundary/u,
  );
});

test("asset discovery rejects empty, over-deep, invalid-adapter, and special-file inputs", async (t) => {
  const emptyFixture = await temporaryAssets(t);
  await assert.rejects(
    readPublicJavaScriptAssets({ assetsDirectoryURL: emptyFixture.url }),
    /contains no deployable JavaScript assets/u,
  );

  const deepFixture = await temporaryAssets(t);
  let deepDirectory = deepFixture.directory;
  for (let index = 0; index < 17; index += 1) {
    deepDirectory = path.join(deepDirectory, `d${index}`);
  }
  await mkdir(deepDirectory, { recursive: true });
  await writeFile(path.join(deepDirectory, "runtime.js"), "export {};\n");
  await assert.rejects(
    readPublicJavaScriptAssets({ assetsDirectoryURL: deepFixture.url }),
    /exceeds the reviewed asset-directory depth/u,
  );

  await assert.rejects(
    readPublicJavaScriptAssets({ assetsDirectoryURL: new URL("https://example.com/") }),
    /must be a file URL/u,
  );
  await assert.rejects(
    readPublicJavaScriptAssets({ assetsDirectoryURL: emptyFixture.url, readFileImpl: null }),
    /filesystem adapters must be functions/u,
  );
  await assert.rejects(
    readPublicJavaScriptAssets({
      assetsDirectoryURL: emptyFixture.url,
      readFileImpl: async (_pathname, encoding) => encoding === "utf8"
        ? "*.test.js\n*.test.mjs\n"
        : new Uint8Array(),
      readdirImpl: async () => [{
        name: "named-pipe",
        isSymbolicLink: () => false,
        isDirectory: () => false,
        isFile: () => false,
      }],
    }),
    /named-pipe has an unsupported asset type/u,
  );
});
