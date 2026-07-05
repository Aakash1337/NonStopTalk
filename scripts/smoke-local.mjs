import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.once("error", reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error(`Timed out loading ${url}`));
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 60000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await readURL(url);
      if (response.status === 200) {
        return;
      }
      lastError = new Error(`Server returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError || new Error("Server did not start");
}

function stopProcessTree(child) {
  if (!child || child.killed) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // Kill the whole process group: `go run` starts the server as a grandchild
  // that would otherwise survive and keep our stdio pipes open.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function launchBrowser() {
  const headless = process.env.HEADED !== "1";
  // Chromium's sandbox cannot run as root (common in CI containers).
  const chromiumSandbox = process.getuid?.() === 0 ? false : undefined;
  const attempts = [{}, { channel: "chrome" }, { channel: "msedge" }];
  if (process.env.SMOKE_CHROMIUM) {
    attempts.unshift({ executablePath: process.env.SMOKE_CHROMIUM });
  }
  let lastError;
  for (const attempt of attempts) {
    try {
      return await chromium.launch({ headless, chromiumSandbox, ...attempt });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function playerOrder(page) {
  return page.locator(".player-row input[name='name']").evaluateAll((inputs) =>
    inputs.map((input) => input.value),
  );
}

async function expectText(page, selector, expected) {
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent?.includes(expected),
    { selector, expected },
  );
  const text = await page.locator(selector).textContent();
  assert(text && text.includes(expected), `Expected ${selector} to contain ${JSON.stringify(expected)}, got ${JSON.stringify(text)}`);
}

const deniedMicInit = () => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
    },
  });
};

const fakeMicInit = () => {
  window.__audioRequests = [];
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: () =>
        Promise.resolve([
          { kind: "audioinput", deviceId: "mic-alpha", label: "Table Mic" },
          { kind: "audioinput", deviceId: "mic-beta", label: "Room Mic" },
        ]),
      addEventListener() {},
      getUserMedia: (constraints) => {
        window.__audioRequests.push(constraints);
        return Promise.resolve({
          getTracks: () => [{ stop() {} }],
        });
      },
    },
  });
  class FakeAudioContext {
    createMediaStreamSource() {
      return { connect() {} };
    }
    createAnalyser() {
      return {
        fftSize: 1024,
        getByteTimeDomainData(data) {
          data.fill(128);
        },
      };
    }
    close() {
      return Promise.resolve();
    }
  }
  Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
};

const fakeSpeechInit = () => {
  class FakeSpeechRecognition {
    start() {
      setTimeout(() => {
        const result = Object.assign(
      [{ transcript: "pancakes are the best breakfast food and I eat pancakes with syrup for breakfast every single morning" }],
          { isFinal: true },
        );
        this.onresult?.({ resultIndex: 0, results: [result] });
      }, 250);
    }
    stop() {
      this.onend?.();
    }
    abort() {}
  }
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    value: FakeSpeechRecognition,
  });
};

async function createRoom(page, baseURL, hostName) {
  await page.goto(baseURL);
  if (hostName) {
    await page.getByPlaceholder("Host name").fill(hostName);
  }
  await page.getByRole("button", { name: "Create Room" }).click();
  await page.waitForSelector(".room-code");
  const code = (await page.locator(".room-code").textContent()).trim();
  assert(/^[A-Z2-9]{6}$/.test(code), `Expected a room code, got ${JSON.stringify(code)}`);
  return code;
}

async function setupFastCustomGame(page, baseURL) {
  await createRoom(page, baseURL, "Player 1");
  await page.getByLabel("Player name").fill("Player 2");
  await page.getByRole("button", { name: "Add" }).click();
  await page.waitForSelector('input[aria-label="Rename Player 2"]');

  await page.getByLabel("Player name").fill("Casey");
  await page.getByRole("button", { name: "Add" }).click();
  await page.waitForSelector('input[aria-label="Rename Casey"]');
  await page.getByRole("button", { name: "Remove Casey" }).click();
  await page.waitForFunction(() =>
    !Array.from(document.querySelectorAll(".player-row input[name='name']")).some((input) => input.value === "Casey"),
  );

  await page.getByLabel("Rename Player 1").fill("Avery");
  await page.getByRole("button", { name: "Save Player 1" }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".player-row input[name='name']")).some((input) => input.value === "Avery"),
  );

  await page.getByRole("button", { name: "Move Player 2 up" }).click();
  await page.waitForFunction(() => {
    const names = Array.from(document.querySelectorAll(".player-row input[name='name']")).map((input) => input.value);
    return names[0] === "Player 2" && names[1] === "Avery";
  });
  assert(JSON.stringify(await playerOrder(page)) === JSON.stringify(["Player 2", "Avery"]), "Player reorder failed");

  await page.getByLabel("Talk time").fill("10");
  await page.getByLabel("Silence limit").fill("1");
  await page.getByLabel("Rounds").fill("1");
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expectText(page, ".start-band", "10s to survive, 1s silence limit");

  await page.getByPlaceholder("One topic per line").fill("Topic Alpha\nTopic Beta");
  await page.getByRole("button", { name: "Use Custom List" }).click();
  await expectText(page, "#topic-summary", "2 topics loaded");
  await expectText(page, ".setup-grid", "Custom");
}

async function runManualFallbackScenario(browser, baseURL) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(deniedMicInit);

  await setupFastCustomGame(page, baseURL);

  await page.getByRole("button", { name: "Start Game" }).click();
  await page.waitForSelector("[data-turn]");
  await expectText(page, ".topic-block h1", "Topic Alpha");

  await page.getByRole("button", { name: "Start Talking" }).click();
  await expectText(page, "[data-voice-label]", "Mic blocked");
  await expectText(page, "[data-silence-label]", "Manual mode ready");

  await page.getByRole("button", { name: "Redraw Topic" }).click();
  await expectText(page, ".topic-block h1", "Topic Beta");

  await page.reload();
  await page.waitForSelector("[data-turn]");
  await expectText(page, ".topic-block h1", "Topic Beta");

  await page.getByRole("button", { name: "Manual Timer" }).click();
  await expectText(page, "[data-voice-label]", "Manual timing");
  await expectText(page, "[data-silence-label]", "Host controlled");

  await page.getByRole("button", { name: "Mark Complete" }).click();
  await page.waitForSelector(".result-band");
  await expectText(page, ".result-band h1", "Player 2 earned 35 points.");
  await expectText(page, ".score-breakdown", "Speaking time");
  await expectText(page, ".score-breakdown", "Completion bonus");
  await expectText(page, ".score-breakdown", "Total");

  await page.reload();
  await page.waitForSelector(".result-band");
  await expectText(page, ".result-band", "Turn scored");

  await page.getByRole("button", { name: "Add 5 points to Player 2" }).click();
  await expectText(page, ".standings", "40");

  await page.getByRole("button", { name: "Next Turn" }).click();
  await page.waitForSelector("[data-turn]");
  await expectText(page, ".turn-meta", "Avery");
  await page.getByRole("button", { name: "Manual Timer" }).click();
  await expectText(page, "[data-voice-label]", "Manual timing");
  await page.getByRole("button", { name: "Mark Complete" }).click();
  await page.waitForSelector(".winner-band");
  await expectText(page, ".winner-band", "Winner");
  await expectText(page, ".winner-band", "Player 2");

  await page.reload();
  await page.waitForSelector(".winner-band");
  await expectText(page, ".winner-band", "Player 2");

  await page.getByRole("button", { name: "Play Again" }).click();
  await page.waitForSelector(".setup-grid");
  await context.close();
}

async function runAutomaticEndingScenario(browser, baseURL) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(fakeMicInit);

  await createRoom(page, baseURL, "Player 1");
  await page.getByLabel("Player name").fill("Player 2");
  await page.getByRole("button", { name: "Add" }).click();
  await page.waitForSelector('input[aria-label="Rename Player 2"]');

  await page.getByLabel("Talk time").fill("10");
  await page.getByLabel("Silence limit").fill("1");
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expectText(page, ".start-band", "10s to survive, 1s silence limit");

  await page.getByRole("button", { name: "Start Game" }).click();
  await page.waitForSelector("[data-turn]");
  await page.getByRole("button", { name: "Change" }).click();
  await page.waitForSelector('[data-mic-option][data-device-id="mic-beta"]');
  await page.locator('[data-mic-option][data-device-id="mic-beta"]').click();
  await expectText(page, "[data-mic-selected-label]", "Room Mic");
  await page.waitForFunction(() =>
    document.querySelector('[data-mic-option][data-device-id="mic-beta"]')?.getAttribute("aria-selected") === "true",
  );
  await page.getByLabel("Close microphone picker").click();
  await page.getByRole("button", { name: "Manual Timer" }).click();
  await page.waitForSelector(".result-band", { timeout: 15000 });
  await expectText(page, ".result-band h1", "Player 1 earned 35 points.");
  await expectText(page, ".result-band", "10 of 10 seconds spoken");

  await page.getByRole("button", { name: "Next Turn" }).click();
  await page.waitForSelector("[data-turn]");
  await page.waitForFunction(() =>
    document.querySelector('[data-mic-option][data-device-id="mic-beta"]')?.getAttribute("aria-selected") === "true",
  );
  await page.getByRole("button", { name: "Start Talking" }).click();
  const audioRequests = await page.evaluate(() => window.__audioRequests);
  assert(
    audioRequests.some((request) => request.audio?.deviceId?.exact === "mic-beta"),
    `Expected selected microphone to be requested, got ${JSON.stringify(audioRequests)}`,
  );
  await expectText(page, "[data-voice-label]", "Silence");
  await page.waitForSelector(".winner-band", { timeout: 5000 });
  await expectText(page, ".winner-band", "Player 1");
  const scoreRows = await page.locator(".score-row").evaluateAll((rows) =>
    rows.map((row) => row.textContent.replace(/\s+/g, " ").trim()),
  );
  assert(scoreRows.some((row) => row.startsWith("Player 2 ") && !row.includes("35")), `Expected Player 2 to lose by silence timeout, got ${JSON.stringify(scoreRows)}`);

  await context.close();
}

// AI judge mode: the speaker's browser transcribes (mocked SpeechRecognition),
// the transcript is graded server-side (offline heuristic judge in the smoke
// environment), and the score screen shows the relevance bonus and feedback.
async function runAIJudgeScenario(browser, baseURL) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(fakeMicInit);
  await page.addInitScript(fakeSpeechInit);

  await createRoom(page, baseURL, "Avery");
  await page.getByLabel("Player name").fill("Blair");
  await page.getByRole("button", { name: "Add" }).click();
  await page.waitForSelector('input[aria-label="Rename Blair"]');

  await page.getByLabel("Talk time").fill("10");
  await page.getByLabel("Silence limit").fill("1");
  await page.getByLabel("AI judge (optional relevance bonus)").check();
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expectText(page, ".start-band", "10s to survive, 1s silence limit");

  await page.getByPlaceholder("One topic per line").fill("Talk about pancakes and breakfast food");
  await page.getByRole("button", { name: "Use Custom List" }).click();
  await expectText(page, "#topic-summary", "1 topics loaded");

  await page.getByRole("button", { name: "Start Game" }).click();
  await page.waitForSelector("[data-turn][data-ai='1']");
  await expectText(page, ".ai-banner", "Audio never leaves this device");

  // Speak with the fake mic: the mocked recognizer emits an on-topic
  // transcript, then the silent mic eliminates the player after ~1s.
  await page.getByRole("button", { name: "Start Talking" }).click();
  await page.waitForSelector(".result-band", { timeout: 15000 });
  await expectText(page, ".ai-verdict", "Offline judge");
  await expectText(page, ".score-breakdown", "AI relevance");

  await context.close();
}

// Two real browser sessions: a host and a remote player joined by room code,
// kept in sync through server-sent events.
async function runRemoteRoomScenario(browser, baseURL) {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  await guest.addInitScript(fakeMicInit);

  const code = await createRoom(host, baseURL, "Hosty");

  await guest.goto(baseURL);
  await guest.getByPlaceholder("ABC123").fill(code);
  await guest.getByPlaceholder("Player name").fill("Remy");
  await guest.getByRole("button", { name: "Join Room" }).click();
  await guest.waitForSelector(".setup-grid");
  await expectText(guest, ".shell", "Waiting for the host");

  // The host's roster updates live over SSE, no reload.
  await host.waitForFunction(
    () => Array.from(document.querySelectorAll(".player-row input[name='name']")).some((input) => input.value === "Remy"),
    undefined,
    { timeout: 10000 },
  );

  await host.getByLabel("Talk time").fill("10");
  await host.getByLabel("Silence limit").fill("1");
  await host.getByRole("button", { name: "Apply Settings" }).click();
  await expectText(host, ".start-band", "10s to survive, 1s silence limit");

  // Guest sees the updated settings live.
  await expectText(guest, ".settings-summary", "10s");

  await host.getByRole("button", { name: "Start Game" }).click();
  await host.waitForSelector("[data-turn]");

  // Guest is a spectator during the host's turn.
  await guest.waitForSelector(".turn-stage.spectate", { timeout: 10000 });
  await expectText(guest, ".turn-meta", "Hosty is up");

  await host.getByRole("button", { name: "Manual Timer" }).click();
  await host.waitForSelector(".result-band", { timeout: 15000 });
  await expectText(host, ".result-band h1", "Hosty earned 35 points.");

  // Guest's page follows to the score screen and offers them the next turn.
  await guest.waitForSelector(".result-band", { timeout: 10000 });
  await guest.getByRole("button", { name: "Next Turn" }).click();
  await guest.waitForSelector("[data-turn]");
  await expectText(guest, ".turn-meta", "Remy (you)");

  // Host spectates the remote turn.
  await host.waitForSelector(".turn-stage.spectate", { timeout: 10000 });
  await expectText(host, ".turn-meta", "Remy is up");

  // Remy talks into a silent fake mic and gets eliminated by the timeout.
  await guest.getByRole("button", { name: "Start Talking" }).click();
  await guest.waitForSelector(".winner-band", { timeout: 10000 });
  await host.waitForSelector(".winner-band", { timeout: 10000 });
  await expectText(host, ".winner-band", "Hosty");
  await expectText(guest, ".winner-band", "Hosty");

  // Server-authoritative scoring: Remy's ~1s turn cannot be worth much.
  const scoreRows = await host.locator(".score-row").evaluateAll((rows) =>
    rows.map((row) => row.textContent.replace(/\s+/g, " ").trim()),
  );
  const remyRow = scoreRows.find((row) => row.startsWith("Remy"));
  assert(remyRow, `Expected Remy in standings, got ${JSON.stringify(scoreRows)}`);
  const remyScore = Number(remyRow.match(/(\d+)/)?.[1] ?? "-1");
  assert(remyScore >= 0 && remyScore <= 5, `Expected a tiny server-clocked score for Remy, got ${JSON.stringify(remyRow)}`);

  await hostContext.close();
  await guestContext.close();
}

async function main() {
  const port = process.env.SMOKE_PORT || String(await getFreePort());
  const baseURL = `http://127.0.0.1:${port}`;
  // Force the offline judge so the AI scenario is deterministic and free.
  const env = { ...process.env, PORT: port };
  delete env.ANTHROPIC_API_KEY;
  const server = spawn("go", ["run", "./cmd/web"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const output = [];
  server.stdout.on("data", (chunk) => output.push(chunk.toString()));
  server.stderr.on("data", (chunk) => output.push(chunk.toString()));

  let browser;
  try {
    await waitForServer(baseURL);
    browser = await launchBrowser();
    await runManualFallbackScenario(browser, baseURL);
    await runAutomaticEndingScenario(browser, baseURL);
    await runRemoteRoomScenario(browser, baseURL);
    await runAIJudgeScenario(browser, baseURL);
    console.log("Smoke test passed (local, automatic ending, remote room, AI judge)");
  } catch (error) {
    console.error("Smoke test failed");
    console.error(error);
    if (output.length > 0) {
      console.error("\nServer output:");
      console.error(output.join("").trim());
    }
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    stopProcessTree(server);
  }
}

await main();
