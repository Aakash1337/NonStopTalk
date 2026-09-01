import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  getFreePort,
  isAddressInUse,
  isolatedChildEnv,
  runChecked,
  startCaptured,
  terminateProcessTree,
  waitForJsonReadiness,
} from "./smoke-process-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const WHOLE_SMOKE_TIMEOUT_MS = 180_000;
const TOPIC = "A deterministic smoke-test topic";

function boundedMessage(value) {
  return String(value instanceof Error ? value.message : value).slice(0, 500);
}

function abortReason(signal, label = "Operation") {
  return signal?.reason instanceof Error ? signal.reason : new Error(`${label} was aborted.`);
}

function throwIfAborted(signal, label) {
  if (signal?.aborted) throw abortReason(signal, label);
}

function aggregateFailure(primaryError, cleanupErrors, message) {
  if (cleanupErrors.length === 0) return primaryError;
  const errors = primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors;
  return new AggregateError(errors, message);
}

function processTreeCleanupFailure(primaryError, cleanupError) {
  const aggregate = new AggregateError(
    [primaryError, cleanupError],
    "Wrangler failed and its process tree could not be reaped.",
  );
  aggregate.code = "ERR_PROCESS_TREE_CLEANUP";
  return aggregate;
}

function containsErrorCode(error, code) {
  if (!error || typeof error !== "object") return false;
  if (error.code === code) return true;
  if (error instanceof AggregateError) {
    return [...error.errors].some((nested) => containsErrorCode(nested, code));
  }
  return containsErrorCode(error.cause, code);
}

function browserEnvironment() {
  const displayEnvironment = {};
  for (const name of [
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
  ]) {
    if (process.env[name] !== undefined) displayEnvironment[name] = process.env[name];
  }
  return isolatedChildEnv(displayEnvironment);
}

async function launchBrowser(signal) {
  const chromiumSandbox = process.getuid?.() === 0 ? false : undefined;
  const attempts = [{}, { channel: "chrome" }, { channel: "msedge" }];
  if (process.env.SMOKE_CHROMIUM) attempts.unshift({ executablePath: process.env.SMOKE_CHROMIUM });
  let lastError;
  for (const attempt of attempts) {
    throwIfAborted(signal, "Browser launch");
    let browser;
    try {
      browser = await chromium.launch({
        headless: process.env.HEADED !== "1",
        chromiumSandbox,
        env: browserEnvironment(),
        handleSIGHUP: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        timeout: 20_000,
        ...attempt,
      });
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal, "Browser launch");
      lastError = error;
      continue;
    }
    if (!signal?.aborted) return browser;
    const primaryError = abortReason(signal, "Browser launch");
    try {
      await browser.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Browser launch was aborted and the browser could not be closed.",
      );
    }
    throw primaryError;
  }
  throw lastError;
}

function trackBrowser(page, label) {
  const pageErrors = [];
  const socketErrors = [];
  const sockets = [];
  page.on("pageerror", (error) => pageErrors.push(`${label}: ${boundedMessage(error)}`));
  page.on("websocket", (socket) => {
    const entry = { url: socket.url(), frames: 0 };
    sockets.push(entry);
    socket.on("framereceived", () => { entry.frames += 1; });
    socket.on("socketerror", (error) => socketErrors.push(`${label}: ${boundedMessage(error)}`));
  });
  return { pageErrors, socketErrors, sockets };
}

async function eventually(check, label, signal, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    throwIfAborted(signal, label);
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    try {
      await delay(50, undefined, signal ? { signal } : undefined);
    } catch {
      throw abortReason(signal, label);
    }
  }
  throw new Error(`${label}${lastError ? `: ${boundedMessage(lastError)}` : ""}`);
}

async function waitForSocket(tracker, code, signal, previousCount = 0) {
  return eventually(
    () => {
      const matching = tracker.sockets.filter((socket) => {
        try {
          return new URL(socket.url).pathname === `/api/rooms/${code}/socket`;
        } catch {
          return false;
        }
      });
      return matching.slice(previousCount).some((socket) => socket.frames > 0) ? matching.length : 0;
    },
    `WebSocket state for room ${code} did not arrive`,
    signal,
  );
}

async function readRoom(page, code) {
  return page.evaluate(async (roomCode) => {
    const response = await fetch(`/api/rooms/${roomCode}/state`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    return { status: response.status, payload: await response.json() };
  }, code);
}

async function unauthorizedSettingsProbe(page, code) {
  return page.evaluate(async (roomCode) => {
    const getState = async () => {
      const response = await fetch(`/api/rooms/${roomCode}/state`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      return response.json();
    };
    const before = await getState();
    const response = await fetch(`/api/rooms/${roomCode}/action`, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "settings",
        duration: 300,
        silence: 10,
        rounds: 10,
        topicPack: "debate",
      }),
    });
    const error = await response.json();
    const after = await getState();
    return {
      status: response.status,
      error: error.error,
      beforeVersion: before.room?.version,
      afterVersion: after.room?.version,
      beforeSettings: before.room?.settings,
      afterSettings: after.room?.settings,
    };
  }, code);
}

async function runBrowserFlow(origin, signal) {
  throwIfAborted(signal, "Browser flow");
  const browser = await launchBrowser(signal);
  let hostContext;
  let guestContext;
  let failure;
  let browserClosePromise;
  const closeBrowser = () => {
    if (!browserClosePromise) {
      browserClosePromise = browser.close();
      void browserClosePromise.catch(() => undefined);
    }
    return browserClosePromise;
  };
  const onAbort = () => { closeBrowser(); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal, "Browser flow");
    hostContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const hostTracker = trackBrowser(host, "host");
    const guestTracker = trackBrowser(guest, "guest");
    for (const page of [host, guest]) {
      page.setDefaultTimeout(12_000);
      page.setDefaultNavigationTimeout(20_000);
    }

    await host.goto(origin, { waitUntil: "domcontentloaded" });
    const create = host.locator("[data-create-room]");
    await create.locator("input[name='name']").fill("Cloud Host");
    await create.getByRole("button", { name: "Create room" }).click();
    await host.waitForURL(/\/room\/[A-HJ-NP-Z2-9]{6}$/u);
    const code = new URL(host.url()).pathname.split("/").at(-1);
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/u);
    await host.getByRole("heading", { level: 1, name: `Room ${code}` }).waitFor();
    await waitForSocket(hostTracker, code, signal);

    await guest.goto(`${origin}/room/${code}`, { waitUntil: "domcontentloaded" });
    await guest.getByRole("heading", { name: "Take a seat." }).waitFor();
    const join = guest.locator("[data-join-current-room]");
    await join.locator("input[name='name']").fill("Cloud Guest");
    await join.getByRole("button", { name: "Join room" }).click();
    await guest.getByLabel("Rename Cloud Guest").waitFor();
    await waitForSocket(guestTracker, code, signal);
    await host.getByLabel("Rename Cloud Guest").waitFor();
    await host.getByRole("button", { name: "Make Cloud Guest the host" }).waitFor();

    const hostCookie = (await hostContext.cookies(origin)).find((cookie) => cookie.name === "nonstoptalk_token");
    const guestCookie = (await guestContext.cookies(origin)).find((cookie) => cookie.name === "nonstoptalk_token");
    assert.ok(hostCookie?.httpOnly && guestCookie?.httpOnly, "Both browser identities must use HttpOnly cookies.");
    assert.ok(hostCookie.value !== guestCookie.value,
      "Host and guest browser contexts must have distinct identities.");

    assert.equal(await guest.locator("form.settings").count(), 0);
    assert.equal(await guest.locator("[data-model-topics]").count(), 0);
    assert.equal(await guest.getByLabel("Custom topics, one per line").count(), 0);
    assert.equal(await guest.getByLabel("Local player").count(), 0);
    assert.equal(await guest.getByRole("button", { name: "Start game" }).count(), 0);

    const unauthorized = await unauthorizedSettingsProbe(guest, code);
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.error, "Only the host can do that.");
    assert.equal(unauthorized.afterVersion, unauthorized.beforeVersion,
      "A rejected guest action must not advance the room version.");
    assert.deepEqual(unauthorized.afterSettings, unauthorized.beforeSettings,
      "A rejected guest action must not change room settings.");

    const settings = host.locator("form.settings");
    await settings.getByLabel("Talk time (seconds)").fill("10");
    await settings.getByLabel("Silence limit").fill("1");
    await settings.getByLabel("Rounds").fill("1");
    await settings.getByRole("button", { name: "Apply settings" }).click();
    await eventually(async () => {
      const summary = await guest.locator(".panel.wide .grid").textContent();
      return summary?.includes("Talk time10s")
        && summary.includes("Silence limit1s")
        && summary.includes("Rounds1");
    }, "Guest settings DOM did not update over WebSocket", signal);
    await eventually(async () => {
      const state = await readRoom(guest, code);
      return state.status === 200
        && state.payload.room?.settings?.duration === 10
        && state.payload.room?.settings?.silence === 1
        && state.payload.room?.settings?.rounds === 1;
    }, "Guest did not receive host settings", signal);

    await host.getByLabel("Custom topics, one per line").fill(TOPIC);
    await host.getByRole("button", { name: "Use custom list" }).click();
    await eventually(async () => {
      const [hostState, guestState] = await Promise.all([readRoom(host, code), readRoom(guest, code)]);
      return hostState.payload.room?.settings?.topicPack === "custom"
        && hostState.payload.room?.topicCount === 1
        && hostState.payload.room?.topics?.length === 1
        && hostState.payload.room.topics[0] === TOPIC
        && guestState.payload.room?.topicCount === 1
        && guestState.payload.room?.topics?.length === 0;
    }, "Custom-topic privacy state did not converge", signal);

    await host.getByRole("button", { name: "Start game" }).click();
    await Promise.all([
      host.getByRole("heading", { name: "Cloud Host is up." }).waitFor(),
      guest.getByRole("heading", { name: "Cloud Host is up." }).waitFor(),
    ]);
    assert.equal(await guest.getByRole("button", { name: "Start game" }).count(), 0);

    await host.getByRole("button", { name: "Draw topic" }).click();
    await Promise.all([
      host.locator(".turn-card .room-state-title").filter({ hasText: TOPIC }).waitFor(),
      guest.locator(".turn-card .room-state-title").filter({ hasText: TOPIC }).waitFor(),
    ]);
    assert.match(await guest.locator(".turn-card").textContent(), /The score arrives when the turn ends\./u);
    assert.equal(await guest.getByRole("button", { name: "Manual timer" }).count(), 0);
    assert.equal(await guest.getByRole("button", { name: "Mark complete" }).count(), 0);

    await host.getByRole("button", { name: "Mark complete" }).click();
    await Promise.all([
      eventually(() => host.locator(".score-callout").textContent().then((text) => text?.trim() === "Cloud Host earned 35 points"),
        "Host score did not render", signal),
      eventually(() => guest.locator(".score-callout").textContent().then((text) => text?.trim() === "Cloud Host earned 35 points"),
        "Guest score did not converge", signal),
    ]);
    assert.match(await host.locator(".panel.wide").first().textContent(), /10 of 10 seconds.*25-point completion bonus/su);
    const hostScore = host.locator(".score-row").filter({ hasText: "Cloud Host" }).locator(":scope > span").nth(1);
    assert.equal((await hostScore.textContent())?.trim(), "35 pts");

    const socketCountBeforeReload = hostTracker.sockets
      .filter((socket) => new URL(socket.url).pathname === `/api/rooms/${code}/socket`).length;
    await host.reload({ waitUntil: "domcontentloaded" });
    await eventually(() => host.locator(".score-callout").textContent().then((text) => text?.trim() === "Cloud Host earned 35 points"),
      "Host score did not survive reload", signal);
    await waitForSocket(hostTracker, code, signal, socketCountBeforeReload);
    const persisted = await readRoom(host, code);
    assert.equal(persisted.status, 200);
    assert.equal(persisted.payload.room?.phase, "playing");
    assert.equal(persisted.payload.room?.activeTurn, null);
    assert.equal(persisted.payload.room?.completedTurns?.length, 1);
    assert.equal(persisted.payload.room?.completedTurns?.[0]?.score, 35);

    await guest.getByRole("button", { name: "Next turn" }).click();
    await Promise.all([
      eventually(() => guest.locator(".turn-meta").textContent().then((text) => text?.includes("Cloud Guest (you)")),
        "Guest did not become the active speaker", signal),
      eventually(() => host.locator(".turn-meta").textContent().then((text) => text?.includes("Cloud Guest")),
        "Host did not receive the guest turn", signal),
    ]);
    assert.equal((await guest.locator(".turn-card .room-state-title").textContent())?.trim(), TOPIC);
    assert.equal((await host.locator(".turn-card .room-state-title").textContent())?.trim(), TOPIC);

    await guest.getByRole("button", { name: "Manual timer" }).click();
    const endTurn = guest.getByRole("button", { name: "End turn" });
    await endTurn.waitFor();
    await endTurn.click();
    await Promise.all([
      host.locator(".winner").waitFor(),
      guest.locator(".winner").waitFor(),
    ]);
    assert.equal((await host.locator(".winner .room-state-title").textContent())?.trim(), "Cloud Host");
    assert.equal((await guest.locator(".winner .room-state-title").textContent())?.trim(), "Cloud Host");
    assert.equal((await host.locator(".winner .score-callout").textContent())?.trim(), "35 points");
    assert.equal((await guest.locator(".winner .score-callout").textContent())?.trim(), "35 points");
    const finished = await readRoom(host, code);
    assert.equal(finished.payload.room?.phase, "finished");
    assert.equal(finished.payload.room?.activeTurn, null);
    assert.equal(finished.payload.room?.completedTurns?.length, 2);
    assert.equal(finished.payload.room?.winner?.name, "Cloud Host");

    assert.deepEqual(hostTracker.pageErrors, []);
    assert.deepEqual(guestTracker.pageErrors, []);
    assert.deepEqual(hostTracker.socketErrors, []);
    assert.deepEqual(guestTracker.socketErrors, []);
  } catch (error) {
    failure = signal?.aborted ? abortReason(signal, "Browser flow") : error;
  } finally {
    const cleanupErrors = [];
    const browserResult = await Promise.allSettled([closeBrowser()]);
    cleanupErrors.push(...browserResult
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason));
    signal?.removeEventListener("abort", onAbort);
    if (!failure && signal?.aborted) failure = abortReason(signal, "Browser flow");
    failure = aggregateFailure(failure, cleanupErrors, "The browser flow did not clean up completely.");
  }
  if (failure) throw failure;
}

async function startWorker(stateDirectory, envFile, signal) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = await getFreePort(signal);
    throwIfAborted(signal, "Wrangler startup");
    const origin = `http://127.0.0.1:${port}`;
    let started;
    try {
      started = startCaptured(
        process.execPath,
        [
          wrangler,
          "dev",
          "--local",
          "--ip", "127.0.0.1",
          "--port", String(port),
          "--persist-to", stateDirectory,
          "--env-file", envFile,
          "--var", "TOPIC_ROUTINE_PROVIDER:offline",
          "--var", "TOPIC_ESCALATION_PROVIDER:off",
        ],
        { cwd: root, env: isolatedChildEnv() },
      );
      await waitForJsonReadiness(
        `${origin}/api/v1/platform/status`,
        started.child,
        started.output,
        (response, payload) => response.status === 200
          && payload.schemaVersion === 5
          && payload.status === "degraded"
          && payload.capabilities?.cloudProgress?.status === "ready"
          && payload.capabilities?.retentionCleanup?.status === "ready"
          && payload.capabilities?.roomFacts?.status === "disabled"
          && payload.capabilities?.aggregateAnalytics?.status === "write-only"
          && payload.degradedCapabilities?.includes("roomFacts")
          && payload.degradedCapabilities?.includes("adminAnalytics"),
        60_000,
        signal,
      );
      throwIfAborted(signal, "Wrangler startup");
      return { ...started, origin };
    } catch (error) {
      const primaryError = signal?.aborted ? abortReason(signal, "Wrangler startup") : error;
      lastError = primaryError;
      if (!started) throw primaryError;
      try {
        await terminateProcessTree(started.child);
      } catch (cleanupError) {
        throw processTreeCleanupFailure(primaryError, cleanupError);
      }
      const output = started.output();
      if (!signal?.aborted && attempt < 3 && isAddressInUse(output)) continue;
      throw new Error(`${boundedMessage(primaryError)}${output ? `\n${output}` : ""}`, { cause: primaryError });
    }
  }
  throw lastError;
}

async function main() {
  const abortController = new AbortController();
  const signalHandlers = new Map();
  let receivedSignal;
  for (const name of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (!receivedSignal) receivedSignal = name;
      if (!abortController.signal.aborted) {
        abortController.abort(new Error(`Interrupted by ${name}.`));
      }
    };
    signalHandlers.set(name, handler);
    process.on(name, handler);
  }
  const deadline = setTimeout(() => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error(`Multiplayer smoke exceeded ${WHOLE_SMOKE_TIMEOUT_MS}ms.`));
    }
  }, WHOLE_SMOKE_TIMEOUT_MS);

  let temporaryRoot;
  let worker;
  let failure;
  let retainedTemporaryState = false;

  try {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "nonstoptalk-cf-multiplayer-"));
    throwIfAborted(abortController.signal, "Smoke setup");
    const stateDirectory = path.join(temporaryRoot, "state");
    const envFile = path.join(temporaryRoot, "smoke.env");
    await mkdir(stateDirectory, { mode: 0o700 });
    throwIfAborted(abortController.signal, "Smoke setup");
    await writeFile(envFile, "", { mode: 0o600, flag: "wx" });
    throwIfAborted(abortController.signal, "Smoke setup");
    await runChecked(
      process.execPath,
      [
        wrangler,
        "d1", "migrations", "apply", "PLATFORM_DB",
        "--local",
        "--persist-to", stateDirectory,
        "--env-file", envFile,
      ],
      {
        cwd: root,
        env: isolatedChildEnv(),
        label: "Local D1 migrations",
        timeoutMs: 90_000,
        signal: abortController.signal,
      },
    );
    throwIfAborted(abortController.signal, "Local D1 migrations");
    worker = await startWorker(stateDirectory, envFile, abortController.signal);
    await runBrowserFlow(worker.origin, abortController.signal);
    throwIfAborted(abortController.signal, "Multiplayer smoke");
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(deadline);
    const cleanupErrors = [];
    let processTreeVerified = !containsErrorCode(failure, "ERR_PROCESS_TREE_CLEANUP");
    if (worker) {
      try {
        await terminateProcessTree(worker.child);
      } catch (cleanupError) {
        processTreeVerified = false;
        cleanupErrors.push(cleanupError);
      }
    }
    if (temporaryRoot && processTreeVerified) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        retainedTemporaryState = true;
        cleanupErrors.push(cleanupError);
      }
    } else if (temporaryRoot) {
      retainedTemporaryState = true;
    }
    for (const [name, handler] of signalHandlers) process.removeListener(name, handler);
    if (!failure && abortController.signal.aborted) {
      failure = abortReason(abortController.signal, "Multiplayer smoke");
    }
    failure = aggregateFailure(failure, cleanupErrors, "The multiplayer smoke did not clean up completely.");
  }

  if (failure) {
    process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : 1;
    console.error(failure);
    if (worker?.output()) console.error(`\nWrangler output:\n${worker.output()}`);
    if (retainedTemporaryState) {
      console.error(`Temporary state may remain because cleanup did not complete: ${temporaryRoot}`);
    }
  } else {
    console.log("Cloudflare two-browser WebSocket multiplayer smoke test passed.");
  }
}

await main();
