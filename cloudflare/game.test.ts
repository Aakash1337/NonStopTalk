import assert from "node:assert/strict";
import test from "node:test";

import {
	COMPLETION_BONUS,
	GameError,
	MAX_PLAYERS,
	TOPIC_PACKS,
	applyAction,
	authorizeTopicGeneration,
	beginTopicGeneration,
	createRoomState,
	joinRoom,
	publicRoomState,
	setHostOnline,
} from "./game.ts";
import { parseRoomRoute } from "./routes.ts";

const host = "a".repeat(64);
const guest = "b".repeat(64);

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
