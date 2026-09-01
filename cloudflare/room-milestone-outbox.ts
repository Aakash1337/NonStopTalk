import {
	PlatformError,
	type PublicRoomFactDraft,
} from "./platform";
import {
	MAX_ROOM_MILESTONE_PAYLOAD_BYTES,
	decodeRoomMilestonePayloadV1,
	encodeRoomMilestonePayloadV1,
	type DeliverableRoomMilestone,
} from "./room-milestone-contract";

export const ROOM_MILESTONE_OUTBOX_CAPACITY = 256;
export const ROOM_MILESTONE_DEAD_LETTER_CAPACITY = 256;
export const ROOM_MILESTONE_OUTBOX_DEADLINE_MS = 7 * 24 * 60 * 60 * 1_000;
export const ROOM_MILESTONE_DEAD_LETTER_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const ROOM_MILESTONE_MAX_ATTEMPTS = 16;
export const ROOM_MILESTONE_DROP_COUNT_MAX = 2_147_483_647;
export const ROOM_MILESTONE_PURGE_BATCH_MAX = 256;

const ROOM_MILESTONE_OUTBOX_SCHEMA_VERSION = 1;
const LOWERCASE_HEX_256_PATTERN = /^[0-9a-f]{64}$/u;
const RETRY_DELAYS_MS = [
	5_000,
	30_000,
	2 * 60_000,
	10 * 60_000,
	60 * 60_000,
	6 * 60 * 60_000,
	24 * 60 * 60_000,
] as const;

const DROP_REASONS = new Set(["capacity", "canonicalization"] as const);
const RETRY_FAILURES = new Set([
	"database-unavailable",
	"receiver-invariant",
	"local-finalization-failed",
] as const);
const DEAD_LETTER_REASONS = new Set([
	"conflict",
	"deadline-exceeded",
	"attempts-exhausted",
	"invalid-payload",
	"receiver-invariant",
] as const);

export type RoomMilestoneDropReason = "capacity" | "canonicalization";
export type RoomMilestoneRetryFailure =
	| "database-unavailable"
	| "receiver-invariant"
	| "local-finalization-failed";
export type RoomMilestoneDeadLetterReason =
	| "conflict"
	| "deadline-exceeded"
	| "attempts-exhausted"
	| "invalid-payload"
	| "receiver-invariant";

export type RoomMilestoneRandomBytes = (bytes: Uint8Array) => void;

export interface RoomMilestoneOutboxMetadata {
	roomInstanceId: string;
	droppedTotal: number;
	droppedCapacity: number;
	droppedCanonicalization: number;
	lastDropReason: RoomMilestoneDropReason | null;
	lastDroppedAtMs: number | null;
}

export interface QueuedRoomMilestone {
	sequence: number;
	eventId: string;
	payloadJson: string;
	milestone: DeliverableRoomMilestone;
}

export interface RoomMilestoneOutboxHead extends QueuedRoomMilestone {
	createdAtMs: number;
	deadlineAtMs: number;
	attemptCount: number;
	nextAttemptAtMs: number;
	lastFailure: RoomMilestoneRetryFailure | null;
}

export type RoomMilestoneEnqueueResult =
	| { outcome: "queued"; events: readonly QueuedRoomMilestone[] }
	| { outcome: "dropped"; reason: RoomMilestoneDropReason; droppedCount: number };

export type RoomMilestoneRetryResult =
	| { outcome: "retry"; attemptCount: number; nextAttemptAtMs: number }
	| { outcome: "dead-lettered"; reason: "deadline-exceeded" | "attempts-exhausted" }
	| { outcome: "stale" };

/**
 * Classify only bounded contract failures as a fail-open telemetry drop.
 * Storage and programming failures must continue to throw so the surrounding
 * room-state transaction can roll back.
 */
export function isRoomMilestoneCanonicalizationError(error: unknown): boolean {
	return error instanceof PlatformError
		&& (error.code === "INVALID_INPUT" || error.code === "PAYLOAD_TOO_LARGE");
}

/** Record a known all-or-drop producer outcome without retaining payload data. */
export function recordRoomMilestoneDrop(
	sql: SqlStorage,
	reason: RoomMilestoneDropReason,
	count: number,
	droppedAtMs: number,
): Extract<RoomMilestoneEnqueueResult, { outcome: "dropped" }> {
	const normalizedAt = safeTimestamp(droppedAtMs, "outbox drop time");
	const normalizedCount = boundedInteger(count, 1, Number.MAX_SAFE_INTEGER, "dropped event count");
	recordDrop(sql, reason, normalizedCount, normalizedAt);
	return { outcome: "dropped", reason, droppedCount: normalizedCount };
}

interface MetadataRow {
	[key: string]: SqlStorageValue;
	schema_version: SqlStorageValue;
	room_instance_id: SqlStorageValue;
	dropped_total: SqlStorageValue;
	dropped_capacity: SqlStorageValue;
	dropped_canonicalization: SqlStorageValue;
	last_drop_reason: SqlStorageValue;
	last_dropped_at_ms: SqlStorageValue;
}

interface OutboxRow {
	[key: string]: SqlStorageValue;
	sequence: SqlStorageValue;
	event_id: SqlStorageValue;
	payload_json: SqlStorageValue;
	milestone: SqlStorageValue;
	created_at_ms: SqlStorageValue;
	deadline_at_ms: SqlStorageValue;
	attempt_count: SqlStorageValue;
	next_attempt_at_ms: SqlStorageValue;
	last_failure: SqlStorageValue;
}

/**
 * Create or migrate the local schema without changing a legacy room_state row.
 * Every helper is synchronous so its caller can compose it inside one
 * DurableObjectStorage.transaction() with the room mutation and alarm write.
 */
export function initializeRoomMilestoneOutbox(
	sql: SqlStorage,
	randomBytes: RoomMilestoneRandomBytes = fillCryptoRandom,
): RoomMilestoneOutboxMetadata {
	sql.exec(`CREATE TABLE IF NOT EXISTS room_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		json TEXT NOT NULL
	)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS room_milestone_meta (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		schema_version INTEGER NOT NULL CHECK (schema_version = 1),
		room_instance_id TEXT NOT NULL UNIQUE CHECK (
			length(room_instance_id) = 64
			AND room_instance_id NOT GLOB '*[^0-9a-f]*'
		),
		dropped_total INTEGER NOT NULL DEFAULT 0 CHECK (
			typeof(dropped_total) = 'integer' AND dropped_total BETWEEN 0 AND ${ROOM_MILESTONE_DROP_COUNT_MAX}
		),
		dropped_capacity INTEGER NOT NULL DEFAULT 0 CHECK (
			typeof(dropped_capacity) = 'integer' AND dropped_capacity BETWEEN 0 AND ${ROOM_MILESTONE_DROP_COUNT_MAX}
		),
		dropped_canonicalization INTEGER NOT NULL DEFAULT 0 CHECK (
			typeof(dropped_canonicalization) = 'integer'
			AND dropped_canonicalization BETWEEN 0 AND ${ROOM_MILESTONE_DROP_COUNT_MAX}
		),
		last_drop_reason TEXT CHECK (
			last_drop_reason IS NULL OR last_drop_reason IN ('capacity', 'canonicalization')
		),
		last_dropped_at_ms INTEGER CHECK (
			last_dropped_at_ms IS NULL OR (
				typeof(last_dropped_at_ms) = 'integer'
				AND last_dropped_at_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
			)
		),
		CHECK ((last_drop_reason IS NULL) = (last_dropped_at_ms IS NULL)),
		CHECK (dropped_total >= dropped_capacity AND dropped_total >= dropped_canonicalization)
	)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS room_milestone_outbox (
		sequence INTEGER PRIMARY KEY AUTOINCREMENT,
		event_id TEXT NOT NULL UNIQUE CHECK (
			length(event_id) = 64 AND event_id NOT GLOB '*[^0-9a-f]*'
		),
		payload_json TEXT NOT NULL CHECK (
			typeof(payload_json) = 'text'
			AND length(CAST(payload_json AS BLOB)) BETWEEN 2 AND ${MAX_ROOM_MILESTONE_PAYLOAD_BYTES}
			AND json_valid(payload_json)
		),
		milestone TEXT NOT NULL CHECK (
			milestone IN ('created', 'joined', 'game-started', 'turn-completed', 'game-finished', 'reset')
		),
		created_at_ms INTEGER NOT NULL CHECK (
			typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
		),
		deadline_at_ms INTEGER NOT NULL CHECK (
			typeof(deadline_at_ms) = 'integer'
			AND deadline_at_ms = created_at_ms + ${ROOM_MILESTONE_OUTBOX_DEADLINE_MS}
			AND deadline_at_ms <= ${Number.MAX_SAFE_INTEGER}
		),
		attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
			typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND ${ROOM_MILESTONE_MAX_ATTEMPTS}
		),
		next_attempt_at_ms INTEGER NOT NULL CHECK (
			typeof(next_attempt_at_ms) = 'integer'
			AND next_attempt_at_ms BETWEEN created_at_ms AND deadline_at_ms
		),
		last_failure TEXT CHECK (
			last_failure IS NULL OR last_failure IN (
				'database-unavailable', 'receiver-invariant', 'local-finalization-failed'
			)
		),
		CHECK ((attempt_count = 0) = (last_failure IS NULL))
	)`);
	sql.exec(`CREATE INDEX IF NOT EXISTS room_milestone_outbox_due_idx
		ON room_milestone_outbox (sequence, next_attempt_at_ms)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS room_milestone_dead_letters (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		reason TEXT NOT NULL CHECK (
			reason IN ('conflict', 'deadline-exceeded', 'attempts-exhausted',
				'invalid-payload', 'receiver-invariant')
		),
		milestone TEXT NOT NULL CHECK (
			milestone IN ('created', 'joined', 'game-started', 'turn-completed', 'game-finished', 'reset')
		),
		attempt_count INTEGER NOT NULL CHECK (
			typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND ${ROOM_MILESTONE_MAX_ATTEMPTS}
		),
		failed_at_ms INTEGER NOT NULL CHECK (
			typeof(failed_at_ms) = 'integer' AND failed_at_ms BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
		),
		purge_at_ms INTEGER NOT NULL CHECK (
			typeof(purge_at_ms) = 'integer'
			AND purge_at_ms = failed_at_ms + ${ROOM_MILESTONE_DEAD_LETTER_RETENTION_MS}
			AND purge_at_ms <= ${Number.MAX_SAFE_INTEGER}
		)
	)`);
	sql.exec(`CREATE INDEX IF NOT EXISTS room_milestone_dead_letters_purge_idx
		ON room_milestone_dead_letters (purge_at_ms, id)`);

	const existing = metadataRow(sql);
	if (!existing) {
		const roomInstanceId = randomHex256(randomBytes);
		sql.exec(
			`INSERT INTO room_milestone_meta (
				id, schema_version, room_instance_id, dropped_total,
				dropped_capacity, dropped_canonicalization,
				last_drop_reason, last_dropped_at_ms
			) VALUES (1, ?, ?, 0, 0, 0, NULL, NULL)`,
			ROOM_MILESTONE_OUTBOX_SCHEMA_VERSION,
			roomInstanceId,
		);
	}
	return readRoomMilestoneOutboxMetadata(sql);
}

export function readRoomMilestoneOutboxMetadata(sql: SqlStorage): RoomMilestoneOutboxMetadata {
	const row = metadataRow(sql);
	if (!row) throw storageInvariant("Room milestone metadata is missing.");
	if (row.schema_version !== ROOM_MILESTONE_OUTBOX_SCHEMA_VERSION) {
		throw storageInvariant("Room milestone metadata has an unsupported schema version.");
	}
	const roomInstanceId = strictHex256(row.room_instance_id, "room instance ID");
	const droppedTotal = boundedInteger(row.dropped_total, 0, ROOM_MILESTONE_DROP_COUNT_MAX, "dropped total");
	const droppedCapacity = boundedInteger(
		row.dropped_capacity,
		0,
		ROOM_MILESTONE_DROP_COUNT_MAX,
		"capacity drop count",
	);
	const droppedCanonicalization = boundedInteger(
		row.dropped_canonicalization,
		0,
		ROOM_MILESTONE_DROP_COUNT_MAX,
		"canonicalization drop count",
	);
	const lastDropReason = row.last_drop_reason === null
		? null
		: enumValue(row.last_drop_reason, DROP_REASONS, "last drop reason");
	const lastDroppedAtMs = row.last_dropped_at_ms === null
		? null
		: safeTimestamp(row.last_dropped_at_ms, "last dropped time");
	if ((lastDropReason === null) !== (lastDroppedAtMs === null)) {
		throw storageInvariant("Room milestone drop metadata is inconsistent.");
	}
	if (droppedTotal < droppedCapacity || droppedTotal < droppedCanonicalization) {
		throw storageInvariant("Room milestone drop counters are inconsistent.");
	}
	return {
		roomInstanceId,
		droppedTotal,
		droppedCapacity,
		droppedCanonicalization,
		lastDropReason,
		lastDroppedAtMs,
	};
}

export function enqueueRoomMilestones(
	sql: SqlStorage,
	facts: readonly PublicRoomFactDraft[],
	nowMs: number,
	randomBytes: RoomMilestoneRandomBytes = fillCryptoRandom,
): RoomMilestoneEnqueueResult {
	const createdAtMs = safeTimestamp(nowMs, "outbox enqueue time");
	const requestedCount = Array.isArray(facts) ? facts.length : 1;
	if (!Array.isArray(facts) || facts.length < 1) {
		return recordRoomMilestoneDrop(
			sql,
			"canonicalization",
			Math.max(1, requestedCount),
			createdAtMs,
		);
	}
	const existingCount = readCount(sql, "room_milestone_outbox");
	if (facts.length > ROOM_MILESTONE_OUTBOX_CAPACITY - existingCount) {
		return recordRoomMilestoneDrop(sql, "capacity", facts.length, createdAtMs);
	}

	const metadata = readRoomMilestoneOutboxMetadata(sql);
	let payloads: Array<{ payloadJson: string; milestone: DeliverableRoomMilestone }>;
	try {
		payloads = facts.map((fact) => {
			const payloadJson = encodeRoomMilestonePayloadV1(metadata.roomInstanceId, fact);
			const payload = decodeRoomMilestonePayloadV1(payloadJson);
			return { payloadJson, milestone: payload.milestone };
		});
	} catch (error) {
		if (!isRoomMilestoneCanonicalizationError(error)) throw error;
		return recordRoomMilestoneDrop(sql, "canonicalization", facts.length, createdAtMs);
	}

	const eventIds = new Set<string>();
	const events: QueuedRoomMilestone[] = [];
	const deadlineAtMs = checkedAdd(createdAtMs, ROOM_MILESTONE_OUTBOX_DEADLINE_MS, "outbox deadline");
	for (const payload of payloads) {
		const eventId = randomHex256(randomBytes);
		if (eventIds.has(eventId)) throw storageInvariant("The random source repeated a milestone event ID.");
		eventIds.add(eventId);
		const rows = sql.exec<{ sequence: number }>(
			`INSERT INTO room_milestone_outbox (
				event_id, payload_json, milestone, created_at_ms, deadline_at_ms,
				attempt_count, next_attempt_at_ms, last_failure
			) VALUES (?, ?, ?, ?, ?, 0, ?, NULL)
			RETURNING sequence`,
			eventId,
			payload.payloadJson,
			payload.milestone,
			createdAtMs,
			deadlineAtMs,
			createdAtMs,
		).toArray();
		if (rows.length !== 1) throw storageInvariant("A milestone event could not be enqueued.");
		events.push({
			sequence: boundedInteger(rows[0]?.sequence, 1, Number.MAX_SAFE_INTEGER, "outbox sequence"),
			eventId,
			payloadJson: payload.payloadJson,
			milestone: payload.milestone,
		});
	}
	return { outcome: "queued", events };
}

export function readRoomMilestoneOutboxHead(sql: SqlStorage): RoomMilestoneOutboxHead | null {
	const row = sql.exec<OutboxRow>(`SELECT
		sequence, event_id, payload_json, milestone, created_at_ms, deadline_at_ms,
		attempt_count, next_attempt_at_ms, last_failure
	FROM room_milestone_outbox
	ORDER BY sequence
	LIMIT 1`).toArray()[0];
	if (!row) return null;
	return outboxHeadFromRow(row);
}

export function acknowledgeRoomMilestone(sql: SqlStorage, expected: RoomMilestoneOutboxHead): boolean {
	const changes = rowsWritten(sql.exec(
		`DELETE FROM room_milestone_outbox
		WHERE sequence = ? AND event_id = ? AND payload_json = ? AND attempt_count = ?`,
		expected.sequence,
		expected.eventId,
		expected.payloadJson,
		expected.attemptCount,
	));
	return changes === 1;
}

export function recordRoomMilestoneRetry(
	sql: SqlStorage,
	expected: RoomMilestoneOutboxHead,
	failure: RoomMilestoneRetryFailure,
	failedAtMs: number,
): RoomMilestoneRetryResult {
	const normalizedFailure = enumValue(failure, RETRY_FAILURES, "retry failure");
	const failedAt = safeTimestamp(failedAtMs, "retry failure time");
	if (failedAt >= expected.deadlineAtMs) {
		return deadLetterRoomMilestone(sql, expected, "deadline-exceeded", failedAt)
			? { outcome: "dead-lettered", reason: "deadline-exceeded" }
			: { outcome: "stale" };
	}
	const attemptCount = expected.attemptCount + 1;
	if (attemptCount >= ROOM_MILESTONE_MAX_ATTEMPTS) {
		return deadLetterWithAttemptCount(sql, expected, "attempts-exhausted", failedAt, attemptCount)
			? { outcome: "dead-lettered", reason: "attempts-exhausted" }
			: { outcome: "stale" };
	}
	const nextAttemptAtMs = Math.min(
		expected.deadlineAtMs,
		checkedAdd(failedAt, roomMilestoneRetryDelayMs(expected.eventId, attemptCount), "retry time"),
	);
	const changes = rowsWritten(sql.exec(
		`UPDATE room_milestone_outbox
		SET attempt_count = ?, next_attempt_at_ms = ?, last_failure = ?
		WHERE sequence = ? AND event_id = ? AND payload_json = ? AND attempt_count = ?`,
		attemptCount,
		nextAttemptAtMs,
		normalizedFailure,
		expected.sequence,
		expected.eventId,
		expected.payloadJson,
		expected.attemptCount,
	));
	return changes === 1
		? { outcome: "retry", attemptCount, nextAttemptAtMs }
		: { outcome: "stale" };
}

export function deadLetterRoomMilestone(
	sql: SqlStorage,
	expected: RoomMilestoneOutboxHead,
	reason: RoomMilestoneDeadLetterReason,
	failedAtMs: number,
): boolean {
	return deadLetterWithAttemptCount(
		sql,
		expected,
		enumValue(reason, DEAD_LETTER_REASONS, "dead-letter reason"),
		safeTimestamp(failedAtMs, "dead-letter time"),
		expected.attemptCount,
	);
}

export function deadLetterExpiredRoomMilestone(
	sql: SqlStorage,
	expected: RoomMilestoneOutboxHead,
	nowMs: number,
): boolean {
	const now = safeTimestamp(nowMs, "deadline check time");
	return now >= expected.deadlineAtMs
		? deadLetterRoomMilestone(sql, expected, "deadline-exceeded", now)
		: false;
}

export function purgeExpiredRoomMilestoneDeadLetters(
	sql: SqlStorage,
	nowMs: number,
	limit = 64,
): number {
	const now = safeTimestamp(nowMs, "dead-letter purge time");
	const boundedLimit = boundedInteger(limit, 1, ROOM_MILESTONE_PURGE_BATCH_MAX, "dead-letter purge limit");
	return rowsWritten(sql.exec(
		`DELETE FROM room_milestone_dead_letters
		WHERE id IN (
			SELECT id FROM room_milestone_dead_letters
			WHERE purge_at_ms <= ?
			ORDER BY purge_at_ms, id
			LIMIT ?
		)`,
		now,
		boundedLimit,
	));
}

/** The outbox owns only its delivery/dead-letter due time; the room adds its TTL. */
export function readNextRoomMilestoneAlarmAt(sql: SqlStorage): number | null {
	const pending = sql.exec<{ due_at_ms: number | null }>(`SELECT
		MIN(next_attempt_at_ms, deadline_at_ms) AS due_at_ms
	FROM room_milestone_outbox
	ORDER BY sequence
	LIMIT 1`).toArray()[0]?.due_at_ms;
	const purge = sql.exec<{ due_at_ms: number | null }>(`SELECT MIN(purge_at_ms) AS due_at_ms
	FROM room_milestone_dead_letters`).toArray()[0]?.due_at_ms;
	const values = [pending, purge]
		.filter((value): value is Exclude<typeof value, null | undefined> => value !== null && value !== undefined)
		.map((value) => safeTimestamp(value, "outbox alarm time"));
	return values.length ? Math.min(...values) : null;
}

/** Deterministic non-security jitter in the inclusive range [80%, 120%]. */
export function roomMilestoneRetryDelayMs(eventId: string, attemptCount: number): number {
	const normalizedEventId = strictHex256(eventId, "retry event ID");
	const normalizedAttempt = boundedInteger(
		attemptCount,
		1,
		ROOM_MILESTONE_MAX_ATTEMPTS,
		"retry attempt count",
	);
	const base = RETRY_DELAYS_MS[Math.min(normalizedAttempt, RETRY_DELAYS_MS.length) - 1] ?? 24 * 60 * 60_000;
	let hash = 2_166_136_261;
	for (const character of `${normalizedEventId}:${normalizedAttempt}`) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16_777_619) >>> 0;
	}
	const basisPoints = 8_000 + (hash % 4_001);
	return Math.floor((base * basisPoints) / 10_000);
}

function deadLetterWithAttemptCount(
	sql: SqlStorage,
	expected: RoomMilestoneOutboxHead,
	reason: RoomMilestoneDeadLetterReason,
	failedAtMs: number,
	attemptCount: number,
): boolean {
	const normalizedAttempt = boundedInteger(
		attemptCount,
		0,
		ROOM_MILESTONE_MAX_ATTEMPTS,
		"dead-letter attempt count",
	);
	const exists = sql.exec<{ present: number }>(`SELECT 1 AS present
		FROM room_milestone_outbox
		WHERE sequence = ? AND event_id = ? AND payload_json = ? AND attempt_count = ?
		LIMIT 1`, expected.sequence, expected.eventId, expected.payloadJson, expected.attemptCount).toArray()[0];
	if (exists?.present !== 1) return false;
	const purgeAtMs = checkedAdd(
		failedAtMs,
		ROOM_MILESTONE_DEAD_LETTER_RETENTION_MS,
		"dead-letter purge time",
	);
	sql.exec(
		`INSERT INTO room_milestone_dead_letters (
			reason, milestone, attempt_count, failed_at_ms, purge_at_ms
		) VALUES (?, ?, ?, ?, ?)`,
		reason,
		expected.milestone,
		normalizedAttempt,
		failedAtMs,
		purgeAtMs,
	);
	const deleted = acknowledgeRoomMilestone(sql, expected);
	if (!deleted) throw storageInvariant("A dead-lettered milestone could not be removed from the queue.");
	capDeadLetters(sql);
	return true;
}

function capDeadLetters(sql: SqlStorage): void {
	sql.exec(`DELETE FROM room_milestone_dead_letters
		WHERE id NOT IN (
			SELECT id FROM room_milestone_dead_letters
			ORDER BY failed_at_ms DESC, id DESC
			LIMIT ${ROOM_MILESTONE_DEAD_LETTER_CAPACITY}
		)`);
}

function recordDrop(
	sql: SqlStorage,
	reason: RoomMilestoneDropReason,
	count: number,
	droppedAtMs: number,
): void {
	const normalizedReason = enumValue(reason, DROP_REASONS, "drop reason");
	const increment = Math.min(
		ROOM_MILESTONE_DROP_COUNT_MAX,
		boundedInteger(count, 1, Number.MAX_SAFE_INTEGER, "dropped event count"),
	);
	const column = normalizedReason === "capacity" ? "dropped_capacity" : "dropped_canonicalization";
	const changes = rowsWritten(sql.exec(
		`UPDATE room_milestone_meta
		SET dropped_total = MIN(?, dropped_total + ?),
			${column} = MIN(?, ${column} + ?),
			last_drop_reason = ?, last_dropped_at_ms = ?
		WHERE id = 1 AND schema_version = ?`,
		ROOM_MILESTONE_DROP_COUNT_MAX,
		increment,
		ROOM_MILESTONE_DROP_COUNT_MAX,
		increment,
		normalizedReason,
		droppedAtMs,
		ROOM_MILESTONE_OUTBOX_SCHEMA_VERSION,
	));
	if (changes !== 1) throw storageInvariant("Room milestone drop telemetry could not be updated.");
}

function outboxHeadFromRow(row: OutboxRow): RoomMilestoneOutboxHead {
	const sequence = boundedInteger(row.sequence, 1, Number.MAX_SAFE_INTEGER, "outbox sequence");
	const eventId = strictHex256(row.event_id, "outbox event ID");
	if (typeof row.payload_json !== "string") throw storageInvariant("Outbox payload is not text.");
	const payloadSize = new TextEncoder().encode(row.payload_json).byteLength;
	if (payloadSize < 2 || payloadSize > MAX_ROOM_MILESTONE_PAYLOAD_BYTES) {
		throw storageInvariant("Outbox payload size is invalid.");
	}
	const milestone = enumValue(
		row.milestone,
		new Set(["created", "joined", "game-started", "turn-completed", "game-finished", "reset"] as const),
		"outbox milestone",
	);
	const createdAtMs = safeTimestamp(row.created_at_ms, "outbox creation time");
	const deadlineAtMs = safeTimestamp(row.deadline_at_ms, "outbox deadline");
	if (deadlineAtMs !== checkedAdd(createdAtMs, ROOM_MILESTONE_OUTBOX_DEADLINE_MS, "outbox deadline")) {
		throw storageInvariant("Outbox deadline is inconsistent.");
	}
	const attemptCount = boundedInteger(
		row.attempt_count,
		0,
		ROOM_MILESTONE_MAX_ATTEMPTS,
		"outbox attempt count",
	);
	const nextAttemptAtMs = safeTimestamp(row.next_attempt_at_ms, "outbox next attempt time");
	if (nextAttemptAtMs < createdAtMs || nextAttemptAtMs > deadlineAtMs) {
		throw storageInvariant("Outbox next attempt time is inconsistent.");
	}
	const lastFailure = row.last_failure === null
		? null
		: enumValue(row.last_failure, RETRY_FAILURES, "outbox retry failure");
	if ((attemptCount === 0) !== (lastFailure === null)) {
		throw storageInvariant("Outbox retry metadata is inconsistent.");
	}
	return {
		sequence,
		eventId,
		payloadJson: row.payload_json,
		milestone,
		createdAtMs,
		deadlineAtMs,
		attemptCount,
		nextAttemptAtMs,
		lastFailure,
	};
}

function metadataRow(sql: SqlStorage): MetadataRow | undefined {
	return sql.exec<MetadataRow>(`SELECT
		schema_version, room_instance_id, dropped_total, dropped_capacity,
		dropped_canonicalization, last_drop_reason, last_dropped_at_ms
	FROM room_milestone_meta
	WHERE id = 1
	LIMIT 1`).toArray()[0];
}

function readCount(sql: SqlStorage, table: "room_milestone_outbox"): number {
	const row = sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0];
	return boundedInteger(row?.count, 0, ROOM_MILESTONE_OUTBOX_CAPACITY, `${table} count`);
}

function randomHex256(randomBytes: RoomMilestoneRandomBytes): string {
	const bytes = new Uint8Array(32);
	randomBytes(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fillCryptoRandom(bytes: Uint8Array): void {
	crypto.getRandomValues(bytes);
}

function rowsWritten(cursor: { rowsWritten: number }): number {
	return boundedInteger(cursor.rowsWritten, 0, Number.MAX_SAFE_INTEGER, "SQL rows written");
}

function checkedAdd(value: number, increment: number, label: string): number {
	const result = value + increment;
	if (!Number.isSafeInteger(result) || result < 0) throw storageInvariant(`${label} is outside the supported range.`);
	return result;
}

function safeTimestamp(value: unknown, label: string): number {
	return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw storageInvariant(`${label} is invalid.`);
	}
	return value;
}

function strictHex256(value: unknown, label: string): string {
	if (typeof value !== "string" || !LOWERCASE_HEX_256_PATTERN.test(value)) {
		throw storageInvariant(`${label} is invalid.`);
	}
	return value;
}

function enumValue<const Value extends string>(
	value: unknown,
	allowed: ReadonlySet<Value>,
	label: string,
): Value {
	if (typeof value !== "string" || !allowed.has(value as Value)) {
		throw storageInvariant(`${label} is invalid.`);
	}
	return value as Value;
}

function storageInvariant(message: string): Error {
	return new Error(message);
}
