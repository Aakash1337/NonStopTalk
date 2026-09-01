import assert from "node:assert/strict";
import test from "node:test";

import {
	D1_SNAPSHOT_SQL,
	EXPECTED_DELTAS,
	STAGING_ORIGIN,
	createStagingRequester,
	parseD1Snapshot,
	pollForExpectedDeltas,
	requireStagingOrigin,
	runStagingOutboxActivationSmoke,
} from "./smoke-staging-outbox.mjs";

const HOST_TOKEN = "a".repeat(64);
const GUEST_TOKEN = "b".repeat(64);

function jsonResponse(payload, status = 200, headers = {}) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
	});
}

function snapshot(overrides = {}) {
	return {
		receiptCount: 40,
		roomFactCount: 12,
		roomCreatedCount: 20,
		roomJoinedCount: 18,
		gameStartedCount: 16,
		turnCompletedCount: 30,
		gameFinishedCount: 14,
		...overrides,
	};
}

function addExpected(baseline) {
	return Object.fromEntries(
		Object.entries(baseline).map(([field, value]) => [field, value + EXPECTED_DELTAS[field]]),
	);
}

function publicRoom(overrides = {}) {
	return {
		code: "ABC234",
		version: 1,
		phase: "setup",
		players: [{ id: "p1", score: 0 }],
		activeTurn: null,
		completedTurns: [],
		history: [],
		winner: null,
		viewer: { isHost: true, isMember: true },
		...overrides,
	};
}

test("the activation smoke refuses every origin except the exact staging origin before I/O", async () => {
	assert.equal(requireStagingOrigin(STAGING_ORIGIN), STAGING_ORIGIN);
	assert.equal(requireStagingOrigin(`${STAGING_ORIGIN}/`), STAGING_ORIGIN);
	for (const origin of [
		"https://dontstoptalking.org",
		"http://nonstoptalk-staging.aakashplays656.workers.dev",
		`${STAGING_ORIGIN}/api/v1/platform/status`,
		`${STAGING_ORIGIN}?unsafe=1`,
		"not a URL",
	]) {
		assert.throws(() => requireStagingOrigin(origin), /exact Release B staging origin/u);
	}

	let fetchCalls = 0;
	let databaseCalls = 0;
	await assert.rejects(
		runStagingOutboxActivationSmoke({
			origin: "https://dontstoptalking.org",
			fetchImpl: async () => {
				fetchCalls += 1;
				return jsonResponse({});
			},
			readSnapshot: async () => {
				databaseCalls += 1;
				return snapshot();
			},
		}),
		/exact Release B staging origin/u,
	);
	assert.equal(fetchCalls, 0);
	assert.equal(databaseCalls, 0);
});

test("readiness rejects schema or delivery mismatches before reading D1 or mutating a room", async () => {
	for (const statusPayload of [
		{
			status: "ok",
			schemaVersion: 5,
			capabilities: {
				aggregateAnalytics: { delivery: "durable-outbox" },
				roomFacts: { status: "ready" },
				retentionCleanup: { status: "ready" },
			},
		},
		{
			status: "ok",
			schemaVersion: 6,
			capabilities: {
				aggregateAnalytics: { delivery: "best-effort" },
				roomFacts: { status: "ready" },
				retentionCleanup: { status: "ready" },
			},
		},
		{
			status: "degraded",
			schemaVersion: 6,
			capabilities: {
				aggregateAnalytics: { delivery: "durable-outbox" },
				roomFacts: { status: "ready" },
				retentionCleanup: { status: "ready" },
			},
		},
		{
			status: "ok",
			schemaVersion: 6,
			capabilities: {
				aggregateAnalytics: { delivery: "durable-outbox" },
				roomFacts: { status: "ready" },
				retentionCleanup: { status: "stale" },
			},
		},
	]) {
		const paths = [];
		let databaseCalls = 0;
		await assert.rejects(
			runStagingOutboxActivationSmoke({
				fetchImpl: async (url) => {
					paths.push(new URL(url).pathname);
					return jsonResponse(statusPayload);
				},
				readSnapshot: async () => {
					databaseCalls += 1;
					return snapshot();
				},
			}),
			/readiness requires/u,
		);
		assert.deepEqual(paths, ["/api/v1/platform/status"]);
		assert.equal(databaseCalls, 0);
	}
});

test("the public lifecycle uses isolated cookies, proves all state transitions, and waits for seven receipts", async () => {
	const trace = [];
	let apiStep = 0;
	const expectedActions = [
		{ type: "start-game" },
		{ type: "start-turn", afterTurnId: "" },
		{ type: "submit-turn", turnId: "t1", spokenSeconds: 1, completed: false, eliminated: false },
		{ type: "start-turn", afterTurnId: "t1" },
		{ type: "submit-turn", turnId: "t2", spokenSeconds: 1, completed: false, eliminated: false },
		{ type: "reset" },
	];
	const actionRooms = [
		publicRoom({
			version: 3,
			phase: "playing",
			players: [{ id: "p1", score: 0 }, { id: "p2", score: 0 }],
		}),
		publicRoom({
			version: 4,
			phase: "playing",
			players: [{ id: "p1", score: 0 }, { id: "p2", score: 0 }],
			activeTurn: { id: "t1" },
		}),
		publicRoom({
			version: 5,
			phase: "playing",
			players: [{ id: "p1", score: 1 }, { id: "p2", score: 0 }],
			completedTurns: [{ id: "t1" }],
		}),
		publicRoom({
			version: 6,
			phase: "playing",
			players: [{ id: "p1", score: 1 }, { id: "p2", score: 0 }],
			activeTurn: { id: "t2" },
			completedTurns: [{ id: "t1" }],
		}),
		publicRoom({
			version: 7,
			phase: "finished",
			players: [{ id: "p1", score: 1 }, { id: "p2", score: 1 }],
			completedTurns: [{ id: "t1" }, { id: "t2" }],
			winner: { id: "p1", score: 1 },
		}),
		publicRoom({
			version: 8,
			players: [{ id: "p1", score: 0 }, { id: "p2", score: 0 }],
			history: [{}],
		}),
	];

	const fetchImpl = async (url, init) => {
		const parsed = new URL(url);
		assert.equal(parsed.origin, STAGING_ORIGIN);
		const headers = new Headers(init.headers);
		if (apiStep === 0) {
			trace.push("status");
			assert.equal(parsed.pathname, "/api/v1/platform/status");
			assert.equal(init.method, "GET");
			assert.equal(headers.get("Cookie"), null);
			apiStep += 1;
			return jsonResponse({
				status: "ok",
				schemaVersion: 6,
				capabilities: {
					aggregateAnalytics: { delivery: "durable-outbox" },
					roomFacts: { status: "ready" },
					retentionCleanup: { status: "ready" },
				},
			});
		}
		if (apiStep === 1) {
			trace.push("create");
			assert.equal(parsed.pathname, "/api/rooms");
			assert.equal(headers.get("Cookie"), null);
			assert.deepEqual(JSON.parse(init.body), { name: "Release B smoke host" });
			apiStep += 1;
			return jsonResponse({ room: publicRoom() }, 201, {
				"Set-Cookie": `nonstoptalk_token=${HOST_TOKEN}; Path=/; HttpOnly; Secure`,
			});
		}
		if (apiStep === 2) {
			trace.push("join");
			assert.equal(parsed.pathname, "/api/rooms/ABC234/join");
			assert.equal(headers.get("Cookie"), null);
			assert.deepEqual(JSON.parse(init.body), { name: "Release B smoke guest" });
			apiStep += 1;
			return jsonResponse({
				room: publicRoom({
					version: 2,
					players: [{ id: "p1", score: 0 }, { id: "p2", score: 0 }],
					viewer: { isHost: false, isMember: true },
				}),
			}, 200, {
				"Set-Cookie": `nonstoptalk_token=${GUEST_TOKEN}; Path=/; HttpOnly; Secure`,
			});
		}

		const actionIndex = apiStep - 3;
		trace.push(`action-${actionIndex + 1}`);
		assert.equal(parsed.pathname, "/api/rooms/ABC234/action");
		assert.equal(headers.get("Cookie"), `nonstoptalk_token=${HOST_TOKEN}`);
		assert.deepEqual(JSON.parse(init.body), expectedActions[actionIndex]);
		apiStep += 1;
		return jsonResponse({ room: actionRooms[actionIndex] });
	};

	const baseline = snapshot();
	const exact = addExpected(baseline);
	let databaseCalls = 0;
	const readSnapshot = async () => {
		databaseCalls += 1;
		trace.push(`snapshot-${databaseCalls}`);
		if (databaseCalls === 1) return baseline;
		if (databaseCalls === 2) {
			return { ...exact, receiptCount: exact.receiptCount - 1 };
		}
		return exact;
	};
	const delays = [];
	const summary = await runStagingOutboxActivationSmoke({
		fetchImpl,
		readSnapshot,
		delay: async (milliseconds) => {
			delays.push(milliseconds);
			trace.push("delay");
		},
		pollAttempts: 3,
		pollDelayMs: 17,
	});

	assert.equal(apiStep, 9);
	assert.equal(databaseCalls, 3);
	assert.deepEqual(delays, [17]);
	assert.deepEqual(summary, {
		status: "ok",
		origin: STAGING_ORIGIN,
		receiptsAdded: 7,
		roomFactsAdded: 1,
		analyticsEventsAdded: {
			roomCreated: 1,
			roomJoined: 1,
			gameStarted: 1,
			turnCompleted: 2,
			gameFinished: 1,
		},
	});
	assert.deepEqual(trace, [
		"status",
		"snapshot-1",
		"create",
		"join",
		"action-1",
		"action-2",
		"action-3",
		"action-4",
		"action-5",
		"action-6",
		"snapshot-2",
		"delay",
		"snapshot-3",
	]);
});

test("the requester rejects either private milestone header before parsing a public response", async () => {
	for (const name of [
		"X-NonStopTalk-Room-Milestones",
		"X-NonStopTalk-Room-Milestone-Owner",
	]) {
		const request = createStagingRequester({
			fetchImpl: async () => jsonResponse({ schemaVersion: 6 }, 200, { [name]: "private" }),
		});
		await assert.rejects(
			request(null, "/api/v1/platform/status"),
			/internal room-milestone protocol header/u,
		);
	}
});

test("the requester cancels an oversized response before buffering the full body", async () => {
	let canceled = false;
	let pullCount = 0;
	const chunks = [
		new Uint8Array(200 * 1_024),
		new Uint8Array(100 * 1_024),
	];
	const request = createStagingRequester({
		fetchImpl: async () => new Response(new ReadableStream({
			pull(controller) {
				pullCount += 1;
				const chunk = chunks.shift();
				if (chunk) controller.enqueue(chunk);
			},
			cancel() {
				canceled = true;
			},
		})),
	});

	await assert.rejects(
		request(null, "/api/v1/platform/status"),
		/exceeded the smoke-test size limit/u,
	);
	assert.equal(canceled, true);
	assert.ok(pullCount <= 3);
});

test("Wrangler D1 JSON is parsed only when the one aggregate row is complete", () => {
	assert.match(D1_SNAPSHOT_SQL, /^SELECT\s/u);
	assert.doesNotMatch(
		D1_SNAPSHOT_SQL,
		/\b(?:ALTER|CREATE|DELETE|DROP|INSERT|REPLACE|UPDATE|UPSERT|VACUUM)\b/iu,
	);
	const row = {
		receipt_count: 47,
		room_fact_count: 13,
		room_created_count: 21,
		room_joined_count: 19,
		game_started_count: 17,
		turn_completed_count: 32,
		game_finished_count: 15,
	};
	assert.deepEqual(parseD1Snapshot(JSON.stringify([{
		results: [row],
		success: true,
		meta: { duration: 0.1, rows_read: 7 },
	}])), snapshot({
		receiptCount: 47,
		roomFactCount: 13,
		roomCreatedCount: 21,
		roomJoinedCount: 19,
		gameStartedCount: 17,
		turnCompletedCount: 32,
		gameFinishedCount: 15,
	}));

	for (const invalid of [
		"not json",
		JSON.stringify({ results: [row], success: true }),
		JSON.stringify([{ results: [row], success: false }]),
		JSON.stringify([{ results: [], success: true }]),
		JSON.stringify([{ results: [{ ...row, receipt_count: "47" }], success: true }]),
		JSON.stringify([{ results: [{ ...row, game_finished_count: -1 }], success: true }]),
	]) {
		assert.throws(() => parseD1Snapshot(invalid), /unexpected shape/u);
	}
});

test("D1 polling is bounded, retries incomplete delivery, and stops on exact deltas", async () => {
	const baseline = snapshot();
	const exact = addExpected(baseline);
	const observations = [
		{ ...exact, receiptCount: exact.receiptCount - 2 },
		{ ...exact, receiptCount: exact.receiptCount - 1 },
		exact,
	];
	const delays = [];
	let reads = 0;
	assert.deepEqual(await pollForExpectedDeltas({
		baseline,
		readSnapshot: async () => observations[reads++],
		delay: async (milliseconds) => delays.push(milliseconds),
		attempts: 3,
		delayMs: 11,
	}), exact);
	assert.equal(reads, 3);
	assert.deepEqual(delays, [11, 11]);

	reads = 0;
	const exhaustedDelays = [];
	await assert.rejects(
		pollForExpectedDeltas({
			baseline,
			readSnapshot: async () => {
				reads += 1;
				return baseline;
			},
			delay: async (milliseconds) => exhaustedDelays.push(milliseconds),
			attempts: 3,
			delayMs: 13,
		}),
		/bounded polling window/u,
	);
	assert.equal(reads, 3);
	assert.deepEqual(exhaustedDelays, [13, 13]);

	reads = 0;
	const overlapped = { ...exact, receiptCount: exact.receiptCount + 1 };
	await assert.rejects(
		pollForExpectedDeltas({
			baseline,
			readSnapshot: async () => {
				reads += 1;
				return overlapped;
			},
			delay: async () => assert.fail("An overlapped run must stop immediately."),
			attempts: 3,
			delayMs: 13,
		}),
		/overlapped the isolated Release B lifecycle/u,
	);
	assert.equal(reads, 1);
});
