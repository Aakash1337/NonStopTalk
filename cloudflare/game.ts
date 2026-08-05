export const MAX_PLAYERS = 12;
export const COMPLETION_BONUS = 25;

export interface Player {
	id: string;
	name: string;
	score: number;
}

export interface Settings {
	duration: number;
	silence: number;
	rounds: number;
	topicPack: string;
}

export interface Turn {
	id: string;
	playerId: string;
	playerName: string;
	round: number;
	topic: string;
	topicIndex: number;
	duration: number;
	silence: number;
	begunAt: number | null;
	spokenSeconds?: number;
	completed?: boolean;
	eliminated?: boolean;
	score?: number;
}

export interface GameHistory {
	finishedAt: number;
	standings: Player[];
	turns: number;
}

export interface RoomState {
	code: string;
	version: number;
	hostToken: string;
	hostDisconnectedAt: number | null;
	createdAt: number;
	updatedAt: number;
	nextPlayer: number;
	nextTurn: number;
	players: Player[];
	members: Record<string, string>;
	settings: Settings;
	topics: string[];
	deck: number[];
	deckCursor: number;
	lastTopicIndex: number | null;
	currentPlayer: number;
	currentRound: number;
	phase: "setup" | "playing" | "finished";
	activeTurn: Turn | null;
	completedTurns: Turn[];
	history: GameHistory[];
}

export interface Action {
	type: string;
	[key: string]: unknown;
}

export const TOPIC_PACKS = [
	{
		id: "everyday",
		name: "Everyday Sparks",
		difficulty: "Easy",
		description: "Low-friction opinions and stories for a first game.",
		topics: [
			"The best breakfast food and why everyone else is wrong",
			"A tiny convenience that makes life dramatically better",
			"The most overrated household item",
			"Something everyone should try once",
			"A harmless rule you would add to daily life",
			"The best way to spend a rainy afternoon",
			"A skill that looks easy until you try it",
			"The ideal snack for a long road trip",
		],
	},
	{
		id: "story",
		name: "Story Time",
		difficulty: "Easy",
		description: "Personal stories that keep the words coming.",
		topics: [
			"A time you got completely lost",
			"The strangest meal you have ever eaten",
			"A plan that fell apart in the funniest way",
			"The best gift you have ever given or received",
			"A moment you were sure you were in trouble",
			"The most memorable stranger you have ever met",
			"A small victory you are still proud of",
			"The weirdest thing you believed as a kid",
		],
	},
	{
		id: "absurd",
		name: "Absurd Arguments",
		difficulty: "Medium",
		description: "Strange prompts that reward commitment.",
		topics: [
			"Why spoons deserve more respect than forks",
			"The official rules for living with a dragon roommate",
			"How to convince aliens that humans are normal",
			"Why elevators should have theme music",
			"The business case for professional pillow fighting",
			"How you would run a city where everyone walks backward",
			"Why clouds are suspicious",
			"The hidden politics of sandwich shapes",
		],
	},
	{
		id: "debate",
		name: "Fast Debate",
		difficulty: "Medium",
		description: "Clear positions for louder groups.",
		topics: [
			"Remote work is better than office work",
			"Movies are better when they are shorter",
			"Every city should ban cars from one street downtown",
			"Board games are better than video games at parties",
			"Cooking is more useful than coding",
			"Schools should teach negotiation",
			"Everyone should have to work in customer service once",
			"Public libraries are underrated infrastructure",
		],
	},
	{
		id: "expert",
		name: "Instant Expert",
		difficulty: "Hard",
		description: "Pretend mastery of topics nobody prepared for.",
		topics: [
			"The complete history of the paperclip",
			"How to referee a professional staring contest",
			"The migration patterns of shopping carts",
			"Advanced techniques in competitive queue standing",
			"The economics of lost socks",
			"A field guide to office chair species",
			"The secret training regimen of weather forecasters",
			"Why ancient civilizations feared the traffic cone",
		],
	},
] as const;

export class GameError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

export function createRoomState(
	code: string,
	hostToken: string,
	hostName: string,
	now = Date.now(),
): RoomState {
	const room: RoomState = {
		code,
		version: 1,
		hostToken,
		// Until the host's live socket connects, the creation request is the
		// latest proof that the host is present. This keeps takeover possible
		// when WebSockets are blocked or the creator closes immediately.
		hostDisconnectedAt: now,
		createdAt: now,
		updatedAt: now,
		nextPlayer: 1,
		nextTurn: 1,
		players: [],
		members: {},
		settings: { duration: 60, silence: 2, rounds: 1, topicPack: "everyday" },
		topics: [...TOPIC_PACKS[0].topics],
		deck: [],
		deckCursor: 0,
		lastTopicIndex: null,
		currentPlayer: 0,
		currentRound: 1,
		phase: "setup",
		activeTurn: null,
		completedTurns: [],
		history: [],
	};
	if (cleanName(hostName)) addPlayer(room, hostToken, hostName);
	return room;
}

export function joinRoom(room: RoomState, token: string, name: string, now = Date.now()): Player | null {
	const existingId = room.members[token];
	if (existingId) return room.players.find((player) => player.id === existingId) ?? null;
	if (token === room.hostToken && !cleanName(name)) return null;
	if (room.phase !== "setup") throw new GameError("This game has already started.", 409);
	if (room.players.length >= MAX_PLAYERS) throw new GameError("This room is full.", 409);
	const player = addPlayer(room, token, name);
	touch(room, now);
	return player;
}

export function applyAction(
	room: RoomState,
	token: string,
	action: Action,
	now = Date.now(),
	onlineTokens: Set<string> = new Set(),
): void {
	const isHost = room.hostToken === token;
	const playerId = room.members[token] ?? "";

	switch (action.type) {
		case "add-player": {
			requireHost(isHost);
			requireSetup(room);
			if (room.players.length >= MAX_PLAYERS) throw new GameError("This room is full.", 409);
			addPlayer(room, "", text(action.name));
			break;
		}
		case "rename-player": {
			requireSetup(room);
			const id = text(action.playerId);
			if (!isHost && id !== playerId) throw new GameError("You can only rename yourself.", 403);
			const player = findPlayer(room, id);
			const name = cleanName(text(action.name));
			if (!name) throw new GameError("Enter a player name.");
			player.name = name;
			if (room.activeTurn?.playerId === id) room.activeTurn.playerName = name;
			break;
		}
		case "move-player": {
			requireHost(isHost);
			requireSetup(room);
			const id = text(action.playerId);
			const from = room.players.findIndex((player) => player.id === id);
			if (from < 0) throw new GameError("Player not found.", 404);
			const offset = clamp(integer(action.offset, 0), -1, 1);
			const to = from + offset;
			if (offset && to >= 0 && to < room.players.length) {
				[room.players[from], room.players[to]] = [room.players[to], room.players[from]];
			}
			break;
		}
		case "remove-player": {
			requireHost(isHost);
			requireSetup(room);
			removePlayer(room, text(action.playerId));
			break;
		}
		case "leave": {
			if (!playerId) throw new GameError("You are not seated in this room.", 409);
			requireSetup(room);
			removePlayer(room, playerId);
			delete room.members[token];
			break;
		}
		case "settings": {
			requireHost(isHost);
			requireSetup(room);
			room.settings.duration = clamp(integer(action.duration, room.settings.duration), 10, 300);
			room.settings.silence = clamp(integer(action.silence, room.settings.silence), 1, 10);
			room.settings.rounds = clamp(integer(action.rounds, room.settings.rounds), 1, 10);
			const packId = text(action.topicPack);
			const pack = TOPIC_PACKS.find((candidate) => candidate.id === packId);
			if (pack) {
				room.settings.topicPack = pack.id;
				room.topics = [...pack.topics];
				resetDeck(room);
			}
			break;
		}
		case "custom-topics": {
			requireHost(isHost);
			requireSetup(room);
			const topics = Array.isArray(action.topics)
				? action.topics.map(String)
				: text(action.topics).replaceAll("\r\n", "\n").split("\n");
			const cleaned = cleanTopics(topics);
			if (!cleaned.length) throw new GameError("Choose at least one topic.");
			room.topics = cleaned;
			room.settings.topicPack = "custom";
			resetDeck(room);
			break;
		}
		case "start-game": {
			requireHost(isHost);
			// A retried request must not erase an in-progress game.
			if (room.phase === "playing") break;
			requireSetup(room);
			if (room.players.length < 2) throw new GameError("Add at least two players.", 409);
			if (!room.topics.length) throw new GameError("Choose at least one topic.", 409);
			archiveFinishedGame(room, now);
			room.phase = "playing";
			room.currentPlayer = 0;
			room.currentRound = 1;
			room.activeTurn = null;
			room.completedTurns = [];
			resetDeck(room);
			for (const player of room.players) player.score = 0;
			break;
		}
		case "start-turn": {
			requirePlaying(room);
			const afterTurnId = text(action.afterTurnId);
			const lastTurnId = room.completedTurns.at(-1)?.id ?? "";
			if (afterTurnId !== lastTurnId) throw new GameError("That next-turn request is stale.", 409);
			const current = room.players[room.currentPlayer];
			if (!current) throw new GameError("The current player is unavailable.", 409);
			if (!isHost && current.id !== playerId) throw new GameError("Only the next speaker or host can start this turn.", 403);
			if (room.activeTurn) break;
			const topicIndex = drawTopic(room);
			room.activeTurn = {
				id: `t${room.nextTurn++}`,
				playerId: current.id,
				playerName: current.name,
				round: room.currentRound,
				topic: room.topics[topicIndex],
				topicIndex,
				duration: room.settings.duration,
				silence: room.settings.silence,
				begunAt: null,
			};
			break;
		}
		case "begin-turn": {
			const turn = requireTurn(room, text(action.turnId));
			requireTurnDriver(isHost, playerId, turn);
			turn.begunAt ??= now;
			break;
		}
		case "redraw-turn": {
			const turn = requireTurn(room, text(action.turnId));
			requireTurnDriver(isHost, playerId, turn);
			if (turn.begunAt !== null) throw new GameError("A topic can only be redrawn before speaking begins.", 409);
			const topicIndex = drawTopic(room);
			turn.id = `t${room.nextTurn++}`;
			turn.topicIndex = topicIndex;
			turn.topic = room.topics[topicIndex];
			turn.begunAt = null;
			break;
		}
		case "submit-turn": {
			const turn = requireTurn(room, text(action.turnId));
			requireTurnDriver(isHost, playerId, turn);
			let spoken = clamp(integer(action.spokenSeconds, 0), 0, turn.duration);
			const eliminated = Boolean(action.eliminated);
			const requestedCompletion = Boolean(action.completed) && !eliminated;
			if (!isHost && turn.begunAt !== null) {
				const serverElapsed = Math.max(0, Math.floor((now - turn.begunAt) / 1000));
				if (requestedCompletion && serverElapsed + 2 >= turn.duration) {
					spoken = turn.duration;
				} else {
					spoken = Math.min(spoken, serverElapsed + 2);
				}
			} else if (!isHost) {
				spoken = 0;
			}
			const completed = requestedCompletion && spoken >= turn.duration;
			const scored: Turn = {
				...turn,
				spokenSeconds: spoken,
				completed,
				eliminated,
				score: spoken + (completed ? COMPLETION_BONUS : 0),
			};
			findPlayer(room, turn.playerId).score += scored.score ?? 0;
			room.completedTurns.push(scored);
			room.activeTurn = null;
			advance(room);
			break;
		}
		case "score": {
			requireHost(isHost);
			const player = findPlayer(room, text(action.playerId));
			const delta = clamp(integer(action.delta, 0), -100, 100);
			player.score = Math.max(0, player.score + delta);
			break;
		}
		case "reset": {
			requireHost(isHost);
			if (room.phase === "playing") throw new GameError("A running game cannot be reset.", 409);
			archiveFinishedGame(room, now);
			room.phase = "setup";
			room.currentPlayer = 0;
			room.currentRound = 1;
			room.activeTurn = null;
			room.completedTurns = [];
			resetDeck(room);
			for (const player of room.players) player.score = 0;
			break;
		}
		case "transfer-host": {
			requireHost(isHost);
			const target = text(action.playerId);
			const targetToken = Object.entries(room.members).find(([, id]) => id === target)?.[0];
			if (!targetToken) throw new GameError("That player is not connected from their own device.", 409);
			if (!onlineTokens.has(targetToken)) throw new GameError("That player is not online right now.", 409);
			room.hostToken = targetToken;
			room.hostDisconnectedAt = null;
			break;
		}
		case "claim-host": {
			if (!playerId) throw new GameError("Join the room before claiming host.", 403);
			if (room.hostDisconnectedAt === null || now - room.hostDisconnectedAt < 30_000) {
				throw new GameError("The host is still here.", 409);
			}
			room.hostToken = token;
			room.hostDisconnectedAt = null;
			break;
		}
		default:
			throw new GameError("Unknown room action.", 404);
	}

	// When the live socket is unavailable, a successful HTTP action is still
	// proof that the current host is present. Refresh the fallback timestamp
	// atomically with the mutation. Rejected actions never reach this point,
	// successful non-host actions fail the ownership check, and a completed
	// transfer no longer considers the old token the room host.
	if (room.hostToken === token && !onlineTokens.has(token)) {
		room.hostDisconnectedAt = now;
	}
	touch(room, now);
}

export function standings(room: RoomState): Player[] {
	return [...room.players].sort((left, right) => right.score - left.score);
}

export function publicRoomState(room: RoomState, token: string, onlineTokens: Set<string>, now = Date.now()) {
	const playerId = room.members[token] ?? "";
	const onlinePlayerIds = new Set(
		Object.entries(room.members)
			.filter(([memberToken]) => onlineTokens.has(memberToken))
			.map(([, id]) => id),
	);
	return {
		code: room.code,
		version: room.version,
		serverNow: now,
		phase: room.phase,
		players: room.players.map((player) => ({ ...player, online: onlinePlayerIds.has(player.id) })),
		settings: room.settings,
		topicCount: room.topics.length,
		// The undrawn deck is host-only so guests cannot inspect surprise topics.
		topics: room.hostToken === token ? room.topics : [],
		topicPacks: TOPIC_PACKS.map(({ topics, ...pack }) => ({ ...pack, count: topics.length })),
		currentPlayer: room.currentPlayer,
		currentRound: room.currentRound,
		activeTurn: room.activeTurn,
		completedTurns: room.completedTurns,
		lastTurn: room.completedTurns.at(-1) ?? null,
		standings: standings(room),
		winner: room.phase === "finished" ? standings(room)[0] ?? null : null,
		history: room.history,
		viewer: {
			playerId,
			isHost: room.hostToken === token,
			isMember: Boolean(playerId) || room.hostToken === token,
			hostDisconnected: room.hostDisconnectedAt !== null,
			hostClaimWaitMs:
				room.hostDisconnectedAt === null
					? 0
					: Math.max(0, 30_000 - (now - room.hostDisconnectedAt)),
			canClaimHost:
				Boolean(playerId) &&
				room.hostDisconnectedAt !== null &&
				now - room.hostDisconnectedAt >= 30_000,
		},
	};
}

export function setHostOnline(room: RoomState, online: boolean, now = Date.now()): boolean {
	const next = online ? null : room.hostDisconnectedAt ?? now;
	if (room.hostDisconnectedAt === next) return false;
	room.hostDisconnectedAt = next;
	touch(room, now);
	return true;
}

function addPlayer(room: RoomState, token: string, rawName: string): Player {
	const player: Player = {
		id: `p${room.nextPlayer++}`,
		name: cleanName(rawName) || `Player ${room.nextPlayer - 1}`,
		score: 0,
	};
	room.players.push(player);
	if (token) room.members[token] = player.id;
	return player;
}

function removePlayer(room: RoomState, id: string): void {
	const index = room.players.findIndex((player) => player.id === id);
	if (index < 0) throw new GameError("Player not found.", 404);
	room.players.splice(index, 1);
	for (const [token, playerId] of Object.entries(room.members)) {
		if (playerId === id) delete room.members[token];
	}
}

function findPlayer(room: RoomState, id: string): Player {
	const player = room.players.find((candidate) => candidate.id === id);
	if (!player) throw new GameError("Player not found.", 404);
	return player;
}

function requireHost(isHost: boolean): void {
	if (!isHost) throw new GameError("Only the host can do that.", 403);
}

function requireSetup(room: RoomState): void {
	if (room.phase !== "setup") throw new GameError("That can only be changed before a game.", 409);
}

function requirePlaying(room: RoomState): void {
	if (room.phase !== "playing") throw new GameError("The game is not in progress.", 409);
}

function requireTurn(room: RoomState, id: string): Turn {
	requirePlaying(room);
	if (!room.activeTurn || !id || room.activeTurn.id !== id) {
		throw new GameError("That turn is no longer active.", 409);
	}
	return room.activeTurn;
}

function requireTurnDriver(isHost: boolean, playerId: string, turn: Turn): void {
	if (!isHost && turn.playerId !== playerId) throw new GameError("Only the current speaker or host can do that.", 403);
}

function advance(room: RoomState): void {
	room.currentPlayer += 1;
	if (room.currentPlayer >= room.players.length) {
		room.currentPlayer = 0;
		room.currentRound += 1;
	}
	if (room.currentRound > room.settings.rounds) room.phase = "finished";
}

function archiveFinishedGame(room: RoomState, now: number): void {
	if (room.phase !== "finished" || !room.completedTurns.length) return;
	room.history.push({
		finishedAt: now,
		standings: standings(room).map((player) => ({ ...player })),
		turns: room.completedTurns.length,
	});
	if (room.history.length > 20) room.history = room.history.slice(-20);
}

function drawTopic(room: RoomState): number {
	if (!room.topics.length) throw new GameError("Choose at least one topic.", 409);
	if (!validDeck(room) || room.deckCursor >= room.deck.length) shuffleDeck(room);
	const index = room.deck[room.deckCursor++];
	room.lastTopicIndex = index;
	return index;
}

function validDeck(room: RoomState): boolean {
	return (
		room.deck.length === room.topics.length &&
		room.deckCursor >= 0 &&
		room.deckCursor <= room.deck.length &&
		new Set(room.deck).size === room.topics.length &&
		room.deck.every((index) => index >= 0 && index < room.topics.length)
	);
}

function shuffleDeck(room: RoomState): void {
	room.deck = room.topics.map((_, index) => index);
	for (let index = room.deck.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(Math.random() * (index + 1));
		[room.deck[index], room.deck[swap]] = [room.deck[swap], room.deck[index]];
	}
	if (room.deck.length > 1 && room.lastTopicIndex !== null && room.deck[0] === room.lastTopicIndex) {
		const swap = 1 + Math.floor(Math.random() * (room.deck.length - 1));
		[room.deck[0], room.deck[swap]] = [room.deck[swap], room.deck[0]];
	}
	room.deckCursor = 0;
}

function resetDeck(room: RoomState): void {
	room.deck = [];
	room.deckCursor = 0;
}

function cleanTopics(values: string[]): string[] {
	const topics: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const topic = String(value).trim().slice(0, 200).trim();
		const key = topic.toLocaleLowerCase();
		if (!topic || seen.has(key)) continue;
		seen.add(key);
		topics.push(topic);
		if (topics.length === 500) break;
	}
	return topics;
}

function cleanName(value: string): string {
	return value.trim().slice(0, 40).trim();
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function integer(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function touch(room: RoomState, now: number): void {
	room.version += 1;
	room.updatedAt = now;
}
