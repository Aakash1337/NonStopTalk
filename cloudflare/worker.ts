import { DurableObject } from "cloudflare:workers";

import {
	GameError,
	applyAction,
	beginTopicGeneration,
	createRoomState,
	joinRoom,
	publicRoomState,
	setHostOnline,
	type Action,
	type RoomState,
} from "./game";
import {
	handlePlatformRoute,
	recordRoomMilestone,
	runPlatformCleanup,
	type PlatformBindings,
} from "./platform-routes";
import {
	handleModelRoute,
	modelAuthorizationErrorForStatus,
	type ModelRouteBindings,
} from "./model-routes";
import { logWorkerEvent } from "./observability";
import { parseRoomRoute } from "./routes";

const TOKEN_COOKIE = "nonstoptalk_token";
const LEGACY_TOKEN_COOKIE = "dst_token";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_ROOM_SOCKETS = 64;
const MAX_SOCKETS_PER_TOKEN = 4;
const ROOM_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROOM_DELETE_RETRY_MS = 60 * 60 * 1000;
const HOST_HTTP_PRESENCE_BUCKET_MS = 15_000;
const ROOM_MILESTONES_HEADER = "X-NonStopTalk-Room-Milestones";
const MODEL_TOPICS_ROUTE = "/api/v1/models/topics";
const ADMIN_ANALYTICS_DOCUMENT = "/admin/analytics";
const ADMIN_ANALYTICS_CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"script-src-attr 'none'",
	"style-src 'self'",
	"style-src-attr 'none'",
	"connect-src 'self'",
	"img-src 'self' data:",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
	"object-src 'none'",
	"worker-src 'none'",
].join("; ");

/**
 * Wrangler generates the declared Cloudflare bindings in
 * worker-configuration.d.ts. The smaller module contracts add optional
 * secrets and provider selectors that Wrangler cannot discover from config.
 */
type WorkerEnv = Env & PlatformBindings & ModelRouteBindings;

interface SocketAttachment {
	token: string;
}

interface TokenIdentity {
	token: string;
	created: boolean;
	migratedLegacy: boolean;
}

export class RoomDurableObject extends DurableObject<WorkerEnv> {
	constructor(ctx: DurableObjectState, env: WorkerEnv) {
		super(ctx, env);
	}

	private initializeSchema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS room_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				json TEXT NOT NULL
			)
		`);
	}

	async fetch(request: Request): Promise<Response> {
		const requestId = request.headers.get("X-Request-ID") ?? undefined;
		try {
			const url = new URL(request.url);
			const token = request.headers.get("X-NonStopTalk-Token") ?? "";

			if (request.method === "POST" && url.pathname === "/create") {
				// Consume the body before reading SQLite. Durable Object requests
				// can interleave across non-storage awaits, so load, mutation, and
				// the synchronous SQL save must remain one uninterrupted section.
				const body = await readJson(request);
				const room = this.load();
				if (room) return json({ error: "Room code collision." }, 409);
				this.initializeSchema();
				const created = createRoomState(text(body.code), token, text(body.name));
				this.save(created);
				return withRoomMilestones(
					json({ room: publicRoomState(created, token, this.onlineTokens()) }, 201),
					["created"],
				);
			}

			if (request.method === "POST" && url.pathname === "/join") {
				const body = await readJson(request);
				const room = this.load();
				if (!room) return json({ error: "Room not found." }, 404);
				const memberBefore = room.members[token];
				joinRoom(room, token, text(body.name));
				this.save(room);
				this.broadcast(room);
				const response = json({ room: publicRoomState(room, token, this.onlineTokens()) });
				return memberBefore || !room.members[token] ? response : withRoomMilestones(response, ["joined"]);
			}

			if (request.method === "POST" && url.pathname === "/action") {
				const action = (await readJson(request)) as Action;
				const room = this.load();
				if (!room) return json({ error: "Room not found." }, 404);
				const priorPhase = room.phase;
				const priorCompletedTurns = room.completedTurns.length;
				applyAction(room, token, action, Date.now(), this.onlineTokens());
				this.save(room);
				this.broadcast(room);
				const milestones: Array<"game-started" | "turn-completed" | "game-finished" | "reset"> = [];
				if (action.type === "start-game" && priorPhase !== "playing" && room.phase === "playing") {
					milestones.push("game-started");
				}
				if (action.type === "submit-turn" && room.completedTurns.length > priorCompletedTurns) {
					milestones.push("turn-completed");
					if (room.phase === "finished") milestones.push("game-finished");
				}
				if (action.type === "reset" && priorPhase !== "setup" && room.phase === "setup") {
					milestones.push("reset");
				}
				return withRoomMilestones(
					json({ room: publicRoomState(room, token, this.onlineTokens()) }),
					milestones,
				);
			}

			const room = this.load();
			if (!room) return json({ error: "Room not found." }, 404);

			if (request.method === "POST" && url.pathname === "/authorize-topic-generation") {
				const topicGeneration = beginTopicGeneration(room, token);
				this.save(room);
				return json({ authorized: true, topicGeneration });
			}

			if (request.method === "GET" && url.pathname === "/state") {
				const now = Date.now();
				if (refreshHTTPHostPresence(room, token, this.hasOpenSocket(token), now)) this.save(room);
				return json({ room: publicRoomState(room, token, this.onlineTokens(), now) });
			}

			if (request.method === "GET" && url.pathname === "/socket") {
				if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
					return json({ error: "Expected a WebSocket upgrade." }, 426);
				}
				if (room.hostToken !== token && !room.members[token]) {
					return json({ error: "Join the room before connecting." }, 403);
				}
				if (this.ctx.getWebSockets().length >= MAX_ROOM_SOCKETS) {
					return json({ error: "This room has too many live connections." }, 503);
				}
				if (this.socketCount(token) >= MAX_SOCKETS_PER_TOKEN) {
					return json({ error: "Close an extra tab before reconnecting to this room." }, 503);
				}

				const pair = new WebSocketPair();
				const [client, server] = Object.values(pair);
				this.ctx.acceptWebSocket(server);
				server.serializeAttachment({ token } satisfies SocketAttachment);
				if (token === room.hostToken && setHostOnline(room, true)) this.save(room);
				this.broadcast(room);
				return new Response(null, { status: 101, webSocket: client } as ResponseInit);
			}

			return json({ error: "Not found." }, 404);
		} catch (error) {
			if (error instanceof GameError) return json({ error: error.message }, error.status);
			logWorkerEvent("error", "room_request_failed", {
				requestId,
				error: safeWorkerErrorName(error),
			});
			return json({ error: "The room could not process that request." }, 500);
		}
	}

	webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void {
		if (typeof message !== "string" || message.length > 1024) {
			socket.close(1009, "Message too large");
			return;
		}
		try {
			const payload = JSON.parse(message) as { type?: string };
			if (payload.type === "sync") {
				const room = this.load();
				const token = this.attachment(socket)?.token ?? "";
				if (room) this.sendState(socket, room, token);
			}
		} catch {
			// Unknown client messages do not mutate room state.
		}
	}

	webSocketClose(socket: WebSocket): void {
		this.recordDisconnect(socket);
	}

	webSocketError(socket: WebSocket): void {
		this.recordDisconnect(socket);
		try {
			socket.close(1011, "Live connection failed");
		} catch {
			// The socket is already gone.
		}
	}

	async alarm(): Promise<void> {
		const room = this.load();
		if (!room) return;
		const expiresAt = room.updatedAt + ROOM_IDLE_TTL_MS;
		if (Date.now() < expiresAt) {
			await this.ctx.storage.setAlarm(expiresAt);
			return;
		}
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.close(1001, "Room expired after 30 days of inactivity");
			} catch {
				// The socket is already closed.
			}
		}
		try {
			await this.ctx.storage.deleteAll();
		} catch (error) {
			logWorkerEvent("error", "room_expiry_delete_failed", {
				error: safeWorkerErrorName(error),
				retryAfterSeconds: ROOM_DELETE_RETRY_MS / 1000,
			});
			try {
				await this.ctx.storage.setAlarm(Date.now() + ROOM_DELETE_RETRY_MS);
			} catch (scheduleError) {
				logWorkerEvent("error", "room_expiry_schedule_failed", {
					error: safeWorkerErrorName(scheduleError),
				});
				throw scheduleError;
			}
		}
	}

	private recordDisconnect(socket: WebSocket): void {
		const room = this.load();
		if (!room) return;
		const token = this.attachment(socket)?.token ?? "";
		if (token === room.hostToken && !this.hasOpenSocket(token, socket) && setHostOnline(room, false)) {
			this.save(room);
		}
		this.broadcast(room, socket);
	}

	private load(): RoomState | null {
		const table = this.ctx.storage.sql
			.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_state'")
			.toArray()[0];
		if (!table) return null;
		const row = this.ctx.storage.sql
			.exec<{ json: string }>("SELECT json FROM room_state WHERE id = 1")
			.toArray()[0];
		return row ? (JSON.parse(row.json) as RoomState) : null;
	}

	private save(room: RoomState): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO room_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
			JSON.stringify(room),
		);
		this.ctx.waitUntil(
			this.ctx.storage
				.setAlarm(room.updatedAt + ROOM_IDLE_TTL_MS)
				.catch((error: unknown) => {
					logWorkerEvent("error", "room_expiry_schedule_failed", {
						error: safeWorkerErrorName(error),
					});
					throw error;
				}),
		);
	}

	private onlineTokens(except?: WebSocket): Set<string> {
		const tokens = new Set<string>();
		for (const socket of this.ctx.getWebSockets()) {
			if (socket === except || socket.readyState !== 1) continue;
			const token = this.attachment(socket)?.token;
			if (token) tokens.add(token);
		}
		return tokens;
	}

	private hasOpenSocket(token: string, except?: WebSocket): boolean {
		return this.onlineTokens(except).has(token);
	}

	private socketCount(token: string): number {
		let count = 0;
		for (const socket of this.ctx.getWebSockets()) {
			if (socket.readyState === 1 && this.attachment(socket)?.token === token) count += 1;
		}
		return count;
	}

	private broadcast(room: RoomState, except?: WebSocket): void {
		const onlineTokens = this.onlineTokens(except);
		for (const socket of this.ctx.getWebSockets()) {
			if (socket === except || socket.readyState !== 1) continue;
			const token = this.attachment(socket)?.token ?? "";
			this.sendState(socket, room, token, onlineTokens);
		}
	}

	private sendState(
		socket: WebSocket,
		room: RoomState,
		token: string,
		onlineTokens = this.onlineTokens(),
	): void {
		try {
			socket.send(
				JSON.stringify({
					type: "state",
					room: publicRoomState(room, token, onlineTokens),
				}),
			);
		} catch {
			try {
				socket.close(1011, "Could not send room state");
			} catch {
				// The socket is already gone.
			}
		}
	}

	private attachment(socket: WebSocket): SocketAttachment | undefined {
		return socket.deserializeAttachment() as SocketAttachment | undefined;
	}
}

function refreshHTTPHostPresence(
	room: RoomState,
	token: string,
	hasOpenSocket: boolean,
	now: number,
): boolean {
	if (token !== room.hostToken || hasOpenSocket) return false;

	// Round the proof-of-presence timestamp up so all reads in this bucket can
	// share one durable write without shortening the 30-second takeover grace.
	// An absent HTTP-only host may therefore take up to one extra bucket to
	// become claimable, while an active one keeps renewing the lease.
	const presenceLease =
		(Math.floor(now / HOST_HTTP_PRESENCE_BUCKET_MS) + 1) * HOST_HTTP_PRESENCE_BUCKET_MS;
	if (room.hostDisconnectedAt !== null && room.hostDisconnectedAt >= presenceLease) return false;

	room.hostDisconnectedAt = presenceLease;
	room.version += 1;
	room.updatedAt = now;
	return true;
}

export default {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
		const requestId = crypto.randomUUID();
		try {
			const url = new URL(request.url);
			if (url.pathname === ADMIN_ANALYTICS_DOCUMENT || url.pathname.startsWith(`${ADMIN_ANALYTICS_DOCUMENT}/`)) {
				return serveAdminAnalyticsDocument(request, env, requestId);
			}
			if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

		if (!sameOrigin(request)) {
			return withRequestId(json({ error: "Cross-origin request rejected." }, 403), requestId);
		}
		const identity = ensureToken(request);
		if (url.pathname.startsWith("/api/v1/")) {
			const limited = await rateLimit(
				env.API_RATE_LIMITER,
				await rateLimitKey(request, identity.token, "platform"),
				requestId,
			);
			if (limited) {
				return withIdentityCookie(
					limited,
					identity,
					request,
					url.pathname.startsWith("/api/v1/progress/"),
				);
			}
		}
		if (url.pathname === MODEL_TOPICS_ROUTE) {
			const limited = await rateLimit(
				env.MODEL_RATE_LIMITER,
				await rateLimitKey(request, identity.token, "model-topics"),
				requestId,
			);
			if (limited) return withIdentityCookie(limited, identity, request, true);
		}
		const model = await handleModelRoute(request, env, identity.token, requestId, {
			authorizeHost: async (code, token) => {
				let response: Response;
				try {
					response = await roomFetch(
						env,
						code,
						request,
						token,
						requestId,
						"/authorize-topic-generation",
						{},
					);
				} catch {
					throw modelAuthorizationErrorForStatus(503);
				}
				if (!response.ok) {
					await response.body?.cancel().catch(() => undefined);
					throw modelAuthorizationErrorForStatus(response.status);
				}
				let authorization: { topicGeneration?: unknown };
				try {
					authorization = await response.json() as { topicGeneration?: unknown };
				} catch {
					throw modelAuthorizationErrorForStatus(503);
				}
				if (!Number.isSafeInteger(authorization.topicGeneration) || Number(authorization.topicGeneration) < 1) {
					throw modelAuthorizationErrorForStatus(503);
				}
				return { topicGeneration: Number(authorization.topicGeneration) };
			},
		});
		if (model) {
			return model.refreshIdentity
				? withIdentityCookie(model.response, identity, request, true)
				: model.response;
		}
		const platform = await handlePlatformRoute(
			request,
			env,
			identity.token,
			requestId,
			(task) => ctx.waitUntil(task),
		);
		if (platform) {
			return platform.refreshIdentity
				? withIdentityCookie(platform.response, identity, request, true)
				: platform.response;
		}

		if (request.method === "POST" && url.pathname === "/api/rooms") {
			const { success } = await env.ROOM_CREATION_RATE_LIMITER.limit({
				key: await rateLimitKey(request, identity.token, "room-create"),
			});
			if (!success) {
				logWorkerEvent("warn", "room_creation_rate_limited", { requestId });
				const response = json({ error: "Too many rooms were created from this connection. Try again shortly." }, 429);
				response.headers.set("Retry-After", "60");
				return withRequestId(withIdentityCookie(response, identity, request), requestId);
			}
			let body: Record<string, unknown>;
			try {
				body = await readJson(request);
			} catch (error) {
				if (error instanceof GameError) {
					return withRequestId(
						withIdentityCookie(json({ error: error.message }, error.status), identity, request),
						requestId,
					);
				}
				throw error;
			}
			for (let attempt = 0; attempt < 8; attempt += 1) {
				const code = randomCode();
				const response = await roomFetch(env, code, request, identity.token, requestId, "/create", {
					code,
					name: text(body.name),
				});
				if (response.status === 409) continue;
				scheduleRoomMilestones(ctx, env, response);
				return withRequestId(
					withIdentityCookie(withoutRoomMilestones(response), identity, request),
					requestId,
				);
			}
			return withRequestId(
				withIdentityCookie(json({ error: "Could not reserve a room code. Try again." }, 503), identity, request),
				requestId,
			);
		}

		const route = parseRoomRoute(url.pathname);
		if (!route) {
			return withRequestId(withIdentityCookie(json({ error: "Not found." }, 404), identity, request), requestId);
		}
		const { code, endpoint } = route;
		if (request.method === "POST" || endpoint === "state" || endpoint === "socket") {
			const scope = request.method === "POST"
				? "room-mutate"
				: endpoint === "socket"
					? "room-connect"
					: "room-read";
			const limited = await rateLimit(
				env.API_RATE_LIMITER,
				await rateLimitKey(request, identity.token, scope),
				requestId,
			);
			if (limited) return withIdentityCookie(limited, identity, request);
		}

		if (endpoint === "socket" && identity.created) {
			return withRequestId(json({ error: "Load the room once before opening its live connection." }, 401), requestId);
		}

		const response = await roomFetch(env, code, request, identity.token, requestId, `/${endpoint}`);
		if (endpoint !== "socket") scheduleRoomMilestones(ctx, env, response);
		return endpoint === "socket"
			? response
			: withRequestId(withIdentityCookie(withoutRoomMilestones(response), identity, request), requestId);
		} catch (error) {
			logWorkerEvent("error", "worker_request_failed", {
				requestId,
				versionId: env.CF_VERSION_METADATA?.id,
				error: safeWorkerErrorName(error),
			});
			const response = json({
				error: "The service is temporarily unavailable.",
				requestId,
			}, 503);
			response.headers.set("Retry-After", "5");
			return withRequestId(response, requestId);
		}
	},
	async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			runPlatformCleanup(env, new Date(controller.scheduledTime)).catch((error: unknown) => {
				logWorkerEvent("error", "platform_cleanup_failed", { error: safeWorkerErrorName(error) });
				throw error;
			}),
		);
	},
} satisfies ExportedHandler<WorkerEnv>;

async function serveAdminAnalyticsDocument(
	request: Request,
	env: WorkerEnv,
	requestId: string,
): Promise<Response> {
	let response: Response;
	if (request.method !== "GET" && request.method !== "HEAD") {
		response = new Response("Method not allowed.", {
			status: 405,
			headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" },
		});
	} else if ([
		ADMIN_ANALYTICS_DOCUMENT,
		`${ADMIN_ANALYTICS_DOCUMENT}/`,
		`${ADMIN_ANALYTICS_DOCUMENT}/index.html`,
	].includes(new URL(request.url).pathname)) {
		const assetURL = new URL("/admin/analytics/index.html", request.url);
		response = await env.ASSETS.fetch(new Request(assetURL, {
			method: request.method,
			headers: { Accept: "text/html" },
		}));
	} else response = new Response("Not found.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
	const headers = new Headers(response.headers);
	// Cloudflare Web Analytics documents this exact cache directive as an
	// opt-out from automatic beacon injection. This token-bearing document must
	// never execute the public site's third-party RUM script.
	headers.set("Cache-Control", "public, max-age=0, must-revalidate, no-transform");
	headers.set("Content-Security-Policy", ADMIN_ANALYTICS_CSP);
	headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("Strict-Transport-Security", "max-age=31536000");
	headers.set("Cross-Origin-Opener-Policy", "same-origin");
	headers.set("Cross-Origin-Resource-Policy", "same-origin");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("X-Frame-Options", "DENY");
	headers.set("X-Permitted-Cross-Domain-Policies", "none");
	headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
	headers.set("X-Request-ID", requestId);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function safeWorkerErrorName(error: unknown): string {
	return error instanceof Error && error.name ? error.name : "UnknownError";
}

async function roomFetch(
	env: WorkerEnv,
	code: string,
	request: Request,
	token: string,
	requestId: string,
	pathname: string,
	body?: unknown,
): Promise<Response> {
	const id = env.ROOMS.idFromName(code);
	const stub = env.ROOMS.get(id);
	const headers = new Headers();
	headers.set("X-NonStopTalk-Token", token);
	headers.set("X-Request-ID", requestId);
	if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
		for (const name of [
			"Upgrade",
			"Sec-WebSocket-Key",
			"Sec-WebSocket-Version",
			"Sec-WebSocket-Protocol",
			"Sec-WebSocket-Extensions",
		]) {
			const value = request.headers.get(name);
			if (value) headers.set(name, value);
		}
	}
	const init: RequestInit = { method: request.method, headers };
	if (body !== undefined) {
		headers.set("Content-Type", "application/json");
		init.body = JSON.stringify(body);
	} else if (request.method !== "GET" && request.method !== "HEAD") {
		const contentType = request.headers.get("Content-Type");
		if (contentType) headers.set("Content-Type", contentType);
		init.body = request.body;
	}
	return stub.fetch(new Request(`https://room.internal${pathname}`, init));
}

function ensureToken(request: Request): TokenIdentity {
	const cookies = parseCookies(request.headers.get("Cookie") ?? "");
	const current = cookies[TOKEN_COOKIE];
	if (validToken(current)) return { token: current, created: false, migratedLegacy: false };
	const legacy = cookies[LEGACY_TOKEN_COOKIE];
	if (validToken(legacy)) return { token: legacy, created: true, migratedLegacy: true };
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return {
		token: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
		created: true,
		migratedLegacy: false,
	};
}

function withIdentityCookie(
	response: Response,
	identity: TokenIdentity,
	request: Request,
	refresh = false,
): Response {
	if (!identity.created && !refresh) return response;
	const headers = new Headers(response.headers);
	const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
	headers.append(
		"Set-Cookie",
		`${TOKEN_COOKIE}=${identity.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
	);
	if (identity.migratedLegacy) {
		headers.append("Set-Cookie", `${LEGACY_TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withRequestId(response: Response, requestId: string): Response {
	const headers = new Headers(response.headers);
	headers.set("X-Request-ID", requestId);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withRoomMilestones(response: Response, milestones: string[]): Response {
	if (milestones.length) response.headers.set(ROOM_MILESTONES_HEADER, milestones.join(","));
	return response;
}

function withoutRoomMilestones(response: Response): Response {
	if (!response.headers.has(ROOM_MILESTONES_HEADER)) return response;
	const headers = new Headers(response.headers);
	headers.delete(ROOM_MILESTONES_HEADER);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function scheduleRoomMilestones(ctx: ExecutionContext, env: WorkerEnv, response: Response): void {
	const milestones = response.headers
		.get(ROOM_MILESTONES_HEADER)
		?.split(",")
		.map((value) => value.trim())
		.filter(Boolean) ?? [];
	if (!milestones.length || !response.ok) return;
	const snapshot = response.clone();
	ctx.waitUntil(
		(async () => {
			const payload = (await snapshot.json()) as { room?: { serverNow?: unknown } };
			if (!payload.room) return;
			const serverNow = payload.room.serverNow;
			if (typeof serverNow !== "number" || !Number.isFinite(serverNow)) {
				throw new Error("room milestone is missing its server timestamp");
			}
			const observedAt = new Date(serverNow);
			for (const milestone of milestones) {
				await recordRoomMilestone(
					env,
					payload.room,
					milestone as Parameters<typeof recordRoomMilestone>[2],
					observedAt,
				);
			}
		})().catch((error: unknown) => {
			logWorkerEvent("warn", "room_milestone_delivery_failed", {
				error: error instanceof Error ? error.name : "UnknownError",
			});
		}),
	);
}

async function rateLimit(limiter: RateLimit, key: string, requestId: string): Promise<Response | null> {
	const { success } = await limiter.limit({ key });
	if (success) return null;
	const response = withRequestId(json({ error: "Too many requests. Try again shortly." }, 429), requestId);
	response.headers.set("Retry-After", "60");
	return response;
}

/** Keep raw connection addresses and browser tokens out of limiter dimensions. */
async function rateLimitKey(request: Request, token: string, scope: string): Promise<string> {
	const connectingAddress = request.headers.get("CF-Connecting-IP")?.trim();
	const subject = connectingAddress ? `address:${connectingAddress}` : `device:${token}`;
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`nonstoptalk-rate-limit:v1:${subject}`),
	);
	const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${scope}:${key}`;
}

function parseCookies(header: string): Record<string, string> {
	const cookies: Record<string, string> = {};
	for (const segment of header.split(";")) {
		const index = segment.indexOf("=");
		if (index < 0) continue;
		cookies[segment.slice(0, index).trim()] = segment.slice(index + 1).trim();
	}
	return cookies;
}

function validToken(value: string | undefined): value is string {
	return Boolean(value && /^[a-f0-9]{64}$/.test(value));
}

function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("Origin");
	if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
		return origin === new URL(request.url).origin;
	}
	if (request.method === "GET" || request.method === "HEAD") return true;
	return !origin || origin === new URL(request.url).origin;
}

function randomCode(): string {
	const values = crypto.getRandomValues(new Uint8Array(6));
	return Array.from(values, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	const length = Number(request.headers.get("Content-Length") ?? 0);
	if (length > 64 * 1024) throw new GameError("Request body is too large.", 413);
	if (!request.body) return {};
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > 64 * 1024) {
			await reader.cancel("request body too large");
			throw new GameError("Request body is too large.", 413);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const textBody = new TextDecoder().decode(bytes);
	if (!textBody) return {};
	try {
		const value = JSON.parse(textBody);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
		return value as Record<string, unknown>;
	} catch {
		throw new GameError("Could not read request data.", 400);
	}
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}
