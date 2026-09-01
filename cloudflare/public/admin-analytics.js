const PRODUCT_METRICS = Object.freeze([
  "room_created",
  "room_joined",
  "game_started",
  "turn_completed",
  "game_finished",
  "coaching_summary_saved",
  "coaching_summary_deleted",
  "cloud_consent_granted",
  "cloud_consent_revoked",
]);

const PRODUCT_VALUE_DOMAINS = Object.freeze({
  room_created: Object.freeze({ minimum: 0, maximum: 0, integer: true }),
  room_joined: Object.freeze({ minimum: 0, maximum: 0, integer: true }),
  game_started: Object.freeze({ minimum: 0, maximum: 0, integer: true }),
  turn_completed: Object.freeze({ minimum: 0, maximum: 300, integer: false }),
  game_finished: Object.freeze({ minimum: 0, maximum: 1_200, integer: true }),
  coaching_summary_saved: Object.freeze({ minimum: 0, maximum: 600, integer: false }),
  coaching_summary_deleted: Object.freeze({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, integer: true }),
  cloud_consent_granted: Object.freeze({ minimum: 0, maximum: 0, integer: true }),
  cloud_consent_revoked: Object.freeze({ minimum: 0, maximum: 0, integer: true }),
});

export const ADMIN_ANALYTICS_WINDOWS = Object.freeze([1, 7, 30, 90]);

const ZERO_MODEL_TOTALS = Object.freeze({
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
});
const MODEL_TOTAL_KEYS = Object.freeze(Object.keys(ZERO_MODEL_TOTALS));
const MAX_MODEL_LATENCY_MS = 300_000;
const FLOAT_ABSOLUTE_TOLERANCE = 1e-9;
const FLOAT_RELATIVE_TOLERANCE = 1e-12;

export class AdminAnalyticsError extends Error {
  constructor(message, { status = 0, code = "", requestId = "" } = {}) {
    super(message);
    this.name = "AdminAnalyticsError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Fetch one bounded 90-day extract from each existing aggregate-only endpoint. */
export async function loadAdminAnalytics(token, { fetchImpl = globalThis.fetch, signal } = {}) {
  const authorization = String(token ?? "").trim();
  if (!/^\d{24,1024}$/u.test(authorization)) {
    throw new AdminAnalyticsError("Enter the numeric analytics token (at least 24 digits).", {
      code: "INVALID_TOKEN_FORMAT",
    });
  }
  if (typeof fetchImpl !== "function") {
    throw new AdminAnalyticsError("Analytics cannot be loaded in this browser.");
  }

  const headers = Object.freeze({
    Accept: "application/json",
    Authorization: `Bearer ${authorization}`,
  });
  const requestController = new AbortController();
  const relayAbort = () => requestController.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener("abort", relayAbort, { once: true });
  const options = {
    method: "GET",
    headers,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: requestController.signal,
  };
  try {
    const [product, models] = await Promise.all([
      requestAggregate("/api/v1/admin/analytics?days=90", options, fetchImpl),
      requestAggregate("/api/v1/admin/model-usage?days=90", options, fetchImpl),
    ]);
    return normalizeAdminAnalytics(product, models);
  } catch (error) {
    requestController.abort();
    throw error;
  } finally {
    signal?.removeEventListener("abort", relayAbort);
  }
}

async function requestAggregate(path, options, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(path, options);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new AdminAnalyticsError("The analytics service could not be reached.");
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Status handling below deliberately avoids reflecting an untrusted body.
  }
  if (!response.ok) {
    const requestId = shortText(payload?.requestId || response.headers?.get?.("X-Request-ID"), 96);
    const code = shortText(payload?.error?.code, 64);
    const message = response.status === 401
      ? "That analytics token was not accepted."
      : response.status === 429
        ? "Too many analytics requests. Wait a minute and try again."
        : response.status === 503
          ? "Analytics is temporarily unavailable."
          : `Analytics could not be loaded (${response.status}).`;
    throw new AdminAnalyticsError(message, { status: response.status, code, requestId });
  }
  return payload;
}

export function normalizeAdminAnalytics(productPayload = {}, modelPayload = {}) {
  const productWindow = validateSourceWindow(productPayload?.window, "product");
  const modelWindow = validateSourceWindow(modelPayload?.window, "model");
  if (productWindow.fromDay !== modelWindow.fromDay || productWindow.throughDay !== modelWindow.throughDay) {
    throw invalidSource("The aggregate source windows do not match.");
  }
  if (!Array.isArray(productPayload?.daily) || !Array.isArray(modelPayload?.daily)) {
    throw invalidSource("The aggregate source rows are missing.");
  }
  const productRows = productPayload.daily.map(normalizeProductRow);
  const modelRows = modelPayload.daily.map(normalizeModelRow);
  assertUniqueRows(productRows, (row) => `${row.day}\u0000${row.metric}`, "product");
  assertUniqueRows(modelRows, (row) => `${row.day}\u0000${row.scope}\u0000${row.provider}\u0000${row.model}\u0000${row.task}`, "model");
  assertRowsInsideWindow(productRows, productWindow, "product");
  assertRowsInsideWindow(modelRows, modelWindow, "model");
  reconcileProductTotals(productPayload?.totals, productRows);
  reconcileModelTotals(modelPayload?.totals, modelRows);
  const latestUpdatedAt = [...productRows, ...modelRows]
    .map((row) => row.updatedAt)
    .sort()
    .at(-1) ?? null;
  return Object.freeze({
    fromDay: productWindow.fromDay,
    throughDay: productWindow.throughDay,
    latestUpdatedAt,
    productRows: Object.freeze(productRows),
    modelRows: Object.freeze(modelRows),
    productPrivacy: shortText(productPayload?.privacy, 300),
    modelPrivacy: shortText(modelPayload?.privacy, 300),
  });
}

export function selectAdminAnalyticsWindow(snapshot, requestedDays = 30) {
  const days = ADMIN_ANALYTICS_WINDOWS.includes(Number(requestedDays)) ? Number(requestedDays) : 30;
  const throughDay = isoDay(snapshot?.throughDay);
  if (!throughDay) throw invalidSource("The normalized analytics window is invalid.");
  const fromDay = shiftUTCDay(throughDay, 1 - days);
  const productRows = (snapshot?.productRows ?? []).filter((row) => row.day >= fromDay && row.day <= throughDay);
  const modelRows = (snapshot?.modelRows ?? []).filter((row) => row.day >= fromDay && row.day <= throughDay);

  const product = Object.fromEntries(PRODUCT_METRICS.map((metric) => [metric, { events: 0, value: 0 }]));
  const productByDay = new Map();
  for (const row of productRows) {
    product[row.metric].events += row.eventCount;
    product[row.metric].value += row.valueSum;
    const day = productByDay.get(row.day) ?? Object.fromEntries(PRODUCT_METRICS.map((metric) => [metric, 0]));
    day[row.metric] += row.eventCount;
    productByDay.set(row.day, day);
  }

  const globalModels = modelRows.filter((row) => row.scope === "global");
  const modelTotals = sumModelRows(globalModels);
  const providerMap = new Map();
  for (const row of modelRows.filter((item) => item.scope === "provider")) {
    const key = `${row.provider}\u0000${row.model}\u0000${row.task}`;
    const current = providerMap.get(key) ?? {
      provider: row.provider,
      model: row.model,
      task: row.task,
      ...ZERO_MODEL_TOTALS,
    };
    addModelRow(current, row);
    providerMap.set(key, current);
  }

  const daily = [];
  for (let offset = 1 - days; offset <= 0; offset += 1) {
    const day = shiftUTCDay(throughDay, offset);
    const usage = productByDay.get(day) ?? {};
    const model = sumModelRows(globalModels.filter((row) => row.day === day));
    daily.push({
      day,
      rooms: usage.room_created ?? 0,
      joins: usage.room_joined ?? 0,
      gameStarts: usage.game_started ?? 0,
      gamesFinished: usage.game_finished ?? 0,
      turns: usage.turn_completed ?? 0,
      summariesSaved: usage.coaching_summary_saved ?? 0,
      modelCompleted: model.completedCalls,
      modelSuccesses: model.successCount,
      modelFailures: model.failureCount,
      modelTokens: model.totalTokens,
    });
  }

  return {
    days,
    fromDay,
    throughDay,
    product,
    modelTotals,
    providers: [...providerMap.values()].sort((left, right) =>
      right.completedCalls - left.completedCalls
      || left.provider.localeCompare(right.provider)
      || left.model.localeCompare(right.model)),
    daily,
  };
}

export function renderAdminUnlock(error = "") {
  return `<section class="admin-shell admin-unlock" aria-labelledby="admin-title">
    <div class="admin-intro">
      <p class="eyebrow">Private operator view</p>
      <h1 id="admin-title">Analytics without another vendor.</h1>
      <p class="lede">Read aggregate product and model operations from the existing Cloudflare database. No names, room codes, browser identities, audio, transcripts, prompts, or generated topics are included.</p>
    </div>
    <form class="panel admin-token-form stack" data-admin-token-form method="post" action="/admin/analytics" autocomplete="off">
      <div><p class="eyebrow">Authorization</p><h2>Enter the analytics token.</h2></div>
      ${error ? `<div class="notice error" role="alert">${escapeHTML(error)}</div>` : ""}
      <label for="admin-token">Numeric admin token
        <input id="admin-token" type="password" inputmode="numeric" pattern="[0-9]{24,1024}" minlength="24" maxlength="1024" autocomplete="off" autocapitalize="off" spellcheck="false" required aria-describedby="admin-token-help">
      </label>
      <p class="hint" id="admin-token-help">The token is sent only in same-origin authorization headers. It is never added to the URL, browser storage, page output, or analytics.</p>
      <button class="button primary" type="submit">Open dashboard</button>
    </form>
  </section>`;
}

export function renderAdminLoading() {
  return `<section class="admin-shell" aria-labelledby="admin-loading-title">
    <div class="loading-card" role="status"><p class="eyebrow">Private operator view</p><h1 id="admin-loading-title">Loading aggregate analytics…</h1><p>The token has been cleared from the form.</p></div>
  </section>`;
}

export function renderAdminDashboard(snapshot, requestedDays = 30, fetchedAt = new Date()) {
  const view = selectAdminAnalyticsWindow(snapshot, requestedDays);
  const product = view.product;
  const models = view.modelTotals;
  const modelSuccessRate = models.completedCalls > 0 ? ratio(models.successCount, models.completedCalls) : null;
  const averageLatency = models.completedCalls > 0 ? models.latencyMsTotal / models.completedCalls : null;
  const roomActivityMax = Math.max(1, ...view.daily.map((row) => row.rooms));
  const modelActivityMax = Math.max(1, ...view.daily.map((row) => row.modelCompleted));
  const safeFetchedAt = validDate(fetchedAt);
  const sourceFreshness = snapshot?.latestUpdatedAt
    ? `Latest recorded aggregate update ${validDate(snapshot.latestUpdatedAt).toLocaleString()}`
    : "No aggregate events have been recorded in the 90-day source window.";

  return `<section class="admin-shell" aria-labelledby="admin-title" data-admin-dashboard>
    <header class="admin-dashboard-head">
      <div><p class="eyebrow">Private operator view</p><h1 id="admin-title">NonStopTalk analytics.</h1><p class="lede">A live, aggregate-only readout from D1 through ${formatDay(view.throughDay)}.</p></div>
      <div class="admin-actions"><button class="button ghost" type="button" data-command="admin-reauthorize">Refresh with token</button><a class="button ghost" href="/" data-route>Exit dashboard</a></div>
    </header>
    <div class="admin-window-controls" role="group" aria-label="Analytics window">
      ${ADMIN_ANALYTICS_WINDOWS.map((days) => `<button class="button small ${days === view.days ? "active" : "ghost"}" type="button" data-command="admin-window" data-days="${days}" ${days === view.days ? 'aria-pressed="true"' : 'aria-pressed="false"'}>${days} day${days === 1 ? "" : "s"}</button>`).join("")}
      <span>Loaded ${escapeHTML(safeFetchedAt.toLocaleString())} · ${escapeHTML(sourceFreshness)}</span>
    </div>

    <section class="admin-kpis" aria-label="Headline metrics">
      ${metricCard(formatInteger(product.room_created.events), "Rooms created", "Room events")}
      ${metricCard(formatInteger(product.game_finished.events), "Games finished", `${formatInteger(product.game_started.events)} start events`)}
      ${metricCard(formatInteger(product.coaching_summary_saved.events), "Practice backups", formatDurationSeconds(product.coaching_summary_saved.value))}
      ${metricCard(modelSuccessRate === null ? "—" : formatPercent(modelSuccessRate), "Model success", models.completedCalls ? `${formatInteger(models.completedCalls)} completed calls` : "No completed calls")}
      ${metricCard(formatDecimal(product.turn_completed.value / 60, 1), "Room speaking minutes", `${formatInteger(product.turn_completed.events)} turns`)}
      ${metricCard(formatInteger(models.totalTokens), "Reported model tokens", averageLatency === null ? "No latency denominator" : `${formatDurationMs(averageLatency)} avg latency`)}
    </section>

    <div class="admin-chart-grid">
      ${barChart("Daily rooms created", "Room-creation events", view.daily, (row) => row.rooms, roomActivityMax)}
      ${barChart("Daily model calls", "Completed hosted-model calls", view.daily, (row) => row.modelCompleted, modelActivityMax)}
    </div>

    <div class="admin-detail-grid">
      <section class="panel admin-table-panel" aria-labelledby="product-funnel-title">
        <div class="section-head"><div><p class="eyebrow">Product journey</p><h2 id="product-funnel-title">Event volume and ratios</h2></div><span>${view.days}d</span></div>
        <div class="table-scroll" role="region" tabindex="0" aria-label="Product event volume table"><table><caption class="sr-only">Product event volumes and operational ratios</caption><thead><tr><th scope="col">Step</th><th scope="col">Events</th><th scope="col">Interpretation</th></tr></thead><tbody>
          ${funnelRow("Rooms created", product.room_created.events, "Entry point")}
          ${funnelRow("Players joined", product.room_joined.events, formatRatio(product.room_joined.events, product.room_created.events, "join / room events"))}
          ${funnelRow("Games started", product.game_started.events, formatRatio(product.game_started.events, product.room_created.events, "start / room events"))}
          ${funnelRow("Games finished", product.game_finished.events, formatRatio(product.game_finished.events, product.game_started.events, "finish / start events"))}
          ${funnelRow("Practice backups", product.coaching_summary_saved.events, `${formatDurationSeconds(product.coaching_summary_saved.value)} total`)}
          ${funnelRow("Backup delete actions", product.coaching_summary_deleted.events, `${formatInteger(product.coaching_summary_deleted.value)} backup items reported deleted`)}
          ${funnelRow("Cloud consent granted", product.cloud_consent_granted.events, `${formatInteger(product.cloud_consent_revoked.events)} revoked`)}
        </tbody></table></div>
      </section>

      <section class="panel admin-table-panel" aria-labelledby="model-summary-title">
        <div class="section-head"><div><p class="eyebrow">Model operations</p><h2 id="model-summary-title">Reliability and usage</h2></div><span>${view.days}d</span></div>
        <div class="table-scroll" role="region" tabindex="0" aria-label="Model reliability table"><table><caption class="sr-only">Hosted model reliability and usage</caption><tbody>
          ${summaryRow("Reserved calls", formatInteger(models.reservedCalls))}
          ${summaryRow("Completed calls", formatInteger(models.completedCalls))}
          ${summaryRow("Unreconciled reservations", formatInteger(models.reservedCalls - models.completedCalls))}
          ${summaryRow("Successes", formatInteger(models.successCount))}
          ${summaryRow("Failures", formatInteger(models.failureCount))}
          ${summaryRow("Success rate", modelSuccessRate === null ? "—" : formatPercent(modelSuccessRate))}
          ${summaryRow("Input / output tokens", `${formatInteger(models.inputTokens)} / ${formatInteger(models.outputTokens)}`)}
          ${summaryRow("Cached / reasoning tokens", `${formatInteger(models.cachedInputTokens)} / ${formatInteger(models.reasoningTokens)}`)}
          ${summaryRow("Average latency", averageLatency === null ? "—" : formatDurationMs(averageLatency))}
        </tbody></table></div>
      </section>
    </div>

    <section class="panel admin-table-panel" aria-labelledby="provider-title">
      <div class="section-head"><div><p class="eyebrow">Provider mix</p><h2 id="provider-title">Hosted model outcomes</h2></div><span>${view.providers.length} provider/model row${view.providers.length === 1 ? "" : "s"}</span></div>
      <div class="table-scroll" role="region" tabindex="0" aria-label="Provider model outcomes table"><table><caption class="sr-only">Hosted model outcomes by provider and model</caption><thead><tr><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Completed</th><th scope="col">Success</th><th scope="col">Failure</th><th scope="col">Reported tokens</th><th scope="col">Avg latency</th></tr></thead><tbody>
        ${view.providers.length ? view.providers.map((provider) => `<tr><th scope="row">${escapeHTML(provider.provider)}</th><td>${escapeHTML(provider.model)}</td><td>${formatInteger(provider.completedCalls)}</td><td>${formatInteger(provider.successCount)}</td><td>${formatInteger(provider.failureCount)}</td><td>${formatInteger(provider.totalTokens)}</td><td>${provider.completedCalls ? formatDurationMs(provider.latencyMsTotal / provider.completedCalls) : "—"}</td></tr>`).join("") : '<tr><td colspan="7" class="empty-cell">No hosted model usage in this window.</td></tr>'}
      </tbody></table></div>
    </section>

    <section class="panel admin-table-panel" aria-labelledby="daily-title">
      <div class="section-head"><div><p class="eyebrow">Source detail</p><h2 id="daily-title">Daily UTC aggregates</h2></div><span>${formatDay(view.fromDay)}–${formatDay(view.throughDay)}</span></div>
      <div class="table-scroll" role="region" tabindex="0" aria-label="Daily UTC aggregate table"><table><caption class="sr-only">Exact daily product and model aggregates in UTC</caption><thead><tr><th scope="col">Day</th><th scope="col">Rooms</th><th scope="col">Starts</th><th scope="col">Games finished</th><th scope="col">Turns</th><th scope="col">Backups</th><th scope="col">Model calls</th><th scope="col">Failures</th><th scope="col">Reported tokens</th></tr></thead><tbody>
        ${[...view.daily].reverse().map((row) => `<tr><th scope="row">${formatDay(row.day)}</th><td>${formatInteger(row.rooms)}</td><td>${formatInteger(row.gameStarts)}</td><td>${formatInteger(row.gamesFinished)}</td><td>${formatInteger(row.turns)}</td><td>${formatInteger(row.summariesSaved)}</td><td>${formatInteger(row.modelCompleted)}</td><td>${formatInteger(row.modelFailures)}</td><td>${formatInteger(row.modelTokens)}</td></tr>`).join("")}
      </tbody></table></div>
    </section>

    <aside class="admin-methodology" aria-labelledby="method-title"><h2 id="method-title">Definitions and privacy</h2><p>These are best-effort operational counters, not an audit, delivery, or billing ledger. Product events can be missed. Failed or timed-out model attempts can report zero tokens when a provider returns no usage, so reported tokens can be lower than billed usage.</p><p>Product metrics count allowlisted milestone events. Room speaking minutes sum completed multiplayer-turn speaking seconds. Practice time sums backed-up compact-summary duration. Event ratios divide totals observed in the selected window; they are operational signals, not cohort conversion rates, and events can cross the window boundary. Model success and average latency use completed calls as the denominator; an em dash means no denominator exists. Every window includes the current UTC day, which may be partial.</p><p>${escapeHTML(snapshot?.productPrivacy || "Aggregate product events only.")} ${escapeHTML(snapshot?.modelPrivacy || "Aggregate model operations only.")}</p><p>Source: same-origin <code>/api/v1/admin/analytics</code> and <code>/api/v1/admin/model-usage</code>, each requested once for a validated 90-day extract. Cards, charts, and tables use the same locally filtered daily rows and reconcile with the API totals.</p></aside>
  </section>`;
}

function normalizeProductRow(value) {
  const day = isoDay(value?.day);
  const metric = PRODUCT_METRICS.includes(value?.metric) ? value.metric : "";
  if (!day || !metric) throw invalidSource("A product aggregate row is invalid.");
  const eventCount = strictNonNegativeNumber(value.eventCount, true);
  const valueSum = strictNonNegativeNumber(value.valueSum);
  const valueMin = strictNonNegativeNumber(value.valueMin);
  const valueMax = strictNonNegativeNumber(value.valueMax);
  const updatedAt = isoTimestamp(value.updatedAt);
  if (
    eventCount < 1
    || valueMin > valueMax
    || !updatedAt
    || !validProductValueAggregate(metric, eventCount, valueSum, valueMin, valueMax)
  ) {
    throw invalidSource("A product aggregate row failed its invariants.");
  }
  return {
    day,
    metric,
    eventCount,
    valueSum,
    updatedAt,
  };
}

function normalizeModelRow(value) {
  const day = isoDay(value?.day);
  const scope = value?.scope === "global" || value?.scope === "provider" ? value.scope : "";
  const provider = boundedSourceDimension(value?.provider, 64, /^[A-Za-z0-9._:-]+$/u);
  const model = boundedSourceDimension(value?.model, 128, /^[A-Za-z0-9._:/-]+$/u);
  const task = boundedSourceText(value?.task, 32);
  const updatedAt = isoTimestamp(value?.updatedAt);
  if (!day || !scope || !provider || !model || !task || !updatedAt) {
    throw invalidSource("A model aggregate row is invalid.");
  }
  const row = {
    day,
    scope,
    provider,
    model,
    task,
    updatedAt,
  };
  for (const key of MODEL_TOTAL_KEYS) row[key] = strictNonNegativeNumber(value?.[key], true);
  const globalShape = provider === "all" && model === "all" && task === "all";
  const providerShape = provider !== "all" && model !== "all" && task === "topics";
  if (
    row.completedCalls !== row.successCount + row.failureCount
    || row.latencyMsTotal > row.completedCalls * MAX_MODEL_LATENCY_MS
    || (scope === "global" && (!globalShape || row.reservedCalls < row.completedCalls))
    || (scope === "provider" && (!providerShape || row.reservedCalls !== 0 || row.completedCalls < 1))
  ) {
    throw invalidSource("A model aggregate row failed its invariants.");
  }
  return row;
}

function validateSourceWindow(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.days !== 90) {
    throw invalidSource(`The ${label} aggregate window is invalid.`);
  }
  const fromDay = utcMidnightDay(value.from);
  const throughDay = utcMidnightDay(value.through);
  if (!fromDay || !throughDay || shiftUTCDay(fromDay, 89) !== throughDay) {
    throw invalidSource(`The ${label} aggregate window is not a complete 90-day UTC window.`);
  }
  return { fromDay, throughDay };
}

function assertUniqueRows(rows, keyFor, label) {
  const keys = new Set();
  for (const row of rows) {
    const key = keyFor(row);
    if (keys.has(key)) throw invalidSource(`The ${label} aggregate contains duplicate rows.`);
    keys.add(key);
  }
}

function assertRowsInsideWindow(rows, window, label) {
  if (rows.some((row) => {
    const updatedDay = row.updatedAt.slice(0, 10);
    return row.day < window.fromDay
      || row.day > window.throughDay
      || updatedDay < row.day
      || updatedDay > window.throughDay;
  })) {
    throw invalidSource(`The ${label} aggregate contains rows outside its declared window.`);
  }
}

function reconcileProductTotals(value, rows) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSource("Product aggregate totals are missing.");
  }
  const expected = new Map();
  for (const row of rows) {
    const total = expected.get(row.metric) ?? { events: 0, value: 0 };
    total.events += row.eventCount;
    total.value += row.valueSum;
    expected.set(row.metric, total);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected.keys()].sort();
  if (actualKeys.join("\u0000") !== expectedKeys.join("\u0000")) {
    throw invalidSource("Product aggregate totals do not match the daily metric set.");
  }
  for (const metric of expectedKeys) {
    const actual = value[metric];
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      throw invalidSource("A product aggregate total is invalid.");
    }
    const events = strictNonNegativeNumber(actual.events, true);
    const sum = strictNonNegativeNumber(actual.value);
    const total = expected.get(metric);
    if (events !== total.events || !nearlyEqual(sum, total.value)) {
      throw invalidSource("Product aggregate totals do not reconcile with daily rows.");
    }
  }
}

function reconcileModelTotals(value, rows) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSource("Model aggregate totals are missing.");
  }
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.join("\u0000") !== [...MODEL_TOTAL_KEYS].sort().join("\u0000")) {
    throw invalidSource("Model aggregate totals have an unexpected shape.");
  }
  const expected = sumModelRows(rows.filter((row) => row.scope === "global"));
  for (const key of MODEL_TOTAL_KEYS) {
    const actual = strictNonNegativeNumber(value[key], true);
    if (actual !== expected[key]) {
      throw invalidSource("Model aggregate totals do not reconcile with daily rows.");
    }
  }
  const providers = sumModelRows(rows.filter((row) => row.scope === "provider"));
  for (const key of MODEL_TOTAL_KEYS.filter((name) => name !== "reservedCalls")) {
    if (providers[key] !== expected[key]) {
      throw invalidSource("Provider aggregates do not reconcile with global model totals.");
    }
  }
  const days = new Set(rows.map((row) => row.day));
  for (const day of days) {
    const globalDay = sumModelRows(rows.filter((row) => row.day === day && row.scope === "global"));
    const providerDay = sumModelRows(rows.filter((row) => row.day === day && row.scope === "provider"));
    for (const key of MODEL_TOTAL_KEYS.filter((name) => name !== "reservedCalls")) {
      if (providerDay[key] !== globalDay[key]) {
        throw invalidSource("Provider aggregates do not reconcile with daily global model totals.");
      }
    }
  }
}

function validProductValueAggregate(metric, eventCount, valueSum, valueMin, valueMax) {
  const domain = PRODUCT_VALUE_DOMAINS[metric];
  if (!domain || valueMin < domain.minimum || valueMax > domain.maximum) return false;
  if (domain.integer && ![valueSum, valueMin, valueMax].every(Number.isSafeInteger)) return false;
  if (eventCount === 1) {
    return nearlyEqual(valueMin, valueMax) && nearlyEqual(valueSum, valueMin);
  }

  const lowerBound = valueMax + ((eventCount - 1) * valueMin);
  const upperBound = valueMin + ((eventCount - 1) * valueMax);
  return (valueSum > lowerBound || nearlyEqual(valueSum, lowerBound))
    && (valueSum < upperBound || nearlyEqual(valueSum, upperBound));
}

function strictNonNegativeNumber(value, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw invalidSource("An aggregate contains an invalid number.");
  }
  return value;
}

function boundedSourceText(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && [...text].length <= limit ? text : "";
}

function boundedSourceDimension(value, limit, pattern) {
  const text = boundedSourceText(value, limit);
  return text && pattern.test(text) ? text : "";
}

function isoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function nearlyEqual(left, right) {
  // D1 accumulates REAL values, so repeated fractional seconds can drift by a
  // few ulps. Keep the allowance tiny and bounded in both absolute and
  // relative terms; integer-valued metric domains are checked exactly above.
  return Math.abs(left - right) <= Math.max(
    FLOAT_ABSOLUTE_TOLERANCE,
    FLOAT_RELATIVE_TOLERANCE * Math.max(Math.abs(left), Math.abs(right)),
  );
}

function invalidSource(_detail) {
  return new AdminAnalyticsError("Analytics returned inconsistent aggregate data.", {
    code: "INVALID_SOURCE_DATA",
  });
}

function sumModelRows(rows) {
  const total = { ...ZERO_MODEL_TOTALS };
  for (const row of rows) addModelRow(total, row);
  return total;
}

function addModelRow(total, row) {
  for (const key of Object.keys(ZERO_MODEL_TOTALS)) total[key] += nonNegative(row[key]);
}

function metricCard(value, label, context) {
  return `<article class="admin-kpi"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong><small>${escapeHTML(context)}</small></article>`;
}

function barChart(title, description, rows, valueFor, maximum) {
  return `<figure class="panel admin-chart"><figcaption><span>${escapeHTML(title)}</span><small>${escapeHTML(description)}</small></figcaption><div class="admin-bars" role="img" aria-label="${escapeHTML(`${title}. ${description}. See the daily aggregate table for exact values.`)}">${rows.map((row) => {
    const value = nonNegative(valueFor(row));
    return `<progress value="${value}" max="${maximum}" title="${escapeHTML(`${formatDay(row.day)}: ${formatInteger(value)}`)}"></progress>`;
  }).join("")}</div></figure>`;
}

function funnelRow(label, events, interpretation) {
  return `<tr><th scope="row">${escapeHTML(label)}</th><td>${formatInteger(events)}</td><td>${escapeHTML(interpretation)}</td></tr>`;
}

function summaryRow(label, value) {
  return `<tr><th scope="row">${escapeHTML(label)}</th><td>${escapeHTML(value)}</td></tr>`;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function formatRatio(numerator, denominator, suffix) {
  const value = ratio(nonNegative(numerator), nonNegative(denominator));
  return denominator > 0 ? `${formatDecimal(value, 2)} ${suffix}` : "— (no denominator)";
}

function formatPercent(value) {
  return `${formatDecimal(nonNegative(value) * 100, 1)}%`;
}

function formatDurationSeconds(value) {
  const seconds = nonNegative(value);
  if (seconds < 60) return `${formatDecimal(seconds, 0)} sec`;
  return `${formatDecimal(seconds / 60, 1)} min`;
}

function formatDurationMs(value) {
  const milliseconds = nonNegative(value);
  if (milliseconds < 1_000) return `${formatDecimal(milliseconds, 0)} ms`;
  return `${formatDecimal(milliseconds / 1_000, 2)} s`;
}

function formatInteger(value) {
  return Math.round(nonNegative(value)).toLocaleString("en-US");
}

function formatDecimal(value, digits) {
  return nonNegative(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDay(value) {
  const day = isoDay(value);
  if (!day) return "Unknown day";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${day}T00:00:00.000Z`));
}

function isoDay(value) {
  const text = String(value ?? "");
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/u);
  if (!match) return "";
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1] ? match[1] : "";
}

function utcMidnightDay(value) {
  if (typeof value !== "string") return "";
  const day = isoDay(value);
  return day && value === `${day}T00:00:00.000Z` ? day : "";
}

function shiftUTCDay(day, offset) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function shortText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}
