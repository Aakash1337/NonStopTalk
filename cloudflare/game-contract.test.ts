import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	COMPLETION_BONUS,
	GameError,
	MAX_PLAYER_NAME_CODE_POINTS,
	MAX_SCORE_CORRECTION_DELTA_MAGNITUDE,
	MAX_TOPIC_CODE_POINTS,
	MAX_TURN_ID_NUMBER,
	MINIMUM_SCORE,
	REMOTE_CLAIM_OBSERVATION_TOLERANCE_SECONDS,
	REMOTE_COMPLETION_GRACE_SECONDS,
	TURN_ID_EXHAUSTED_SENTINEL,
	TURN_ID_PREFIX,
	applyAction,
	createRoomState,
	joinRoom,
	type RoomState,
	type Turn,
} from "./game.ts";

interface RepeatedText {
	repeat: string;
	count: number;
	suffix?: string;
	suffixUtf16?: number[];
}

interface GameContract {
	schemaVersion: number;
	constants: {
		textLengthUnit: string;
		maxPlayerNameCodePoints: number;
		maxTopicCodePoints: number;
		remoteClaimObservationToleranceSeconds: number;
		remoteCompletionGraceSeconds: number;
		completionBonus: number;
		maxScoreCorrectionDeltaMagnitude: number;
		minimumScore: number;
		turnIdPrefix: string;
		maxTurnIdNumber: number;
		turnIdExhaustedSentinel: number;
	};
	cases: {
		unicodeTruncation: Array<{
			id: string;
			field: "player_name" | "topic";
			input: RepeatedText;
			expected: RepeatedText;
			expectedCodePoints: number;
		}>;
		remoteTurnClaims: Array<{
			id: string;
			durationSeconds: number;
			claimedSpokenSeconds: number;
			requestedCompleted: boolean;
			eliminated: boolean;
			serverElapsedSeconds: number;
			expectedSpokenSeconds: number;
			expectedCompleted: boolean;
		}>;
		turnSubmissions: Array<{
			id: string;
			durationSeconds: number;
			spokenSeconds: number;
			requestedCompleted: boolean;
			eliminated: boolean;
			expectedSpokenSeconds: number;
			expectedCompleted: boolean;
			expectedScore: number;
		}>;
		scoreCorrections: Array<{
			id: string;
			playerId: string;
			initialScore: number;
			requestedDelta: number;
			expectedAppliedDelta: number;
			expectedScore: number;
			expectedAccepted: boolean;
			errorCode?: string;
			expectedVersionChanged?: boolean;
		}>;
		customTopics: Array<{
			id: string;
			inputTopics: string[];
			initial: {
				topics: string[];
				topicPack: string;
				deck: number[];
				deckCursor: number;
				topicGeneration: number;
				version: number;
			};
			expected: {
				topics: string[];
				topicPack: string;
				deck: number[];
				deckCursor: number;
				topicGeneration: number;
				version: number;
				accepted: boolean;
				errorCode: string;
			};
		}>;
		turnCounters: Array<{
			id: string;
			allocation: "start_turn" | "redraw_turn";
			initialNextTurn: number;
			activeTurnId: string | null;
			completedTurnIds: string[];
			expectedAllocatedTurnId: string | null;
			expectedNextTurn: number;
			expectedAccepted: boolean;
			errorCode?: string;
			expectedHistoryPreserved?: boolean;
			expectedVersionChanged?: boolean;
		}>;
	};
}

const contract = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../testdata/game-contract.v1.json"), "utf8"),
) as GameContract;

const host = "a".repeat(64);
const guest = "b".repeat(64);

function expand(value: RepeatedText): string {
	const suffix = value.suffixUtf16
		? String.fromCharCode(...value.suffixUtf16)
		: value.suffix ?? "";
	return value.repeat.repeat(value.count) + suffix;
}

function roomWithTwoPlayers(duration = 60): RoomState {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	applyAction(room, host, { type: "settings", duration }, 2);
	return room;
}

function turnWithId(room: RoomState, id: string): Turn {
	const player = room.players[0];
	return {
		id,
		playerId: player.id,
		playerName: player.name,
		round: 1,
		topic: room.topics[0],
		topicIndex: 0,
		duration: room.settings.duration,
		silence: room.settings.silence,
		begunAt: null,
	};
}

function errorCode(error: unknown): string | null {
	if (!(error instanceof GameError)) return null;
	if (error.status === 404 && error.message === "Player not found.") return "player_not_found";
	if (error.message === "Choose at least one topic.") return "topics_required";
	if (error.status === 409 && error.message === "This room has exhausted its turn IDs.") return "turn_ids_exhausted";
	return null;
}

test("shared game contract constants match the Cloudflare engine", () => {
	assert.equal(contract.schemaVersion, 1);
	assert.equal(contract.constants.textLengthUnit, "unicode-code-points");
	assert.equal(contract.constants.maxPlayerNameCodePoints, MAX_PLAYER_NAME_CODE_POINTS);
	assert.equal(contract.constants.maxTopicCodePoints, MAX_TOPIC_CODE_POINTS);
	assert.equal(contract.constants.remoteClaimObservationToleranceSeconds, REMOTE_CLAIM_OBSERVATION_TOLERANCE_SECONDS);
	assert.equal(contract.constants.remoteCompletionGraceSeconds, REMOTE_COMPLETION_GRACE_SECONDS);
	assert.equal(contract.constants.completionBonus, COMPLETION_BONUS);
	assert.equal(contract.constants.maxScoreCorrectionDeltaMagnitude, MAX_SCORE_CORRECTION_DELTA_MAGNITUDE);
	assert.equal(contract.constants.minimumScore, MINIMUM_SCORE);
	assert.equal(contract.constants.turnIdPrefix, TURN_ID_PREFIX);
	assert.equal(contract.constants.maxTurnIdNumber, MAX_TURN_ID_NUMBER);
	assert.equal(contract.constants.turnIdExhaustedSentinel, TURN_ID_EXHAUSTED_SENTINEL);
});

test("shared Unicode truncation cases use whole code points", () => {
	for (const fixture of contract.cases.unicodeTruncation) {
		const input = expand(fixture.input);
		const expected = expand(fixture.expected);
		const room = createRoomState("ABC234", host, fixture.field === "player_name" ? input : "Alice", 0);
		let actual: string;
		if (fixture.field === "topic") {
			applyAction(room, host, { type: "custom-topics", topics: [input] }, 1);
			actual = room.topics[0];
		} else {
			actual = room.players[0].name;
		}
		assert.equal(actual, expected, fixture.id);
		assert.equal([...actual].length, fixture.expectedCodePoints, fixture.id);
	}
});

test("shared remote turn claims use observation tolerance and completion grace", () => {
	for (const fixture of contract.cases.remoteTurnClaims) {
		const room = roomWithTwoPlayers(fixture.durationSeconds);
		applyAction(room, host, { type: "move-player", playerId: "p2", offset: -1 }, 3);
		applyAction(room, host, { type: "start-game" }, 4);
		applyAction(room, guest, { type: "start-turn", afterTurnId: "" }, 5);
		const turnId = room.activeTurn?.id;
		const begunAt = 100_000;
		if (fixture.serverElapsedSeconds >= 0) {
			applyAction(room, guest, { type: "begin-turn", turnId }, begunAt);
		}
		applyAction(room, guest, {
			type: "submit-turn",
			turnId,
			spokenSeconds: fixture.claimedSpokenSeconds,
			completed: fixture.requestedCompleted,
			eliminated: fixture.eliminated,
		}, begunAt + Math.max(0, fixture.serverElapsedSeconds) * 1_000);
		const completed = room.completedTurns[0];
		assert.equal(completed.spokenSeconds, fixture.expectedSpokenSeconds, fixture.id);
		assert.equal(completed.completed, fixture.expectedCompleted, fixture.id);
	}
});

test("shared turn submission cases normalize completion and scoring", () => {
	for (const fixture of contract.cases.turnSubmissions) {
		const room = roomWithTwoPlayers(fixture.durationSeconds);
		applyAction(room, host, { type: "start-game" }, 3);
		applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 4);
		applyAction(room, host, {
			type: "submit-turn",
			turnId: room.activeTurn?.id,
			spokenSeconds: fixture.spokenSeconds,
			completed: fixture.requestedCompleted,
			eliminated: fixture.eliminated,
		}, 5);
		const completed = room.completedTurns[0];
		assert.equal(completed.spokenSeconds, fixture.expectedSpokenSeconds, fixture.id);
		assert.equal(completed.completed, fixture.expectedCompleted, fixture.id);
		assert.equal(completed.score, fixture.expectedScore, fixture.id);
	}
});

test("shared score correction cases enforce bounds, floor, and rejection", () => {
	for (const fixture of contract.cases.scoreCorrections) {
		const room = createRoomState("ABC234", host, "Alice", 0);
		room.players[0].score = fixture.initialScore;
		const initialVersion = room.version;
		let caught: unknown;
		try {
			applyAction(room, host, {
				type: "score",
				playerId: fixture.playerId,
				delta: fixture.requestedDelta,
			}, 1);
		} catch (error) {
			caught = error;
		}

		assert.equal(caught === undefined, fixture.expectedAccepted, fixture.id);
		assert.equal(room.players[0].score, fixture.expectedScore, fixture.id);
		const boundedDelta = fixture.expectedAccepted
			? Math.max(
				-contract.constants.maxScoreCorrectionDeltaMagnitude,
				Math.min(contract.constants.maxScoreCorrectionDeltaMagnitude, fixture.requestedDelta),
			)
			: 0;
		assert.equal(boundedDelta, fixture.expectedAppliedDelta, fixture.id);
		if (fixture.errorCode) assert.equal(errorCode(caught), fixture.errorCode, fixture.id);
		if (fixture.expectedVersionChanged !== undefined) {
			assert.equal(room.version !== initialVersion, fixture.expectedVersionChanged, fixture.id);
		}
		assert.ok(room.players[0].score >= contract.constants.minimumScore, fixture.id);
	}
});

test("shared empty custom-topic case rejects atomically", () => {
	for (const fixture of contract.cases.customTopics) {
		const room = createRoomState("ABC234", host, "Alice", 0);
		room.topics = [...fixture.initial.topics];
		room.settings.topicPack = fixture.initial.topicPack;
		room.deck = [...fixture.initial.deck];
		room.deckCursor = fixture.initial.deckCursor;
		room.topicGeneration = fixture.initial.topicGeneration;
		room.version = fixture.initial.version;
		let caught: unknown;
		try {
			applyAction(room, host, { type: "custom-topics", topics: fixture.inputTopics }, 1);
		} catch (error) {
			caught = error;
		}

		assert.equal(caught === undefined, fixture.expected.accepted, fixture.id);
		assert.equal(errorCode(caught), fixture.expected.errorCode, fixture.id);
		assert.deepEqual(room.topics, fixture.expected.topics, fixture.id);
		assert.equal(room.settings.topicPack, fixture.expected.topicPack, fixture.id);
		assert.deepEqual(room.deck, fixture.expected.deck, fixture.id);
		assert.equal(room.deckCursor, fixture.expected.deckCursor, fixture.id);
		assert.equal(room.topicGeneration, fixture.expected.topicGeneration, fixture.id);
		assert.equal(room.version, fixture.expected.version, fixture.id);
	}
});

test("shared stale turn-counter cases repair lazily without rewriting history", () => {
	for (const fixture of contract.cases.turnCounters) {
		const room = roomWithTwoPlayers();
		room.nextTurn = fixture.initialNextTurn;
		room.completedTurns = fixture.completedTurnIds.map((id) => turnWithId(room, id));
		const initialVersion = room.version;
		let caught: unknown;
		try {
			if (fixture.allocation === "start_turn") {
				applyAction(room, host, { type: "start-game" }, 3);
				applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 4);
			} else {
				applyAction(room, host, { type: "start-game" }, 3);
				room.nextTurn = fixture.initialNextTurn;
				room.completedTurns = fixture.completedTurnIds.map((id) => turnWithId(room, id));
				room.activeTurn = turnWithId(room, fixture.activeTurnId ?? "");
				applyAction(room, host, { type: "redraw-turn", turnId: fixture.activeTurnId }, 4);
			}
		} catch (error) {
			caught = error;
		}

		assert.equal(caught === undefined, fixture.expectedAccepted, fixture.id);
		if (fixture.errorCode) assert.equal(errorCode(caught), fixture.errorCode, fixture.id);
		assert.equal(room.activeTurn?.id ?? null, fixture.expectedAllocatedTurnId, fixture.id);
		assert.equal(room.nextTurn, fixture.expectedNextTurn, fixture.id);
		if (fixture.expectedVersionChanged !== undefined) {
			assert.equal(room.version !== initialVersion, fixture.expectedVersionChanged, fixture.id);
		}
		if (fixture.expectedHistoryPreserved) {
			assert.deepEqual(room.completedTurns.map((turn) => turn.id), fixture.completedTurnIds, fixture.id);
		}
		if (fixture.allocation === "redraw_turn") {
			assert.deepEqual(room.completedTurns.map((turn) => turn.id), fixture.completedTurnIds, fixture.id);
		}
		if (fixture.expectedAccepted) {
			assert.ok(room.activeTurn?.id.startsWith(contract.constants.turnIdPrefix), fixture.id);
		}
	}
});
