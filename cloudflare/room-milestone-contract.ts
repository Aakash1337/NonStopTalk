import {
	PlatformError,
	type PublicRoomFactDraft,
	type RoomMilestone,
} from "./platform";

export const ROOM_MILESTONE_PAYLOAD_DOMAIN = "nonstoptalk-room-milestone:v1";
export const MAX_ROOM_MILESTONE_PAYLOAD_BYTES = 1_024;

const LOWERCASE_HEX_256_PATTERN = /^[0-9a-f]{64}$/u;
const DELIVERABLE_MILESTONES = new Set([
	"created",
	"joined",
	"game-started",
	"turn-completed",
	"game-finished",
	"reset",
] as const);
const PHASES = new Set(["setup", "playing", "finished"] as const);
const TOPIC_PACKS = new Set(["everyday", "story", "absurd", "debate", "expert", "custom"] as const);
const ROOM_ANALYTICS_METRICS = new Set([
	"room_created",
	"room_joined",
	"game_started",
	"turn_completed",
	"game_finished",
] as const);

export type DeliverableRoomMilestone = Exclude<RoomMilestone, "snapshot">;
export type RoomMilestoneAnalyticsMetric =
	| "room_created"
	| "room_joined"
	| "game_started"
	| "turn_completed"
	| "game_finished";

/**
 * The persisted outbox payload has one byte representation. A fixed tuple
 * prevents object-key ordering or newly added public-room fields from changing
 * an already-created event's receipt hash.
 */
export type CanonicalRoomMilestonePayloadV1 = readonly [
	domain: typeof ROOM_MILESTONE_PAYLOAD_DOMAIN,
	roomInstanceId: string,
	milestone: DeliverableRoomMilestone,
	occurredAt: string,
	stateVersion: number,
	phase: PublicRoomFactDraft["phase"],
	playerCount: number,
	onlinePlayerCount: number,
	configuredRounds: number,
	turnDurationSeconds: number,
	topicPack: PublicRoomFactDraft["topicPack"],
	completedTurnCount: number,
	finishedGameCount: number,
	totalScore: number,
	lastTurnSpokenSeconds: number,
	analyticsMetric: RoomMilestoneAnalyticsMetric | null,
	analyticsValue: number | null,
];

export interface NormalizedRoomMilestonePayloadV1 {
	roomInstanceId: string;
	milestone: DeliverableRoomMilestone;
	occurredAt: string;
	stateVersion: number;
	phase: PublicRoomFactDraft["phase"];
	playerCount: number;
	onlinePlayerCount: number;
	configuredRounds: number;
	turnDurationSeconds: number;
	topicPack: PublicRoomFactDraft["topicPack"];
	completedTurnCount: number;
	finishedGameCount: number;
	totalScore: number;
	lastTurnSpokenSeconds: number;
	analyticsMetric: RoomMilestoneAnalyticsMetric | null;
	analyticsValue: number | null;
}

export interface RoomMilestoneDeliveryV1 {
	eventId: string;
	payloadJson: string;
}

export interface NormalizedRoomMilestoneDeliveryV1 extends RoomMilestoneDeliveryV1 {
	payload: NormalizedRoomMilestonePayloadV1;
}

/**
 * Select only aggregate fact fields. In particular, roomCode and any extra
 * public-room fields never enter the serialized payload.
 */
export function encodeRoomMilestonePayloadV1(
	roomInstanceId: unknown,
	fact: PublicRoomFactDraft,
): string {
	const instanceId = lowercaseHex256(roomInstanceId, "roomInstanceId");
	const analytics = expectedAnalytics(fact.milestone, fact.completedTurnCount, fact.lastTurnSpokenSeconds);
	const tuple: CanonicalRoomMilestonePayloadV1 = [
		ROOM_MILESTONE_PAYLOAD_DOMAIN,
		instanceId,
		fact.milestone as DeliverableRoomMilestone,
		fact.observedAt,
		fact.stateVersion,
		fact.phase,
		fact.playerCount,
		fact.onlinePlayerCount,
		fact.configuredRounds,
		fact.turnDurationSeconds,
		fact.topicPack,
		fact.completedTurnCount,
		fact.finishedGameCount,
		fact.totalScore,
		fact.lastTurnSpokenSeconds,
		analytics.metric,
		analytics.value,
	];
	const payloadJson = JSON.stringify(tuple);
	// Keep the producer and receiver on one strict contract. This also catches a
	// runtime caller that bypassed the TypeScript type with malformed values.
	decodeRoomMilestonePayloadV1(payloadJson);
	return payloadJson;
}

export function decodeRoomMilestonePayloadV1(payloadJson: unknown): NormalizedRoomMilestonePayloadV1 {
	if (typeof payloadJson !== "string") throw invalid("payloadJson", "must be text");
	if (new TextEncoder().encode(payloadJson).byteLength > MAX_ROOM_MILESTONE_PAYLOAD_BYTES) {
		throw new PlatformError(
			"PAYLOAD_TOO_LARGE",
			`Room milestone payload exceeds ${MAX_ROOM_MILESTONE_PAYLOAD_BYTES} bytes.`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson) as unknown;
	} catch (error) {
		throw invalid("payloadJson", "must be valid canonical JSON", error);
	}
	if (!Array.isArray(parsed) || parsed.length !== 17) {
		throw invalid("payloadJson", "must be the exact 17-field milestone tuple");
	}
	if (JSON.stringify(parsed) !== payloadJson) {
		throw invalid("payloadJson", "must use its canonical JSON representation");
	}

	const [
		domain,
		roomInstanceIdValue,
		milestoneValue,
		occurredAtValue,
		stateVersionValue,
		phaseValue,
		playerCountValue,
		onlinePlayerCountValue,
		configuredRoundsValue,
		turnDurationSecondsValue,
		topicPackValue,
		completedTurnCountValue,
		finishedGameCountValue,
		totalScoreValue,
		lastTurnSpokenSecondsValue,
		analyticsMetricValue,
		analyticsValueValue,
	] = parsed;

	if (domain !== ROOM_MILESTONE_PAYLOAD_DOMAIN) {
		throw invalid("payloadJson[0]", `must be ${ROOM_MILESTONE_PAYLOAD_DOMAIN}`);
	}
	const roomInstanceId = lowercaseHex256(roomInstanceIdValue, "payloadJson[1]");
	const milestone = enumValue(milestoneValue, DELIVERABLE_MILESTONES, "payloadJson[2]");
	const occurredAt = canonicalTimestamp(occurredAtValue, "payloadJson[3]");
	const stateVersion = finiteNumber(stateVersionValue, "payloadJson[4]", 1, Number.MAX_SAFE_INTEGER, true);
	const phase = enumValue(phaseValue, PHASES, "payloadJson[5]");
	const playerCount = finiteNumber(playerCountValue, "payloadJson[6]", 0, 12, true);
	const onlinePlayerCount = finiteNumber(onlinePlayerCountValue, "payloadJson[7]", 0, playerCount, true);
	const configuredRounds = finiteNumber(configuredRoundsValue, "payloadJson[8]", 1, 10, true);
	const turnDurationSeconds = finiteNumber(turnDurationSecondsValue, "payloadJson[9]", 10, 300, true);
	const topicPack = enumValue(topicPackValue, TOPIC_PACKS, "payloadJson[10]");
	const completedTurnCount = finiteNumber(completedTurnCountValue, "payloadJson[11]", 0, 1_200, true);
	const finishedGameCount = finiteNumber(finishedGameCountValue, "payloadJson[12]", 0, 21, true);
	const totalScore = finiteNumber(totalScoreValue, "payloadJson[13]", 0, 12_000_000, true);
	const lastTurnSpokenSeconds = finiteNumber(lastTurnSpokenSecondsValue, "payloadJson[14]", 0, 300);
	const analyticsMetric = analyticsMetricValue === null
		? null
		: enumValue(analyticsMetricValue, ROOM_ANALYTICS_METRICS, "payloadJson[15]");
	const analyticsValue = analyticsValueValue === null
		? null
		: finiteNumber(analyticsValueValue, "payloadJson[16]", 0, 1_200);

	assertMilestoneInvariants(
		milestone,
		phase,
		completedTurnCount,
		finishedGameCount,
		totalScore,
		lastTurnSpokenSeconds,
	);
	const expected = expectedAnalytics(milestone, completedTurnCount, lastTurnSpokenSeconds);
	if (analyticsMetric !== expected.metric || analyticsValue !== expected.value) {
		throw invalid("payloadJson", "analytics fields do not match the milestone facts");
	}

	return {
		roomInstanceId,
		milestone,
		occurredAt,
		stateVersion,
		phase,
		playerCount,
		onlinePlayerCount,
		configuredRounds,
		turnDurationSeconds,
		topicPack,
		completedTurnCount,
		finishedGameCount,
		totalScore,
		lastTurnSpokenSeconds,
		analyticsMetric,
		analyticsValue,
	};
}

export function normalizeRoomMilestoneDeliveryV1(input: unknown): NormalizedRoomMilestoneDeliveryV1 {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw invalid("delivery", "must be an object");
	}
	const source = input as Record<string, unknown>;
	const keys = Object.keys(source);
	if (keys.length !== 2 || !Object.hasOwn(source, "eventId") || !Object.hasOwn(source, "payloadJson")) {
		throw invalid("delivery", "must contain exactly eventId and payloadJson");
	}
	const eventId = lowercaseHex256(source.eventId, "delivery.eventId");
	if (typeof source.payloadJson !== "string") throw invalid("delivery.payloadJson", "must be text");
	return {
		eventId,
		payloadJson: source.payloadJson,
		payload: decodeRoomMilestonePayloadV1(source.payloadJson),
	};
}

export async function hashRoomMilestonePayloadV1(payloadJson: unknown): Promise<string> {
	if (typeof payloadJson !== "string") throw invalid("payloadJson", "must be text");
	decodeRoomMilestonePayloadV1(payloadJson);
	try {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadJson));
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	} catch (error) {
		throw new PlatformError("DATABASE_UNAVAILABLE", "The milestone payload hash could not be computed.", {
			cause: error,
		});
	}
}

function expectedAnalytics(
	milestone: RoomMilestone,
	completedTurnCount: number,
	lastTurnSpokenSeconds: number,
): { metric: RoomMilestoneAnalyticsMetric | null; value: number | null } {
	switch (milestone) {
		case "created":
			return { metric: "room_created", value: 0 };
		case "joined":
			return { metric: "room_joined", value: 0 };
		case "game-started":
			return { metric: "game_started", value: 0 };
		case "turn-completed":
			return { metric: "turn_completed", value: lastTurnSpokenSeconds };
		case "game-finished":
			return { metric: "game_finished", value: completedTurnCount };
		case "reset":
			return { metric: null, value: null };
		case "snapshot":
			throw invalid("milestone", "snapshot events cannot be delivered");
		default:
			throw invalid("milestone", "must be a deliverable room milestone");
	}
}

function assertMilestoneInvariants(
	milestone: DeliverableRoomMilestone,
	phase: PublicRoomFactDraft["phase"],
	completedTurnCount: number,
	finishedGameCount: number,
	totalScore: number,
	lastTurnSpokenSeconds: number,
): void {
	if (["created", "joined", "reset"].includes(milestone) && phase !== "setup") {
		throw invalid("payloadJson", `${milestone} requires setup phase`);
	}
	if (phase === "setup" && (completedTurnCount !== 0 || lastTurnSpokenSeconds !== 0)) {
		throw invalid("payloadJson", "setup phase cannot contain a completed or last turn");
	}
	if (milestone === "created" && (finishedGameCount !== 0 || totalScore !== 0)) {
		throw invalid("payloadJson", "created requires no finished games or score");
	}
	if (milestone === "reset" && totalScore !== 0) {
		throw invalid("payloadJson", "reset requires cleared scores");
	}
	if (milestone === "game-started" && (phase !== "playing" || completedTurnCount !== 0)) {
		throw invalid("payloadJson", "game-started requires playing phase with no completed turns");
	}
	if (milestone === "turn-completed" && (phase === "setup" || completedTurnCount < 1)) {
		throw invalid("payloadJson", "turn-completed requires a playing/finished game with a completed turn");
	}
	if (
		milestone === "game-finished"
		&& (phase !== "finished" || completedTurnCount < 1 || finishedGameCount < 1)
	) {
		throw invalid("payloadJson", "game-finished requires a finished game with a completed turn");
	}
}

function lowercaseHex256(value: unknown, path: string): string {
	if (typeof value !== "string" || !LOWERCASE_HEX_256_PATTERN.test(value)) {
		throw invalid(path, "must be a 256-bit lowercase hexadecimal value");
	}
	return value;
}

function canonicalTimestamp(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length !== 24) {
		throw invalid(path, "must be a canonical millisecond UTC timestamp");
	}
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
		throw invalid(path, "must be a canonical millisecond UTC timestamp");
	}
	return value;
}

function finiteNumber(
	value: unknown,
	path: string,
	minimum: number,
	maximum: number,
	integer = false,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(path, "must be a finite number");
	if (integer && !Number.isSafeInteger(value)) throw invalid(path, "must be a safe integer");
	if (value < minimum || value > maximum) {
		throw invalid(path, `must be between ${minimum} and ${maximum}`);
	}
	return value;
}

function enumValue<const Value extends string>(
	value: unknown,
	allowed: ReadonlySet<Value>,
	path: string,
): Value {
	if (typeof value !== "string" || !allowed.has(value as Value)) {
		throw invalid(path, `must be one of: ${[...allowed].join(", ")}`);
	}
	return value as Value;
}

function invalid(path: string, rule: string, cause?: unknown): PlatformError {
	return new PlatformError("INVALID_INPUT", `${path} ${rule}.`, cause === undefined ? {} : { cause });
}
