import { logWorkerEvent } from "./observability";
import {
	PlatformError,
	ROOM_FACT_RETENTION_MS,
} from "./platform";
import { requireSupportedPlatformSchema } from "./platform-schema";
import {
	hashRoomMilestonePayloadV1,
	normalizeRoomMilestoneDeliveryV1,
	type NormalizedRoomMilestonePayloadV1,
} from "./room-milestone-contract";

const LOWERCASE_HEX_256_PATTERN = /^[0-9a-f]{64}$/u;
const RECEIPT_INSERT_SQL = `
	INSERT INTO room_milestone_receipts (
		event_id, payload_hash, received_at, applied_at, expires_at
	)
	SELECT ?, ?, ?, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+90 days')
	WHERE EXISTS (
		SELECT 1 FROM platform_meta WHERE id = 1 AND schema_version = 6
	)
	ON CONFLICT(event_id) DO NOTHING
`;

const RECEIPT_GATED_ROOM_FACT_SQL = `
	INSERT INTO room_facts (
		room_key, first_observed_at, last_observed_at, expires_at, state_version,
		last_milestone, phase, player_count, online_player_count, configured_rounds,
		turn_duration_seconds, topic_pack, completed_turn_count, finished_game_count,
		total_score, last_turn_spoken_seconds
	)
	SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
	WHERE ? = 1
		AND EXISTS (
			SELECT 1
			FROM room_milestone_receipts AS receipt
			JOIN platform_meta AS meta ON meta.id = 1 AND meta.schema_version = 6
			WHERE receipt.event_id = ?
				AND receipt.payload_hash = ?
				AND receipt.received_at = ?
				AND receipt.expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+90 days')
				AND receipt.applied_at IS NULL
				AND receipt.expires_at > ?
		)
	ON CONFLICT(room_key) DO UPDATE SET
		first_observed_at = CASE
			WHEN excluded.last_milestone = 'created' THEN excluded.first_observed_at
			ELSE room_facts.first_observed_at
		END,
		last_observed_at = excluded.last_observed_at,
		expires_at = excluded.expires_at,
		state_version = excluded.state_version,
		last_milestone = excluded.last_milestone,
		phase = excluded.phase,
		player_count = excluded.player_count,
		online_player_count = excluded.online_player_count,
		configured_rounds = excluded.configured_rounds,
		turn_duration_seconds = excluded.turn_duration_seconds,
		topic_pack = excluded.topic_pack,
		completed_turn_count = excluded.completed_turn_count,
		finished_game_count = excluded.finished_game_count,
		total_score = excluded.total_score,
		last_turn_spoken_seconds = excluded.last_turn_spoken_seconds
	WHERE (
		excluded.last_observed_at > room_facts.last_observed_at
		AND (
			excluded.last_milestone = 'created'
			OR excluded.state_version >= room_facts.state_version
		)
	)
	OR (
		excluded.last_observed_at = room_facts.last_observed_at
		AND excluded.state_version >= room_facts.state_version
	)
`;

const RECEIPT_GATED_ANALYTICS_SQL = `
	INSERT INTO analytics_daily (
		day, metric, event_count, value_sum, value_min, value_max, updated_at
	)
	SELECT ?, ?, 1, ?, ?, ?, ?
	WHERE ? = 1
		AND EXISTS (
			SELECT 1
			FROM room_milestone_receipts AS receipt
			JOIN platform_meta AS meta ON meta.id = 1 AND meta.schema_version = 6
			WHERE receipt.event_id = ?
				AND receipt.payload_hash = ?
				AND receipt.received_at = ?
				AND receipt.expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+90 days')
				AND receipt.applied_at IS NULL
				AND receipt.expires_at > ?
		)
	ON CONFLICT(day, metric) DO UPDATE SET
		event_count = analytics_daily.event_count + excluded.event_count,
		value_sum = analytics_daily.value_sum + excluded.value_sum,
		value_min = MIN(analytics_daily.value_min, excluded.value_min),
		value_max = MAX(analytics_daily.value_max, excluded.value_max),
		updated_at = excluded.updated_at
`;

const RECEIPT_APPLY_SQL = `
	UPDATE room_milestone_receipts
	SET applied_at = CASE WHEN received_at > ? THEN received_at ELSE ? END
	WHERE event_id = ?
		AND payload_hash = ?
		AND received_at = ?
		AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+90 days')
		AND applied_at IS NULL
		AND expires_at > ?
		AND EXISTS (
			SELECT 1 FROM platform_meta WHERE id = 1 AND schema_version = 6
		)
`;

const RECEIPT_READ_SQL = `
	SELECT payload_hash, applied_at, expires_at
	FROM room_milestone_receipts
	WHERE event_id = ?
		AND EXISTS (
			SELECT 1 FROM platform_meta WHERE id = 1 AND schema_version = 6
		)
	LIMIT 1
`;

export interface RoomMilestoneReceiverBindings {
	PLATFORM_DB: D1Database;
	PRODUCT_ANALYTICS?: AnalyticsEngineDataset;
	ROOM_FACT_HASH_KEY?: string;
}

export type RoomMilestoneReceiveResult =
	| { outcome: "applied" }
	| { outcome: "duplicate" }
	| { outcome: "conflict" }
	| { outcome: "invariant" };

interface ReceiptRow {
	payload_hash: unknown;
	applied_at: unknown;
	expires_at: unknown;
}

/**
 * Apply one trusted, canonical room event to D1. This is intentionally a strict
 * primitive: D1 and cryptographic failures propagate to the future outbox,
 * while only Analytics Engine remains best-effort after a committed first
 * application.
 */
export async function receiveRoomMilestone(
	env: RoomMilestoneReceiverBindings,
	input: unknown,
	receivedAt = new Date(),
): Promise<RoomMilestoneReceiveResult> {
	const delivery = normalizeRoomMilestoneDeliveryV1(input);
	const attemptTimestamp = receiverTimestamp(receivedAt);
	const schemaVersion = await requireSupportedPlatformSchema(env.PLATFORM_DB);
	if (schemaVersion !== 6) return { outcome: "invariant" };

	const payloadHash = await hashRoomMilestonePayloadV1(delivery.payloadJson);
	const roomFactHashKey = env.ROOM_FACT_HASH_KEY;
	const roomFactKeyConfigured = isSecureRoomFactHashKey(roomFactHashKey);
	const roomKey = roomFactKeyConfigured
		? await hashRoomInstanceId(delivery.payload.roomInstanceId, roomFactHashKey)
		: null;
	const factExpiresAt = roomFactExpiry(delivery.payload.occurredAt);
	const analyticsEnabled = delivery.payload.analyticsMetric !== null;
	const analyticsValue = delivery.payload.analyticsValue ?? 0;

	let results: D1Result<ReceiptRow>[];
	try {
		results = await env.PLATFORM_DB.batch<ReceiptRow>([
			env.PLATFORM_DB
				.prepare(RECEIPT_INSERT_SQL)
				.bind(
					delivery.eventId,
					payloadHash,
					attemptTimestamp,
					attemptTimestamp,
				),
			prepareRoomFactStatement(
				env.PLATFORM_DB,
				delivery.eventId,
				payloadHash,
				attemptTimestamp,
				delivery.payload,
				roomKey,
				factExpiresAt,
			),
			env.PLATFORM_DB
				.prepare(RECEIPT_GATED_ANALYTICS_SQL)
				.bind(
					delivery.payload.occurredAt.slice(0, 10),
					delivery.payload.analyticsMetric,
					analyticsValue,
					analyticsValue,
					analyticsValue,
					delivery.payload.occurredAt,
					analyticsEnabled ? 1 : 0,
					delivery.eventId,
					payloadHash,
					attemptTimestamp,
					attemptTimestamp,
					attemptTimestamp,
				),
			env.PLATFORM_DB
				.prepare(RECEIPT_APPLY_SQL)
				.bind(
					attemptTimestamp,
					attemptTimestamp,
					delivery.eventId,
					payloadHash,
					attemptTimestamp,
					attemptTimestamp,
					attemptTimestamp,
				),
			env.PLATFORM_DB.prepare(RECEIPT_READ_SQL).bind(delivery.eventId),
		]);
	} catch (error) {
		throw new PlatformError("DATABASE_UNAVAILABLE", "Could not apply the room milestone receipt.", {
			cause: error,
		});
	}

	const result = classifyReceiptResults(results, payloadHash);
	if (result.outcome === "applied" && analyticsEnabled) {
		try {
			env.PRODUCT_ANALYTICS?.writeDataPoint({
				indexes: [`event:${delivery.payload.analyticsMetric}`],
				blobs: [delivery.payload.analyticsMetric as string, "v1", "cloudflare"],
				doubles: [1, analyticsValue],
			});
		} catch (error) {
			logWorkerEvent("warn", "analytics_engine_write_failed", {
				metric: delivery.payload.analyticsMetric,
				error: safeErrorName(error),
			});
		}
	}
	return result;
}

function prepareRoomFactStatement(
	database: D1Database,
	eventId: string,
	payloadHash: string,
	attemptTimestamp: string,
	payload: NormalizedRoomMilestonePayloadV1,
	roomKey: string | null,
	factExpiresAt: string,
): D1PreparedStatement {
	return database
		.prepare(RECEIPT_GATED_ROOM_FACT_SQL)
		.bind(
			roomKey,
			payload.occurredAt,
			payload.occurredAt,
			factExpiresAt,
			payload.stateVersion,
			payload.milestone,
			payload.phase,
			payload.playerCount,
			payload.onlinePlayerCount,
			payload.configuredRounds,
			payload.turnDurationSeconds,
			payload.topicPack,
			payload.completedTurnCount,
			payload.finishedGameCount,
			payload.totalScore,
			payload.lastTurnSpokenSeconds,
			roomKey === null ? 0 : 1,
			eventId,
			payloadHash,
			attemptTimestamp,
			attemptTimestamp,
			attemptTimestamp,
		);
}

function classifyReceiptResults(
	results: readonly D1Result<ReceiptRow>[],
	payloadHash: string,
): RoomMilestoneReceiveResult {
	if (results.length !== 5) return { outcome: "invariant" };
	const inserted = resultChanges(results[0]);
	const applied = resultChanges(results[3]);
	if (![0, 1].includes(inserted) || ![0, 1].includes(applied)) return { outcome: "invariant" };
	const rows = results[4]?.results;
	if (!Array.isArray(rows) || rows.length !== 1) return { outcome: "invariant" };
	const row = rows[0];
	if (!row || typeof row !== "object") return { outcome: "invariant" };
	if (typeof row.payload_hash !== "string" || !LOWERCASE_HEX_256_PATTERN.test(row.payload_hash)) {
		return { outcome: "invariant" };
	}
	if (row.payload_hash !== payloadHash) return { outcome: "conflict" };
	if (row.applied_at !== null && !isCanonicalTimestamp(row.applied_at)) return { outcome: "invariant" };
	if (!isCanonicalTimestamp(row.expires_at)) return { outcome: "invariant" };
	if (inserted === 1 && applied === 1 && row.applied_at !== null) return { outcome: "applied" };
	if (inserted === 0 && applied === 0 && row.applied_at !== null) return { outcome: "duplicate" };
	return { outcome: "invariant" };
}

function isSecureRoomFactHashKey(value: string | undefined): value is string {
	if (typeof value !== "string") return false;
	const size = new TextEncoder().encode(value).byteLength;
	return size >= 32 && size <= 1_024;
}

async function hashRoomInstanceId(roomInstanceId: string, hashKey: string): Promise<string> {
	try {
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
	} catch (error) {
		throw new PlatformError("DATABASE_UNAVAILABLE", "The room-instance fact key could not be computed.", {
			cause: error,
		});
	}
}

function receiverTimestamp(value: Date): string {
	if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
		throw new PlatformError("INVALID_INPUT", "The milestone receipt time is invalid.");
	}
	const timestamp = value.toISOString();
	if (timestamp.length !== 24) {
		throw new PlatformError("INVALID_INPUT", "The milestone receipt time is outside the supported range.");
	}
	return timestamp;
}

function roomFactExpiry(occurredAt: string): string {
	const expiresAt = new Date(Date.parse(occurredAt) + ROOM_FACT_RETENTION_MS);
	if (!Number.isFinite(expiresAt.valueOf())) {
		throw new PlatformError("INVALID_INPUT", "The milestone time cannot produce a supported fact expiry.");
	}
	const timestamp = expiresAt.toISOString();
	if (timestamp.length !== 24) {
		throw new PlatformError("INVALID_INPUT", "The milestone fact expiry is outside the supported range.");
	}
	return timestamp;
}

function resultChanges(result: D1Result<unknown> | undefined): number {
	return Number(result?.meta.changes ?? Number.NaN);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length !== 24) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function safeErrorName(error: unknown): string {
	return error instanceof Error && error.name ? error.name : "UnknownError";
}
