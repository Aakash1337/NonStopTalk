import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES = 512 * 1024;
export const PUBLIC_JAVASCRIPT_ASSET_MAX_COUNT = 64;
export const PUBLIC_JAVASCRIPT_ASSET_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const PUBLIC_JAVASCRIPT_ASSET_PATH_MAX_BYTES = 512;
export const PUBLIC_EXCLUDED_JAVASCRIPT_ASSET_MAX_COUNT = 128;
export const PUBLIC_JAVASCRIPT_TEST_SUFFIXES = Object.freeze([".test.js", ".test.mjs"]);

const PUBLIC_ASSETS_DIRECTORY_URL = new URL("../cloudflare/public/", import.meta.url);
const REQUIRED_ASSETS_IGNORE_RULE = PUBLIC_JAVASCRIPT_TEST_SUFFIXES
  .map((suffix) => `*${suffix}`)
  .join("\n");
const PUBLIC_ASSET_DIRECTORY_MAX_DEPTH = 16;
const WRANGLER_ROOT_METADATA_NAMES = new Set([".assetsignore", "_headers", "_redirects"]);
const JAVASCRIPT_EXTENSION = /\.(?:js|mjs)$/iu;
const JAVASCRIPT_TEST_NAME = /\.test\.(?:js|mjs)$/iu;
const utf8 = new TextEncoder();

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertAssetsIgnorePolicy(source) {
  if (source !== `${REQUIRED_ASSETS_IGNORE_RULE}\n`) {
    throw new Error(
      `cloudflare/public/.assetsignore must contain exactly ${REQUIRED_ASSETS_IGNORE_RULE}`,
    );
  }
}

export function encodePublicPathSegment(segment) {
  return encodeURIComponent(segment).replace(/[!'()*]/gu, (character) => (
    `%${character.codePointAt(0).toString(16).toUpperCase()}`
  ));
}

function publicPath(relativePath) {
  return `/${relativePath
    .split(path.sep)
    .map(encodePublicPathSegment)
    .join("/")}`;
}

function isIgnoredByWranglerPolicy(segments) {
  return WRANGLER_ROOT_METADATA_NAMES.has(segments[0]?.toLowerCase())
    || segments.some((segment) => JAVASCRIPT_TEST_NAME.test(segment));
}

function decodedCanonicalPathSegments(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.includes("//")) {
    return null;
  }
  const encodedSegments = pathname.slice(1).split("/");
  if (encodedSegments.length === 0 || encodedSegments.some((segment) => segment.length === 0)) {
    return null;
  }
  const decodedSegments = [];
  for (const encodedSegment of encodedSegments) {
    let decodedSegment;
    try {
      decodedSegment = decodeURIComponent(encodedSegment);
    } catch {
      return null;
    }
    if (decodedSegment === "." || decodedSegment === ".."
      || /[\\/\u0000-\u001f\u007f]/u.test(decodedSegment)
      || encodePublicPathSegment(decodedSegment) !== encodedSegment) {
      return null;
    }
    decodedSegments.push(decodedSegment);
  }
  return decodedSegments;
}

export function isReviewedProductionJavaScriptPath(pathname) {
  const segments = decodedCanonicalPathSegments(pathname);
  return segments !== null
    && utf8.encode(pathname).byteLength <= PUBLIC_JAVASCRIPT_ASSET_PATH_MAX_BYTES
    && JAVASCRIPT_EXTENSION.test(segments.at(-1))
    && !isIgnoredByWranglerPolicy(segments);
}

export function isReviewedExcludedJavaScriptPath(pathname) {
  const segments = decodedCanonicalPathSegments(pathname);
  return segments !== null
    && utf8.encode(pathname).byteLength <= PUBLIC_JAVASCRIPT_ASSET_PATH_MAX_BYTES
    && JAVASCRIPT_EXTENSION.test(segments.at(-1))
    && isIgnoredByWranglerPolicy(segments);
}

async function collectJavaScriptFiles({
  directory,
  relativeDirectory,
  depth,
  readdirImpl,
  productionFiles,
  excludedFiles,
}) {
  if (depth > PUBLIC_ASSET_DIRECTORY_MAX_DEPTH) {
    throw new Error("cloudflare/public exceeds the reviewed asset-directory depth");
  }

  const entries = await readdirImpl(directory, { withFileTypes: true });
  entries.sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? path.join(relativeDirectory, entry.name)
      : entry.name;
    const relativeSegments = relativePath.split(path.sep);
    const ignoredByWrangler = isIgnoredByWranglerPolicy(relativeSegments);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${publicPath(relativePath)} must not be a symbolic-link asset`);
    }
    if (entry.isDirectory()) {
      await collectJavaScriptFiles({
        directory: absolutePath,
        relativeDirectory: relativePath,
        depth: depth + 1,
        readdirImpl,
        productionFiles,
        excludedFiles,
      });
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`${publicPath(relativePath)} has an unsupported asset type`);
    }
    if (!JAVASCRIPT_EXTENSION.test(entry.name)) continue;
    const pathname = publicPath(relativePath);
    if (utf8.encode(pathname).byteLength > PUBLIC_JAVASCRIPT_ASSET_PATH_MAX_BYTES
      || decodedCanonicalPathSegments(pathname) === null) {
      throw new Error(`${pathname} exceeds the reviewed JavaScript asset-path boundary`);
    }
    if (ignoredByWrangler) {
      excludedFiles.push(pathname);
      if (excludedFiles.length > PUBLIC_EXCLUDED_JAVASCRIPT_ASSET_MAX_COUNT) {
        throw new Error(
          `cloudflare/public exceeds the reviewed ${PUBLIC_EXCLUDED_JAVASCRIPT_ASSET_MAX_COUNT}-excluded-script boundary`,
        );
      }
      continue;
    }
    productionFiles.push({ absolutePath, pathname });
    if (productionFiles.length > PUBLIC_JAVASCRIPT_ASSET_MAX_COUNT) {
      throw new Error(
        `cloudflare/public exceeds the reviewed ${PUBLIC_JAVASCRIPT_ASSET_MAX_COUNT}-script boundary`,
      );
    }
  }
}

export async function readPublicJavaScriptAssetInventory({
  assetsDirectoryURL = PUBLIC_ASSETS_DIRECTORY_URL,
  readFileImpl = readFile,
  readdirImpl = readdir,
} = {}) {
  if (!(assetsDirectoryURL instanceof URL) || assetsDirectoryURL.protocol !== "file:") {
    throw new TypeError("assetsDirectoryURL must be a file URL");
  }
  if (typeof readFileImpl !== "function" || typeof readdirImpl !== "function") {
    throw new TypeError("asset filesystem adapters must be functions");
  }

  const assetsDirectory = fileURLToPath(assetsDirectoryURL);
  assertAssetsIgnorePolicy(
    await readFileImpl(path.join(assetsDirectory, ".assetsignore"), "utf8"),
  );

  const productionFiles = [];
  const excludedFiles = [];
  await collectJavaScriptFiles({
    directory: assetsDirectory,
    relativeDirectory: "",
    depth: 0,
    readdirImpl,
    productionFiles,
    excludedFiles,
  });
  productionFiles.sort((left, right) => compareCodeUnits(left.pathname, right.pathname));
  excludedFiles.sort(compareCodeUnits);
  if (productionFiles.length === 0) {
    throw new Error("cloudflare/public contains no deployable JavaScript assets");
  }

  const assets = new Map();
  let totalBytes = 0;
  for (const { absolutePath, pathname } of productionFiles) {
    const sourceBytes = await readFileImpl(absolutePath);
    if (!(sourceBytes instanceof Uint8Array)
      || sourceBytes.byteLength > PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES) {
      throw new Error(`${pathname} exceeds the reviewed JavaScript asset boundary`);
    }
    totalBytes += sourceBytes.byteLength;
    if (totalBytes > PUBLIC_JAVASCRIPT_ASSET_MAX_TOTAL_BYTES) {
      throw new Error("cloudflare/public exceeds the reviewed aggregate JavaScript boundary");
    }
    if (sourceBytes[0] === 0xef && sourceBytes[1] === 0xbb && sourceBytes[2] === 0xbf) {
      throw new Error(`${pathname} must not contain a UTF-8 byte-order mark`);
    }
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(sourceBytes);
    } catch {
      throw new Error(`${pathname} is not canonical UTF-8 JavaScript`);
    }
    assets.set(pathname, source);
  }
  return { productionAssets: assets, excludedJavaScriptAssetPaths: excludedFiles };
}

export async function readPublicJavaScriptAssets(options) {
  return (await readPublicJavaScriptAssetInventory(options)).productionAssets;
}
