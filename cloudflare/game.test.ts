import assert from "node:assert/strict";
import test from "node:test";

import {
	COMPLETION_BONUS,
	GameError,
	JUDGE_BUSY_FEEDBACK,
	JUDGE_FAILED_FEEDBACK,
	JUDGE_REVIEW_TIMEOUT_MS,
	JUDGE_SKIPPED_FEEDBACK,
	JUDGE_TIMEOUT_FEEDBACK,
	MAX_PLAYERS,
	MAX_PENDING_JUDGE_REVIEWS,
	TOPIC_PACKS,
	applyAction,
	authorizeTopicGeneration,
	beginTopicGeneration,
	claimJudgeReview,
	createRoomState,
	expireJudgeReviews,
	joinRoom,
	nextJudgeReviewDeadline,
	publicRoomState,
	resolveJudgeReview,
	setHostOnline,
} from "./game.ts";
import { judgeBonus } from "./judge.ts";
import { parseRoomRoute } from "./routes.ts";

const host = "a".repeat(64);
const guest = "b".repeat(64);
const firstClaimId = "1".repeat(64);
const secondClaimId = "2".repeat(64);

function createJudgeRoom(tier: "routine" | "escalated" = "routine", rounds = 1) {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	applyAction(room, host, { type: "settings", duration: 10, rounds }, 2);
	applyAction(room, host, { type: "judge-settings", enabled: true, tier }, 3);
	applyAction(room, host, { type: "start-game" }, 4);
	return room;
}

test("creates a durable room with the host seated and default topics", () => {
	const room = createRoomState("ABC234", host, "  Alice  ", 100);
	assert.equal(room.code, "ABC234");
	assert.equal(room.players[0].name, "Alice");
	assert.equal(room.members[host], "p1");
	assert.deepEqual(room.topics, [...TOPIC_PACKS[0].topics]);
	assert.equal(room.phase, "setup");
});

test("joins once per browser identity and protects host actions", () => {
	const room = createRoomState("ABC234", host, "Alice", 100);
	const bob = joinRoom(room, guest, "Bob", 200);
	assert.equal(bob?.id, "p2");
	assert.equal(joinRoom(room, guest, "Ignored", 300)?.id, "p2");
	assert.equal(room.players.length, 2);
	assert.throws(
		() => applyAction(room, guest, { type: "settings", duration: 10 }, 400),
		(error: unknown) => error instanceof GameError && error.status === 403,
	);
});

test("topic generation preflight is host-only and setup-only", () => {
	const room = createRoomState("ABC234", host, "Alice", 100);
	joinRoom(room, guest, "Bob", 200);
	authorizeTopicGeneration(room, host);
	assert.throws(
		() => authorizeTopicGeneration(room, guest),
		(error: unknown) => error instanceof GameError && error.status === 403,
	);
	applyAction(room, host, { type: "start-game" }, 300);
	assert.throws(
		() => authorizeTopicGeneration(room, host),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
});

test("newer topic generations and manual edits invalidate stale drafts", () => {
	const room = createRoomState("ABC234", host, "Alice", 100);
	const first = beginTopicGeneration(room, host, 200);
	const second = beginTopicGeneration(room, host, 300);
	assert.equal(first, 1);
	assert.equal(second, 2);
	assert.throws(
		() => applyAction(room, host, {
			type: "custom-topics",
			topics: ["Old generated topic"],
			topicGeneration: first,
		}, 400),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	applyAction(room, host, {
		type: "custom-topics",
		topics: ["Newest generated topic"],
		topicGeneration: second,
	}, 500);
	assert.deepEqual(room.topics, ["Newest generated topic"]);
	assert.throws(
		() => applyAction(room, host, {
			type: "custom-topics",
			topics: ["Replayed generated topic"],
			topicGeneration: second,
		}, 550),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	applyAction(room, host, { type: "custom-topics", topics: ["Manual topic"] }, 600);
	assert.throws(
		() => applyAction(room, host, {
			type: "custom-topics",
			topics: ["Late generated topic"],
			topicGeneration: second,
		}, 700),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
});

test("applies a built-in setup kit as one canonical room mutation", () => {
	const room = createRoomState("ABC234", host, "Alice", 100);
	const pack = TOPIC_PACKS.find((candidate) => candidate.id === "absurd");
	assert.ok(pack);
	room.deck = room.topics.map((_, index) => index);
	room.deckCursor = 3;
	room.lastTopicIndex = 2;
	const beforeVersion = room.version;

	applyAction(room, host, {
		type: "apply-setup-kit",
		duration: "45",
		silence: "3",
		rounds: "2",
		topicPack: pack.id,
		topics: ["A browser-modified replacement must be ignored"],
	}, 250);

	assert.deepEqual(room.settings, { duration: 45, silence: 3, rounds: 2, topicPack: "absurd" });
	assert.deepEqual(room.topics, [...pack.topics]);
	assert.deepEqual(room.deck, []);
	assert.equal(room.deckCursor, 0);
	assert.equal(room.lastTopicIndex, null);
	assert.equal(room.topicGeneration, 1);
	assert.equal(room.version, beforeVersion + 1);
	assert.equal(room.updatedAt, 250);
	assert.equal(room.hostDisconnectedAt, 250);
});

test("applies and normalizes a custom setup kit", () => {
	const room = createRoomState("ABC234", host, "Alice", 100);
	room.topicGeneration = 7;
	room.deck = room.topics.map((_, index) => index);
	room.deckCursor = 2;
	room.lastTopicIndex = 1;

	applyAction(room, host, {
		type: "apply-setup-kit",
		duration: "999",
		silence: "-8",
		rounds: "0",
		topicPack: "custom",
		topics: "  First topic  \r\nFIRST TOPIC\r\nSecond topic  ",
	}, 200);

	assert.deepEqual(room.settings, { duration: 300, silence: 1, rounds: 1, topicPack: "custom" });
	assert.deepEqual(room.topics, ["First topic", "Second topic"]);
	assert.equal(room.topicGeneration, 8);
	assert.deepEqual(room.deck, []);
	assert.equal(room.deckCursor, 0);
	assert.equal(room.lastTopicIndex, null);
});

test("setup-kit topic deduplication uses locale-independent casing", () => {
	const room = createRoomState("ABC234", host, "Alice", 100);
	applyAction(room, host, {
		type: "apply-setup-kit",
		duration: 60,
		silence: 2,
		rounds: 1,
		topicPack: "custom",
		topics: ["İ", "i\u0307"],
	}, 200);
	assert.deepEqual(room.topics, ["İ"]);
});

test("invalid setup kits reject without mutating any room state", () => {
	const invalidKits = [
		{ topicPack: "custom", topics: " \r\n\t" },
		{ topicPack: "not-a-pack", topics: ["Otherwise valid topic"] },
	];

	for (const invalid of invalidKits) {
		const room = createRoomState("ABC234", host, "Alice", 100);
		room.settings = { duration: 90, silence: 4, rounds: 3, topicPack: "story" };
		room.topics = ["Existing one", "Existing two"];
		room.deck = [1, 0];
		room.deckCursor = 1;
		room.lastTopicIndex = 0;
		room.topicGeneration = 9;
		room.hostDisconnectedAt = 75;
		const before = structuredClone(room);

		assert.throws(
			() => applyAction(room, host, {
				type: "apply-setup-kit",
				duration: 10,
				silence: 1,
				rounds: 1,
				...invalid,
			}, 500),
			(error: unknown) => error instanceof GameError && error.status === 400,
		);
		assert.deepEqual(room, before);
	}
});

test("setup kits are host-only and setup-only", () => {
	const room = createRoomState("ABC234", host, "Alice", 100);
	joinRoom(room, guest, "Bob", 150);
	const kit = {
		type: "apply-setup-kit",
		duration: 45,
		silence: 3,
		rounds: 2,
		topicPack: "story",
		topics: [],
	};
	const beforeGuestAttempt = structuredClone(room);
	assert.throws(
		() => applyAction(room, guest, kit, 200),
		(error: unknown) => error instanceof GameError && error.status === 403,
	);
	assert.deepEqual(room, beforeGuestAttempt);

	applyAction(room, host, { type: "start-game" }, 250);
	const beforeStartedAttempt = structuredClone(room);
	assert.throws(
		() => applyAction(room, host, kit, 300),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	assert.deepEqual(room, beforeStartedAttempt);
});

test("applying a setup kit invalidates an outstanding generated-topic draft", () => {
	const room = createRoomState("ABC234", host, "Alice", 100);
	const draftGeneration = beginTopicGeneration(room, host, 150);
	const beforeVersion = room.version;
	applyAction(room, host, {
		type: "apply-setup-kit",
		duration: 60,
		silence: 2,
		rounds: 1,
		topicPack: "debate",
		topics: ["Ignored browser copy"],
	}, 200);
	assert.equal(room.topicGeneration, draftGeneration + 1);
	assert.equal(room.version, beforeVersion + 1);
	const applied = structuredClone(room);

	assert.throws(
		() => applyAction(room, host, {
			type: "custom-topics",
			topics: ["Late generated topic"],
			topicGeneration: draftGeneration,
		}, 250),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	assert.deepEqual(room, applied);
});

test("plays and scores a complete round with authoritative turn IDs", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	applyAction(room, host, { type: "start-game" }, 10);
	applyAction(room, host, { type: "start-turn" }, 20);
	const firstTurn = room.activeTurn?.id;
	assert.equal(firstTurn, "t1");
	applyAction(room, host, { type: "begin-turn", turnId: firstTurn }, 1_000);
	applyAction(
		room,
		host,
		{ type: "submit-turn", turnId: firstTurn, spokenSeconds: 60, completed: true },
		61_000,
	);
	assert.equal(room.players[0].score, 60 + COMPLETION_BONUS);
	assert.equal(room.currentPlayer, 1);

	applyAction(room, guest, { type: "start-turn", afterTurnId: firstTurn }, 62_000);
	const secondTurn = room.activeTurn?.id;
	assert.equal(secondTurn, "t2");
	assert.throws(
		() => applyAction(room, guest, { type: "begin-turn", turnId: firstTurn }, 63_000),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	applyAction(room, guest, { type: "begin-turn", turnId: secondTurn }, 63_000);
	applyAction(
		room,
		guest,
		{ type: "submit-turn", turnId: secondTurn, spokenSeconds: 3, completed: false },
		66_000,
	);
	assert.equal(room.players[1].score, 3);
	assert.equal(room.phase, "finished");
	assert.equal(room.completedTurns.length, 2);
});

test("server elapsed time caps a browser-supplied score", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	applyAction(room, host, { type: "move-player", playerId: "p2", offset: -1 }, 1);
	applyAction(room, host, { type: "start-game" }, 2);
	applyAction(room, guest, { type: "start-turn", afterTurnId: "" }, 3);
	const turnId = room.activeTurn?.id;
	applyAction(room, guest, { type: "begin-turn", turnId }, 10_000);
	applyAction(
		room,
		guest,
		{ type: "submit-turn", turnId, spokenSeconds: 60, completed: true },
		12_000,
	);
	assert.equal(room.completedTurns[0].spokenSeconds, 3);
	assert.equal(room.completedTurns[0].completed, false);
	assert.equal(room.players[0].score, 3);
});

test("topic deck does not repeat within a cycle or at a cycle boundary", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	applyAction(room, host, { type: "start-game" }, 2);
	applyAction(room, host, { type: "start-turn" }, 3);
	let turnId = room.activeTurn?.id;
	const topics = [room.activeTurn?.topic];
	for (let index = 1; index < room.topics.length + 1; index += 1) {
		applyAction(room, host, { type: "redraw-turn", turnId }, 3 + index);
		topics.push(room.activeTurn?.topic);
		turnId = room.activeTurn?.id;
	}
	assert.equal(new Set(topics.slice(0, room.topics.length)).size, room.topics.length);
	assert.notEqual(topics.at(-1), topics.at(-2));
});

test("JSON persistence keeps an in-progress game playable", () => {
	const original = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(original, guest, "Bob", 1);
	applyAction(original, host, { type: "start-game" }, 2);
	applyAction(original, host, { type: "start-turn" }, 3);
	const restored = JSON.parse(JSON.stringify(original));
	assert.equal(restored.activeTurn.id, "t1");
	applyAction(restored, host, { type: "redraw-turn", turnId: "t1" }, 4);
	assert.equal(restored.activeTurn.id, "t2");
	assert.equal(restored.version, original.version + 1);
});

test("public state never exposes identity tokens", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	const view = publicRoomState(room, guest, new Set([guest]), 2);
	const hostView = publicRoomState(room, host, new Set([host, guest]), 2);
	const serialized = JSON.stringify(view);
	assert.equal(view.viewer.playerId, "p2");
	assert.equal(view.players[1].online, true);
	assert.equal(view.topicCount, room.topics.length);
	assert.equal(view.maxPlayers, MAX_PLAYERS);
	assert.equal(view.completionBonus, COMPLETION_BONUS);
	assert.deepEqual(view.topics, []);
	assert.deepEqual(hostView.topics, room.topics);
	assert.equal(serialized.includes(host), false);
	assert.equal(serialized.includes(guest), false);
});

test("a seated player can claim hosting only after the disconnect grace", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	setHostOnline(room, true, 500);
	setHostOnline(room, false, 1_000);
	assert.throws(() => applyAction(room, guest, { type: "claim-host" }, 30_999), GameError);
	applyAction(room, guest, { type: "claim-host" }, 31_000);
	assert.equal(room.hostToken, guest);
});

test("successful host HTTP actions refresh takeover grace without weakening authorization", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	setHostOnline(room, true, 500);
	setHostOnline(room, false, 1_000);

	applyAction(room, host, { type: "settings", duration: 45 }, 20_000);
	assert.equal(room.hostDisconnectedAt, 20_000);
	assert.throws(() => applyAction(room, guest, { type: "settings", duration: 10 }, 25_000), GameError);
	assert.equal(room.hostDisconnectedAt, 20_000);
	assert.throws(() => applyAction(room, guest, { type: "claim-host" }, 49_999), GameError);

	applyAction(room, guest, { type: "claim-host" }, 50_000);
	assert.equal(room.hostToken, guest);
	assert.equal(room.hostDisconnectedAt, 50_000);
	assert.throws(() => applyAction(room, host, { type: "claim-host" }, 79_999), GameError);
	applyAction(room, host, { type: "claim-host" }, 80_000);
	assert.equal(room.hostToken, host);
	assert.equal(room.hostDisconnectedAt, 80_000);
});

test("score overrides and host transfers remain host-only", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	const bob = joinRoom(room, guest, "Bob", 1);
	assert.ok(bob);

	assert.throws(() => applyAction(room, guest, { type: "score", playerId: bob.id, delta: 5 }, 2), GameError);
	applyAction(room, host, { type: "score", playerId: bob.id, delta: 5 }, 3);
	assert.equal(bob.score, 5);

	assert.throws(() => applyAction(room, guest, { type: "transfer-host", playerId: bob.id }, 4), GameError);
	applyAction(room, host, { type: "transfer-host", playerId: bob.id }, 5, new Set([guest]));
	assert.equal(room.hostToken, guest);
	assert.equal(room.hostDisconnectedAt, null);
	assert.throws(() => applyAction(room, host, { type: "score", playerId: bob.id, delta: 5 }, 6), GameError);
});

test("redraw and next-turn replay guards invalidate delayed actions", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	applyAction(room, host, { type: "start-game" }, 2);
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 3);
	applyAction(room, host, { type: "redraw-turn", turnId: "t1" }, 4);
	assert.equal(room.activeTurn?.id, "t2");
	assert.throws(() => applyAction(room, host, { type: "begin-turn", turnId: "t1" }, 5), GameError);
	applyAction(room, host, { type: "submit-turn", turnId: "t2", spokenSeconds: 1 }, 6);
	assert.throws(() => applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 7), GameError);
	applyAction(room, host, { type: "start-turn", afterTurnId: "t2" }, 8);
	const activeId = room.activeTurn?.id;
	applyAction(room, host, { type: "start-turn", afterTurnId: "t2" }, 9);
	assert.equal(room.activeTurn?.id, activeId);
});

test("started turns and games reject setup-only mutations", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	applyAction(room, host, { type: "start-game" }, 2);
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 3);
	const turnId = room.activeTurn?.id;
	const topic = room.activeTurn?.topic;
	applyAction(room, host, { type: "begin-turn", turnId }, 4);

	assert.throws(
		() => applyAction(room, host, { type: "redraw-turn", turnId }, 5),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	assert.throws(() => joinRoom(room, "c".repeat(64), "Charlie", 6), GameError);
	assert.throws(() => applyAction(room, host, { type: "rename-player", playerId: "p1", name: "Changed" }, 7), GameError);
	assert.throws(() => applyAction(room, host, { type: "reset" }, 8), GameError);
	assert.equal(room.activeTurn?.id, turnId);
	assert.equal(room.activeTurn?.topic, topic);
	assert.equal(room.players[0].name, "Alice");
});

test("remote completion grace normalizes to full time and elimination wins", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	applyAction(room, host, { type: "move-player", playerId: "p2", offset: -1 }, 1);
	applyAction(room, host, { type: "start-game" }, 2);
	applyAction(room, guest, { type: "start-turn", afterTurnId: "" }, 3);
	applyAction(room, guest, { type: "begin-turn", turnId: "t1" }, 10_000);
	applyAction(room, guest, { type: "submit-turn", turnId: "t1", spokenSeconds: 58, completed: true }, 68_000);
	assert.equal(room.completedTurns[0].spokenSeconds, 60);
	assert.equal(room.completedTurns[0].completed, true);
	assert.equal(room.completedTurns[0].score, 60 + COMPLETION_BONUS);

	applyAction(room, host, { type: "start-turn", afterTurnId: "t1" }, 69_000);
	applyAction(room, host, { type: "submit-turn", turnId: "t2", spokenSeconds: 60, completed: true, eliminated: true }, 70_000);
	assert.equal(room.completedTurns[1].completed, false);
	assert.equal(room.completedTurns[1].eliminated, true);
	assert.equal(room.completedTurns[1].score, 60);
});

test("maps only valid public room API routes to Durable Object endpoints", () => {
	assert.deepEqual(parseRoomRoute("/api/rooms/abc234"), { code: "ABC234", endpoint: "state" });
	assert.deepEqual(parseRoomRoute("/api/rooms/ABC234/socket"), { code: "ABC234", endpoint: "socket" });
	assert.equal(parseRoomRoute("/room/ABC234"), null);
	assert.equal(parseRoomRoute("/api/rooms/ABCI01/state"), null);
	assert.equal(parseRoomRoute("/api/rooms/ABC234/delete"), null);
});

test("finished-game history keeps its score snapshot after reset", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);
	applyAction(room, host, { type: "settings", duration: 10 }, 2);
	applyAction(room, host, { type: "start-game" }, 3);
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 4);
	applyAction(room, host, { type: "submit-turn", turnId: "t1", spokenSeconds: 10, completed: true }, 14_000);
	applyAction(room, guest, { type: "start-turn", afterTurnId: "t1" }, 15_000);
	applyAction(room, guest, { type: "submit-turn", turnId: "t2", spokenSeconds: 2 }, 17_000);
	assert.equal(room.phase, "finished");
	applyAction(room, host, { type: "reset" }, 18_000);
	assert.equal(room.history[0].standings[0].score, 10 + COMPLETION_BONUS);
	assert.equal(room.players[0].score, 0);
});

test("judge state defaults off and legacy rooms remain ordinary classic games", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	assert.deepEqual(room.judge, { enabled: false, tier: "routine" });
	assert.deepEqual(room.pendingJudgeReviews, []);
	joinRoom(room, guest, "Bob", 1);
	delete room.judge;
	delete room.pendingJudgeReviews;

	const legacyView = publicRoomState(room, host, new Set(), 2);
	assert.deepEqual(legacyView.judge, { enabled: false, tier: "routine" });
	applyAction(room, host, { type: "start-game" }, 3);
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 4);
	applyAction(room, host, {
		type: "submit-turn",
		turnId: "t1",
		spokenSeconds: 8,
		judgeChoice: "transcript",
		manual: false,
		transcript: "must-never-be-stored",
	}, 5);

	assert.equal(room.completedTurns[0].score, 8);
	assert.equal(room.completedTurns[0].judge, undefined);
	assert.deepEqual(room.pendingJudgeReviews, []);
	assert.equal(JSON.stringify(room).includes("must-never-be-stored"), false);
});

test("judge configuration is host-only, setup-only, exact, and atomic", () => {
	const room = createRoomState("ABC234", host, "Alice", 0);
	joinRoom(room, guest, "Bob", 1);

	for (const [token, action, status] of [
		[guest, { type: "judge-settings", enabled: true, tier: "routine" }, 403],
		[host, { type: "judge-settings", enabled: "true", tier: "routine" }, 400],
		[host, { type: "judge-settings", enabled: true, tier: "flash" }, 400],
	] as const) {
		const before = structuredClone(room);
		assert.throws(
			() => applyAction(room, token, action, 10),
			(error: unknown) => error instanceof GameError && error.status === status,
		);
		assert.deepEqual(room, before);
	}

	applyAction(room, host, { type: "judge-settings", enabled: true, tier: "escalated" }, 11);
	assert.deepEqual(room.judge, { enabled: true, tier: "escalated" });
	applyAction(room, host, { type: "start-game" }, 12);
	const started = structuredClone(room);
	assert.throws(
		() => applyAction(room, host, { type: "judge-settings", enabled: false, tier: "routine" }, 13),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	assert.deepEqual(room, started);
});

test("enabled judge mode safely skips classic, manual, and missing choices", () => {
	const room = createJudgeRoom("routine", 2);
	const submissions = [
		{ token: host, after: "", action: {} },
		{ token: guest, after: "t1", action: { judgeChoice: "classic", manual: false } },
		{ token: host, after: "t2", action: { judgeChoice: "transcript", manual: true } },
	];

	for (const [index, submission] of submissions.entries()) {
		applyAction(room, submission.token, { type: "start-turn", afterTurnId: submission.after }, 10 + index * 2);
		applyAction(room, submission.token, {
			type: "submit-turn",
			turnId: `t${index + 1}`,
			spokenSeconds: 3,
			...submission.action,
		}, 11 + index * 2);
		assert.deepEqual(room.completedTurns[index].judge, {
			status: "skipped",
			bonus: 0,
			feedback: JUDGE_SKIPPED_FEEDBACK,
		});
	}
	assert.deepEqual(room.pendingJudgeReviews, []);
});

test("supplied judge choice and manual mode must use their exact wire types", () => {
	for (const invalid of [
		{ judgeChoice: "local" },
		{ judgeChoice: true },
		{ judgeChoice: "classic", manual: "false" },
	]) {
		const room = createJudgeRoom();
		applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
		const before = structuredClone(room);
		assert.throws(
			() => applyAction(room, host, {
				type: "submit-turn",
				turnId: "t1",
				spokenSeconds: 3,
				...invalid,
			}, 6),
			(error: unknown) => error instanceof GameError && error.status === 400,
		);
		assert.deepEqual(room, before);
	}
});

test("only the exact speaker can consent to transcript judging before classic scoring mutates", () => {
	const room = createJudgeRoom();
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	applyAction(room, host, {
		type: "submit-turn",
		turnId: "t1",
		spokenSeconds: 2,
		judgeChoice: "classic",
	}, 6);
	applyAction(room, guest, { type: "start-turn", afterTurnId: "t1" }, 7);
	const before = structuredClone(room);

	assert.throws(
		() => applyAction(room, host, {
			type: "submit-turn",
			turnId: "t2",
			spokenSeconds: 10,
			completed: true,
			judgeChoice: "transcript",
		}, 17_000),
		(error: unknown) => error instanceof GameError && error.status === 403,
	);
	assert.deepEqual(room, before);

	applyAction(room, guest, {
		type: "submit-turn",
		turnId: "t2",
		spokenSeconds: 1,
		judgeChoice: "transcript",
		manual: false,
	}, 8);
	assert.deepEqual(room.completedTurns[1].judge, { status: "pending", bonus: 0 });
});

test("transcript selection commits classic scoring and only transcript-free private metadata", () => {
	const room = createJudgeRoom("escalated");
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	applyAction(room, host, {
		type: "submit-turn",
		turnId: "t1",
		spokenSeconds: 10,
		completed: true,
		judgeChoice: "transcript",
		manual: false,
		transcript: "private-transcript-marker",
		audio: "private-audio-marker",
	}, 100);

	assert.equal(room.players[0].score, 10 + COMPLETION_BONUS);
	assert.deepEqual(room.completedTurns[0].judge, { status: "pending", bonus: 0 });
	assert.deepEqual(room.pendingJudgeReviews, [{
		turnId: "t1",
		playerId: "p1",
		tier: "escalated",
		deadlineAt: 100 + JUDGE_REVIEW_TIMEOUT_MS,
		claimId: null,
		claimedAt: null,
	}]);
	assert.equal(nextJudgeReviewDeadline(room), 100 + JUDGE_REVIEW_TIMEOUT_MS);
	const persisted = JSON.stringify(room);
	assert.equal(persisted.includes("private-transcript-marker"), false);
	assert.equal(persisted.includes("private-audio-marker"), false);

	const view = publicRoomState(room, host, new Set(), 101);
	assert.equal(view.standingsProvisional, true);
	assert.equal(view.winner, null);
	assert.deepEqual(view.completedTurns[0].judge, { status: "pending", bonus: 0 });
	assert.equal("pendingJudgeReviews" in view, false);
});

test("judge claims are speaker-only, exact-turn, one-time capabilities", () => {
	const room = createJudgeRoom("escalated");
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	applyAction(room, host, {
		type: "submit-turn",
		turnId: "t1",
		spokenSeconds: 4,
		judgeChoice: "transcript",
	}, 100);

	assert.throws(
		() => claimJudgeReview(room, guest, "t1", firstClaimId, 101),
		(error: unknown) => error instanceof GameError && error.status === 403,
	);
	assert.throws(
		() => claimJudgeReview(room, host, "t99", firstClaimId, 101),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	for (const invalidClaimId of ["not-a-server-claim", "A".repeat(64), "g".repeat(64)]) {
		assert.throws(
			() => claimJudgeReview(room, host, "t1", invalidClaimId, 101),
			(error: unknown) => error instanceof GameError && error.status === 400,
		);
	}

	const version = room.version;
	const claim = claimJudgeReview(room, host, "t1", firstClaimId, 102);
	assert.deepEqual(claim, {
		claimId: firstClaimId,
		turnId: "t1",
		topic: room.completedTurns[0].topic,
		tier: "escalated",
		deadlineAt: 100 + JUDGE_REVIEW_TIMEOUT_MS,
	});
	assert.equal(room.version, version + 1);
	assert.equal(room.pendingJudgeReviews?.[0].claimId, firstClaimId);
	assert.equal(room.pendingJudgeReviews?.[0].claimedAt, 102);
	const claimed = structuredClone(room);
	assert.throws(
		() => claimJudgeReview(room, host, "t1", firstClaimId, 103),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	assert.throws(
		() => claimJudgeReview(room, host, "t1", secondClaimId, 104),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	assert.deepEqual(room, claimed);
	assert.equal(JSON.stringify(publicRoomState(room, host, new Set(), 105)).includes(firstClaimId), false);
});

test("a review cannot be claimed at or after its exact deadline", () => {
	const room = createJudgeRoom();
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	applyAction(room, host, {
		type: "submit-turn", turnId: "t1", spokenSeconds: 4, judgeChoice: "transcript",
	}, 100);
	const deadline = 100 + JUDGE_REVIEW_TIMEOUT_MS;
	const before = structuredClone(room);
	assert.throws(
		() => claimJudgeReview(room, host, "t1", firstClaimId, deadline),
		(error: unknown) => error instanceof GameError && error.status === 409,
	);
	assert.deepEqual(room, before);
	assert.equal(expireJudgeReviews(room, deadline), 1);
	assert.deepEqual(room.completedTurns[0].judge, {
		status: "failed", bonus: 0, feedback: JUDGE_TIMEOUT_FEEDBACK,
	});
});

test("a host cannot claim the current guest speaker's transcript review", () => {
	const room = createJudgeRoom();
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	applyAction(room, host, { type: "submit-turn", turnId: "t1", spokenSeconds: 1 }, 6);
	applyAction(room, guest, { type: "start-turn", afterTurnId: "t1" }, 7);
	applyAction(room, guest, {
		type: "submit-turn",
		turnId: "t2",
		spokenSeconds: 1,
		judgeChoice: "transcript",
	}, 100);

	assert.throws(
		() => claimJudgeReview(room, host, "t2", firstClaimId, 101),
		(error: unknown) => error instanceof GameError && error.status === 403,
	);
	assert.equal(claimJudgeReview(room, guest, "t2", firstClaimId, 102).turnId, "t2");
});

test("a valid verdict adds one exact bonus without undoing host score corrections", () => {
	const room = createJudgeRoom();
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	applyAction(room, host, {
		type: "submit-turn",
		turnId: "t1",
		spokenSeconds: 10,
		completed: true,
		judgeChoice: "transcript",
	}, 100);
	claimJudgeReview(room, host, "t1", firstClaimId, 101);
	applyAction(room, host, { type: "score", playerId: "p1", delta: 5 }, 102);

	for (const attempt of [
		() => resolveJudgeReview(room, "t2", firstClaimId, {
			status: "done", verdict: { relevance: 0.55, confidence: 0.8, feedback: "Strong focus." },
		}, 103),
		() => resolveJudgeReview(room, "t1", secondClaimId, {
			status: "done", verdict: { relevance: 0.55, confidence: 0.8, feedback: "Strong focus." },
		}, 103),
		() => resolveJudgeReview(room, "t1", firstClaimId, {
			status: "done", verdict: { relevance: 2, confidence: 0.8, feedback: "Invalid." },
		}, 103),
	]) {
		const before = structuredClone(room);
		assert.equal(attempt(), false);
		assert.deepEqual(room, before);
	}

	const bonus = judgeBonus(0.55);
	assert.equal(resolveJudgeReview(room, "t1", firstClaimId, {
		status: "done",
		verdict: { relevance: 0.55, confidence: 0.8, feedback: "Strong focus." },
	}, 104), true);
	assert.equal(room.completedTurns[0].score, 10 + COMPLETION_BONUS + bonus);
	assert.equal(room.players[0].score, 10 + COMPLETION_BONUS + 5 + bonus);
	assert.equal(room.players[1].score, 0);
	assert.deepEqual(room.completedTurns[0].judge, {
		status: "done",
		bonus,
		relevance: 0.55,
		confidence: 0.8,
		feedback: "Strong focus.",
	});
	assert.deepEqual(room.pendingJudgeReviews, []);

	const resolved = structuredClone(room);
	assert.equal(resolveJudgeReview(room, "t1", firstClaimId, {
		status: "done",
		verdict: { relevance: 1, confidence: 1, feedback: "Replay." },
	}, 105), false);
	assert.deepEqual(room, resolved);
	const view = publicRoomState(room, host, new Set(), 106);
	assert.equal(view.standingsProvisional, false);
	assert.deepEqual(view.completedTurns[0].judge, {
		status: "done",
		bonus,
		relevance: 0.55,
		confidence: 0.8,
		confidenceLabel: "high confidence",
		feedback: "Strong focus.",
	});
});

test("failed and overdue reviews remain classic while independent reviews continue", () => {
	const room = createJudgeRoom();
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	applyAction(room, host, {
		type: "submit-turn", turnId: "t1", spokenSeconds: 4, judgeChoice: "transcript",
	}, 100);
	applyAction(room, guest, { type: "start-turn", afterTurnId: "t1" }, 101);
	applyAction(room, guest, { type: "begin-turn", turnId: "t2" }, 150);
	applyAction(room, guest, {
		type: "submit-turn", turnId: "t2", spokenSeconds: 3, judgeChoice: "transcript",
	}, 2_150);
	claimJudgeReview(room, host, "t1", firstClaimId, 2_201);
	claimJudgeReview(room, guest, "t2", secondClaimId, 2_202);

	const beforeDeadline = structuredClone(room);
	assert.equal(expireJudgeReviews(room, 100 + JUDGE_REVIEW_TIMEOUT_MS - 1), 0);
	assert.deepEqual(room, beforeDeadline);
	assert.equal(nextJudgeReviewDeadline(room), 100 + JUDGE_REVIEW_TIMEOUT_MS);

	assert.equal(expireJudgeReviews(room, 100 + JUDGE_REVIEW_TIMEOUT_MS), 1);
	assert.deepEqual(room.completedTurns[0].judge, {
		status: "failed", bonus: 0, feedback: JUDGE_TIMEOUT_FEEDBACK,
	});
	assert.deepEqual(room.completedTurns[1].judge, { status: "pending", bonus: 0 });
	assert.equal(room.players[0].score, 4);
	assert.equal(nextJudgeReviewDeadline(room), 2_150 + JUDGE_REVIEW_TIMEOUT_MS);
	const afterExpiry = structuredClone(room);
	assert.equal(resolveJudgeReview(room, "t1", firstClaimId, {
		status: "done", verdict: { relevance: 1, confidence: 1, feedback: "Late." },
	}, 100 + JUDGE_REVIEW_TIMEOUT_MS + 1), false);
	assert.deepEqual(room, afterExpiry);

	assert.equal(resolveJudgeReview(room, "t2", secondClaimId, { status: "failed" }, 2_204), true);
	assert.deepEqual(room.completedTurns[1].judge, {
		status: "failed", bonus: 0, feedback: JUDGE_FAILED_FEEDBACK,
	});
	assert.equal(room.players[1].score, 3);
	assert.equal(nextJudgeReviewDeadline(room), null);
});

test("orphaned legacy pending work reconciles to failed classic scoring", () => {
	const room = createJudgeRoom();
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	applyAction(room, host, {
		type: "submit-turn", turnId: "t1", spokenSeconds: 5, judgeChoice: "transcript",
	}, 100);
	room.completedTurns[0].score = 18;
	room.players[0].score = 18;
	delete room.pendingJudgeReviews;

	assert.equal(nextJudgeReviewDeadline(room), 0);
	assert.equal(expireJudgeReviews(room, 101), 1);
	assert.equal(room.completedTurns[0].score, 5);
	assert.equal(room.players[0].score, 5);
	assert.deepEqual(room.completedTurns[0].judge, {
		status: "failed", bonus: 0, feedback: JUDGE_FAILED_FEEDBACK,
	});
});

test("reset and new-game transitions clear every private judge capability", () => {
	const room = createJudgeRoom();
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	applyAction(room, host, {
		type: "submit-turn", turnId: "t1", spokenSeconds: 4, judgeChoice: "transcript",
	}, 100);
	applyAction(room, guest, { type: "start-turn", afterTurnId: "t1" }, 101);
	applyAction(room, guest, { type: "begin-turn", turnId: "t2" }, 200);
	applyAction(room, guest, {
		type: "submit-turn", turnId: "t2", spokenSeconds: 3, judgeChoice: "transcript",
	}, 2_200);
	assert.equal(room.phase, "finished");
	assert.equal(room.pendingJudgeReviews?.length, 2);

	applyAction(room, host, { type: "reset" }, 3_000);
	assert.deepEqual(room.pendingJudgeReviews, []);
	assert.deepEqual(room.completedTurns, []);
	assert.deepEqual(room.history[0].standings.map((player) => player.score), [4, 3]);
	assert.deepEqual(room.players.map((player) => player.score), [0, 0]);

	applyAction(room, host, { type: "start-game" }, 3_001);
	assert.deepEqual(room.pendingJudgeReviews, []);
	assert.equal(nextJudgeReviewDeadline(room), null);
});

test("public serialization allowlists room and turn data and normalizes judge fields", () => {
	const room = createJudgeRoom();
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	applyAction(room, host, {
		type: "submit-turn", turnId: "t1", spokenSeconds: 4, judgeChoice: "transcript",
	}, 100);
	const secret = "DO-NOT-LEAK-PRIVATE-JUDGE-DATA";
	Object.assign(room, { privateMarker: secret });
	Object.assign(room.players[0], { browserToken: secret });
	Object.assign(room.settings, { credential: secret });
	Object.assign(room.completedTurns[0], { transcript: secret, claimId: secret });
	Object.assign(room.completedTurns[0].judge ?? {}, { feedback: secret, bonus: 999, verdict: { transcript: secret } });
	Object.assign(room.pendingJudgeReviews?.[0] ?? {}, { transcript: secret, browserToken: secret });
	room.history.push({
		finishedAt: 1,
		standings: [Object.assign({ id: "p9", name: "Safe", score: 1 }, { token: secret })],
		turns: 1,
	});

	const view = publicRoomState(room, host, new Set(), 101);
	const serialized = JSON.stringify(view);
	assert.equal(serialized.includes(secret), false);
	assert.equal("pendingJudgeReviews" in view, false);
	assert.deepEqual(view.completedTurns[0].judge, { status: "pending", bonus: 0 });
	assert.deepEqual(view.judge, { enabled: true, tier: "routine" });

	room.judge = { enabled: "true", tier: "unknown" } as never;
	room.completedTurns[0].judge = {
		status: "done", bonus: 999, relevance: 2, confidence: -1, feedback: secret,
	};
	const corrupted = publicRoomState(room, host, new Set(), 102);
	assert.deepEqual(corrupted.judge, { enabled: false, tier: "routine" });
	assert.deepEqual(corrupted.completedTurns[0].judge, {
		status: "failed", bonus: 0, feedback: JUDGE_FAILED_FEEDBACK,
	});
});

test("private review storage stays bounded even when stale records are present", () => {
	const room = createJudgeRoom();
	applyAction(room, host, { type: "start-turn", afterTurnId: "" }, 5);
	room.pendingJudgeReviews = Array.from({ length: MAX_PENDING_JUDGE_REVIEWS + 50 }, (_, index) => ({
		turnId: `t${index + 50}`,
		playerId: "p1",
		tier: "routine" as const,
		deadlineAt: 100_000,
		claimId: null,
		claimedAt: null,
	}));
	applyAction(room, host, {
		type: "submit-turn", turnId: "t1", spokenSeconds: 2, judgeChoice: "transcript",
	}, 100);
	assert.equal(room.pendingJudgeReviews?.length, 1);
	assert.equal(room.pendingJudgeReviews?.[0].turnId, "t1");
	assert.ok((room.pendingJudgeReviews?.length ?? 0) <= MAX_PENDING_JUDGE_REVIEWS);
});
