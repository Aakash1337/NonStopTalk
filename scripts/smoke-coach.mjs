import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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

async function readURL(url) {
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
      if (await readURL(url) === 200) return;
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

const syntheticCoachAudio = () => {
  window.__coachTrackStopped = false;
  window.__coachGetUserMediaCalls = 0;
  const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      async getUserMedia() {
        window.__coachGetUserMediaCalls += 1;
        const context = new NativeAudioContext();
        await context.resume();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const destination = context.createMediaStreamDestination();
        oscillator.frequency.value = 190;
        oscillator.connect(gain).connect(destination);
        const now = context.currentTime;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.setValueAtTime(0.075, now + 2.05);
        gain.gain.setValueAtTime(0.0002, now + 5.8);
        gain.gain.setValueAtTime(0.075, now + 6.8);
        oscillator.start();
        const stream = destination.stream;
        for (const track of stream.getTracks()) {
          const nativeStop = track.stop.bind(track);
          track.stop = () => {
            window.__coachTrackStopped = true;
            nativeStop();
            oscillator.stop();
            context.close().catch(() => {});
          };
        }
        return stream;
      },
    },
  });

  class LocalRecognition {
    constructor() {
      this.processLocally = false;
      this.continuous = false;
      this.interimResults = false;
      this.timer = 0;
    }
    start(track) {
      if (!this.processLocally || track?.kind !== "audio") throw new DOMException("Local track required", "NotSupportedError");
      this.timer = window.setTimeout(() => {
        const alternative = { transcript: "Um basically my idea solves the problem and my idea gives people a clearer next step" };
        const result = { 0: alternative, length: 1, isFinal: true };
        this.onresult?.({ results: { 0: result, length: 1 } });
      }, 500);
    }
    stop() { clearTimeout(this.timer); }
    abort() { clearTimeout(this.timer); }
  }
  Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: LocalRecognition });
};

const delayedCoachPermission = () => {
  window.__lateCoachTrackStopped = false;
  let resolvePermission;
  const track = {
    kind: "audio",
    readyState: "live",
    stop() {
      this.readyState = "ended";
      window.__lateCoachTrackStopped = true;
    },
  };
  window.__resolveCoachPermission = () => resolvePermission?.({
    getTracks: () => [track],
    getAudioTracks: () => [track],
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => new Promise((resolve) => { resolvePermission = resolve; }),
    },
  });
};

const delayedCoachWorklet = () => {
  window.__activeCoachIntervals = new Set();
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  window.setInterval = (callback, milliseconds, ...args) => {
    const id = nativeSetInterval(callback, milliseconds, ...args);
    window.__activeCoachIntervals.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    window.__activeCoachIntervals.delete(id);
    return nativeClearInterval(id);
  };
  AudioWorklet.prototype.addModule = () => new Promise((resolve) => {
    window.__resolveCoachWorklet = resolve;
  });
};

const inspectableCoachWorklet = () => {
  const NativeAudioWorkletNode = window.AudioWorkletNode;
  window.AudioWorkletNode = class extends NativeAudioWorkletNode {
    constructor(...args) {
      super(...args);
      window.__coachWorkletNode = this;
    }
  };
};

const stalledCalibrationMeter = () => {
  window.AudioWorkletNode = class {
    constructor(context) {
      const node = context.createGain();
      Object.defineProperty(node, "port", {
        configurable: true,
        value: { onmessage: null, close() {} },
      });
      return node;
    }
  };
};

async function storedSummaries(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("nonstoptalk-coaching", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction("session-summaries", "readonly").objectStore("session-summaries").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

async function storedArtifacts(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("nonstoptalk-coaching", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction("session-artifacts", "readonly").objectStore("session-artifacts").getAll();
        request.onsuccess = () => resolve(request.result.map((item) => ({
          id: item.id,
          audioSize: item.audioBlob instanceof Blob ? item.audioBlob.size : -1,
          audioType: item.audioBlob instanceof Blob ? item.audioBlob.type : "",
          transcript: item.transcript,
        })));
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

async function runPracticeFlow(browser, origin) {
  const context = await browser.newContext();
  await context.addInitScript(syntheticCoachAudio);
  const page = await context.newPage();
  const pageErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });

  await page.goto(`${origin}/practice`);
  await page.waitForSelector("[data-coach-setup]");
  assert((await page.locator("body").innerText()).toLocaleLowerCase().includes("on device"), "Practice setup must disclose on-device processing");
  const retentionCheckbox = page.getByLabel("Optional full session retention").getByRole("checkbox");
  assert(!(await retentionCheckbox.isChecked()), "Raw audio/full transcript retention must be opt-in");
  await page.getByLabel("Optional transcript analysis").getByRole("checkbox").check();
  await retentionCheckbox.check();
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForSelector("[data-coach-calibration]");
  await page.waitForSelector("[data-coach-live]", { timeout: 12_000 });
  await page.waitForTimeout(3_200);
  const meterWidth = await page.locator("[data-coach-meter]").evaluate((element) => Number.parseFloat(element.style.width));
  assert(meterWidth > 0, `Expected a live input meter, got ${meterWidth}`);
  await page.locator("[data-coach-stop]").click();
  await page.waitForSelector("[data-coach-review]");
  await page.waitForSelector("[data-coach-timeline] .voice");
  await page.waitForSelector("[data-coach-timeline] .pause");
  await page.waitForSelector("[data-coach-grounding]");
  const review = await page.locator("[data-coach-review]").innerText();
  const normalizedReview = review.toLocaleLowerCase();
  for (const expected of ["Strength", "Focus next", "Drill", "speaking ratio", "level consistency", "clipping frames", "On-device transcript", "Local RAG", "NonStopTalk Coaching Library"]) {
    assert(normalizedReview.includes(expected.toLocaleLowerCase()), `Expected review to include ${JSON.stringify(expected)}`);
  }
  const summaries = await storedSummaries(page);
  assert(summaries.length === 1, `Expected one locally stored summary, got ${summaries.length}`);
  const summary = summaries[0];
  const serialized = JSON.stringify(summaries);
  assert(!serialized.includes("Um basically"), "Stored summaries must not contain the full transcript");
  assert(!serialized.includes("data:audio") && !serialized.includes("audioBlob"), "Stored summaries must not contain audio");
  assert(JSON.stringify(Object.keys(summary).sort()) === JSON.stringify(["advice", "analysisSchemaVersion", "artifacts", "createdAt", "goal", "id", "metrics", "scenario", "targetDurationMs"].sort()), "Stored summary must use the reviewed top-level allowlist");
  assert(!("segments" in summary.metrics) && !("transcript" in summary.metrics) && !("frames" in summary.metrics), "Stored metrics must exclude timelines, raw transcripts, and live frames");
  assert(summary.metrics.transcriptMetrics?.fillerOccurrences?.some((item) => item.phrase === "um"), "Consented derived filler patterns should be retained locally for analysis");
  const artifacts = await storedArtifacts(page);
  assert(artifacts.length === 1, `Expected one opted-in full session artifact, got ${artifacts.length}`);
  assert(artifacts[0].audioSize > 0, "The opted-in browser-encoded recording should be stored as a non-empty Blob");
  assert(artifacts[0].transcript.includes("basically my idea"), "Opted-in full transcript should be retained locally");
  assert(apiRequests.length === 0, `Practice mode unexpectedly called the backend: ${apiRequests.join(", ")}`);
  assert(pageErrors.length === 0, `Practice page emitted errors: ${JSON.stringify(pageErrors)}`);

  await page.getByRole("link", { name: "View progress" }).click();
  await page.waitForSelector("[data-coach-progress]");
  await page.waitForFunction(() => document.activeElement?.tagName === "H1");
  assert((await page.locator("h1").innerText()).toLocaleLowerCase().includes("baseline"), "SPA navigation should move focus to the Progress heading");
  assert(/1\s+attempts? for this site/i.test(await page.locator("[data-coach-progress]").innerText()), "Progress should show the saved attempt");
  assert(await page.getByRole("button", { name: "Download recording" }).isVisible(), "Progress should expose the opted-in recording");
  assert(await page.getByRole("button", { name: "Download transcript" }).isVisible(), "Progress should expose the opted-in transcript");
  const [recordingDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download recording" }).click(),
  ]);
  assert((await readFile(await recordingDownload.path())).length > 0, "Downloaded recording should contain the stored audio Blob");
  const [transcriptDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download transcript" }).click(),
  ]);
  const downloadedTranscript = await readFile(await transcriptDownload.path(), "utf8");
  assert(downloadedTranscript.includes("basically my idea"), "Downloaded transcript should contain the full captured text");
  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export JSON" }).click(),
  ]);
  const exported = JSON.parse(await readFile(await jsonDownload.path(), "utf8"));
  const exportedText = JSON.stringify(exported);
  assert(exported.sessions?.length === 1, "JSON export should contain the compact summary");
  assert(!exportedText.includes("basically my idea") && !exportedText.includes("audioBlob"), "JSON export must exclude the full transcript and recording Blob");
  await page.reload();
  await page.waitForSelector("[data-coach-progress]");
  const reloadedProgress = await page.locator("[data-coach-progress]").innerText();
  let reloadStorageDebug = "";
  if (!reloadedProgress.toLocaleLowerCase().includes("interview answer")) {
    try {
      reloadStorageDebug = JSON.stringify(await storedSummaries(page));
    } catch (error) {
      reloadStorageDebug = `${error?.name}: ${error?.message}`;
    }
  }
  assert(reloadedProgress.toLocaleLowerCase().includes("interview answer"), `Progress must survive a reload; storage=${reloadStorageDebug}; got ${JSON.stringify(reloadedProgress)}`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete local history" }).click();
  await page.waitForSelector(".empty-progress");
  assert((await storedSummaries(page)).length === 0, "Deleting local history must clear summaries");
  assert((await storedArtifacts(page)).length === 0, "Deleting local history must clear full artifacts");
  await context.close();
}

async function runDefaultRetentionFlow(browser, origin) {
  const context = await browser.newContext();
  await context.addInitScript(syntheticCoachAudio);
  await context.addInitScript(() => {
    const NativeMediaRecorder = window.MediaRecorder;
    window.__coachRecorderConstructed = 0;
    window.MediaRecorder = class extends NativeMediaRecorder {
      constructor(...args) {
        super(...args);
        window.__coachRecorderConstructed += 1;
      }
      static isTypeSupported(value) { return NativeMediaRecorder.isTypeSupported(value); }
    };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/practice`);
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForSelector("[data-coach-live]", { timeout: 12_000 });
  await page.waitForTimeout(500);
  await page.locator("[data-coach-stop]").click();
  await page.waitForSelector("[data-coach-review]");
  assert(await page.evaluate(() => window.__coachRecorderConstructed) === 0, "Default-off retention must not construct a MediaRecorder");
  assert((await storedSummaries(page)).length === 1, "Default-off flow should still save its compact summary");
  assert((await storedArtifacts(page)).length === 0, "Default-off flow must not persist a recording or full transcript artifact");
  assert(pageErrors.length === 0, `Default retention flow emitted errors: ${JSON.stringify(pageErrors)}`);
  await context.close();
}

async function runVersionOneMigrationFlow(browser, origin) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("nonstoptalk-coaching", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("session-summaries", { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.goto(`${origin}/progress`);
  await page.waitForSelector("[data-coach-progress]");
  const stores = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("nonstoptalk-coaching", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const names = [...database.objectStoreNames];
    database.close();
    return names;
  });
  assert(stores.includes("session-summaries") && stores.includes("session-artifacts"), "IndexedDB v1 history should upgrade to both v2 stores");
  await context.close();
}

async function runCancelledPermissionFlow(browser, origin) {
  const context = await browser.newContext();
  await context.addInitScript(delayedCoachPermission);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/practice`);
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForSelector("[data-coach-calibration]");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForSelector("[data-coach-setup]");
  await page.evaluate(() => window.__resolveCoachPermission());
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => window.__lateCoachTrackStopped), "A microphone stream resolving after cancellation must be stopped");
  assert(await page.locator("[data-coach-live]").count() === 0, "A cancelled permission request must not start coaching later");
  assert(pageErrors.length === 0, `Cancelled permission flow emitted errors: ${JSON.stringify(pageErrors)}`);
  await context.close();
}

async function runCancelledWorkletFlow(browser, origin) {
  const context = await browser.newContext();
  await context.addInitScript(syntheticCoachAudio);
  await context.addInitScript(delayedCoachWorklet);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/practice`);
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForFunction(() => typeof window.__resolveCoachWorklet === "function");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForSelector("[data-coach-setup]");
  await page.evaluate(() => window.__resolveCoachWorklet());
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => window.__coachTrackStopped), "Cancelling during AudioWorklet loading must stop the microphone track");
  assert(await page.evaluate(() => window.__activeCoachIntervals.size) === 0, "Cancelling during AudioWorklet loading must not leave a fallback interval");
  assert(await page.locator("[data-coach-live]").count() === 0, "A cancelled AudioWorklet load must not start coaching later");
  assert(pageErrors.length === 0, `Cancelled AudioWorklet flow emitted errors: ${JSON.stringify(pageErrors)}`);
  await context.close();
}

async function runStalledActiveFlow(browser, origin) {
  const context = await browser.newContext();
  await context.addInitScript(syntheticCoachAudio);
  await context.addInitScript(inspectableCoachWorklet);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/practice`);
  await page.locator('select[name="duration"]').evaluate((select) => {
    select.add(new Option("15 seconds", "15"));
    select.value = "15";
  });
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForSelector("[data-coach-live]", { timeout: 12_000 });
  await page.waitForFunction(() => Boolean(window.__coachWorkletNode));
  await page.evaluate(() => { window.__coachWorkletNode.port.onmessage = null; });
  await page.waitForSelector("[data-coach-review]", { timeout: 20_000 });
  const review = (await page.locator("[data-coach-review]").innerText()).toLocaleLowerCase();
  assert(review.includes("unobserved audio"), "A stalled active meter should disclose unobserved audio rather than invent speech");
  assert(!review.includes("create an idea boundary"), "A stalled meter must not produce false continuous-speech advice");
  assert(await page.evaluate(() => window.__coachTrackStopped), "The wall-clock deadline must stop the microphone after a stalled callback stream");
  assert(pageErrors.length === 0, `Stalled active flow emitted errors: ${JSON.stringify(pageErrors)}`);
  await context.close();
}

async function runStalledCalibrationFlow(browser, origin) {
  const context = await browser.newContext();
  await context.addInitScript(syntheticCoachAudio);
  await context.addInitScript(stalledCalibrationMeter);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/practice`);
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForSelector("[data-coach-calibration]");
  await page.waitForSelector("[data-coach-setup]", { timeout: 9_000 });
  const text = (await page.locator("body").innerText()).toLocaleLowerCase();
  assert(text.includes("analysis stopped during calibration"), "A callback-free calibration should fail with an actionable message");
  assert(await page.evaluate(() => window.__coachTrackStopped), "Calibration timeout must stop the microphone");
  assert(pageErrors.length === 0, `Stalled calibration flow emitted errors: ${JSON.stringify(pageErrors)}`);
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
  await waitForServer(`${origin}/practice`, child, () => logs);
  browser = await launchBrowser();
  await runPracticeFlow(browser, origin);
  await runDefaultRetentionFlow(browser, origin);
  await runVersionOneMigrationFlow(browser, origin);
  await runCancelledPermissionFlow(browser, origin);
  await runCancelledWorkletFlow(browser, origin);
  await runStalledActiveFlow(browser, origin);
  await runStalledCalibrationFlow(browser, origin);
  console.log("Speech coaching browser smoke test passed.");
} finally {
  await browser?.close().catch(() => {});
  stopProcessTree(child);
}
