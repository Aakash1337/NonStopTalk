import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { LOCAL_BEST_EFFORT_DELIVERY_WRANGLER_ARGS } from "./smoke-local-worker-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ANALYTICS_ORIGIN = "https://static.cloudflareinsights.com";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function contentSecurityPolicySources(policy, directiveName) {
  const directive = String(policy)
    .split(";")
    .map((item) => item.trim().split(/\s+/u))
    .find(([name]) => name === directiveName);
  return directive ? directive.slice(1) : [];
}

function hasScriptFromOrigin(html, documentURL, expectedOrigin) {
  const sources = [...String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/giu)]
    .map((match) => match[1]);
  return sources.some((source) => {
    try {
      return new URL(source, documentURL).origin === expectedOrigin;
    } catch {
      return false;
    }
  });
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
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
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
      const response = await readURL(url);
      if (response.status === 200) return response;
      lastError = new Error(`Server returned ${response.status}`);
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

function utcWindow(throughDay = "2026-09-01") {
  const from = new Date(`${throughDay}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 89);
  return { from: from.toISOString(), through: `${throughDay}T00:00:00.000Z`, days: 90 };
}

function productPayload() {
  return {
    window: utcWindow(),
    totals: {
      room_created: { events: 3, value: 0 },
      game_started: { events: 2, value: 0 },
      game_finished: { events: 1, value: 4 },
      turn_completed: { events: 4, value: 133 },
      coaching_summary_saved: { events: 2, value: 91 },
    },
    daily: [
      { day: "2026-09-01", metric: "room_created", eventCount: 3, valueSum: 0, valueMin: 0, valueMax: 0, updatedAt: "2026-09-01T12:00:00.000Z" },
      { day: "2026-09-01", metric: "game_started", eventCount: 2, valueSum: 0, valueMin: 0, valueMax: 0, updatedAt: "2026-09-01T12:00:00.000Z" },
      { day: "2026-09-01", metric: "game_finished", eventCount: 1, valueSum: 4, valueMin: 4, valueMax: 4, updatedAt: "2026-09-01T12:00:00.000Z" },
      { day: "2026-09-01", metric: "turn_completed", eventCount: 4, valueSum: 133, valueMin: 20, valueMax: 44, updatedAt: "2026-09-01T12:00:00.000Z" },
      { day: "2026-09-01", metric: "coaching_summary_saved", eventCount: 2, valueSum: 91, valueMin: 45, valueMax: 46, updatedAt: "2026-09-01T12:00:00.000Z" },
    ],
    privacy: "Aggregate product events only; <b>never identity</b>.",
    requestId: "smoke-product",
  };
}

function modelPayload() {
  const totals = {
    reservedCalls: 3,
    completedCalls: 2,
    successCount: 1,
    failureCount: 1,
    inputTokens: 30,
    outputTokens: 45,
    totalTokens: 80,
    cachedInputTokens: 5,
    reasoningTokens: 7,
    latencyMsTotal: 900,
  };
  return {
    window: utcWindow(),
    totals,
    daily: [
      { day: "2026-09-01", scope: "global", provider: "all", model: "all", task: "all", ...totals, updatedAt: "2026-09-01T12:01:00.000Z" },
      { day: "2026-09-01", scope: "provider", provider: "glm:test", model: "glm-5.3-flash", task: "topics", ...totals, reservedCalls: 0, updatedAt: "2026-09-01T12:01:00.000Z" },
    ],
    privacy: "Aggregate model operations only.",
    requestId: "smoke-model",
  };
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
  const documentResponse = await waitForServer(`${origin}/admin/analytics`, child, () => logs);
  assert(documentResponse.headers["cache-control"] === "public, max-age=0, must-revalidate, no-transform",
    "Admin document must disable edge payload transforms");
  const csp = documentResponse.headers["content-security-policy"] || "";
  for (const directive of [
    "default-src 'none'", "script-src 'self'", "script-src-attr 'none'", "style-src 'self'",
    "style-src-attr 'none'", "connect-src 'self'", "form-action 'none'", "frame-ancestors 'none'", "worker-src 'none'",
  ]) assert(csp.includes(directive), `Admin CSP is missing ${directive}`);
  const adminScriptSources = contentSecurityPolicySources(csp, "script-src");
  assert(adminScriptSources.length === 1 && adminScriptSources[0] === "'self'",
    "Admin CSP must permit only same-origin scripts");
  assert(documentResponse.headers["referrer-policy"] === "no-referrer", "Admin document must suppress referrers");
  assert(documentResponse.headers["x-robots-tag"] === "noindex, nofollow, noarchive", "Admin document must be noindex");
  assert(documentResponse.body.includes("Operator analytics · NonStopTalk"), "Admin route did not return its dedicated shell");
  assert(documentResponse.body.includes("/admin-analytics-page.js"), "Admin shell is missing its isolated module");
  assert(!documentResponse.body.includes("/app.js"), "Admin shell must not load the public SPA");
  assert(!hasScriptFromOrigin(documentResponse.body, `${origin}/admin/analytics`, WEB_ANALYTICS_ORIGIN),
    "Admin shell contains an analytics beacon");

  const trailingResponse = await readURL(`${origin}/admin/analytics/`);
  assert(trailingResponse.status === 200 && trailingResponse.headers["content-security-policy"] === csp,
    "Trailing-slash admin route must use the same isolated document policy");
  const directAssetResponse = await readURL(`${origin}/admin/analytics/index.html`);
  assert(directAssetResponse.status === 200 && directAssetResponse.headers["content-security-policy"] === csp,
    "Direct admin asset path must not bypass the isolated document policy");
  assert(!hasScriptFromOrigin(directAssetResponse.body, `${origin}/admin/analytics/index.html`, WEB_ANALYTICS_ORIGIN),
    "Direct admin asset path contains an analytics beacon");
  const unknownAdminResponse = await readURL(`${origin}/admin/analytics/not-a-route`);
  assert(unknownAdminResponse.status === 404 && unknownAdminResponse.headers["content-security-policy"] === csp,
    "Unknown admin subpaths must fail under the same isolated policy");
  const publicResponse = await readURL(`${origin}/`);
  const publicScriptSources = contentSecurityPolicySources(
    publicResponse.headers["content-security-policy"] || "",
    "script-src",
  );
  assert(publicScriptSources.length === 2
    && publicScriptSources[0] === "'self'"
    && publicScriptSources[1] === WEB_ANALYTICS_ORIGIN,
    "Admin isolation must not remove analytics from the public site");

  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 320, height: 850 } });
  await context.addInitScript(() => {
    window.__adminStorageWrites = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      const original = storage.setItem.bind(storage);
      storage.setItem = (key, value) => {
        window.__adminStorageWrites.push([String(key), String(value)]);
        return original(key, value);
      };
    }
  });
  const page = await context.newPage();
  const calls = [];
  const externalRequests = [];
  const pageErrors = [];
  const consoleErrors = [];
  let mode = "success";
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.route("**/api/v1/admin/**", async (route) => {
    const request = route.request();
    calls.push({
      url: request.url(),
      method: request.method(),
      authorization: request.headers().authorization || "",
      referer: request.headers().referer || "",
      body: request.postData(),
    });
    if (mode === "unauthorized") {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({
        error: { code: "INVALID_IDENTITY", message: "do not reflect this" },
        requestId: "smoke-unauthorized",
      }) });
      return;
    }
    const body = request.url().includes("model-usage") ? modelPayload() : productPayload();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(`${origin}/admin/analytics`);
  await page.waitForSelector("[data-admin-token-form]");
  assert(calls.length === 0, "Admin API was called before token submission");
  assert(externalRequests.length === 0, `Admin page made external requests: ${JSON.stringify(externalRequests)}`);
  assert(await page.locator("[data-admin-token-form]").getAttribute("method") === "post",
    "Admin form must fail closed as POST when its controller is unavailable");
  assert(await page.locator("[data-admin-token-form]").getAttribute("action") === "/admin/analytics",
    "Admin form fallback action must remain same-origin and fixed");
  assert(await page.locator("#admin-token").getAttribute("name") === null,
    "Admin token must not be a native successful form control");

  const lifecycleToken = "3".repeat(64);
  await page.locator("#admin-token").fill(lifecycleToken);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  assert(await page.locator("#admin-token").inputValue() === "", "pagehide retained an unsubmitted token");
  assert(!(await page.locator("body").innerText()).includes(lifecycleToken), "pagehide retained token text");
  assert(await page.locator("[data-admin-dashboard]").count() === 0, "pagehide retained protected dashboard data");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await page.waitForFunction(() => document.activeElement?.id === "admin-token");
  assert(calls.length === 0, "Lifecycle locking unexpectedly called an admin API");

  const token = "4".repeat(64);
  await page.locator("#admin-token").fill(token);
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await page.waitForSelector("[data-admin-dashboard]");
  assert(calls.length === 2, `Expected exactly two admin requests, got ${calls.length}`);
  for (const call of calls) {
    assert(call.method === "GET", "Admin aggregate request was not GET");
    assert(call.authorization === `Bearer ${token}`, "Admin bearer header was incorrect");
    assert(call.referer === "", "Admin aggregate request sent a Referer header");
    assert(call.body === null, "Admin token request unexpectedly had a body");
    assert(!call.url.includes(token), "Admin token leaked into a URL");
  }
  assert((await page.locator("body").innerText()).includes("NonStopTalk analytics."), "Dashboard did not render");
  assert(!(await page.locator("body").innerText()).includes(token), "Admin token leaked into page text");
  assert(await page.locator("#admin-token").count() === 0, "Token field remained in the DOM after submission");
  assert((await page.locator(".admin-kpi").count()) === 6, "Headline KPI strip is incomplete");
  assert((await page.locator(".admin-chart progress").count()) === 60, "30-day charts should render 60 exact daily bars");
  assert((await page.locator(".admin-table-panel table").count()) === 4, "Source-backed tables are incomplete");
  assert((await page.locator("body").innerText()).includes("glm:test"), "Provider dimension was not rendered");
  assert(await page.locator("img").count() === 0, "Dashboard unexpectedly created an image element");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "Admin dashboard overflows the 320px viewport");
  const persistence = await page.evaluate(async () => ({
    url: location.href,
    writes: window.__adminStorageWrites,
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    databases: typeof indexedDB.databases === "function" ? (await indexedDB.databases()).map((item) => item.name) : [],
  }));
  assert(!JSON.stringify(persistence).includes(token), "Admin token leaked into browser persistence or URL state");
  assert(persistence.writes.length === 0, "Admin page wrote browser storage");
  assert(pageErrors.length === 0, `Admin page emitted errors during successful loading: ${JSON.stringify(pageErrors)}`);
  assert(consoleErrors.length === 0, `Admin page emitted console errors during successful loading: ${JSON.stringify(consoleErrors)}`);

  await page.getByRole("button", { name: "1 day" }).click();
  assert(await page.getByRole("button", { name: "1 day" }).getAttribute("aria-pressed") === "true",
    "Window control did not update");
  assert(await page.evaluate(() => document.activeElement?.textContent?.trim() === "1 day"),
    "Window control did not retain keyboard focus");

  await page.getByRole("button", { name: "Refresh with token" }).click();
  await page.waitForSelector("#admin-token");
  await page.waitForFunction(() => document.activeElement?.id === "admin-token");
  assert(await page.evaluate(() => document.activeElement?.id === "admin-token"),
    "Reauthorization did not focus the token field");
  const refreshedToken = "6".repeat(64);
  const callsBeforeRefresh = calls.length;
  await page.locator("#admin-token").fill(refreshedToken);
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await page.waitForSelector("[data-admin-dashboard]");
  assert(calls.length === callsBeforeRefresh + 2, "Reauthorization did not issue exactly two fresh requests");
  for (const call of calls.slice(callsBeforeRefresh)) {
    assert(call.authorization === `Bearer ${refreshedToken}`, "Refreshed bearer header was incorrect");
    assert(call.referer === "", "Refreshed aggregate request sent a Referer header");
  }

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  assert(await page.locator("[data-admin-dashboard]").count() === 0,
    "pagehide retained protected aggregate dashboard content");
  assert(await page.locator("#admin-token").inputValue() === "", "pagehide did not restore a blank locked view");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await page.waitForFunction(() => document.activeElement?.id === "admin-token");

  mode = "unauthorized";
  const rejectedToken = "5".repeat(64);
  await page.locator("#admin-token").fill(rejectedToken);
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await page.waitForSelector("[data-admin-token-form] .notice.error");
  await page.waitForFunction(() => document.activeElement?.id === "admin-token");
  assert(await page.locator("#admin-token").inputValue() === "", "401 did not clear the token field");
  assert(await page.evaluate(() => document.activeElement?.id === "admin-token"), "401 did not restore focus to authorization");
  const rejectedBody = await page.locator("body").innerText();
  assert(!rejectedBody.includes(rejectedToken), "Rejected token leaked into the page");
  assert(rejectedBody.includes("That analytics token was not accepted."), "401 did not show the fixed error message");
  assert(externalRequests.length === 0, `Admin browser made external requests: ${JSON.stringify(externalRequests)}`);
  assert(pageErrors.length === 0, `Admin page emitted errors: ${JSON.stringify(pageErrors)}`);
  assert(consoleErrors.length === 2 && consoleErrors.every((message) => message.includes("401")),
    `Unauthorized flow emitted unexpected console errors: ${JSON.stringify(consoleErrors)}`);

  await context.close();
  console.log("Private admin analytics browser smoke test passed.");
} catch (error) {
  if (logs.trim()) console.error(`Wrangler output captured before failure:\n${logs.trim()}`);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  stopProcessTree(child);
}
