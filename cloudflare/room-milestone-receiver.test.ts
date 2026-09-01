import assert from "node:assert/strict";
import test from "node:test";

import { PlatformError, type PublicRoomFactDraft } from "./platform.ts";
import {
	ROOM_MILESTONE_PAYLOAD_DOMAIN,
	decodeRoomMilestonePayloadV1,
	encodeRoomMilestonePayloadV1,
	hashRoomMilestonePayloadV1,
	normalizeRoomMilestoneDeliveryV1,
} from "./room-milestone-contract.ts";
import { receiveRoomMilestone } from "./room-milestone-receiver.ts";

const EVENT_ID = "a".repeat(64);
const ROOM_INSTANCE_ID = "b".repeat(64);
const RECEIVED_AT = new Date("2026-09-01T12:00:00.000Z");

function roomFact(overrides: Partial<PublicRoomFactDraft> = {}): PublicRoomFactDraft {
	return {
		roomCode: "ABC234",
		stateVersion: 1,
		observedAt: "2026-09-01T11:59:59.000Z",
		milestone: "created",
		phase: "setup",
		playerCount: 1,
		onlinePlayerCount: 1,
		configuredRounds: 1,
		turnDurationSeconds: 60,
		topicPack: "everyday",
		completedTurnCount: 0,
		finishedGameCount: 0,
		totalScore: 0,
		lastTurnSpokenSeconds: 0,
		...overrides,
	};
}

function delivery(fact = roomFact()): { eventId: string; payloadJson: string } {
	return {
		eventId: EVENT_ID,
		payloadJson: encodeRoomMilestonePayloadV1(ROOM_INSTANCE_ID, fact),
	};
}

function changedTuple(payloadJson: string, index: number, value: unknown): string {
	const tuple = JSON.parse(payloadJson) as unknown[];
	tuple[index] = value;
	return JSON.stringify(tuple);
}

function expectInvalid(operation: () => unknown): void {
	assert.throws(
		operation,
		(error: unknown) => error instanceof PlatformError && error.code === "INVALID_INPUT",
	);
}

function expectPlatformError(operation: () => unknown, code: PlatformError["code"]): void {
	assert.throws(
		operation,
		(error: unknown) => error instanceof PlatformError && error.code === code,
	);
}

function fakeResult(changes: number, results: unknown[] = []): D1Result<unknown> {
	return {
		success: true,
		results,
		meta: { changes },
	} as unknown as D1Result<unknown>;
}

class FakeStatement {
	readonly database: FakeReceiverD1;
	readonly query: string;
	bindings: unknown[] = [];

	constructor(database: FakeReceiverD1, query: string) {
		this.database = database;
		this.query = query;
	}

	bind(...values: unknown[]): FakeStatement {
		this.bindings = values;
		return this;
	}

	async first<T>(): Promise<T | null> {
		assert.match(this.query, /^SELECT schema_version FROM platform_meta/u);
		return { schema_version: this.database.schemaVersion } as T;
	}
}

class FakeReceiverD1 {
	readonly schemaVersion: unknown;
	readonly configuredResults: D1Result<unknown>[];
	readonly statements: FakeStatement[] = [];
	batchStatements: FakeStatement[] = [];
	batchCalls = 0;
	failBatch = false;

	constructor(schemaVersion: unknown, configuredResults: D1Result<unknown>[] = []) {
		this.schemaVersion = schemaVersion;
		this.configuredResults = configuredResults;
	}

	prepare(query: string): D1PreparedStatement {
		const statement = new FakeStatement(this, query);
		this.statements.push(statement);
		return statement as unknown as D1PreparedStatement;
	}

	async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
		this.batchCalls += 1;
		this.batchStatements = statements as unknown as FakeStatement[];
		if (this.failBatch) throw new Error("synthetic D1 outage");
		return this.configuredResults as D1Result<T>[];
	}
}

test("encodes one canonical aggregate-only 17-field milestone tuple", async () => {
	const unsafeFact = {
		...roomFact({
			stateVersion: 9,
			milestone: "turn-completed",
			phase: "playing",
			playerCount: 2,
			onlinePlayerCount: 1,
			completedTurnCount: 2,
			totalScore: 125,
			lastTurnSpokenSeconds: 40,
		}),
		playerName: "Alice Private",
		topic: "Private topic",
		memberToken: "never-store",
	};
	const payloadJson = encodeRoomMilestonePayloadV1(ROOM_INSTANCE_ID, unsafeFact);
	const tuple = JSON.parse(payloadJson) as unknown[];

	assert.equal(tuple.length, 17);
	assert.equal(tuple[0], ROOM_MILESTONE_PAYLOAD_DOMAIN);
	assert.equal(tuple[1], ROOM_INSTANCE_ID);
	assert.deepEqual(tuple.slice(15), ["turn_completed", 40]);
	for (const privateValue of ["ABC234", "Alice Private", "Private topic", "never-store"]) {
		assert.equal(payloadJson.includes(privateValue), false);
	}
	assert.deepEqual(decodeRoomMilestonePayloadV1(payloadJson), {
		roomInstanceId: ROOM_INSTANCE_ID,
		milestone: "turn-completed",
		occurredAt: "2026-09-01T11:59:59.000Z",
		stateVersion: 9,
		phase: "playing",
		playerCount: 2,
		onlinePlayerCount: 1,
		configuredRounds: 1,
		turnDurationSeconds: 60,
		topicPack: "everyday",
		completedTurnCount: 2,
		finishedGameCount: 0,
		totalScore: 125,
		lastTurnSpokenSeconds: 40,
		analyticsMetric: "turn_completed",
		analyticsValue: 40,
	});
	assert.equal(
		await hashRoomMilestonePayloadV1(payloadJson),
		"a15541225dcdd41ac937e333440434c3235e2f8be0a35a2f2e1353b9aae5aeb8",
	);
});

test("rejects non-canonical, malformed, inconsistent, or expanded milestone payloads", () => {
	const payloadJson = delivery().payloadJson;
	const tuple = JSON.parse(payloadJson) as unknown[];
	const alternateNumericEncoding = payloadJson.replace(',1,"setup"', ',1.0,"setup"');
	assert.notEqual(alternateNumericEncoding, payloadJson);
	for (const invalidPayload of [
		` ${payloadJson}`,
		`${payloadJson}\n`,
		alternateNumericEncoding,
		changedTuple(payloadJson, 0, "nonstoptalk-room-milestone:v2"),
		changedTuple(payloadJson, 1, "B".repeat(64)),
		changedTuple(payloadJson, 2, "snapshot"),
		changedTuple(payloadJson, 3, "2026-09-01T24:00:00.000Z"),
		changedTuple(payloadJson, 5, "playing"),
		changedTuple(payloadJson, 7, 2),
		changedTuple(payloadJson, 15, "room_joined"),
		changedTuple(payloadJson, 16, 1),
		JSON.stringify(tuple.slice(0, -1)),
		JSON.stringify([...tuple, "extra"]),
	]) {
		expectInvalid(() => decodeRoomMilestonePayloadV1(invalidPayload));
	}

	expectInvalid(() => normalizeRoomMilestoneDeliveryV1({
		...delivery(),
		extra: "not allowed",
	}));
	expectInvalid(() => normalizeRoomMilestoneDeliveryV1({
		eventId: "A".repeat(64),
		payloadJson,
	}));
});

test("rejects short or nonhex identifiers and enforces the payload byte ceiling", () => {
	const payloadJson = delivery().payloadJson;
	for (const eventId of ["a".repeat(63), "g".repeat(64), 123]) {
		expectInvalid(() => normalizeRoomMilestoneDeliveryV1({ eventId, payloadJson }));
	}
	for (const roomInstanceId of ["b".repeat(63), "z".repeat(64)]) {
		expectInvalid(() => decodeRoomMilestonePayloadV1(changedTuple(payloadJson, 1, roomInstanceId)));
		expectInvalid(() => encodeRoomMilestonePayloadV1(roomInstanceId, roomFact()));
	}
	expectPlatformError(
		() => decodeRoomMilestonePayloadV1("x".repeat(1_025)),
		"PAYLOAD_TOO_LARGE",
	);
	expectInvalid(() => encodeRoomMilestonePayloadV1(ROOM_INSTANCE_ID, {
		...roomFact(),
		milestone: "unknown-runtime-milestone",
	} as unknown as PublicRoomFactDraft));
});

test("enforces numeric types, inclusive bounds, and milestone/count invariants", () => {
	const payloadJson = delivery().payloadJson;
	const invalidNumericFields: Array<[index: number, value: unknown]> = [
		[4, 0],
		[4, 1.5],
		[4, Number.MAX_SAFE_INTEGER + 1],
		[4, "1"],
		[6, -1],
		[6, 13],
		[6, 1.5],
		[7, -1],
		[8, 0],
		[8, 11],
		[9, 9],
		[9, 301],
		[11, -1],
		[11, 1_201],
		[12, -1],
		[12, 22],
		[13, -1],
		[13, 12_000_001],
		[14, -0.1],
		[14, 301],
		[14, "0"],
	];
	for (const [index, value] of invalidNumericFields) {
		expectInvalid(() => decodeRoomMilestonePayloadV1(changedTuple(payloadJson, index, value)));
	}

	const gameStarted = delivery(roomFact({
		milestone: "game-started",
		phase: "playing",
	})).payloadJson;
	const gameFinished = delivery(roomFact({
		milestone: "game-finished",
		phase: "finished",
		completedTurnCount: 1,
		finishedGameCount: 1,
	})).payloadJson;
	const reset = delivery(roomFact({ milestone: "reset", stateVersion: 2 })).payloadJson;
	for (const impossible of [
		changedTuple(payloadJson, 11, 1),
		changedTuple(payloadJson, 14, 1),
		changedTuple(gameStarted, 11, 1),
		changedTuple(gameFinished, 12, 0),
		changedTuple(reset, 13, 1),
	]) {
		expectInvalid(() => decodeRoomMilestonePayloadV1(impossible));
	}

	const upperBoundary = delivery(roomFact({
		stateVersion: Number.MAX_SAFE_INTEGER,
		milestone: "turn-completed",
		phase: "finished",
		playerCount: 12,
		onlinePlayerCount: 12,
		configuredRounds: 10,
		turnDurationSeconds: 300,
		completedTurnCount: 1_200,
		finishedGameCount: 21,
		totalScore: 12_000_000,
		lastTurnSpokenSeconds: 300,
	})).payloadJson;
	assert.equal(decodeRoomMilestonePayloadV1(upperBoundary).stateVersion, Number.MAX_SAFE_INTEGER);
});

test("prepares one exact-schema receipt transaction and emits Analytics Engine only after first apply", async () => {
	const item = delivery();
	const payloadHash = await hashRoomMilestonePayloadV1(item.payloadJson);
	const database = new FakeReceiverD1(6, [
		fakeResult(1),
		fakeResult(0),
		fakeResult(1),
		fakeResult(1),
		fakeResult(0, [{
			payload_hash: payloadHash,
			applied_at: RECEIVED_AT.toISOString(),
			expires_at: "2026-11-30T12:00:00.000Z",
		}]),
	]);
	const points: AnalyticsEngineDataPoint[] = [];

	assert.deepEqual(await receiveRoomMilestone({
		PLATFORM_DB: database as unknown as D1Database,
		PRODUCT_ANALYTICS: {
			writeDataPoint(point: AnalyticsEngineDataPoint): void {
				points.push(point);
			},
		} as AnalyticsEngineDataset,
	}, item, RECEIVED_AT), { outcome: "applied" });

	assert.equal(database.batchCalls, 1);
	assert.equal(database.batchStatements.length, 5);
	assert.match(database.batchStatements[0]?.query ?? "", /INSERT INTO room_milestone_receipts/u);
	assert.match(database.batchStatements[1]?.query ?? "", /INSERT INTO room_facts/u);
	assert.match(database.batchStatements[2]?.query ?? "", /INSERT INTO analytics_daily/u);
	assert.match(database.batchStatements[3]?.query ?? "", /UPDATE room_milestone_receipts/u);
	assert.match(database.batchStatements[4]?.query ?? "", /SELECT payload_hash, applied_at, expires_at/u);
	for (const statement of database.batchStatements) {
		assert.match(statement.query, /schema_version = 6/u);
	}
	const serializedBindings = JSON.stringify(database.batchStatements.map((statement) => statement.bindings));
	assert.equal(serializedBindings.includes(ROOM_INSTANCE_ID), false, "raw room instance ID reached D1 bindings");
	assert.equal(serializedBindings.includes(item.payloadJson), false, "canonical payload reached D1 bindings");
	assert.equal(database.batchStatements[1]?.bindings[0], null, "an absent key did not disable only the fact branch");
	assert.deepEqual(points, [{
		indexes: ["event:room_created"],
		blobs: ["room_created", "v1", "cloudflare"],
		doubles: [1, 0],
	}]);
});

test("classifies duplicate, conflict, and impossible receipt states without Analytics Engine replay", async (t) => {
	const item = delivery();
	const payloadHash = await hashRoomMilestonePayloadV1(item.payloadJson);
	for (const scenario of [
		{
			name: "duplicate",
			inserted: 0,
			applied: 0,
			storedHash: payloadHash,
			appliedAt: RECEIVED_AT.toISOString(),
			expected: "duplicate",
		},
		{
			name: "conflict",
			inserted: 0,
			applied: 0,
			storedHash: "f".repeat(64),
			appliedAt: RECEIVED_AT.toISOString(),
			expected: "conflict",
		},
		{
			name: "pending invariant",
			inserted: 0,
			applied: 0,
			storedHash: payloadHash,
			appliedAt: null,
			expected: "invariant",
		},
		{
			name: "an uninserted receipt cannot be applied by this attempt",
			inserted: 0,
			applied: 1,
			storedHash: payloadHash,
			appliedAt: RECEIVED_AT.toISOString(),
			expected: "invariant",
		},
		{
			name: "a newly inserted receipt must be applied atomically",
			inserted: 1,
			applied: 0,
			storedHash: payloadHash,
			appliedAt: null,
			expected: "invariant",
		},
	] as const) {
		await t.test(scenario.name, async () => {
			const database = new FakeReceiverD1(6, [
				fakeResult(scenario.inserted),
				fakeResult(0),
				fakeResult(0),
				fakeResult(scenario.applied),
				fakeResult(0, [{
					payload_hash: scenario.storedHash,
					applied_at: scenario.appliedAt,
					expires_at: "2026-11-30T12:00:00.000Z",
				}]),
			]);
			let analyticsWrites = 0;
			const result = await receiveRoomMilestone({
				PLATFORM_DB: database as unknown as D1Database,
				PRODUCT_ANALYTICS: {
					writeDataPoint: () => { analyticsWrites += 1; },
				} as unknown as AnalyticsEngineDataset,
			}, item, RECEIVED_AT);
			assert.deepEqual(result, { outcome: scenario.expected });
			assert.equal(analyticsWrites, 0);
		});
	}
});

test("schema 5 performs no receiver batch and D1 failures remain retryable errors", async () => {
	const schemaFive = new FakeReceiverD1(5);
	assert.deepEqual(await receiveRoomMilestone(
		{ PLATFORM_DB: schemaFive as unknown as D1Database },
		delivery(),
		RECEIVED_AT,
	), { outcome: "invariant" });
	assert.equal(schemaFive.batchCalls, 0);

	const failed = new FakeReceiverD1(6);
	failed.failBatch = true;
	await assert.rejects(
		receiveRoomMilestone(
			{ PLATFORM_DB: failed as unknown as D1Database },
			delivery(),
			RECEIVED_AT,
		),
		(error: unknown) => error instanceof PlatformError
			&& error.code === "DATABASE_UNAVAILABLE"
			&& error.status === 503,
	);
});

test("rejects a canonical occurrence time whose 90-day fact expiry leaves the supported year range", async () => {
	const database = new FakeReceiverD1(6);
	const item = delivery(roomFact({
		observedAt: "9999-12-31T23:59:59.999Z",
	}));
	await assert.rejects(
		receiveRoomMilestone(
			{ PLATFORM_DB: database as unknown as D1Database },
			item,
			RECEIVED_AT,
		),
		(error: unknown) => error instanceof PlatformError && error.code === "INVALID_INPUT",
	);
	assert.equal(database.batchCalls, 0);
});

test("rejects a receipt time whose 90-day expiry leaves the supported year range", async () => {
	const database = new FakeReceiverD1(6);
	await assert.rejects(
		receiveRoomMilestone(
			{ PLATFORM_DB: database as unknown as D1Database },
			delivery(),
			new Date("9999-12-31T23:59:59.999Z"),
		),
		(error: unknown) => error instanceof PlatformError && error.code === "INVALID_INPUT",
	);
	assert.equal(database.statements.length, 0);
	assert.equal(database.batchCalls, 0);
});

test("a synchronous Analytics Engine failure cannot undo an applied D1 receipt", async (t) => {
	const item = delivery();
	const payloadHash = await hashRoomMilestonePayloadV1(item.payloadJson);
	const database = new FakeReceiverD1(6, [
		fakeResult(1), fakeResult(1), fakeResult(1), fakeResult(1),
		fakeResult(0, [{
			payload_hash: payloadHash,
			applied_at: RECEIVED_AT.toISOString(),
			expires_at: "2026-11-30T12:00:00.000Z",
		}]),
	]);
	const warnings: unknown[] = [];
	t.mock.method(console, "warn", (value: unknown) => warnings.push(value));

	assert.deepEqual(await receiveRoomMilestone({
		PLATFORM_DB: database as unknown as D1Database,
		PRODUCT_ANALYTICS: {
			writeDataPoint: () => { throw new Error("synthetic AE outage"); },
		} as unknown as AnalyticsEngineDataset,
	}, item, RECEIVED_AT), { outcome: "applied" });
	assert.deepEqual(
		warnings.map((warning) => (warning as { event?: unknown }).event),
		["analytics_engine_write_failed"],
	);
});
