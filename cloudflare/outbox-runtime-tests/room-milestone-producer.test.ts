import { env } from "cloudflare:workers";
import {
	createExecutionContext,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRoomState, publicRoomState, type RoomState } from "../game";
import { mapPublicRoomStateToFact } from "../platform";
import {
	enqueueRoomMilestones,
	initializeRoomMilestoneOutbox,
	readRoomMilestoneOutboxHead,
	readRoomMilestoneOutboxMetadata,
	type RoomMilestoneRandomBytes,
} from "../room-milestone-outbox";
import worker, { RoomDurableObject } from "../worker";

const HOST_TOKEN = "a".repeat(64);
const GUEST_TOKEN = "b".repeat(64);
const THIRD_TOKEN = "c".repeat(64);
const ROOM_MILESTONES_HEADER = "X-NonStopTalk-Room-Milestones";
const ROOM_MILESTONE_OUTBOX_V1_SENTINEL = ",";

interface LocalOutboxRow {
	[key: string]: SqlStorageValue;
	sequence: number;
	event_id: string;
	milestone: string;
	payload_json: string;
	attempt_count: number;
	next_attempt_at_ms: number;
	last_failure: string | null;
}

interface ReplayCapture {
	roomInstanceId: string;
	eventIds: string[];
}

function roomStub(code: string): DurableObjectStub<RoomDurableObject> {
	return env.ROOMS.get(env.ROOMS.idFromName(code));
}

function roomRequest(pathname: string, token: string, body?: unknown): Request {
	const headers = new Headers({ "X-NonStopTalk-Token": token });
	const init: RequestInit = { method: body === undefined ? "GET" : "POST", headers };
	if (body !== undefined) {
		headers.set("Content-Type", "application/json");
		init.body = JSON.stringify(body);
	}
	return new Request(`https://room.internal${pathname}`, init);
}

async function postRoom(
	stub: DurableObjectStub<RoomDurableObject>,
	pathname: string,
	token: string,
	body: unknown,
): Promise<{ response: Response; room: RoomState }> {
	const response = await stub.fetch(roomRequest(pathname, token, body));
	expect(response.ok, await response.clone().text()).toBe(true);
	const payload = await response.json<{ room: RoomState }>();
	return { response, room: payload.room };
}

async function createRoom(
	stub: DurableObjectStub<RoomDurableObject>,
	code: string,
): Promise<{ response: Response; room: RoomState }> {
	return postRoom(stub, "/create", HOST_TOKEN, { code, name: "Outbox Host" });
}

async function action(
	stub: DurableObjectStub<RoomDurableObject>,
	body: Record<string, unknown>,
): Promise<{ response: Response; room: RoomState }> {
	return postRoom(stub, "/action", HOST_TOKEN, body);
}

async function localSnapshot(stub: DurableObjectStub<RoomDurableObject>): Promise<{
	room: RoomState | null;
	rows: LocalOutboxRow[];
	roomInstanceId: string | null;
	droppedCapacity: number;
	droppedCanonicalization: number;
	alarm: number | null;
}> {
	return runInDurableObject(stub, async (_instance, state) => {
		const roomRow = state.storage.sql.exec<{ json: string }>(
			"SELECT json FROM room_state WHERE id = 1",
		).toArray()[0];
		const metaTable = state.storage.sql.exec<{ present: number }>(
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'room_milestone_meta'",
		).toArray()[0];
		const metadata = metaTable
			? readRoomMilestoneOutboxMetadata(state.storage.sql)
			: null;
		return {
			room: roomRow ? JSON.parse(roomRow.json) as RoomState : null,
			rows: metaTable
				? state.storage.sql.exec<LocalOutboxRow>(`SELECT
					sequence, event_id, milestone, payload_json,
					attempt_count, next_attempt_at_ms, last_failure
					FROM room_milestone_outbox ORDER BY sequence`).toArray()
				: [],
			roomInstanceId: metadata?.roomInstanceId ?? null,
			droppedCapacity: metadata?.droppedCapacity ?? 0,
			droppedCanonicalization: metadata?.droppedCanonicalization ?? 0,
			alarm: await state.storage.getAlarm(),
		};
	});
}

async function prepareFinalTurn(
	stub: DurableObjectStub<RoomDurableObject>,
	code: string,
): Promise<RoomState> {
	await createRoom(stub, code);
	await postRoom(stub, "/join", GUEST_TOKEN, { name: "Outbox Guest" });
	await action(stub, { type: "start-game" });
	const first = await action(stub, { type: "start-turn", afterTurnId: "" });
	const firstTurnId = first.room.activeTurn?.id;
	if (!firstTurnId) throw new Error("Expected the first active turn.");
	await action(stub, {
		type: "submit-turn",
		turnId: firstTurnId,
		spokenSeconds: 1,
	});
	const second = await action(stub, { type: "start-turn", afterTurnId: firstTurnId });
	if (!second.room.activeTurn?.id) throw new Error("Expected the final active turn.");
	return second.room;
}

function deterministicEventIds(): RoomMilestoneRandomBytes {
	let sequence = 0;
	return (bytes) => {
		sequence += 1;
		bytes.fill(0);
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			.setUint32(bytes.byteLength - 4, sequence);
	};
}

function workerLogRecords(calls: unknown[][]): Record<string, unknown>[] {
	return calls.flatMap((call) => {
		const value = call[0];
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? [value as Record<string, unknown>]
			: [];
	});
}

async function replayNextTransactionOnce(
	stub: DurableObjectStub<RoomDurableObject>,
): Promise<{ captures: ReplayCapture[]; restore: () => void }> {
	const captures: ReplayCapture[] = [];
	let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
	await runInDurableObject(stub, (_instance, state) => {
		const original = state.storage.transaction.bind(state.storage);
		transactionSpy = vi.spyOn(state.storage, "transaction");
		const replayingTransaction: DurableObjectStorage["transaction"] = async (closure) => {
			let captured = false;
			try {
				await original(async (transaction) => {
					await closure(transaction);
					captures.push({
						roomInstanceId: readRoomMilestoneOutboxMetadata(state.storage.sql).roomInstanceId,
						eventIds: state.storage.sql.exec<{ event_id: string }>(
							"SELECT event_id FROM room_milestone_outbox ORDER BY sequence",
						).toArray().map(({ event_id }) => event_id),
					});
					captured = true;
					transaction.rollback();
				});
			} catch (error) {
				if (!captured) throw error;
			}
			return original(closure);
		};
		transactionSpy.mockImplementation(replayingTransaction);
	});
	return {
		captures,
		restore: () => transactionSpy?.mockRestore(),
	};
}

async function replaceQueueWith(
	stub: DurableObjectStub<RoomDurableObject>,
	count: number,
): Promise<void> {
	await runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec("DELETE FROM room_milestone_outbox");
		const row = state.storage.sql.exec<{ json: string }>(
			"SELECT json FROM room_state WHERE id = 1",
		).one();
		const room = JSON.parse(row.json) as RoomState;
		const now = Date.now();
		const fact = mapPublicRoomStateToFact(
			publicRoomState(room, HOST_TOKEN, new Set(), now),
			"turn-completed",
			new Date(now),
		);
		const result = enqueueRoomMilestones(
			state.storage.sql,
			Array.from({ length: count }, () => fact),
			now,
			deterministicEventIds(),
		);
		if (result.outcome !== "queued") throw new Error("Could not seed the producer capacity test.");
	});
}

async function scalar(sql: string): Promise<number> {
	const row = await env.PLATFORM_DB.prepare(sql).first<{ value: number }>();
	return Number(row?.value ?? 0);
}

beforeEach(async () => {
	await env.PLATFORM_DB.batch([
		env.PLATFORM_DB.prepare("DELETE FROM room_milestone_receipts"),
		env.PLATFORM_DB.prepare("DELETE FROM room_facts"),
		env.PLATFORM_DB.prepare("DELETE FROM analytics_daily"),
		env.PLATFORM_DB.prepare("UPDATE platform_meta SET schema_version = 6 WHERE id = 1"),
	]);
});

describe("durable outbox runtime configuration", () => {
	it("provides the exact outbox opt-in binding", () => {
		const bindings = env as unknown as Record<string, unknown>;
		expect(bindings.ROOM_MILESTONE_DELIVERY_MODE).toBe("outbox");
	});
});

describe("atomic normal-room outbox producer", () => {
	it("uses only the durable path through the real outer Worker and room object", async () => {
		const publicEnv = new Proxy(
			env as unknown as Parameters<typeof worker.fetch>[1],
			{
				get(target, property, receiver) {
					if (property === "ROOM_CREATION_RATE_LIMITER") {
						return { limit: async () => ({ success: true }) };
					}
					return Reflect.get(target, property, receiver);
				},
			},
		);
		const context = createExecutionContext();
		const response = await worker.fetch(new Request("https://example.test/api/rooms", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://example.test",
			},
			body: JSON.stringify({ name: "Public Host" }),
		}), publicEnv, context);
		await waitOnExecutionContext(context);
		expect(response.status, await response.clone().text()).toBe(201);
		expect(response.headers.get(ROOM_MILESTONES_HEADER)).toBeNull();
		const payload = await response.json<{ room: RoomState }>();
		const stub = roomStub(payload.room.code);

		expect((await localSnapshot(stub)).rows.map((row) => row.milestone)).toEqual(["created"]);
		expect(await scalar("SELECT COUNT(*) AS value FROM analytics_daily")).toBe(0);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await localSnapshot(stub)).rows).toEqual([]);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(1);
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(1);
	});

	it("keeps durable ownership when a best-effort outer Worker reaches an outbox room version", async () => {
		const publicEnv = new Proxy(
			env as unknown as Parameters<typeof worker.fetch>[1],
			{
				get(target, property, receiver) {
					if (property === "ROOM_CREATION_RATE_LIMITER") {
						return { limit: async () => ({ success: true }) };
					}
					if (property === "ROOM_MILESTONE_DELIVERY_MODE") return "best-effort";
					return Reflect.get(target, property, receiver);
				},
			},
		);
		const context = createExecutionContext();
		const response = await worker.fetch(new Request("https://example.test/api/rooms", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://example.test",
			},
			body: JSON.stringify({ name: "Version Skew Host" }),
		}), publicEnv, context);
		await waitOnExecutionContext(context);

		expect(response.status, await response.clone().text()).toBe(201);
		expect(response.headers.get(ROOM_MILESTONES_HEADER)).toBeNull();
		const payload = await response.json<{ room: RoomState }>();
		const stub = roomStub(payload.room.code);
		expect((await localSnapshot(stub)).rows.map((row) => row.milestone)).toEqual(["created"]);
		expect(await scalar("SELECT COUNT(*) AS value FROM analytics_daily")).toBe(0);

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await localSnapshot(stub)).rows).toEqual([]);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(1);
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(1);
	});

	it("creates one canonical local event with Release-A-compatible ownership and drains it exactly once", async () => {
		const stub = roomStub("PRDCR2");
		const { response, room } = await createRoom(stub, "PRDCR2");

		const encodedOwnership = response.headers.get(ROOM_MILESTONES_HEADER);
		expect(encodedOwnership).toBe(ROOM_MILESTONE_OUTBOX_V1_SENTINEL);
		// Release A split/trim/filtered this same header and therefore schedules no
		// legacy event before deleting it from the public response.
		expect(encodedOwnership?.split(",").map((value) => value.trim()).filter(Boolean)).toEqual([]);
		const releaseAHeaders = new Headers(response.headers);
		releaseAHeaders.delete(ROOM_MILESTONES_HEADER);
		expect(releaseAHeaders.has(ROOM_MILESTONES_HEADER)).toBe(false);
		const before = await localSnapshot(stub);
		expect(before.room?.version).toBe(room.version);
		expect(before.roomInstanceId).toMatch(/^[0-9a-f]{64}$/u);
		expect(before.rows.map((row) => row.milestone)).toEqual(["created"]);
		expect(before.rows[0]?.event_id).toMatch(/^[0-9a-f]{64}$/u);
		expect(before.alarm).not.toBeNull();
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(0);

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const after = await localSnapshot(stub);
		expect(after.rows).toEqual([]);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(1);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_facts")).toBe(1);
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(1);

		// The ACK removed the event; later room alarms cannot replay its receipt.
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(1);
	});

	it("persists a schema-5 retry and drains it after schema 6 returns", async () => {
		const stub = roomStub("RETRY2");
		await createRoom(stub, "RETRY2");
		await env.PLATFORM_DB.prepare("UPDATE platform_meta SET schema_version = 5 WHERE id = 1").run();

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const retrying = await localSnapshot(stub);
		expect(retrying.rows).toHaveLength(1);
		expect(retrying.rows[0]?.attempt_count).toBe(1);
		expect(retrying.rows[0]?.last_failure).toBe("receiver-invariant");
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(0);

		await env.PLATFORM_DB.prepare("UPDATE platform_meta SET schema_version = 6 WHERE id = 1").run();
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE room_milestone_outbox SET next_attempt_at_ms = ?",
				Date.now() - 1,
			);
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		expect((await localSnapshot(stub)).rows).toEqual([]);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(1);
	});

	it("emits one post-commit record for retry and stale compare-and-swap outcomes", async () => {
		const stub = roomStub("LAGR24");
		await createRoom(stub, "LAGR24");
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await runInDurableObject(stub, async (instance, state) => {
				const head = readRoomMilestoneOutboxHead(state.storage.sql);
				if (!head) throw new Error("Expected a queued milestone for the log contract test.");
				const finalize: unknown = Reflect.get(instance, "finalizeMilestoneRetry");
				if (typeof finalize !== "function") {
					throw new Error("The retry finalizer is unavailable for the log contract test.");
				}
				await Reflect.apply(finalize, instance, [
					head,
					"database-unavailable",
					Date.now(),
					"PlatformError",
				]);
				expect(readRoomMilestoneOutboxHead(state.storage.sql)?.attemptCount).toBe(1);
				await Reflect.apply(finalize, instance, [
					head,
					"database-unavailable",
					Date.now(),
					"PlatformError",
				]);
			});

			const records = workerLogRecords(warnings.mock.calls)
				.filter((record) => typeof record.event === "string"
					&& record.event.startsWith("room_milestone_outbox_"))
				.map(({ timestamp: _timestamp, ...record }) => record);
			expect(records).toEqual([
				{
					failure: "database-unavailable",
					attemptCount: 1,
					error: "PlatformError",
					level: "warn",
					event: "room_milestone_outbox_retry_scheduled",
				},
				{
					failure: "database-unavailable",
					error: "PlatformError",
					level: "warn",
					event: "room_milestone_outbox_retry_stale",
				},
			]);
			expect(records.some((record) => (
				record.event === "room_milestone_outbox_delivery_failed"
			))).toBe(false);
		} finally {
			warnings.mockRestore();
		}
	});

	it("replays a producer event without repeating D1 after local ACK failure", async () => {
		const stub = roomStub("ACKR24");
		await createRoom(stub, "ACKR24");
		const produced = await localSnapshot(stub);
		const eventId = produced.rows[0]?.event_id;
		if (!eventId) throw new Error("Expected a naturally produced event ID.");
		let originalRow: Record<string, SqlStorageValue> | undefined;

		await runInDurableObject(stub, async (instance, state) => {
			originalRow = state.storage.sql.exec<Record<string, SqlStorageValue>>(
				"SELECT * FROM room_milestone_outbox WHERE event_id = ?",
				eventId,
			).one();
			state.storage.sql.exec(`CREATE TRIGGER test_fail_producer_ack
				BEFORE DELETE ON room_milestone_outbox
				BEGIN SELECT RAISE(ABORT, 'synthetic producer ACK failure'); END`);

			await expect(instance.alarm()).rejects.toThrow("synthetic producer ACK failure");
			expect(state.storage.sql.exec<Record<string, SqlStorageValue>>(
				"SELECT * FROM room_milestone_outbox WHERE event_id = ?",
				eventId,
			).one()).toEqual(originalRow);
			expect(await state.storage.getAlarm()).not.toBeNull();
			state.storage.sql.exec("DROP TRIGGER test_fail_producer_ack");
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(1);
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(1);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await localSnapshot(stub)).rows).toEqual([]);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(1);
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(1);
	});

	it("keeps one lifecycle identity across eviction and queues joins only once", async () => {
		const stub = roomStub("EVCT24");
		await createRoom(stub, "EVCT24");
		const initial = await localSnapshot(stub);
		await evictDurableObject(stub);

		const firstJoin = await postRoom(stub, "/join", GUEST_TOKEN, { name: "Guest" });
		const replayJoin = await postRoom(stub, "/join", GUEST_TOKEN, { name: "Changed name" });
		const after = await localSnapshot(stub);

		expect(firstJoin.response.headers.get(ROOM_MILESTONES_HEADER)).toBe(ROOM_MILESTONE_OUTBOX_V1_SENTINEL);
		expect(replayJoin.response.headers.get(ROOM_MILESTONES_HEADER)).toBe(ROOM_MILESTONE_OUTBOX_V1_SENTINEL);
		expect(after.roomInstanceId).toBe(initial.roomInstanceId);
		expect(after.rows.map((row) => row.milestone)).toEqual(["created", "joined"]);
	});

	it("delivers a complete game lifecycle in FIFO order through idempotent receipts", async () => {
		const stub = roomStub("FAVR24");
		const ready = await prepareFinalTurn(stub, "FAVR24");
		const finalTurnId = ready.activeTurn?.id;
		if (!finalTurnId) throw new Error("Expected the final turn ID.");
		await action(stub, {
			type: "submit-turn",
			turnId: finalTurnId,
			spokenSeconds: 1,
		});
		await action(stub, { type: "reset" });

		const expectedOrder = [
			"created",
			"joined",
			"game-started",
			"turn-completed",
			"turn-completed",
			"game-finished",
			"reset",
		];
		const queued = await localSnapshot(stub);
		expect(queued.rows.map((row) => row.milestone)).toEqual(expectedOrder);
		for (const [delivered, milestone] of expectedOrder.entries()) {
			expect((await localSnapshot(stub)).rows[0]?.milestone).toBe(milestone);
			expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(delivered);
			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(delivered + 1);
		}

		expect((await localSnapshot(stub)).rows).toEqual([]);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(7);
		expect(await scalar("SELECT COALESCE(SUM(event_count), 0) AS value FROM analytics_daily")).toBe(6);
		const fact = await env.PLATFORM_DB.prepare("SELECT last_milestone FROM room_facts")
			.first<{ last_milestone: string }>();
		expect(fact?.last_milestone).toBe("reset");
	});

	it("commits gameplay and bounded telemetry on a canonicalization drop", async () => {
		const stub = roomStub("BAD1I?");
		const { response, room } = await createRoom(stub, "BAD1I?");
		const local = await localSnapshot(stub);

		expect(response.status).toBe(201);
		expect(response.headers.get(ROOM_MILESTONES_HEADER)).toBe(ROOM_MILESTONE_OUTBOX_V1_SENTINEL);
		expect(room.code).toBe("BAD1I?");
		expect(local.room?.code).toBe("BAD1I?");
		expect(local.rows).toEqual([]);
		expect(local.droppedCanonicalization).toBe(1);
	});

	it("serializes concurrent joins into monotonic room versions and FIFO events", async () => {
		const stub = roomStub("CNCR24");
		await createRoom(stub, "CNCR24");

		const [guest, third] = await Promise.all([
			postRoom(stub, "/join", GUEST_TOKEN, { name: "Guest" }),
			postRoom(stub, "/join", THIRD_TOKEN, { name: "Third" }),
		]);
		const versions = [guest.room.version, third.room.version].sort((left, right) => left - right);
		const local = await localSnapshot(stub);

		expect(versions).toEqual([2, 3]);
		expect(local.room?.version).toBe(3);
		expect(Object.keys(local.room?.members ?? {})).toHaveLength(3);
		expect(local.rows.map((row) => row.milestone)).toEqual(["created", "joined", "joined"]);
	});

	it("replays stable lifecycle and event entropy for a new-room transaction", async () => {
		const stub = roomStub("RPLY24");
		const replay = await replayNextTransactionOnce(stub);
		await createRoom(stub, "RPLY24");
		replay.restore();
		const committed = await localSnapshot(stub);

		expect(replay.captures).toHaveLength(1);
		expect(committed.roomInstanceId).toBe(replay.captures[0]?.roomInstanceId);
		expect(committed.rows.map((row) => row.event_id)).toEqual(replay.captures[0]?.eventIds);
	});

	it("replays the same two event IDs for an existing-room final pair", async () => {
		const stub = roomStub("RPLP24");
		const ready = await prepareFinalTurn(stub, "RPLP24");
		const finalTurnId = ready.activeTurn?.id;
		if (!finalTurnId) throw new Error("Expected the final turn ID.");
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("DELETE FROM room_milestone_outbox");
		});
		const before = await localSnapshot(stub);
		const replay = await replayNextTransactionOnce(stub);
		await action(stub, {
			type: "submit-turn",
			turnId: finalTurnId,
			spokenSeconds: 1,
		});
		replay.restore();
		const committed = await localSnapshot(stub);

		expect(replay.captures).toHaveLength(1);
		expect(replay.captures[0]?.roomInstanceId).toBe(before.roomInstanceId);
		expect(committed.rows.map((row) => row.milestone)).toEqual([
			"turn-completed",
			"game-finished",
		]);
		expect(committed.rows.map((row) => row.event_id)).toEqual(replay.captures[0]?.eventIds);
	});

	it("rolls room state back when its transactional write fails", async () => {
		const stub = roomStub("STATE2");
		await createRoom(stub, "STATE2");
		await postRoom(stub, "/join", GUEST_TOKEN, { name: "Guest" });
		const before = await localSnapshot(stub);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(`CREATE TRIGGER test_fail_room_state_update
				BEFORE UPDATE ON room_state
				BEGIN SELECT RAISE(FAIL, 'synthetic room state failure'); END`);
		});

		const response = await stub.fetch(roomRequest("/action", HOST_TOKEN, { type: "start-game" }));
		expect(response.status).toBe(500);
		const after = await localSnapshot(stub);
		expect(after.room).toEqual(before.room);
		expect(after.rows).toEqual(before.rows);
	});

	it("rolls a create back when lifecycle metadata cannot be inserted", async () => {
		const stub = roomStub("META24");
		await runInDurableObject(stub, (_instance, state) => {
			initializeRoomMilestoneOutbox(state.storage.sql);
			state.storage.sql.exec("DELETE FROM room_milestone_meta");
			state.storage.sql.exec(`CREATE TRIGGER test_fail_room_meta_insert
				BEFORE INSERT ON room_milestone_meta
				BEGIN SELECT RAISE(FAIL, 'synthetic metadata failure'); END`);
		});

		const response = await stub.fetch(roomRequest("/create", HOST_TOKEN, {
			code: "META24",
			name: "Host",
		}));
		expect(response.status).toBe(500);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(state.storage.sql.exec("SELECT id FROM room_state").toArray()).toEqual([]);
			expect(state.storage.sql.exec("SELECT id FROM room_milestone_meta").toArray()).toEqual([]);
			expect(state.storage.sql.exec("SELECT sequence FROM room_milestone_outbox").toArray()).toEqual([]);
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});

	it("rolls the room, metadata, event, and alarm back when alarm persistence fails", async () => {
		const stub = roomStub("ALRM24");
		let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
		await runInDurableObject(stub, (_instance, state) => {
			const original = state.storage.transaction.bind(state.storage);
			transactionSpy = vi.spyOn(state.storage, "transaction");
			const failingTransaction: DurableObjectStorage["transaction"] = (closure) =>
				original((transaction) => closure(new Proxy(transaction, {
					get(target, property, receiver) {
						if (property === "setAlarm") {
							return async () => { throw new Error("synthetic alarm failure"); };
						}
						return Reflect.get(target, property, receiver);
					},
				})));
			transactionSpy.mockImplementation(failingTransaction);
		});

		const response = await stub.fetch(roomRequest("/create", HOST_TOKEN, {
			code: "ALRM24",
			name: "Host",
		}));
		expect(response.status).toBe(500);
		transactionSpy?.mockRestore();
		await runInDurableObject(stub, async (_instance, state) => {
			const tables = state.storage.sql.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			).toArray().map(({ name }) => name);
			expect(tables).toEqual([]);
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});

	it("rolls back both final-turn events when the second insert fails", async () => {
		const stub = roomStub("PARR24");
		const ready = await prepareFinalTurn(stub, "PARR24");
		const finalTurnId = ready.activeTurn?.id;
		if (!finalTurnId) throw new Error("Expected the final turn ID.");
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("DELETE FROM room_milestone_outbox");
			state.storage.sql.exec(`CREATE TRIGGER test_fail_second_milestone
				BEFORE INSERT ON room_milestone_outbox
				WHEN NEW.milestone = 'game-finished'
				BEGIN SELECT RAISE(FAIL, 'synthetic second event failure'); END`);
		});

		const response = await stub.fetch(roomRequest("/action", HOST_TOKEN, {
			type: "submit-turn",
			turnId: finalTurnId,
			spokenSeconds: 1,
		}));
		expect(response.status).toBe(500);
		const after = await localSnapshot(stub);
		expect(after.room?.phase).toBe("playing");
		expect(after.room?.activeTurn?.id).toBe(finalTurnId);
		expect(after.rows).toEqual([]);
		expect(after.droppedCapacity).toBe(0);
	});

	it.each([
		{ existing: 254, expectedCount: 256, expectedDrops: 0 },
		{ existing: 255, expectedCount: 255, expectedDrops: 2 },
	])("commits final gameplay with an all-or-drop pair at capacity $existing", async ({
		existing,
		expectedCount,
		expectedDrops,
	}) => {
		const code = existing === 254 ? "CAP254" : "CAP255";
		const stub = roomStub(code);
		const ready = await prepareFinalTurn(stub, code);
		const finalTurnId = ready.activeTurn?.id;
		if (!finalTurnId) throw new Error("Expected the final turn ID.");
		await replaceQueueWith(stub, existing);

		const final = await action(stub, {
			type: "submit-turn",
			turnId: finalTurnId,
			spokenSeconds: 1,
		});
		const after = await localSnapshot(stub);

		expect(final.response.headers.get(ROOM_MILESTONES_HEADER)).toBe(ROOM_MILESTONE_OUTBOX_V1_SENTINEL);
		expect(final.room.phase).toBe("finished");
		expect(after.room?.phase).toBe("finished");
		expect(after.rows).toHaveLength(expectedCount);
		expect(after.droppedCapacity).toBe(expectedDrops);
		if (existing === 254) {
			expect(after.rows.slice(-2).map((row) => row.milestone)).toEqual([
				"turn-completed",
				"game-finished",
			]);
		} else {
			expect(after.rows.every((row) => row.milestone === "turn-completed")).toBe(true);
		}
	});

	it("falls back to legacy delivery when an exact outer Worker reaches an older room version", async () => {
		let analyticsCalls = 0;
		const now = Date.now();
		const legacyRoom = publicRoomState(
			createRoomState("SKEW24", HOST_TOKEN, "Legacy Host", now),
			HOST_TOKEN,
			new Set(),
			now,
		);
		const fakeEnv = new Proxy(
			env as unknown as Parameters<typeof worker.fetch>[1],
			{
				get(target, property, receiver) {
					if (property === "API_RATE_LIMITER") {
						return { limit: async () => ({ success: true }) };
					}
					if (property === "PRODUCT_ANALYTICS") {
						return { writeDataPoint: () => { analyticsCalls += 1; } };
					}
					if (property === "ROOMS") {
						return {
							idFromName: () => ({} as DurableObjectId),
							get: () => ({
								fetch: async () => {
									const response = Response.json({ room: legacyRoom });
									response.headers.set(ROOM_MILESTONES_HEADER, "created");
									return response;
								},
							}),
						};
					}
					return Reflect.get(target, property, receiver);
				},
			},
		);
		const context = createExecutionContext();
		const response = await worker.fetch(new Request("https://example.test/api/rooms/SKEW24/state", {
			headers: { Cookie: `nonstoptalk_token=${HOST_TOKEN}` },
		}), fakeEnv, context);
		await waitOnExecutionContext(context);

		expect(response.status).toBe(200);
		expect(response.headers.get(ROOM_MILESTONES_HEADER)).toBeNull();
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(1);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(0);
		expect(analyticsCalls).toBe(1);
	});

	it.each(["outbox", "best-effort"])(
		"recognizes the outbox sentinel when a %s outer reaches an outbox-owning room",
		async (deliveryMode) => {
			let databaseCalls = 0;
			let analyticsCalls = 0;
			const fakeEnv = {
				ROOM_MILESTONE_DELIVERY_MODE: deliveryMode,
				API_RATE_LIMITER: { limit: async () => ({ success: true }) },
				PLATFORM_DB: {
					prepare: () => {
						databaseCalls += 1;
						throw new Error("Legacy D1 delivery must not run.");
					},
				},
				PRODUCT_ANALYTICS: {
					writeDataPoint: () => { analyticsCalls += 1; },
				},
				ROOMS: {
					idFromName: () => ({}) as DurableObjectId,
					get: () => ({
						fetch: async () => {
							const response = Response.json({ room: { code: "GUARD2", serverNow: Date.now() } });
							response.headers.set(ROOM_MILESTONES_HEADER, ROOM_MILESTONE_OUTBOX_V1_SENTINEL);
							return response;
						},
					}),
				},
			} as unknown as Parameters<typeof worker.fetch>[1];
			const context = createExecutionContext();
			const response = await worker.fetch(new Request("https://example.test/api/rooms/GUARD2/state", {
				headers: { Cookie: `nonstoptalk_token=${HOST_TOKEN}` },
			}), fakeEnv, context);
			await waitOnExecutionContext(context);

			expect(response.status).toBe(200);
			expect(response.headers.get(ROOM_MILESTONES_HEADER)).toBeNull();
			expect(databaseCalls).toBe(0);
			expect(analyticsCalls).toBe(0);
		},
	);
});
