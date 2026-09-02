import {
	confidenceLabel,
	judgeBonus,
	normalizeJudgeVerdict,
	type JudgeTier,
	type JudgeVerdict,
} from "./judge";

export const MAX_PLAYERS = 12;
export const COMPLETION_BONUS = 25;
export const JUDGE_REVIEW_TIMEOUT_MS = 30_000;
export const MAX_PENDING_JUDGE_REVIEWS = MAX_PLAYERS * 10;
export const JUDGE_SKIPPED_FEEDBACK = "Classic scoring was used for this turn.";
export const JUDGE_BUSY_FEEDBACK = "The judge was busy, so scoring stays classic.";
export const JUDGE_FAILED_FEEDBACK = "The judge could not review this turn, so scoring stays classic.";
export const JUDGE_TIMEOUT_FEEDBACK = "The judge did not finish in time, so scoring stays classic.";
export const JUDGE_RESET_FEEDBACK = "The judge review ended with the game, so scoring stays classic.";
export const HOST_CLAIM_GRACE_MS = 30_000;
export const MAX_PLAYER_NAME_CODE_POINTS = 40;
export const MAX_TOPIC_CODE_POINTS = 200;
export const MAX_SCORE_CORRECTION_DELTA_MAGNITUDE = 100;
export const MINIMUM_SCORE = 0;
export const REMOTE_CLAIM_OBSERVATION_TOLERANCE_SECONDS = 1;
export const REMOTE_COMPLETION_GRACE_SECONDS = 2;
export const TURN_ID_PREFIX = "t";
export const MAX_TURN_ID_NUMBER = Number.MAX_SAFE_INTEGER;
export const TURN_ID_EXHAUSTED_SENTINEL = MAX_TURN_ID_NUMBER + 1;

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
	judge?: TurnJudge;
}

export type JudgeStatus = "pending" | "done" | "skipped" | "failed";

export interface TurnJudge {
	status: JudgeStatus;
	bonus: number;
	relevance?: number;
	confidence?: number;
	feedback?: string;
	/** Derived for public display; new room state does not persist this label. */
	confidenceLabel?: string;
}

export interface JudgeConfig {
	enabled: boolean;
	tier: JudgeTier;
}

/**
 * Private room-local coordination metadata. It is deliberately kept outside
 * Turn so public turn serialization can never reveal claim capability data.
 */
export interface PendingJudgeReview {
	turnId: string;
	playerId: string;
	tier: JudgeTier;
	deadlineAt: number;
	claimId: string | null;
	claimedAt: number | null;
}

export interface JudgeReviewClaim {
	claimId: string;
	turnId: string;
	topic: string;
	tier: JudgeTier;
	deadlineAt: number;
}

export type JudgeReviewResolution =
	| { status: "done"; verdict: JudgeVerdict }
	| { status: "failed" };

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
	topicGeneration: number;
	nextPlayer: number;
	nextTurn: number;
	players: Player[];
	members: Record<string, string>;
	settings: Settings;
	/** Missing on pre-judge persisted rooms and normalized to disabled/routine. */
	judge?: JudgeConfig;
	/** Private, bounded, transcript-free review coordination state. */
	pendingJudgeReviews?: PendingJudgeReview[];
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
		topicGeneration: 0,
		nextPlayer: 1,
		nextTurn: 1,
		players: [],
		members: {},
		settings: { duration: 60, silence: 2, rounds: 1, topicPack: "everyday" },
		judge: { enabled: false, tier: "routine" },
		pendingJudgeReviews: [],
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

/** Authorize the read-only preflight that gates optional topic generation. */
export function authorizeTopicGeneration(room: RoomState, token: string): void {
	if (room.hostToken !== token) throw new GameError("Only the host can generate room topics.", 403);
	requireSetup(room);
}

/** Reserve a generation number so newer requests/manual edits can invalidate an older result. */
export function beginTopicGeneration(room: RoomState, token: string, now = Date.now()): number {
	authorizeTopicGeneration(room, token);
	room.topicGeneration = currentTopicGeneration(room) + 1;
	touch(room, now);
	return room.topicGeneration;
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
				room.topicGeneration = currentTopicGeneration(room) + 1;
				room.settings.topicPack = pack.id;
				room.topics = [...pack.topics];
				resetDeck(room);
			}
			break;
		}
		case "judge-settings": {
			requireHost(isHost);
			requireSetup(room);
			if (typeof action.enabled !== "boolean") {
				throw new GameError("Choose whether the optional judge is enabled.");
			}
			if (action.tier !== "routine" && action.tier !== "escalated") {
				throw new GameError("Choose a valid judge tier.");
			}
			room.judge = { enabled: action.enabled, tier: action.tier };
			break;
		}
		case "apply-setup-kit": {
			requireHost(isHost);
			requireSetup(room);

			// A setup kit is one complete room mutation. Resolve and validate its
			// topic source before changing settings so a malformed browser-local
			// kit cannot leave a partially applied setup behind.
			const nextSettings = {
				duration: clamp(integer(action.duration, room.settings.duration), 10, 300),
				silence: clamp(integer(action.silence, room.settings.silence), 1, 10),
				rounds: clamp(integer(action.rounds, room.settings.rounds), 1, 10),
				topicPack: "",
			};
			const requestedPack = text(action.topicPack);
			const builtInPack = TOPIC_PACKS.find((candidate) => candidate.id === requestedPack);
			let nextTopics: string[];
			if (builtInPack) {
				nextSettings.topicPack = builtInPack.id;
				// Built-in packs are server-owned. Ignore any stale or modified copy
				// stored in the browser with the rest of the kit.
				nextTopics = [...builtInPack.topics];
			} else if (requestedPack === "custom") {
				nextSettings.topicPack = "custom";
				nextTopics = cleanActionTopics(action.topics);
				if (!nextTopics.length) throw new GameError("Choose at least one topic.");
			} else {
				throw new GameError("Choose a valid topic pack.");
			}
			const nextTopicGeneration = currentTopicGeneration(room) + 1;

			room.settings = nextSettings;
			room.topics = nextTopics;
			room.topicGeneration = nextTopicGeneration;
			resetDeck(room);
			// This index belongs to the replaced topic collection, unlike a deck
			// reset between games where cross-cycle repeat protection is useful.
			room.lastTopicIndex = null;
			break;
		}
		case "custom-topics": {
			requireHost(isHost);
			requireSetup(room);
			const cleaned = cleanActionTopics(action.topics);
			if (!cleaned.length) throw new GameError("Choose at least one topic.");
			if (action.topicGeneration !== undefined) {
				if (integer(action.topicGeneration, -1) !== currentTopicGeneration(room)) {
					throw new GameError("That generated topic draft is stale.", 409);
				}
			}
			// Both a generated apply and a manual edit consume/invalidate the
			// current draft number. A delayed or replayed generated response can
			// therefore never overwrite the accepted list.
			room.topicGeneration = currentTopicGeneration(room) + 1;
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
			// Repair a legacy counter before completed turn IDs are cleared. This
			// preserves monotonic IDs without rewriting stored turn history.
			repairNextTurn(room);
			terminalizeJudgeReviews(room, JUDGE_RESET_FEEDBACK);
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
			// Fail before advancing the topic deck when a persisted room has
			// exhausted the cross-runtime safe turn-ID range.
			repairNextTurn(room);
			const topicIndex = drawTopic(room);
			room.activeTurn = {
				id: nextTurnId(room),
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
			repairNextTurn(room);
			const topicIndex = drawTopic(room);
			turn.id = nextTurnId(room);
			turn.topicIndex = topicIndex;
			turn.topic = room.topics[topicIndex];
			turn.begunAt = null;
			break;
		}
		case "submit-turn": {
			const turn = requireTurn(room, text(action.turnId));
			requireTurnDriver(isHost, playerId, turn);
			const judgePlan = judgeSubmissionPlan(room, playerId, turn, action);
			let spoken = clamp(integer(action.spokenSeconds, 0), 0, turn.duration);
			const eliminated = Boolean(action.eliminated);
			const requestedCompletion = Boolean(action.completed) && !eliminated;
			if (!isHost) {
				const serverElapsed = turn.begunAt === null
					? -1
					: Math.floor((now - turn.begunAt) / 1000);
				const observed = serverElapsed < 0
					? 0
					: Math.min(
						turn.duration,
						serverElapsed + REMOTE_CLAIM_OBSERVATION_TOLERANCE_SECONDS,
					);
				spoken = Math.min(spoken, observed);
				if (
					requestedCompletion &&
					serverElapsed >= 0 &&
					serverElapsed + REMOTE_COMPLETION_GRACE_SECONDS >= turn.duration
				) {
					// A completion accepted inside the grace window must normalize to
					// the full duration so its score and completion bonus agree.
					spoken = turn.duration;
				}
			}
			const completed = requestedCompletion && spoken >= turn.duration;
			const scored: Turn = {
				...turn,
				spokenSeconds: spoken,
				completed,
				eliminated,
				score: spoken + (completed ? COMPLETION_BONUS : 0),
			};
			if (judgePlan === "pending") {
				scored.judge = { status: "pending", bonus: 0 };
				const reviews = canonicalPendingJudgeReviews(room);
				if (reviews.length < MAX_PENDING_JUDGE_REVIEWS) {
					reviews.push({
						turnId: scored.id,
						playerId: scored.playerId,
						tier: readJudgeConfig(room).tier,
						deadlineAt: now + JUDGE_REVIEW_TIMEOUT_MS,
						claimId: null,
						claimedAt: null,
					});
					room.pendingJudgeReviews = reviews;
				} else {
					scored.judge = { status: "failed", bonus: 0, feedback: JUDGE_BUSY_FEEDBACK };
				}
			} else if (judgePlan === "skipped") {
				scored.judge = { status: "skipped", bonus: 0, feedback: JUDGE_SKIPPED_FEEDBACK };
			}
			findPlayer(room, turn.playerId).score += scored.score ?? 0;
			room.completedTurns.push(scored);
			room.activeTurn = null;
			advance(room);
			break;
		}
		case "score": {
			requireHost(isHost);
			const player = findPlayer(room, text(action.playerId));
			const delta = clamp(
				integer(action.delta, 0),
				-MAX_SCORE_CORRECTION_DELTA_MAGNITUDE,
				MAX_SCORE_CORRECTION_DELTA_MAGNITUDE,
			);
			player.score = Math.max(MINIMUM_SCORE, player.score + delta);
			break;
		}
		case "reset": {
			requireHost(isHost);
			if (room.phase === "playing") throw new GameError("A running game cannot be reset.", 409);
			repairNextTurn(room);
			terminalizeJudgeReviews(room, JUDGE_RESET_FEEDBACK);
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
			if (room.hostDisconnectedAt === null || now - room.hostDisconnectedAt < HOST_CLAIM_GRACE_MS) {
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

/**
 * Atomically reserve one pending transcript review for the exact speaker that
 * consented on the completed turn. The claim ID is generated by the Worker;
 * no transcript, browser token, or provider payload is accepted into state.
 */
export function claimJudgeReview(
	room: RoomState,
	token: string,
	turnId: string,
	claimId: string,
	now = Date.now(),
): JudgeReviewClaim {
	if (!validJudgeClaimId(claimId)) throw new GameError("The judge claim ID is invalid.");
	const turn = room.completedTurns.find((candidate) => candidate.id === turnId);
	if (!turn || turn.judge?.status !== "pending") {
		throw new GameError("That judge review is no longer available.", 409);
	}
	if (room.members[token] !== turn.playerId) {
		throw new GameError("Only that turn's speaker can request its judge review.", 403);
	}

	const reviews = canonicalPendingJudgeReviews(room);
	const index = reviews.findIndex((review) =>
		review.turnId === turn.id && review.playerId === turn.playerId
	);
	const review = reviews[index];
	if (!review || review.claimId !== null || review.deadlineAt <= now) {
		throw new GameError("That judge review is no longer available.", 409);
	}

	reviews[index] = { ...review, claimId, claimedAt: now };
	room.pendingJudgeReviews = reviews;
	touch(room, now);
	return {
		claimId,
		turnId: turn.id,
		topic: turn.topic,
		tier: review.tier,
		deadlineAt: review.deadlineAt,
	};
}

/**
 * Resolve a previously claimed exact turn. Wrong, stale, late, or replayed
 * capabilities are inert. A committed resolution removes the capability
 * before another invocation can award a second bonus.
 */
export function resolveJudgeReview(
	room: RoomState,
	turnId: string,
	claimId: string,
	resolution: JudgeReviewResolution,
	now = Date.now(),
): boolean {
	if (!validJudgeClaimId(claimId)) return false;
	const reviews = canonicalPendingJudgeReviews(room);
	const reviewIndex = reviews.findIndex((review) =>
		review.turnId === turnId && review.claimId === claimId
	);
	const review = reviews[reviewIndex];
	if (!review || review.deadlineAt <= now) return false;
	const turn = room.completedTurns.find((candidate) => candidate.id === turnId);
	if (
		!turn ||
		turn.playerId !== review.playerId ||
		turn.judge?.status !== "pending"
	) return false;

	let verdict: JudgeVerdict | null = null;
	if (resolution?.status === "done") {
		try {
			verdict = normalizeJudgeVerdict(resolution.verdict);
		} catch {
			return false;
		}
	} else if (resolution?.status !== "failed") return false;

	if (verdict) {
		const bonus = judgeBonus(verdict.relevance);
		setResolvedTurnScore(room, turn, bonus);
		turn.judge = {
			status: "done",
			bonus,
			relevance: verdict.relevance,
			confidence: verdict.confidence,
			feedback: verdict.feedback,
		};
	} else {
		setResolvedTurnScore(room, turn, 0);
		turn.judge = { status: "failed", bonus: 0, feedback: JUDGE_FAILED_FEEDBACK };
	}

	reviews.splice(reviewIndex, 1);
	room.pendingJudgeReviews = reviews;
	touch(room, now);
	return true;
}

/** Fail overdue (and impossible legacy-orphaned) work back to classic scoring. */
export function expireJudgeReviews(room: RoomState, now = Date.now()): number {
	const reviews = canonicalPendingJudgeReviews(room);
	const usable = new Map<string, PendingJudgeReview>();
	for (const review of reviews) {
		const turn = room.completedTurns.find((candidate) => candidate.id === review.turnId);
		if (
			turn?.judge?.status === "pending" &&
			turn.playerId === review.playerId &&
			!usable.has(review.turnId)
		) usable.set(review.turnId, review);
	}

	let expired = 0;
	for (const turn of room.completedTurns) {
		if (turn.judge?.status !== "pending") continue;
		const review = usable.get(turn.id);
		if (review && review.deadlineAt > now) continue;
		setResolvedTurnScore(room, turn, 0);
		turn.judge = {
			status: "failed",
			bonus: 0,
			feedback: review ? JUDGE_TIMEOUT_FEEDBACK : JUDGE_FAILED_FEEDBACK,
		};
		usable.delete(turn.id);
		expired += 1;
	}
	if (!expired) return 0;

	room.pendingJudgeReviews = reviews.filter((review) => usable.get(review.turnId) === review);
	touch(room, now);
	return expired;
}

/** Earliest room-local judge deadline for multiplexing the Durable Object alarm. */
export function nextJudgeReviewDeadline(room: RoomState): number | null {
	const reviews = canonicalPendingJudgeReviews(room);
	const byTurn = new Map(reviews.map((review) => [review.turnId, review]));
	let earliest: number | null = null;
	for (const turn of room.completedTurns) {
		if (turn.judge?.status !== "pending") continue;
		const review = byTurn.get(turn.id);
		// A malformed or missing private row must wake promptly so the alarm can
		// repair the public pending state back to classic scoring.
		if (!review || review.playerId !== turn.playerId) return 0;
		if (earliest === null || review.deadlineAt < earliest) earliest = review.deadlineAt;
	}
	return earliest;
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
	const completedTurns = room.completedTurns.map(publicTurn);
	const publicStandings = standings(room).map(publicPlayer);
	const standingsProvisional = room.completedTurns.some((turn) => turn.judge?.status === "pending");
	return {
		code: room.code,
		version: room.version,
		serverNow: now,
		maxPlayers: MAX_PLAYERS,
		completionBonus: COMPLETION_BONUS,
		phase: room.phase,
		players: room.players.map((player) => ({
			...publicPlayer(player),
			online: onlinePlayerIds.has(player.id),
		})),
		settings: {
			duration: room.settings.duration,
			silence: room.settings.silence,
			rounds: room.settings.rounds,
			topicPack: room.settings.topicPack,
		},
		judge: readJudgeConfig(room),
		topicCount: room.topics.length,
		// The undrawn deck is host-only so guests cannot inspect surprise topics.
		topics: room.hostToken === token ? [...room.topics] : [],
		topicPacks: TOPIC_PACKS.map(({ topics, ...pack }) => ({ ...pack, count: topics.length })),
		currentPlayer: room.currentPlayer,
		currentRound: room.currentRound,
		activeTurn: room.activeTurn ? publicTurn(room.activeTurn) : null,
		completedTurns,
		lastTurn: completedTurns.at(-1) ?? null,
		standings: publicStandings,
		standingsProvisional,
		winner: room.phase === "finished" && !standingsProvisional ? publicStandings[0] ?? null : null,
		history: room.history.map((record) => ({
			finishedAt: record.finishedAt,
			standings: record.standings.map(publicPlayer),
			turns: record.turns,
		})),
		viewer: {
			playerId,
			isHost: room.hostToken === token,
			isMember: Boolean(playerId) || room.hostToken === token,
			hostDisconnected: room.hostDisconnectedAt !== null,
			hostClaimWaitMs:
				room.hostDisconnectedAt === null
					? 0
					: Math.max(0, HOST_CLAIM_GRACE_MS - (now - room.hostDisconnectedAt)),
			canClaimHost:
				Boolean(playerId) &&
				room.hostDisconnectedAt !== null &&
				now - room.hostDisconnectedAt >= HOST_CLAIM_GRACE_MS,
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

function readJudgeConfig(room: RoomState): JudgeConfig {
	return {
		enabled: room.judge?.enabled === true,
		tier: room.judge?.tier === "escalated" ? "escalated" : "routine",
	};
}

function judgeSubmissionPlan(
	room: RoomState,
	playerId: string,
	turn: Turn,
	action: Action,
): "none" | "skipped" | "pending" {
	if (
		action.judgeChoice !== undefined &&
		action.judgeChoice !== "classic" &&
		action.judgeChoice !== "transcript"
	) throw new GameError("Choose classic play or transcript judging.");
	if (action.manual !== undefined && typeof action.manual !== "boolean") {
		throw new GameError("The turn mode is invalid.");
	}
	if (action.judgeChoice === "transcript" && playerId !== turn.playerId) {
		throw new GameError("Only the current speaker can choose transcript judging.", 403);
	}

	const config = readJudgeConfig(room);
	if (!config.enabled) return "none";
	if (action.manual === true || action.judgeChoice !== "transcript") return "skipped";
	return "pending";
}

function terminalizeJudgeReviews(room: RoomState, feedback: string): void {
	for (const turn of room.completedTurns) {
		if (turn.judge?.status !== "pending") continue;
		setResolvedTurnScore(room, turn, 0);
		turn.judge = { status: "failed", bonus: 0, feedback };
	}
	room.pendingJudgeReviews = [];
}

function setResolvedTurnScore(room: RoomState, turn: Turn, bonus: number): void {
	const classic = classicTurnScore(turn);
	const prior = Number.isSafeInteger(turn.score) ? Number(turn.score) : classic;
	const next = classic + bonus;
	turn.score = next;
	const player = room.players.find((candidate) => candidate.id === turn.playerId);
	if (!player) return;
	player.score = Math.max(MINIMUM_SCORE, player.score + next - prior);
}

function classicTurnScore(turn: Turn): number {
	const duration = clamp(integer(turn.duration, 0), 0, 300);
	const spoken = clamp(integer(turn.spokenSeconds, 0), 0, duration);
	return spoken + (turn.completed === true && turn.eliminated !== true ? COMPLETION_BONUS : 0);
}

function canonicalPendingJudgeReviews(room: RoomState): PendingJudgeReview[] {
	if (!Array.isArray(room.pendingJudgeReviews)) return [];
	const reviews: PendingJudgeReview[] = [];
	const seen = new Set<string>();
	for (const value of room.pendingJudgeReviews) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const review = value as Partial<PendingJudgeReview>;
		if (
			typeof review.turnId !== "string" || !/^t[1-9][0-9]*$/.test(review.turnId) ||
			typeof review.playerId !== "string" || !/^p[1-9][0-9]*$/.test(review.playerId) ||
			(review.tier !== "routine" && review.tier !== "escalated") ||
			!Number.isSafeInteger(review.deadlineAt) || Number(review.deadlineAt) < 0 ||
			seen.has(review.turnId)
		) continue;
		const turn = room.completedTurns.find((candidate) => candidate.id === review.turnId);
		if (turn?.judge?.status !== "pending" || turn.playerId !== review.playerId) continue;

		let claimId: string | null = null;
		let claimedAt: number | null = null;
		if (review.claimId !== null) {
			if (
				typeof review.claimId !== "string" || !validJudgeClaimId(review.claimId) ||
				!Number.isSafeInteger(review.claimedAt) || Number(review.claimedAt) < 0 ||
				Number(review.claimedAt) > Number(review.deadlineAt)
			) continue;
			claimId = review.claimId;
			claimedAt = Number(review.claimedAt);
		} else if (review.claimedAt !== null) continue;

		seen.add(review.turnId);
		reviews.push({
			turnId: review.turnId,
			playerId: review.playerId,
			tier: review.tier,
			deadlineAt: Number(review.deadlineAt),
			claimId,
			claimedAt,
		});
		if (reviews.length === MAX_PENDING_JUDGE_REVIEWS) break;
	}
	return reviews;
}

function validJudgeClaimId(value: string): boolean {
	return /^[0-9a-f]{64}$/.test(value);
}

function publicPlayer(player: Player): Player {
	return { id: player.id, name: player.name, score: player.score };
}

function publicTurn(turn: Turn): Turn {
	const result: Turn = {
		id: turn.id,
		playerId: turn.playerId,
		playerName: turn.playerName,
		round: turn.round,
		topic: turn.topic,
		topicIndex: turn.topicIndex,
		duration: turn.duration,
		silence: turn.silence,
		begunAt: turn.begunAt,
	};
	if (typeof turn.spokenSeconds === "number") result.spokenSeconds = turn.spokenSeconds;
	if (typeof turn.completed === "boolean") result.completed = turn.completed;
	if (typeof turn.eliminated === "boolean") result.eliminated = turn.eliminated;
	if (typeof turn.score === "number") result.score = turn.score;
	const judge = publicTurnJudge(turn.judge);
	if (judge) result.judge = judge;
	return result;
}

function publicTurnJudge(value: TurnJudge | undefined): TurnJudge | undefined {
	if (!value) return undefined;
	switch (value.status) {
		case "pending":
			return { status: "pending", bonus: 0 };
		case "skipped":
			return { status: "skipped", bonus: 0, feedback: JUDGE_SKIPPED_FEEDBACK };
		case "failed": {
			const allowed = new Set([
				JUDGE_BUSY_FEEDBACK,
				JUDGE_FAILED_FEEDBACK,
				JUDGE_TIMEOUT_FEEDBACK,
				JUDGE_RESET_FEEDBACK,
			]);
			return {
				status: "failed",
				bonus: 0,
				feedback: allowed.has(value.feedback ?? "") ? value.feedback : JUDGE_FAILED_FEEDBACK,
			};
		}
		case "done": {
			try {
				const verdict = normalizeJudgeVerdict({
					relevance: value.relevance,
					confidence: value.confidence,
					feedback: value.feedback,
				});
				return {
					status: "done",
					bonus: judgeBonus(verdict.relevance),
					relevance: verdict.relevance,
					confidence: verdict.confidence,
					confidenceLabel: confidenceLabel(verdict.confidence),
					feedback: verdict.feedback,
				};
			} catch {
				return { status: "failed", bonus: 0, feedback: JUDGE_FAILED_FEEDBACK };
			}
		}
		default:
			return undefined;
	}
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

function currentTopicGeneration(room: RoomState): number {
	return Number.isSafeInteger(room.topicGeneration) && room.topicGeneration >= 0
		? room.topicGeneration
		: 0;
}

function nextTurnId(room: RoomState): string {
	repairNextTurn(room);
	if (!Number.isSafeInteger(room.nextTurn) || room.nextTurn < 1 || room.nextTurn > MAX_TURN_ID_NUMBER) {
		throw new GameError("This room has exhausted its turn IDs.", 409);
	}
	const id = `${TURN_ID_PREFIX}${room.nextTurn}`;
	// MAX_SAFE_INTEGER + 1 is an exact finite Number and acts only as a durable
	// exhaustion sentinel. repairNextTurn rejects it instead of resetting it,
	// so clearing old turn history can never make an ID reusable.
	room.nextTurn = room.nextTurn === MAX_TURN_ID_NUMBER
		? TURN_ID_EXHAUSTED_SENTINEL
		: room.nextTurn + 1;
	return id;
}

function repairNextTurn(room: RoomState): void {
	let maxUsed = 0;
	const remember = (id: string): void => {
		const match = /^t([1-9][0-9]*)$/.exec(id);
		if (!match) return;
		const numberText = match[1];
		const used = Number(numberText);
		if (!Number.isSafeInteger(used) || used > MAX_TURN_ID_NUMBER) return;
		if (used > maxUsed) maxUsed = used;
	};
	if (room.activeTurn) remember(room.activeTurn.id);
	for (const turn of room.completedTurns) remember(turn.id);

	if (typeof room.nextTurn === "number" && Number.isFinite(room.nextTurn) && room.nextTurn > MAX_TURN_ID_NUMBER) {
		throw new GameError("This room has exhausted its turn IDs.", 409);
	}
	if (maxUsed >= MAX_TURN_ID_NUMBER) {
		throw new GameError("This room has exhausted its turn IDs.", 409);
	}
	const persisted = Number.isSafeInteger(room.nextTurn) && room.nextTurn >= 1 ? room.nextTurn : 1;
	room.nextTurn = Math.max(persisted, maxUsed + 1);
}

function cleanTopics(values: string[]): string[] {
	const topics: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const topic = trimGameSpace(
			truncateCodePoints(trimGameSpace(String(value)), MAX_TOPIC_CODE_POINTS),
		);
		// Keep duplicate handling identical across browser and Worker locales.
		const key = topic.toLowerCase();
		if (!topic || seen.has(key)) continue;
		seen.add(key);
		topics.push(topic);
		if (topics.length === 500) break;
	}
	return topics;
}

function cleanActionTopics(value: unknown): string[] {
	const topics = Array.isArray(value)
		? value.map(String)
		: text(value).replaceAll("\r\n", "\n").split("\n");
	return cleanTopics(topics);
}

function cleanName(value: string): string {
	return trimGameSpace(
		truncateCodePoints(trimGameSpace(value), MAX_PLAYER_NAME_CODE_POINTS),
	);
}

function truncateCodePoints(value: string, maximum: number): string {
	return [...value.toWellFormed()].slice(0, maximum).join("");
}

function trimGameSpace(value: string): string {
	// Align the Go and ECMAScript whitespace sets: Unicode White_Space plus
	// the BOM/zero-width no-break space that browsers traditionally trim.
	return value.replace(/^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu, "");
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
