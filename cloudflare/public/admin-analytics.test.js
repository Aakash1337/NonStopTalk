import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AdminAnalyticsError,
  loadAdminAnalytics,
  normalizeAdminAnalytics,
  renderAdminDashboard,
  renderAdminUnlock,
  selectAdminAnalyticsWindow,
} from "./admin-analytics.js";

const MODEL_ZERO = {
  reservedCalls: 0,
  completedCalls: 0,
  successCount: 0,
  failureCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  latencyMsTotal: 0,
};

function dayOffset(day, offset) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function sourceWindow(throughDay = "2026-09-01") {
  return {
    from: `${dayOffset(throughDay, -89)}T00:00:00.000Z`,
    through: `${throughDay}T00:00:00.000Z`,
    days: 90,
  };
}

function productRow(overrides = {}) {
  return {
    day: "2026-09-01",
    metric: "room_created",
    eventCount: 2,
    valueSum: 0,
    valueMin: 0,
    valueMax: 0,
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

function modelRow(overrides = {}) {
  return {
    day: "2026-09-01",
    scope: "global",
    provider: "all",
    model: "all",
    task: "all",
    reservedCalls: 2,
    completedCalls: 2,
    successCount: 1,
    failureCount: 1,
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cachedInputTokens: 2,
    reasoningTokens: 3,
    latencyMsTotal: 400,
    updatedAt: "2026-09-01T12:01:00.000Z",
    ...overrides,
  };
}

function providerRow(overrides = {}) {
  return modelRow({
    scope: "provider",
    provider: "glm",
    model: "glm-5.3-flash",
    task: "topics",
    reservedCalls: 0,
    ...overrides,
  });
}

function productPayload(rows = [productRow()], throughDay = "2026-09-01") {
  const totals = {};
  for (const row of rows) {
    const total = totals[row.metric] ?? { events: 0, value: 0 };
    total.events += row.eventCount;
    total.value += row.valueSum;
    totals[row.metric] = total;
  }
  return {
    window: sourceWindow(throughDay),
    totals,
    daily: rows,
    privacy: "Aggregate product events only.",
    requestId: "product-request",
  };
}

function sumModels(rows) {
  const totals = { ...MODEL_ZERO };
  for (const row of rows.filter((item) => item.scope === "global")) {
    for (const key of Object.keys(totals)) totals[key] += row[key];
  }
  return totals;
}

function modelPayload(rows = [modelRow(), providerRow()], throughDay = "2026-09-01") {
  return {
    window: sourceWindow(throughDay),
    totals: sumModels(rows),
    daily: rows,
    privacy: "Aggregate model operations only.",
    requestId: "model-request",
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "response-request" },
  });
}

test("admin client starts exactly two fixed same-origin requests and confines the token to authorization", async () => {
  const token = "7".repeat(64);
  const calls = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    await held;
    return path.includes("model-usage")
      ? jsonResponse(modelPayload())
      : jsonResponse(productPayload());
  };

  const pending = loadAdminAnalytics(token, { fetchImpl });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2, "requests were not launched concurrently");
  assert.deepEqual(calls.map((call) => call.path).sort(), [
    "/api/v1/admin/analytics?days=90",
    "/api/v1/admin/model-usage?days=90",
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.cache, "no-store");
    assert.equal(call.options.referrerPolicy, "no-referrer");
    assert.equal(call.options.headers.Authorization, `Bearer ${token}`);
    assert.equal(call.path.includes(token), false);
    assert.equal("body" in call.options, false);
  }
  release();
  const snapshot = await pending;
  assert.equal(snapshot.throughDay, "2026-09-01");
  assert.equal(JSON.stringify(snapshot).includes(token), false);
});

test("admin client rejects nonnumeric and short secrets before any request", async () => {
  let calls = 0;
  for (const token of ["1".repeat(23), "a".repeat(64), `1${"2".repeat(62)}x`]) {
    await assert.rejects(
      loadAdminAnalytics(token, { fetchImpl: async () => { calls += 1; } }),
      (error) => error instanceof AdminAnalyticsError && error.code === "INVALID_TOKEN_FORMAT",
    );
  }
  assert.equal(calls, 0);
});

test("401 errors are fixed text and never reflect the submitted token", async () => {
  const token = "8".repeat(64);
  await assert.rejects(
    loadAdminAnalytics(token, {
      fetchImpl: async () => jsonResponse({
        error: { code: "INVALID_IDENTITY", message: `bad ${token}` },
        requestId: "auth-request",
      }, 401),
    }),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.message, "That analytics token was not accepted.");
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
});

test("a failed aggregate request aborts its still-pending sibling", async () => {
  let siblingStarted = false;
  let siblingAborted = false;
  const fetchImpl = async (path, options) => {
    if (!path.includes("model-usage")) {
      return jsonResponse({ error: { message: "untrusted" } }, 401);
    }
    siblingStarted = true;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        siblingAborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  };
  await assert.rejects(
    loadAdminAnalytics("8".repeat(64), { fetchImpl }),
    (error) => error instanceof AdminAnalyticsError && error.status === 401,
  );
  assert.equal(siblingStarted, true);
  assert.equal(siblingAborted, true);
});

test("validated daily rows produce inclusive UTC windows across leap-day and DST dates", () => {
  const throughDay = "2024-03-10";
  const productRows = [
    productRow({ day: "2024-03-10", eventCount: 1, updatedAt: "2024-03-10T12:00:00.000Z" }),
    productRow({ day: "2024-03-04", eventCount: 2, updatedAt: "2024-03-04T12:00:00.000Z" }),
    productRow({ day: "2024-02-10", eventCount: 4, updatedAt: "2024-02-10T12:00:00.000Z" }),
    productRow({ day: "2023-12-12", eventCount: 8, updatedAt: "2023-12-12T12:00:00.000Z" }),
  ];
  const snapshot = normalizeAdminAnalytics(productPayload(productRows, throughDay), modelPayload([], throughDay));
  assert.equal(selectAdminAnalyticsWindow(snapshot, 1).product.room_created.events, 1);
  assert.equal(selectAdminAnalyticsWindow(snapshot, 7).product.room_created.events, 3);
  assert.equal(selectAdminAnalyticsWindow(snapshot, 30).product.room_created.events, 7);
  assert.equal(selectAdminAnalyticsWindow(snapshot, 90).product.room_created.events, 15);
  assert.equal(selectAdminAnalyticsWindow(snapshot, 30).fromDay, "2024-02-10");
  assert.equal(selectAdminAnalyticsWindow(snapshot, 90).fromDay, "2023-12-12");
});

test("empty valid aggregates render zero volumes and unavailable denominators", () => {
  const snapshot = normalizeAdminAnalytics(productPayload([]), modelPayload([]));
  const view = selectAdminAnalyticsWindow(snapshot, 30);
  assert.equal(view.daily.length, 30);
  assert.equal(view.daily.every((row) => row.rooms === 0 && row.modelCompleted === 0), true);
  const html = renderAdminDashboard(snapshot, 30, new Date("2026-09-01T12:05:00.000Z"));
  assert.match(html, /Model success<\/span><strong>—<\/strong>/u);
  assert.match(html, /Success rate<\/th><td>—<\/td>/u);
  assert.match(html, /Average latency<\/th><td>—<\/td>/u);
  assert.doesNotMatch(html, /0\.0%/u);
  assert.match(html, /No aggregate events have been recorded/u);
});

test("rendered labels preserve operational units and best-effort caveats", () => {
  const productRows = [
    productRow({ metric: "room_created", eventCount: 1 }),
    productRow({ metric: "room_joined", eventCount: 3 }),
    productRow({ metric: "turn_completed", eventCount: 2, valueSum: 90, valueMin: 40, valueMax: 50 }),
    productRow({ metric: "game_finished", eventCount: 1, valueSum: 4, valueMin: 4, valueMax: 4 }),
    productRow({ metric: "coaching_summary_deleted", eventCount: 1, valueSum: 2, valueMin: 2, valueMax: 2 }),
  ];
  const snapshot = normalizeAdminAnalytics(productPayload(productRows), modelPayload());
  const html = renderAdminDashboard(snapshot, 1, new Date("2026-09-01T12:05:00.000Z"));
  assert.match(html, /Room speaking minutes/u);
  assert.match(html, /Reported model tokens/u);
  assert.match(html, /best-effort operational counters, not an audit, delivery, or billing ledger/u);
  assert.match(html, /Backup delete actions<\/th><td>1<\/td><td>2 backup items reported deleted/u);
  assert.match(html, /Games finished/u);
  assert.match(html, /3\.00 join \/ room events/u);
  assert.match(html, /— \(no denominator\)/u);
  assert.equal((html.match(/class="table-scroll" role="region"/gu) ?? []).length, 4);
});

test("normalization rejects untrustworthy windows, rows, duplicates, and totals", () => {
  const cases = [
    () => normalizeAdminAnalytics({ ...productPayload(), window: { ...sourceWindow(), days: 89 } }, modelPayload()),
    () => normalizeAdminAnalytics(productPayload(), modelPayload([], "2026-08-31")),
    () => normalizeAdminAnalytics(productPayload([productRow(), productRow()]), modelPayload()),
    () => normalizeAdminAnalytics(productPayload([productRow({ eventCount: -1 })]), modelPayload()),
    () => normalizeAdminAnalytics(productPayload([productRow({ metric: "visitor_email" })]), modelPayload()),
    () => normalizeAdminAnalytics({ ...productPayload(), totals: { room_created: { events: 999, value: 0 } } }, modelPayload()),
    () => normalizeAdminAnalytics(productPayload(), modelPayload([modelRow({ completedCalls: 2, successCount: 2, failureCount: 1 })])),
    () => normalizeAdminAnalytics(productPayload(), modelPayload([modelRow({ reservedCalls: 1, completedCalls: 2 })])),
    () => normalizeAdminAnalytics(productPayload(), modelPayload([modelRow(), providerRow({ task: "all" })])),
    () => normalizeAdminAnalytics(productPayload(), modelPayload([modelRow(), providerRow({ totalTokens: 29 })])),
  ];
  for (const invalid of cases) {
    assert.throws(invalid, (error) => error instanceof AdminAnalyticsError && error.code === "INVALID_SOURCE_DATA");
  }
});

test("product value aggregates enforce source ranges, extrema, and metric domains", () => {
  const invalidRows = [
    productRow({ metric: "turn_completed", eventCount: 2, valueSum: 9_999, valueMin: 1, valueMax: 2 }),
    productRow({ metric: "turn_completed", eventCount: 1, valueSum: 1.5, valueMin: 1, valueMax: 2 }),
    productRow({ valueSum: 1, valueMin: 0, valueMax: 0 }),
    productRow({ metric: "turn_completed", valueSum: 301, valueMin: 0, valueMax: 301 }),
    productRow({ metric: "game_finished", valueSum: 1.5, valueMin: 0, valueMax: 1.5 }),
    productRow({ metric: "coaching_summary_deleted", valueSum: 1, valueMin: 0, valueMax: 1 }),
  ];
  for (const row of invalidRows) {
    assert.throws(
      () => normalizeAdminAnalytics(productPayload([row]), modelPayload([])),
      (error) => error instanceof AdminAnalyticsError && error.code === "INVALID_SOURCE_DATA",
    );
  }

  const fractionalRows = [
    productRow({
      metric: "turn_completed",
      eventCount: 2,
      valueSum: 3.75,
      valueMin: 1.25,
      valueMax: 2.5,
    }),
    productRow({
      metric: "coaching_summary_saved",
      eventCount: 2,
      valueSum: 600,
      valueMin: 0.125,
      valueMax: 599.875,
    }),
  ];
  const snapshot = normalizeAdminAnalytics(productPayload(fractionalRows), modelPayload([]));
  assert.equal(selectAdminAnalyticsWindow(snapshot, 1).product.turn_completed.value, 3.75);
  assert.equal(selectAdminAnalyticsWindow(snapshot, 1).product.coaching_summary_saved.value, 600);

  const singleEvent = productRow({
    metric: "turn_completed",
    eventCount: 1,
    valueSum: 1.5,
    valueMin: 1.5,
    valueMax: 1.5,
  });
  assert.doesNotThrow(() => normalizeAdminAnalytics(productPayload([singleEvent]), modelPayload([])));

  let repeatedFraction = 0;
  for (let index = 0; index < 1_000; index += 1) repeatedFraction += 0.1;
  const repeated = productRow({
    metric: "turn_completed",
    eventCount: 1_000,
    valueSum: repeatedFraction,
    valueMin: 0.1,
    valueMax: 0.1,
  });
  assert.doesNotThrow(() => normalizeAdminAnalytics(productPayload([repeated]), modelPayload([])));
});

test("model provider rows reconcile per UTC day while reservation-only days remain valid", () => {
  const globalCompleted = modelRow({
    day: "2026-08-31",
    reservedCalls: 3,
    updatedAt: "2026-08-31T12:00:00.000Z",
  });
  const glm = providerRow({
    day: "2026-08-31",
    completedCalls: 1,
    successCount: 1,
    failureCount: 0,
    inputTokens: 4,
    outputTokens: 6,
    totalTokens: 10,
    cachedInputTokens: 1,
    reasoningTokens: 1,
    latencyMsTotal: 150,
    updatedAt: "2026-08-31T12:00:00.000Z",
  });
  const gemma = providerRow({
    day: "2026-08-31",
    provider: "gemma31",
    model: "gemma-4-31b",
    completedCalls: 1,
    successCount: 0,
    failureCount: 1,
    inputTokens: 6,
    outputTokens: 14,
    totalTokens: 20,
    cachedInputTokens: 1,
    reasoningTokens: 2,
    latencyMsTotal: 250,
    updatedAt: "2026-08-31T12:00:00.000Z",
  });
  const reservationOnly = modelRow({
    ...MODEL_ZERO,
    reservedCalls: 1,
    updatedAt: "2026-09-01T00:01:00.000Z",
  });
  const snapshot = normalizeAdminAnalytics(
    productPayload([]),
    modelPayload([globalCompleted, glm, gemma, reservationOnly]),
  );
  const view = selectAdminAnalyticsWindow(snapshot, 7);
  assert.equal(view.modelTotals.reservedCalls, 4);
  assert.equal(view.modelTotals.completedCalls, 2);
  assert.equal(view.providers.length, 2);

  const shiftedProvider = providerRow({ day: "2026-08-31", updatedAt: "2026-08-31T12:00:00.000Z" });
  assert.throws(
    () => normalizeAdminAnalytics(productPayload([]), modelPayload([modelRow(), shiftedProvider])),
    (error) => error instanceof AdminAnalyticsError && error.code === "INVALID_SOURCE_DATA",
  );
});

test("source timestamps and model dimensions must match the API contract", () => {
  const nonMidnight = productPayload();
  nonMidnight.window = { ...nonMidnight.window, through: "2026-09-01T12:00:00.000Z" };
  const cases = [
    () => normalizeAdminAnalytics(nonMidnight, modelPayload()),
    () => normalizeAdminAnalytics(
      productPayload([productRow({ updatedAt: "2026-08-31T23:59:59.000Z" })]),
      modelPayload(),
    ),
    () => normalizeAdminAnalytics(
      productPayload(),
      modelPayload([modelRow({ updatedAt: "2026-09-02T00:00:00.000Z" }), providerRow()]),
    ),
    () => normalizeAdminAnalytics(
      productPayload(),
      modelPayload([modelRow(), providerRow({ provider: "bad provider" })]),
    ),
    () => normalizeAdminAnalytics(
      productPayload(),
      modelPayload([modelRow(), providerRow({ model: "bad<script>" })]),
    ),
  ];
  for (const invalid of cases) {
    assert.throws(invalid, (error) => error instanceof AdminAnalyticsError && error.code === "INVALID_SOURCE_DATA");
  }
});

test("model latency aggregates respect the per-completion cap", () => {
  const global = modelRow({
    reservedCalls: 1,
    completedCalls: 1,
    successCount: 1,
    failureCount: 0,
    latencyMsTotal: 300_000,
  });
  const provider = providerRow({
    completedCalls: 1,
    successCount: 1,
    failureCount: 0,
    latencyMsTotal: 300_000,
  });
  assert.doesNotThrow(() => normalizeAdminAnalytics(productPayload(), modelPayload([global, provider])));

  const impossibleGlobal = { ...global, latencyMsTotal: 999_999_999 };
  const impossibleProvider = { ...provider, latencyMsTotal: 999_999_999 };
  assert.throws(
    () => normalizeAdminAnalytics(productPayload(), modelPayload([impossibleGlobal, impossibleProvider])),
    (error) => error instanceof AdminAnalyticsError && error.code === "INVALID_SOURCE_DATA",
  );
});

test("provider, model, and privacy text is escaped and no inline executable/style content is emitted", () => {
  const unsafeProvider = "<img src=x onerror=alert(1)>";
  const unsafeModel = "<script>alert(1)</script>";
  const global = modelRow();
  const product = productPayload();
  product.privacy = "<b>aggregate only</b>";
  const models = modelPayload([global, providerRow()]);
  models.privacy = "<svg onload=alert(1)>";
  const normalized = normalizeAdminAnalytics(product, models);
  const snapshot = {
    ...normalized,
    modelRows: normalized.modelRows.map((row) => row.scope === "provider"
      ? { ...row, provider: unsafeProvider, model: unsafeModel }
      : row),
  };
  const html = renderAdminDashboard(snapshot, 30, new Date("2026-09-01T12:05:00.000Z"));
  assert.equal(html.includes(unsafeProvider), false);
  assert.equal(html.includes(unsafeModel), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /&lt;b&gt;aggregate only&lt;\/b&gt;/u);
  assert.doesNotMatch(html, /\sstyle=/u);
  assert.doesNotMatch(html, /<script/u);
});

test("unlock markup and implementation contain no persistence or token-output path", async () => {
  const token = "9".repeat(64);
  const unlock = renderAdminUnlock();
  assert.match(unlock, /type="password"/u);
  assert.match(unlock, /inputmode="numeric"/u);
  assert.match(unlock, /<form[^>]*method="post"[^>]*action="\/admin\/analytics"/u);
  assert.doesNotMatch(unlock, /<input[^>]*\sname=/u);
  assert.equal(unlock.includes(token), false);
  assert.match(renderAdminUnlock("<script>failure</script>"), /&lt;script&gt;failure&lt;\/script&gt;/u);

  const [moduleSource, pageSource] = await Promise.all([
    readFile(new URL("./admin-analytics.js", import.meta.url), "utf8"),
    readFile(new URL("./admin-analytics-page.js", import.meta.url), "utf8"),
  ]);
  for (const source of [moduleSource, pageSource]) {
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/iu);
    assert.doesNotMatch(source, /console\./u);
  }
  assert.doesNotMatch(pageSource, /pushState|replaceState/iu);
});
