import { env } from "cloudflare:workers";
import {
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { RoomState } from "../game";
import {
	ROOM_MILESTONE_OUTBOX_DEADLINE_MS,
	enqueueRoomMilestones,
	initializeRoomMilestoneOutbox,
	readRoomMilestoneOutboxMetadata,
} from "../room-milestone-outbox";
import type { PublicRoomFactDraft } from "../platform";
import { RoomDurableObject } from "../worker";

const TOKEN = "a".repeat(64);
const HEX_256 = /^[0-9a-f]{64}$/u;
const MILESTONE_HEADER = "X-NonStopTalk-Room-Milestones";
const ROOM_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

function roomStub(code: string): DurableObjectStub<RoomDurableObject> {
	return env.ROOMS.get(env.ROOMS.idFromName(code));
}

function roomRequest(pathname: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("X-NonStopTalk-Token", TOKEN);
	return new Request(`https://room.internal${pathname}`, { ...init, headers });
}

async function createRoom(
	stub: DurableObjectStub<RoomDurableObject>,
	code: string,
): Promise<{ response: Response; room: RoomState }> {
	const response = await stub.fetch(roomRequest("/create", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code, name: "Outbox Host" }),
	}));
	expect(response.status).toBe(201);
	const snapshot = response.clone();
	const payload = await snapshot.json<{ room: RoomState }>();
	return { response, room: payload.room };
}

function milestoneFact(
	milestone: "created" | "joined",
	stateVersion: number,
	observedAt = new Date().toISOString(),
): PublicRoomFactDraft {
	return {
		roomCode: "MILE24",
		stateVersion,
		observedAt,
		milestone,
		phase: "setup",
		playerCount: milestone === "created" ? 1 : 2,
		onlinePlayerCount: milestone === "created" ? 1 : 2,
		configuredRounds: 1,
		turnDurationSeconds: 60,
		topicPack: "everyday",
		completedTurnCount: 0,
		finishedGameCount: 0,
		totalScore: 0,
		lastTurnSpokenSeconds: 0,
	};
}

function userTables(storage: DurableObjectStorage): string[] {
	return storage.sql
		.exec<{ name: string }>(`SELECT name FROM sqlite_master
			WHERE type = 'table'
				AND name NOT LIKE 'sqlite_%'
				AND name <> '_cf_METADATA'
			ORDER BY name`)
		.toArray()
		.map(({ name }) => name);
}

async function receiptCount(eventId?: string): Promise<number> {
	const statement = eventId
		? env.PLATFORM_DB.prepare(
			"SELECT COUNT(*) AS count FROM room_milestone_receipts WHERE event_id = ?",
		).bind(eventId)
		: env.PLATFORM_DB.prepare("SELECT COUNT(*) AS count FROM room_milestone_receipts");
	const row = await statement.first<{ count: number }>();
	return row?.count ?? 0;
}

beforeEach(async () => {
	await env.PLATFORM_DB.batch([
		env.PLATFORM_DB.prepare("DELETE FROM room_milestone_receipts"),
		env.PLATFORM_DB.prepare("DELETE FROM room_facts"),
		env.PLATFORM_DB.prepare("DELETE FROM analytics_daily"),
		env.PLATFORM_DB.prepare("UPDATE platform_meta SET schema_version = 6 WHERE id = 1"),
	]);
});

describe("room milestone compatibility bridge in the Workers runtime", () => {
	it("keeps missing-room probes storage-free", async () => {
		const stub = roomStub("MISS24");
		const response = await stub.fetch(roomRequest("/state"));
		expect(response.status).toBe(404);

		await runInDurableObject(stub, (_instance, state) => {
			expect(userTables(state.storage)).toEqual([]);
		});
	});

	it("keeps ordinary rooms cheap and preserves a manually installed private identity across eviction", async () => {
		const stub = roomStub("META24");
		await createRoom(stub, "META24");

		let storedJson = "";
		let roomInstanceId = "";
		await runInDurableObject(stub, async (_instance, state) => {
			expect(userTables(state.storage)).toEqual(["room_state"]);
			storedJson = state.storage.sql.exec<{ json: string }>(
				"SELECT json FROM room_state WHERE id = 1",
			).one().json;

			await state.storage.transaction(async () => {
				roomInstanceId = initializeRoomMilestoneOutbox(state.storage.sql).roomInstanceId;
			});
			expect(roomInstanceId).toMatch(HEX_256);
			expect(userTables(state.storage)).toEqual([
				"room_milestone_dead_letters",
				"room_milestone_meta",
				"room_milestone_outbox",
				"room_state",
			]);
			expect(state.storage.sql.exec<{ json: string }>(
				"SELECT json FROM room_state WHERE id = 1",
			).one().json).toBe(storedJson);

			const deadLetterColumns = state.storage.sql
				.exec<{ name: string }>("PRAGMA table_info(room_milestone_dead_letters)")
				.toArray()
				.map(({ name }) => name);
			expect(deadLetterColumns).not.toContain("event_id");
			expect(deadLetterColumns).not.toContain("payload_json");
		});

		await evictDurableObject(stub);
		await runInDurableObject(stub, (_instance, state) => {
			expect(readRoomMilestoneOutboxMetadata(state.storage.sql).roomInstanceId).toBe(roomInstanceId);
			expect(state.storage.sql.exec<{ json: string }>(
				"SELECT json FROM room_state WHERE id = 1",
			).one().json).toBe(storedJson);
		});
	});

	it("retains best-effort headers without creating an outbox", async () => {
		const stub = roomStub("BEST24");
		const { response } = await createRoom(stub, "BEST24");
		expect(response.headers.get(MILESTONE_HEADER)).toBe("created");

		await runInDurableObject(stub, (_instance, state) => {
			expect(userTables(state.storage)).toEqual(["room_state"]);
		});
		expect(await receiptCount()).toBe(0);
	});

	it("drains a future canonical row and applies one receipt while best-effort mode remains active", async () => {
		const stub = roomStub("SEND24");
		await createRoom(stub, "SEND24");
		let eventId = "";

		await runInDurableObject(stub, async (_instance, state) => {
			const now = Date.now() - 1;
			await state.storage.transaction(async (transaction) => {
				initializeRoomMilestoneOutbox(state.storage.sql);
				const result = enqueueRoomMilestones(state.storage.sql, [milestoneFact("created", 1)], now);
				expect(result.outcome).toBe("queued");
				if (result.outcome !== "queued") throw new Error("Expected a queued milestone.");
				eventId = result.events[0]?.eventId ?? "";
				await transaction.setAlarm(Date.now() + 60_000);
			});
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await receiptCount(eventId)).toBe(1);
		await runInDurableObject(stub, (_instance, state) => {
			expect(state.storage.sql.exec("SELECT sequence FROM room_milestone_outbox").toArray()).toEqual([]);
		});
	});

	it("replays as a duplicate when D1 commits before the local ACK transaction fails", async () => {
		const stub = roomStub("ACKF24");
		await createRoom(stub, "ACKF24");
		let eventId = "";
		let originalRow: Record<string, SqlStorageValue> | undefined;

		await runInDurableObject(stub, async (instance, state) => {
			const now = Date.now() - 1;
			await state.storage.transaction(async (transaction) => {
				initializeRoomMilestoneOutbox(state.storage.sql);
				const result = enqueueRoomMilestones(
					state.storage.sql,
					[milestoneFact("created", 1)],
					now,
				);
				if (result.outcome !== "queued") throw new Error("Expected a queued milestone.");
				eventId = result.events[0]?.eventId ?? "";
				await transaction.setAlarm(Date.now() + 60_000);
			});
			originalRow = state.storage.sql.exec<Record<string, SqlStorageValue>>(
				"SELECT * FROM room_milestone_outbox WHERE event_id = ?",
				eventId,
			).one();
			state.storage.sql.exec(`CREATE TRIGGER test_fail_room_milestone_ack
				BEFORE DELETE ON room_milestone_outbox
				BEGIN
					SELECT RAISE(ABORT, 'synthetic local ACK failure');
				END`);

			await expect(instance.alarm()).rejects.toThrow("synthetic local ACK failure");

			expect(state.storage.sql.exec<Record<string, SqlStorageValue>>(
				"SELECT * FROM room_milestone_outbox WHERE event_id = ?",
				eventId,
			).one()).toEqual(originalRow);
			expect(await state.storage.getAlarm()).not.toBeNull();
			state.storage.sql.exec("DROP TRIGGER test_fail_room_milestone_ack");
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await receiptCount(eventId)).toBe(1);
		expect(await env.PLATFORM_DB.prepare(
			"SELECT event_count FROM analytics_daily WHERE metric = 'room_created'",
		).first<{ event_count: number }>()).toEqual({ event_count: 1 });

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await receiptCount(eventId)).toBe(1);
		expect(await env.PLATFORM_DB.prepare(
			"SELECT event_count FROM analytics_daily WHERE metric = 'room_created'",
		).first<{ event_count: number }>()).toEqual({ event_count: 1 });
		await runInDurableObject(stub, (_instance, state) => {
			expect(state.storage.sql.exec(
				"SELECT sequence FROM room_milestone_outbox WHERE event_id = ?",
				eventId,
			).toArray()).toEqual([]);
		});
	});

	it("persists marker-5 retry state, blocks FIFO, and drains in order after marker-6 recovery", async () => {
		const stub = roomStub("FIFO24");
		await createRoom(stub, "FIFO24");
		let firstEventId = "";
		let secondEventId = "";

		await runInDurableObject(stub, async (_instance, state) => {
			const now = Date.now() - 1;
			await state.storage.transaction(async (transaction) => {
				initializeRoomMilestoneOutbox(state.storage.sql);
				const result = enqueueRoomMilestones(state.storage.sql, [
					milestoneFact("created", 1),
					milestoneFact("joined", 2),
				], now);
				expect(result.outcome).toBe("queued");
				if (result.outcome !== "queued") throw new Error("Expected queued milestones.");
				[firstEventId, secondEventId] = result.events.map(({ eventId }) => eventId);
				await transaction.setAlarm(Date.now() + 60_000);
			});
		});
		await env.PLATFORM_DB.prepare("UPDATE platform_meta SET schema_version = 5 WHERE id = 1").run();

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await receiptCount()).toBe(0);
		await runInDurableObject(stub, async (_instance, state) => {
			const rows = state.storage.sql.exec<{
				event_id: string;
				attempt_count: number;
				last_failure: string | null;
			}>(`SELECT event_id, attempt_count, last_failure
				FROM room_milestone_outbox ORDER BY sequence`).toArray();
			expect(rows).toEqual([
				{ event_id: firstEventId, attempt_count: 1, last_failure: "receiver-invariant" },
				{ event_id: secondEventId, attempt_count: 0, last_failure: null },
			]);
			expect(await state.storage.getAlarm()).not.toBeNull();
		});

		await env.PLATFORM_DB.prepare("UPDATE platform_meta SET schema_version = 6 WHERE id = 1").run();
		await runInDurableObject(stub, async (_instance, state) => {
			const now = Date.now();
			state.storage.sql.exec(
				"UPDATE room_milestone_outbox SET next_attempt_at_ms = ? WHERE event_id = ?",
				now,
				firstEventId,
			);
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await receiptCount(firstEventId)).toBe(1);
		expect(await receiptCount(secondEventId)).toBe(0);
		// The runtime may consume a just-scheduled follower alarm before the test
		// helper observes it. Move the existing wake into the future without
		// changing the already-due FIFO row, then invoke it deterministically.
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await receiptCount(secondEventId)).toBe(1);
		await runInDurableObject(stub, (_instance, state) => {
			expect(state.storage.sql.exec("SELECT sequence FROM room_milestone_outbox").toArray()).toEqual([]);
		});
	});

	it("terminally scrubs a corrupt payload into a privacy-minimal dead letter", async () => {
		const stub = roomStub("BADP24");
		await createRoom(stub, "BADP24");

		await runInDurableObject(stub, async (_instance, state) => {
			const now = Date.now() - 1;
			await state.storage.transaction(async (transaction) => {
				initializeRoomMilestoneOutbox(state.storage.sql);
				state.storage.sql.exec(
					`INSERT INTO room_milestone_outbox (
						event_id, payload_json, milestone, created_at_ms, deadline_at_ms,
						attempt_count, next_attempt_at_ms, last_failure
					) VALUES (?, '[]', 'created', ?, ?, 0, ?, NULL)`,
					"b".repeat(64),
					now,
					now + ROOM_MILESTONE_OUTBOX_DEADLINE_MS,
					now,
				);
				await transaction.setAlarm(Date.now() + 60_000);
			});
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, (_instance, state) => {
			expect(state.storage.sql.exec("SELECT sequence FROM room_milestone_outbox").toArray()).toEqual([]);
			expect(state.storage.sql.exec<{
				reason: string;
				milestone: string;
				attempt_count: number;
			}>("SELECT reason, milestone, attempt_count FROM room_milestone_dead_letters").toArray()).toEqual([
				{ reason: "invalid-payload", milestone: "created", attempt_count: 0 },
			]);
		});
		expect(await receiptCount("b".repeat(64))).toBe(0);
	});

	it("dead-letters a canonical payload whose stored milestone column disagrees", async () => {
		const stub = roomStub("MISM24");
		await createRoom(stub, "MISM24");
		let eventId = "";

		await runInDurableObject(stub, async (_instance, state) => {
			const now = Date.now() - 1;
			await state.storage.transaction(async (transaction) => {
				initializeRoomMilestoneOutbox(state.storage.sql);
				const result = enqueueRoomMilestones(state.storage.sql, [milestoneFact("created", 1)], now);
				if (result.outcome !== "queued") throw new Error("Expected a queued milestone.");
				eventId = result.events[0]?.eventId ?? "";
				state.storage.sql.exec(
					"UPDATE room_milestone_outbox SET milestone = 'joined' WHERE event_id = ?",
					eventId,
				);
				await transaction.setAlarm(Date.now() + 60_000);
			});
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await receiptCount(eventId)).toBe(0);
		await runInDurableObject(stub, (_instance, state) => {
			expect(state.storage.sql.exec("SELECT sequence FROM room_milestone_outbox").toArray()).toEqual([]);
			expect(state.storage.sql.exec<{ reason: string; milestone: string }>(
				"SELECT reason, milestone FROM room_milestone_dead_letters",
			).toArray()).toEqual([{ reason: "invalid-payload", milestone: "joined" }]);
		});
	});

	it("expires the room by deleting every table and its alarm", async () => {
		const stub = roomStub("GONE24");
		await createRoom(stub, "GONE24");

		await runInDurableObject(stub, async (_instance, state) => {
			initializeRoomMilestoneOutbox(state.storage.sql);
			const row = state.storage.sql.exec<{ json: string }>(
				"SELECT json FROM room_state WHERE id = 1",
			).one();
			const expired = JSON.parse(row.json) as RoomState;
			expired.updatedAt = Date.now() - ROOM_IDLE_TTL_MS - 1;
			state.storage.sql.exec("UPDATE room_state SET json = ? WHERE id = 1", JSON.stringify(expired));
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(userTables(state.storage)).toEqual([]);
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});
});
