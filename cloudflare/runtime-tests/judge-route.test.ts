import { env } from "cloudflare:workers";
import {
	createExecutionContext,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { RoomState } from "../game";
import { handleJudgeRoute } from "../judge-routes";
import worker, { RoomDurableObject } from "../worker";
import { parseRoomRoute } from "../routes";

const SPEAKER_TOKEN = "a".repeat(64);
const HOST_TOKEN = "b".repeat(64);
const CLAIM_ID = "c".repeat(64);
const ROOM_CODE = "JDG234";
const TRANSCRIPT_CANARY = "private transcript must remain only in Worker memory";

function passingLimiter(onLimit?: (key: string) => void): RateLimit {
	return {
		limit: async ({ key }) => {
			onLimit?.(key);
			return { success: true };
		},
	} as RateLimit;
}

function workerEnv(
	rooms: Pick<DurableObjectNamespace<RoomDurableObject>, "idFromName" | "get">,
	onLimit?: (key: string) => void,
): Parameters<typeof worker.fetch>[1] {
	return {
		ROOMS: rooms,
		API_RATE_LIMITER: passingLimiter(onLimit),
		MODEL_RATE_LIMITER: passingLimiter(onLimit),
	} as Parameters<typeof worker.fetch>[1];
}

function judgeRequest(
	body: Record<string, unknown> = {
		roomCode: ROOM_CODE,
		turnId: "t1",
		transcript: TRANSCRIPT_CANARY,
		externalConsent: false,
	},
	options: {
		method?: string;
		origin?: string | null;
		contentType?: string;
		token?: string;
		rawBody?: BodyInit;
	} = {},
): Request {
	const requestOrigin = "https://nonstoptalk.test";
	const headers = new Headers({
		Cookie: `nonstoptalk_token=${options.token ?? SPEAKER_TOKEN}`,
		"Content-Type": options.contentType ?? "application/json",
	});
	if (options.origin !== null) headers.set("Origin", options.origin ?? requestOrigin);
	return new Request(`${requestOrigin}/api/v1/models/judge`, {
		method: options.method ?? "POST",
		headers,
		body: options.method === "GET"
			? undefined
			: options.rawBody ?? JSON.stringify(body),
	});
}

function recordingRooms(
	requests: Request[],
	respond: (request: Request) => Promise<Response> | Response,
): Pick<DurableObjectNamespace<RoomDurableObject>, "idFromName" | "get"> {
	return {
		idFromName: () => ({}) as DurableObjectId,
		get: () => ({
			fetch: async (request: Request) => {
				requests.push(request.clone());
				return respond(request);
			},
		}) as DurableObjectStub<RoomDurableObject>,
	};
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
	return response.json<Record<string, unknown>>();
}

describe("offline judge Worker privacy boundary", () => {
	it("grades in Worker memory and forwards only bounded claim and resolution data", async () => {
		const forwarded: Request[] = [];
		const limiterKeys: string[] = [];
		const rooms = recordingRooms(forwarded, async (request) => {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/claim-judge") {
				return Response.json({
					claim: {
						claimId: CLAIM_ID,
						topic: "Why clouds are suspicious",
						tier: "routine",
						deadlineAt: Date.now() + 30_000,
					},
				});
			}
			if (pathname === "/resolve-judge") return Response.json({ resolved: true });
			return new Response(null, { status: 404 });
		});

		const response = await worker.fetch(
			judgeRequest(),
			workerEnv(rooms, (key) => limiterKeys.push(key)),
			createExecutionContext(),
		);
		const responseText = await response.text();
		const payload = JSON.parse(responseText) as {
			judge: {
				turnId: string;
				status: string;
				relevance: number;
				confidence: number;
				feedback: string;
				bonus: number;
			};
			tier: string;
			provider: string;
			model: null;
			external: boolean;
			requestId: string;
		};

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(payload).toMatchObject({
			judge: { turnId: "t1", status: "done", confidence: 0.3 },
			tier: "routine",
			provider: "offline",
			model: null,
			external: false,
		});
		expect(payload.judge.bonus).toBe(Math.round(payload.judge.relevance * 20));
		expect(payload.requestId).toBe(response.headers.get("X-Request-ID"));
		expect(responseText).not.toContain(TRANSCRIPT_CANARY);
		expect(responseText).not.toContain("Why clouds are suspicious");
		expect(responseText).not.toContain(CLAIM_ID);
		expect(responseText).not.toContain(SPEAKER_TOKEN);
		expect(forwarded).toHaveLength(2);
		expect(limiterKeys).toHaveLength(1);
		expect(limiterKeys[0]).toMatch(/^platform:[0-9a-f]{64}$/u);

		const claimRequest = forwarded[0];
		const resolveRequest = forwarded[1];
		expect(new URL(claimRequest.url).pathname).toBe("/claim-judge");
		expect(new URL(resolveRequest.url).pathname).toBe("/resolve-judge");
		expect(await claimRequest.json()).toEqual({ turnId: "t1" });
		const resolution = await resolveRequest.json<{
			turnId: string;
			claimId: string;
			resolution: { status: string; verdict: Record<string, unknown> };
		}>();
		expect(Object.keys(resolution).sort()).toEqual(["claimId", "resolution", "turnId"]);
		expect(resolution.turnId).toBe("t1");
		expect(resolution.claimId).toMatch(/^[0-9a-f]{64}$/u);
		expect(resolution.resolution.status).toBe("done");
		expect(JSON.stringify(resolution)).not.toContain(TRANSCRIPT_CANARY);

		for (const internal of forwarded) {
			expect(internal.headers.get("X-NonStopTalk-Token")).toBe(SPEAKER_TOKEN);
			expect(internal.headers.get("X-Request-ID")).toBeNull();
			expect(internal.headers.get("Cookie")).toBeNull();
			expect(internal.headers.get("Origin")).toBeNull();
			expect(internal.headers.get("Authorization")).toBeNull();
			expect(internal.headers.get("CF-Connecting-IP")).toBeNull();
			expect([...internal.headers].some(([name, value]) =>
				name.includes("transcript") || value.includes(TRANSCRIPT_CANARY)
			)).toBe(false);
		}
	});

	it("does not retry a claimed turn when resolution fails", async () => {
		const forwarded: Request[] = [];
		const rooms = recordingRooms(forwarded, (request) => {
			if (new URL(request.url).pathname === "/claim-judge") {
				return Response.json({
					claim: {
						claimId: CLAIM_ID,
						topic: "A private assigned topic",
						tier: "escalated",
						deadlineAt: Date.now() + 30_000,
					},
				});
			}
			return Response.json({ privateDetail: TRANSCRIPT_CANARY }, { status: 503 });
		});

		const response = await worker.fetch(
			judgeRequest(),
			workerEnv(rooms),
			createExecutionContext(),
		);
		const text = await response.text();

		expect(response.status).toBe(503);
		expect(forwarded).toHaveLength(2);
		expect(forwarded.map((request) => new URL(request.url).pathname)).toEqual([
			"/claim-judge",
			"/resolve-judge",
		]);
		expect(text).not.toContain(TRANSCRIPT_CANARY);
		expect(text).not.toContain(CLAIM_ID);
		expect(text).not.toContain("A private assigned topic");
		expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("JUDGE_UNAVAILABLE");
	});

	it("maps room authorization and stale-turn failures without exposing the room body", async () => {
		for (const expectation of [
			{ upstream: 403, status: 403, code: "JUDGE_AUTHORIZATION_REQUIRED" },
			{ upstream: 404, status: 409, code: "JUDGE_NOT_PENDING" },
			{ upstream: 409, status: 409, code: "JUDGE_NOT_PENDING" },
		] as const) {
			const forwarded: Request[] = [];
			const rooms = recordingRooms(forwarded, () =>
				Response.json({ error: TRANSCRIPT_CANARY, topic: "private topic" }, { status: expectation.upstream })
			);
			const response = await worker.fetch(
				judgeRequest(),
				workerEnv(rooms),
				createExecutionContext(),
			);
			const text = await response.text();
			expect(response.status).toBe(expectation.status);
			expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(expectation.code);
			expect(text).not.toContain(TRANSCRIPT_CANARY);
			expect(text).not.toContain("private topic");
			expect(forwarded).toHaveLength(1);
		}
	});

	it("never logs a transcript even when the internal claim dependency throws", async () => {
		const logs = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const forwarded: Request[] = [];
			const rooms = recordingRooms(forwarded, () => {
				throw new Error(TRANSCRIPT_CANARY);
			});
			const response = await worker.fetch(
				judgeRequest(),
				workerEnv(rooms),
				createExecutionContext(),
			);
			expect(response.status).toBe(503);
			expect(forwarded).toHaveLength(1);
			expect(JSON.stringify(logs.mock.calls)).not.toContain(TRANSCRIPT_CANARY);
		} finally {
			logs.mockRestore();
		}
	});

	it("bounds and aborts a claim dependency even when the room stub ignores abort", async () => {
		const forwarded: Request[] = [];
		let claimSignal: AbortSignal | null = null;
		const rooms = recordingRooms(forwarded, (request) => {
			claimSignal = request.signal;
			return new Promise<Response>(() => undefined);
		});
		const response = await handleJudgeRoute(
			judgeRequest(),
			workerEnv(rooms),
			SPEAKER_TOKEN,
			"claim-timeout-test",
			{ internalCallTimeoutMs: 5 },
		);
		if (!response) throw new Error("Expected the judge route to handle the request.");

		const responseText = await response.text();
		expect(response.status).toBe(503);
		expect(forwarded).toHaveLength(1);
		expect((claimSignal as AbortSignal | null)?.aborted).toBe(true);
		expect((JSON.parse(responseText) as { error: { code: string } }).error.code)
			.toBe("JUDGE_UNAVAILABLE");
		expect(responseText).not.toContain(TRANSCRIPT_CANARY);
	});

	it("caps an ignored resolve dependency at the exact remaining review window", async () => {
		const fixedNow = 2_000_000_000_000;
		const forwarded: Request[] = [];
		const signals: AbortSignal[] = [];
		let resolveMayHaveCommitted = false;
		const rooms = recordingRooms(forwarded, (request) => {
			signals.push(request.signal);
			if (new URL(request.url).pathname === "/claim-judge") {
				return Response.json({
					claim: {
						claimId: CLAIM_ID,
						topic: "Why clouds are suspicious",
						tier: "routine",
						deadlineAt: fixedNow + 5,
					},
				});
			}
			resolveMayHaveCommitted = true;
			return new Promise<Response>(() => undefined);
		});
		const response = await handleJudgeRoute(
			judgeRequest(),
			workerEnv(rooms),
			SPEAKER_TOKEN,
			"resolve-timeout-test",
			{ internalCallTimeoutMs: 50, now: () => fixedNow },
		);
		if (!response) throw new Error("Expected the judge route to handle the request.");

		const responseText = await response.text();
		expect(response.status).toBe(503);
		expect(forwarded).toHaveLength(2);
		expect(signals).toHaveLength(2);
		expect(signals[0]?.aborted).toBe(false);
		expect(signals[1]?.aborted).toBe(true);
		const error = JSON.parse(responseText) as { error: { code: string; message: string } };
		expect(error.error.code).toBe("JUDGE_UNAVAILABLE");
		expect(error.error.message).toContain("classic score is safe");
		expect(error.error.message).toContain("refresh the room");
		expect(resolveMayHaveCommitted).toBe(true);
		expect(responseText).not.toContain(TRANSCRIPT_CANARY);
		expect(JSON.stringify(await forwarded[1]?.json())).not.toContain(TRANSCRIPT_CANARY);
	});
});

describe("offline judge request validation", () => {
	it("rejects method, origin, content type, key, consent, identifier, and Unicode violations before a claim", async () => {
		const forwarded: Request[] = [];
		const rooms = recordingRooms(forwarded, () => {
			throw new Error("room must not be contacted");
		});
		const cases: Array<{ request: Request; status: number; code?: string }> = [
			{ request: judgeRequest({}, { method: "GET" }), status: 405, code: "METHOD_NOT_ALLOWED" },
			{ request: judgeRequest({}, { origin: null }), status: 403, code: "INVALID_ORIGIN" },
			// The outer API guard rejects an explicitly foreign Origin before identity
			// or route-specific work; the judge's stricter guard handles a missing one.
			{ request: judgeRequest({}, { origin: "https://cross-origin.test" }), status: 403 },
			{ request: judgeRequest({}, { contentType: "text/plain" }), status: 400, code: "INVALID_INPUT" },
			{
				request: judgeRequest({
					roomCode: ROOM_CODE,
					turnId: "t1",
					transcript: TRANSCRIPT_CANARY,
					externalConsent: false,
					unexpected: "must be rejected",
				}),
				status: 400,
				code: "INVALID_INPUT",
			},
			{
				request: judgeRequest({ roomCode: ROOM_CODE, turnId: "t1", externalConsent: false }),
				status: 400,
				code: "INVALID_INPUT",
			},
			{
				request: judgeRequest({ roomCode: ROOM_CODE, turnId: "t1", transcript: TRANSCRIPT_CANARY }),
				status: 400,
				code: "INVALID_INPUT",
			},
			{
				request: judgeRequest({
					roomCode: ROOM_CODE,
					turnId: "t1",
					transcript: TRANSCRIPT_CANARY,
					externalConsent: true,
				}),
				status: 400,
				code: "INVALID_INPUT",
			},
			{
				request: judgeRequest({
					roomCode: "OOOOOO",
					turnId: "t1",
					transcript: TRANSCRIPT_CANARY,
					externalConsent: false,
				}),
				status: 400,
				code: "INVALID_INPUT",
			},
			{
				request: judgeRequest({
					roomCode: ROOM_CODE,
					turnId: "t0",
					transcript: TRANSCRIPT_CANARY,
					externalConsent: false,
				}),
				status: 400,
				code: "INVALID_INPUT",
			},
			{
				request: judgeRequest({
					roomCode: ROOM_CODE,
					turnId: "t1",
					transcript: "\ud800",
					externalConsent: false,
				}),
				status: 400,
				code: "INVALID_INPUT",
			},
			{
				request: judgeRequest({
					roomCode: ROOM_CODE,
					turnId: "t1",
					transcript: "🌍".repeat(2049),
					externalConsent: false,
				}),
				status: 400,
				code: "INVALID_INPUT",
			},
		];

		for (const testCase of cases) {
			const response = await worker.fetch(
				testCase.request,
				workerEnv(rooms),
				createExecutionContext(),
			);
			expect(response.status).toBe(testCase.status);
			const payload = await responsePayload(response) as { error: string | { code: string } };
			if (testCase.code) {
				expect(typeof payload.error).toBe("object");
				expect((payload.error as { code: string }).code).toBe(testCase.code);
			} else expect(payload.error).toBe("Cross-origin request rejected.");
		}
		expect(forwarded).toHaveLength(0);
	});

	it("rejects malformed UTF-8 and oversized bodies before room work", async () => {
		const forwarded: Request[] = [];
		const rooms = recordingRooms(forwarded, () => {
			throw new Error("room must not be contacted");
		});
		const malformed = new Uint8Array([
			...new TextEncoder().encode('{"roomCode":"JDG234","turnId":"t1","transcript":"'),
			0xff,
			...new TextEncoder().encode('"}'),
		]);
		const malformedResponse = await worker.fetch(
			judgeRequest({}, { rawBody: malformed }),
			workerEnv(rooms),
			createExecutionContext(),
		);
		expect(malformedResponse.status).toBe(400);
		expect((await responsePayload(malformedResponse) as { error: { code: string } }).error.code)
			.toBe("INVALID_INPUT");

		const oversizedResponse = await worker.fetch(
			judgeRequest({}, { rawBody: "x".repeat(64 * 1024 + 1) }),
			workerEnv(rooms),
			createExecutionContext(),
		);
		expect(oversizedResponse.status).toBe(413);
		expect((await responsePayload(oversizedResponse) as { error: { code: string } }).error.code)
			.toBe("PAYLOAD_TOO_LARGE");
		expect(forwarded).toHaveLength(0);
	});

	it("keeps internal judge handler names outside the public room URL grammar", () => {
		expect(parseRoomRoute(`/api/rooms/${ROOM_CODE}/claim-judge`)).toBeNull();
		expect(parseRoomRoute(`/api/rooms/${ROOM_CODE}/resolve-judge`)).toBeNull();
	});

	it("normalizes control/whitespace and accepts exactly 8192 normalized UTF-8 bytes", async () => {
		const forwarded: Request[] = [];
		const rooms = recordingRooms(forwarded, (request) =>
			new URL(request.url).pathname === "/claim-judge"
				? Response.json({
					claim: {
						claimId: CLAIM_ID,
						topic: "A bounded topic",
						tier: "routine",
						deadlineAt: Date.now() + 30_000,
					},
				})
				: Response.json({ resolved: true })
		);
		const transcript = ` ${"é".repeat(4096)} `;
		const response = await worker.fetch(
			judgeRequest({ roomCode: ROOM_CODE, turnId: "t1", transcript, externalConsent: false }),
			workerEnv(rooms),
			createExecutionContext(),
		);

		expect(new TextEncoder().encode(transcript.trim()).byteLength).toBe(8192);
		expect(response.status).toBe(200);
		expect(forwarded).toHaveLength(2);
		expect(JSON.stringify(await forwarded[0].json())).not.toContain("é");
		expect(JSON.stringify(await forwarded[1].json())).not.toContain("é");
	});
});

function roomStub(code: string): DurableObjectStub<RoomDurableObject> {
	return env.ROOMS.get(env.ROOMS.idFromName(code));
}

function internalRoomRequest(token: string, pathname: string, body: Record<string, unknown>): Request {
	return new Request(`https://room.internal${pathname}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-NonStopTalk-Token": token,
		},
		body: JSON.stringify(body),
	});
}

async function seedPendingJudgeRoom(
	code: string,
	deadlineAt = Date.now() + 30_000,
): Promise<DurableObjectStub<RoomDurableObject>> {
	const stub = roomStub(code);
	const created = await stub.fetch(internalRoomRequest(HOST_TOKEN, "/create", {
		code,
		name: "Host",
	}));
	expect(created.status).toBe(201);
	await created.body?.cancel();
	const joined = await stub.fetch(internalRoomRequest(SPEAKER_TOKEN, "/join", { name: "Speaker" }));
	expect(joined.status).toBe(200);
	await joined.body?.cancel();

	await runInDurableObject(stub, (_instance, state) => {
		const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1").one();
		const room = JSON.parse(row.json) as RoomState;
		const playerId = room.members[SPEAKER_TOKEN];
		const speaker = room.players.find((player) => player.id === playerId);
		if (!speaker) throw new Error("Expected a seeded speaker.");
		speaker.score = 85;
		room.phase = "finished";
		room.judge = { enabled: true, tier: "routine" };
		room.completedTurns = [{
			id: "t1",
			playerId,
			playerName: speaker.name,
			round: 1,
			topic: "Why clouds are suspicious",
			topicIndex: 0,
			duration: 60,
			silence: 2,
			begunAt: Date.now() - 60_000,
			spokenSeconds: 60,
			completed: true,
			eliminated: false,
			score: 85,
			judge: { status: "pending", bonus: 0 },
		}];
		room.pendingJudgeReviews = [{
			turnId: "t1",
			playerId,
			tier: "routine",
			deadlineAt,
			claimId: null,
			claimedAt: null,
		}];
		state.storage.sql.exec("UPDATE room_state SET json = ? WHERE id = 1", JSON.stringify(room));
	});
	return stub;
}

describe("offline judge end-to-end Durable Object coordination", () => {
	it("generates a private 256-bit claim and returns only the grading inputs", async () => {
		const code = "JDG567";
		const stub = await seedPendingJudgeRoom(code);
		const claimed = await stub.fetch(internalRoomRequest(SPEAKER_TOKEN, "/claim-judge", { turnId: "t1" }));
		const payload = await claimed.json<{
			claim: { claimId: string; topic: string; tier: string; deadlineAt: number };
		}>();

		expect(claimed.status).toBe(200);
		expect(Object.keys(payload)).toEqual(["claim"]);
		expect(Object.keys(payload.claim).sort()).toEqual(["claimId", "deadlineAt", "tier", "topic"]);
		expect(payload.claim.claimId).toMatch(/^[0-9a-f]{64}$/u);
		expect(payload.claim.topic).toBe("Why clouds are suspicious");
		expect(payload.claim.tier).toBe("routine");
		expect(payload.claim.deadlineAt).toBeGreaterThan(Date.now());
		expect(JSON.stringify(payload)).not.toContain(SPEAKER_TOKEN);
		expect(JSON.stringify(payload)).not.toContain(TRANSCRIPT_CANARY);

		const resolved = await stub.fetch(internalRoomRequest(SPEAKER_TOKEN, "/resolve-judge", {
			turnId: "t1",
			claimId: payload.claim.claimId,
			resolution: { status: "failed" },
		}));
		expect(resolved.status).toBe(200);
		expect(await resolved.json()).toEqual({ resolved: true });
	});

	it("rejects host/stale/replay claims and persists only the resolved verdict", async () => {
		const code = "JDG345";
		const stub = await seedPendingJudgeRoom(code);
		const routeEnv = workerEnv(env.ROOMS);
		const request = (token: string, turnId = "t1") => judgeRequest({
			roomCode: code,
			turnId,
			transcript: TRANSCRIPT_CANARY,
			externalConsent: false,
		}, { token });

		const host = await worker.fetch(request(HOST_TOKEN), routeEnv, createExecutionContext());
		expect(host.status).toBe(403);
		const stale = await worker.fetch(request(SPEAKER_TOKEN, "t2"), routeEnv, createExecutionContext());
		expect(stale.status).toBe(409);
		const extraInternalField = await stub.fetch(internalRoomRequest(SPEAKER_TOKEN, "/claim-judge", {
			turnId: "t1",
			transcript: TRANSCRIPT_CANARY,
		}));
		expect(extraInternalField.status).toBe(400);
		expect(await extraInternalField.text()).not.toContain(TRANSCRIPT_CANARY);

		const graded = await worker.fetch(request(SPEAKER_TOKEN), routeEnv, createExecutionContext());
		const gradedPayload = await graded.json<{
			judge: { status: string; bonus: number; feedback: string };
		}>();
		expect(graded.status).toBe(200);
		expect(gradedPayload.judge.status).toBe("done");
		expect(gradedPayload.judge.bonus).toBeGreaterThan(0);

		const replay = await worker.fetch(request(SPEAKER_TOKEN), routeEnv, createExecutionContext());
		expect(replay.status).toBe(409);

		await runInDurableObject(stub, (_instance, state) => {
			const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1").one();
			expect(row.json).not.toContain(TRANSCRIPT_CANARY);
			const room = JSON.parse(row.json) as RoomState;
			expect(room.pendingJudgeReviews).toEqual([]);
			expect(room.completedTurns[0]?.judge?.status).toBe("done");
			expect(room.completedTurns[0]?.judge?.feedback).toBe(gradedPayload.judge.feedback);
			expect(room.players.find((player) => player.id === room.completedTurns[0]?.playerId)?.score)
				.toBe(85 + gradedPayload.judge.bonus);
		});
	});

	it("expires an unfinished claim through the shared room alarm and keeps classic scoring", async () => {
		const code = "JDG456";
		const stub = await seedPendingJudgeRoom(code, Date.now() - 1);
		await runInDurableObject(stub, async (instance, state) => {
			await instance.alarm();
			const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1").one();
			const room = JSON.parse(row.json) as RoomState;
			const turn = room.completedTurns[0];
			expect(turn?.judge?.status).toBe("failed");
			expect(turn?.judge?.bonus).toBe(0);
			expect(turn?.score).toBe(85);
			expect(room.pendingJudgeReviews).toEqual([]);
			expect(room.players.find((player) => player.id === turn?.playerId)?.score).toBe(85);
			const nextAlarm = await state.storage.getAlarm();
			expect(nextAlarm).not.toBeNull();
			expect(nextAlarm as number).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1_000);
		});
	});

	it("schedules and repairs orphaned pending state instead of leaving standings provisional", async () => {
		const code = "JDG678";
		const stub = await seedPendingJudgeRoom(code);
		await runInDurableObject(stub, (_instance, state) => {
			const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1").one();
			const room = JSON.parse(row.json) as RoomState;
			delete room.pendingJudgeReviews;
			state.storage.sql.exec("UPDATE room_state SET json = ? WHERE id = 1", JSON.stringify(room));
		});

		const before = Date.now();
		const saved = await stub.fetch(internalRoomRequest(HOST_TOKEN, "/action", {
			type: "score",
			playerId: "p1",
			delta: 0,
		}));
		expect(saved.status).toBe(200);

		await runInDurableObject(stub, async (instance, state) => {
			const scheduled = await state.storage.getAlarm();
			expect(scheduled).not.toBeNull();
			expect(scheduled as number).toBeGreaterThanOrEqual(before + 1_000);
			expect(scheduled as number).toBeLessThanOrEqual(Date.now() + 2_000);

			await instance.alarm();
			const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1").one();
			const room = JSON.parse(row.json) as RoomState;
			expect(room.completedTurns[0]?.judge?.status).toBe("failed");
			expect(room.completedTurns[0]?.score).toBe(85);
			expect(room.pendingJudgeReviews).toEqual([]);
		});
	});

	it("repairs an orphaned pending review alarm when the Durable Object reactivates", async () => {
		const code = "JDG789";
		const stub = await seedPendingJudgeRoom(code);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(state.storage.sql.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_milestone_outbox'",
			).toArray()).toEqual([]);
			const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1").one();
			const room = JSON.parse(row.json) as RoomState;
			delete room.pendingJudgeReviews;
			state.storage.sql.exec("UPDATE room_state SET json = ? WHERE id = 1", JSON.stringify(room));
			const wrongAlarm = Date.now() + 60_000;
			await state.storage.setAlarm(wrongAlarm);
			expect(await state.storage.getAlarm()).toBe(wrongAlarm);
		});

		await evictDurableObject(stub);
		const before = Date.now();
		const reactivated = await stub.fetch(new Request("https://room.internal/state", {
			// A member read performs no host-presence write, so only constructor
			// activation can advance the deliberately late alarm.
			headers: { "X-NonStopTalk-Token": SPEAKER_TOKEN },
		}));
		expect(reactivated.status).toBe(200);
		await reactivated.body?.cancel();

		await runInDurableObject(stub, async (_instance, state) => {
			const scheduled = await state.storage.getAlarm();
			expect(scheduled).not.toBeNull();
			expect(scheduled as number).toBeGreaterThanOrEqual(before + 1_000);
			expect(scheduled as number).toBeLessThanOrEqual(Date.now() + 2_000);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, (_instance, state) => {
			const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1").one();
			const room = JSON.parse(row.json) as RoomState;
			const turn = room.completedTurns[0];
			expect(turn?.judge?.status).toBe("failed");
			expect(turn?.judge?.bonus).toBe(0);
			expect(turn?.score).toBe(85);
			expect(room.pendingJudgeReviews).toEqual([]);
			expect(room.players.find((player) => player.id === turn?.playerId)?.score).toBe(85);
		});
	});
});
