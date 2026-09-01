import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_LOG_LIMIT = 64 * 1024;
const childSettlements = new WeakMap();
const CHILD_ENV_PASSTHROUGH = new Set([
  "COLORTERM", "COMSPEC", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH",
  "PATHEXT", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR", "TZ", "WINDIR",
]);
const FORCED_CHILD_ENV = new Set([
  "CI", "CLOUDFLARE_CF_FETCH_ENABLED", "CLOUDFLARE_INCLUDE_PROCESS_ENV",
  "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", "NO_COLOR",
  "WRANGLER_SEND_ERROR_REPORTS", "WRANGLER_SEND_METRICS",
]);
const EXPLICIT_SENSITIVE_CHILD_ENV = new Set([
  "ANALYTICS_ADMIN_TOKEN", "ANTHROPIC_API_KEY", "CF_ACCOUNT_ID", "CF_API_KEY",
  "CF_API_TOKEN", "CLOUDFLARE_ACCESS_CLIENT_ID", "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_USER_SERVICE_KEY", "CLOUDFLARE_EMAIL", "GEMINI_API_KEY",
  "GH_TOKEN", "GITHUB_TOKEN", "GOOGLE_API_KEY", "IDENTITY_HASH_KEY",
  "NODE_AUTH_TOKEN", "NPM_TOKEN", "ROOM_FACT_HASH_KEY", "TOPIC_ESCALATION_PROVIDER",
  "TOPIC_ROUTINE_PROVIDER", "WRANGLER_CF_AUTHORIZATION_TOKEN", "ZAI_API_KEY",
]);

function isSensitiveEnvName(name) {
  const normalized = name.toUpperCase();
  return EXPLICIT_SENSITIVE_CHILD_ENV.has(normalized)
    || /(?:^|_)(?:API_KEY|API_TOKEN|AUTHORIZATION_TOKEN|CLIENT_SECRET|HASH_KEY|PASSWORD|SECRET|SERVICE_KEY|TOKEN)$/u
      .test(normalized);
}

export function isolatedChildEnv(extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (CHILD_ENV_PASSTHROUGH.has(name.toUpperCase())) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    const normalized = name.toUpperCase();
    if (!isSensitiveEnvName(name) && !FORCED_CHILD_ENV.has(normalized)) env[name] = value;
  }
  return {
    ...env,
    CI: "1",
    NO_COLOR: "1",
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_SEND_METRICS: "false",
  };
}

export function captureBoundedOutput(child, limit = DEFAULT_LOG_LIMIT) {
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-limit);
    });
  }
  return () => output.trim();
}

export function startCaptured(command, args, options = {}) {
  if (process.platform === "win32") {
    throw new Error(
      "Verified process-tree cleanup is unavailable on native Windows; run this smoke in WSL, Linux, or macOS.",
    );
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  observeChild(child);
  const output = captureBoundedOutput(child, options.logLimit);
  return { child, output };
}

function observeChild(child) {
  if (!child) return undefined;
  const existing = childSettlements.get(child);
  if (existing) return existing;
  if (child.exitCode !== null || child.signalCode !== null) {
    const settled = Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    childSettlements.set(child, settled);
    return settled;
  }
  let spawnError;
  const settlement = new Promise((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal, error: spawnError }));
  });
  childSettlements.set(child, settlement);
  return settlement;
}

function waitForExit(child) {
  return observeChild(child)
    ?? Promise.resolve({ code: null, signal: null });
}

function abortError(signal, label = "Operation") {
  return signal?.reason instanceof Error ? signal.reason : new Error(`${label} was aborted.`);
}

function abortWatcher(signal) {
  let listener;
  return {
    promise: signal
      ? new Promise((resolve) => {
          listener = () => resolve({ aborted: true });
          if (signal.aborted) listener();
          else signal.addEventListener("abort", listener, { once: true });
        })
      : new Promise(() => {}),
    dispose() {
      if (listener) signal?.removeEventListener("abort", listener);
    },
  };
}

function timeoutWatcher(timeoutMs) {
  let timer;
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    }),
    dispose() { clearTimeout(timer); },
  };
}

async function settleWithin(promise, timeoutMs) {
  const timeout = timeoutWatcher(timeoutMs);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    timeout.dispose();
  }
}

function processGroupExists(processGroupId) {
  if (!Number.isSafeInteger(processGroupId)) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function processGroupHasLiveMember(processGroupId) {
  if (!processGroupExists(processGroupId)) return false;
  if (process.platform !== "linux") return true;

  let foundGroupMember = false;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      let stat;
      try {
        stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch {
        continue;
      }
      const close = stat.lastIndexOf(")");
      if (close < 0) continue;
      const fields = stat.slice(close + 2).trim().split(/\s+/u);
      const state = fields[0];
      const group = Number(fields[2]);
      if (group !== processGroupId) continue;
      foundGroupMember = true;
      if (state !== "Z" && state !== "X") return true;
    }
  } catch {
    return true;
  }
  return foundGroupMember ? false : processGroupExists(processGroupId);
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupHasLiveMember(processGroupId)) return true;
    await delay(25);
  }
  return !processGroupHasLiveMember(processGroupId);
}

async function signalPosixProcessGroup(processGroupId, signal) {
  if (!processGroupHasLiveMember(processGroupId)) return;
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function terminateProcessTree(child, graceMs = 5_000) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    throw new Error("Verified process-tree cleanup is unavailable on native Windows.");
  }

  const processGroupId = child.pid;
  const exited = waitForExit(child);
  await signalPosixProcessGroup(processGroupId, "SIGTERM");
  if (!(await waitForProcessGroupExit(processGroupId, graceMs))) {
    await signalPosixProcessGroup(processGroupId, "SIGKILL");
    if (!(await waitForProcessGroupExit(processGroupId, graceMs))) {
      throw new Error(`Process group ${processGroupId} survived SIGKILL.`);
    }
  }
  const result = await settleWithin(exited.then(() => ({ exited: true })), graceMs);
  if (!result.exited && child.exitCode === null && child.signalCode === null) {
    throw new Error(`Child process ${child.pid} did not settle after its process group exited.`);
  }
}

function processTreeCleanupError(primaryError, cleanupError) {
  const aggregate = new AggregateError(
    [primaryError, cleanupError],
    "The command failed and its process tree could not be reaped.",
  );
  aggregate.code = "ERR_PROCESS_TREE_CLEANUP";
  return aggregate;
}

async function terminateForFailure(child, primaryError) {
  try {
    await terminateProcessTree(child);
  } catch (cleanupError) {
    throw processTreeCleanupError(primaryError, cleanupError);
  }
  throw primaryError;
}

export async function runChecked(command, args, options = {}) {
  if (options.signal?.aborted) throw abortError(options.signal, options.label || command);
  const { child, output } = startCaptured(command, args, options);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const timeout = timeoutWatcher(timeoutMs);
  const abort = abortWatcher(options.signal);
  let result;
  try {
    result = await Promise.race([
      waitForExit(child).then((outcome) => ({ outcome })),
      timeout.promise,
      abort.promise,
    ]);
  } finally {
    timeout.dispose();
    abort.dispose();
  }
  if (result.aborted) {
    await terminateForFailure(child, abortError(options.signal, options.label || command));
  }
  if (result.timeout) {
    await terminateForFailure(
      child,
      new Error(`${options.label || command} exceeded its ${timeoutMs}ms deadline.\n${output()}`.trim()),
    );
  }
  if (result.outcome.error) throw result.outcome.error;
  if (processGroupHasLiveMember(child.pid)) {
    try {
      await terminateProcessTree(child);
    } catch (cleanupError) {
      throw processTreeCleanupError(
        new Error(`${options.label || command} exited but left a live process-group descendant.`),
        cleanupError,
      );
    }
  }
  if (result.outcome.code !== 0) {
    throw new Error(
      `${options.label || command} failed with exit ${String(result.outcome.code)}${result.outcome.signal ? ` (${result.outcome.signal})` : ""}.\n${output()}`.trim(),
    );
  }
  return output();
}

export async function getFreePort(signal) {
  if (signal?.aborted) throw abortError(signal, "Port allocation");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      server.removeListener("error", onError);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const closeAfterPendingListen = () => {
      try {
        server.close(() => undefined);
      } catch (error) {
        if (error?.code !== "ERR_SERVER_NOT_RUNNING") throw error;
      }
    };
    const onAbort = () => {
      if (!server.listening) server.once("listening", closeAfterPendingListen);
      else closeAfterPendingListen();
      rejectOnce(abortError(signal, "Port allocation"));
    };
    const onError = (error) => rejectOnce(error);
    signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) rejectOnce(error);
        else if (signal?.aborted) rejectOnce(abortError(signal, "Port allocation"));
        else resolveOnce(address.port);
      });
    });
  });
}

export async function waitForJsonReadiness(url, child, output, accept, timeoutMs = 60_000, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal, "Wrangler readiness");
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Wrangler exited before readiness (${String(child.exitCode ?? child.signalCode)}).`);
    }
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(2_000)])
          : AbortSignal.timeout(2_000),
      });
      const payload = await response.json();
      if (accept(response, payload)) return payload;
      lastFailure = `HTTP ${response.status} returned an unexpected readiness shape`;
    } catch (error) {
      if (signal?.aborted) throw abortError(signal, "Wrangler readiness");
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    try {
      await delay(200, undefined, signal ? { signal } : undefined);
    } catch {
      throw abortError(signal, "Wrangler readiness");
    }
  }
  throw new Error(`Wrangler did not become ready: ${lastFailure}.\n${output()}`.trim());
}

export function isAddressInUse(output) {
  return /\bEADDRINUSE\b|address already in use/iu.test(output);
}
