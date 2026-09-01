import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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

async function assertNoAxeViolations(page, label) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  assert(result.violations.length === 0, `${label} has axe violations: ${JSON.stringify(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target),
  })))}`);
}

function normalizeHyphenatedText(value) {
  return String(value)
    .toLocaleLowerCase()
    .replace(/[-\u2010-\u2015\u2212]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
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
        for (let cycleStart = 5.8; cycleStart < 5 * 60; cycleStart += 4) {
          gain.gain.setValueAtTime(0.0002, now + cycleStart);
          gain.gain.setValueAtTime(0.075, now + cycleStart + 1);
        }
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
    stop() {
      clearTimeout(this.timer);
      window.__coachRecognitionLateFlushOutcome = "pending";
      this.timer = window.setTimeout(() => {
        window.__coachRecognitionLateFlushOutcome = "delivered";
        const alternative = { transcript: "Um basically my idea solves the problem and my idea gives people a clearer next step after the delayed flush" };
        const result = { 0: alternative, length: 1, isFinal: true };
        this.onresult?.({ results: { 0: result, length: 1 } });
        this.onerror?.({ type: "error", error: "no-speech" });
      }, window.__coachRecognitionFinalDelay ?? 600);
    }
    abort() {
      if (window.__coachRecognitionLateFlushOutcome === "pending") {
        window.__coachRecognitionLateFlushOutcome = "cancelled";
      }
      clearTimeout(this.timer);
    }
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
  window.__coachIntervalBaseline = new Set();
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
  window.__captureCoachIntervalBaseline = () => {
    window.__coachIntervalBaseline = new Set(window.__activeCoachIntervals);
  };
  window.__coachIntervalsAfterBaseline = () => [...window.__activeCoachIntervals]
    .filter((id) => !window.__coachIntervalBaseline.has(id)).length;
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
          transcriptMayBePartial: item.transcriptMayBePartial,
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
  assert(normalizeHyphenatedText(await page.locator("body").innerText()).includes("on device"), "Practice setup must disclose on-device processing");
  await page.getByRole("radio", { name: /Single coached attempt/ }).check();
  const retentionCheckbox = page.getByLabel("Optional full session retention").getByRole("checkbox");
  assert(!(await retentionCheckbox.isChecked()), "Raw audio/full transcript retention must be opt-in");
  await page.getByLabel("Optional transcript analysis").getByRole("checkbox").check();
  await retentionCheckbox.check();
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForSelector("[data-coach-calibration]");
  assert(await page.locator("[data-coach-calibration] h1").evaluate((heading) => document.activeElement === heading),
    "Starting calibration must move focus to its status heading");
  await page.waitForSelector("[data-coach-live]", { timeout: 12_000 });
  assert(await page.locator("[data-coach-live] h1").evaluate((heading) => document.activeElement === heading),
    "Starting an attempt must move focus to its prompt heading");
  assert(await page.locator("[data-coach-timer]").getAttribute("role") === "timer",
    "The coaching countdown must expose timer semantics");
  assert(await page.locator(".coach-meter").getAttribute("role") === "meter",
    "The microphone level must expose meter semantics");
  await assertNoAxeViolations(page, "Live coaching view");
  await page.waitForTimeout(3_200);
  const meterWidth = await page.locator("[data-coach-meter]").evaluate((element) => Number.parseFloat(element.style.width));
  assert(meterWidth > 0, `Expected a live input meter, got ${meterWidth}`);
  assert(Number(await page.locator(".coach-meter").getAttribute("aria-valuenow")) > 0,
    "The microphone meter must update its accessible value");
  await page.locator("[data-coach-stop]").click();
  await page.waitForSelector("[data-coach-review]");
  assert(await page.locator("[data-coach-review] h1").evaluate((heading) => document.activeElement === heading),
    "Completing an attempt must move focus to its review heading");
  await assertNoAxeViolations(page, "Coaching review");
  await page.waitForSelector("[data-coach-timeline] .voice");
  await page.waitForSelector("[data-coach-timeline] .pause");
  await page.waitForSelector("[data-coach-grounding]");
  const review = await page.locator("[data-coach-review]").innerText();
  const normalizedReview = review.toLocaleLowerCase();
  for (const expected of ["Strength", "Focus next", "Drill", "speaking ratio", "level consistency", "clipping frames", "On-device transcript", "Local RAG", "NonStopTalk Coaching Library"]) {
    assert(normalizedReview.includes(expected.toLocaleLowerCase()), `Expected review to include ${JSON.stringify(expected)}`);
  }
  assert(normalizedReview.includes("transcript may be partial"), "A late recognition error must preserve captured text while warning that it may be partial");
  const summaries = await storedSummaries(page);
  assert(summaries.length === 1, `Expected one locally stored summary, got ${summaries.length}`);
  const summary = summaries[0];
  const serialized = JSON.stringify(summaries);
  assert(!serialized.includes("Um basically"), "Stored summaries must not contain the full transcript");
  assert(!serialized.includes("data:audio") && !serialized.includes("audioBlob"), "Stored summaries must not contain audio");
  assert(JSON.stringify(Object.keys(summary).sort()) === JSON.stringify(["advice", "analysisSchemaVersion", "artifacts", "baselineAttemptId", "createdAt", "feedbackMode", "goal", "id", "attemptRole", "metrics", "practiceLoopId", "scenario", "targetDurationMs"].sort()), "Stored summary must use the reviewed top-level allowlist");
  assert(summary.attemptRole === "standalone" && summary.feedbackMode === "live-cues", "Single coached attempts must remain explicit standalone/live-cue records");
  assert(summary.practiceLoopId === null && summary.baselineAttemptId === null, "Standalone attempts must not claim a practice-loop relationship");
  assert(!("segments" in summary.metrics) && !("transcript" in summary.metrics) && !("frames" in summary.metrics), "Stored metrics must exclude timelines, raw transcripts, and live frames");
  assert(summary.metrics.transcriptMetrics?.fillerOccurrences?.some((item) => item.phrase === "um"), "Consented derived filler patterns should be retained locally for analysis");
  assert(summary.artifacts.transcriptMayBePartial === true, "Summary metadata must preserve the partial-transcript warning without storing full text there");
  const artifacts = await storedArtifacts(page);
  assert(artifacts.length === 1, `Expected one opted-in full session artifact, got ${artifacts.length}`);
  assert(artifacts[0].audioSize > 0, "The opted-in browser-encoded recording should be stored as a non-empty Blob");
  assert(artifacts[0].transcript.includes("basically my idea"), "Opted-in captured transcript should be retained locally");
  assert(artifacts[0].transcript.includes("delayed flush"), "Final local-recognition results arriving after the old 350ms cutoff should be retained");
  assert(artifacts[0].transcriptMayBePartial === true, "A retained transcript followed by a recognition error must be marked as possibly partial");
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
  await page.getByRole("button", { name: "Delete saved artifacts" }).click();
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent?.includes("compact summary remains"));
  assert((await storedSummaries(page)).length === 1, "Per-attempt artifact deletion must preserve the compact summary");
  assert((await storedArtifacts(page)).length === 0, "Per-attempt artifact deletion must remove the selected local artifact");
  assert(await page.getByRole("button", { name: "Download recording" }).count() === 0, "Deleted recording controls must disappear after metadata is updated");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete local history" }).click();
  await page.waitForSelector(".empty-progress");
  assert((await storedSummaries(page)).length === 0, "Deleting local history must clear summaries");
  assert((await storedArtifacts(page)).length === 0, "Deleting local history must clear full artifacts");
  await context.close();
}

async function runPracticeLoopFlow(browser, origin) {
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
  assert(await page.getByRole("radio", { name: /Baseline \+ unassisted retry/ }).isChecked(),
    "The deliberate baseline/retry loop should be the default practice format");
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForSelector("[data-coach-live]", { timeout: 12_000 });
  assert(await page.getByText("No live coaching cues.", { exact: true }).isVisible(),
    "A paired baseline must explicitly hide coaching cues until review");
  assert(await page.locator("[data-coach-tip]").count() === 0, "A paired baseline must not mount the live-tip surface");
  assert(await page.locator("[data-coach-meter]").count() === 0, "A paired baseline must not reveal the live input meter");
  assert(await page.locator(".live-stats").count() === 0, "A paired baseline must not reveal live measurements");
  await page.waitForTimeout(650);
  await page.locator("[data-coach-stop]").click();
  await page.waitForSelector("[data-coach-review]");
  assert(await page.getByRole("button", { name: /Prepare unassisted retry/ }).isVisible(),
    "A baseline review must offer its explicit unassisted retry");

  let summaries = await storedSummaries(page);
  assert(summaries.length === 1, `Expected one saved loop baseline, got ${summaries.length}`);
  const baseline = summaries[0];
  assert(typeof baseline.practiceLoopId === "string" && baseline.practiceLoopId.length > 0,
    "A loop baseline needs a non-empty opaque loop ID");
  assert(baseline.baselineAttemptId === baseline.id, "A loop baseline must self-identify as the paired baseline");
  assert(baseline.attemptRole === "baseline" && baseline.feedbackMode === "review-only",
    "A loop baseline must persist its review-only relationship metadata");

  await page.getByRole("link", { name: "View progress" }).click();
  await page.waitForSelector("[data-coach-progress]");
  assert(await page.locator("[data-practice-loop]").count() === 1,
    "Progress must render the saved baseline as one explicit practice loop");
  assert(await page.getByRole("button", { name: "Complete unassisted retry" }).isVisible(),
    "An incomplete loop must expose a resumable retry action");
  await page.reload();
  await page.waitForSelector("[data-coach-progress]");
  await page.getByRole("button", { name: "Complete unassisted retry" }).click();
  await page.waitForSelector("[data-coach-setup]");

  const setup = page.locator("[data-coach-setup]");
  assert(await setup.locator('select[name="scenario"]').isDisabled(), "A resumed retry must lock the baseline scenario");
  assert(await setup.locator('select[name="goal"]').isDisabled(), "A resumed retry must lock the baseline goal");
  assert(await setup.locator('select[name="duration"]').isDisabled(), "A resumed retry must lock the baseline duration");
  assert(await setup.locator('select[name="scenario"]').inputValue() === baseline.scenario,
    "A resumed retry must restore the baseline scenario");
  assert(await setup.locator('select[name="goal"]').inputValue() === baseline.goal,
    "A resumed retry must restore the baseline goal");
  assert(Number(await setup.locator('select[name="duration"]').inputValue()) * 1_000 === baseline.targetDurationMs,
    "A resumed retry must restore the baseline target duration");
  assert(!(await page.getByLabel("Optional transcript analysis").getByRole("checkbox").isChecked()),
    "A resumed retry must not silently re-enable transcript analysis");
  assert(!(await page.getByLabel("Optional full session retention").getByRole("checkbox").isChecked()),
    "A resumed retry must not silently re-enable full-session retention");
  assert(!(await page.getByLabel("Optional cloud summary backup").getByRole("checkbox").isChecked()),
    "A resumed retry must not silently re-enable cloud backup");

  await page.getByRole("button", { name: /Calibrate for retry/ }).click();
  await page.waitForSelector("[data-coach-live]", { timeout: 12_000 });
  assert(await page.getByText("No live coaching cues.", { exact: true }).isVisible(),
    "The retry must remain unassisted after resuming from Progress");
  assert(await page.locator("[data-coach-tip], [data-coach-meter], .live-stats").count() === 0,
    "The retry must not mount any live coaching feedback surface");
  await page.waitForTimeout(650);
  await page.locator("[data-coach-stop]").click();
  await page.waitForSelector("[data-coach-review]");
  await page.waitForSelector("[data-coach-comparison]");
  const comparisonText = (await page.locator("[data-coach-comparison]").innerText()).toLocaleLowerCase();
  assert(comparisonText.includes("limited evidence"),
    "Short smoke attempts should be labeled as limited evidence instead of implying improvement");
  assert(comparisonText.includes("descriptive change"),
    "Paired measurements must describe the delta without turning it into a score");

  summaries = await storedSummaries(page);
  assert(summaries.length === 2, `Expected one baseline and one linked retry, got ${summaries.length}`);
  const retry = summaries.find((item) => item.id !== baseline.id);
  assert(retry?.practiceLoopId === baseline.practiceLoopId, "The retry must retain the baseline loop ID");
  assert(retry?.baselineAttemptId === baseline.id, "The retry must point to the exact baseline, never a recent substitute");
  assert(retry?.attemptRole === "retry" && retry?.feedbackMode === "review-only",
    "The retry must persist review-only relationship metadata");
  assert(retry?.scenario === baseline.scenario && retry?.goal === baseline.goal && retry?.targetDurationMs === baseline.targetDurationMs,
    "A comparable retry must preserve the baseline scenario, goal, and target duration");

  await page.getByRole("link", { name: "View progress" }).click();
  await page.waitForSelector("[data-coach-progress]");
  assert(await page.locator("[data-practice-loop]").count() === 1,
    "Progress must group a baseline and retry into one practice loop");
  assert(await page.locator("[data-practice-loop] [data-coach-comparison]").count() === 1,
    "The linked goal comparison must survive in Progress");
  const progressText = (await page.locator("[data-coach-progress]").innerText()).toLocaleLowerCase();
  assert(!progressText.includes("latest ratio shift") && !progressText.includes("average speaking ratio"),
    "Progress must not compare unrelated attempts through global ratio aggregates");
  await page.reload();
  await page.waitForSelector("[data-practice-loop] [data-coach-comparison]");
  assert((await storedSummaries(page)).length === 2, "The complete practice loop must survive a reload");
  assert(apiRequests.length === 0, `The default local-first loop unexpectedly called the backend: ${apiRequests.join(", ")}`);
  assert(pageErrors.length === 0, `Practice-loop flow emitted errors: ${JSON.stringify(pageErrors)}`);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete local history" }).click();
  await page.waitForSelector(".empty-progress");
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

async function runTranscriptFinalizationTimeoutFlow(browser, origin) {
  const context = await browser.newContext();
  await context.addInitScript(syntheticCoachAudio);
  await context.addInitScript(() => { window.__coachRecognitionFinalDelay = 2_100; });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/practice`);
  await page.getByLabel("Optional transcript analysis").getByRole("checkbox").check();
  await page.getByLabel("Optional full session retention").getByRole("checkbox").check();
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForSelector("[data-coach-live]", { timeout: 12_000 });
  await page.waitForTimeout(700);
  await page.locator("[data-coach-stop]").click();
  await page.waitForSelector("[data-coach-review]", { timeout: 5_000 });
  await page.waitForFunction(() => ["delivered", "cancelled"].includes(window.__coachRecognitionLateFlushOutcome));
  const review = (await page.locator("[data-coach-review]").innerText()).toLocaleLowerCase();
  assert(review.includes("did not finish within two seconds"), "A recognition flush timeout must be disclosed in the review");
  const summaries = await storedSummaries(page);
  const artifacts = await storedArtifacts(page);
  assert(await page.evaluate(() => window.__coachRecognitionLateFlushOutcome) === "cancelled", "The timed-out local-recognition flush should be cancelled during cleanup");
  assert(summaries[0]?.artifacts?.transcriptMayBePartial === true, "Timeout state must survive in compact summary metadata");
  assert(artifacts[0]?.transcriptMayBePartial === true, "Timeout state must survive with the captured transcript artifact");
  assert(artifacts[0]?.transcript && !artifacts[0].transcript.includes("delayed flush"), "Timed-out final speech must not be silently represented as captured");
  await page.getByRole("link", { name: "View progress" }).click();
  await page.waitForSelector("[data-coach-progress]");
  assert((await page.locator("[data-coach-progress]").innerText()).toLocaleLowerCase().includes("captured transcript may be partial"), "Progress must preserve the partial-transcript disclosure");
  assert(pageErrors.length === 0, `Transcript finalization timeout flow emitted errors: ${JSON.stringify(pageErrors)}`);
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
        store.put({
          id: "legacy-v1-summary",
          createdAt: "2026-01-01T00:00:00.000Z",
          scenario: "interview",
          goal: "pauses",
          targetDurationMs: 45_000,
          metrics: { durationMs: 30_000, speakingRatio: 0.6, pauseCount: 1 },
          advice: { focus: "Legacy focus preserved" },
        });
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
  const migration = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("nonstoptalk-coaching", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = [...database.objectStoreNames];
      const legacySummary = await new Promise((resolve, reject) => {
        const request = database.transaction("session-summaries", "readonly")
          .objectStore("session-summaries")
          .get("legacy-v1-summary");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return { stores, legacySummary };
    } finally {
      database.close();
    }
  });
  assert(migration.stores.includes("session-summaries") && migration.stores.includes("session-artifacts"), "IndexedDB v1 history should upgrade to both v2 stores");
  assert(migration.legacySummary?.advice?.focus === "Legacy focus preserved", "IndexedDB v2 migration must preserve legacy v1 summaries");
  await context.close();
}

async function runLegacyProgressFlow(browser, origin) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("nonstoptalk-coaching", 2);
      request.onupgradeneeded = () => {
        const summaries = request.result.createObjectStore("session-summaries", { keyPath: "id" });
        summaries.createIndex("createdAt", "createdAt");
        const artifacts = request.result.createObjectStore("session-artifacts", { keyPath: "id" });
        artifacts.createIndex("createdAt", "createdAt");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("session-summaries", "readwrite");
      const store = transaction.objectStore("session-summaries");
      store.put({ id: "legacy-missing", createdAt: "2026-08-05T12:00:00.000Z", scenario: "interview", goal: "pace" });
      store.put({ id: "legacy-invalid", createdAt: "2026-08-05T11:00:00.000Z", scenario: "presentation", goal: "pauses", metrics: { speakingRatio: "unknown" } });
      store.put({ id: "legacy-valid", createdAt: "2026-08-05T10:00:00.000Z", scenario: "impromptu", goal: "energy", metrics: { speakingRatio: 0.6 } });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.goto(`${origin}/progress`);
  await page.waitForSelector("[data-coach-progress]");
  const progressMetrics = page.locator(".progress-metrics .review-metric strong");
  assert(await progressMetrics.nth(0).innerText() === "3", "All legacy summaries should remain visible as independent attempts");
  assert(await progressMetrics.nth(1).innerText() === "0", "Legacy summaries must not invent completed practice loops");
  assert(await progressMetrics.nth(2).innerText() === "0", "Legacy summaries must not invent baselines awaiting retry");
  assert(await page.locator("[data-coach-comparison]").count() === 0,
    "Legacy summaries must not be paired by recency or compared without explicit relationship metadata");
  assert(pageErrors.length === 0, `Legacy progress flow emitted errors: ${JSON.stringify(pageErrors)}`);
  await context.close();
}

async function runRouteLinkClickFlow(browser, origin) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  const result = await page.evaluate(() => {
    const link = document.querySelector("[data-route]");
    const dispatch = (init) => {
      let appPreventedDefault = false;
      window.addEventListener("click", (event) => {
        appPreventedDefault = event.defaultPrevented;
        event.preventDefault();
      }, { once: true });
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
      return { appPreventedDefault, pathname: location.pathname };
    };
    return {
      modified: dispatch({ button: 0, ctrlKey: true }),
      nonPrimary: dispatch({ button: 1 }),
      primary: dispatch({ button: 0 }),
    };
  });
  assert(!result.modified.appPreventedDefault && result.modified.pathname === "/", "Modified route-link clicks should retain native browser behavior");
  assert(!result.nonPrimary.appPreventedDefault && result.nonPrimary.pathname === "/", "Non-primary route-link clicks should retain native browser behavior");
  assert(result.primary.appPreventedDefault && result.primary.pathname === "/practice", "Unmodified primary route-link clicks should still use SPA navigation");
  await context.close();
}

async function runCancelledAudioResumeFlow(browser, origin) {
  const context = await browser.newContext();
  await context.addInitScript(syntheticCoachAudio);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/practice`);
  await page.evaluate(() => {
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    class StalledAudioContext extends NativeAudioContext {
      resume() {
        window.__coachAppResumeStarted = true;
        return new Promise(() => {});
      }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: StalledAudioContext });
  });
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForFunction(() => window.__coachAppResumeStarted === true);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForSelector("[data-coach-setup]");
  await page.waitForFunction(() => window.__coachTrackStopped === true);
  assert(await page.evaluate(() => window.__coachTrackStopped), "Cancelling a stalled AudioContext resume must stop the acquired microphone track");
  assert(pageErrors.length === 0, `Cancelled AudioContext resume flow emitted errors: ${JSON.stringify(pageErrors)}`);
  await context.close();
}

async function runCalibrationAccessibilityFlow(browser, origin) {
  const context = await browser.newContext();
  await context.addInitScript(syntheticCoachAudio);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/practice`);
  await page.evaluate(() => {
    const getSyntheticStream = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => new Promise((resolve, reject) => {
      window.__resolveCoachSyntheticPermission = () => getSyntheticStream(...args).then(resolve, reject);
    });
  });
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.getByRole("heading", { name: "Allow microphone access." }).waitFor();
  const cancel = page.getByRole("button", { name: "Cancel" });
  await cancel.focus();
  await page.waitForFunction(() => typeof window.__resolveCoachSyntheticPermission === "function");
  await page.evaluate(() => window.__resolveCoachSyntheticPermission());
  await page.getByRole("heading", { name: "Stay quiet for a moment." }).waitFor({ timeout: 12_000 });
  assert(await cancel.evaluate((button) => document.activeElement === button), "The permission-to-quiet calibration update must preserve keyboard focus");
  await page.waitForFunction(() => document.querySelector("#announcer")?.textContent.includes("Stay quiet"));
  await page.getByRole("heading", { name: "Now speak normally." }).waitFor();
  assert(await cancel.evaluate((button) => document.activeElement === button), "The quiet-to-speaking calibration update must preserve keyboard focus");
  await page.waitForFunction(() => document.querySelector("#announcer")?.textContent.includes("Now speak normally"));
  await cancel.click();
  await page.waitForSelector("[data-coach-setup]");
  assert(await page.evaluate(() => window.__coachTrackStopped), "Cancelling the accessibility calibration flow must stop the microphone");
  assert(pageErrors.length === 0, `Calibration accessibility flow emitted errors: ${JSON.stringify(pageErrors)}`);
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
  await page.waitForFunction(() => window.__lateCoachTrackStopped === true);
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
  await page.evaluate(() => window.__captureCoachIntervalBaseline());
  await page.getByRole("button", { name: /Calibrate microphone/ }).click();
  await page.waitForFunction(() => typeof window.__resolveCoachWorklet === "function");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForSelector("[data-coach-setup]");
  await page.evaluate(() => window.__resolveCoachWorklet());
  await page.waitForFunction(() => window.__coachTrackStopped === true && window.__coachIntervalsAfterBaseline() === 0);
  assert(await page.evaluate(() => window.__coachTrackStopped), "Cancelling during AudioWorklet loading must stop the microphone track");
  assert(await page.evaluate(() => window.__coachIntervalsAfterBaseline()) === 0, "Cancelling during AudioWorklet loading must not leave a fallback interval");
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
  assert(review.includes("retrieved as context") && review.includes("higher-priority evidence rule"), "RAG provenance must not claim an unused card shaped signal-recovery advice");
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
  await runPracticeLoopFlow(browser, origin);
  await runDefaultRetentionFlow(browser, origin);
  await runTranscriptFinalizationTimeoutFlow(browser, origin);
  await runVersionOneMigrationFlow(browser, origin);
  await runLegacyProgressFlow(browser, origin);
  await runRouteLinkClickFlow(browser, origin);
  await runCancelledAudioResumeFlow(browser, origin);
  await runCalibrationAccessibilityFlow(browser, origin);
  await runCancelledPermissionFlow(browser, origin);
  await runCancelledWorkletFlow(browser, origin);
  await runStalledActiveFlow(browser, origin);
  await runStalledCalibrationFlow(browser, origin);
  console.log("Speech coaching browser smoke test passed.");
} catch (error) {
  if (logs.trim()) console.error(`Wrangler output captured before failure:\n${logs.trim()}`);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  stopProcessTree(child);
}
