import { env } from "cloudflare:workers";
import {
	createExecutionContext,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import worker, { RoomDurableObject } from "../worker";
import type { RoomState } from "../game";

const TOKEN = "a".repeat(64);
const ROOM_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

function roomStub(code: string): DurableObjectStub<RoomDurableObject> {
	return env.ROOMS.get(env.ROOMS.idFromName(code));
}

function roomRequest(pathname: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("X-NonStopTalk-Token", TOKEN);
	return new Request(`https://room.internal${pathname}`, { ...init, headers });
}

async function createRoom(stub: DurableObjectStub<RoomDurableObject>, code: string): Promise<RoomState> {
	const response = await stub.fetch(roomRequest("/create", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code, name: "Runtime Host" }),
	}));
	expect(response.status).toBe(201);
	const payload = await response.json<{ room: RoomState }>();
	return payload.room;
}

async function storedRoom(stub: DurableObjectStub<RoomDurableObject>): Promise<RoomState | null> {
	return runInDurableObject(stub, (_instance, state) => {
		const table = state.storage.sql
			.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_state'")
			.toArray()[0];
		if (!table) return null;
		const row = state.storage.sql
			.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1")
			.toArray()[0];
		return row ? JSON.parse(row.json) as RoomState : null;
	});
}

function nextSocketMessage(socket: WebSocket): Promise<string> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for a room WebSocket message.")), 2_000);
		socket.addEventListener("message", (event) => {
			clearTimeout(timeout);
			resolve(String(event.data));
		}, { once: true });
	});
}

describe("RoomDurableObject in the Workers runtime", () => {
	it("persists its SQLite room state across instance eviction", async () => {
		const code = "RNTM24";
		const stub = roomStub(code);
		const created = await createRoom(stub, code);

		expect(created.code).toBe(code);
		expect(created.hostToken).toBeUndefined();
		const persisted = await storedRoom(stub);
		expect(persisted?.hostToken).toBe(TOKEN);
		expect(persisted?.players[0]?.name).toBe("Runtime Host");

		await evictDurableObject(stub);
		const response = await stub.fetch(roomRequest("/state"));
		expect(response.status).toBe(200);
		const reloaded = await response.json<{ room: RoomState }>();
		expect(reloaded.room.code).toBe(code);
		expect(reloaded.room.players[0]?.name).toBe("Runtime Host");
	});

	it("executes the expiry alarm against persisted SQLite state", async () => {
		const code = "ALARMS";
		const stub = roomStub(code);
		await createRoom(stub, code);

		await runInDurableObject(stub, async (_instance, state) => {
			const row = state.storage.sql
				.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1")
				.one();
			const expired = JSON.parse(row.json) as RoomState;
			expired.updatedAt = Date.now() - ROOM_IDLE_TTL_MS - 1;
			state.storage.sql.exec("UPDATE room_state SET json = ? WHERE id = 1", JSON.stringify(expired));
			await state.storage.setAlarm(Date.now() + 60_000);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await storedRoom(stub)).toBeNull();
		const response = await stub.fetch(roomRequest("/state"));
		expect(response.status).toBe(404);
	});

	it("reschedules expired-room deletion after a storage failure", async () => {
		const code = "RETRY2";
		const stub = roomStub(code);
		await createRoom(stub, code);
		const before = Date.now();

		await runInDurableObject(stub, async (instance, state) => {
			const row = state.storage.sql
				.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1")
				.one();
			const expired = JSON.parse(row.json) as RoomState;
			expired.updatedAt = Date.now() - ROOM_IDLE_TTL_MS - 1;
			state.storage.sql.exec("UPDATE room_state SET json = ? WHERE id = 1", JSON.stringify(expired));

			const deletion = vi.spyOn(state.storage, "deleteAll")
				.mockRejectedValueOnce(new Error("synthetic storage outage"));
			await instance.alarm();

			expect(deletion).toHaveBeenCalledOnce();
			const retryAt = await state.storage.getAlarm();
			expect(retryAt).not.toBeNull();
			expect(retryAt as number).toBeGreaterThanOrEqual(before + 59 * 60 * 1_000);
			expect(retryAt as number).toBeLessThanOrEqual(Date.now() + 61 * 60 * 1_000);
			expect(state.storage.sql
				.exec("SELECT json FROM room_state WHERE id = 1")
				.toArray()).toHaveLength(1);
		});
	});

	it("keeps a hibernatable WebSocket usable across eviction", async () => {
		const code = "SCKT24";
		const stub = roomStub(code);
		await createRoom(stub, code);

		const response = await stub.fetch(roomRequest("/socket", {
			headers: { Upgrade: "websocket" },
		}));
		expect(response.status).toBe(101);
		const socket = response.webSocket;
		expect(socket).toBeDefined();
		if (!socket) throw new Error("Expected the room to return a WebSocket.");
		socket.accept();

		const initial = JSON.parse(await nextSocketMessage(socket)) as { room: RoomState };
		expect(initial.room.code).toBe(code);
		await evictDurableObject(stub);

		const synchronized = nextSocketMessage(socket);
		socket.send(JSON.stringify({ type: "sync" }));
		const afterEviction = JSON.parse(await synchronized) as { room: RoomState };
		expect(afterEviction.room.code).toBe(code);
		socket.close(1000, "test complete");
	});
});

describe("Worker-to-room boundary in the Workers runtime", () => {
	it("forwards only room protocol headers and propagates the request ID", async () => {
		let forwarded: Request | undefined;
		const fakeEnv = {
			API_RATE_LIMITER: {
				limit: async () => ({ success: true }),
			},
			ROOMS: {
				idFromName: () => ({}) as DurableObjectId,
				get: () => ({
					fetch: async (request: Request) => {
						forwarded = request;
						return Response.json({ room: { code: "HEAD24" } });
					},
				}),
			},
		} as unknown as Parameters<typeof worker.fetch>[1];
		const context = createExecutionContext();
		const response = await worker.fetch(new Request("https://example.test/api/rooms/HEAD24/state", {
			headers: {
				Authorization: "Bearer must-not-forward",
				Cookie: `nonstoptalk_token=${TOKEN}`,
				"CF-Connecting-IP": "192.0.2.1",
				"X-Untrusted-Browser-Header": "must-not-forward",
			},
		}), fakeEnv, context);

		expect(response.status).toBe(200);
		expect(forwarded).toBeDefined();
		const internal = forwarded as Request;
		expect(internal.url).toBe("https://room.internal/state");
		expect(internal.headers.get("X-NonStopTalk-Token")).toBe(TOKEN);
		expect(internal.headers.get("X-Request-ID")).toBe(response.headers.get("X-Request-ID"));
		expect(internal.headers.get("Authorization")).toBeNull();
		expect(internal.headers.get("Cookie")).toBeNull();
		expect(internal.headers.get("CF-Connecting-IP")).toBeNull();
		expect(internal.headers.get("X-Untrusted-Browser-Header")).toBeNull();
	});

	it("returns a correlated stable 503 when an edge dependency throws", async () => {
		const fakeEnv = {
			API_RATE_LIMITER: {
				limit: async () => { throw new Error("synthetic limiter outage"); },
			},
		} as unknown as Parameters<typeof worker.fetch>[1];
		const response = await worker.fetch(new Request("https://example.test/api/v1/platform/status", {
			headers: { Cookie: `nonstoptalk_token=${TOKEN}` },
		}), fakeEnv, createExecutionContext());
		const payload = await response.json<{ error: string; requestId: string }>();

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("5");
		expect(response.headers.get("X-Request-ID")).toBe(payload.requestId);
		expect(payload.error).toBe("The service is temporarily unavailable.");
	});
});
