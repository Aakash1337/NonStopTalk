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
  child.kill("SIGTERM");
}

async function launchBrowser() {
  const headless = process.env.HEADED !== "1";
  const attempts = [{}, { channel: "chrome" }, { channel: "msedge" }];
  let lastError;
  for (const attempt of attempts) {
    try {
      return await chromium.launch({ headless, ...attempt });
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

async function setupFastCustomGame(page, baseURL) {
  await page.goto(baseURL);

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
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
      },
    });
  });

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
  await page.close();
}

async function runAutomaticEndingScenario(browser, baseURL) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.resolve({
            getTracks: () => [{ stop() {} }],
          }),
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
  });

  await page.goto(baseURL);
  await page.getByLabel("Talk time").fill("10");
  await page.getByLabel("Silence limit").fill("1");
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expectText(page, ".start-band", "10s to survive, 1s silence limit");

  await page.getByRole("button", { name: "Start Game" }).click();
  await page.waitForSelector("[data-turn]");
  await page.getByRole("button", { name: "Manual Timer" }).click();
  await page.waitForSelector(".result-band", { timeout: 15000 });
  await expectText(page, ".result-band h1", "Player 1 earned 35 points.");
  await expectText(page, ".result-band", "10 of 10 seconds spoken");

  await page.getByRole("button", { name: "Next Turn" }).click();
  await page.waitForSelector("[data-turn]");
  await page.getByRole("button", { name: "Start Talking" }).click();
  await expectText(page, "[data-voice-label]", "Silence");
  await page.waitForSelector(".winner-band", { timeout: 5000 });
  await expectText(page, ".winner-band", "Player 1");
  const scoreRows = await page.locator(".score-row").evaluateAll((rows) =>
    rows.map((row) => row.textContent.replace(/\s+/g, " ").trim()),
  );
  assert(scoreRows.some((row) => row.startsWith("Player 2 ") && !row.includes("35")), `Expected Player 2 to lose by silence timeout, got ${JSON.stringify(scoreRows)}`);

  await page.close();
}

async function main() {
  const port = process.env.SMOKE_PORT || String(await getFreePort());
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn("go", ["run", "./cmd/web"], {
    cwd: root,
    env: { ...process.env, PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
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
    console.log("MVP smoke test passed");
  } catch (error) {
    console.error("MVP smoke test failed");
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
