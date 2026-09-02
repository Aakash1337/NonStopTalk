import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

import { LOCAL_BEST_EFFORT_DELIVERY_WRANGLER_ARGS } from "./smoke-local-worker-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const syntheticAccessibilityMicrophones = () => {
  const microphones = [
    { kind: "audioinput", deviceId: "accessibility-table-mic", label: "Table microphone" },
    { kind: "audioinput", deviceId: "accessibility-room-mic", label: "Room microphone" },
  ];
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      enumerateDevices: () => Promise.resolve(microphones.map((device) => ({ ...device }))),
      getUserMedia: () => Promise.resolve({
        getAudioTracks: () => [],
        getTracks: () => [],
      }),
    },
  });

  class SilentAudioNode {
    connect(target) { return target; }
    disconnect() {}
  }

  class SilentAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = new SilentAudioNode();
      this.state = "running";
    }

    resume() {
      this.state = "running";
      return Promise.resolve();
    }

    close() {
      this.state = "closed";
      return Promise.resolve();
    }

    createOscillator() {
      const oscillator = new SilentAudioNode();
      oscillator.type = "sine";
      oscillator.frequency = { value: 0 };
      oscillator.start = () => {};
      oscillator.stop = () => {};
      return oscillator;
    }

    createGain() {
      const gain = new SilentAudioNode();
      gain.gain = {
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
      };
      return gain;
    }
  }

  window.AudioContext = SilentAudioContext;
  window.webkitAudioContext = SilentAudioContext;

  class LocalSpeechRecognitionCapability {
    constructor() { this.processLocally = false; }
    abort() {}
  }
  window.SpeechRecognition = LocalSpeechRecognitionCapability;
  window.webkitSpeechRecognition = LocalSpeechRecognitionCapability;
};

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function readStatus(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error(`Timed out loading ${url}`)));
  });
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited before startup (${child.exitCode}).\n${output()}`);
    try {
      if (await readStatus(url) === 200) return;
    } catch (error) {
      lastError = error;
    }
    await delay(300);
  }
  throw new Error(`Wrangler did not start: ${lastError?.message || "timeout"}\n${output()}`);
}

function stopProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function launchBrowser() {
  const chromiumSandbox = process.getuid?.() === 0 ? false : undefined;
  const attempts = [{}, { channel: "chrome" }, { channel: "msedge" }];
  if (process.env.SMOKE_CHROMIUM) attempts.unshift({ executablePath: process.env.SMOKE_CHROMIUM });
  let lastError;
  for (const attempt of attempts) {
    try {
      return await chromium.launch({ headless: process.env.HEADED !== "1", chromiumSandbox, ...attempt });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function violationSummary(violations) {
  return violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.target),
  }));
}

async function assertNoAxeViolations(page, label) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  assert(result.violations.length === 0,
    `${label} has axe violations: ${JSON.stringify(violationSummary(result.violations), null, 2)}`);
}

async function assertSinglePageStructure(page, label) {
  assert(await page.locator("main").count() === 1, `${label} must expose exactly one main landmark`);
  assert(await page.locator("main h1").count() === 1, `${label} must expose exactly one level-one heading inside main`);
  assert(await page.getByRole("navigation", { name: "Primary navigation" }).count() === 1,
    `${label} must expose one named primary navigation landmark`);
}

async function runAccessibilityFlow(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(syntheticAccessibilityMicrophones);
  const page = await context.newPage();
  const pageErrors = [];
  const coachingDataRequests = [];
  let trackProgressRequests = false;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (trackProgressRequests && new URL(request.url()).pathname.startsWith("/api/")) {
      coachingDataRequests.push(request.url());
    }
  });

  await page.goto(origin);
  await page.getByRole("heading", { level: 1, name: "Find your voice." }).waitFor();
  await assertSinglePageStructure(page, "Landing page");
  assert(await page.title() === "NonStopTalk", "The landing page title must identify NonStopTalk");
  assert(await page.getByRole("link", { name: "Play", exact: true }).getAttribute("aria-current") === "page",
    "The landing route must identify Play as the current page");
  await assertNoAxeViolations(page, "Landing page");

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  assert(await skipLink.evaluate((link) => document.activeElement === link),
    "The skip link must be the first keyboard focus target");
  assert(await skipLink.isVisible(), "The skip link must become visible when focused");
  await page.keyboard.press("Enter");
  assert(await page.locator("#app").evaluate((main) => document.activeElement === main),
    "Activating the skip link must move focus to main content");

  await page.evaluate(() => history.replaceState({}, "", "/"));
  await page.getByRole("link", { name: "Practice", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "Practice with a signal, not a score." }).waitFor();
  await page.waitForFunction(() => document.activeElement?.tagName === "H1");
  assert(await page.title() === "Practice · NonStopTalk", "Practice must update the document title");
  assert(await page.getByRole("link", { name: "Practice", exact: true }).getAttribute("aria-current") === "page",
    "Practice must be identified as the current page");
  assert((await page.locator("#announcer").textContent())?.includes("Practice with a signal, not a score. page."),
    "SPA navigation must announce the destination heading");
  await assertSinglePageStructure(page, "Practice page");
  await assertNoAxeViolations(page, "Practice page");

  const microphoneOpener = page.getByRole("button", { name: "Choose microphone" });
  await microphoneOpener.click();
  const microphoneDialog = page.getByRole("dialog", { name: "Choose a microphone" });
  await microphoneDialog.waitFor();
  assert(await microphoneDialog.getAttribute("aria-describedby") === "microphone-dialog-description",
    "The microphone dialog must expose its privacy explanation as an accessible description");
  assert((await page.locator("#microphone-dialog-description").innerText()).includes("stores only the chosen device ID"),
    "The microphone dialog description must explain what is stored");
  const microphoneList = page.getByLabel("Audio input");
  assert(await microphoneList.evaluate((select) => document.activeElement === select && select.closest("dialog")?.open),
    "Opening the microphone dialog must move focus to its native audio-input selector");
  const microphoneStatus = microphoneDialog.getByRole("status");
  await microphoneStatus.filter({ hasText: "2 microphone inputs available." }).waitFor();
  assert(await microphoneStatus.getAttribute("aria-live") === "polite"
    && await microphoneStatus.getAttribute("aria-atomic") === "true",
  "Microphone availability feedback must use polite, atomic live-status semantics");
  await assertNoAxeViolations(page, "Open microphone dialog");

  assert(await microphoneList.inputValue() === "", "The microphone selector must begin on Auto-detect");
  await microphoneList.press("ArrowDown");
  assert(await microphoneList.inputValue() === "accessibility-table-mic",
    "The native microphone selector must support keyboard option selection");
  await page.keyboard.press("Escape");
  await microphoneDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.matches('[data-command="microphone-open"]'));
  assert(await microphoneOpener.evaluate((button) => document.activeElement === button),
    "Escape must close the microphone dialog and restore focus to its opener");

  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await microphoneOpener.click();
  await microphoneDialog.waitFor();
  assert(await microphoneList.evaluate((select) => document.activeElement === select),
    "The microphone selector must still receive initial focus with reduced motion enabled");
  const microphoneDialogBounds = await microphoneDialog.boundingBox();
  assert(microphoneDialogBounds
    && microphoneDialogBounds.x >= 0
    && microphoneDialogBounds.x + microphoneDialogBounds.width <= 320,
  `The microphone dialog must fit within 320 CSS pixels, got ${JSON.stringify(microphoneDialogBounds)}`);
  assert(await microphoneDialog.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
    "The microphone dialog contents must not overflow horizontally at 320 CSS pixels");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "The open microphone dialog must not create page-level horizontal scrolling at 320 CSS pixels");
  const microphoneTransitionDurations = await microphoneDialog.evaluate((dialog) => [
    getComputedStyle(dialog).transitionDuration,
    ...Array.from(dialog.querySelectorAll("*"), (element) => getComputedStyle(element).transitionDuration),
  ]);
  assert(microphoneTransitionDurations.every((durations) =>
    durations.split(",").every((duration) => Number.parseFloat(duration) === 0)),
  `Reduced-motion mode must remove microphone-dialog transitions, got ${JSON.stringify(microphoneTransitionDurations)}`);
  await assertNoAxeViolations(page, "Open microphone dialog at 320 CSS pixels with reduced motion");
  await microphoneDialog.getByRole("button", { name: "Cancel" }).click();
  await microphoneDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.matches('[data-command="microphone-open"]'));
  assert(await microphoneOpener.evaluate((button) => document.activeElement === button),
    "Cancel must close the microphone dialog and restore focus to its opener");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });

  trackProgressRequests = true;
  await page.getByRole("link", { name: "Progress", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "Your baseline, not a leaderboard." }).waitFor();
  await page.waitForFunction(() => document.activeElement?.tagName === "H1");
  assert(await page.title() === "Progress · NonStopTalk", "Progress must update the document title");
  assert(await page.getByRole("link", { name: "Progress", exact: true }).getAttribute("aria-current") === "page",
    "Progress must be identified as the current page");
  const emptyArtifactDashboard = page.locator('[data-artifact-usage="ready"]');
  await emptyArtifactDashboard.waitFor();
  assert(await emptyArtifactDashboard.getByRole("heading", { level: 2 }).innerText() === "0 B of 128 MiB app limit",
    "Empty Progress must present a clear zero-usage artifact dashboard");
  const emptyArtifactMeter = emptyArtifactDashboard.locator("progress");
  assert(await emptyArtifactMeter.getAttribute("value") === "0"
    && await emptyArtifactMeter.getAttribute("max") === "134217728"
    && await emptyArtifactMeter.getAttribute("aria-label")
      === "0 bytes used of the 134217728 byte NonStopTalk artifact limit",
  "The empty artifact dashboard must expose exact accessible meter values");
  await assertSinglePageStructure(page, "Progress page");
  await assertNoAxeViolations(page, "Progress page");
  trackProgressRequests = false;

  await page.goBack();
  await page.getByRole("heading", { level: 1, name: "Practice with a signal, not a score." }).waitFor();
  await page.waitForFunction(() => document.activeElement?.tagName === "H1");
  assert(await page.title() === "Practice · NonStopTalk", "History navigation must restore the Practice title");

  const modifiedHomeClick = await page.evaluate(() => {
    const link = document.querySelector("[data-home]");
    let appPreventedDefault = false;
    window.addEventListener("click", (event) => {
      appPreventedDefault = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    link.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    }));
    return { appPreventedDefault, pathname: location.pathname };
  });
  assert(!modifiedHomeClick.appPreventedDefault && modifiedHomeClick.pathname === "/practice",
    "Modified brand clicks must retain native new-tab behavior");

  await page.goto(origin);
  await page.locator("[data-create-room] input[name='name']").fill("Accessibility Host");
  await page.locator("[data-create-room]").getByRole("button", { name: "Create room" }).click();
  const roomHeading = page.locator("h1.room-code");
  await roomHeading.waitFor();
  const roomHeadingText = (await roomHeading.textContent()).replace(/\s+/gu, " ").trim();
  const roomCode = roomHeadingText.replace(/^Room /u, "");
  assert(/^[A-HJ-NP-Z2-9]{6}$/.test(roomCode), `Expected a valid room heading, got ${JSON.stringify(roomCode)}`);
  assert(roomHeadingText === `Room ${roomCode}`, "The room code heading must have a descriptive accessible name");
  assert(await roomHeading.getAttribute("id") === "room-title", "The room heading must label the room header section");
  await page.waitForFunction(() => document.activeElement?.matches("h1.room-code"));
  assert(await roomHeading.evaluate((heading) => document.activeElement === heading),
    "Creating a room must focus the room route heading");
  assert(await page.title() === `Room ${roomCode} · NonStopTalk`, "Room routes must have a descriptive document title");
  assert(await page.getByLabel("Custom topics, one per line").count() === 1,
    "The custom-topic editor must have an accessible name");
  assert(await page.getByRole("heading", { level: 2, name: "Local setup kits" }).count() === 1,
    "The host lobby must expose a named Local setup kits section");
  assert(await page.getByLabel("Saved setup kit").count() === 1,
    "The saved-kit selector must have an accessible name");
  assert(await page.getByLabel("Kit name").count() === 1,
    "The setup-kit name field must have an accessible name");
  assert(await page.getByLabel("Import topic list (.txt)").count() === 1,
    "The topic import control must have an accessible name");
  assert(await page.getByRole("button", { name: "Apply selected kit" }).isDisabled(),
    "Apply must be disabled while the local kit library is empty");
  assert(await page.getByRole("button", { name: "Delete selected kit" }).isDisabled(),
    "Delete must be disabled while the local kit library is empty");
  assert(await page.locator("[data-setup-kit-status]").getAttribute("role") === "status",
    "Setup-kit feedback must use live status semantics");
  await assertSinglePageStructure(page, "Room lobby");
  await assertNoAxeViolations(page, "Room lobby");

  const judgeSetting = page.getByRole("checkbox", { name: /Offer the offline relevance judge/u });
  assert(await judgeSetting.count() === 1,
    "The host judge setting must expose one labeled checkbox");
  assert(!await judgeSetting.isChecked(), "The optional judge must begin disabled");
  await judgeSetting.check();
  const applyJudgeSetting = page.getByRole("button", { name: "Apply judge setting" });
  await applyJudgeSetting.click();
  await page.getByRole("checkbox", { name: /Offer the offline relevance judge/u }).waitFor();
  assert(await page.getByRole("checkbox", { name: /Offer the offline relevance judge/u }).isChecked(),
    "The accepted judge setting must remain visibly enabled after the room rerender");
  await page.waitForFunction(() => document.querySelector("#announcer")?.textContent?.includes(
    "The offline relevance judge is now available.",
  ));
  await page.waitForFunction(() => document.activeElement?.matches('[data-setup-focus="judge-apply"]'));
  assert(await applyJudgeSetting.evaluate((button) => document.activeElement === button),
    "Applying the privacy-sensitive judge setting must preserve keyboard focus through the room rerender");
  await assertNoAxeViolations(page, "Room lobby with offline judge enabled");

  // Enter submits the local save form, then focus lands on the replacement
  // button instead of disappearing when the panel rerenders.
  const kitName = page.getByLabel("Kit name");
  await kitName.fill("Keyboard kit");
  await kitName.press("Enter");
  await page.locator("[data-setup-kit-status]").filter({ hasText: "Saved “Keyboard kit” on this device." }).waitFor();
  const saveKit = page.getByRole("button", { name: "Save applied setup" });
  assert(await saveKit.evaluate((button) => document.activeElement === button),
    "Keyboard save must retain a useful focus target after the local rerender");
  assert(!await page.getByRole("button", { name: "Apply selected kit" }).isDisabled(),
    "A saved kit must enable Apply");

  const applyKit = page.getByRole("button", { name: "Apply selected kit" });
  await applyKit.focus();
  await page.keyboard.press("Enter");
  await page.locator("[data-setup-kit-status]").filter({ hasText: `Applied “Keyboard kit” to room ${roomCode}.` }).waitFor();
  assert(await applyKit.evaluate((button) => document.activeElement === button),
    "Keyboard apply must preserve focus through the authoritative room rerender");
  await assertNoAxeViolations(page, "Room lobby with a saved setup kit");

  const topicImport = page.getByLabel("Import topic list (.txt)");
  await topicImport.focus();
  assert(await topicImport.evaluate((input) => document.activeElement === input),
    "The native topic-file control must be keyboard focusable");

  await page.setViewportSize({ width: 320, height: 800 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "The room lobby and setup-kit controls must reflow at 320 CSS pixels without page-level horizontal scrolling");
  assert(await page.locator("[data-setup-kits]").evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
    "The setup-kit panel must not overflow its 320-pixel layout");
  await assertNoAxeViolations(page, "Room lobby with setup kits at 320 CSS pixels");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const setupTransitionDurations = await page.locator("[data-setup-kits]").evaluate((panel) => getComputedStyle(panel).transitionDuration);
  assert(setupTransitionDurations.split(",").every((duration) => Number.parseFloat(duration) === 0),
    `Reduced-motion mode must remove setup-kit transitions, got ${JSON.stringify(setupTransitionDurations)}`);
  await page.setViewportSize({ width: 1280, height: 900 });

  const localPlayerForm = page.locator("form[data-room-action]:has(input[value='add-player'])");
  await localPlayerForm.locator("input[name='name']").fill("Accessibility Guest");
  await localPlayerForm.getByRole("button", { name: "Add" }).click();
  await page.getByLabel("Rename Accessibility Guest").waitFor();
  await page.getByRole("button", { name: "Start game" }).click();
  await page.getByRole("heading", { level: 2, name: "Accessibility Host is up." }).waitFor();
  await assertSinglePageStructure(page, "Room ready state");
  await assertNoAxeViolations(page, "Room ready state");
  await page.getByRole("button", { name: "Draw topic" }).click();
  await page.locator(".turn-card .room-state-title").waitFor();
  const judgeChoices = page.locator('[data-turn-judge-choice] input[name="turnJudgeChoice"]');
  assert(await judgeChoices.count() === 2,
    "The exact speaker must receive two labeled per-turn judge choices");
  assert(await page.getByRole("radio", { name: /Classic scoring/u }).count() === 1,
    "Classic scoring must be an accessible radio choice");
  assert(await page.getByRole("radio", { name: /Use on-device transcription/u }).count() === 1,
    "On-device transcription must be an accessible radio choice");
  assert((await judgeChoices.evaluateAll((controls) => controls.filter((control) => control.checked).length)) === 0,
    "A fresh turn must not imply transcript consent");
  assert(await page.locator("[data-timer]").getAttribute("role") === "timer",
    "The multiplayer countdown must expose timer semantics");
  assert((await page.locator("[data-timer]").getAttribute("aria-label"))?.endsWith(" seconds remaining"),
    "The multiplayer countdown must expose its remaining time");
  const soundCues = page.getByRole("button", { name: "Sound cues", exact: true });
  assert(await soundCues.count() === 1,
    "Only the current turn driver must receive one sound-cue preference control");
  assert(await soundCues.getAttribute("aria-pressed") === "true",
    "Sound cues must default on and expose their state with aria-pressed");
  await soundCues.focus();
  await page.keyboard.press("Space");
  assert(await soundCues.getAttribute("aria-pressed") === "false",
    "Space must turn sound cues off");
  assert(await soundCues.evaluate((button) => document.activeElement === button),
    "Changing sound cues must preserve keyboard focus");
  await page.keyboard.press("Enter");
  assert(await soundCues.getAttribute("aria-pressed") === "true",
    "Enter must turn sound cues back on");
  assert(await soundCues.evaluate((button) => document.activeElement === button),
    "Previewing sound cues must preserve keyboard focus");
  await assertSinglePageStructure(page, "Active room turn");
  await assertNoAxeViolations(page, "Active room turn");

  await page.setViewportSize({ width: 320, height: 800 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "The active room must reflow at 320 CSS pixels without page-level horizontal scrolling");

  await page.emulateMedia({ reducedMotion: "reduce" });
  assert(await soundCues.getAttribute("aria-pressed") === "true",
    "Reduced-motion mode must not silently change the independent sound preference");
  const transitionDurations = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "coach-tip";
    document.body.append(probe);
    const durations = getComputedStyle(probe).transitionDuration;
    probe.remove();
    return durations;
  });
  assert(transitionDurations.split(",").every((duration) => Number.parseFloat(duration) === 0),
    `Reduced-motion mode must remove interface transitions, got ${JSON.stringify(transitionDurations)}`);

  trackProgressRequests = true;
  await page.goto(`${origin}/progress`);
  await page.waitForSelector('[data-artifact-usage="ready"]');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "The empty artifact dashboard must reflow at 320 CSS pixels without page-level horizontal scrolling");
  await assertSinglePageStructure(page, "Progress page at 320 CSS pixels");
  await assertNoAxeViolations(page, "Progress page at 320 CSS pixels");

  assert(coachingDataRequests.length === 0,
    `Local Progress unexpectedly sent coaching data over the network: ${coachingDataRequests.join(", ")}`);
  assert(pageErrors.length === 0, `Accessibility smoke emitted page errors: ${JSON.stringify(pageErrors)}`);
  await context.close();
}

const port = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
let logs = "";
const child = spawn(process.execPath, [
  wrangler,
  "dev",
  "--local",
  "--ip",
  "127.0.0.1",
  "--port",
  String(port),
  ...LOCAL_BEST_EFFORT_DELIVERY_WRANGLER_ARGS,
], {
  cwd: root,
  detached: process.platform !== "win32",
  env: { ...process.env, NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
}

let browser;
try {
  await waitForServer(origin, child, () => logs);
  browser = await launchBrowser();
  await runAccessibilityFlow(browser, origin);
  console.log("Public SPA accessibility smoke test passed.");
} catch (error) {
  if (logs.trim()) console.error(`Wrangler output captured before failure:\n${logs.trim()}`);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  stopProcessTree(child);
}
