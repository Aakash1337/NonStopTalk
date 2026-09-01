import {
	ANONYMOUS_DATA_RETENTION_MS,
	CLOUD_SUMMARY_POLICY_VERSION,
	MAX_ACTIVE_COACHING_SUMMARIES,
	PlatformError,
	analyticsEventFromRoomMilestone,
	cleanupExpiredData,
	createPlatformStore,
	hasExpiredPlatformData,
	mapAnalyticsEvent,
	mapPublicRoomStateToFact,
	readCleanupHeartbeat,
	recordCleanupHeartbeat,
	type AnalyticsEventInput,
	type CleanupHeartbeat,
	type RoomMilestone,
} from "./platform";
import {
	describeTopicProvider,
	type TopicModelTier,
	type TopicProviderBindings,
} from "./model-provider";
import { logWorkerEvent } from "./observability";
import { requireSupportedPlatformSchema } from "./platform-schema";

const MAX_PLATFORM_BODY_BYTES = 66 * 1024;
const DEFAULT_ANALYTICS_DAYS = 30;
const MAX_ANALYTICS_DAYS = 180;
const MAX_CLEANUP_BATCHES_PER_RUN = 20;
export const RETENTION_CLEANUP_STALE_MS = 36 * 60 * 60 * 1_000;
const MAX_HEARTBEAT_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface PlatformBindings extends TopicProviderBindings {
	PLATFORM_DB: D1Database;
	PRODUCT_ANALYTICS?: AnalyticsEngineDataset;
	ANALYTICS_ADMIN_TOKEN?: string;
	ROOM_FACT_HASH_KEY?: string;
	ROOM_MILESTONE_DELIVERY_MODE?: string;
}

export interface PlatformRouteResult {
	response: Response;
	refreshIdentity: boolean;
}

/**
 * Handle only the versioned central-platform surface. Returning null leaves
 * the existing room router in charge, so this module can evolve independently.
 */
export async function handlePlatformRoute(
	request: Request,
	env: PlatformBindings,
	browserToken: string,
	requestId: string,
	defer: (task: Promise<void>) => void,
): Promise<PlatformRouteResult | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/api/v1/")) return null;

	try {
		if (url.pathname === "/api/v1/platform/status") {
			if (request.method !== "GET" && request.method !== "HEAD") {
				return result(methodNotAllowed(requestId, "GET, HEAD"), false);
			}
			const schemaVersion = await requireSupportedPlatformSchema(env.PLATFORM_DB);
			const roomFactsReady = isSecureRoomFactKey(env.ROOM_FACT_HASH_KEY);
			const adminAnalyticsReady = isSecureAdminToken(env.ANALYTICS_ADMIN_TOKEN);
			const topicGeneration = topicGenerationCapability(env);
			const retentionCleanupStatus = classifyRetentionCleanupStatus(
				await readCleanupHeartbeat(env.PLATFORM_DB),
			);
			const degradedCapabilities = [
				...(roomFactsReady ? [] : ["roomFacts"]),
				...(adminAnalyticsReady ? [] : ["adminAnalytics"]),
				...(topicGeneration.status === "degraded" ? ["topicGeneration"] : []),
				...(retentionCleanupStatus === "ready" ? [] : ["retentionCleanup"]),
			];
			return result(
				platformJson(
					{
						status: degradedCapabilities.length === 0 ? "ok" : "degraded",
						apiVersion: "v1",
						schemaVersion,
						capabilities: {
							cloudProgress: {
								status: "ready",
								retentionDays: ANONYMOUS_DATA_RETENTION_MS / (24 * 60 * 60 * 1_000),
								newSaveLimit: MAX_ACTIVE_COACHING_SUMMARIES,
							},
							roomFacts: { status: roomFactsReady ? "ready" : "disabled" },
							retentionCleanup: { status: retentionCleanupStatus },
							topicGeneration,
							aggregateAnalytics: {
								status: adminAnalyticsReady ? "ready" : "write-only",
								// Release A can drain a future outbox but does not produce one.
								// Configuration alone must never overstate the effective path.
								delivery: "best-effort",
								adminRead: adminAnalyticsReady,
								analyticsEngine: env.PRODUCT_ANALYTICS ? "enabled" : "disabled",
							},
						},
						degradedCapabilities,
						requestId,
					},
					200,
					requestId,
				),
				false,
			);
		}

		if (url.pathname === "/api/v1/progress/sessions") {
			if (request.method === "GET") {
				await requireSupportedPlatformSchema(env.PLATFORM_DB);
				const store = createPlatformStore(env.PLATFORM_DB);
				const limit = parsePositiveInteger(url.searchParams.get("limit"), 50, 100);
				const page = await store.listCoachingSummaries(browserToken, {
					limit,
					cursor: url.searchParams.get("cursor"),
				});
				return result(platformJson({ ...page, requestId }, 200, requestId), true);
			}
			if (request.method === "POST") {
				requireExactMutationOrigin(request);
				const body = await readPlatformJson(request);
				assertExactBodyKeys(body, ["session"]);
				await requireSupportedPlatformSchema(env.PLATFORM_DB);
				const store = createPlatformStore(env.PLATFORM_DB);
				const saved = await store.saveConsentedCoachingSummary(
					browserToken,
					body.session,
					CLOUD_SUMMARY_POLICY_VERSION,
				);
				const analyticsEvents: AnalyticsEventInput[] = [];
				if (saved.consentGranted) {
					analyticsEvents.push({ type: "cloud_consent_granted" });
				}
				if (saved.created) {
					analyticsEvents.push({
						type: "coaching_summary_saved",
						durationMs: saved.summary.metrics.durationMs,
					});
				}
				deferProductEvents(defer, env, analyticsEvents);
				return result(
					platformJson({ created: saved.created, session: saved.summary, requestId }, saved.created ? 201 : 200, requestId),
					true,
				);
			}
			if (request.method === "DELETE") {
				requireExactMutationOrigin(request);
				await requireSupportedPlatformSchema(env.PLATFORM_DB);
				const store = createPlatformStore(env.PLATFORM_DB);
				const deleted = await store.clearCoachingSummaries(browserToken);
				const analyticsEvents: AnalyticsEventInput[] = [];
				if (deleted.deletedCount > 0) {
					analyticsEvents.push({
						type: "coaching_summary_deleted",
						deletedCount: deleted.deletedCount,
					});
				}
				if (deleted.consentRevoked) {
					analyticsEvents.push({ type: "cloud_consent_revoked" });
				}
				deferProductEvents(defer, env, analyticsEvents);
				return result(platformJson({ ...deleted, requestId }, 200, requestId), true);
			}
			return result(methodNotAllowed(requestId, "GET, POST, DELETE"), true);
		}

		if (url.pathname === "/api/v1/progress/export") {
			if (request.method !== "GET") return result(methodNotAllowed(requestId, "GET"), true);
			await requireSupportedPlatformSchema(env.PLATFORM_DB);
			const exported = await createPlatformStore(env.PLATFORM_DB).exportCoachingSummaries(browserToken);
			return result(platformJson({ ...exported, requestId }, 200, requestId), true);
		}

		if (url.pathname === "/api/v1/admin/analytics") {
			if (request.method !== "GET") return result(methodNotAllowed(requestId, "GET"), false);
			await requireAdmin(request, env.ANALYTICS_ADMIN_TOKEN);
			const days = parsePositiveInteger(url.searchParams.get("days"), DEFAULT_ANALYTICS_DAYS, MAX_ANALYTICS_DAYS);
			await requireSupportedPlatformSchema(env.PLATFORM_DB);
			const through = startOfUTCDay(new Date());
			const from = new Date(through.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
			const rows = await createPlatformStore(env.PLATFORM_DB).listDailyAnalytics(
				from.toISOString().slice(0, 10),
				through.toISOString().slice(0, 10),
			);
			const totals: Record<string, { events: number; value: number }> = {};
			for (const row of rows) {
				const current = totals[row.metric] ?? { events: 0, value: 0 };
				current.events += row.eventCount;
				current.value += row.valueSum;
				totals[row.metric] = current;
			}
			return result(
				platformJson(
					{
						window: { from: from.toISOString(), through: through.toISOString(), days },
						totals,
						daily: rows,
						privacy: "Aggregate product events only; no names, IPs, browser tokens, audio, or transcript text.",
						requestId,
					},
					200,
					requestId,
				),
				false,
			);
		}

		if (url.pathname === "/api/v1/admin/model-usage") {
			if (request.method !== "GET") return result(methodNotAllowed(requestId, "GET"), false);
			await requireAdmin(request, env.ANALYTICS_ADMIN_TOKEN);
			await requireSupportedPlatformSchema(env.PLATFORM_DB);
			const days = parsePositiveInteger(url.searchParams.get("days"), DEFAULT_ANALYTICS_DAYS, MAX_ANALYTICS_DAYS);
			const through = startOfUTCDay(new Date());
			const from = new Date(through.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
			const query = await env.PLATFORM_DB
				.prepare(`SELECT
					day, scope, provider, model, task,
					reserved_calls AS reservedCalls,
					completed_calls AS completedCalls,
					success_count AS successCount,
					failure_count AS failureCount,
					input_tokens AS inputTokens,
					output_tokens AS outputTokens,
					total_tokens AS totalTokens,
					cached_input_tokens AS cachedInputTokens,
					reasoning_tokens AS reasoningTokens,
					latency_ms_total AS latencyMsTotal,
					updated_at AS updatedAt
				FROM model_usage_daily
				WHERE day >= ? AND day <= ?
				ORDER BY day DESC, scope, provider, model`)
				.bind(from.toISOString().slice(0, 10), through.toISOString().slice(0, 10))
				.all<ModelUsageDailyRow>();
			const rows = query.results ?? [];
			return result(
				platformJson(
					{
						window: { from: from.toISOString(), through: through.toISOString(), days },
						totals: summarizeModelUsage(rows.filter((row) => row.scope === "global")),
						daily: rows,
						privacy: "Aggregate model operations only; no themes, generated topics, room codes, identities, audio, or transcript text.",
						requestId,
					},
					200,
					requestId,
				),
				false,
			);
		}

		return result(platformErrorResponse(new PlatformError("NOT_FOUND", "API route not found."), requestId), false);
	} catch (error) {
		return result(platformErrorResponse(error, requestId), url.pathname.startsWith("/api/v1/progress/"));
	}
}

export interface TopicGenerationCapability {
	status: "ready" | "degraded";
	routine: TopicTierCapability;
	escalated: TopicTierCapability;
}

interface ModelUsageDailyRow {
	day: string;
	scope: "global" | "provider";
	provider: string;
	model: string;
	task: string;
	reservedCalls: number;
	completedCalls: number;
	successCount: number;
	failureCount: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens: number;
	reasoningTokens: number;
	latencyMsTotal: number;
	updatedAt: string;
}

interface ModelUsageTotals {
	reservedCalls: number;
	completedCalls: number;
	successCount: number;
	failureCount: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens: number;
	reasoningTokens: number;
	latencyMsTotal: number;
}

interface TopicTierCapability {
	status: "offline" | "ready" | "degraded";
	provider: "offline" | "glm" | "glm53" | "gemma31";
	model: string | null;
	externalAvailable: boolean;
}

/** Expose deployment readiness without returning keys or arbitrary selector values. */
export function topicGenerationCapability(env: TopicProviderBindings): TopicGenerationCapability {
	const routine = topicTierCapability(env, "routine");
	const escalated = topicTierCapability(env, "escalated");
	return {
		status: routine.status === "degraded" || escalated.status === "degraded" ? "degraded" : "ready",
		routine,
		escalated,
	};
}

function topicTierCapability(env: TopicProviderBindings, tier: TopicModelTier): TopicTierCapability {
	try {
		const description = describeTopicProvider(env, tier);
		if (!description.remote) {
			return { status: "offline", provider: "offline", model: null, externalAvailable: false };
		}
		return {
			status: description.configured ? "ready" : "degraded",
			provider: description.provider,
			model: description.model,
			externalAvailable: description.configured,
		};
	} catch {
		return { status: "degraded", provider: "offline", model: null, externalAvailable: false };
	}
}

function summarizeModelUsage(rows: ModelUsageDailyRow[]): ModelUsageTotals {
	return rows.reduce<ModelUsageTotals>((total, row) => ({
		reservedCalls: total.reservedCalls + row.reservedCalls,
		completedCalls: total.completedCalls + row.completedCalls,
		successCount: total.successCount + row.successCount,
		failureCount: total.failureCount + row.failureCount,
		inputTokens: total.inputTokens + row.inputTokens,
		outputTokens: total.outputTokens + row.outputTokens,
		totalTokens: total.totalTokens + row.totalTokens,
		cachedInputTokens: total.cachedInputTokens + row.cachedInputTokens,
		reasoningTokens: total.reasoningTokens + row.reasoningTokens,
		latencyMsTotal: total.latencyMsTotal + row.latencyMsTotal,
	}), {
		reservedCalls: 0,
		completedCalls: 0,
		successCount: 0,
		failureCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedInputTokens: 0,
		reasoningTokens: 0,
		latencyMsTotal: 0,
	});
}

/** Record a real room transition, never a page view or presence heartbeat. */
export async function recordRoomMilestone(
	env: PlatformBindings,
	publicRoomState: unknown,
	milestone: RoomMilestone,
	observedAt = new Date(),
): Promise<void> {
	const fact = mapPublicRoomStateToFact(publicRoomState, milestone, observedAt);
	try {
		await requireSupportedPlatformSchema(env.PLATFORM_DB);
		const store = createPlatformStore(env.PLATFORM_DB, { roomHashKey: env.ROOM_FACT_HASH_KEY });
		await store.upsertRoomFact(publicRoomState, milestone, observedAt);
	} catch (error) {
		logWorkerEvent("warn", "room_fact_write_failed", { milestone, error: safeErrorName(error) });
	}
	const event = analyticsEventFromRoomMilestone(fact);
	if (event) await recordProductEvent(env, event, observedAt);
}

/** Both low-volume D1 rollups and Analytics Engine delivery are best-effort. */
export async function recordProductEvent(
	env: PlatformBindings,
	event: AnalyticsEventInput,
	occurredAt = new Date(),
): Promise<void> {
	let delta;
	try {
		delta = mapAnalyticsEvent(event, occurredAt);
	} catch (error) {
		logWorkerEvent("warn", "product_analytics_event_rejected", {
			metric: typeof event?.type === "string" ? event.type : "unknown",
			error: safeErrorName(error),
		});
		return;
	}
	try {
		await requireSupportedPlatformSchema(env.PLATFORM_DB);
		await createPlatformStore(env.PLATFORM_DB).recordAnalyticsEvent(event, occurredAt);
	} catch (error) {
		logWorkerEvent("warn", "product_analytics_rollup_failed", {
			metric: delta.metric,
			error: safeErrorName(error),
		});
	}
	try {
		env.PRODUCT_ANALYTICS?.writeDataPoint({
			indexes: [`event:${delta.metric}`],
			blobs: [delta.metric, "v1", "cloudflare"],
			doubles: [delta.eventCount, delta.valueSum],
		});
	} catch (error) {
		logWorkerEvent("warn", "analytics_engine_write_failed", {
			metric: delta.metric,
			error: safeErrorName(error),
		});
	}
}

function deferProductEvents(
	defer: (task: Promise<void>) => void,
	env: PlatformBindings,
	events: readonly AnalyticsEventInput[],
): void {
	if (events.length === 0) return;
	const occurredAt = new Date();
	defer((async () => {
		for (const event of events) await recordProductEvent(env, event, occurredAt);
	})());
}

export async function runPlatformCleanup(
	env: PlatformBindings,
	scheduledAt = new Date(),
	clock: () => Date = () => new Date(),
): Promise<void> {
	const deleted = {
		coachingSessions: 0,
		consentRecords: 0,
		devices: 0,
		syncProfiles: 0,
		roomFacts: 0,
		roomMilestoneReceipts: 0,
	};
	let hasMore = false;
	let batches = 0;
	while (batches < MAX_CLEANUP_BATCHES_PER_RUN) {
		const schemaVersion = await requireSupportedPlatformSchema(env.PLATFORM_DB);
		const chunk = await cleanupExpiredData(env.PLATFORM_DB, schemaVersion, scheduledAt);
		batches += 1;
		deleted.coachingSessions += chunk.coachingSessions;
		deleted.consentRecords += chunk.consentRecords;
		deleted.devices += chunk.devices;
		deleted.syncProfiles += chunk.syncProfiles;
		deleted.roomFacts += chunk.roomFacts;
		deleted.roomMilestoneReceipts += chunk.roomMilestoneReceipts;
		hasMore = chunk.hasMore;
		if (!hasMore) break;
	}
	if (hasMore && batches === MAX_CLEANUP_BATCHES_PER_RUN) {
		const schemaVersion = await requireSupportedPlatformSchema(env.PLATFORM_DB);
		hasMore = await hasExpiredPlatformData(env.PLATFORM_DB, schemaVersion, scheduledAt);
	}
	const observedCompletion = clock();
	const completedAt = observedCompletion.getTime() < scheduledAt.getTime()
		? scheduledAt
		: observedCompletion;
	await requireSupportedPlatformSchema(env.PLATFORM_DB);
	await recordCleanupHeartbeat(env.PLATFORM_DB, scheduledAt, completedAt, hasMore);
	logWorkerEvent("info", "platform_cleanup_completed", { ...deleted, batches, hasMore });
	if (hasMore) logWorkerEvent("warn", "platform_cleanup_budget_exhausted", { batches });
}

export type RetentionCleanupStatus = "ready" | "stale" | "backlog";

export function classifyRetentionCleanupStatus(
	heartbeat: CleanupHeartbeat,
	now: Date | string = new Date(),
): RetentionCleanupStatus {
	const observedAt = now instanceof Date ? now.getTime() : new Date(now).getTime();
	const scheduledAt = heartbeat.scheduledAt === null ? Number.NaN : Date.parse(heartbeat.scheduledAt);
	const completedAt = heartbeat.completedAt === null ? Number.NaN : Date.parse(heartbeat.completedAt);
	if (
		!Number.isFinite(observedAt)
		|| !Number.isFinite(scheduledAt)
		|| !Number.isFinite(completedAt)
		|| scheduledAt > completedAt
		|| scheduledAt > observedAt + MAX_HEARTBEAT_CLOCK_SKEW_MS
		|| completedAt > observedAt + MAX_HEARTBEAT_CLOCK_SKEW_MS
		|| observedAt - scheduledAt > RETENTION_CLEANUP_STALE_MS
	) {
		return "stale";
	}
	return heartbeat.backlog ? "backlog" : "ready";
}

function result(response: Response, refreshIdentity: boolean): PlatformRouteResult {
	return { response, refreshIdentity };
}

function platformJson(value: unknown, status: number, requestId: string): Response {
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

function platformErrorResponse(error: unknown, requestId: string): Response {
	const known = error instanceof PlatformError
		? error
		: new PlatformError("DATABASE_UNAVAILABLE", "The platform data service is temporarily unavailable.", {
			cause: error,
		});
	if (!(error instanceof PlatformError)) {
		logWorkerEvent("error", "platform_api_failed", { requestId, error: safeErrorName(error) });
	}
	const response = platformJson(
		{
			error: { code: known.code, message: known.message },
			requestId,
		},
		known.status,
		requestId,
	);
	if (known.status === 401) response.headers.set("WWW-Authenticate", 'Bearer realm="NonStopTalk analytics"');
	if (known.status === 503) response.headers.set("Retry-After", "30");
	return response;
}

function methodNotAllowed(requestId: string, allow: string): Response {
	const response = platformErrorResponse(
		new PlatformError("INVALID_INPUT", "Method not allowed.", { status: 405 }),
		requestId,
	);
	response.headers.set("Allow", allow);
	return response;
}

async function readPlatformJson(request: Request): Promise<Record<string, unknown>> {
	const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/json") {
		throw new PlatformError("INVALID_INPUT", "Content-Type must be application/json.");
	}
	const length = Number(request.headers.get("Content-Length") ?? 0);
	if (Number.isFinite(length) && length > MAX_PLATFORM_BODY_BYTES) {
		throw new PlatformError("PAYLOAD_TOO_LARGE", "The platform request body is too large.");
	}
	const reader = request.body?.getReader();
	if (!reader) return {};
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_PLATFORM_BODY_BYTES) {
			await reader.cancel("request body too large");
			throw new PlatformError("PAYLOAD_TOO_LARGE", "The platform request body is too large.");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new PlatformError("INVALID_INPUT", "Could not read platform request data.", { cause: error });
	}
}

function assertExactBodyKeys(body: Record<string, unknown>, allowed: string[]): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(body)) {
		if (!allowedSet.has(key)) throw new PlatformError("INVALID_INPUT", `Unexpected request field: ${key}.`);
	}
	for (const key of allowed) {
		if (!(key in body)) throw new PlatformError("INVALID_INPUT", `Missing request field: ${key}.`);
	}
}

function requireExactMutationOrigin(request: Request): void {
	const expected = new URL(request.url).origin;
	if (request.headers.get("Origin") !== expected) {
		throw new PlatformError("INVALID_IDENTITY", "Cross-origin request rejected.", { status: 403 });
	}
}

async function requireAdmin(request: Request, expectedToken: string | undefined): Promise<void> {
	if (!isSecureAdminToken(expectedToken)) {
		throw new PlatformError("DATABASE_UNAVAILABLE", "Analytics administration is not configured.");
	}
	const authorization = request.headers.get("Authorization") ?? "";
	const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
	if (!(await constantTimeTextEqual(presented, expectedToken))) {
		throw new PlatformError("INVALID_IDENTITY", "Administrator authentication is required.", { status: 401 });
	}
}

function isSecureAdminToken(value: string | undefined): value is string {
	if (typeof value !== "string") return false;
	const bytes = new TextEncoder().encode(value).byteLength;
	return bytes >= 24 && bytes <= 1_024 && /^\d+$/u.test(value);
}

function isSecureRoomFactKey(value: string | undefined): value is string {
	if (typeof value !== "string") return false;
	const bytes = new TextEncoder().encode(value).byteLength;
	return bytes >= 32 && bytes <= 1_024;
}

async function constantTimeTextEqual(left: string, right: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(left)),
		crypto.subtle.digest("SHA-256", encoder.encode(right)),
	]);
	if (typeof crypto.subtle.timingSafeEqual === "function") {
		return crypto.subtle.timingSafeEqual(leftHash, rightHash);
	}
	// Node's Web Crypto test runtime does not yet expose Workers'
	// timingSafeEqual extension. Both SHA-256 digests have a fixed length, so a
	// full fallback pass preserves the same comparison semantics in tests.
	const leftBytes = new Uint8Array(leftHash);
	const rightBytes = new Uint8Array(rightHash);
	let difference = 0;
	for (let index = 0; index < leftBytes.length; index += 1) {
		difference |= leftBytes[index] ^ rightBytes[index];
	}
	return difference === 0;
}

function parsePositiveInteger(value: string | null, fallback: number, maximum: number): number {
	if (value === null || value === "") return fallback;
	if (!/^\d{1,4}$/u.test(value)) throw new PlatformError("INVALID_INPUT", "A positive integer was expected.");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new PlatformError("INVALID_INPUT", `The value must be between 1 and ${maximum}.`);
	}
	return parsed;
}

function startOfUTCDay(value: Date): Date {
	return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function safeErrorName(error: unknown): string {
	return error instanceof Error ? error.name : "UnknownError";
}
