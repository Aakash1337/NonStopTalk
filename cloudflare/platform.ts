/**
 * Centralized, privacy-bounded D1 data access for the Cloudflare edition.
 *
 * The browser identity token is accepted only at this module's public boundary,
 * hashed with SHA-256, and never bound to a statement or returned to a caller.
 * Coaching payloads are rebuilt from an allowlist before they can reach D1.
 */

import { prepareSyncIdentityTouch, type DeviceKey } from "./sync-identity";

export type { DeviceKey } from "./sync-identity";

export const CLOUD_SUMMARY_POLICY_VERSION = "cloud-summary-v1";
export const ANONYMOUS_DATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const ROOM_FACT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const MAX_CLOUD_SUMMARY_BYTES = 64 * 1_024;
export const MAX_COACHING_PAGE_SIZE = 100;
export const MAX_COACHING_EXPORT_SIZE = 5_000;
export const MAX_ACTIVE_COACHING_SUMMARIES = 250;
export const RETENTION_CLEANUP_BATCH_SIZE = 500;

const DEVICE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const DEVICE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const SCENARIOS = new Set(["interview", "presentation", "impromptu"] as const);
const GOALS = new Set(["pace", "pauses", "energy"] as const);
const AUDIO_CONFIDENCE = new Set(["low", "medium", "high", "unknown"] as const);
const ATTEMPT_ROLES = new Set(["standalone", "baseline", "retry"] as const);
const FEEDBACK_MODES = new Set(["live-cues", "review-only"] as const);
const TOPIC_PACKS = new Set(["everyday", "story", "absurd", "debate", "expert", "custom"] as const);

const FORBIDDEN_CLOUD_KEYS = new Set([
	"audio",
	"audioblob",
	"audiodata",
	"rawaudio",
	"recording",
	"recordingblob",
	"transcript",
	"transcripttext",
	"capturedtranscript",
	"capturedtranscripttext",
	"fulltranscript",
	"rawtranscript",
	"pcm",
	"waveform",
	"samples",
	"sampleframes",
	"segments",
]);

const SUMMARY_COLUMNS = `
	session_id,
	analysis_schema_version,
	client_created_at,
	received_at,
	updated_at,
	scenario,
	goal,
	target_duration_ms,
	duration_ms,
	speaking_ratio,
	pause_count,
	audio_confidence,
	transcript_metrics_used,
	practice_loop_id,
	baseline_attempt_id,
	attempt_role,
	summary_json
`;

export type CoachingScenario = "interview" | "presentation" | "impromptu";
export type CoachingGoal = "pace" | "pauses" | "energy";
export type AudioConfidence = "low" | "medium" | "high" | "unknown";
export type CoachingAttemptRole = "standalone" | "baseline" | "retry";
export type CoachingFeedbackMode = "live-cues" | "review-only";

export interface WordPattern {
	phrase: string;
	count: number;
}

export interface RepeatedWordPattern {
	word: string;
	count: number;
}

export interface TranscriptMetrics {
	wordCount: number;
	wordsPerMinute: number;
	fillerCount: number;
	repeatedWordCount: number;
	fillerRatePer100Words: number;
	repetitionRatePer100Words: number;
	fillerOccurrences: WordPattern[];
	repeatedWords: RepeatedWordPattern[];
}

export interface CoachingMetrics {
	durationMs: number;
	voicedMs: number;
	speakingRatio: number;
	pauseCount: number;
	observedDurationMs: number;
	unknownMs: number;
	coverageRatio: number;
	maxSampleGapMs: number;
	medianPauseMs: number;
	longestPauseMs: number;
	longestSpeakingRunMs: number;
	levelConsistencyPct: number | null;
	clippingPct: number;
	audioConfidence: AudioConfidence;
	transcriptMetrics: TranscriptMetrics | null;
}

export interface CoachingAdvice {
	strength: string;
	strengthEvidence: string;
	focus: string;
	focusEvidence: string;
	drill: string;
	drillDetail: string;
}

/** Metadata about browser-local artifacts. The artifacts themselves are forbidden. */
export interface LocalArtifactMetadata {
	audioStored: boolean;
	audioBytes: number;
	audioMimeType: string;
	transcriptStored: boolean;
	transcriptMayBePartial: boolean;
}

/** Exact schema currently produced by buildCoachingSummary in public/app.js. */
export interface CoachingSummary {
	analysisSchemaVersion: 2;
	id: string;
	createdAt: string;
	scenario: CoachingScenario;
	goal: CoachingGoal;
	targetDurationMs: number;
	metrics: CoachingMetrics;
	advice: CoachingAdvice;
	artifacts?: LocalArtifactMetadata;
	/** Optional for backward compatibility with pre-loop analysis-v2 summaries. */
	practiceLoopId?: string | null;
	baselineAttemptId?: string | null;
	attemptRole?: CoachingAttemptRole;
	feedbackMode?: CoachingFeedbackMode;
}

export type ExportedCoachingSummary = Omit<CoachingSummary, "artifacts">;

export type PlatformErrorCode =
	| "INVALID_INPUT"
	| "PAYLOAD_TOO_LARGE"
	| "FORBIDDEN_CLOUD_DATA"
	| "INVALID_IDENTITY"
	| "INVALID_CURSOR"
	| "CONSENT_REQUIRED"
	| "STORAGE_LIMIT_REACHED"
	| "NOT_FOUND"
	| "CONFLICT"
	| "DATABASE_UNAVAILABLE";

const DEFAULT_ERROR_STATUS: Record<PlatformErrorCode, number> = {
	INVALID_INPUT: 400,
	PAYLOAD_TOO_LARGE: 413,
	FORBIDDEN_CLOUD_DATA: 422,
	INVALID_IDENTITY: 401,
	INVALID_CURSOR: 400,
	CONSENT_REQUIRED: 403,
	STORAGE_LIMIT_REACHED: 409,
	NOT_FOUND: 404,
	CONFLICT: 409,
	DATABASE_UNAVAILABLE: 503,
};

export class PlatformError extends Error {
	readonly code: PlatformErrorCode;
	readonly status: number;

	constructor(
		code: PlatformErrorCode,
		message: string,
		options: { status?: number; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "PlatformError";
		this.code = code;
		this.status = options.status ?? DEFAULT_ERROR_STATUS[code];
	}
}

export interface CloudSummaryConsent {
	purpose: "cloud_summary";
	granted: boolean;
	policyVersion: string;
	grantedAt: string | null;
	revokedAt: string | null;
	updatedAt: string;
}

export interface SavedCoachingSummary {
	created: boolean;
	summary: CoachingSummary;
	/** True only when this request changed consent from absent/revoked/older-policy to granted. */
	consentGranted?: boolean;
}

export interface CoachingListCursor {
	createdAt: string;
	id: string;
}

export interface CoachingListOptions {
	limit?: number;
	cursor?: string | null;
}

export interface CoachingSummaryPage {
	sessions: CoachingSummary[];
	nextCursor: string | null;
}

export interface CoachingSummaryExport {
	product: "NonStopTalk";
	schemaVersion: 2;
	exportedAt: string;
	privacy: string;
	sessions: ExportedCoachingSummary[];
	truncated: boolean;
}

export type AnalyticsEventInput =
	| { type: "room_created" }
	| { type: "room_joined" }
	| { type: "game_started" }
	| { type: "turn_completed"; spokenSeconds: number }
	| { type: "game_finished"; turns: number }
	| { type: "coaching_summary_saved"; durationMs: number }
	| { type: "coaching_summary_deleted"; deletedCount: number }
	| { type: "cloud_consent_granted" }
	| { type: "cloud_consent_revoked" };

export type AnalyticsMetric = AnalyticsEventInput["type"];

export interface DailyAnalyticsDelta {
	day: string;
	metric: AnalyticsMetric;
	eventCount: 1;
	valueSum: number;
}

export interface DailyAnalyticsRow {
	day: string;
	metric: AnalyticsMetric;
	eventCount: number;
	valueSum: number;
	valueMin: number;
	valueMax: number;
	updatedAt: string;
}

export type RoomMilestone =
	| "created"
	| "joined"
	| "game-started"
	| "turn-completed"
	| "game-finished"
	| "reset"
	| "snapshot";

export interface PublicRoomFactDraft {
	roomCode: string;
	stateVersion: number;
	observedAt: string;
	milestone: RoomMilestone;
	phase: "setup" | "playing" | "finished";
	playerCount: number;
	onlinePlayerCount: number;
	configuredRounds: number;
	turnDurationSeconds: number;
	topicPack: "everyday" | "story" | "absurd" | "debate" | "expert" | "custom";
	completedTurnCount: number;
	finishedGameCount: number;
	totalScore: number;
	lastTurnSpokenSeconds: number;
}

export interface RoomFact extends Omit<PublicRoomFactDraft, "roomCode"> {
	roomKey: string;
	firstObservedAt: string;
	expiresAt: string;
}

export interface ProtectedSummaryQuery {
	sql: string;
	bindings: [deviceKey: string, sessionId: string, activeAt: string];
}

export interface CleanupResult {
	coachingSessions: number;
	consentRecords: number;
	devices: number;
	syncProfiles: number;
	roomFacts: number;
	hasMore: boolean;
}

export interface PlatformStoreOptions {
	now?: () => Date;
	roomHashKey?: string;
}

/**
 * Rebuild a client summary from an exact allowlist. Unknown fields are errors,
 * and raw capture fields receive a distinct privacy error instead of being
 * silently ignored.
 */
export function normalizeCoachingSummary(input: unknown): CoachingSummary {
	assertJsonSize(input, MAX_CLOUD_SUMMARY_BYTES, "Cloud coaching summary");
	assertNoForbiddenCloudData(input);
	const source = record(input, "summary");
	assertExactKeys(
		source,
		[
			"analysisSchemaVersion",
			"id",
			"createdAt",
			"scenario",
			"goal",
			"targetDurationMs",
			"metrics",
			"advice",
			"artifacts",
			"practiceLoopId",
			"baselineAttemptId",
			"attemptRole",
			"feedbackMode",
		],
		"summary",
		["artifacts", "practiceLoopId", "baselineAttemptId", "attemptRole", "feedbackMode"],
	);
	if (source.analysisSchemaVersion !== 2) {
		throw invalid("summary.analysisSchemaVersion", "must be exactly 2");
	}

	const id = normalizeSessionId(source.id, "summary.id");
	const createdAt = isoTimestamp(source.createdAt, "summary.createdAt");
	const scenario = enumValue(source.scenario, SCENARIOS, "summary.scenario");
	const goal = enumValue(source.goal, GOALS, "summary.goal");
	const targetDurationMs = finite(source.targetDurationMs, "summary.targetDurationMs", 15_000, 180_000, true);
	const metrics = normalizeMetrics(source.metrics);
	const advice = normalizeAdvice(source.advice);
	const artifacts = source.artifacts === undefined ? undefined : normalizeArtifactMetadata(source.artifacts);
	const relationship = normalizePracticeRelationship(source, id);

	if (metrics.voicedMs > metrics.durationMs + 1) {
		throw invalid("summary.metrics.voicedMs", "cannot exceed durationMs");
	}
	if (metrics.observedDurationMs > metrics.durationMs + 1) {
		throw invalid("summary.metrics.observedDurationMs", "cannot exceed durationMs");
	}
	if (metrics.unknownMs > metrics.durationMs + 1) {
		throw invalid("summary.metrics.unknownMs", "cannot exceed durationMs");
	}

	const normalized: CoachingSummary = {
		analysisSchemaVersion: 2,
		id,
		createdAt,
		scenario,
		goal,
		targetDurationMs,
		metrics,
		advice,
		...(artifacts === undefined ? {} : { artifacts }),
		...relationship,
	};
	assertJsonSize(normalized, MAX_CLOUD_SUMMARY_BYTES, "Normalized cloud coaching summary");
	return normalized;
}

export function withoutLocalArtifacts(summary: CoachingSummary): ExportedCoachingSummary {
	const { artifacts: _localOnly, ...exported } = summary;
	return exported;
}

export function encodeCoachingCursor(cursor: CoachingListCursor): string {
	const normalized = {
		createdAt: isoTimestamp(cursor.createdAt, "cursor.createdAt"),
		id: normalizeSessionId(cursor.id, "cursor.id"),
	};
	return btoa(JSON.stringify(normalized)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeCoachingCursor(cursor: string): CoachingListCursor {
	if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
		throw new PlatformError("INVALID_CURSOR", "The coaching history cursor is invalid.");
	}
	try {
		const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
		const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
		const value: unknown = JSON.parse(decoded);
		const source = record(value, "cursor");
		assertExactKeys(source, ["createdAt", "id"], "cursor");
		return {
			createdAt: isoTimestamp(source.createdAt, "cursor.createdAt"),
			id: normalizeSessionId(source.id, "cursor.id"),
		};
	} catch (error) {
		if (error instanceof PlatformError && error.code === "INVALID_CURSOR") throw error;
		throw new PlatformError("INVALID_CURSOR", "The coaching history cursor is invalid.", { cause: error });
	}
}

/** Hash exactly the validated 64-lowercase-hex browser token. */
export async function hashDeviceToken(browserToken: unknown): Promise<DeviceKey> {
	if (typeof browserToken !== "string" || !DEVICE_TOKEN_PATTERN.test(browserToken)) {
		throw new PlatformError(
			"INVALID_IDENTITY",
			"A valid anonymous browser identity is required for cloud progress.",
		);
	}
	return (await sha256Hex(browserToken)) as DeviceKey;
}

/** Room codes are keyed before hashing so their small code space cannot be enumerated offline. */
export async function hashRoomCode(roomCode: unknown, roomHashKey: unknown): Promise<string> {
	const normalized = normalizeRoomCode(roomCode);
	if (typeof roomHashKey !== "string") {
		throw new PlatformError("DATABASE_UNAVAILABLE", "Room-fact hashing is not configured.");
	}
	const keyBytes = new TextEncoder().encode(roomHashKey);
	if (keyBytes.byteLength < 32 || keyBytes.byteLength > 1_024) {
		throw new PlatformError("DATABASE_UNAVAILABLE", "Room-fact hashing is not configured securely.");
	}
	return hmacSha256Hex(keyBytes, `nonstoptalk-room:v1:${normalized}`);
}

/**
 * Central ownership guard used by reads and deletes. Both the session ID and
 * hashed device key are mandatory; expiration is part of the same predicate.
 */
export function protectedSummaryQuery(
	deviceKey: string,
	sessionId: unknown,
	activeAt: Date | string = new Date(),
): ProtectedSummaryQuery {
	assertDeviceKey(deviceKey);
	const id = normalizeSessionId(sessionId, "sessionId");
	const timestamp = dateInput(activeAt, "activeAt").toISOString();
	return {
		sql: `SELECT ${SUMMARY_COLUMNS} FROM coaching_sessions
			WHERE device_key = ? AND session_id = ?
				AND EXISTS (
					SELECT 1 FROM devices
					WHERE devices.device_key = coaching_sessions.device_key
						AND devices.expires_at > ?
				)
			LIMIT 1`,
		bindings: [deviceKey, id, timestamp],
	};
}

/** Map an event to one UTC-day aggregate without accepting identity dimensions. */
export function mapAnalyticsEvent(
	input: unknown,
	occurredAt: Date | string = new Date(),
): DailyAnalyticsDelta {
	const source = record(input, "analytics event");
	const type = text(source.type, "analytics event.type", 64) as AnalyticsMetric;
	let valueSum = 0;

	switch (type) {
		case "room_created":
		case "room_joined":
		case "game_started":
		case "cloud_consent_granted":
		case "cloud_consent_revoked":
			assertExactKeys(source, ["type"], "analytics event");
			break;
		case "coaching_summary_deleted":
			assertExactKeys(source, ["type", "deletedCount"], "analytics event");
			valueSum = finite(source.deletedCount, "analytics event.deletedCount", 1, Number.MAX_SAFE_INTEGER, true);
			break;
		case "turn_completed":
			assertExactKeys(source, ["type", "spokenSeconds"], "analytics event");
			valueSum = finite(source.spokenSeconds, "analytics event.spokenSeconds", 0, 300);
			break;
		case "game_finished":
			assertExactKeys(source, ["type", "turns"], "analytics event");
			valueSum = finite(source.turns, "analytics event.turns", 0, 1_200, true);
			break;
		case "coaching_summary_saved":
			assertExactKeys(source, ["type", "durationMs"], "analytics event");
			valueSum = finite(source.durationMs, "analytics event.durationMs", 0, 600_000) / 1_000;
			break;
		default:
			throw invalid("analytics event.type", "is not an allowlisted aggregate event");
	}

	return {
		day: dateInput(occurredAt, "occurredAt").toISOString().slice(0, 10),
		metric: type,
		eventCount: 1,
		valueSum,
	};
}

/** Extract bounded facts from public room state; names/topics/viewer data are ignored. */
export function mapPublicRoomStateToFact(
	publicState: unknown,
	milestone: RoomMilestone = "snapshot",
	observedAt: Date | string = new Date(),
): PublicRoomFactDraft {
	const source = record(publicState, "public room state");
	const roomCode = normalizeRoomCode(source.code);
	const stateVersion = finite(source.version, "public room state.version", 1, Number.MAX_SAFE_INTEGER, true);
	const phase = enumValue(source.phase, new Set(["setup", "playing", "finished"] as const), "public room state.phase");
	const normalizedMilestone = enumValue(
		milestone,
		new Set(["created", "joined", "game-started", "turn-completed", "game-finished", "reset", "snapshot"] as const),
		"room milestone",
	);
	const players = array(source.players, "public room state.players", 12);
	const completedTurns = array(source.completedTurns, "public room state.completedTurns", 1_200);
	const history = array(source.history, "public room state.history", 20);
	const settings = record(source.settings, "public room state.settings");
	const topicPack = enumValue(settings.topicPack, TOPIC_PACKS, "public room state.settings.topicPack");
	const configuredRounds = finite(settings.rounds, "public room state.settings.rounds", 1, 10, true);
	const turnDurationSeconds = finite(settings.duration, "public room state.settings.duration", 10, 300, true);

	let onlinePlayerCount = 0;
	let totalScore = 0;
	for (const [index, playerValue] of players.entries()) {
		const player = record(playerValue, `public room state.players[${index}]`);
		if (player.online === true) onlinePlayerCount += 1;
		totalScore += finite(player.score, `public room state.players[${index}].score`, 0, 1_000_000, true);
	}
	const lastTurn = source.lastTurn === null || source.lastTurn === undefined
		? null
		: record(source.lastTurn, "public room state.lastTurn");
	const lastTurnSpokenSeconds = lastTurn === null
		? 0
		: finite(lastTurn.spokenSeconds, "public room state.lastTurn.spokenSeconds", 0, 300);

	return {
		roomCode,
		stateVersion,
		observedAt: dateInput(observedAt, "observedAt").toISOString(),
		milestone: normalizedMilestone,
		phase,
		playerCount: players.length,
		onlinePlayerCount,
		configuredRounds,
		turnDurationSeconds,
		topicPack,
		completedTurnCount: completedTurns.length,
		finishedGameCount: history.length + (phase === "finished" ? 1 : 0),
		totalScore,
		lastTurnSpokenSeconds,
	};
}

/** Convert a true room milestone to a safe aggregate event; snapshots do not count. */
export function analyticsEventFromRoomMilestone(fact: PublicRoomFactDraft): AnalyticsEventInput | null {
	switch (fact.milestone) {
		case "created":
			return { type: "room_created" };
		case "joined":
			return { type: "room_joined" };
		case "game-started":
			return { type: "game_started" };
		case "turn-completed":
			return { type: "turn_completed", spokenSeconds: fact.lastTurnSpokenSeconds };
		case "game-finished":
			return { type: "game_finished", turns: fact.completedTurnCount };
		case "reset":
		case "snapshot":
			return null;
	}
}

function normalizeMetrics(input: unknown): CoachingMetrics {
	const source = record(input, "summary.metrics");
	assertExactKeys(
		source,
		[
			"durationMs",
			"voicedMs",
			"speakingRatio",
			"pauseCount",
			"observedDurationMs",
			"unknownMs",
			"coverageRatio",
			"maxSampleGapMs",
			"medianPauseMs",
			"longestPauseMs",
			"longestSpeakingRunMs",
			"levelConsistencyPct",
			"clippingPct",
			"audioConfidence",
			"transcriptMetrics",
		],
		"summary.metrics",
	);
	return {
		durationMs: finite(source.durationMs, "summary.metrics.durationMs", 0, 600_000),
		voicedMs: finite(source.voicedMs, "summary.metrics.voicedMs", 0, 600_000),
		speakingRatio: finite(source.speakingRatio, "summary.metrics.speakingRatio", 0, 1),
		pauseCount: finite(source.pauseCount, "summary.metrics.pauseCount", 0, 10_000, true),
		observedDurationMs: finite(source.observedDurationMs, "summary.metrics.observedDurationMs", 0, 600_000),
		unknownMs: finite(source.unknownMs, "summary.metrics.unknownMs", 0, 600_000),
		coverageRatio: finite(source.coverageRatio, "summary.metrics.coverageRatio", 0, 1),
		maxSampleGapMs: finite(source.maxSampleGapMs, "summary.metrics.maxSampleGapMs", 0, 600_000),
		medianPauseMs: finite(source.medianPauseMs, "summary.metrics.medianPauseMs", 0, 600_000),
		longestPauseMs: finite(source.longestPauseMs, "summary.metrics.longestPauseMs", 0, 600_000),
		longestSpeakingRunMs: finite(
			source.longestSpeakingRunMs,
			"summary.metrics.longestSpeakingRunMs",
			0,
			600_000,
		),
		levelConsistencyPct: nullableFinite(
			source.levelConsistencyPct,
			"summary.metrics.levelConsistencyPct",
			0,
			100,
		),
		clippingPct: finite(source.clippingPct, "summary.metrics.clippingPct", 0, 100),
		audioConfidence: enumValue(
			source.audioConfidence,
			AUDIO_CONFIDENCE,
			"summary.metrics.audioConfidence",
		),
		transcriptMetrics: source.transcriptMetrics === null
			? null
			: normalizeTranscriptMetrics(source.transcriptMetrics),
	};
}

function normalizeTranscriptMetrics(input: unknown): TranscriptMetrics {
	const source = record(input, "summary.metrics.transcriptMetrics");
	assertExactKeys(
		source,
		[
			"wordCount",
			"wordsPerMinute",
			"fillerCount",
			"repeatedWordCount",
			"fillerRatePer100Words",
			"repetitionRatePer100Words",
			"fillerOccurrences",
			"repeatedWords",
		],
		"summary.metrics.transcriptMetrics",
	);
	return {
		wordCount: finite(source.wordCount, "summary.metrics.transcriptMetrics.wordCount", 0, 100_000, true),
		wordsPerMinute: finite(source.wordsPerMinute, "summary.metrics.transcriptMetrics.wordsPerMinute", 0, 2_000),
		fillerCount: finite(source.fillerCount, "summary.metrics.transcriptMetrics.fillerCount", 0, 100_000, true),
		repeatedWordCount: finite(
			source.repeatedWordCount,
			"summary.metrics.transcriptMetrics.repeatedWordCount",
			0,
			100_000,
			true,
		),
		fillerRatePer100Words: finite(
			source.fillerRatePer100Words,
			"summary.metrics.transcriptMetrics.fillerRatePer100Words",
			0,
			100,
		),
		repetitionRatePer100Words: finite(
			source.repetitionRatePer100Words,
			"summary.metrics.transcriptMetrics.repetitionRatePer100Words",
			0,
			100,
		),
		fillerOccurrences: normalizePatterns(source.fillerOccurrences, "phrase"),
		repeatedWords: normalizePatterns(source.repeatedWords, "word"),
	};
}

function normalizePatterns(input: unknown, key: "phrase"): WordPattern[];
function normalizePatterns(input: unknown, key: "word"): RepeatedWordPattern[];
function normalizePatterns(
	input: unknown,
	key: "phrase" | "word",
): Array<WordPattern | RepeatedWordPattern> {
	const values = array(input, `summary.metrics.transcriptMetrics.${key === "phrase" ? "fillerOccurrences" : "repeatedWords"}`, 50);
	return values.map((value, index) => {
		const path = `summary.metrics.transcriptMetrics.${key === "phrase" ? "fillerOccurrences" : "repeatedWords"}[${index}]`;
		const source = record(value, path);
		assertExactKeys(source, [key, "count"], path);
		const label = text(source[key], `${path}.${key}`, 64);
		const count = finite(source.count, `${path}.count`, 0, 100_000, true);
		return key === "phrase" ? { phrase: label, count } : { word: label, count };
	});
}

function normalizeAdvice(input: unknown): CoachingAdvice {
	const source = record(input, "summary.advice");
	assertExactKeys(
		source,
		["strength", "strengthEvidence", "focus", "focusEvidence", "drill", "drillDetail"],
		"summary.advice",
	);
	return {
		strength: text(source.strength, "summary.advice.strength", 600),
		strengthEvidence: text(source.strengthEvidence, "summary.advice.strengthEvidence", 600),
		focus: text(source.focus, "summary.advice.focus", 600),
		focusEvidence: text(source.focusEvidence, "summary.advice.focusEvidence", 600),
		drill: text(source.drill, "summary.advice.drill", 600),
		drillDetail: text(source.drillDetail, "summary.advice.drillDetail", 600),
	};
}

function normalizeArtifactMetadata(input: unknown): LocalArtifactMetadata {
	const source = record(input, "summary.artifacts");
	assertExactKeys(
		source,
		["audioStored", "audioBytes", "audioMimeType", "transcriptStored", "transcriptMayBePartial"],
		"summary.artifacts",
	);
	return {
		audioStored: bool(source.audioStored, "summary.artifacts.audioStored"),
		audioBytes: finite(source.audioBytes, "summary.artifacts.audioBytes", 0, 1_000_000_000, true),
		audioMimeType: optionalText(source.audioMimeType, "summary.artifacts.audioMimeType", 80),
		transcriptStored: bool(source.transcriptStored, "summary.artifacts.transcriptStored"),
		transcriptMayBePartial: bool(
			source.transcriptMayBePartial,
			"summary.artifacts.transcriptMayBePartial",
		),
	};
}

function normalizePracticeRelationship(
	source: Record<string, unknown>,
	sessionId: string,
): Pick<CoachingSummary, "practiceLoopId" | "baselineAttemptId" | "attemptRole" | "feedbackMode"> | Record<string, never> {
	const keys = ["practiceLoopId", "baselineAttemptId", "attemptRole", "feedbackMode"] as const;
	const present = keys.filter((key) => Object.hasOwn(source, key));
	if (present.length === 0) return {};
	if (present.length !== keys.length) {
		throw invalid("summary practice relationship", "must include all relationship fields or none");
	}
	const attemptRole = enumValue(source.attemptRole, ATTEMPT_ROLES, "summary.attemptRole");
	const feedbackMode = enumValue(source.feedbackMode, FEEDBACK_MODES, "summary.feedbackMode");
	if (attemptRole === "standalone") {
		if (source.practiceLoopId !== null || source.baselineAttemptId !== null) {
			throw invalid("summary practice relationship", "standalone attempts cannot belong to a loop");
		}
		if (feedbackMode !== "live-cues") {
			throw invalid("summary.feedbackMode", "standalone attempts must use live-cues");
		}
		return {
			practiceLoopId: null,
			baselineAttemptId: null,
			attemptRole,
			feedbackMode,
		};
	}
	const practiceLoopId = normalizeSessionId(source.practiceLoopId, "summary.practiceLoopId");
	const baselineAttemptId = normalizeSessionId(source.baselineAttemptId, "summary.baselineAttemptId");
	if (feedbackMode !== "review-only") {
		throw invalid("summary.feedbackMode", "paired attempts must use review-only");
	}
	if (attemptRole === "baseline" && baselineAttemptId !== sessionId) {
		throw invalid("summary.baselineAttemptId", "must equal summary.id for a baseline");
	}
	if (attemptRole === "retry" && baselineAttemptId === sessionId) {
		throw invalid("summary.baselineAttemptId", "cannot point a retry to itself");
	}
	return { practiceLoopId, baselineAttemptId, attemptRole, feedbackMode };
}

interface CoachingSummaryRow {
	session_id: string;
	analysis_schema_version: number;
	client_created_at: string;
	received_at: string;
	updated_at: string;
	scenario: string;
	goal: string;
	target_duration_ms: number;
	duration_ms: number;
	speaking_ratio: number;
	pause_count: number;
	audio_confidence: string;
	transcript_metrics_used: number;
	practice_loop_id: string | null;
	baseline_attempt_id: string | null;
	attempt_role: CoachingAttemptRole;
	summary_json: string;
}

interface ConsentRow {
	purpose: "cloud_summary";
	granted: number;
	policy_version: string;
	granted_at: string | null;
	revoked_at: string | null;
	updated_at: string;
}

interface AnalyticsRow {
	day: string;
	metric: AnalyticsMetric;
	event_count: number;
	value_sum: number;
	value_min: number;
	value_max: number;
	updated_at: string;
}

interface RoomFactRow {
	room_key: string;
	first_observed_at: string;
	last_observed_at: string;
	expires_at: string;
	state_version: number;
	last_milestone: RoomMilestone;
	phase: "setup" | "playing" | "finished";
	player_count: number;
	online_player_count: number;
	configured_rounds: number;
	turn_duration_seconds: number;
	topic_pack: PublicRoomFactDraft["topicPack"];
	completed_turn_count: number;
	finished_game_count: number;
	total_score: number;
	last_turn_spoken_seconds: number;
}

const UPSERT_CONSENT_SQL = `
	INSERT INTO consent_records (
		device_key, purpose, policy_version, granted, granted_at, revoked_at, updated_at
	) VALUES (?, 'cloud_summary', ?, ?, ?, ?, ?)
	ON CONFLICT(device_key, purpose) DO UPDATE SET
		policy_version = excluded.policy_version,
		granted = excluded.granted,
		granted_at = CASE
			WHEN excluded.granted = 1 THEN excluded.updated_at
			ELSE consent_records.granted_at
		END,
		revoked_at = CASE WHEN excluded.granted = 0 THEN excluded.updated_at ELSE NULL END,
		updated_at = excluded.updated_at
`;

const INSERT_SUMMARY_SQL = `
	INSERT INTO coaching_sessions (
		device_key, session_id, analysis_schema_version, client_created_at,
		received_at, updated_at, scenario, goal, target_duration_ms,
		duration_ms, speaking_ratio, pause_count, audio_confidence,
		transcript_metrics_used, practice_loop_id, baseline_attempt_id,
		attempt_role, summary_json
	)
	SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
	WHERE EXISTS (
		SELECT 1
		FROM consent_records AS consent
		JOIN devices AS device ON device.device_key = consent.device_key
		WHERE consent.device_key = ?
			AND consent.purpose = 'cloud_summary'
			AND consent.granted = 1
			AND device.expires_at > ?
	)
	AND NOT EXISTS (
		SELECT 1 FROM coaching_sessions AS quota
		WHERE quota.device_key = ?
		LIMIT 1 OFFSET ?
	)
	ON CONFLICT(device_key, session_id) DO NOTHING
`;

const UPDATE_SUMMARY_SQL = `
	UPDATE coaching_sessions
	SET analysis_schema_version = ?, client_created_at = ?, updated_at = ?,
		scenario = ?, goal = ?, target_duration_ms = ?, duration_ms = ?, speaking_ratio = ?,
		pause_count = ?, audio_confidence = ?, transcript_metrics_used = ?,
		practice_loop_id = ?, baseline_attempt_id = ?, attempt_role = ?, summary_json = ?
	WHERE device_key = ? AND session_id = ?
		AND EXISTS (
			SELECT 1 FROM devices
			WHERE devices.device_key = coaching_sessions.device_key
				AND devices.expires_at > ?
		)
		AND EXISTS (
			SELECT 1 FROM consent_records
			WHERE device_key = ? AND purpose = 'cloud_summary' AND granted = 1
		)
`;

const UPSERT_ANALYTICS_SQL = `
	INSERT INTO analytics_daily (
		day, metric, event_count, value_sum, value_min, value_max, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(day, metric) DO UPDATE SET
		event_count = analytics_daily.event_count + excluded.event_count,
		value_sum = analytics_daily.value_sum + excluded.value_sum,
		value_min = MIN(analytics_daily.value_min, excluded.value_min),
		value_max = MAX(analytics_daily.value_max, excluded.value_max),
		updated_at = excluded.updated_at
`;

const UPSERT_ROOM_FACT_SQL = `
	INSERT INTO room_facts (
		room_key, first_observed_at, last_observed_at, expires_at, state_version,
		last_milestone, phase, player_count, online_player_count, configured_rounds,
		turn_duration_seconds, topic_pack, completed_turn_count, finished_game_count,
		total_score, last_turn_spoken_seconds
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

/** D1 service used by Worker route handlers. */
export class PlatformStore {
	readonly #db: D1Database;
	readonly #now: () => Date;
	readonly #roomHashKey: string | undefined;

	constructor(db: D1Database, options: PlatformStoreOptions = {}) {
		this.#db = db;
		this.#now = options.now ?? (() => new Date());
		this.#roomHashKey = options.roomHashKey;
	}

	async recordCloudSummaryConsent(
		browserToken: unknown,
		granted: boolean,
		policyVersion = CLOUD_SUMMARY_POLICY_VERSION,
	): Promise<CloudSummaryConsent> {
		if (typeof granted !== "boolean") throw invalid("granted", "must be a boolean");
		if (granted) return (await this.grantConsentTransition(browserToken, policyVersion)).consent;
		const policy = normalizePolicyVersion(policyVersion);
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		await this.touchSyncIdentity(deviceKey, now);
		const timestamp = now.toISOString();
		await databaseOperation("record cloud-summary consent", async () => {
			await this.#db
				.prepare(UPSERT_CONSENT_SQL)
				.bind(
					deviceKey,
					policy,
					granted ? 1 : 0,
					granted ? timestamp : null,
					granted ? null : timestamp,
					timestamp,
				)
				.run();
		});
		const consent = await this.readConsent(deviceKey);
		if (!consent) {
			throw new PlatformError("DATABASE_UNAVAILABLE", "Cloud-summary consent could not be read after saving.");
		}
		return consent;
	}

	grantCloudSummaryConsent(
		browserToken: unknown,
		policyVersion = CLOUD_SUMMARY_POLICY_VERSION,
	): Promise<CloudSummaryConsent> {
		return this.grantConsentTransition(browserToken, policyVersion).then((result) => result.consent);
	}

	revokeCloudSummaryConsent(
		browserToken: unknown,
		policyVersion = CLOUD_SUMMARY_POLICY_VERSION,
	): Promise<CloudSummaryConsent> {
		return this.recordCloudSummaryConsent(browserToken, false, policyVersion);
	}

	async getCloudSummaryConsent(browserToken: unknown): Promise<CloudSummaryConsent | null> {
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		if (!(await this.hasActiveDevice(deviceKey, now.toISOString()))) return null;
		await this.touchSyncIdentity(deviceKey, now);
		return this.readConsent(deviceKey);
	}

	/**
	 * Idempotent create: a retry with the same ID and payload is a no-op. The
	 * immutable client ID may not be reused for different summary content.
	 */
	async saveCoachingSummary(browserToken: unknown, input: unknown): Promise<SavedCoachingSummary> {
		const summary: CoachingSummary = withoutLocalArtifacts(normalizeCoachingSummary(input));
		const serialized = JSON.stringify(summary);
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		const timestamp = now.toISOString();
		await this.touchSyncIdentity(deviceKey, now);
		await this.requireConsent(deviceKey);

		const result = await databaseOperation("save the coaching summary", () =>
			this.summaryInsertStatement(deviceKey, summary, serialized, timestamp).run(),
		);
		return this.resolveSummaryInsert(
			deviceKey,
			summary,
			serialized,
			timestamp,
			resultChanges(result) > 0,
		);
	}

	/** Explicit one-call boundary for a POST whose body communicates consent. */
	async saveConsentedCoachingSummary(
		browserToken: unknown,
		input: unknown,
		policyVersion = CLOUD_SUMMARY_POLICY_VERSION,
	): Promise<SavedCoachingSummary> {
		const summary: CoachingSummary = withoutLocalArtifacts(normalizeCoachingSummary(input));
		const serialized = JSON.stringify(summary);
		const policy = normalizePolicyVersion(policyVersion);
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		const timestamp = now.toISOString();
		const expiresAt = anonymousExpiryFrom(now);
		const identityTouch = prepareSyncIdentityTouch(
			this.#db,
			deviceKey,
			timestamp,
			expiresAt,
		);
		const consentInsertIndex = identityTouch.length;
		const consentUpdateIndex = consentInsertIndex + 1;
		const summaryInsertIndex = consentUpdateIndex + 1;
		const results = await databaseOperation("grant consent and save the coaching summary", () =>
			this.#db.batch([
				...identityTouch,
				this.#db
					.prepare(`INSERT OR IGNORE INTO consent_records (
						device_key, purpose, policy_version, granted, granted_at, revoked_at, updated_at
					) VALUES (?, 'cloud_summary', ?, 1, ?, NULL, ?)`)
					.bind(deviceKey, policy, timestamp, timestamp),
				this.#db
					.prepare(`UPDATE consent_records
						SET policy_version = ?, granted = 1, granted_at = ?, revoked_at = NULL, updated_at = ?
						WHERE device_key = ? AND purpose = 'cloud_summary'
							AND (granted = 0 OR policy_version <> ?)`)
					.bind(policy, timestamp, timestamp, deviceKey, policy),
				this.summaryInsertStatement(deviceKey, summary, serialized, timestamp),
			]),
		);
		const saved = await this.resolveSummaryInsert(
			deviceKey,
			summary,
			serialized,
			timestamp,
			resultChanges(results[summaryInsertIndex]) > 0,
		);
		return {
			...saved,
			consentGranted: resultChanges(results[consentInsertIndex]) > 0
				|| resultChanges(results[consentUpdateIndex]) > 0,
		};
	}

	/** Deliberate CRUD update; ordinary POST retries should use saveCoachingSummary. */
	async updateCoachingSummary(browserToken: unknown, input: unknown): Promise<CoachingSummary> {
		const summary: CoachingSummary = withoutLocalArtifacts(normalizeCoachingSummary(input));
		const serialized = JSON.stringify(summary);
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		const timestamp = now.toISOString();
		await this.touchSyncIdentity(deviceKey, now);
		await this.requireConsent(deviceKey);
		const result = await databaseOperation("update the coaching summary", () =>
			this.#db
				.prepare(UPDATE_SUMMARY_SQL)
				.bind(
					summary.analysisSchemaVersion,
					summary.createdAt,
					timestamp,
					summary.scenario,
					summary.goal,
					summary.targetDurationMs,
					summary.metrics.durationMs,
					summary.metrics.speakingRatio,
					summary.metrics.pauseCount,
					summary.metrics.audioConfidence,
					summary.metrics.transcriptMetrics === null ? 0 : 1,
					summary.practiceLoopId ?? null,
					summary.baselineAttemptId ?? null,
					summary.attemptRole ?? "standalone",
					serialized,
					deviceKey,
					summary.id,
					timestamp,
					deviceKey,
				)
				.run(),
		);
		if (resultChanges(result) === 0) {
			await this.requireConsent(deviceKey);
			throw new PlatformError("NOT_FOUND", "That coaching summary was not found for this browser.");
		}
		return summary;
	}

	async getCoachingSummary(browserToken: unknown, sessionId: unknown): Promise<CoachingSummary | null> {
		const id = normalizeSessionId(sessionId, "sessionId");
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		const timestamp = now.toISOString();
		if (!(await this.hasActiveDevice(deviceKey, timestamp))) return null;
		await this.touchSyncIdentity(deviceKey, now);
		return this.readProtectedSummary(deviceKey, id, timestamp);
	}

	async listCoachingSummaries(
		browserToken: unknown,
		options: CoachingListOptions = {},
	): Promise<CoachingSummaryPage> {
		const limit = normalizeLimit(options.limit);
		const cursor = options.cursor ? decodeCoachingCursor(options.cursor) : null;
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		const timestamp = now.toISOString();
		const expiresAt = anonymousExpiryFrom(now);
		if (!(await this.hasActiveDevice(deviceKey, timestamp))) {
			return { sessions: [], nextCursor: null };
		}
		await this.touchSyncIdentity(deviceKey, now);
		const statement = cursor
			? this.#db
				.prepare(`SELECT ${SUMMARY_COLUMNS} FROM coaching_sessions
					WHERE device_key = ?
						AND (client_created_at < ? OR (client_created_at = ? AND session_id < ?))
					ORDER BY client_created_at DESC, session_id DESC LIMIT ?`)
				.bind(deviceKey, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
			: this.#db
				.prepare(`SELECT ${SUMMARY_COLUMNS} FROM coaching_sessions
					WHERE device_key = ?
					ORDER BY client_created_at DESC, session_id DESC LIMIT ?`)
				.bind(deviceKey, limit + 1);
		const result = await databaseOperation("list coaching summaries", () => statement.all<CoachingSummaryRow>());
		const hasMore = result.results.length > limit;
		const rows = result.results.slice(0, limit);
		const sessions = rows.map(summaryFromRow);
		const last = sessions.at(-1);
		return {
			sessions,
			nextCursor: hasMore && last ? encodeCoachingCursor({ createdAt: last.createdAt, id: last.id }) : null,
		};
	}

	async exportCoachingSummaries(browserToken: unknown): Promise<CoachingSummaryExport> {
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		const timestamp = now.toISOString();
		if (!(await this.hasActiveDevice(deviceKey, timestamp))) {
			return {
				product: "NonStopTalk",
				schemaVersion: 2,
				exportedAt: timestamp,
				privacy: "Aggregate coaching measurements and advice; no audio, captured transcript text, or local artifacts.",
				sessions: [],
				truncated: false,
			};
		}
		await this.touchSyncIdentity(deviceKey, now);
		const result = await databaseOperation("export coaching summaries", () =>
			this.#db
				.prepare(`SELECT ${SUMMARY_COLUMNS} FROM coaching_sessions
					WHERE device_key = ?
					ORDER BY client_created_at DESC, session_id DESC LIMIT ?`)
				.bind(deviceKey, MAX_COACHING_EXPORT_SIZE + 1)
				.all<CoachingSummaryRow>(),
		);
		const truncated = result.results.length > MAX_COACHING_EXPORT_SIZE;
		return {
			product: "NonStopTalk",
			schemaVersion: 2,
			exportedAt: timestamp,
			privacy: "Aggregate coaching measurements and advice; no audio, captured transcript text, or local artifacts.",
			sessions: result.results
				.slice(0, MAX_COACHING_EXPORT_SIZE)
				.map(summaryFromRow)
				.map(withoutLocalArtifacts),
			truncated,
		};
	}

	async deleteCoachingSummary(browserToken: unknown, sessionId: unknown): Promise<boolean> {
		const id = normalizeSessionId(sessionId, "sessionId");
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		const timestamp = now.toISOString();
		if (!(await this.hasActiveDevice(deviceKey, timestamp))) return false;
		await this.touchSyncIdentity(deviceKey, now);
		const result = await databaseOperation("delete the coaching summary", () =>
			this.#db
				.prepare("DELETE FROM coaching_sessions WHERE device_key = ? AND session_id = ?")
				.bind(deviceKey, id)
				.run(),
		);
		return resultChanges(result) > 0;
	}

	/** Delete every cloud summary for the browser and revoke future cloud saves. */
	async clearCoachingSummaries(browserToken: unknown): Promise<{ deletedCount: number; consentRevoked: boolean }> {
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		if (!(await this.hasActiveDevice(deviceKey, now.toISOString()))) {
			return { deletedCount: 0, consentRevoked: false };
		}
		await this.touchSyncIdentity(deviceKey, now);
		const timestamp = now.toISOString();
		const results = await databaseOperation("clear coaching summaries and revoke consent", () =>
			this.#db.batch([
				this.#db.prepare("DELETE FROM coaching_sessions WHERE device_key = ?").bind(deviceKey),
				this.#db
					.prepare(`UPDATE consent_records
						SET granted = 0, revoked_at = ?, updated_at = ?
						WHERE device_key = ? AND purpose = 'cloud_summary' AND granted = 1`)
					.bind(timestamp, timestamp, deviceKey),
				this.#db
					.prepare(`INSERT OR IGNORE INTO consent_records (
						device_key, purpose, policy_version, granted, granted_at, revoked_at, updated_at
					) VALUES (?, 'cloud_summary', ?, 0, NULL, ?, ?)`)
					.bind(
						deviceKey,
						CLOUD_SUMMARY_POLICY_VERSION,
						timestamp,
						timestamp,
					),
			]),
		);
		return {
			deletedCount: resultChanges(results[0]),
			consentRevoked: resultChanges(results[1]) > 0,
		};
	}

	async upsertRoomFact(
		publicState: unknown,
		milestone: RoomMilestone = "snapshot",
		observedAt: Date | string = this.clock(),
	): Promise<RoomFact> {
		const draft = mapPublicRoomStateToFact(publicState, milestone, observedAt);
		const roomKey = await hashRoomCode(draft.roomCode, this.#roomHashKey);
		const expiresAt = expiryFrom(dateInput(draft.observedAt, "observedAt"), ROOM_FACT_RETENTION_MS);
		await databaseOperation("upsert the public room fact", () =>
			this.#db
				.prepare(UPSERT_ROOM_FACT_SQL)
				.bind(
					roomKey,
					draft.observedAt,
					draft.observedAt,
					expiresAt,
					draft.stateVersion,
					draft.milestone,
					draft.phase,
					draft.playerCount,
					draft.onlinePlayerCount,
					draft.configuredRounds,
					draft.turnDurationSeconds,
					draft.topicPack,
					draft.completedTurnCount,
					draft.finishedGameCount,
					draft.totalScore,
					draft.lastTurnSpokenSeconds,
				)
				.run(),
		);
		const row = await databaseOperation("read the public room fact", () =>
			this.#db
				.prepare("SELECT * FROM room_facts WHERE room_key = ? AND expires_at > ? LIMIT 1")
				.bind(roomKey, draft.observedAt)
				.first<RoomFactRow>(),
		);
		if (!row) throw new PlatformError("DATABASE_UNAVAILABLE", "The room fact could not be read after saving.");
		return roomFactFromRow(row);
	}

	async getRoomFact(roomCode: unknown): Promise<RoomFact | null> {
		const roomKey = await hashRoomCode(roomCode, this.#roomHashKey);
		const timestamp = this.clock().toISOString();
		const row = await databaseOperation("read the public room fact", () =>
			this.#db
				.prepare("SELECT * FROM room_facts WHERE room_key = ? AND expires_at > ? LIMIT 1")
				.bind(roomKey, timestamp)
				.first<RoomFactRow>(),
		);
		return row ? roomFactFromRow(row) : null;
	}

	async recordAnalyticsEvent(
		input: unknown,
		occurredAt: Date | string = this.clock(),
	): Promise<DailyAnalyticsRow> {
		const delta = mapAnalyticsEvent(input, occurredAt);
		const updatedAt = dateInput(occurredAt, "occurredAt").toISOString();
		await databaseOperation("record daily product analytics", () =>
			this.#db
				.prepare(UPSERT_ANALYTICS_SQL)
				.bind(
					delta.day,
					delta.metric,
					delta.eventCount,
					delta.valueSum,
					delta.valueSum,
					delta.valueSum,
					updatedAt,
				)
				.run(),
		);
		const row = await databaseOperation("read daily product analytics", () =>
			this.#db
				.prepare("SELECT * FROM analytics_daily WHERE day = ? AND metric = ? LIMIT 1")
				.bind(delta.day, delta.metric)
				.first<AnalyticsRow>(),
		);
		if (!row) throw new PlatformError("DATABASE_UNAVAILABLE", "The analytics aggregate could not be read after saving.");
		return analyticsFromRow(row);
	}

	async listDailyAnalytics(fromDay: string, toDay: string): Promise<DailyAnalyticsRow[]> {
		const from = normalizeDay(fromDay, "fromDay");
		const to = normalizeDay(toDay, "toDay");
		if (from > to) throw invalid("fromDay", "must be on or before toDay");
		const result = await databaseOperation("list daily product analytics", () =>
			this.#db
				.prepare("SELECT * FROM analytics_daily WHERE day >= ? AND day <= ? ORDER BY day, metric")
				.bind(from, to)
				.all<AnalyticsRow>(),
		);
		return result.results.map(analyticsFromRow);
	}

	private clock(): Date {
		return dateInput(this.#now(), "PlatformStore clock");
	}

	private async touchSyncIdentity(deviceKey: DeviceKey, now: Date): Promise<void> {
		const timestamp = now.toISOString();
		const expiresAt = anonymousExpiryFrom(now);
		await databaseOperation("refresh the anonymous sync identity", () =>
			this.#db.batch(prepareSyncIdentityTouch(this.#db, deviceKey, timestamp, expiresAt)),
		);
	}

	private async readConsent(deviceKey: DeviceKey): Promise<CloudSummaryConsent | null> {
		const row = await databaseOperation("read cloud-summary consent", () =>
			this.#db
				.prepare(`SELECT purpose, granted, policy_version, granted_at, revoked_at, updated_at
					FROM consent_records WHERE device_key = ? AND purpose = 'cloud_summary' LIMIT 1`)
				.bind(deviceKey)
				.first<ConsentRow>(),
		);
		return row ? consentFromRow(row) : null;
	}

	private async hasActiveDevice(deviceKey: DeviceKey, activeAt: string): Promise<boolean> {
		const row = await databaseOperation("read the anonymous device", () =>
			this.#db
				.prepare("SELECT 1 AS found FROM devices WHERE device_key = ? AND expires_at > ? LIMIT 1")
				.bind(deviceKey, activeAt)
				.first<{ found: number }>(),
		);
		return row?.found === 1;
	}

	private summaryInsertStatement(
		deviceKey: DeviceKey,
		summary: ExportedCoachingSummary,
		serialized: string,
		timestamp: string,
	): D1PreparedStatement {
		return this.#db
			.prepare(INSERT_SUMMARY_SQL)
			.bind(
				deviceKey,
				summary.id,
				summary.analysisSchemaVersion,
				summary.createdAt,
				timestamp,
				timestamp,
				summary.scenario,
				summary.goal,
				summary.targetDurationMs,
				summary.metrics.durationMs,
				summary.metrics.speakingRatio,
				summary.metrics.pauseCount,
				summary.metrics.audioConfidence,
				summary.metrics.transcriptMetrics === null ? 0 : 1,
				summary.practiceLoopId ?? null,
				summary.baselineAttemptId ?? null,
				summary.attemptRole ?? "standalone",
				serialized,
				deviceKey,
				timestamp,
				deviceKey,
				MAX_ACTIVE_COACHING_SUMMARIES - 1,
			);
	}

	private async resolveSummaryInsert(
		deviceKey: DeviceKey,
		summary: CoachingSummary,
		serialized: string,
		timestamp: string,
		created: boolean,
	): Promise<SavedCoachingSummary> {
		if (created) return { created: true, summary };
		const existing = await this.readProtectedSummary(deviceKey, summary.id, timestamp);
		if (!existing) {
			await this.requireConsent(deviceKey);
			const atCapacity = await this.activeSummaryCountAtLeast(
				deviceKey,
				MAX_ACTIVE_COACHING_SUMMARIES,
			);
			if (atCapacity) {
				throw new PlatformError(
					"STORAGE_LIMIT_REACHED",
					`New cloud saves stop once this anonymous browser has ${MAX_ACTIVE_COACHING_SUMMARIES} summaries. Export or delete history before saving more.`,
				);
			}
			throw new PlatformError("DATABASE_UNAVAILABLE", "The coaching summary could not be saved.");
		}
		if (JSON.stringify(existing) !== serialized) {
			throw new PlatformError(
				"CONFLICT",
				"That coaching session ID already belongs to a different immutable summary.",
			);
		}
		return { created: false, summary: existing };
	}

	private async activeSummaryCountAtLeast(
		deviceKey: DeviceKey,
		limit: number,
	): Promise<boolean> {
		const row = await databaseOperation("check the coaching-summary storage limit", () =>
			this.#db
				.prepare(`SELECT 1 AS reached FROM coaching_sessions
					WHERE device_key = ? LIMIT 1 OFFSET ?`)
				.bind(deviceKey, limit - 1)
				.first<{ reached: number }>(),
		);
		return row?.reached === 1;
	}

	private async grantConsentTransition(
		browserToken: unknown,
		policyVersion: unknown,
	): Promise<{ consent: CloudSummaryConsent; changed: boolean }> {
		const policy = normalizePolicyVersion(policyVersion);
		const deviceKey = await hashDeviceToken(browserToken);
		const now = this.clock();
		await this.touchSyncIdentity(deviceKey, now);
		const timestamp = now.toISOString();
		const results = await databaseOperation("grant cloud-summary consent", () =>
			this.#db.batch([
				this.#db
					.prepare(`INSERT OR IGNORE INTO consent_records (
						device_key, purpose, policy_version, granted, granted_at, revoked_at, updated_at
					) VALUES (?, 'cloud_summary', ?, 1, ?, NULL, ?)`)
					.bind(deviceKey, policy, timestamp, timestamp),
				this.#db
					.prepare(`UPDATE consent_records
						SET policy_version = ?, granted = 1, granted_at = ?, revoked_at = NULL, updated_at = ?
						WHERE device_key = ? AND purpose = 'cloud_summary'
							AND (granted = 0 OR policy_version <> ?)`)
					.bind(policy, timestamp, timestamp, deviceKey, policy),
			]),
		);
		const consent = await this.readConsent(deviceKey);
		if (!consent) {
			throw new PlatformError("DATABASE_UNAVAILABLE", "Cloud-summary consent could not be read after saving.");
		}
		return {
			consent,
			changed: resultChanges(results[0]) > 0 || resultChanges(results[1]) > 0,
		};
	}

	private async requireConsent(deviceKey: DeviceKey): Promise<void> {
		const consent = await this.readConsent(deviceKey);
		if (!consent?.granted) {
			throw new PlatformError(
				"CONSENT_REQUIRED",
				"Enable compact cloud-summary backup before saving coaching progress online.",
			);
		}
	}

	private async readProtectedSummary(
		deviceKey: DeviceKey,
		sessionId: string,
		activeAt: string,
	): Promise<CoachingSummary | null> {
		const query = protectedSummaryQuery(deviceKey, sessionId, activeAt);
		const row = await databaseOperation("read the protected coaching summary", () =>
			this.#db.prepare(query.sql).bind(...query.bindings).first<CoachingSummaryRow>(),
		);
		return row ? summaryFromRow(row) : null;
	}

}

export function createPlatformStore(db: D1Database, options: PlatformStoreOptions = {}): PlatformStore {
	return new PlatformStore(db, options);
}

/** Delete expired anonymous detail while retaining non-identifying daily totals. */
export async function cleanupExpiredData(
	db: D1Database,
	now: Date | string = new Date(),
	limit = RETENTION_CLEANUP_BATCH_SIZE,
): Promise<CleanupResult> {
	const timestamp = dateInput(now, "now").toISOString();
	const boundedLimit = finite(limit, "cleanup limit", 1, 1_000, true);
	const results = await databaseOperation("clean up expired platform data", () =>
		db.batch([
			db
				.prepare(`DELETE FROM coaching_sessions WHERE rowid IN (
					SELECT session.rowid
					FROM coaching_sessions AS session
					JOIN devices AS device ON device.device_key = session.device_key
					WHERE device.expires_at <= ? LIMIT ?
				)`)
				.bind(timestamp, boundedLimit),
			db
				.prepare(`DELETE FROM consent_records WHERE rowid IN (
					SELECT consent.rowid
					FROM consent_records AS consent
					JOIN devices AS device ON device.device_key = consent.device_key
					WHERE device.expires_at <= ? LIMIT ?
				)`)
				.bind(timestamp, boundedLimit),
			db
				.prepare(`DELETE FROM devices WHERE rowid IN (
					SELECT device.rowid FROM devices AS device
					WHERE device.expires_at <= ?
						AND NOT EXISTS (
							SELECT 1 FROM coaching_sessions AS session
							WHERE session.device_key = device.device_key
						)
						AND NOT EXISTS (
							SELECT 1 FROM consent_records AS consent
							WHERE consent.device_key = device.device_key
						)
					LIMIT ?
				)`)
				.bind(timestamp, boundedLimit),
			db
				.prepare(`DELETE FROM sync_profiles WHERE rowid IN (
					SELECT profile.rowid
					FROM sync_profiles AS profile
					WHERE profile.expires_at <= ?
						AND NOT EXISTS (
							SELECT 1 FROM sync_profile_devices AS membership
							WHERE membership.profile_id = profile.profile_id
						)
					LIMIT ?
				)`)
				.bind(timestamp, boundedLimit),
			db
				.prepare(`DELETE FROM room_facts WHERE rowid IN (
					SELECT rowid FROM room_facts WHERE expires_at <= ? LIMIT ?
				)`)
				.bind(timestamp, boundedLimit),
		]),
	);
	const deleted = {
		coachingSessions: resultChanges(results[0]),
		consentRecords: resultChanges(results[1]),
		devices: resultChanges(results[2]),
		syncProfiles: resultChanges(results[3]),
		roomFacts: resultChanges(results[4]),
	};
	return {
		...deleted,
		hasMore: Object.values(deleted).some((count) => count >= boundedLimit),
	};
}

function summaryFromRow(row: CoachingSummaryRow): CoachingSummary {
	try {
		return withoutLocalArtifacts(normalizeCoachingSummary(JSON.parse(row.summary_json) as unknown));
	} catch (error) {
		throw new PlatformError(
			"DATABASE_UNAVAILABLE",
			"A stored coaching summary failed its privacy schema check.",
			{ cause: error },
		);
	}
}

function consentFromRow(row: ConsentRow): CloudSummaryConsent {
	return {
		purpose: "cloud_summary",
		granted: row.granted === 1,
		policyVersion: row.policy_version,
		grantedAt: row.granted_at,
		revokedAt: row.revoked_at,
		updatedAt: row.updated_at,
	};
}

function roomFactFromRow(row: RoomFactRow): RoomFact {
	return {
		roomKey: row.room_key,
		firstObservedAt: row.first_observed_at,
		observedAt: row.last_observed_at,
		expiresAt: row.expires_at,
		stateVersion: row.state_version,
		milestone: row.last_milestone,
		phase: row.phase,
		playerCount: row.player_count,
		onlinePlayerCount: row.online_player_count,
		configuredRounds: row.configured_rounds,
		turnDurationSeconds: row.turn_duration_seconds,
		topicPack: row.topic_pack,
		completedTurnCount: row.completed_turn_count,
		finishedGameCount: row.finished_game_count,
		totalScore: row.total_score,
		lastTurnSpokenSeconds: row.last_turn_spoken_seconds,
	};
}

function analyticsFromRow(row: AnalyticsRow): DailyAnalyticsRow {
	return {
		day: row.day,
		metric: row.metric,
		eventCount: row.event_count,
		valueSum: row.value_sum,
		valueMin: row.value_min,
		valueMax: row.value_max,
		updatedAt: row.updated_at,
	};
}

function normalizeLimit(value: number | undefined): number {
	if (value === undefined) return 50;
	return finite(value, "limit", 1, MAX_COACHING_PAGE_SIZE, true);
}

function normalizePolicyVersion(value: unknown): string {
	if (typeof value !== "string" || !POLICY_VERSION_PATTERN.test(value)) {
		throw invalid("policyVersion", "must be a short lowercase policy identifier");
	}
	return value;
}

function normalizeSessionId(value: unknown, path: string): string {
	if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
		throw invalid(path, "must be a 1-128 character opaque identifier");
	}
	return value;
}

function normalizeRoomCode(value: unknown): string {
	if (typeof value !== "string") throw invalid("room code", "must be a six-character room code");
	const normalized = value.toUpperCase();
	if (!ROOM_CODE_PATTERN.test(normalized)) throw invalid("room code", "must be a valid six-character room code");
	return normalized;
}

function normalizeDay(value: unknown, path: string): string {
	if (typeof value !== "string" || !DAY_PATTERN.test(value)) {
		throw invalid(path, "must use YYYY-MM-DD");
	}
	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
		throw invalid(path, "must be a real UTC calendar date");
	}
	return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalid(path, "must be an object");
	}
	return value as Record<string, unknown>;
}

function array(value: unknown, path: string, maximumLength: number): unknown[] {
	if (!Array.isArray(value)) throw invalid(path, "must be an array");
	if (value.length > maximumLength) throw invalid(path, `may contain at most ${maximumLength} items`);
	return value;
}

function assertExactKeys(
	source: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
	optional: readonly string[] = ["artifacts"],
): void {
	const expected = new Set(allowed);
	const optionalKeys = new Set(optional);
	for (const key of Object.keys(source)) {
		if (!expected.has(key)) throw invalid(`${path}.${key}`, "is not an allowlisted field");
	}
	for (const key of allowed) {
		if (optionalKeys.has(key)) continue;
		if (!Object.hasOwn(source, key)) throw invalid(`${path}.${key}`, "is required");
	}
}

function assertJsonSize(value: unknown, maximumBytes: number, label: string): void {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw invalid(label, `must be JSON serializable (${safeErrorName(error)})`);
	}
	if (serialized === undefined) throw invalid(label, "must be JSON serializable");
	if (new TextEncoder().encode(serialized).byteLength > maximumBytes) {
		throw new PlatformError("PAYLOAD_TOO_LARGE", `${label} exceeds ${maximumBytes} bytes.`);
	}
}

function assertNoForbiddenCloudData(value: unknown): void {
	const seen = new WeakSet<object>();
	const visit = (candidate: unknown, path: string): void => {
		if (typeof candidate !== "object" || candidate === null) return;
		if (seen.has(candidate)) throw invalid(path, "must not contain circular data");
		seen.add(candidate);
		if (Array.isArray(candidate)) {
			candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
			return;
		}
		for (const [key, child] of Object.entries(candidate)) {
			const canonicalKey = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
			if (FORBIDDEN_CLOUD_KEYS.has(canonicalKey)) {
				throw new PlatformError(
					"FORBIDDEN_CLOUD_DATA",
					`Cloud summaries cannot contain raw audio, captured transcripts, or sample traces (${path}.${key}).`,
				);
			}
			visit(child, `${path}.${key}`);
		}
	};
	visit(value, "summary");
}

function text(value: unknown, path: string, maximumLength: number): string {
	if (typeof value !== "string") throw invalid(path, "must be text");
	const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
	if (!normalized) throw invalid(path, "must not be empty");
	if (normalized.length > maximumLength) throw invalid(path, `may contain at most ${maximumLength} characters`);
	return normalized;
}

function optionalText(value: unknown, path: string, maximumLength: number): string {
	if (typeof value !== "string") throw invalid(path, "must be text");
	const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
	if (normalized.length > maximumLength) throw invalid(path, `may contain at most ${maximumLength} characters`);
	return normalized;
}

function finite(
	value: unknown,
	path: string,
	minimum: number,
	maximum: number,
	integer = false,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(path, "must be a finite number");
	if (integer && !Number.isInteger(value)) throw invalid(path, "must be an integer");
	if (value < minimum || value > maximum) throw invalid(path, `must be between ${minimum} and ${maximum}`);
	return value;
}

function nullableFinite(
	value: unknown,
	path: string,
	minimum: number,
	maximum: number,
): number | null {
	return value === null ? null : finite(value, path, minimum, maximum);
}

function bool(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw invalid(path, "must be a boolean");
	return value;
}

function enumValue<const Value extends string>(
	value: unknown,
	values: ReadonlySet<Value>,
	path: string,
): Value {
	if (typeof value !== "string" || !values.has(value as Value)) {
		throw invalid(path, `must be one of: ${[...values].join(", ")}`);
	}
	return value as Value;
}

function isoTimestamp(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length > 40) throw invalid(path, "must be an ISO-8601 UTC timestamp");
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
		throw invalid(path, "must be a canonical ISO-8601 UTC timestamp");
	}
	return value;
}

function dateInput(value: Date | string, path: string): Date {
	const parsed = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
	if (!Number.isFinite(parsed.valueOf())) throw invalid(path, "must be a valid date");
	return parsed;
}

function expiryFrom(now: Date, retentionMs: number): string {
	return new Date(now.valueOf() + retentionMs).toISOString();
}

/**
 * Quantize the 30-day lease to UTC midnight. Cloud use still grants at least
 * 30 days, while repeated reads in one day do not rewrite every owned row.
 */
function anonymousExpiryFrom(now: Date): string {
	const dayMs = 24 * 60 * 60 * 1_000;
	const exactExpiry = now.valueOf() + ANONYMOUS_DATA_RETENTION_MS;
	return new Date(Math.ceil(exactExpiry / dayMs) * dayMs).toISOString();
}

function assertDeviceKey(value: unknown): asserts value is DeviceKey {
	if (typeof value !== "string" || !DEVICE_KEY_PATTERN.test(value)) {
		throw invalid("deviceKey", "must be a SHA-256 lowercase hex digest");
	}
}

async function sha256Hex(value: string): Promise<string> {
	try {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	} catch (error) {
		throw new PlatformError("DATABASE_UNAVAILABLE", "The platform identity hash could not be computed.", {
			cause: error,
		});
	}
}

async function hmacSha256Hex(keyBytes: Uint8Array, value: string): Promise<string> {
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			keyBytes,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	} catch (error) {
		throw new PlatformError("DATABASE_UNAVAILABLE", "The room-fact hash could not be computed.", {
			cause: error,
		});
	}
}

function resultChanges(result: D1Result<unknown> | undefined): number {
	return Number(result?.meta.changes ?? 0);
}

async function databaseOperation<Result>(label: string, operation: () => Promise<Result>): Promise<Result> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof PlatformError) throw error;
		throw new PlatformError("DATABASE_UNAVAILABLE", `Could not ${label}.`, { cause: error });
	}
}

function invalid(path: string, rule: string): PlatformError {
	return new PlatformError("INVALID_INPUT", `${path} ${rule}.`);
}

function safeErrorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown error";
}
