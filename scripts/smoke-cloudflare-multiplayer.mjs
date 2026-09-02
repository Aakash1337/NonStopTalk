import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { SETUP_KIT_MAX_TOPIC_FILE_BYTES } from "../cloudflare/public/setup-kits.js";

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
const IMPORTED_TOPICS = "Imported <strong>topic</strong>\nA second imported topic";

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

function trackApiRequests(page) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(page.url() || url).origin || !url.pathname.startsWith("/api/")) return;
    let body = null;
    try { body = request.postDataJSON(); } catch { /* Non-JSON requests have no action body. */ }
    requests.push({ method: request.method(), path: url.pathname, body });
  });
  return requests;
}

async function installSyntheticMicrophone(context, profile) {
  await context.addInitScript(({ microphoneProfile }) => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const events = [];
    const devices = [
      {
        kind: "audioinput",
        deviceId: `${microphoneProfile}-mic`,
        groupId: `${microphoneProfile}-private-group`,
        label: `Studio <script>${microphoneProfile}</script> microphone`,
      },
      {
        kind: "audioinput",
        deviceId: `${microphoneProfile}-backup`,
        groupId: `${microphoneProfile}-backup-group`,
        label: "Backup microphone",
      },
      {
        kind: "videoinput",
        deviceId: `${microphoneProfile}-camera`,
        groupId: `${microphoneProfile}-camera-group`,
        label: "Camera that must not become an audio option",
      },
    ];
    let streamNumber = 0;
    let releasePending = null;

    const harness = {
      profile: microphoneProfile,
      events,
      blockNextUserMedia: false,
      releasePendingUserMedia() {
        if (!releasePending) throw new Error("No synthetic microphone request is waiting.");
        const release = releasePending;
        releasePending = null;
        release();
      },
    };
    Object.defineProperty(window, "__microphoneHarness", {
      configurable: true,
      value: harness,
    });

    const mediaDevices = new EventTarget();
    mediaDevices.enumerateDevices = async () => {
      events.push({ type: "enumerate-devices" });
      return devices.map((device) => ({ ...device }));
    };
    mediaDevices.getUserMedia = async (constraints) => {
      const request = clone(constraints);
      events.push({ type: "get-user-media", constraints: request });
      const streamId = `${microphoneProfile}-stream-${++streamNumber}`;
      const track = {
        stop() {
          events.push({ type: "track-stopped", streamId });
        },
      };
      const stream = {
        id: streamId,
        getTracks() { return [track]; },
      };
      const makeReady = () => {
        events.push({ type: "stream-ready", streamId });
        return stream;
      };
      if (!harness.blockNextUserMedia) return makeReady();
      harness.blockNextUserMedia = false;
      return new Promise((resolve) => {
        releasePending = () => resolve(makeReady());
      });
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });

    class SyntheticAudioContext {
      constructor() {
        this.state = "suspended";
        events.push({ type: "audio-context-created" });
      }

      async resume() {
        this.state = "running";
        events.push({ type: "audio-context-resumed" });
      }

      createMediaStreamSource(stream) {
        events.push({ type: "media-source-created", streamId: stream?.id || "" });
        return {
          connect() {
            events.push({ type: "audio-graph-connected", streamId: stream?.id || "" });
          },
        };
      }

      createAnalyser() {
        return {
          fftSize: 0,
          getByteTimeDomainData(samples) { samples.fill(140); },
        };
      }

      async close() {
        this.state = "closed";
        events.push({ type: "audio-context-closed" });
      }
    }
    window.AudioContext = SyntheticAudioContext;
    window.webkitAudioContext = SyntheticAudioContext;

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      let body = null;
      try { body = JSON.parse(init?.body || "null"); } catch { /* Only JSON room actions matter here. */ }
      if (/^\/api\/rooms\/[A-HJ-NP-Z2-9]{6}\/action$/u.test(url.pathname)) {
        events.push({ type: "room-action", body });
      }
      return originalFetch(input, init);
    };
  }, { microphoneProfile: profile });
}

async function readDownloadText(download) {
  const stream = await download.createReadStream();
  assert.ok(stream, "The browser download must expose a readable stream.");
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function assertNoNewApiRequests(requests, before, label) {
  assert.deepEqual(requests.slice(before), [], `${label} unexpectedly contacted a site API.`);
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

async function postRoomAction(context, origin, code, action) {
  const response = await context.request.post(`${origin}/api/rooms/${code}/action`, {
    data: action,
    headers: { Accept: "application/json" },
  });
  assert.equal(response.status(), 200, `Remote room action ${action.type} failed: ${await response.text()}`);
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

async function unauthorizedSetupKitProbe(page, code) {
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
        type: "apply-setup-kit",
        duration: 10,
        silence: 1,
        rounds: 1,
        topicPack: "custom",
        topics: ["Unauthorized setup-kit topic"],
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
      beforeTopics: before.room?.topics,
      afterTopics: after.room?.topics,
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
    await Promise.all([
      installSyntheticMicrophone(hostContext, "host"),
      installSyntheticMicrophone(guestContext, "guest"),
    ]);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const hostTracker = trackBrowser(host, "host");
    const guestTracker = trackBrowser(guest, "guest");
    const hostApiRequests = trackApiRequests(host);
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
    const [joinedHost, joinedGuest] = await Promise.all([
      readRoom(host, code),
      readRoom(guest, code),
    ]);
    const hostPlayerId = joinedHost.payload.room?.viewer?.playerId;
    const guestPlayerId = joinedGuest.payload.room?.viewer?.playerId;
    assert.ok(hostPlayerId, "The room host must have a player identity.");
    assert.ok(guestPlayerId, "The joined guest must have a player identity.");

    const hostCookie = (await hostContext.cookies(origin)).find((cookie) => cookie.name === "nonstoptalk_token");
    const guestCookie = (await guestContext.cookies(origin)).find((cookie) => cookie.name === "nonstoptalk_token");
    assert.ok(hostCookie?.httpOnly && guestCookie?.httpOnly, "Both browser identities must use HttpOnly cookies.");
    assert.ok(hostCookie.value !== guestCookie.value,
      "Host and guest browser contexts must have distinct identities.");

    assert.equal(await guest.locator("form.settings").count(), 0);
    assert.equal(await guest.locator("[data-model-topics]").count(), 0);
    assert.equal(await guest.getByLabel("Custom topics, one per line").count(), 0);
    assert.equal(await guest.locator("[data-setup-kits]").count(), 0);
    assert.equal(await guest.getByLabel("Local player").count(), 0);
    assert.equal(await guest.getByRole("button", { name: "Start game" }).count(), 0);
    await host.getByRole("heading", { level: 2, name: "Local setup kits" }).waitFor();

    // A browser storage failure disables only the local library; the host lobby
    // stays rendered and recovers when storage access returns.
    let requestCount = hostApiRequests.length;
    await host.evaluate(() => {
      window.__setupKitOriginalGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = () => { throw new DOMException("blocked", "SecurityError"); };
      window.dispatchEvent(new StorageEvent("storage", { key: "nonstoptalk.setup-kits.v1" }));
    });
    await host.locator("[data-setup-kit-status]")
      .filter({ hasText: "Saved setup kits could not be read." }).waitFor();
    assert(await host.getByRole("button", { name: "Save applied setup" }).isDisabled(),
      "A local-storage failure must disable setup-kit writes without crashing the room.");
    assert.equal(await host.getByRole("heading", { level: 1, name: `Room ${code}` }).count(), 1,
      "A local-storage failure must not replace the rest of the room UI.");
    assertNoNewApiRequests(hostApiRequests, requestCount, "Rendering a local-storage setup-kit error");
    await host.evaluate(() => {
      Storage.prototype.getItem = window.__setupKitOriginalGetItem;
      delete window.__setupKitOriginalGetItem;
      window.dispatchEvent(new StorageEvent("storage", { key: "nonstoptalk.setup-kits.v1" }));
    });
    await host.getByRole("button", { name: "Save applied setup" }).waitFor({ state: "visible" });
    assert(!await host.getByRole("button", { name: "Save applied setup" }).isDisabled(),
      "Setup-kit controls must recover after local storage becomes available.");

    const unauthorized = await unauthorizedSettingsProbe(guest, code);
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.error, "Only the host can do that.");
    assert.equal(unauthorized.afterVersion, unauthorized.beforeVersion,
      "A rejected guest action must not advance the room version.");
    assert.deepEqual(unauthorized.afterSettings, unauthorized.beforeSettings,
      "A rejected guest action must not change room settings.");
    const unauthorizedKit = await unauthorizedSetupKitProbe(guest, code);
    assert.equal(unauthorizedKit.status, 403);
    assert.equal(unauthorizedKit.error, "Only the host can do that.");
    assert.equal(unauthorizedKit.afterVersion, unauthorizedKit.beforeVersion,
      "A rejected guest setup kit must not advance the room version.");
    assert.deepEqual(unauthorizedKit.afterSettings, unauthorizedKit.beforeSettings,
      "A rejected guest setup kit must not change room settings.");
    assert.deepEqual(unauthorizedKit.afterTopics, unauthorizedKit.beforeTopics,
      "A rejected guest setup kit must not change room topics.");

    // Saving a kit is browser-local, escapes its name, and survives a reload in
    // this browser context without appearing in another browser identity.
    requestCount = hostApiRequests.length;
    const kitName = "Default <kit>";
    const kitNameInput = host.getByLabel("Kit name");
    await kitNameInput.fill(kitName);
    await kitNameInput.press("Enter");
    await host.locator("[data-setup-kit-status]").filter({ hasText: `Saved “${kitName}” on this device.` }).waitFor();
    assertNoNewApiRequests(hostApiRequests, requestCount, "Saving a local setup kit");
    assert.equal(await host.locator("[data-setup-kits] kit").count(), 0,
      "A hostile setup-kit name must remain text instead of becoming markup.");
    const storedDefault = await host.evaluate(() => JSON.parse(localStorage.getItem("nonstoptalk.setup-kits.v1")));
    assert.deepEqual(storedDefault, {
      schemaVersion: 1,
      kits: [{ name: kitName, duration: 60, silence: 2, rounds: 1, topicPack: "everyday", topics: [] }],
    });
    assert.equal(await guest.evaluate(() => localStorage.getItem("nonstoptalk.setup-kits.v1")), null,
      "A setup kit must not cross isolated browser contexts.");

    const socketCountBeforeKitReload = hostTracker.sockets
      .filter((socket) => new URL(socket.url).pathname === `/api/rooms/${code}/socket`).length;
    await host.reload({ waitUntil: "domcontentloaded" });
    await host.getByLabel("Saved setup kit").waitFor();
    assert.equal(await host.getByLabel("Saved setup kit").inputValue(), kitName);
    await waitForSocket(hostTracker, code, signal, socketCountBeforeKitReload);

    // Host transfer hides the old host's local controls. The new host sees only
    // the library from its own browser profile, then can transfer control back.
    await host.getByRole("button", { name: "Make Cloud Guest the host" }).click();
    await guest.getByRole("heading", { level: 2, name: "Local setup kits" }).waitFor();
    await eventually(() => host.locator("[data-setup-kits]").count().then((count) => count === 0),
      "The former host retained setup-kit controls", signal);
    assert.equal(await guest.getByLabel("Saved setup kit").inputValue(), "",
      "The new host must see its own empty browser-local kit library.");
    await guest.getByRole("button", { name: "Make Cloud Host the host" }).click();
    await host.getByLabel("Saved setup kit").waitFor();
    assert.equal(await host.getByLabel("Saved setup kit").inputValue(), kitName);
    await eventually(() => guest.locator("[data-setup-kits]").count().then((count) => count === 0),
      "Setup-kit controls remained visible after transferring host back", signal);

    // Plain-text import edits only the local draft. A guest mutation forces a
    // WebSocket rerender and proves the imported draft and focus survive it.
    requestCount = hostApiRequests.length;
    const topicImport = host.locator("[data-topic-import]");
    const draftBeforeOversizedImport = await host.getByLabel("Custom topics, one per line").inputValue();
    await topicImport.setInputFiles({
      name: "too-large.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(SETUP_KIT_MAX_TOPIC_FILE_BYTES + 1, 0x61),
    });
    await host.locator("[data-topic-status]").filter({ hasText: "Topic files must be 64 KiB or smaller." }).waitFor();
    assert.equal(await host.getByLabel("Custom topics, one per line").inputValue(), draftBeforeOversizedImport,
      "An oversized topic file must be rejected before replacing the editor draft.");
    assertNoNewApiRequests(hostApiRequests, requestCount, "Rejecting an oversized local topic file");

    requestCount = hostApiRequests.length;
    await topicImport.setInputFiles({
      name: "portable-topics.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(IMPORTED_TOPICS),
    });
    const topicEditor = host.getByLabel("Custom topics, one per line");
    await host.locator("[data-topic-status]").filter({ hasText: "Imported 2 topics" }).waitFor();
    assert.equal(await topicEditor.inputValue(), IMPORTED_TOPICS);
    assert(await topicEditor.evaluate((control) => document.activeElement === control),
      "Topic import must return focus to the editable draft.");
    assertNoNewApiRequests(hostApiRequests, requestCount, "Importing a local topic file");

    await postRoomAction(guestContext, origin, code, {
      type: "rename-player",
      playerId: guestPlayerId,
      name: "Cloud Guest Two",
    });
    await host.getByLabel("Rename Cloud Guest Two").waitFor();
    assert.equal(await topicEditor.inputValue(), IMPORTED_TOPICS,
      "A WebSocket rerender discarded the imported topic draft.");
    assert(await topicEditor.evaluate((control) => document.activeElement === control),
      "A WebSocket rerender discarded topic-editor focus.");
    assert.match(await host.locator("[data-topic-status]").textContent(), /Imported 2 topics/u,
      "A WebSocket rerender discarded topic-import status.");

    requestCount = hostApiRequests.length;
    const [topicDownload] = await Promise.all([
      host.waitForEvent("download"),
      host.getByRole("button", { name: "Export topic list" }).click(),
    ]);
    assert.equal(topicDownload.suggestedFilename(), "nonstoptalk-topics.txt");
    assert.equal(await readDownloadText(topicDownload), IMPORTED_TOPICS);
    assertNoNewApiRequests(hostApiRequests, requestCount, "Exporting the topic editor");
    assert(await host.getByRole("button", { name: "Export topic list" }).evaluate((button) => document.activeElement === button),
      "Topic export must preserve the initiating keyboard focus target.");

    // An async file read that finishes after SPA navigation must not restore
    // stale room UI or dispatch a room action.
    await host.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = function delayedTopicFileText() {
        return new Promise((resolve) => {
          window.__releaseDelayedTopicFile = () => {
            File.prototype.text = original;
            window.__releaseDelayedTopicFile = null;
            resolve("A stale imported topic");
          };
        });
      };
    });
    requestCount = hostApiRequests.length;
    await topicImport.setInputFiles({
      name: "delayed-topics.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("ignored"),
    });
    await host.getByRole("link", { name: "Home", exact: true }).click();
    await host.getByRole("heading", { level: 1, name: "Find your voice." }).waitFor();
    await host.evaluate(() => window.__releaseDelayedTopicFile());
    await host.waitForFunction(() => window.__releaseDelayedTopicFile === null);
    assertNoNewApiRequests(hostApiRequests, requestCount, "A stale topic-file completion");
    await host.goBack();
    await host.getByRole("heading", { level: 1, name: `Room ${code}` }).waitFor();
    await host.getByLabel("Saved setup kit").waitFor();
    assert.equal(await host.getByLabel("Saved setup kit").inputValue(), kitName);

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

    // A saved custom kit captures only the currently applied room setup. An
    // exact-name overwrite is explicit and remains local.
    const customKitName = "Fast custom";
    requestCount = hostApiRequests.length;
    await host.getByLabel("Kit name").fill(customKitName);
    await host.getByLabel("Kit name").press("Enter");
    await host.locator("[data-setup-kit-status]").filter({ hasText: `Saved “${customKitName}” on this device.` }).waitFor();
    assertNoNewApiRequests(hostApiRequests, requestCount, "Saving an applied custom setup kit");

    let overwritePrompt = "";
    host.once("dialog", async (dialog) => {
      overwritePrompt = dialog.message();
      await dialog.accept();
    });
    requestCount = hostApiRequests.length;
    await host.getByLabel("Kit name").press("Enter");
    assert.equal(overwritePrompt, `Replace the saved “${customKitName}” kit in this browser?`);
    assertNoNewApiRequests(hostApiRequests, requestCount, "Overwriting a local setup kit");

    await host.getByLabel("Saved setup kit").selectOption(kitName);
    const unsavedKitName = "Unsaved <draft>";
    await host.getByLabel("Kit name").fill(unsavedKitName);
    await host.getByLabel("Kit name").evaluate((input) => input.setSelectionRange(4, 9));
    await postRoomAction(guestContext, origin, code, {
      type: "rename-player",
      playerId: guestPlayerId,
      name: "Cloud Guest",
    });
    await host.getByLabel("Rename Cloud Guest").waitFor();
    assert.equal(await host.getByLabel("Saved setup kit").inputValue(), kitName,
      "A WebSocket rerender discarded the selected local setup kit.");
    assert.equal(await host.getByLabel("Kit name").inputValue(), unsavedKitName,
      "A WebSocket rerender discarded the setup-kit name draft.");
    assert.deepEqual(await host.getByLabel("Kit name").evaluate((input) => ({
      focused: document.activeElement === input,
      start: input.selectionStart,
      end: input.selectionEnd,
    })), { focused: true, start: 4, end: 9 },
    "A WebSocket rerender discarded setup-kit focus or selection.");
    assert.match(await host.locator("[data-setup-kit-status]").textContent(), /Saved “Fast custom” on this device\./u,
      "A WebSocket rerender discarded setup-kit status.");

    // Change every applied setting, then restore the custom kit through exactly
    // one room action. The local kit name must not cross that boundary.
    await settings.getByLabel("Talk time (seconds)").fill("25");
    await settings.getByLabel("Silence limit").fill("3");
    await settings.getByLabel("Rounds").fill("2");
    await settings.getByLabel("Topic pack").selectOption("debate");
    await settings.getByRole("button", { name: "Apply settings" }).click();
    await eventually(async () => {
      const state = await readRoom(guest, code);
      return state.payload.room?.settings?.duration === 25
        && state.payload.room?.settings?.silence === 3
        && state.payload.room?.settings?.rounds === 2
        && state.payload.room?.settings?.topicPack === "debate";
    }, "The temporary room setup did not converge", signal);

    await host.getByLabel("Saved setup kit").selectOption(customKitName);
    requestCount = hostApiRequests.length;
    await host.getByRole("button", { name: "Apply selected kit" }).click();
    await host.locator("[data-setup-kit-status]").filter({ hasText: `Applied “${customKitName}” to room ${code}.` }).waitFor();
    const applyRequests = hostApiRequests.slice(requestCount);
    assert.equal(applyRequests.length, 1, "Applying a setup kit must make exactly one API request.");
    assert.deepEqual(applyRequests[0], {
      method: "POST",
      path: `/api/rooms/${code}/action`,
      body: {
        type: "apply-setup-kit",
        duration: 10,
        silence: 1,
        rounds: 1,
        topicPack: "custom",
        topics: [TOPIC],
      },
    });
    assert.equal(Object.hasOwn(applyRequests[0].body, "name"), false,
      "The browser-local kit name must not be sent to the room.");
    assert(await host.getByRole("button", { name: "Apply selected kit" }).evaluate((button) => document.activeElement === button),
      "Applying a setup kit must preserve keyboard focus through the room rerender.");
    await eventually(async () => {
      const [hostState, guestState] = await Promise.all([readRoom(host, code), readRoom(guest, code)]);
      return hostState.payload.room?.settings?.duration === 10
        && hostState.payload.room?.settings?.silence === 1
        && hostState.payload.room?.settings?.rounds === 1
        && hostState.payload.room?.settings?.topicPack === "custom"
        && hostState.payload.room?.topics?.length === 1
        && hostState.payload.room.topics[0] === TOPIC
        && guestState.payload.room?.topicCount === 1
        && guestState.payload.room?.topics?.length === 0;
    }, "Applied setup-kit state did not converge privately", signal);

    let deletePrompt = "";
    host.once("dialog", async (dialog) => {
      deletePrompt = dialog.message();
      await dialog.accept();
    });
    requestCount = hostApiRequests.length;
    await host.getByRole("button", { name: "Delete selected kit" }).click();
    await host.locator("[data-setup-kit-status]").filter({ hasText: `Deleted “${customKitName}” from this device.` }).waitFor();
    assert.equal(deletePrompt, `Delete “${customKitName}” from this browser? This does not change the room.`);
    assertNoNewApiRequests(hostApiRequests, requestCount, "Deleting a local setup kit");
    assert.equal(await host.getByLabel("Saved setup kit").inputValue(), kitName);
    const storedAfterDelete = await host.evaluate(() => JSON.parse(localStorage.getItem("nonstoptalk.setup-kits.v1")));
    assert.deepEqual(storedAfterDelete.kits.map((kit) => kit.name), [kitName]);

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

    // The microphone preference is local to the current driver. It survives a
    // harmless room rerender, restores focus to the replacement opener, and
    // never creates a room action or exposes its device metadata to the guest.
    assert.equal(await host.getByRole("button", { name: "Choose microphone" }).count(), 1,
      "The current room driver must be able to choose a microphone.");
    assert.equal(await guest.getByRole("button", { name: "Choose microphone" }).count(), 0,
      "A non-host spectator must not receive the current driver's microphone controls.");
    requestCount = hostApiRequests.length;
    const microphoneDialog = host.getByRole("dialog", { name: "Choose a microphone" });
    let microphoneOpener = host.getByRole("button", { name: "Choose microphone" });
    await microphoneOpener.click();
    await microphoneDialog.waitFor();
    const microphoneList = microphoneDialog.getByLabel("Audio input");
    await microphoneDialog.getByRole("option", {
      name: "Studio <script>host</script> microphone",
    }).waitFor({ state: "attached" });
    assert.equal(await microphoneDialog.locator("script").count(), 0,
      "A browser-provided microphone label must remain inert text.");
    assert(await microphoneList.evaluate((control) => document.activeElement === control),
      "Opening the picker must move keyboard focus into its device list.");

    const hostSocketFramesBeforePickerRerender = hostTracker.sockets
      .reduce((total, socket) => total + socket.frames, 0);
    await postRoomAction(hostContext, origin, code, {
      type: "score",
      playerId: guestPlayerId,
      delta: 0,
    });
    await eventually(
      () => hostTracker.sockets.reduce((total, socket) => total + socket.frames, 0)
        > hostSocketFramesBeforePickerRerender,
      "The harmless score action did not trigger a WebSocket rerender",
      signal,
    );
    assert(await microphoneDialog.isVisible(),
      "A benign WebSocket rerender must not close the active microphone picker.");
    assert(await microphoneList.evaluate((control) => document.activeElement === control),
      "A benign WebSocket rerender must preserve focus inside the microphone picker.");
    await microphoneDialog.getByRole("button", { name: "Cancel" }).click();
    await microphoneDialog.waitFor({ state: "hidden" });
    microphoneOpener = host.getByRole("button", { name: "Choose microphone" });
    await eventually(
      () => microphoneOpener.evaluate((button) => document.activeElement === button),
      "Cancel did not restore focus to the replacement microphone opener",
      signal,
    );

    microphoneOpener = host.getByRole("button", { name: "Choose microphone" });
    await microphoneOpener.click();
    await microphoneDialog.waitFor();
    await microphoneDialog.getByLabel("Audio input").press("Escape");
    await microphoneDialog.waitFor({ state: "hidden" });
    await eventually(
      () => microphoneOpener.evaluate((button) => document.activeElement === button),
      "Escape did not restore focus to the microphone opener",
      signal,
    );

    // A host transfer changes the driver's authority identity. Even though the
    // active speaker can still drive their own turn, the old dialog scope must
    // close instead of carrying authority across that state transition.
    await microphoneOpener.click();
    await microphoneDialog.waitFor();
    await postRoomAction(hostContext, origin, code, {
      type: "transfer-host",
      playerId: guestPlayerId,
    });
    await microphoneDialog.waitFor({ state: "hidden" });
    const roomHeading = host.getByRole("heading", { level: 1, name: `Room ${code}` });
    await eventually(
      () => roomHeading.evaluate((heading) => document.activeElement === heading),
      "Authority invalidation did not focus the current room heading",
      signal,
    );
    await postRoomAction(guestContext, origin, code, {
      type: "transfer-host",
      playerId: hostPlayerId,
    });
    await host.getByRole("button", { name: "Choose microphone" }).waitFor();

    microphoneOpener = host.getByRole("button", { name: "Choose microphone" });
    await microphoneOpener.click();
    await microphoneDialog.waitFor();
    await microphoneDialog.getByLabel("Audio input").selectOption("host-mic");
    await microphoneDialog.getByRole("button", { name: "Use microphone" }).click();
    await microphoneDialog.waitFor({ state: "hidden" });
    await eventually(
      () => microphoneOpener.evaluate((button) => document.activeElement === button),
      "Applying a microphone choice did not restore focus to its opener",
      signal,
    );
    assertNoNewApiRequests(hostApiRequests, requestCount, "Choosing a browser-local microphone");
    assert.equal(await host.evaluate(() => localStorage.getItem("nonstoptalk.microphone.v1")), "host-mic",
      "Only the chosen opaque device ID should be persisted in the driver's browser.");
    assert.equal(await guest.evaluate(() => localStorage.getItem("nonstoptalk.microphone.v1")), null,
      "The microphone preference must not cross browser identities.");
    assert.equal((await host.locator("[data-microphone-selected-label]").textContent())?.trim(),
      "Studio <script>host</script> microphone");
    const roomAfterLocalSelection = await readRoom(host, code);
    assert.equal(roomAfterLocalSelection.payload.room?.activeTurn?.begunAt, null,
      "Choosing a local microphone must not begin or mutate the room turn.");
    assert(!JSON.stringify(roomAfterLocalSelection.payload).includes("host-mic"),
      "The selected device ID must not appear in the room API response.");
    assert(!JSON.stringify(roomAfterLocalSelection.payload).includes("host-private-group"),
      "Browser microphone group metadata must not appear in the room API response.");

    // Hold the selected-device promise open to prove that begin-turn is sent
    // only after a usable stream exists and the local audio graph is connected.
    requestCount = hostApiRequests.length;
    const microphoneEventOffset = await host.evaluate(() => window.__microphoneHarness.events.length);
    await host.evaluate(() => { window.__microphoneHarness.blockNextUserMedia = true; });
    await host.getByRole("button", { name: "Start with microphone" }).click();
    await host.waitForFunction((offset) => window.__microphoneHarness.events
      .slice(offset).some((event) => event.type === "get-user-media"), microphoneEventOffset);
    await delay(100, undefined, signal ? { signal } : undefined);
    assertNoNewApiRequests(hostApiRequests, requestCount,
      "A microphone start waiting for usable media");
    const beforeMediaRelease = await host.evaluate((offset) =>
      window.__microphoneHarness.events.slice(offset), microphoneEventOffset);
    assert.equal(beforeMediaRelease.some((event) => event.type === "stream-ready"), false);
    assert.equal(beforeMediaRelease.some((event) => event.type === "room-action"), false,
      "begin-turn must not be attempted while microphone acquisition is pending.");

    await host.evaluate(() => window.__microphoneHarness.releasePendingUserMedia());
    await host.getByRole("button", { name: "End turn" }).waitFor();
    const microphoneEvents = await host.evaluate((offset) =>
      window.__microphoneHarness.events.slice(offset), microphoneEventOffset);
    const eventIndex = (type) => microphoneEvents.findIndex((event) => event.type === type);
    const microphoneRequest = microphoneEvents.find((event) => event.type === "get-user-media");
    assert.deepEqual(microphoneRequest?.constraints, {
      audio: { deviceId: { exact: "host-mic" } },
      video: false,
    }, "The chosen opaque ID must become an exact audio device constraint.");
    assert(eventIndex("stream-ready") >= 0);
    assert(eventIndex("audio-context-resumed") > eventIndex("stream-ready"));
    assert(eventIndex("audio-graph-connected") > eventIndex("audio-context-resumed"));
    assert(eventIndex("room-action") > eventIndex("audio-graph-connected"),
      "The room turn must begin only after the microphone audio graph is usable.");
    const microphoneStartRequests = hostApiRequests.slice(requestCount);
    assert.equal(microphoneStartRequests.length, 1,
      "Starting with a usable microphone must send exactly one room action.");
    assert.deepEqual(microphoneStartRequests[0], {
      method: "POST",
      path: `/api/rooms/${code}/action`,
      body: {
        type: "begin-turn",
        turnId: roomAfterLocalSelection.payload.room.activeTurn.id,
      },
    });
    const serializedMicrophoneRequests = JSON.stringify(microphoneStartRequests);
    for (const privateValue of [
      "host-mic",
      "host-private-group",
      "Studio <script>host</script> microphone",
      "deviceId",
    ]) {
      assert(!serializedMicrophoneRequests.includes(privateValue),
        `Room traffic exposed browser-local microphone metadata: ${privateValue}`);
    }

    const activeStreamId = microphoneEvents.find((event) => event.type === "stream-ready")?.streamId;
    assert(activeStreamId, "The selected microphone start must expose a synthetic active stream.");
    await postRoomAction(hostContext, origin, code, {
      type: "transfer-host",
      playerId: guestPlayerId,
    });
    await eventually(
      () => host.evaluate((streamId) => window.__microphoneHarness.events
        .some((event) => event.type === "track-stopped" && event.streamId === streamId), activeStreamId),
      "Losing the authority identity did not stop the active local microphone stream",
      signal,
    );
    await host.getByRole("button", { name: "Resume microphone" }).waitFor();
    await postRoomAction(guestContext, origin, code, {
      type: "transfer-host",
      playerId: hostPlayerId,
    });
    await host.getByRole("button", { name: "Mark complete" }).waitFor();

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

    // This same non-host browser had no picker while spectating the first turn.
    // Once it becomes the active speaker, it receives an isolated local picker
    // containing only Auto-detect and devices exposed by its own browser.
    const guestMicrophoneOpener = guest.getByRole("button", { name: "Choose microphone" });
    assert.equal(await guestMicrophoneOpener.count(), 1,
      "The non-host active speaker must receive microphone controls for their own turn.");
    assert.equal((await guest.locator("[data-microphone-selected-label]").textContent())?.trim(), "Auto-detect");
    assert.equal(await guest.evaluate(() => localStorage.getItem("nonstoptalk.microphone.v1")), null,
      "The host's selected device must not become the guest speaker's preference.");
    await guestMicrophoneOpener.click();
    const guestMicrophoneDialog = guest.getByRole("dialog", { name: "Choose a microphone" });
    await guestMicrophoneDialog.waitFor();
    const guestMicrophoneList = guestMicrophoneDialog.getByLabel("Audio input");
    assert.equal(await guestMicrophoneList.inputValue(), "",
      "The guest speaker's isolated picker must default to Auto-detect.");
    assert.deepEqual(await guestMicrophoneList.locator("option").evaluateAll((options) =>
      options.map((option) => ({ value: option.value, label: option.textContent }))), [
      { value: "", label: "Auto-detect" },
      { value: "guest-mic", label: "Studio <script>guest</script> microphone" },
      { value: "guest-backup", label: "Backup microphone" },
    ]);
    assert.equal(await guestMicrophoneList.locator('option[value="host-mic"]').count(), 0,
      "The active guest must not see a device ID from the host's browser profile.");
    await guestMicrophoneList.press("Escape");
    await guestMicrophoneDialog.waitFor({ state: "hidden" });
    await eventually(
      () => guestMicrophoneOpener.evaluate((button) => document.activeElement === button),
      "Closing the guest speaker's picker did not restore focus",
      signal,
    );

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
          && payload.schemaVersion === 6
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
