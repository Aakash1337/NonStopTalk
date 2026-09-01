import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

export const STAGING_ORIGIN = "https://nonstoptalk-staging.aakashplays656.workers.dev";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER_ENTRY = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
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
// That privacy boundary also means a passing activation run requires a quiet
// staging window: any unrelated write makes the exact-delta check fail closed.
export const D1_SNAPSHOT_SQL = `SELECT
	(SELECT COUNT(*) FROM room_milestone_receipts) AS receipt_count,
	(SELECT COUNT(*) FROM room_facts) AS room_fact_count,
	COALESCE((SELECT event_count FROM analytics_daily WHERE day = strftime('%Y-%m-%d', 'now') AND metric = 'room_created'), 0) AS room_created_count,
	COALESCE((SELECT event_count FROM analytics_daily WHERE day = strftime('%Y-%m-%d', 'now') AND metric = 'room_joined'), 0) AS room_joined_count,
	COALESCE((SELECT event_count FROM analytics_daily WHERE day = strftime('%Y-%m-%d', 'now') AND metric = 'game_started'), 0) AS game_started_count,
	COALESCE((SELECT event_count FROM analytics_daily WHERE day = strftime('%Y-%m-%d', 'now') AND metric = 'turn_completed'), 0) AS turn_completed_count,
	COALESCE((SELECT event_count FROM analytics_daily WHERE day = strftime('%Y-%m-%d', 'now') AND metric = 'game_finished'), 0) AS game_finished_count;`;

const execFileAsync = promisify(execFile);

function fail(message) {
	throw new Error(message);
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireStagingOrigin(value) {
	if (typeof value !== "string" || value.length === 0) {
		return fail("Refusing to run: the exact Release B staging origin is required.");
	}
	let candidate;
	try {
		candidate = new URL(value);
	} catch {
		return fail("Refusing to run: the exact Release B staging origin is required.");
	}
	if (
		candidate.origin !== STAGING_ORIGIN
		|| candidate.pathname !== "/"
		|| candidate.search !== ""
		|| candidate.hash !== ""
		|| candidate.username !== ""
		|| candidate.password !== ""
	) {
		return fail("Refusing to run: the exact Release B staging origin is required.");
	}
	return STAGING_ORIGIN;
}

function assertNoInternalHeaders(headers) {
	for (const name of INTERNAL_RESPONSE_HEADERS) {
		if (headers.has(name)) {
			fail("A public response exposed an internal room-milestone protocol header.");
		}
	}
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

async function readJsonResponse(response) {
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
		if (overflowed) {
			return fail("A staging API response exceeded the smoke-test size limit.");
		}
		if (readFailed) return fail("A staging API response body could not be read.");
	}
	if (text === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		return fail("A staging API response was not valid JSON.");
	}
}

export function createStagingRequester({ origin = STAGING_ORIGIN, fetchImpl = globalThis.fetch } = {}) {
	const checkedOrigin = requireStagingOrigin(origin);
	if (typeof fetchImpl !== "function") fail("A Fetch implementation is required.");
	return async function request(identity, pathname, { method = "GET", body } = {}) {
		const headers = new Headers({ Accept: "application/json" });
		if (identity?.cookie) headers.set("Cookie", identity.cookie);
		if (method !== "GET" && method !== "HEAD") headers.set("Origin", checkedOrigin);
		if (body !== undefined) headers.set("Content-Type", "application/json");

		let response;
		try {
			response = await fetchImpl(new URL(pathname, checkedOrigin), {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "error",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			return fail("A staging API request failed.");
		}
		assertNoInternalHeaders(response.headers);
		if (identity) {
			const cookie = readIdentityCookie(response.headers);
			if (cookie) identity.cookie = cookie;
		}
		return {
			status: response.status,
			payload: await readJsonResponse(response),
		};
	};
}

export function assertOutboxReadiness(result) {
	if (!isObject(result) || result.status !== 200 || !isObject(result.payload)) {
		return fail("Release B staging readiness was not healthy.");
	}
	if (result.payload.status !== "ok") {
		return fail("Release B staging readiness requires an overall healthy status.");
	}
	if (result.payload.schemaVersion !== 6) {
		return fail("Release B staging readiness requires platform schema 6.");
	}
	if (result.payload.capabilities?.aggregateAnalytics?.delivery !== "durable-outbox") {
		return fail("Release B staging readiness requires durable-outbox delivery.");
	}
	if (
		result.payload.capabilities?.roomFacts?.status !== "ready"
		|| result.payload.capabilities?.retentionCleanup?.status !== "ready"
	) {
		return fail("Release B staging readiness requires room facts and retention cleanup.");
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

export async function runPublicRoomLifecycle(request) {
	if (typeof request !== "function") fail("A staging request adapter is required.");
	const host = { cookie: "" };
	const guest = { cookie: "" };

	const created = expectRoom(await request(host, "/api/rooms", {
		method: "POST",
		body: { name: "Release B smoke host" },
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

	const roomPath = `/api/rooms/${created.code}`;
	const joined = expectRoom(await request(guest, `${roomPath}/join`, {
		method: "POST",
		body: { name: "Release B smoke guest" },
	}), 200, "Room join");
	if (
		joined.code !== created.code
		|| joined.version !== 2
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

	const started = expectRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: { type: "start-game" },
	}), 200, "Game start");
	if (
		started.version !== 3
		|| started.phase !== "playing"
		|| started.activeTurn !== null
		|| expectArray(started.completedTurns, "Game start").length !== 0
	) {
		fail("Game start did not return the expected public room state.");
	}

	const firstStarted = expectRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: { type: "start-turn", afterTurnId: "" },
	}), 200, "First turn start");
	const firstTurnId = firstStarted.activeTurn?.id;
	if (
		firstStarted.version !== 4
		|| firstStarted.phase !== "playing"
		|| typeof firstTurnId !== "string"
		|| firstTurnId.length === 0
		|| expectArray(firstStarted.completedTurns, "First turn start").length !== 0
	) {
		fail("First turn start did not return the expected public room state.");
	}

	const firstCompleted = expectRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: {
			type: "submit-turn",
			turnId: firstTurnId,
			spokenSeconds: 1,
			completed: false,
			eliminated: false,
		},
	}), 200, "First turn completion");
	const firstCompletedTurns = expectArray(firstCompleted.completedTurns, "First turn completion");
	if (
		firstCompleted.version !== 5
		|| firstCompleted.phase !== "playing"
		|| firstCompleted.activeTurn !== null
		|| firstCompletedTurns.length !== 1
		|| firstCompletedTurns[0]?.id !== firstTurnId
	) {
		fail("First turn completion did not return the expected public room state.");
	}

	const secondStarted = expectRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: { type: "start-turn", afterTurnId: firstTurnId },
	}), 200, "Second turn start");
	const secondTurnId = secondStarted.activeTurn?.id;
	if (
		secondStarted.version !== 6
		|| secondStarted.phase !== "playing"
		|| typeof secondTurnId !== "string"
		|| secondTurnId.length === 0
		|| secondTurnId === firstTurnId
		|| expectArray(secondStarted.completedTurns, "Second turn start").length !== 1
	) {
		fail("Second turn start did not return the expected public room state.");
	}

	const finished = expectRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: {
			type: "submit-turn",
			turnId: secondTurnId,
			spokenSeconds: 1,
			completed: false,
			eliminated: false,
		},
	}), 200, "Game finish");
	const finishedTurns = expectArray(finished.completedTurns, "Game finish");
	if (
		finished.version !== 7
		|| finished.phase !== "finished"
		|| finished.activeTurn !== null
		|| finishedTurns.length !== 2
		|| finishedTurns[0]?.id !== firstTurnId
		|| finishedTurns[1]?.id !== secondTurnId
		|| !isObject(finished.winner)
	) {
		fail("Game finish did not return the expected public room state.");
	}

	const reset = expectRoom(await request(host, `${roomPath}/action`, {
		method: "POST",
		body: { type: "reset" },
	}), 200, "Game reset");
	if (
		reset.version !== 8
		|| reset.phase !== "setup"
		|| reset.activeTurn !== null
		|| reset.winner !== null
		|| expectArray(reset.completedTurns, "Game reset").length !== 0
		|| expectArray(reset.history, "Game reset").length !== 1
		|| expectArray(reset.players, "Game reset").some((player) => player?.score !== 0)
	) {
		fail("Game reset did not return the expected public room state.");
	}
}

function parseCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseD1Snapshot(stdout) {
	if (typeof stdout !== "string" || stdout.trim() === "") {
		return fail("The staging aggregate D1 query returned an unexpected shape.");
	}
	let document;
	try {
		document = JSON.parse(stdout);
	} catch {
		return fail("The staging aggregate D1 query returned an unexpected shape.");
	}
	if (
		!Array.isArray(document)
		|| document.length !== 1
		|| !isObject(document[0])
		|| document[0].success !== true
		|| !Array.isArray(document[0].results)
		|| document[0].results.length !== 1
		|| !isObject(document[0].results[0])
	) {
		return fail("The staging aggregate D1 query returned an unexpected shape.");
	}
	const row = document[0].results[0];
	const snapshot = {};
	for (const field of SNAPSHOT_FIELD_NAMES) {
		const count = parseCount(row[SNAPSHOT_ROW_FIELDS[field]]);
		if (count === null) {
			return fail("The staging aggregate D1 query returned an unexpected shape.");
		}
		snapshot[field] = count;
	}
	return snapshot;
}

export async function readRemoteD1Snapshot() {
	let output;
	try {
		output = await execFileAsync(process.execPath, [
			WRANGLER_ENTRY,
			"d1",
			"execute",
			"PLATFORM_DB",
			"--remote",
			"--env",
			"staging",
			"--json",
			"--command",
			D1_SNAPSHOT_SQL,
		], {
			cwd: PROJECT_ROOT,
			encoding: "utf8",
			maxBuffer: 1_024 * 1_024,
			timeout: 30_000,
			windowsHide: true,
			env: { ...process.env, CI: "1", NO_COLOR: "1" },
		});
	} catch {
		return fail("The staging aggregate D1 counters could not be read.");
	}
	return parseD1Snapshot(output.stdout);
}

function assertSnapshot(snapshot) {
	if (!isObject(snapshot)) fail("The D1 snapshot adapter returned an invalid result.");
	for (const field of SNAPSHOT_FIELD_NAMES) {
		if (parseCount(snapshot[field]) === null) {
			fail("The D1 snapshot adapter returned an invalid result.");
		}
	}
}

export async function pollForExpectedDeltas({
	baseline,
	readSnapshot,
	delay = sleep,
	attempts = DEFAULT_POLL_ATTEMPTS,
	delayMs = DEFAULT_POLL_DELAY_MS,
}) {
	assertSnapshot(baseline);
	if (typeof readSnapshot !== "function" || typeof delay !== "function") {
		fail("The D1 polling adapters are invalid.");
	}
	if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) {
		fail("The D1 polling attempt bound is invalid.");
	}
	if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
		fail("The D1 polling delay bound is invalid.");
	}
	const expected = Object.fromEntries(
		SNAPSHOT_FIELD_NAMES.map((field) => [field, baseline[field] + EXPECTED_DELTAS[field]]),
	);
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const observed = await readSnapshot();
		assertSnapshot(observed);
		if (SNAPSHOT_FIELD_NAMES.every((field) => observed[field] === expected[field])) {
			return observed;
		}
		if (SNAPSHOT_FIELD_NAMES.some((field) => observed[field] > expected[field])) {
			return fail("Another staging write or cleanup overlapped the isolated Release B lifecycle.");
		}
		if (attempt < attempts) await delay(delayMs);
	}
	return fail("The durable Release B counters did not converge inside the bounded polling window.");
}

export async function runStagingOutboxActivationSmoke({
	origin = STAGING_ORIGIN,
	fetchImpl = globalThis.fetch,
	readSnapshot = readRemoteD1Snapshot,
	delay = sleep,
	pollAttempts = DEFAULT_POLL_ATTEMPTS,
	pollDelayMs = DEFAULT_POLL_DELAY_MS,
} = {}) {
	const request = createStagingRequester({ origin, fetchImpl });
	const status = await request(null, "/api/v1/platform/status");
	assertOutboxReadiness(status);
	const baseline = await readSnapshot();
	assertSnapshot(baseline);
	await runPublicRoomLifecycle(request);
	await pollForExpectedDeltas({
		baseline,
		readSnapshot,
		delay,
		attempts: pollAttempts,
		delayMs: pollDelayMs,
	});
	return {
		status: "ok",
		origin: STAGING_ORIGIN,
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

const isMain = process.argv[1]
	&& fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
	const requestedOrigin = process.argv[2] ?? STAGING_ORIGIN;
	if (process.argv.length > 3) fail("This command accepts at most one staging-origin argument.");
	const summary = await runStagingOutboxActivationSmoke({ origin: requestedOrigin });
	console.log(JSON.stringify(summary));
}
