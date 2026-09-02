import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  PUBLIC_EXCLUDED_JAVASCRIPT_ASSET_MAX_COUNT,
  PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES,
  PUBLIC_JAVASCRIPT_ASSET_MAX_COUNT,
  PUBLIC_JAVASCRIPT_ASSET_MAX_TOTAL_BYTES,
  isReviewedExcludedJavaScriptPath,
  isReviewedProductionJavaScriptPath,
} from "./public-javascript-assets.mjs";

export const PUBLIC_EXCLUDED_JAVASCRIPT_ATTEMPTS = 8;
export const PUBLIC_EXCLUDED_JAVASCRIPT_RETRY_MS = 1_000;
export const PUBLIC_EXCLUDED_JAVASCRIPT_MAX_CONCURRENCY = 8;
export const PUBLIC_JAVASCRIPT_ASSET_MAX_CONCURRENCY = 8;
export const PUBLIC_MODULE_GRAPH_ATTEMPTS = 8;
export const PUBLIC_MODULE_GRAPH_RETRY_MS = 1_000;
export const PRODUCTION_SMOKE_BUDGET_MS = 180_000;
export { PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES };

const REQUIRED_PUBLIC_MODULE_PATHS = [
  "/app.js",
  "/coach-storage.js",
  "/coach-engine.js",
  "/setup-kits.js",
  "/microphone-selection.js",
  "/sound-cues.js",
];

const JAVASCRIPT_SYNTAX_TIMEOUT_MS = 5_000;
const utf8 = new TextEncoder();
const monotonicNow = () => performance.now();

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function validateDeadline(deadlineMs, now) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (deadlineMs !== Number.POSITIVE_INFINITY
    && (!Number.isFinite(deadlineMs) || deadlineMs < 0)) {
    throw new TypeError("deadlineMs must be a non-negative finite number or Infinity");
  }
}

function remainingDeadlineMs(deadlineMs, now) {
  if (deadlineMs === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  const currentTime = now();
  if (!Number.isFinite(currentTime)) throw new TypeError("now must return a finite number");
  const remainingMs = Math.floor(deadlineMs - currentTime);
  if (remainingMs < 1) {
    throw new Error("production smoke probe exceeded its shared deadline");
  }
  return remainingMs;
}

async function sleepWithinDeadline({ sleep, delayMs, deadlineMs, now }) {
  const remainingMs = remainingDeadlineMs(deadlineMs, now);
  const clampedDelayMs = Math.min(delayMs, remainingMs);
  await sleep(clampedDelayMs);
  if (clampedDelayMs < delayMs) {
    throw new Error("production smoke probe exceeded its shared deadline");
  }
  remainingDeadlineMs(deadlineMs, now);
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The validation error remains the useful failure when transport cleanup fails.
  }
}

function validateExcludedJavaScriptAssetPaths(pathnames) {
  if (!Array.isArray(pathnames)) {
    throw new TypeError("excludedJavaScriptAssetPaths must be an array");
  }
  if (pathnames.length > PUBLIC_EXCLUDED_JAVASCRIPT_ASSET_MAX_COUNT) {
    throw new TypeError("excludedJavaScriptAssetPaths exceeds the reviewed script-count boundary");
  }
  const uniquePaths = new Set();
  for (const pathname of pathnames) {
    if (!isReviewedExcludedJavaScriptPath(pathname)) {
      throw new TypeError(
        "excludedJavaScriptAssetPaths contains an invalid canonical ignored JavaScript path",
      );
    }
    if (uniquePaths.has(pathname)) {
      throw new TypeError("excludedJavaScriptAssetPaths must not contain duplicate paths");
    }
    uniquePaths.add(pathname);
  }
}

async function runSettledPathSweep({
  pathnames,
  visitPath,
  concurrency,
}) {
  const values = new Array(pathnames.length);
  const failures = new Array(pathnames.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, pathnames.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < pathnames.length) {
      const index = nextIndex;
      nextIndex += 1;
      const pathname = pathnames[index];
      try {
        values[index] = await visitPath(pathname);
      } catch (error) {
        failures[index] = asError(error);
      }
    }
  }));
  const firstFailure = failures.find((failure) => failure !== undefined);
  if (firstFailure) throw firstFailure;
  return values;
}

export async function waitForExcludedJavaScriptAssets({
  loadExcludedJavaScriptAsset,
  excludedJavaScriptAssetPaths,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = PUBLIC_EXCLUDED_JAVASCRIPT_ATTEMPTS,
  retryMs = PUBLIC_EXCLUDED_JAVASCRIPT_RETRY_MS,
  concurrency = PUBLIC_EXCLUDED_JAVASCRIPT_MAX_CONCURRENCY,
  deadlineMs = Number.POSITIVE_INFINITY,
  now = monotonicNow,
}) {
  if (typeof loadExcludedJavaScriptAsset !== "function") {
    throw new TypeError("loadExcludedJavaScriptAsset must be a function");
  }
  if (typeof sleep !== "function") {
    throw new TypeError("sleep must be a function");
  }
  if (!Number.isSafeInteger(attempts)
    || attempts < 1
    || attempts > PUBLIC_EXCLUDED_JAVASCRIPT_ATTEMPTS) {
    throw new TypeError(
      `attempts must be a safe integer from 1 through ${PUBLIC_EXCLUDED_JAVASCRIPT_ATTEMPTS}`,
    );
  }
  if (!Number.isSafeInteger(retryMs)
    || retryMs < 0
    || retryMs > PUBLIC_EXCLUDED_JAVASCRIPT_RETRY_MS) {
    throw new TypeError(
      `retryMs must be a safe integer from 0 through ${PUBLIC_EXCLUDED_JAVASCRIPT_RETRY_MS}`,
    );
  }
  if (!Number.isSafeInteger(concurrency)
    || concurrency < 1
    || concurrency > PUBLIC_EXCLUDED_JAVASCRIPT_MAX_CONCURRENCY) {
    throw new TypeError(
      `concurrency must be a safe integer from 1 through ${PUBLIC_EXCLUDED_JAVASCRIPT_MAX_CONCURRENCY}`,
    );
  }
  validateDeadline(deadlineMs, now);
  validateExcludedJavaScriptAssetPaths(excludedJavaScriptAssetPaths);
  const pathnames = [...excludedJavaScriptAssetPaths].sort();

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Complete every bounded sweep before deciding whether to retry. If an
      // edge briefly mixes releases, the next attempt rechecks the entire set.
      await runSettledPathSweep({
        pathnames,
        visitPath: async (pathname) => {
          const response = await loadExcludedJavaScriptAsset(
            pathname,
            remainingDeadlineMs(deadlineMs, now),
          );
          await assertExcludedJavaScriptResponse(response, pathname);
        },
        concurrency,
      });
      remainingDeadlineMs(deadlineMs, now);
      return pathnames;
    } catch (error) {
      lastError = asError(error);
    }
    if (attempt < attempts) {
      await sleepWithinDeadline({
        sleep,
        delayMs: attempt * retryMs,
        deadlineMs,
        now,
      });
    }
  }

  throw lastError || new Error("the excluded public JavaScript assets did not become ready");
}

export async function waitForPublicModuleGraph({
  loadJavaScriptAsset,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = PUBLIC_MODULE_GRAPH_ATTEMPTS,
  retryMs = PUBLIC_MODULE_GRAPH_RETRY_MS,
  expectedJavaScriptAssets = null,
  concurrency = PUBLIC_JAVASCRIPT_ASSET_MAX_CONCURRENCY,
  deadlineMs = Number.POSITIVE_INFINITY,
  now = monotonicNow,
}) {
  if (typeof loadJavaScriptAsset !== "function") {
    throw new TypeError("loadJavaScriptAsset must be a function");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError("attempts must be a positive safe integer");
  }
  if (!Number.isSafeInteger(retryMs) || retryMs < 0) {
    throw new TypeError("retryMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(concurrency)
    || concurrency < 1
    || concurrency > PUBLIC_JAVASCRIPT_ASSET_MAX_CONCURRENCY) {
    throw new TypeError(
      `concurrency must be a safe integer from 1 through ${PUBLIC_JAVASCRIPT_ASSET_MAX_CONCURRENCY}`,
    );
  }
  validateDeadline(deadlineMs, now);
  if (expectedJavaScriptAssets !== null) validateExpectedJavaScriptAssets(expectedJavaScriptAssets);
  const syntaxValidatedSources = new Map();
  if (expectedJavaScriptAssets !== null) {
    // Checked-out release syntax is deterministic. Validate it once before any
    // network retry so a local defect fails immediately and propagation retries
    // spend their budget only on changing edge observations.
    for (const [pathname, source] of expectedJavaScriptAssets) {
      assertJavaScriptModuleSyntax(
        pathname,
        source,
        Math.min(JAVASCRIPT_SYNTAX_TIMEOUT_MS, remainingDeadlineMs(deadlineMs, now)),
      );
      remainingDeadlineMs(deadlineMs, now);
      syntaxValidatedSources.set(pathname, source);
    }
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Fetch all assets on every attempt. A newly promoted Worker can briefly
      // expose two different static-asset generations at an edge, so validating
      // only one successful response can report a false deployment failure.
      const assetPaths = expectedJavaScriptAssets === null
        ? REQUIRED_PUBLIC_MODULE_PATHS
        : [...expectedJavaScriptAssets.keys()].sort();
      const observedSources = await runSettledPathSweep({
        pathnames: assetPaths,
        concurrency,
        visitPath: (pathname) => loadJavaScriptAsset(
          pathname,
          remainingDeadlineMs(deadlineMs, now),
        ),
      });
      const observedJavaScriptAssets = new Map(
        assetPaths.map((pathname, index) => [pathname, observedSources[index]]),
      );
      for (const [pathname, source] of observedJavaScriptAssets) {
        assertJavaScriptAssetBoundary(pathname, source);
        if (expectedJavaScriptAssets !== null) {
          assertExpectedJavaScriptAsset(expectedJavaScriptAssets, pathname, source);
        }
        if (syntaxValidatedSources.get(pathname) !== source) {
          assertJavaScriptModuleSyntax(
            pathname,
            source,
            Math.min(JAVASCRIPT_SYNTAX_TIMEOUT_MS, remainingDeadlineMs(deadlineMs, now)),
          );
          remainingDeadlineMs(deadlineMs, now);
          syntaxValidatedSources.set(pathname, source);
        }
      }
      const appSource = observedJavaScriptAssets.get("/app.js");
      const coachStorageSource = observedJavaScriptAssets.get("/coach-storage.js");
      const coachEngineSource = observedJavaScriptAssets.get("/coach-engine.js");
      const setupKitsSource = observedJavaScriptAssets.get("/setup-kits.js");
      const microphoneSelectionSource = observedJavaScriptAssets.get("/microphone-selection.js");
      const soundCuesSource = observedJavaScriptAssets.get("/sound-cues.js");
      const appTokens = tokenizeJavaScript(appSource);
      const coachStorageTokens = tokenizeJavaScript(coachStorageSource);
      const coachEngineTokens = tokenizeJavaScript(coachEngineSource);
      const setupKitsTokens = tokenizeJavaScript(setupKitsSource);
      const microphoneSelectionTokens = tokenizeJavaScript(microphoneSelectionSource);
      const soundCuesTokens = tokenizeJavaScript(soundCuesSource);
      if (!hasNamespaceModuleImport(
        appTokens,
        "./coach-storage.js",
        "coachingStorage",
      )) {
        throw new Error("/app.js does not reference the required coaching storage module");
      }
      if (!hasDynamicModuleLoader(
        appTokens,
        "loadCoachEngine",
        "coachEnginePromise",
        "./coach-engine.js",
      ) || !hasAwaitedFactoryAssignment(appTokens, "engine", "loadCoachEngine")
        || !hasAssignedObjectShorthand(appTokens, ["run", "coachingRun"], "engine")) {
        throw new Error("/app.js does not reference the required coaching engine module");
      }
      if (!hasMemberCall(appTokens, "assessCalibrationReadiness")) {
        throw new Error("/app.js does not consume the calibration-readiness boundary");
      }
      if (!hasNamedModuleImport(
        appTokens,
        "./setup-kits.js",
        "createSetupKitStore",
      )) {
        throw new Error("/app.js does not reference the required setup-kit module");
      }
      if (!hasAssignedFactoryCall(appTokens, "setupKitStore", "createSetupKitStore")) {
        throw new Error("/app.js does not consume the setup-kit storage boundary");
      }
      if (!hasNamedModuleImport(
        appTokens,
        "./microphone-selection.js",
        "createMicrophoneSelection",
      )) {
        throw new Error("/app.js does not reference the required microphone-selection module");
      }
      if (!hasAssignedFactoryCall(
        appTokens,
        "microphoneSelection",
        "createMicrophoneSelection",
      )) {
        throw new Error("/app.js does not consume the microphone-selection boundary");
      }
      if (!hasNamedModuleImport(
        appTokens,
        "./sound-cues.js",
        "createSoundCues",
      )) {
        throw new Error("/app.js does not reference the required sound-cue module");
      }
      if (!hasAssignedFactoryCall(appTokens, "soundCues", "createSoundCues")) {
        throw new Error("/app.js does not consume the sound-cue boundary");
      }
      if (!hasExportedFunction(coachStorageTokens, "openCoachDatabase", { async: true })) {
        throw new Error("/coach-storage.js does not expose the expected storage boundary");
      }
      if (!hasExportedFunction(coachEngineTokens, "assessCalibrationReadiness")) {
        throw new Error("/coach-engine.js does not expose assessCalibrationReadiness");
      }
      if (!hasExportedFunction(setupKitsTokens, "createSetupKitStore")) {
        throw new Error("/setup-kits.js does not expose createSetupKitStore");
      }
      if (!hasExportedFunction(microphoneSelectionTokens, "createMicrophoneSelection")) {
        throw new Error("/microphone-selection.js does not expose createMicrophoneSelection");
      }
      if (!hasExportedFunction(soundCuesTokens, "createSoundCues")) {
        throw new Error("/sound-cues.js does not expose createSoundCues");
      }
      remainingDeadlineMs(deadlineMs, now);
      return {
        observedJavaScriptAssets,
        appSource,
        coachStorageSource,
        coachEngineSource,
        setupKitsSource,
        microphoneSelectionSource,
        soundCuesSource,
      };
    } catch (error) {
      lastError = asError(error);
    }

    if (attempt < attempts) {
      await sleepWithinDeadline({
        sleep,
        delayMs: attempt * retryMs,
        deadlineMs,
        now,
      });
    }
  }

  throw lastError || new Error("the public JavaScript module graph did not become ready");
}

export function waitForExactPublicModuleGraph(options) {
  if (!options || !(options.expectedJavaScriptAssets instanceof Map)) {
    throw new TypeError("expectedJavaScriptAssets must be a Map of checked-out release sources");
  }
  return waitForPublicModuleGraph(options);
}

function assertJavaScriptModuleSyntax(pathname, source, timeoutMs = JAVASCRIPT_SYNTAX_TIMEOUT_MS) {
  const result = spawnSync(process.execPath, ["--check", "--input-type=module"], {
    input: source,
    encoding: "utf8",
    timeout: Math.max(1, Math.floor(timeoutMs)),
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${pathname} is not valid JavaScript module syntax`);
  }
}

function assertJavaScriptAssetBoundary(pathname, source) {
  if (typeof source !== "string" || utf8.encode(source).byteLength > PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES) {
    throw new Error(`${pathname} exceeds the reviewed JavaScript asset boundary`);
  }
}

function validateExpectedJavaScriptAssets(expected) {
  if (!(expected instanceof Map)) {
    throw new TypeError("expectedJavaScriptAssets must be a Map of checked-out release sources");
  }
  if (expected.size > PUBLIC_JAVASCRIPT_ASSET_MAX_COUNT) {
    throw new TypeError("expectedJavaScriptAssets exceeds the reviewed script-count boundary");
  }
  if (REQUIRED_PUBLIC_MODULE_PATHS.some((pathname) => !expected.has(pathname))) {
    throw new TypeError("expectedJavaScriptAssets must include every reviewed public module path");
  }
  let totalBytes = 0;
  for (const [pathname, source] of expected) {
    if (!isReviewedProductionJavaScriptPath(pathname)) {
      throw new TypeError("expectedJavaScriptAssets contains an invalid deployable JavaScript path");
    }
    assertJavaScriptAssetBoundary(pathname, source);
    totalBytes += utf8.encode(source).byteLength;
    if (totalBytes > PUBLIC_JAVASCRIPT_ASSET_MAX_TOTAL_BYTES) {
      throw new TypeError("expectedJavaScriptAssets exceeds the reviewed aggregate byte boundary");
    }
  }
}

function assertExpectedJavaScriptAsset(expected, pathname, observedSource) {
  if (observedSource !== expected.get(pathname)) {
    throw new Error(`${pathname} does not match the checked-out release source`);
  }
}

export async function readBoundedJavaScriptBody(response, pathname) {
  const declaredLength = response?.headers?.get?.("content-length");
  if (/^[0-9]+$/u.test(declaredLength || "")
    && Number(declaredLength) > PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${pathname} exceeds the reviewed JavaScript asset boundary`);
  }
  if (!response?.body || typeof response.body.getReader !== "function") {
    throw new Error(`${pathname} did not expose a readable JavaScript body`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let bytes = 0;
  let source = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${pathname} returned an invalid JavaScript body chunk`);
      }
      bytes += value.byteLength;
      if (bytes > PUBLIC_JAVASCRIPT_ASSET_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${pathname} exceeds the reviewed JavaScript asset boundary`);
      }
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
    return source;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof TypeError) {
      throw new Error(`${pathname} is not canonical UTF-8 JavaScript`);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readVerifiedJavaScriptResponse(response, pathname) {
  const mediaType = String(response?.headers?.get?.("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "text/javascript" && mediaType !== "application/javascript") {
    await cancelResponseBody(response);
    throw new Error(`${pathname} did not return JavaScript`);
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    await cancelResponseBody(response);
    throw new Error(`${pathname} is missing MIME-sniffing protection`);
  }
  const source = await readBoundedJavaScriptBody(response, pathname);
  if (source.charCodeAt(0) === 0xfeff) {
    throw new Error(`${pathname} must not contain a UTF-8 byte-order mark`);
  }
  if (source.trim().length === 0 || /^\s*(?:<!doctype\s+html|<html\b)/iu.test(source)) {
    throw new Error(`${pathname} returned an empty or HTML fallback document`);
  }
  return source;
}

export async function assertExcludedJavaScriptResponse(response, pathname) {
  const mediaType = String(response?.headers?.get?.("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const hasNoSniff = response?.headers?.get?.("x-content-type-options") === "nosniff";
  await cancelResponseBody(response);
  if (mediaType !== "text/html") {
    throw new Error(`${pathname} was not excluded from executable static assets`);
  }
  if (!hasNoSniff) {
    throw new Error(`${pathname} fallback is missing MIME-sniffing protection`);
  }
}

function hasNamespaceModuleImport(tokens, specifier, localBinding) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isIdentifier(tokens[index], "import") || !tokens[index].lineStart) continue;
    if (isPunctuator(tokens[index + 1], "*")
      && isIdentifier(tokens[index + 2], "as")
      && isIdentifier(tokens[index + 3], localBinding)
      && isIdentifier(tokens[index + 4], "from")
      && isString(tokens[index + 5], specifier)) return true;
  }
  return false;
}

function hasNamedModuleImport(tokens, specifier, importedBinding) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isIdentifier(tokens[index], "import")
      || !tokens[index].lineStart
      || !isPunctuator(tokens[index + 1], "{")) continue;
    let cursor = index + 2;
    let importsRequiredBinding = false;
    while (cursor < tokens.length && !isPunctuator(tokens[cursor], "}")) {
      if (isPunctuator(tokens[cursor], ",")) {
        cursor += 1;
        continue;
      }
      const imported = tokens[cursor];
      if (imported?.type !== "identifier" && imported?.type !== "string") break;
      cursor += 1;
      let local = imported;
      if (isIdentifier(tokens[cursor], "as")) {
        local = tokens[cursor + 1];
        cursor += 2;
      }
      if (isIdentifier(imported, importedBinding)
        && isIdentifier(local, importedBinding)) importsRequiredBinding = true;
      if (!isPunctuator(tokens[cursor], ",") && !isPunctuator(tokens[cursor], "}")) break;
    }
    if (importsRequiredBinding
      && isPunctuator(tokens[cursor], "}")
      && isIdentifier(tokens[cursor + 1], "from")
      && isString(tokens[cursor + 2], specifier)) return true;
  }
  return false;
}

function hasDynamicModuleLoader(tokens, loaderName, target, specifier) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isIdentifier(tokens[index], "function")
      || !tokens[index].lineStart
      || braceDepthAt(tokens, index) !== 0
      || !isIdentifier(tokens[index + 1], loaderName)
      || !isPunctuator(tokens[index + 2], "(")
      || !isPunctuator(tokens[index + 3], ")")
      || !isPunctuator(tokens[index + 4], "{")) continue;
    const close = findMatchingPunctuator(tokens, index + 4, "{", "}");
    if (close < 0) continue;
    let assignmentIndex = -1;
    let returnIndex = -1;
    let depth = 1;
    for (let cursor = index + 5; cursor < close; cursor += 1) {
      if (depth === 1
        && isIdentifier(tokens[cursor], target)
        && isPunctuator(tokens[cursor + 1], "|")
        && isPunctuator(tokens[cursor + 2], "|")
        && isPunctuator(tokens[cursor + 3], "=")
        && isIdentifier(tokens[cursor + 4], "import")
        && isPunctuator(tokens[cursor + 5], "(")
        && isString(tokens[cursor + 6], specifier)
        && isPunctuator(tokens[cursor + 7], ")")) assignmentIndex = cursor;
      if (depth === 1
        && isIdentifier(tokens[cursor], "return")
        && isIdentifier(tokens[cursor + 1], target)) returnIndex = cursor;
      if (isPunctuator(tokens[cursor], "{")) depth += 1;
      if (isPunctuator(tokens[cursor], "}")) depth -= 1;
    }
    if (assignmentIndex >= 0 && returnIndex > assignmentIndex) return true;
  }
  return false;
}

function hasAwaitedFactoryAssignment(tokens, localBinding, factoryName) {
  return tokens.some((token, index) => isIdentifier(token, "const")
    && token.lineStart
    && isIdentifier(tokens[index + 1], localBinding)
    && isPunctuator(tokens[index + 2], "=")
    && isIdentifier(tokens[index + 3], "await")
    && isIdentifier(tokens[index + 4], factoryName)
    && isPunctuator(tokens[index + 5], "(")
    && isPunctuator(tokens[index + 6], ")"));
}

function hasAssignedObjectShorthand(tokens, assignmentChain, propertyName) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isIdentifier(tokens[index], assignmentChain[0])
      || !tokens[index].lineStart) continue;
    let cursor = index;
    let matchesAssignment = true;
    for (const binding of assignmentChain) {
      if (!isIdentifier(tokens[cursor], binding) || !isPunctuator(tokens[cursor + 1], "=")) {
        matchesAssignment = false;
        break;
      }
      cursor += 2;
    }
    if (!matchesAssignment || !isPunctuator(tokens[cursor], "{")) continue;
    const close = findMatchingPunctuator(tokens, cursor, "{", "}");
    if (close < 0) continue;
    let depth = 1;
    for (let property = cursor + 1; property < close; property += 1) {
      const previous = tokens[property - 1];
      const next = tokens[property + 1];
      if (depth === 1
        && isIdentifier(tokens[property], propertyName)
        && (isPunctuator(previous, "{") || isPunctuator(previous, ","))
        && (isPunctuator(next, ",") || isPunctuator(next, "}"))) return true;
      if (isPunctuator(tokens[property], "{")) depth += 1;
      if (isPunctuator(tokens[property], "}")) depth -= 1;
    }
  }
  return false;
}

function findMatchingPunctuator(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (isPunctuator(tokens[index], open)) depth += 1;
    if (isPunctuator(tokens[index], close)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function braceDepthAt(tokens, end) {
  let depth = 0;
  for (let index = 0; index < end; index += 1) {
    if (isPunctuator(tokens[index], "{")) depth += 1;
    if (isPunctuator(tokens[index], "}")) depth -= 1;
  }
  return depth;
}

function hasMemberCall(tokens, name) {
  return tokens.some((token, index) => isIdentifier(token, name)
    && isPunctuator(tokens[index - 1], ".")
    && isIdentifier(tokens[index - 2], "engine")
    && isPunctuator(tokens[index - 3], ".")
    && isIdentifier(tokens[index - 4], "run")
    && isPunctuator(tokens[index - 5], "=")
    && isIdentifier(tokens[index - 6], "calibrationReadiness")
    && isPunctuator(tokens[index - 7], ".")
    && isIdentifier(tokens[index - 8], "run")
    && tokens[index - 8].lineStart
    && isPunctuator(tokens[index + 1], "("));
}

function hasAssignedFactoryCall(tokens, localBinding, factoryName) {
  return tokens.some((token, index) => isIdentifier(token, "const")
    && token.lineStart
    && braceDepthAt(tokens, index) === 0
    && isIdentifier(tokens[index + 1], localBinding)
    && isPunctuator(tokens[index + 2], "=")
    && isIdentifier(tokens[index + 3], factoryName)
    && isPunctuator(tokens[index + 4], "("));
}

function hasExportedFunction(tokens, name, { async = false } = {}) {
  return tokens.some((token, index) => {
    if (!isIdentifier(token, "export") || !token.lineStart) return false;
    let cursor = index + 1;
    if (async) {
      if (!isIdentifier(tokens[cursor], "async")) return false;
      cursor += 1;
    } else if (isIdentifier(tokens[cursor], "async")) {
      return false;
    }
    return isIdentifier(tokens[cursor], "function")
      && isIdentifier(tokens[cursor + 1], name)
      && isPunctuator(tokens[cursor + 2], "(");
  });
}

function isIdentifier(token, value) {
  return token?.type === "identifier" && token.value === value;
}

function isString(token, value) {
  return token?.type === "string" && token.value === value;
}

function isPunctuator(token, value) {
  return token?.type === "punctuator" && token.value === value;
}

// This deliberately small lexer recognizes the token shapes used by the
// reviewed browser modules while discarding comments, regular-expression
// bodies, and template text. It never evaluates downloaded production code.
function tokenizeJavaScript(source) {
  if (typeof source !== "string") return [];
  const tokens = [];

  const scanCode = (start, stopAtTemplateBrace = false) => {
    let index = start;
    let braceDepth = 0;
    while (index < source.length) {
      const character = source[index];
      const next = source[index + 1];
      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }
      if (character === "/" && next === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        const end = source.indexOf("*/", index + 2);
        index = end < 0 ? source.length : end + 2;
        continue;
      }
      if (character === "\"" || character === "'") {
        const quote = character;
        let value = "";
        index += 1;
        while (index < source.length) {
          if (source[index] === "\\") {
            value += "\uFFFD";
            index += Math.min(2, source.length - index);
          } else if (source[index] === quote) {
            index += 1;
            break;
          } else {
            value += source[index];
            index += 1;
          }
        }
        tokens.push({ type: "string", value });
        continue;
      }
      if (character === "`") {
        index = scanTemplate(index + 1);
        continue;
      }
      if (character === "/" && canStartRegularExpression(tokens.at(-1))) {
        index = skipRegularExpression(index + 1);
        continue;
      }
      if (isIdentifierStart(character)) {
        const begin = index;
        index += 1;
        while (index < source.length && isIdentifierPart(source[index])) index += 1;
        tokens.push({ type: "identifier", value: source.slice(begin, index), lineStart: isLineStart(begin) });
        continue;
      }
      if (/[0-9]/u.test(character)) {
        const begin = index;
        index += 1;
        while (index < source.length && /[A-Z0-9_.]/iu.test(source[index])) index += 1;
        tokens.push({ type: "number", value: source.slice(begin, index), lineStart: isLineStart(begin) });
        continue;
      }
      if (stopAtTemplateBrace && character === "}" && braceDepth === 0) return index + 1;
      if (stopAtTemplateBrace && character === "{") braceDepth += 1;
      if (stopAtTemplateBrace && character === "}" && braceDepth > 0) braceDepth -= 1;
      if ((character === "+" || character === "-") && next === character) {
        tokens.push({ type: "punctuator", value: `${character}${next}`, lineStart: isLineStart(index) });
        index += 2;
        continue;
      }
      tokens.push({ type: "punctuator", value: character, lineStart: isLineStart(index) });
      index += 1;
    }
    return index;
  };

  const scanTemplate = (start) => {
    let index = start;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += Math.min(2, source.length - index);
      } else if (source[index] === "`") {
        return index + 1;
      } else if (source[index] === "$" && source[index + 1] === "{") {
        index = scanCode(index + 2, true);
      } else {
        index += 1;
      }
    }
    return index;
  };

  const skipRegularExpression = (start) => {
    let index = start;
    let inCharacterClass = false;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += Math.min(2, source.length - index);
      } else if (source[index] === "[") {
        inCharacterClass = true;
        index += 1;
      } else if (source[index] === "]") {
        inCharacterClass = false;
        index += 1;
      } else if (source[index] === "/" && !inCharacterClass) {
        index += 1;
        while (index < source.length && /[a-z]/iu.test(source[index])) index += 1;
        return index;
      } else {
        index += 1;
      }
    }
    return index;
  };

  scanCode(0);
  return tokens;

  function isLineStart(index) {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (source[cursor] === "\n" || source[cursor] === "\r") return true;
      if (!/[\t\v\f ]/u.test(source[cursor])) return false;
    }
    return true;
  }
}

function canStartRegularExpression(previous) {
  if (!previous) return true;
  if (previous.type === "identifier") {
    return ["case", "do", "else", "in", "instanceof", "return", "throw", "typeof", "void", "yield"]
      .includes(previous.value);
  }
  return previous.type === "punctuator" && ![")", "]", "}", "++", "--"].includes(previous.value);
}

function isIdentifierStart(character) {
  return /[A-Z_$]/iu.test(character) || character.codePointAt(0) > 0x7f;
}

function isIdentifierPart(character) {
  return /[A-Z0-9_$]/iu.test(character) || character.codePointAt(0) > 0x7f;
}
