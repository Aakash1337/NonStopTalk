import assert from "node:assert/strict";
import {
	DatabaseSync,
	type SQLInputValue,
	type StatementResultingChanges,
} from "node:sqlite";
import test from "node:test";

import type { PublicRoomFactDraft } from "./platform.ts";
import { decodeRoomMilestonePayloadV1 } from "./room-milestone-contract.ts";
import {
	ROOM_MILESTONE_DEAD_LETTER_CAPACITY,
	ROOM_MILESTONE_DEAD_LETTER_RETENTION_MS,
	ROOM_MILESTONE_DROP_COUNT_MAX,
	ROOM_MILESTONE_MAX_ATTEMPTS,
	ROOM_MILESTONE_OUTBOX_CAPACITY,
	ROOM_MILESTONE_OUTBOX_DEADLINE_MS,
	acknowledgeRoomMilestone,
	deadLetterExpiredRoomMilestone,
	deadLetterRoomMilestone,
	enqueueRoomMilestones,
	initializeRoomMilestoneOutbox,
	purgeExpiredRoomMilestoneDeadLetters,
	readNextRoomMilestoneAlarmAt,
	readRoomMilestoneOutboxHead,
	readRoomMilestoneOutboxMetadata,
	recordRoomMilestoneRetry,
	roomMilestoneRetryDelayMs,
	type RoomMilestoneRandomBytes,
} from "./room-milestone-outbox.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

class TestCursor<Row extends Record<string, SqlStorageValue>> {
	readonly rowsWritten: number;
	readonly #rows: Row[];

	constructor(rows: Row[], rowsWritten: number) {
		this.#rows = rows;
		this.rowsWritten = rowsWritten;
	}

	toArray(): Row[] {
		return [...this.#rows];
	}
}

class TestSqlStorage {
	readonly database = new DatabaseSync(":memory:");

	exec<Row extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: SqlStorageValue[]
	): SqlStorageCursor<Row> {
		const nodeBindings = bindings.map(nodeSqlValue);
		const statement = query.trimStart().slice(0, 12).toUpperCase();
		if (!bindings.length && (statement.startsWith("CREATE TABLE") || statement.startsWith("CREATE INDEX"))) {
			this.database.exec(query);
			return new TestCursor<Row>([], 0) as unknown as SqlStorageCursor<Row>;
		}
		const prepared = this.database.prepare(query);
		if (statement.startsWith("SELECT") || /\bRETURNING\b/iu.test(query)) {
			const rows = prepared.all(...nodeBindings) as Row[];
			const changes = /\bRETURNING\b/iu.test(query)
				? Number((this.database.prepare("SELECT changes() AS changes").get() as { changes: number }).changes)
				: 0;
			return new TestCursor(rows, changes) as unknown as SqlStorageCursor<Row>;
		}
		const result = prepared.run(...nodeBindings) as StatementResultingChanges;
		return new TestCursor<Row>([], Number(result.changes)) as unknown as SqlStorageCursor<Row>;
	}

	transaction<T>(operation: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const value = operation();
			this.database.exec("COMMIT");
			return value;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	rows<Row extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): Row[] {
		return this.database.prepare(query).all(...bindings.map(nodeSqlValue)) as Row[];
	}
}

function nodeSqlValue(value: SqlStorageValue): SQLInputValue {
	return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function sqlStorage(testStorage: TestSqlStorage): SqlStorage {
	return testStorage as unknown as SqlStorage;
}

function sequentialRandom(start = 1): RoomMilestoneRandomBytes {
	let value = start;
	return (bytes) => {
		bytes.fill(0);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		view.setUint32(0, value);
		value += 1;
	};
}

function fact(overrides: Partial<PublicRoomFactDraft> = {}): PublicRoomFactDraft {
	return {
		roomCode: "ABC234",
		stateVersion: 1,
		observedAt: "2026-09-01T12:00:00.000Z",
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

function initialize(storage: TestSqlStorage, random = sequentialRandom()): void {
	initializeRoomMilestoneOutbox(sqlStorage(storage), random);
}

test("migrates legacy room_state without rewriting it and keeps one stable random room identity", () => {
	const storage = new TestSqlStorage();
	storage.database.exec(`CREATE TABLE room_state (
		id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL
	)`);
	const legacyJson = JSON.stringify({ code: "ABC234", version: 17, private: "preserve-verbatim" });
	storage.database.prepare("INSERT INTO room_state (id, json) VALUES (1, ?)").run(legacyJson);

	const first = initializeRoomMilestoneOutbox(sqlStorage(storage), sequentialRandom(7));
	const second = initializeRoomMilestoneOutbox(sqlStorage(storage), sequentialRandom(99));

	assert.match(first.roomInstanceId, /^[0-9a-f]{64}$/u);
	assert.equal(second.roomInstanceId, first.roomInstanceId);
	assert.equal(storage.rows<{ json: string }>("SELECT json FROM room_state WHERE id = 1")[0]?.json, legacyJson);
	assert.equal(storage.rows<{ count: number }>("SELECT COUNT(*) AS count FROM room_milestone_outbox")[0]?.count, 0);
	assert.deepEqual(first, {
		roomInstanceId: first.roomInstanceId,
		droppedTotal: 0,
		droppedCapacity: 0,
		droppedCanonicalization: 0,
		lastDropReason: null,
		lastDroppedAtMs: null,
	});

	const schema = storage.rows<{ sql: string }>(
		"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'room_milestone_outbox'",
	)[0]?.sql ?? "";
	assert.match(schema, /json_valid\(payload_json\)/u);
	assert.match(schema, /attempt_count BETWEEN 0 AND 16/u);
	assert.match(schema, /deadline_at_ms = created_at_ms \+ 604800000/u);
});

test("enqueues canonical privacy-minimal events in strict FIFO order and conditionally acknowledges", () => {
	const storage = new TestSqlStorage();
	const random = sequentialRandom();
	initialize(storage, random);
	const unsafeCreated = {
		...fact(),
		playerName: "Private Alice",
		topic: "Private subject",
		memberToken: "private-token",
	};
	const result = enqueueRoomMilestones(sqlStorage(storage), [
		unsafeCreated,
		fact({ milestone: "joined", stateVersion: 2, playerCount: 2, onlinePlayerCount: 2 }),
	], NOW, random);
	assert.equal(result.outcome, "queued");
	if (result.outcome !== "queued") return;
	assert.deepEqual(result.events.map(({ sequence, milestone }) => ({ sequence, milestone })), [
		{ sequence: 1, milestone: "created" },
		{ sequence: 2, milestone: "joined" },
	]);
	assert.notEqual(result.events[0]?.eventId, result.events[1]?.eventId);
	for (const event of result.events) {
		assert.match(event.eventId, /^[0-9a-f]{64}$/u);
		for (const secret of ["ABC234", "Private Alice", "Private subject", "private-token"]) {
			assert.equal(event.payloadJson.includes(secret), false);
		}
		assert.equal(
			decodeRoomMilestonePayloadV1(event.payloadJson).roomInstanceId,
			readRoomMilestoneOutboxMetadata(sqlStorage(storage)).roomInstanceId,
		);
	}

	const head = readRoomMilestoneOutboxHead(sqlStorage(storage));
	assert.ok(head);
	assert.equal(head.milestone, "created");
	assert.equal(head.deadlineAtMs, NOW + ROOM_MILESTONE_OUTBOX_DEADLINE_MS);
	assert.equal(readNextRoomMilestoneAlarmAt(sqlStorage(storage)), NOW);
	assert.equal(acknowledgeRoomMilestone(sqlStorage(storage), { ...head, attemptCount: 1 }), false);
	assert.equal(acknowledgeRoomMilestone(sqlStorage(storage), head), true);
	assert.equal(readRoomMilestoneOutboxHead(sqlStorage(storage))?.milestone, "joined");
});

test("drops an invalid all-or-drop batch and an over-capacity batch while bounding telemetry", () => {
	const storage = new TestSqlStorage();
	const random = sequentialRandom();
	initialize(storage, random);
	const invalid = fact({ milestone: "game-finished", phase: "finished", completedTurnCount: 0 });
	const canonicalization = storage.transaction(() => enqueueRoomMilestones(
		sqlStorage(storage),
		[fact(), invalid],
		NOW,
		random,
	));
	assert.deepEqual(canonicalization, {
		outcome: "dropped",
		reason: "canonicalization",
		droppedCount: 2,
	});
	assert.equal(storage.rows<{ count: number }>("SELECT COUNT(*) AS count FROM room_milestone_outbox")[0]?.count, 0);

	const filled = storage.transaction(() => enqueueRoomMilestones(
		sqlStorage(storage),
		Array.from({ length: ROOM_MILESTONE_OUTBOX_CAPACITY - 1 }, () => fact()),
		NOW,
		random,
	));
	assert.equal(filled.outcome, "queued");
	const capacity = storage.transaction(() => enqueueRoomMilestones(
		sqlStorage(storage),
		[fact(), fact()],
		NOW,
		random,
	));
	assert.deepEqual(capacity, { outcome: "dropped", reason: "capacity", droppedCount: 2 });
	assert.equal(storage.rows<{ count: number }>("SELECT COUNT(*) AS count FROM room_milestone_outbox")[0]?.count, 255);
	assert.deepEqual(readRoomMilestoneOutboxMetadata(sqlStorage(storage)), {
		roomInstanceId: readRoomMilestoneOutboxMetadata(sqlStorage(storage)).roomInstanceId,
		droppedTotal: 4,
		droppedCapacity: 2,
		droppedCanonicalization: 2,
		lastDropReason: "capacity",
		lastDroppedAtMs: NOW,
	});

	storage.database.prepare(`UPDATE room_milestone_meta
		SET dropped_total = ?, dropped_capacity = ? WHERE id = 1`).run(
		ROOM_MILESTONE_DROP_COUNT_MAX,
		ROOM_MILESTONE_DROP_COUNT_MAX,
	);
	enqueueRoomMilestones(sqlStorage(storage), [fact(), fact()], NOW + 1, random);
	assert.equal(readRoomMilestoneOutboxMetadata(sqlStorage(storage)).droppedTotal, ROOM_MILESTONE_DROP_COUNT_MAX);
});

test("uses deterministic bounded retry tiers, stale guards, the deadline, and the attempt ceiling", () => {
	const bases = [5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000, 86_400_000];
	const eventId = "a".repeat(64);
	for (const [index, base] of bases.entries()) {
		const attempt = index + 1;
		const delay = roomMilestoneRetryDelayMs(eventId, attempt);
		assert.equal(delay, roomMilestoneRetryDelayMs(eventId, attempt));
		assert.ok(delay >= Math.floor(base * 0.8));
		assert.ok(delay <= Math.floor(base * 1.2));
	}

	const storage = new TestSqlStorage();
	const random = sequentialRandom();
	initialize(storage, random);
	enqueueRoomMilestones(sqlStorage(storage), [fact()], NOW, random);
	const original = readRoomMilestoneOutboxHead(sqlStorage(storage));
	assert.ok(original);
	const first = recordRoomMilestoneRetry(
		sqlStorage(storage), original, "database-unavailable", NOW + 1,
	);
	assert.equal(first.outcome, "retry");
	assert.deepEqual(
		recordRoomMilestoneRetry(sqlStorage(storage), original, "database-unavailable", NOW + 2),
		{ outcome: "stale" },
	);

	let head = readRoomMilestoneOutboxHead(sqlStorage(storage));
	assert.ok(head);
	while (head.attemptCount < ROOM_MILESTONE_MAX_ATTEMPTS - 1) {
		const retry = recordRoomMilestoneRetry(
			sqlStorage(storage), head, "receiver-invariant", NOW + 10,
		);
		if (retry.outcome === "dead-lettered") break;
		assert.equal(retry.outcome, "retry");
		head = readRoomMilestoneOutboxHead(sqlStorage(storage));
		assert.ok(head);
	}
	const exhausted = recordRoomMilestoneRetry(
		sqlStorage(storage), head, "local-finalization-failed", NOW + 11,
	);
	assert.deepEqual(exhausted, { outcome: "dead-lettered", reason: "attempts-exhausted" });
	assert.equal(readRoomMilestoneOutboxHead(sqlStorage(storage)), null);
	assert.deepEqual(storage.rows<{ reason: string; attempt_count: number }>(
		"SELECT reason, attempt_count FROM room_milestone_dead_letters",
	).map((row) => ({ ...row })), [{
		reason: "attempts-exhausted",
		attempt_count: ROOM_MILESTONE_MAX_ATTEMPTS,
	}]);

	enqueueRoomMilestones(sqlStorage(storage), [fact()], NOW, random);
	const expiring = readRoomMilestoneOutboxHead(sqlStorage(storage));
	assert.ok(expiring);
	assert.equal(deadLetterExpiredRoomMilestone(sqlStorage(storage), expiring, expiring.deadlineAtMs - 1), false);
	assert.equal(deadLetterExpiredRoomMilestone(sqlStorage(storage), expiring, expiring.deadlineAtMs), true);
});

test("reads corrupt canonical bytes so integration can scrub them into a capped, expiring dead letter", () => {
	const storage = new TestSqlStorage();
	const random = sequentialRandom();
	initialize(storage, random);
	enqueueRoomMilestones(sqlStorage(storage), [fact()], NOW, random);
	storage.database.prepare("UPDATE room_milestone_outbox SET payload_json = '{}' WHERE sequence = 1").run();

	const corrupt = readRoomMilestoneOutboxHead(sqlStorage(storage));
	assert.ok(corrupt);
	assert.equal(corrupt.payloadJson, "{}");
	assert.equal(deadLetterRoomMilestone(sqlStorage(storage), corrupt, "invalid-payload", NOW + 1), true);
	assert.equal(readRoomMilestoneOutboxHead(sqlStorage(storage)), null);
	const columns = storage.rows<{ name: string }>("PRAGMA table_info(room_milestone_dead_letters)")
		.map(({ name }) => name);
	assert.equal(columns.includes("event_id"), false);
	assert.equal(columns.includes("payload_json"), false);
	assert.equal(columns.includes("room_instance_id"), false);

	for (let index = 0; index <= ROOM_MILESTONE_DEAD_LETTER_CAPACITY; index += 1) {
		enqueueRoomMilestones(sqlStorage(storage), [fact()], NOW + index + 2, random);
		const head = readRoomMilestoneOutboxHead(sqlStorage(storage));
		assert.ok(head);
		assert.equal(deadLetterRoomMilestone(
			sqlStorage(storage), head, "conflict", NOW + index + 2,
		), true);
	}
	assert.equal(storage.rows<{ count: number }>(
		"SELECT COUNT(*) AS count FROM room_milestone_dead_letters",
	)[0]?.count, ROOM_MILESTONE_DEAD_LETTER_CAPACITY);
	assert.equal(
		readNextRoomMilestoneAlarmAt(sqlStorage(storage)),
		NOW + 3 + ROOM_MILESTONE_DEAD_LETTER_RETENTION_MS,
	);
	assert.equal(purgeExpiredRoomMilestoneDeadLetters(
		sqlStorage(storage),
		NOW + ROOM_MILESTONE_DEAD_LETTER_RETENTION_MS + ROOM_MILESTONE_DEAD_LETTER_CAPACITY + 2,
		64,
	), 64);
	assert.equal(storage.rows<{ count: number }>(
		"SELECT COUNT(*) AS count FROM room_milestone_dead_letters",
	)[0]?.count, ROOM_MILESTONE_DEAD_LETTER_CAPACITY - 64);
});

test("strong SQLite checks reject malformed direct writes and storage failures still throw", () => {
	const storage = new TestSqlStorage();
	initialize(storage);
	assert.throws(() => storage.database.prepare(`INSERT INTO room_milestone_outbox (
		event_id, payload_json, milestone, created_at_ms, deadline_at_ms,
		attempt_count, next_attempt_at_ms, last_failure
	) VALUES (?, '{}', 'created', ?, ?, 0, ?, NULL)`).run(
		"A".repeat(64),
		NOW,
		NOW + ROOM_MILESTONE_OUTBOX_DEADLINE_MS,
		NOW,
	));
	assert.throws(() => storage.database.prepare(`INSERT INTO room_milestone_dead_letters (
		reason, milestone, attempt_count, failed_at_ms, purge_at_ms
	) VALUES ('unbounded-reason', 'created', 0, ?, ?)`).run(
		NOW,
		NOW + ROOM_MILESTONE_DEAD_LETTER_RETENTION_MS,
	));

	storage.database.exec(`CREATE TRIGGER fail_outbox_insert
		BEFORE INSERT ON room_milestone_outbox
		BEGIN SELECT RAISE(ABORT, 'synthetic local storage failure'); END`);
	assert.throws(
		() => enqueueRoomMilestones(sqlStorage(storage), [fact()], NOW, sequentialRandom(50)),
		/synthetic local storage failure/u,
	);
});
