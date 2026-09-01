import {
	TopicModelError,
	describeTopicProvider,
	generateOfflineTopics,
	generateTopics,
	type TopicGenerationResult,
	type TopicModelTier,
	type TopicProviderBindings,
	type TopicProviderDescription,
} from "./model-provider";
import { logWorkerEvent } from "./observability";
import { requireSupportedPlatformSchema } from "./platform-schema";

const TOPIC_ROUTE = "/api/v1/models/topics";
const MAX_MODEL_BODY_BYTES = 16 * 1024;
const MAX_THEME_RUNES = 200;
const MAX_THEME_BYTES = 800;
const MAX_TOPIC_RUNES = 200;
const TOPIC_COUNT = 10;
const DEFAULT_DAILY_CALL_LIMIT = 100;
const MAX_DAILY_CALL_LIMIT = 100_000;
const REMOTE_FALLBACK_CODE = "REMOTE_PROVIDER_FALLBACK";
const PROVIDER_UNAVAILABLE_FALLBACK_CODE = "MODEL_PROVIDER_UNAVAILABLE";
const CONFIGURATION_FALLBACK_CODE = "MODEL_CONFIGURATION_FALLBACK";
const BUDGET_LIMIT_FALLBACK_CODE = "MODEL_DAILY_LIMIT_REACHED";
const BUDGET_UNAVAILABLE_FALLBACK_CODE = "MODEL_BUDGET_UNAVAILABLE";
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/u;
const SAFE_USAGE_DIMENSION = /^[A-Za-z0-9._:/-]+$/u;

const RESERVE_DAILY_CALL_SQL = `/* model_usage_reserve */
	INSERT INTO model_usage_daily (
		day, scope, provider, model, task, reserved_calls, completed_calls,
		success_count, failure_count, input_tokens, output_tokens,
		total_tokens, cached_input_tokens, reasoning_tokens,
		latency_ms_total, updated_at
	)
	VALUES (?, 'global', 'all', 'all', 'all', 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
	ON CONFLICT(day, scope, provider, model, task) DO UPDATE SET
		reserved_calls = model_usage_daily.reserved_calls + 1,
		updated_at = excluded.updated_at
	WHERE model_usage_daily.reserved_calls < ?`;

const RECONCILE_GLOBAL_USAGE_SQL = `/* model_usage_reconcile_global */
	UPDATE model_usage_daily
	SET completed_calls = completed_calls + 1,
		success_count = success_count + ?,
		failure_count = failure_count + ?,
		input_tokens = input_tokens + ?,
		output_tokens = output_tokens + ?,
		total_tokens = total_tokens + ?,
		cached_input_tokens = cached_input_tokens + ?,
		reasoning_tokens = reasoning_tokens + ?,
		latency_ms_total = latency_ms_total + ?,
		updated_at = ?
	WHERE day = ? AND scope = 'global' AND provider = 'all'
		AND model = 'all' AND task = 'all'`;

const RECONCILE_PROVIDER_USAGE_SQL = `/* model_usage_reconcile_provider */
	INSERT INTO model_usage_daily (
		day, scope, provider, model, task, reserved_calls, completed_calls,
		success_count, failure_count, input_tokens, output_tokens,
		total_tokens, cached_input_tokens, reasoning_tokens,
		latency_ms_total, updated_at
	)
	VALUES (?, 'provider', ?, ?, 'topics', 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(day, scope, provider, model, task) DO UPDATE SET
		completed_calls = model_usage_daily.completed_calls + 1,
		success_count = model_usage_daily.success_count + excluded.success_count,
		failure_count = model_usage_daily.failure_count + excluded.failure_count,
		input_tokens = model_usage_daily.input_tokens + excluded.input_tokens,
		output_tokens = model_usage_daily.output_tokens + excluded.output_tokens,
		total_tokens = model_usage_daily.total_tokens + excluded.total_tokens,
		cached_input_tokens = model_usage_daily.cached_input_tokens + excluded.cached_input_tokens,
		reasoning_tokens = model_usage_daily.reasoning_tokens + excluded.reasoning_tokens,
		latency_ms_total = model_usage_daily.latency_ms_total + excluded.latency_ms_total,
		updated_at = excluded.updated_at`;

export interface ModelRouteBindings extends TopicProviderBindings {
	PLATFORM_DB: D1Database;
	MODEL_DAILY_CALL_LIMIT?: string;
}

type GenerateTopics = typeof generateTopics;
type DescribeProvider = typeof describeTopicProvider;
type OfflineTopics = typeof generateOfflineTopics;

export interface ModelRouteDependencies {
	authorizeHost(
		roomCode: string,
		browserToken: string,
	): Promise<void | { topicGeneration: number }>;
	generateTopics?: GenerateTopics;
	describeProvider?: DescribeProvider;
	offline?: OfflineTopics;
	now?: () => Date;
}

export interface ModelRouteResult {
	response: Response;
	refreshIdentity: boolean;
}

interface TopicRequest {
	roomCode: string;
	theme: string;
	tier: TopicModelTier;
	externalConsent: boolean;
}

interface UsageReconciliation {
	provider: string;
	model: string;
	succeeded: boolean;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens: number;
	reasoningTokens: number;
	latencyMs: number;
}

interface ExternalAttemptDisclosure {
	provider: "glm" | "glm53" | "gemma31";
	model: string;
}

export type ModelAuthorizationStatus = 403 | 409 | 503;

/**
 * A deliberately data-free authorization failure that can cross the Worker /
 * route boundary without carrying a Durable Object response body or error.
 */
export class ModelAuthorizationError extends Error {
	readonly status: ModelAuthorizationStatus;

	constructor(status: ModelAuthorizationStatus) {
		super("Room topic-generation authorization failed.");
		this.name = "ModelAuthorizationError";
		this.status = status;
	}
}

export function modelAuthorizationErrorForStatus(status: number): ModelAuthorizationError {
	if (status === 409) return new ModelAuthorizationError(409);
	if (status >= 500) return new ModelAuthorizationError(503);
	return new ModelAuthorizationError(403);
}

class ModelRouteError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = "ModelRouteError";
		this.code = code;
		this.status = status;
	}
}

function authorizationRouteError(error: unknown): ModelRouteError {
	if (error instanceof ModelAuthorizationError && error.status === 409) {
		return new ModelRouteError(
			"ROOM_PHASE_CONFLICT",
			"Topics can only be generated while the room is in setup.",
			409,
		);
	}
	if (error instanceof ModelAuthorizationError && error.status === 503) {
		return new ModelRouteError(
			"ROOM_AUTHORIZATION_UNAVAILABLE",
			"Room authorization is temporarily unavailable.",
			503,
		);
	}
	return new ModelRouteError(
		"HOST_AUTHORIZATION_REQUIRED",
		"Only the room host can generate topics while the room is in setup.",
		403,
	);
}

/**
 * Handle the optional, versioned topic-model route. The room callback is the
 * authority for both host ownership and setup-phase eligibility; provider
 * selection remains server-controlled.
 */
export async function handleModelRoute(
	request: Request,
	env: ModelRouteBindings,
	browserToken: string,
	requestId: string,
	deps: ModelRouteDependencies,
): Promise<ModelRouteResult | null> {
	const url = new URL(request.url);
	if (url.pathname !== TOPIC_ROUTE) return null;
	if (request.method !== "POST") {
		const response = errorResponse(
			new ModelRouteError("METHOD_NOT_ALLOWED", "Method not allowed.", 405),
			requestId,
		);
		response.headers.set("Allow", "POST");
		return result(response);
	}

	try {
		requireExactMutationOrigin(request);
		const input = normalizeTopicRequest(await readModelJson(request));
		let topicGeneration: number | null;
		try {
			topicGeneration = authorizationGeneration(
				await deps.authorizeHost(input.roomCode, browserToken),
			);
		} catch (error) {
			throw authorizationRouteError(error);
		}

		const offline = deps.offline ?? generateOfflineTopics;
		const describe = deps.describeProvider ?? describeTopicProvider;
		let description: TopicProviderDescription;
		try {
			description = describe(env, input.tier);
		} catch {
			return result(offlineFallbackResponse(
				input,
				offline,
				CONFIGURATION_FALLBACK_CODE,
				requestId,
				topicGeneration,
			));
		}
		if (description.remote && description.configured && !input.externalConsent) {
			throw new ModelRouteError(
				"EXTERNAL_CONSENT_REQUIRED",
				`Confirm this one topic request before sending its theme to ${providerLabel(description.provider)}.`,
				428,
			);
		}

		const generator = deps.generateTopics ?? generateTopics;
		if (!description.remote) {
			const generated = await generator(env, {
				theme: input.theme,
				tier: input.tier,
				requestId,
			});
			return result(successResponse(
				normalizeGeneratedResult(generated, input.tier),
				null,
				requestId,
				topicGeneration,
			));
		}

		// A selected but incomplete remote configuration cannot perform a fetch,
		// so it does not consume the paid-call budget.
		if (!description.configured) {
			return result(offlineFallbackResponse(
				input, offline, PROVIDER_UNAVAILABLE_FALLBACK_CODE, requestId, topicGeneration,
			));
		}

		const reservationTime = clock(deps.now);
		const reservationDay = utcDay(reservationTime);
		let reserved: boolean;
		try {
			await requireSupportedPlatformSchema(env.PLATFORM_DB);
			reserved = await reserveDailyCall(
				env.PLATFORM_DB,
				reservationDay,
				reservationTime.toISOString(),
				dailyCallLimit(env.MODEL_DAILY_CALL_LIMIT),
			);
		} catch {
			return result(offlineFallbackResponse(
				input, offline, BUDGET_UNAVAILABLE_FALLBACK_CODE, requestId, topicGeneration,
			));
		}
		if (!reserved) {
			return result(offlineFallbackResponse(
				input, offline, BUDGET_LIMIT_FALLBACK_CODE, requestId, topicGeneration,
			));
		}

		const startedAt = clock(deps.now).getTime();
		try {
			const generated = normalizeGeneratedResult(
				await generator(env, {
					theme: input.theme,
					tier: input.tier,
					requestId,
				}),
				input.tier,
			);
			if (generated.provider === "offline") {
				throw new Error("remote provider unexpectedly returned an offline result");
			}
			await safelyReconcileUsage(env.PLATFORM_DB, reservationDay, clock(deps.now), {
				provider: generated.provider,
				model: generated.model ?? description.model ?? "unknown",
				succeeded: true,
				inputTokens: tokenCount(generated.usage?.inputTokens),
				outputTokens: tokenCount(generated.usage?.outputTokens),
				totalTokens: tokenCount(generated.usage?.totalTokens),
				cachedInputTokens: tokenCount(generated.usage?.cachedInputTokens),
				reasoningTokens: tokenCount(generated.usage?.reasoningTokens),
				latencyMs: elapsedMilliseconds(startedAt, clock(deps.now)),
			});
			return result(successResponse(
				generated,
				null,
				requestId,
				topicGeneration,
				externalAttempt(description),
			));
		} catch (error) {
			const failedUsage = error instanceof TopicModelError ? error.usage : null;
			await safelyReconcileUsage(env.PLATFORM_DB, reservationDay, clock(deps.now), {
				provider: description.provider,
				model: description.model ?? "unknown",
				succeeded: false,
				inputTokens: tokenCount(failedUsage?.inputTokens),
				outputTokens: tokenCount(failedUsage?.outputTokens),
				totalTokens: tokenCount(failedUsage?.totalTokens),
				cachedInputTokens: tokenCount(failedUsage?.cachedInputTokens),
				reasoningTokens: tokenCount(failedUsage?.reasoningTokens),
				latencyMs: elapsedMilliseconds(startedAt, clock(deps.now)),
			});
			return result(offlineFallbackResponse(
				input,
				offline,
				REMOTE_FALLBACK_CODE,
				requestId,
				topicGeneration,
				externalAttempt(description),
			));
		}
	} catch (error) {
		const known = error instanceof ModelRouteError
			? error
			: new ModelRouteError("MODEL_ROUTE_UNAVAILABLE", "Topic generation is temporarily unavailable.", 503);
		return result(errorResponse(known, requestId));
	}
}

function result(response: Response): ModelRouteResult {
	return { response, refreshIdentity: true };
}

function successResponse(
	generated: TopicGenerationResult,
	fallbackCode: string | null,
	requestId: string,
	topicGeneration: number | null,
	attempt: ExternalAttemptDisclosure | null = null,
): Response {
	const generatedExternally = generated.provider !== "offline";
	const disclosedAttempt = attempt ?? (generatedExternally && generated.model
		? { provider: generated.provider, model: generated.model } as ExternalAttemptDisclosure
		: null);
	return modelJson({
		topics: generated.topics,
		tier: generated.tier,
		provider: generated.provider,
		model: generated.model,
		external: disclosedAttempt !== null,
		externalProvider: disclosedAttempt?.provider ?? null,
		externalModel: disclosedAttempt?.model ?? null,
		topicGeneration,
		fallbackCode,
		requestId,
	}, 200, requestId);
}

function offlineFallbackResponse(
	input: TopicRequest,
	offline: OfflineTopics,
	fallbackCode: string,
	requestId: string,
	topicGeneration: number | null,
	attempt: ExternalAttemptDisclosure | null = null,
): Response {
	let topics: string[];
	try {
		topics = normalizeTopics(offline(input.theme, input.tier));
	} catch {
		return errorResponse(
			new ModelRouteError("OFFLINE_FALLBACK_UNAVAILABLE", "Topic generation is temporarily unavailable.", 503),
			requestId,
		);
	}
	return successResponse({
		topics,
		tier: input.tier,
		provider: "offline",
		model: null,
		usage: null,
		requestId,
	}, fallbackCode, requestId, topicGeneration, attempt);
}

function authorizationGeneration(value: void | { topicGeneration: number }): number | null {
	if (value === undefined) return null;
	if (!Number.isSafeInteger(value.topicGeneration) || value.topicGeneration < 1) {
		throw modelAuthorizationErrorForStatus(503);
	}
	return value.topicGeneration;
}

function externalAttempt(description: TopicProviderDescription): ExternalAttemptDisclosure {
	if (
		!description.remote
		|| (
			description.provider !== "glm"
			&& description.provider !== "glm53"
			&& description.provider !== "gemma31"
		)
		|| !description.model
	) {
		throw new Error("external provider disclosure is unavailable");
	}
	return { provider: description.provider, model: description.model };
}

function normalizeGeneratedResult(
	generated: TopicGenerationResult,
	requestedTier: TopicModelTier,
): TopicGenerationResult {
	if (!generated || generated.tier !== requestedTier) {
		throw new Error("topic provider returned the wrong tier");
	}
	if (
		generated.provider !== "offline"
		&& generated.provider !== "glm"
		&& generated.provider !== "glm53"
		&& generated.provider !== "gemma31"
	) {
		throw new Error("topic provider returned an unsupported provider");
	}
	if (generated.model !== null && (
		typeof generated.model !== "string"
		|| generated.model.length === 0
		|| generated.model.length > 128
	)) {
		throw new Error("topic provider returned an invalid model");
	}
	return { ...generated, topics: normalizeTopics(generated.topics) };
}

function normalizeTopics(input: unknown): string[] {
	if (!Array.isArray(input) || input.length !== TOPIC_COUNT) {
		throw new Error(`topic provider must return exactly ${TOPIC_COUNT} topics`);
	}
	const seen = new Set<string>();
	return input.map((value) => {
		if (typeof value !== "string") throw new Error("topic must be text");
		const topic = value.trim();
		if (
			!topic
			|| [...topic].length > MAX_TOPIC_RUNES
			|| /[\r\n\u0000-\u001f\u007f]/u.test(topic)
		) {
			throw new Error("topic has an invalid length or format");
		}
		const key = topic.toLocaleLowerCase("en-US");
		if (seen.has(key)) throw new Error("topic list contains a duplicate");
		seen.add(key);
		return topic;
	});
}

async function reserveDailyCall(
	database: D1Database,
	day: string,
	timestamp: string,
	limit: number,
): Promise<boolean> {
	const result = await database
		.prepare(RESERVE_DAILY_CALL_SQL)
		.bind(day, timestamp, limit)
		.run();
	return resultChanges(result) === 1;
}

async function safelyReconcileUsage(
	database: D1Database,
	reservationDay: string,
	completedAt: Date,
	usage: UsageReconciliation,
): Promise<void> {
	const timestamp = completedAt.toISOString();
	const provider = usageDimension(usage.provider, 64);
	const model = usageDimension(usage.model, 128);
	const success = usage.succeeded ? 1 : 0;
	const failure = usage.succeeded ? 0 : 1;
	try {
		// Provider calls can outlive a schema transition. Revalidate immediately
		// before the reconciliation batch so an old isolate cannot issue schema-5
		// SQL after the compatibility window has closed.
		await requireSupportedPlatformSchema(database);
		await database.batch([
			database
				.prepare(RECONCILE_GLOBAL_USAGE_SQL)
				.bind(
					success,
					failure,
					usage.inputTokens,
					usage.outputTokens,
					usage.totalTokens,
					usage.cachedInputTokens,
					usage.reasoningTokens,
					usage.latencyMs,
					timestamp,
					reservationDay,
				),
			database
				.prepare(RECONCILE_PROVIDER_USAGE_SQL)
				.bind(
					reservationDay,
					provider,
					model,
					success,
					failure,
					usage.inputTokens,
					usage.outputTokens,
					usage.totalTokens,
					usage.cachedInputTokens,
					usage.reasoningTokens,
					usage.latencyMs,
					timestamp,
				),
		]);
	} catch (error) {
		logWorkerEvent("warn", "model_usage_reconciliation_failed", {
			error: error instanceof Error ? error.name : "UnknownError",
		});
	}
}

function dailyCallLimit(value: string | undefined): number {
	if (value === undefined || value === "") return DEFAULT_DAILY_CALL_LIMIT;
	if (!/^\d{1,6}$/u.test(value)) throw new Error("invalid daily model call limit");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_DAILY_CALL_LIMIT) {
		throw new Error("invalid daily model call limit");
	}
	return parsed;
}

function usageDimension(value: string, maximum: number): string {
	const normalized = String(value).trim();
	if (!normalized || normalized.length > maximum || !SAFE_USAGE_DIMENSION.test(normalized)) return "unknown";
	return normalized;
}

function tokenCount(value: number | null | undefined): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function elapsedMilliseconds(startedAt: number, completedAt: Date): number {
	return Math.max(0, Math.min(300_000, Math.round(completedAt.getTime() - startedAt)));
}

function clock(now: (() => Date) | undefined): Date {
	const value = now?.() ?? new Date();
	if (!Number.isFinite(value.getTime())) throw new Error("invalid route clock");
	return value;
}

function utcDay(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function providerLabel(provider: TopicProviderDescription["provider"]): string {
	switch (provider) {
		case "glm": return "Z.AI (GLM)";
		case "glm53": return "Cloudflare Workers AI (GLM 5.3 Flash)";
		case "gemma31": return "the configured Gemma 4 service";
		case "offline": return "the local topic generator";
	}
}

function normalizeTopicRequest(body: Record<string, unknown>): TopicRequest {
	assertExactKeys(body, ["roomCode", "theme", "tier", "externalConsent"]);
	const roomCode = typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : "";
	if (!ROOM_CODE_PATTERN.test(roomCode)) {
		throw new ModelRouteError("INVALID_INPUT", "A valid room code is required.", 400);
	}
	const theme = typeof body.theme === "string" ? body.theme.trim() : "";
	if (
		!theme
		|| [...theme].length > MAX_THEME_RUNES
		|| new TextEncoder().encode(theme).byteLength > MAX_THEME_BYTES
		|| /[\r\n\u0000-\u001f\u007f]/u.test(theme)
	) {
		throw new ModelRouteError(
			"INVALID_INPUT",
			`Theme must contain 1-${MAX_THEME_RUNES} characters and at most ${MAX_THEME_BYTES} UTF-8 bytes.`,
			400,
		);
	}
	if (body.tier !== "routine" && body.tier !== "escalated") {
		throw new ModelRouteError("INVALID_INPUT", "Topic tier must be routine or escalated.", 400);
	}
	if (typeof body.externalConsent !== "boolean") {
		throw new ModelRouteError("INVALID_INPUT", "External consent must be a boolean.", 400);
	}
	return { roomCode, theme, tier: body.tier, externalConsent: body.externalConsent };
}

function assertExactKeys(body: Record<string, unknown>, expected: string[]): void {
	const expectedSet = new Set(expected);
	for (const key of Object.keys(body)) {
		if (!expectedSet.has(key)) {
			throw new ModelRouteError("INVALID_INPUT", `Unexpected request field: ${key}.`, 400);
		}
	}
	for (const key of expected) {
		if (!(key in body)) {
			throw new ModelRouteError("INVALID_INPUT", `Missing request field: ${key}.`, 400);
		}
	}
}

function requireExactMutationOrigin(request: Request): void {
	if (request.headers.get("Origin") !== new URL(request.url).origin) {
		throw new ModelRouteError("INVALID_ORIGIN", "Cross-origin request rejected.", 403);
	}
}

async function readModelJson(request: Request): Promise<Record<string, unknown>> {
	const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/json") {
		throw new ModelRouteError("INVALID_INPUT", "Content-Type must be application/json.", 400);
	}
	const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_BODY_BYTES) {
		throw new ModelRouteError("PAYLOAD_TOO_LARGE", "The model request body is too large.", 413);
	}
	if (!request.body) throw new ModelRouteError("INVALID_INPUT", "A JSON request body is required.", 400);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_MODEL_BODY_BYTES) {
			await reader.cancel("request body too large");
			throw new ModelRouteError("PAYLOAD_TOO_LARGE", "The model request body is too large.", 413);
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
		if (error instanceof ModelRouteError) throw error;
		throw new ModelRouteError("INVALID_INPUT", "Could not read model request data.", 400);
	}
}

function resultChanges(result: D1Result<unknown>): number {
	const changes = (result.meta as { changes?: unknown } | undefined)?.changes;
	return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}

function errorResponse(error: ModelRouteError, requestId: string): Response {
	return modelJson({
		error: { code: error.code, message: error.message },
		requestId,
	}, error.status, requestId);
}

function modelJson(value: unknown, status: number, requestId: string): Response {
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
