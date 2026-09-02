const TOKEN_COOKIE = "nonstoptalk_token";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const INTERNAL_RESPONSE_HEADERS = Object.freeze([
	"X-NonStopTalk-Room-Milestones",
	"X-NonStopTalk-Room-Milestone-Owner",
]);
const DEFAULT_POLL_ATTEMPTS = 24;
const DEFAULT_POLL_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1_024;

const SNAPSHOT_FIELD_NAMES = Object.freeze([
	"receiptCount",
	"roomFactCount",
	"roomCreatedCount",
	"roomJoinedCount",
	"gameStartedCount",
	"turnCompletedCount",
	"gameFinishedCount",
]);

const SNAPSHOT_ROW_FIELDS = Object.freeze({
	receiptCount: "receipt_count",
	roomFactCount: "room_fact_count",
	roomCreatedCount: "room_created_count",
	roomJoinedCount: "room_joined_count",
	gameStartedCount: "game_started_count",
	turnCompletedCount: "turn_completed_count",
	gameFinishedCount: "game_finished_count",
});

export const EXPECTED_DELTAS = Object.freeze({
	receiptCount: 7,
	roomFactCount: 1,
	roomCreatedCount: 1,
	roomJoinedCount: 1,
	gameStartedCount: 1,
	turnCompletedCount: 2,
	gameFinishedCount: 1,
});

// This statement is deliberately fixed and aggregate-only. It cannot disclose
// room codes, device cookies, player names, event IDs, or milestone payloads.
// The exact-delta boundary detects unexpected aggregate movement and overshoot.
// Aggregate-only counters cannot attribute an identical unrelated event if it
// permanently substitutes for a delayed or missing canary event.
export const D1_SNAPSHOT_SQL = `SELECT
	(SELECT COUNT(*) FROM room_milestone_receipts) AS receipt_count,
	(SELECT COUNT(*) FROM room_facts) AS room_fact_count,
	COALESCE((SELECT event_count FROM analytics_daily WHERE day = strftime('%Y-%m-%d', 'now') AND metric = 'room_created'), 0) AS room_created_count,
	COALESCE((SELECT event_count FROM analytics_daily WHERE day = strftime('%Y-%m-%d', 'now') AND metric = 'room_joined'), 0) AS room_joined_count,
	COALESCE((SELECT event_count FROM analytics_daily WHERE day = strftime('%Y-%m-%d', 'now') AND metric = 'game_started'), 0) AS game_started_count,
	COALESCE((SELECT event_count FROM analytics_daily WHERE day = strftime('%Y-%m-%d', 'now') AND metric = 'turn_completed'), 0) AS turn_completed_count,
	COALESCE((SELECT event_count FROM analytics_daily WHERE day = strftime('%Y-%m-%d', 'now') AND metric = 'game_finished'), 0) AS game_finished_count;`;

export const DEFAULT_CANARY_MESSAGES = Object.freeze({
	origin: "Refusing to run: the exact outbox-canary origin is required.",
	requestAdapter: "An outbox-canary request adapter is required.",
	requestFailed: "An outbox-canary API request failed.",
	responseTooLarge: "An outbox-canary API response exceeded the smoke-test size limit.",
	responseUnreadable: "An outbox-canary API response body could not be read.",
	responseInvalidJson: "An outbox-canary API response was not valid JSON.",
	readinessUnhealthy: "Outbox-canary readiness was not healthy.",
	readinessStatus: "Outbox-canary readiness requires an overall healthy status.",
	readinessSchema: "Outbox-canary readiness requires platform schema 6.",
	readinessDelivery: "Outbox-canary readiness requires durable-outbox delivery.",
	readinessCapabilities: "Outbox-canary readiness requires room facts and retention cleanup.",
	d1Shape: "The aggregate D1 query returned an unexpected shape.",
	overlap: "Another write or cleanup overlapped the isolated outbox-canary lifecycle.",
	convergence: "The durable outbox counters did not converge inside the bounded polling window.",
});

function fail(message) {
	throw new Error(message);
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messagesFrom(value) {
	if (value === undefined) return DEFAULT_CANARY_MESSAGES;
	if (!isObject(value)) fail("The outbox-canary message profile is invalid.");
	for (const key of Object.keys(DEFAULT_CANARY_MESSAGES)) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			fail("The outbox-canary message profile is invalid.");
		}
	}
	return value;
}

export function requireExactOrigin(value, expectedOrigin, { messages } = {}) {
	const profile = messagesFrom(messages);
	let expected;
	let candidate;
	try {
		expected = new URL(expectedOrigin);
		candidate = new URL(value);
	} catch {
		return fail(profile.origin);
	}
	if (
		typeof value !== "string"
		|| expected.protocol !== "https:"
		|| expected.pathname !== "/"
		|| expected.search !== ""
		|| expected.hash !== ""
		|| expected.username !== ""
		|| expected.password !== ""
		|| candidate.origin !== expected.origin
		|| candidate.pathname !== "/"
		|| candidate.search !== ""
		|| candidate.hash !== ""
		|| candidate.username !== ""
		|| candidate.password !== ""
	) {
		return fail(profile.origin);
	}
	return expected.origin;
}

function assertNoInternalHeaders(headers) {
	for (const name of INTERNAL_RESPONSE_HEADERS) {
		if (headers.has(name)) {
			fail("A public response exposed an internal room-milestone protocol header.");
		}
	}
}

function requireCanaryRequestTarget(pathname, checkedOrigin, method) {
	if (
		typeof pathname !== "string"
		|| pathname.length === 0
		|| pathname.length > 2_048
		|| !/^\/api\/[A-Za-z0-9._~/-]+$/u.test(pathname)
		|| pathname.startsWith("//")
		|| pathname.includes("\\")
		|| (method !== "GET" && method !== "HEAD" && method !== "POST")
	) return fail("The outbox canary accepts only an exact same-origin public API path.");
	let target;
	try {
		target = new URL(pathname, checkedOrigin);
	} catch {
		return fail("The outbox canary accepts only an exact same-origin public API path.");
	}
	if (
		target.origin !== checkedOrigin
		|| target.username !== ""
		|| target.password !== ""
		|| target.search !== ""
		|| target.hash !== ""
		|| target.pathname !== pathname
	) return fail("The outbox canary accepts only an exact same-origin public API path.");
	return target;
}

function readIdentityCookie(headers) {
	const values = typeof headers.getSetCookie === "function"
		? headers.getSetCookie()
		: [headers.get("set-cookie")].filter(Boolean);
	for (const value of values) {
		if (typeof value !== "string") continue;
		const match = value.match(/(?:^|,\s*)nonstoptalk_token=([^;,\s]+)/u);
		if (match && TOKEN_PATTERN.test(match[1] ?? "")) {
			return `${TOKEN_COOKIE}=${match[1]}`;
		}
	}
	return "";
}

async function readJsonResponse(response, profile) {
	let text = "";
	if (response.body) {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let bytes = 0;
		let overflowed = false;
		let readFailed = false;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!(value instanceof Uint8Array)) {
					readFailed = true;
					break;
				}
				bytes += value.byteLength;
				if (bytes > MAX_RESPONSE_BYTES) {
					overflowed = true;
					break;
				}
				text += decoder.decode(value, { stream: true });
			}
			if (!overflowed && !readFailed) text += decoder.decode();
		} catch {
			readFailed = true;
		} finally {
			if (overflowed || readFailed) await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		if (overflowed) return fail(profile.responseTooLarge);
		if (readFailed) return fail(profile.responseUnreadable);
	}
	if (text === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		return fail(profile.responseInvalidJson);
	}
}

export function createCanaryRequester({
	origin,
	expectedOrigin,
	fetchImpl = globalThis.fetch,
	messages,
} = {}) {
	const profile = messagesFrom(messages);
	const checkedOrigin = requireExactOrigin(origin, expectedOrigin, { messages: profile });
	if (typeof fetchImpl !== "function") fail("A Fetch implementation is required.");
	return async function request(identity, pathname, { method = "GET", body } = {}) {
		const target = requireCanaryRequestTarget(pathname, checkedOrigin, method);
		const headers = new Headers({ Accept: "application/json" });
		if (identity?.cookie) headers.set("Cookie", identity.cookie);
		if (method !== "GET" && method !== "HEAD") headers.set("Origin", checkedOrigin);
		if (body !== undefined) headers.set("Content-Type", "application/json");

		let response;
		try {
			response = await fetchImpl(target, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "error",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			return fail(profile.requestFailed);
		}
		assertNoInternalHeaders(response.headers);
		if (identity) {
			const cookie = readIdentityCookie(response.headers);
			if (cookie) identity.cookie = cookie;
		}
		return {
			status: response.status,
			payload: await readJsonResponse(response, profile),
		};
	};
}

export function assertCanaryOutboxReadiness(result, { messages } = {}) {
	const profile = messagesFrom(messages);
	if (!isObject(result) || result.status !== 200 || !isObject(result.payload)) {
		return fail(profile.readinessUnhealthy);
	}
	if (result.payload.status !== "ok") return fail(profile.readinessStatus);
	if (result.payload.schemaVersion !== 6) return fail(profile.readinessSchema);
	if (result.payload.capabilities?.aggregateAnalytics?.delivery !== "durable-outbox") {
		return fail(profile.readinessDelivery);
	}
	if (
		result.payload.capabilities?.roomFacts?.status !== "ready"
		|| result.payload.capabilities?.retentionCleanup?.status !== "ready"
	) {
		return fail(profile.readinessCapabilities);
	}
}

function expectRoom(result, expectedStatus, stage) {
	if (!isObject(result) || result.status !== expectedStatus || !isObject(result.payload?.room)) {
		return fail(`${stage} did not return the expected public room state.`);
	}
	return result.payload.room;
}

function expectArray(value, stage) {
	if (!Array.isArray(value)) fail(`${stage} did not return the expected public room state.`);
	return value;
}

function expectSameRoom(result, expectedStatus, stage, expectedCode) {
	const room = expectRoom(result, expectedStatus, stage);
	if (room.code !== expectedCode) {
		fail(`${stage} returned state for a different room.`);
	}
	return room;
}

export async function runCanaryPublicRoomCreate(request, { messages } = {}) {
	const profile = messagesFrom(messages);
	if (typeof request !== "function") fail(profile.requestAdapter);
	const host = { cookie: "" };
	const created = expectRoom(await request(host, "/api/rooms", {
		method: "POST",
		body: { name: "Outbox canary host" },
	}), 201, "Room creation");
	if (
		typeof created.code !== "string"
		|| !/^[A-HJ-NP-Z2-9]{6}$/u.test(created.code)
		|| created.version !== 1
		|| created.phase !== "setup"
		|| created.activeTurn !== null
		|| expectArray(created.completedTurns, "Room creation").length !== 0
		|| expectArray(created.players, "Room creation").length !== 1
		|| created.viewer?.isHost !== true
	) {
		fail("Room creation did not return the expected public room state.");
	}
	if (!host.cookie) fail("Room creation did not establish the host identity.");
	return { host, created };
}

export async function runCanaryPublicRoomLifecycle(request, { messages } = {}) {
	const profile = messagesFrom(messages);
	if (typeof request !== "function") fail(profile.requestAdapter);
	const { host, created } = await runCanaryPublicRoomCreate(request, { messages: profile });
	const guest = { cookie: "" };
	const roomPath = `/api/rooms/${created.code}`;
	const joined = expectSameRoom(await request(guest, `${roomPath}/join`, {
		method: "POST",
		body: { name: "Outbox canary guest" },
	}), 200, "Room join", created.code);
	if (
		joined.version !== 2
		|| joined.phase !== "setup"
		|| expectArray(joined.players, "Room join").length !== 2
		|| joined.viewer?.isHost !== false
		|| joined.viewer?.isMember !== true
	) {
		fail("Room join did not return the expected public room state.");
	}
	if (!guest.cookie || guest.cookie === host.cookie) {
		fail("Room join did not establish a distinct guest identity.");
	}

	const started = expectSameRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: { type: "start-game" },
	}), 200, "Game start", created.code);
	if (
		started.version !== 3
		|| started.phase !== "playing"
		|| started.activeTurn !== null
		|| expectArray(started.completedTurns, "Game start").length !== 0
	) fail("Game start did not return the expected public room state.");

	const firstStarted = expectSameRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: { type: "start-turn", afterTurnId: "" },
	}), 200, "First turn start", created.code);
	const firstTurnId = firstStarted.activeTurn?.id;
	if (
		firstStarted.version !== 4
		|| firstStarted.phase !== "playing"
		|| typeof firstTurnId !== "string"
		|| firstTurnId.length === 0
		|| expectArray(firstStarted.completedTurns, "First turn start").length !== 0
	) fail("First turn start did not return the expected public room state.");

	const firstCompleted = expectSameRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: {
			type: "submit-turn",
			turnId: firstTurnId,
			spokenSeconds: 1,
			completed: false,
			eliminated: false,
		},
	}), 200, "First turn completion", created.code);
	const firstCompletedTurns = expectArray(firstCompleted.completedTurns, "First turn completion");
	if (
		firstCompleted.version !== 5
		|| firstCompleted.phase !== "playing"
		|| firstCompleted.activeTurn !== null
		|| firstCompletedTurns.length !== 1
		|| firstCompletedTurns[0]?.id !== firstTurnId
	) fail("First turn completion did not return the expected public room state.");

	const secondStarted = expectSameRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: { type: "start-turn", afterTurnId: firstTurnId },
	}), 200, "Second turn start", created.code);
	const secondTurnId = secondStarted.activeTurn?.id;
	if (
		secondStarted.version !== 6
		|| secondStarted.phase !== "playing"
		|| typeof secondTurnId !== "string"
		|| secondTurnId.length === 0
		|| secondTurnId === firstTurnId
		|| expectArray(secondStarted.completedTurns, "Second turn start").length !== 1
	) fail("Second turn start did not return the expected public room state.");

	const finished = expectSameRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: {
			type: "submit-turn",
			turnId: secondTurnId,
			spokenSeconds: 1,
			completed: false,
			eliminated: false,
		},
	}), 200, "Game finish", created.code);
	const finishedTurns = expectArray(finished.completedTurns, "Game finish");
	if (
		finished.version !== 7
		|| finished.phase !== "finished"
		|| finished.activeTurn !== null
		|| finishedTurns.length !== 2
		|| finishedTurns[0]?.id !== firstTurnId
		|| finishedTurns[1]?.id !== secondTurnId
		|| !isObject(finished.winner)
	) fail("Game finish did not return the expected public room state.");

	const reset = expectSameRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: { type: "reset" },
	}), 200, "Game reset", created.code);
	if (
		reset.version !== 8
		|| reset.phase !== "setup"
		|| reset.activeTurn !== null
		|| reset.winner !== null
		|| expectArray(reset.completedTurns, "Game reset").length !== 0
		|| expectArray(reset.history, "Game reset").length !== 1
		|| expectArray(reset.players, "Game reset").some((player) => player?.score !== 0)
	) fail("Game reset did not return the expected public room state.");
}

function parseCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseCanaryD1Snapshot(stdout, { messages } = {}) {
	const profile = messagesFrom(messages);
	if (typeof stdout !== "string" || stdout.trim() === "") return fail(profile.d1Shape);
	let document;
	try {
		document = JSON.parse(stdout);
	} catch {
		return fail(profile.d1Shape);
	}
	if (
		!Array.isArray(document)
		|| document.length !== 1
		|| !isObject(document[0])
		|| document[0].success !== true
		|| !Array.isArray(document[0].results)
		|| document[0].results.length !== 1
		|| !isObject(document[0].results[0])
	) return fail(profile.d1Shape);
	const row = document[0].results[0];
	const snapshot = {};
	for (const field of SNAPSHOT_FIELD_NAMES) {
		const count = parseCount(row[SNAPSHOT_ROW_FIELDS[field]]);
		if (count === null) return fail(profile.d1Shape);
		snapshot[field] = count;
	}
	return snapshot;
}

export function assertCanarySnapshot(snapshot) {
	if (!isObject(snapshot)) fail("The D1 snapshot adapter returned an invalid result.");
	for (const field of SNAPSHOT_FIELD_NAMES) {
		if (parseCount(snapshot[field]) === null) {
			fail("The D1 snapshot adapter returned an invalid result.");
		}
	}
}

export async function pollForCanaryExpectedDeltas({
	baseline,
	readSnapshot,
	delay,
	attempts = DEFAULT_POLL_ATTEMPTS,
	delayMs = DEFAULT_POLL_DELAY_MS,
	messages,
}) {
	const profile = messagesFrom(messages);
	assertCanarySnapshot(baseline);
	if (typeof readSnapshot !== "function" || typeof delay !== "function") {
		fail("The D1 polling adapters are invalid.");
	}
	assertCanaryPollingBounds(attempts, delayMs);
	const expected = Object.fromEntries(
		SNAPSHOT_FIELD_NAMES.map((field) => [field, baseline[field] + EXPECTED_DELTAS[field]]),
	);
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const observed = await readSnapshot();
		assertCanarySnapshot(observed);
		if (SNAPSHOT_FIELD_NAMES.every((field) => observed[field] === expected[field])) {
			// An exact aggregate vector is only provisional: a delayed canary event
			// could be temporarily masked by an unrelated event with the same metric.
			// Hold the quiet-window boundary for one more bounded observation.
			await delay(delayMs);
			const confirmed = await readSnapshot();
			assertCanarySnapshot(confirmed);
			if (SNAPSHOT_FIELD_NAMES.every((field) => confirmed[field] === expected[field])) {
				return confirmed;
			}
			return fail(profile.overlap);
		}
		if (SNAPSHOT_FIELD_NAMES.some((field) => observed[field] > expected[field])) {
			return fail(profile.overlap);
		}
		if (attempt < attempts) await delay(delayMs);
	}
	return fail(profile.convergence);
}

export function assertCanaryPollingBounds(attempts, delayMs) {
	if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) {
		fail("The D1 polling attempt bound is invalid.");
	}
	if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
		fail("The D1 polling delay bound is invalid.");
	}
}

export async function runOutboxActivationCanary({
	origin,
	expectedOrigin,
	fetchImpl = globalThis.fetch,
	readSnapshot,
	delay,
	pollAttempts = DEFAULT_POLL_ATTEMPTS,
	pollDelayMs = DEFAULT_POLL_DELAY_MS,
	messages,
	assertStableBeforeBaseline,
	assertStableBeforeMutation,
	assertStableAfterLifecycle,
	assertStableAfterMutation,
} = {}) {
	const profile = messagesFrom(messages);
	if (
		typeof fetchImpl !== "function"
		|| typeof readSnapshot !== "function"
		|| typeof delay !== "function"
	) {
		fail("The outbox-canary adapters are invalid.");
	}
	for (const [label, adapter] of [
		["pre-baseline", assertStableBeforeBaseline],
		["pre-mutation", assertStableBeforeMutation],
		["post-lifecycle", assertStableAfterLifecycle],
		["post-mutation", assertStableAfterMutation],
	]) {
		if (adapter !== undefined && typeof adapter !== "function") {
			fail(`The ${label} stability adapter is invalid.`);
		}
	}
	assertCanaryPollingBounds(pollAttempts, pollDelayMs);
	const request = createCanaryRequester({
		origin,
		expectedOrigin,
		fetchImpl,
		messages: profile,
	});
	const status = await request(null, "/api/v1/platform/status");
	assertCanaryOutboxReadiness(status, { messages: profile });
	await assertStableBeforeBaseline?.();
	const baseline = await readSnapshot();
	assertCanarySnapshot(baseline);
	await assertStableBeforeMutation?.();
	await runCanaryPublicRoomLifecycle(request, { messages: profile });
	await assertStableAfterLifecycle?.();
	await pollForCanaryExpectedDeltas({
		baseline,
		readSnapshot,
		delay,
		attempts: pollAttempts,
		delayMs: pollDelayMs,
		messages: profile,
	});
	await assertStableAfterMutation?.();
	return {
		status: "ok",
		origin: requireExactOrigin(origin, expectedOrigin, { messages: profile }),
		receiptsAdded: EXPECTED_DELTAS.receiptCount,
		roomFactsAdded: EXPECTED_DELTAS.roomFactCount,
		analyticsEventsAdded: {
			roomCreated: EXPECTED_DELTAS.roomCreatedCount,
			roomJoined: EXPECTED_DELTAS.roomJoinedCount,
			gameStarted: EXPECTED_DELTAS.gameStartedCount,
			turnCompleted: EXPECTED_DELTAS.turnCompletedCount,
			gameFinished: EXPECTED_DELTAS.gameFinishedCount,
		},
	};
}
