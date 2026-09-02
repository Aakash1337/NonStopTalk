import type { JudgeReviewResolution } from "./game";
import {
	gradeOfflineJudge,
	judgeBonus,
	normalizeJudgeVerdict,
	type JudgeTier,
	type JudgeVerdict,
} from "./judge";

export const MODEL_JUDGE_ROUTE = "/api/v1/models/judge";
export const JUDGE_INTERNAL_CALL_TIMEOUT_MS = 5_000;

const MAX_JUDGE_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_JUDGE_TRANSCRIPT_BYTES = 8 * 1024;
const MAX_INTERNAL_JUDGE_RESPONSE_BYTES = 8 * 1024;
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/u;
const TURN_ID_PATTERN = /^t([1-9][0-9]*)$/u;
const CLAIM_ID_PATTERN = /^[0-9a-f]{64}$/u;

interface JudgeRouteInput {
	roomCode: string;
	turnId: string;
	transcript: string;
	externalConsent: false;
}

interface InternalJudgeClaim {
	claimId: string;
	topic: string;
	tier: JudgeTier;
	deadlineAt: number;
}

interface JudgeRoomStub {
	fetch(request: Request): Response | Promise<Response>;
}

interface JudgeRoomNamespace {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): JudgeRoomStub;
}

export interface JudgeRouteBindings {
	ROOMS: JudgeRoomNamespace;
}

export interface JudgeRouteRuntime {
	internalCallTimeoutMs?: number;
	now?: () => number;
}

type JudgeRouteErrorCode =
	| "METHOD_NOT_ALLOWED"
	| "INVALID_ORIGIN"
	| "INVALID_INPUT"
	| "PAYLOAD_TOO_LARGE"
	| "JUDGE_AUTHORIZATION_REQUIRED"
	| "JUDGE_NOT_PENDING"
	| "JUDGE_UNAVAILABLE";

class JudgeRouteError extends Error {
	constructor(
		readonly code: JudgeRouteErrorCode,
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "JudgeRouteError";
	}
}

/**
 * Handle the disabled-by-default, offline-only judge route. The transcript is
 * scoped to this call and never crosses the room boundary; the Durable Object
 * receives only exact turn/claim coordination data and a canonical verdict.
 */
export async function handleJudgeRoute(
	request: Request,
	env: JudgeRouteBindings,
	browserToken: string,
	requestId: string,
	runtime: JudgeRouteRuntime = {},
): Promise<Response | null> {
	if (new URL(request.url).pathname !== MODEL_JUDGE_ROUTE) return null;
	if (request.method !== "POST") {
		const response = judgeErrorResponse(
			new JudgeRouteError("METHOD_NOT_ALLOWED", "Method not allowed.", 405),
			requestId,
		);
		response.headers.set("Allow", "POST");
		return response;
	}

	let transientTranscript = "";
	try {
		const internalCallTimeoutMs = normalizeInternalCallTimeout(runtime.internalCallTimeoutMs);
		const now = runtime.now ?? Date.now;
		requireExactJudgeOrigin(request);
		const input = normalizeJudgeRouteInput(await readJudgeJson(request));
		const roomCode = input.roomCode;
		const turnId = input.turnId;
		transientTranscript = input.transcript;
		// Do not let a timed-out internal operation retain the normalized input
		// object (and therefore its transcript) through an accidental closure.
		input.transcript = "";
		const claim = await withJudgeInternalDeadline(
			(signal) => claimJudgeTurn(env, roomCode, browserToken, turnId, signal),
			internalCallTimeoutMs,
		);

		let verdict: JudgeVerdict | null = null;
		let topic = claim.topic;
		claim.topic = "";
		try {
			verdict = normalizeJudgeVerdict(gradeOfflineJudge(topic, transientTranscript));
		} catch {
			// Every acquired capability gets a terminal resolution. An unexpected
			// local grading failure preserves the already-committed classic score.
		} finally {
			// JavaScript strings cannot be zeroed in place, but dropping every live
			// application reference immediately after synchronous grading prevents
			// the transcript from surviving the subsequent room-resolution wait.
			transientTranscript = "";
			topic = "";
		}

		const resolution: JudgeReviewResolution = verdict
			? { status: "done", verdict }
			: { status: "failed" };
		const resolveTimeoutMs = Math.min(
			internalCallTimeoutMs,
			claim.deadlineAt - now(),
		);
		if (resolveTimeoutMs < 1) throw unavailableError();
		await withJudgeInternalDeadline(
			(signal) => resolveJudgeTurn(
				env,
				roomCode,
				browserToken,
				turnId,
				claim.claimId,
				resolution,
				signal,
			),
			resolveTimeoutMs,
		);
		if (!verdict) throw unavailableError();

		return judgeJson({
			judge: {
				turnId,
				status: "done",
				relevance: verdict.relevance,
				confidence: verdict.confidence,
				feedback: verdict.feedback,
				bonus: judgeBonus(verdict.relevance),
			},
			tier: claim.tier,
			provider: "offline",
			model: null,
			external: false,
			requestId,
		}, 200, requestId);
	} catch (error) {
		return judgeErrorResponse(
			error instanceof JudgeRouteError ? error : unavailableError(),
			requestId,
		);
	} finally {
		transientTranscript = "";
	}
}

function normalizeInternalCallTimeout(value: number | undefined): number {
	if (value === undefined) return JUDGE_INTERNAL_CALL_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(value)
		|| value < 1
		|| value > JUDGE_INTERNAL_CALL_TIMEOUT_MS
	) throw unavailableError();
	return value;
}

export function isJudgeTurnId(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = TURN_ID_PATTERN.exec(value);
	return Boolean(match && Number.isSafeInteger(Number(match[1])));
}

export function isJudgeClaimId(value: unknown): value is string {
	return typeof value === "string" && CLAIM_ID_PATTERN.test(value);
}

async function claimJudgeTurn(
	env: JudgeRouteBindings,
	roomCode: string,
	browserToken: string,
	turnId: string,
	signal: AbortSignal,
): Promise<InternalJudgeClaim> {
	let response: Response;
	try {
		response = await judgeRoomFetch(env, roomCode, browserToken, "/claim-judge", { turnId }, signal);
	} catch {
		throw unavailableError();
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw judgeDependencyError(response.status);
	}
	let body: Record<string, unknown>;
	try {
		body = await readInternalJudgeResponse(response, signal);
	} catch {
		throw unavailableError();
	}
	assertExactInternalResponse(body, ["claim"]);
	if (!isRecord(body.claim)) throw unavailableError();
	assertExactInternalResponse(body.claim, ["claimId", "topic", "tier", "deadlineAt"]);
	const claimId = body.claim.claimId;
	const topic = body.claim.topic;
	const tier = body.claim.tier;
	const deadlineAt = body.claim.deadlineAt;
	if (
		!isJudgeClaimId(claimId)
		|| typeof topic !== "string"
		|| topic.length === 0
		|| topic !== topic.toWellFormed()
		|| [...topic].length > 200
		|| (tier !== "routine" && tier !== "escalated")
		|| !Number.isSafeInteger(deadlineAt)
		|| Number(deadlineAt) < 1
	) throw unavailableError();
	return { claimId, topic, tier, deadlineAt: Number(deadlineAt) };
}

async function resolveJudgeTurn(
	env: JudgeRouteBindings,
	roomCode: string,
	browserToken: string,
	turnId: string,
	claimId: string,
	resolution: JudgeReviewResolution,
	signal: AbortSignal,
): Promise<void> {
	let response: Response;
	try {
		response = await judgeRoomFetch(env, roomCode, browserToken, "/resolve-judge", {
			turnId,
			claimId,
			resolution,
		}, signal);
	} catch {
		throw unavailableError();
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw judgeDependencyError(response.status);
	}
	let body: Record<string, unknown>;
	try {
		body = await readInternalJudgeResponse(response, signal);
	} catch {
		throw unavailableError();
	}
	assertExactInternalResponse(body, ["resolved"]);
	if (body.resolved !== true) throw unavailableError();
}

async function judgeRoomFetch(
	env: JudgeRouteBindings,
	roomCode: string,
	browserToken: string,
	pathname: "/claim-judge" | "/resolve-judge",
	body: { turnId: string } | {
		turnId: string;
		claimId: string;
		resolution: JudgeReviewResolution;
	},
	signal: AbortSignal,
): Promise<Response> {
	const stub = env.ROOMS.get(env.ROOMS.idFromName(roomCode));
	return stub.fetch(new Request(`https://room.internal${pathname}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-NonStopTalk-Token": browserToken,
		},
		body: JSON.stringify(body),
		signal,
	}));
}

async function withJudgeInternalDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	if (
		!Number.isSafeInteger(timeoutMs)
		|| timeoutMs < 1
		|| timeoutMs > JUDGE_INTERNAL_CALL_TIMEOUT_MS
	) throw unavailableError();

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(unavailableError());
		}, timeoutMs);
	});
	try {
		// Abort is best-effort across a binding. The race remains the logical
		// deadline when a dependency or test double ignores the propagated signal.
		return await Promise.race([operation(controller.signal), timeout]);
	} catch (error) {
		if (controller.signal.aborted) throw unavailableError();
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function normalizeJudgeRouteInput(body: Record<string, unknown>): JudgeRouteInput {
	const keys = Object.keys(body);
	const allowed = new Set(["roomCode", "turnId", "transcript", "externalConsent"]);
	if (keys.some((key) => !allowed.has(key))) {
		throw new JudgeRouteError("INVALID_INPUT", "The judge request contains an unexpected field.", 400);
	}
	for (const required of ["roomCode", "turnId", "transcript", "externalConsent"] as const) {
		if (!Object.hasOwn(body, required)) {
			throw new JudgeRouteError("INVALID_INPUT", "The judge request is missing a required field.", 400);
		}
	}
	if (body.externalConsent !== false) {
		throw new JudgeRouteError(
			"INVALID_INPUT",
			"External consent must be false for offline judging.",
			400,
		);
	}

	const roomCode = typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : "";
	if (!ROOM_CODE_PATTERN.test(roomCode)) {
		throw new JudgeRouteError("INVALID_INPUT", "A valid room code is required.", 400);
	}
	const turnId = typeof body.turnId === "string" ? body.turnId.trim() : "";
	if (!isJudgeTurnId(turnId)) {
		throw new JudgeRouteError("INVALID_INPUT", "A valid turn ID is required.", 400);
	}
	if (typeof body.transcript !== "string" || body.transcript !== body.transcript.toWellFormed()) {
		throw new JudgeRouteError("INVALID_INPUT", "A valid transcript is required.", 400);
	}
	let transcript: string;
	try {
		transcript = body.transcript
			.normalize("NFC")
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
			.replace(/\s+/gu, " ")
			.trim();
	} catch {
		throw new JudgeRouteError("INVALID_INPUT", "A valid transcript is required.", 400);
	}
	if (!transcript || new TextEncoder().encode(transcript).byteLength > MAX_JUDGE_TRANSCRIPT_BYTES) {
		throw new JudgeRouteError(
			"INVALID_INPUT",
			`Transcript must contain 1-${MAX_JUDGE_TRANSCRIPT_BYTES} UTF-8 bytes after normalization.`,
			400,
		);
	}
	return { roomCode, turnId, transcript, externalConsent: false };
}

function requireExactJudgeOrigin(request: Request): void {
	if (request.headers.get("Origin") !== new URL(request.url).origin) {
		throw new JudgeRouteError("INVALID_ORIGIN", "Cross-origin request rejected.", 403);
	}
}

async function readJudgeJson(request: Request): Promise<Record<string, unknown>> {
	const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/json") {
		throw new JudgeRouteError("INVALID_INPUT", "Content-Type must be application/json.", 400);
	}
	const declaredHeader = request.headers.get("Content-Length");
	if (declaredHeader !== null) {
		const normalizedLength = declaredHeader.trim();
		if (!/^(?:0|[1-9][0-9]*)$/u.test(normalizedLength)) {
			throw new JudgeRouteError("INVALID_INPUT", "Content-Length is invalid.", 400);
		}
		const declaredLength = Number(normalizedLength);
		if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_JUDGE_REQUEST_BODY_BYTES) {
			throw new JudgeRouteError("PAYLOAD_TOO_LARGE", "The judge request body is too large.", 413);
		}
	}
	if (!request.body) {
		throw new JudgeRouteError("INVALID_INPUT", "A JSON request body is required.", 400);
	}

	const bytes = await readBoundedBytes(
		request.body,
		MAX_JUDGE_REQUEST_BODY_BYTES,
		() => new JudgeRouteError("PAYLOAD_TOO_LARGE", "The judge request body is too large.", 413),
	);
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
		const parsed: unknown = JSON.parse(decoded);
		if (!isRecord(parsed)) throw new Error("not an object");
		return parsed;
	} catch (error) {
		if (error instanceof JudgeRouteError) throw error;
		throw new JudgeRouteError("INVALID_INPUT", "Could not read judge request data.", 400);
	}
}

async function readInternalJudgeResponse(
	response: Response,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	if (!response.body) throw new Error("Internal judge response is missing its body.");
	const bytes = await readBoundedBytes(
		response.body,
		MAX_INTERNAL_JUDGE_RESPONSE_BYTES,
		() => new Error("Internal judge response is too large."),
		signal,
	);
	const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	const parsed: unknown = JSON.parse(decoded);
	if (!isRecord(parsed)) throw new Error("Internal judge response is invalid.");
	return parsed;
}

async function readBoundedBytes(
	stream: ReadableStream<Uint8Array>,
	maximum: number,
	tooLarge: () => Error,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const cancelForAbort = (): void => {
		void reader.cancel("internal judge deadline exceeded").catch(() => undefined);
	};
	if (signal?.aborted) cancelForAbort();
	else signal?.addEventListener("abort", cancelForAbort, { once: true });
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maximum) {
				await reader.cancel("body too large").catch(() => undefined);
				throw tooLarge();
			}
			chunks.push(value);
		}
	} finally {
		signal?.removeEventListener("abort", cancelForAbort);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function assertExactInternalResponse(body: Record<string, unknown>, expected: readonly string[]): void {
	const keys = Object.keys(body);
	if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(body, key))) {
		throw unavailableError();
	}
}

function judgeDependencyError(status: number): JudgeRouteError {
	if (status === 403) {
		return new JudgeRouteError(
			"JUDGE_AUTHORIZATION_REQUIRED",
			"Only the speaker who completed this turn can request its judge.",
			403,
		);
	}
	if (status === 404 || status === 409) {
		return new JudgeRouteError(
			"JUDGE_NOT_PENDING",
			"That turn is not waiting for an offline judge.",
			409,
		);
	}
	return unavailableError();
}

function unavailableError(): JudgeRouteError {
	return new JudgeRouteError(
		"JUDGE_UNAVAILABLE",
		"Offline judging is temporarily unavailable. Your classic score is safe; refresh the room to confirm the final review state.",
		503,
	);
}

function judgeErrorResponse(error: JudgeRouteError, requestId: string): Response {
	return judgeJson({
		error: { code: error.code, message: error.message },
		requestId,
	}, error.status, requestId);
}

function judgeJson(value: unknown, status: number, requestId: string): Response {
	return Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "application/json; charset=utf-8",
			"X-Content-Type-Options": "nosniff",
			"X-Request-ID": requestId,
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
