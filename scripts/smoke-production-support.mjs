export const PUBLIC_MODULE_GRAPH_ATTEMPTS = 8;
export const PUBLIC_MODULE_GRAPH_RETRY_MS = 1_000;

const COACH_STORAGE_IMPORT = /\bfrom\s+["']\.\/coach-storage\.js["']/u;
const COACH_STORAGE_EXPORT = "export async function openCoachDatabase";
const COACH_ENGINE_IMPORT = /\bimport\(\s*["']\.\/coach-engine\.js["']\s*\)/u;
const COACH_ENGINE_EXPORT = /\bexport\s+function\s+assessCalibrationReadiness\s*\(/u;

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

export async function waitForPublicModuleGraph({
  loadJavaScriptAsset,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = PUBLIC_MODULE_GRAPH_ATTEMPTS,
  retryMs = PUBLIC_MODULE_GRAPH_RETRY_MS,
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

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Fetch all assets on every attempt. A newly promoted Worker can briefly
      // expose two different static-asset generations at an edge, so validating
      // only one successful response can report a false deployment failure.
      const [appSource, coachStorageSource, coachEngineSource] = await Promise.all([
        loadJavaScriptAsset("/app.js"),
        loadJavaScriptAsset("/coach-storage.js"),
        loadJavaScriptAsset("/coach-engine.js"),
      ]);
      if (!COACH_STORAGE_IMPORT.test(appSource)) {
        throw new Error("/app.js does not reference the required coaching storage module");
      }
      if (!COACH_ENGINE_IMPORT.test(appSource)) {
        throw new Error("/app.js does not reference the required coaching engine module");
      }
      if (!coachStorageSource.includes(COACH_STORAGE_EXPORT)) {
        throw new Error("/coach-storage.js does not expose the expected storage boundary");
      }
      if (!COACH_ENGINE_EXPORT.test(coachEngineSource)) {
        throw new Error("/coach-engine.js does not expose assessCalibrationReadiness");
      }
      return { appSource, coachStorageSource, coachEngineSource };
    } catch (error) {
      lastError = asError(error);
    }

    if (attempt < attempts) {
      await sleep(attempt * retryMs);
    }
  }

  throw lastError || new Error("the public JavaScript module graph did not become ready");
}
