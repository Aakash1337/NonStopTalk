import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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
  await assertSinglePageStructure(page, "Room lobby");
  await assertNoAxeViolations(page, "Room lobby");

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
  assert(await page.locator("[data-timer]").getAttribute("role") === "timer",
    "The multiplayer countdown must expose timer semantics");
  assert((await page.locator("[data-timer]").getAttribute("aria-label"))?.endsWith(" seconds remaining"),
    "The multiplayer countdown must expose its remaining time");
  await assertSinglePageStructure(page, "Active room turn");
  await assertNoAxeViolations(page, "Active room turn");

  await page.setViewportSize({ width: 320, height: 800 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "The room lobby must reflow at 320 CSS pixels without page-level horizontal scrolling");

  await page.emulateMedia({ reducedMotion: "reduce" });
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
const child = spawn(process.execPath, [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port)], {
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
