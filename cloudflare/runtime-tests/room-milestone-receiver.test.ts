import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { PlatformError, type PublicRoomFactDraft } from "../platform";
import {
	encodeRoomMilestonePayloadV1,
	hashRoomMilestonePayloadV1,
} from "../room-milestone-contract";
import { receiveRoomMilestone } from "../room-milestone-receiver";

const EVENT_ID = "1".repeat(64);
const ROOM_INSTANCE_ID = "2".repeat(64);
const ROOM_FACT_KEY = "3".repeat(64);
const RECEIVED_AT = new Date("2026-09-01T12:00:00.000Z");
const FAIL_FACT_TRIGGER = "runtime_fail_room_milestone_fact";
const FAIL_ANALYTICS_TRIGGER = "runtime_fail_room_milestone_analytics";

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

function delivery(
	eventId = EVENT_ID,
	fact = roomFact(),
): { eventId: string; payloadJson: string } {
	return {
		eventId,
		payloadJson: encodeRoomMilestonePayloadV1(ROOM_INSTANCE_ID, fact),
	};
}

function analyticsBinding(points: AnalyticsEngineDataPoint[]): AnalyticsEngineDataset {
	return {
		writeDataPoint(point: AnalyticsEngineDataPoint): void {
			points.push(point);
		},
	} as AnalyticsEngineDataset;
}

async function scalar(query: string, ...bindings: unknown[]): Promise<number> {
	const row = await env.PLATFORM_DB.prepare(query).bind(...bindings).first<{ value: number }>();
	if (!row) throw new Error(`Missing scalar result for: ${query}`);
	return row.value;
}

async function expectedRoomKey(roomInstanceId: string, hashKey: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(hashKey),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`nonstoptalk-room-instance:v1:${roomInstanceId}`),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeEach(async () => {
	await env.PLATFORM_DB.exec(`DROP TRIGGER IF EXISTS ${FAIL_FACT_TRIGGER}`);
	await env.PLATFORM_DB.exec(`DROP TRIGGER IF EXISTS ${FAIL_ANALYTICS_TRIGGER}`);
	await env.PLATFORM_DB.batch([
		env.PLATFORM_DB.prepare("DELETE FROM room_milestone_receipts"),
		env.PLATFORM_DB.prepare("DELETE FROM room_facts"),
		env.PLATFORM_DB.prepare("DELETE FROM analytics_daily"),
		env.PLATFORM_DB.prepare("UPDATE platform_meta SET schema_version = 6 WHERE id = 1"),
	]);
});

describe("schema-6 room milestone receiver in the Workers runtime", () => {
	it("applies one of 24 concurrent deliveries exactly once in D1 and attempts Analytics Engine once", async () => {
		const points: AnalyticsEngineDataPoint[] = [];
		const item = delivery();
		const deliveryCount = 24;
		const receiverEnv = {
			PLATFORM_DB: env.PLATFORM_DB,
			ROOM_FACT_HASH_KEY: ROOM_FACT_KEY,
			PRODUCT_ANALYTICS: analyticsBinding(points),
		};

		const outcomes = await Promise.all(Array.from(
			{ length: deliveryCount },
			() => receiveRoomMilestone(receiverEnv, item, RECEIVED_AT),
		));
		expect(outcomes.filter(({ outcome }) => outcome === "applied")).toHaveLength(1);
		expect(outcomes.filter(({ outcome }) => outcome === "duplicate")).toHaveLength(deliveryCount - 1);
		expect(points).toHaveLength(1);

		const receipt = await env.PLATFORM_DB
			.prepare(`SELECT payload_hash, received_at, applied_at, expires_at
				FROM room_milestone_receipts WHERE event_id = ?`)
			.bind(EVENT_ID)
			.first<{
				payload_hash: string;
				received_at: string;
				applied_at: string | null;
				expires_at: string;
			}>();
		expect(receipt).toEqual({
			payload_hash: await hashRoomMilestonePayloadV1(item.payloadJson),
			received_at: RECEIVED_AT.toISOString(),
			applied_at: RECEIVED_AT.toISOString(),
			expires_at: "2026-11-30T12:00:00.000Z",
		});

		const fact = await env.PLATFORM_DB
			.prepare("SELECT room_key, last_milestone FROM room_facts")
			.first<{ room_key: string; last_milestone: string }>();
		expect(fact).toEqual({
			room_key: await expectedRoomKey(ROOM_INSTANCE_ID, ROOM_FACT_KEY),
			last_milestone: "created",
		});
		expect(await scalar(
			"SELECT event_count AS value FROM analytics_daily WHERE day = ? AND metric = ?",
			"2026-09-01",
			"room_created",
		)).toBe(1);
	});

	it("applies reset to the receipt and fact sinks without creating analytics", async () => {
		const points: AnalyticsEngineDataPoint[] = [];
		expect(await receiveRoomMilestone({
			PLATFORM_DB: env.PLATFORM_DB,
			ROOM_FACT_HASH_KEY: ROOM_FACT_KEY,
			PRODUCT_ANALYTICS: analyticsBinding(points),
		}, delivery(EVENT_ID, roomFact({
			stateVersion: 2,
			milestone: "reset",
		})), RECEIVED_AT)).toEqual({ outcome: "applied" });

		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(1);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_facts WHERE last_milestone = 'reset'")).toBe(1);
		expect(await scalar("SELECT COUNT(*) AS value FROM analytics_daily")).toBe(0);
		expect(points).toHaveLength(0);
	});

	it("treats a changed payload as a terminal conflict without repeating either sink", async () => {
		const points: AnalyticsEngineDataPoint[] = [];
		const receiverEnv = {
			PLATFORM_DB: env.PLATFORM_DB,
			ROOM_FACT_HASH_KEY: ROOM_FACT_KEY,
			PRODUCT_ANALYTICS: analyticsBinding(points),
		};
		expect(await receiveRoomMilestone(receiverEnv, delivery(), RECEIVED_AT)).toEqual({ outcome: "applied" });
		expect(await receiveRoomMilestone(
			receiverEnv,
			delivery(EVENT_ID, roomFact({ playerCount: 2, onlinePlayerCount: 1, stateVersion: 2 })),
			new Date(RECEIVED_AT.valueOf() + 1),
	)).toEqual({ outcome: "conflict" });

		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(1);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_facts")).toBe(1);
		expect(await scalar(
			"SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'",
		)).toBe(1);
		expect(points).toHaveLength(1);
	});

	it("receipts analytics without a valid fact key and never backfills the fact on replay", async () => {
		const points: AnalyticsEngineDataPoint[] = [];
		const item = delivery();
		expect(await receiveRoomMilestone({
			PLATFORM_DB: env.PLATFORM_DB,
			ROOM_FACT_HASH_KEY: "too-short",
			PRODUCT_ANALYTICS: analyticsBinding(points),
		}, item, RECEIVED_AT)).toEqual({ outcome: "applied" });
		expect(await scalar("SELECT COUNT(*) AS value FROM room_facts")).toBe(0);
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(1);

		expect(await receiveRoomMilestone({
			PLATFORM_DB: env.PLATFORM_DB,
			ROOM_FACT_HASH_KEY: ROOM_FACT_KEY,
			PRODUCT_ANALYTICS: analyticsBinding(points),
		}, item, new Date(RECEIVED_AT.valueOf() + 1))).toEqual({ outcome: "duplicate" });
		expect(await scalar("SELECT COUNT(*) AS value FROM room_facts")).toBe(0);
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(1);
		expect(points).toHaveLength(1);
	});

	it("fails closed on a pre-existing same-hash pending receipt", async () => {
		const item = delivery();
		const payloadHash = await hashRoomMilestonePayloadV1(item.payloadJson);
		await env.PLATFORM_DB
			.prepare(`INSERT INTO room_milestone_receipts (
				event_id, payload_hash, received_at, applied_at, expires_at
			) VALUES (?, ?, ?, NULL, ?)`)
			.bind(
				EVENT_ID,
				payloadHash,
				"2026-08-31T12:00:00.000Z",
				"2026-11-29T12:00:00.000Z",
			)
			.run();

		expect(await receiveRoomMilestone({
			PLATFORM_DB: env.PLATFORM_DB,
			ROOM_FACT_HASH_KEY: ROOM_FACT_KEY,
		}, item, RECEIVED_AT)).toEqual({ outcome: "invariant" });
		expect(await scalar("SELECT COUNT(*) AS value FROM room_facts")).toBe(0);
		expect(await scalar("SELECT COUNT(*) AS value FROM analytics_daily")).toBe(0);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts WHERE applied_at IS NULL")).toBe(1);
	});

	it.each([
		{
			stage: "room-fact insert",
			triggerSql: `CREATE TRIGGER ${FAIL_FACT_TRIGGER}
				BEFORE INSERT ON room_facts
				WHEN NEW.last_milestone = 'created'
				BEGIN
					SELECT RAISE(ABORT, 'synthetic fact failure');
				END`,
		},
		{
			stage: "analytics insert",
			triggerSql: `CREATE TRIGGER ${FAIL_ANALYTICS_TRIGGER}
				BEFORE INSERT ON analytics_daily
				WHEN NEW.metric = 'room_created'
				BEGIN
					SELECT RAISE(ABORT, 'synthetic analytics failure');
				END`,
		},
	])("rolls back the entire batch when the $stage fails", async ({ triggerSql }) => {
		await env.PLATFORM_DB.prepare(triggerSql).run();
		const points: AnalyticsEngineDataPoint[] = [];

		await expect(receiveRoomMilestone({
			PLATFORM_DB: env.PLATFORM_DB,
			ROOM_FACT_HASH_KEY: ROOM_FACT_KEY,
			PRODUCT_ANALYTICS: analyticsBinding(points),
		}, delivery(), RECEIVED_AT)).rejects.toMatchObject({
			name: "PlatformError",
			code: "DATABASE_UNAVAILABLE",
			status: 503,
		});
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(0);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_facts")).toBe(0);
		expect(await scalar("SELECT COUNT(*) AS value FROM analytics_daily")).toBe(0);
		expect(points).toHaveLength(0);
	});

	it("keeps committed D1 state when Analytics Engine throws and makes the retry a duplicate", async () => {
		let analyticsAttempts = 0;
		const item = delivery();
		const receiverEnv = {
			PLATFORM_DB: env.PLATFORM_DB,
			ROOM_FACT_HASH_KEY: ROOM_FACT_KEY,
			PRODUCT_ANALYTICS: {
				writeDataPoint(): void {
					analyticsAttempts += 1;
					throw new Error("synthetic Analytics Engine outage");
				},
			} as AnalyticsEngineDataset,
		};

		expect(await receiveRoomMilestone(receiverEnv, item, RECEIVED_AT)).toEqual({ outcome: "applied" });
		expect(await scalar(
			"SELECT COUNT(*) AS value FROM room_milestone_receipts WHERE applied_at IS NOT NULL",
		)).toBe(1);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_facts")).toBe(1);
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(1);

		expect(await receiveRoomMilestone(
			receiverEnv,
			item,
			new Date(RECEIVED_AT.valueOf() + 1),
		)).toEqual({ outcome: "duplicate" });
		expect(analyticsAttempts).toBe(1);
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(1);
	});

	it("counts identical payloads with different event IDs independently", async () => {
		const points: AnalyticsEngineDataPoint[] = [];
		const receiverEnv = {
			PLATFORM_DB: env.PLATFORM_DB,
			ROOM_FACT_HASH_KEY: ROOM_FACT_KEY,
			PRODUCT_ANALYTICS: analyticsBinding(points),
		};
		expect(await receiveRoomMilestone(
			receiverEnv,
			delivery("6".repeat(64)),
			RECEIVED_AT,
		)).toEqual({ outcome: "applied" });
		expect(await receiveRoomMilestone(
			receiverEnv,
			delivery("7".repeat(64)),
			new Date(RECEIVED_AT.valueOf() + 1),
		)).toEqual({ outcome: "applied" });

		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(2);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_facts")).toBe(1);
		expect(await scalar("SELECT event_count AS value FROM analytics_daily WHERE metric = 'room_created'")).toBe(2);
		expect(points).toHaveLength(2);
	});

	it("keeps schema 5 batch-free, blocks schema 7, and recovers on schema 6 using the same binding", async () => {
		const receiverEnv = { PLATFORM_DB: env.PLATFORM_DB };
		await env.PLATFORM_DB.prepare("UPDATE platform_meta SET schema_version = 5 WHERE id = 1").run();
		expect(await receiveRoomMilestone(
			receiverEnv,
			delivery(),
			RECEIVED_AT,
		)).toEqual({ outcome: "invariant" });
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(0);

		await env.PLATFORM_DB.prepare("UPDATE platform_meta SET schema_version = 7 WHERE id = 1").run();
		await expect(receiveRoomMilestone(
			receiverEnv,
			delivery(),
			RECEIVED_AT,
		)).rejects.toBeInstanceOf(PlatformError);
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(0);

		await env.PLATFORM_DB.prepare("UPDATE platform_meta SET schema_version = 6 WHERE id = 1").run();
		expect(await receiveRoomMilestone(
			receiverEnv,
			delivery(),
			RECEIVED_AT,
		)).toEqual({ outcome: "applied" });
		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(1);
	});

	it("applies ordered turn-completed and game-finished events at one timestamp", async () => {
		const points: AnalyticsEngineDataPoint[] = [];
		const receiverEnv = {
			PLATFORM_DB: env.PLATFORM_DB,
			ROOM_FACT_HASH_KEY: ROOM_FACT_KEY,
			PRODUCT_ANALYTICS: analyticsBinding(points),
		};
		const common = {
			stateVersion: 9,
			phase: "finished" as const,
			playerCount: 2,
			onlinePlayerCount: 2,
			completedTurnCount: 2,
			finishedGameCount: 1,
			totalScore: 125,
			lastTurnSpokenSeconds: 40,
		};
		expect(await receiveRoomMilestone(
			receiverEnv,
			delivery("4".repeat(64), roomFact({ ...common, milestone: "turn-completed" })),
			RECEIVED_AT,
	)).toEqual({ outcome: "applied" });
		expect(await receiveRoomMilestone(
			receiverEnv,
			delivery("5".repeat(64), roomFact({ ...common, milestone: "game-finished" })),
			new Date(RECEIVED_AT.valueOf() + 1),
	)).toEqual({ outcome: "applied" });

		expect(await scalar("SELECT COUNT(*) AS value FROM room_milestone_receipts")).toBe(2);
		expect(await scalar("SELECT COUNT(*) AS value FROM analytics_daily WHERE event_count = 1")).toBe(2);
		const fact = await env.PLATFORM_DB
			.prepare("SELECT last_milestone FROM room_facts")
			.first<{ last_milestone: string }>();
		expect(fact?.last_milestone).toBe("game-finished");
		expect(points).toHaveLength(2);
	});
});
