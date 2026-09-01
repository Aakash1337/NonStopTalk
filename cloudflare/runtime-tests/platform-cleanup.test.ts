import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanupExpiredData, hasExpiredPlatformData } from "../platform";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

interface ReceiptFixture {
	eventDigit: string;
	payloadDigit: string;
	receivedAt: Date;
	applied: boolean;
}

async function insertReceipt({
	eventDigit,
	payloadDigit,
	receivedAt,
	applied,
}: ReceiptFixture): Promise<void> {
	const receivedAtIso = receivedAt.toISOString();
	const expiresAtIso = new Date(receivedAt.getTime() + RECEIPT_RETENTION_MS).toISOString();
	await env.PLATFORM_DB
		.prepare(`INSERT INTO room_milestone_receipts (
			event_id, payload_hash, received_at, applied_at, expires_at
		) VALUES (?, ?, ?, ?, ?)`)
		.bind(
			eventDigit.repeat(64),
			payloadDigit.repeat(64),
			receivedAtIso,
			applied ? receivedAtIso : null,
			expiresAtIso,
		)
		.run();
}

async function receiptCounts(): Promise<{ total: number; expired: number; future: number }> {
	const row = await env.PLATFORM_DB
		.prepare(`SELECT
			COUNT(*) AS total,
			COUNT(*) FILTER (WHERE expires_at <= ?) AS expired,
			COUNT(*) FILTER (WHERE expires_at > ?) AS future
		FROM room_milestone_receipts`)
		.bind(NOW.toISOString(), NOW.toISOString())
		.first<{ total: number; expired: number; future: number }>();
	if (!row) throw new Error("Could not count receipt fixtures.");
	return row;
}

async function insertExpiredRoomFact(): Promise<void> {
	await env.PLATFORM_DB
		.prepare(`INSERT INTO room_facts (
			room_key, first_observed_at, last_observed_at, expires_at, state_version,
			last_milestone, phase, player_count, online_player_count, configured_rounds,
			turn_duration_seconds, topic_pack, completed_turn_count, finished_game_count,
			total_score, last_turn_spoken_seconds
		) VALUES (?, ?, ?, ?, 1, 'created', 'setup', 0, 0, 1, 60, 'everyday', 0, 0, 0, 0)`)
		.bind(
			"4".repeat(64),
			"2026-05-01T00:00:00.000Z",
			"2026-05-02T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
		)
		.run();
}

describe.sequential("platform cleanup with real local D1", () => {
	beforeEach(async () => {
		await env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS test_fail_receipt_cleanup").run();
		await env.PLATFORM_DB
			.prepare("UPDATE platform_meta SET schema_version = 6 WHERE id = 1")
			.run();
		await env.PLATFORM_DB.prepare("DELETE FROM room_facts").run();
		await env.PLATFORM_DB.prepare("DELETE FROM room_milestone_receipts").run();
	});

	it("deletes due and exact-boundary pending/applied receipts but keeps future receipts", async () => {
		await insertReceipt({
			eventDigit: "1",
			payloadDigit: "a",
			receivedAt: new Date(NOW.getTime() - RECEIPT_RETENTION_MS - 1),
			applied: true,
		});
		await insertReceipt({
			eventDigit: "2",
			payloadDigit: "b",
			receivedAt: new Date(NOW.getTime() - RECEIPT_RETENTION_MS),
			applied: false,
		});
		await insertReceipt({
			eventDigit: "3",
			payloadDigit: "c",
			receivedAt: new Date(NOW.getTime() - RECEIPT_RETENTION_MS + 1),
			applied: false,
		});

		expect(await hasExpiredPlatformData(env.PLATFORM_DB, 6, NOW)).toBe(true);
		const first = await cleanupExpiredData(env.PLATFORM_DB, 6, NOW, 1);
		expect(first.roomMilestoneReceipts).toBe(1);
		expect(first.hasMore).toBe(true);
		expect(await hasExpiredPlatformData(env.PLATFORM_DB, 6, NOW)).toBe(true);

		const second = await cleanupExpiredData(env.PLATFORM_DB, 6, NOW, 1);
		expect(second.roomMilestoneReceipts).toBe(1);
		expect(second.hasMore).toBe(true);
		expect(await receiptCounts()).toEqual({ total: 1, expired: 0, future: 1 });
		expect(await hasExpiredPlatformData(env.PLATFORM_DB, 6, NOW)).toBe(false);

		const settled = await cleanupExpiredData(env.PLATFORM_DB, 6, NOW, 1);
		expect(settled.roomMilestoneReceipts).toBe(0);
		expect(settled.hasMore).toBe(false);
	});

	it("skips receipt deletion and backlog when the marker rolls back after a schema-6 pre-read", async () => {
		await insertReceipt({
			eventDigit: "5",
			payloadDigit: "d",
			receivedAt: new Date(NOW.getTime() - RECEIPT_RETENTION_MS),
			applied: false,
		});
		await env.PLATFORM_DB
			.prepare("UPDATE platform_meta SET schema_version = 5 WHERE id = 1")
			.run();

		const cleaned = await cleanupExpiredData(env.PLATFORM_DB, 6, NOW);
		expect(cleaned.roomMilestoneReceipts).toBe(0);
		expect(await receiptCounts()).toEqual({ total: 1, expired: 1, future: 0 });
		expect(await hasExpiredPlatformData(env.PLATFORM_DB, 6, NOW)).toBe(false);
	});

	it("rolls back earlier cleanup statements when receipt deletion fails", async () => {
		await insertExpiredRoomFact();
		await insertReceipt({
			eventDigit: "6",
			payloadDigit: "e",
			receivedAt: new Date(NOW.getTime() - RECEIPT_RETENTION_MS),
			applied: true,
		});
		await env.PLATFORM_DB.prepare(`CREATE TRIGGER test_fail_receipt_cleanup
			BEFORE DELETE ON room_milestone_receipts
			BEGIN
				SELECT RAISE(ABORT, 'synthetic receipt cleanup failure');
			END`).run();

		await expect(cleanupExpiredData(env.PLATFORM_DB, 6, NOW)).rejects.toThrow(
			"Could not clean up expired platform data.",
		);
		const afterFailure = await env.PLATFORM_DB
			.prepare(`SELECT
				(SELECT COUNT(*) FROM room_facts) AS roomFacts,
				(SELECT COUNT(*) FROM room_milestone_receipts) AS receipts`)
			.first<{ roomFacts: number; receipts: number }>();
		expect(afterFailure).toEqual({ roomFacts: 1, receipts: 1 });

		await env.PLATFORM_DB.prepare("DROP TRIGGER test_fail_receipt_cleanup").run();
		const retried = await cleanupExpiredData(env.PLATFORM_DB, 6, NOW);
		expect(retried.roomFacts).toBe(1);
		expect(retried.roomMilestoneReceipts).toBe(1);
		const afterRetry = await env.PLATFORM_DB
			.prepare(`SELECT
				(SELECT COUNT(*) FROM room_facts) AS roomFacts,
				(SELECT COUNT(*) FROM room_milestone_receipts) AS receipts`)
			.first<{ roomFacts: number; receipts: number }>();
		expect(afterRetry).toEqual({ roomFacts: 0, receipts: 0 });
	});

	it("does not reference the receipt table at all on the physical schema-5 path", async () => {
		await env.PLATFORM_DB
			.prepare("UPDATE platform_meta SET schema_version = 5 WHERE id = 1")
			.run();
		await env.PLATFORM_DB
			.prepare("ALTER TABLE room_milestone_receipts RENAME TO schema6_receipts_held")
			.run();

		try {
			const cleaned = await cleanupExpiredData(env.PLATFORM_DB, 5, NOW);
			expect(cleaned.roomMilestoneReceipts).toBe(0);
			expect(cleaned.hasMore).toBe(false);
			expect(await hasExpiredPlatformData(env.PLATFORM_DB, 5, NOW)).toBe(false);
		} finally {
			await env.PLATFORM_DB
				.prepare("ALTER TABLE schema6_receipts_held RENAME TO room_milestone_receipts")
				.run();
			await env.PLATFORM_DB
				.prepare("UPDATE platform_meta SET schema_version = 6 WHERE id = 1")
				.run();
		}
	});
});
