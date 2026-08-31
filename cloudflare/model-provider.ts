export type TopicModelTier = "routine" | "escalated";

export type TopicProvider = "offline" | "glm" | "glm53" | "gemma31";

export interface TopicWorkersAIBinding {
	run(
		model: string,
		inputs: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<unknown>;
}

export interface TopicProviderBindings {
	TOPIC_ROUTINE_PROVIDER?: string;
	TOPIC_ESCALATION_PROVIDER?: string;
	ZAI_API_KEY?: string;
	GEMINI_API_KEY?: string;
	AI?: TopicWorkersAIBinding;
}

export interface TopicUsage {
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	cachedInputTokens: number | null;
	reasoningTokens: number | null;
}

export interface TopicGenerationResult {
	topics: string[];
	tier: TopicModelTier;
	provider: TopicProvider;
	model: string | null;
	usage: TopicUsage | null;
	requestId: string;
}

export interface TopicProviderDescription {
	tier: TopicModelTier;
	provider: TopicProvider;
	model: string | null;
	remote: boolean;
	configured: boolean;
}

export type TopicModelErrorCode =
	| "INVALID_INPUT"
	| "INVALID_CONFIGURATION"
	| "MISSING_CREDENTIALS"
	| "TIMEOUT"
	| "REMOTE_ERROR"
	| "INVALID_RESPONSE"
	| "RESPONSE_TOO_LARGE";

export class TopicModelError extends Error {
	readonly code: TopicModelErrorCode;
	readonly status: number;
	readonly provider: TopicProvider | null;
	readonly retryable: boolean;
	readonly usage: TopicUsage | null;

	constructor(
		code: TopicModelErrorCode,
		message: string,
		options: {
			status?: number;
			provider?: TopicProvider | null;
			retryable?: boolean;
			usage?: TopicUsage | null;
		} = {},
	) {
		super(message);
		this.name = "TopicModelError";
		this.code = code;
		this.status = options.status ?? 500;
		this.provider = options.provider ?? null;
		this.retryable = options.retryable ?? false;
		this.usage = options.usage ?? null;
	}
}

interface GenerateTopicsInput {
	theme: string;
	tier: TopicModelTier;
	requestId: string;
}

interface GenerateTopicsOptions {
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

interface ChatCompletionResponse {
	request_id?: unknown;
	choices?: unknown;
	usage?: unknown;
}

interface GeminiResponse {
	candidates?: unknown;
	usageMetadata?: unknown;
}

const ZAI_CHAT_COMPLETIONS_URL = "https://api.z.ai/api/paas/v4/chat/completions";
const GEMINI_GEMMA_31B_URL =
	"https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent";
const GLM_MODEL = "glm-4.7-flash";
const GLM53_MODEL = "glm-5.3-flash";
const GLM53_WORKERS_AI_MODEL = "@cf/zai-org/glm-5.3-flash";
const GEMMA_MODEL = "gemma-4-31b-it";
const TOPIC_COUNT = 10;
const MAX_THEME_CHARACTERS = 200;
const MAX_THEME_BYTES = 800;
const MAX_TOPIC_CHARACTERS = 200;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const SYSTEM_INSTRUCTION = [
	"Generate exactly 10 concise, safe, distinct speaking prompts related to the user's theme.",
	'Output only a JSON object with exactly one key, "topics", whose value is an array of 10 strings.',
	"Each prompt must be a single line between 1 and 200 characters. Do not use Markdown or add commentary.",
].join(" ");

const ROUTINE_OFFLINE_TEMPLATES = [
	"The most useful thing to know about {theme}",
	"A common misconception about {theme}",
	"How {theme} could improve everyday life",
	"The best beginner question about {theme}",
	"A small change that would make {theme} better",
	"The strongest argument in favor of {theme}",
	"A surprising connection between {theme} and daily routines",
	"What everyone should experience about {theme} once",
	"The future of {theme} in five years",
	"A personal story someone might tell about {theme}",
] as const;

const ESCALATED_OFFLINE_TEMPLATES = [
	"Defend an unpopular opinion about {theme}",
	"The hardest tradeoff hidden inside {theme}",
	"How an expert and a beginner would disagree about {theme}",
	"What would happen if {theme} became twice as important overnight",
	"The strongest case against the usual view of {theme}",
	"A rule about {theme} that society should reconsider",
	"The ethical question at the center of {theme}",
	"A bold prediction about the next decade of {theme}",
	"The most overlooked consequence of {theme}",
	"Explain {theme} through an unexpected analogy",
] as const;

export function describeTopicProvider(
	env: TopicProviderBindings,
	tier: TopicModelTier,
): TopicProviderDescription {
	assertTier(tier);
	const provider = providerForTier(env, tier);
	if (provider === "offline") {
		return { tier, provider, model: null, remote: false, configured: true };
	}
	if (provider === "glm") {
		return {
			tier,
			provider,
			model: GLM_MODEL,
			remote: true,
			configured: hasCredential(env.ZAI_API_KEY),
		};
	}
	if (provider === "glm53") {
		return {
			tier,
			provider,
			model: GLM53_MODEL,
			remote: true,
			// This is structural readiness only. Paid-plan eligibility is known
			// only when Cloudflare accepts an inference request at runtime.
			configured: hasWorkersAIBinding(env.AI),
		};
	}
	return {
		tier,
		provider,
		model: GEMMA_MODEL,
		remote: true,
		configured: hasCredential(env.GEMINI_API_KEY),
	};
}

export function generateOfflineTopics(theme: string, tier: TopicModelTier): string[] {
	assertTier(tier);
	const normalizedTheme = normalizeTheme(theme);
	const templates = tier === "routine" ? ROUTINE_OFFLINE_TEMPLATES : ESCALATED_OFFLINE_TEMPLATES;
	return templates.map((template) => fillOfflineTemplate(template, normalizedTheme));
}

export async function generateTopics(
	env: TopicProviderBindings,
	input: GenerateTopicsInput,
	options: GenerateTopicsOptions = {},
): Promise<TopicGenerationResult> {
	assertTier(input.tier);
	const theme = normalizeTheme(input.theme);
	const requestId = normalizeRequestId(input.requestId);
	const description = describeTopicProvider(env, input.tier);

	if (!description.remote) {
		return {
			topics: generateOfflineTopics(theme, input.tier),
			tier: input.tier,
			provider: "offline",
			model: null,
			usage: null,
			requestId,
		};
	}

	if (!description.configured) {
		throw new TopicModelError("MISSING_CREDENTIALS", "The selected topic provider is not configured.", {
			status: 503,
			provider: description.provider,
		});
	}

	const timeoutMs = normalizeTimeout(options.timeoutMs);
	if (description.provider === "glm53") {
		return generateWithWorkersAI(env, theme, input.tier, requestId, timeoutMs);
	}

	const fetcher = options.fetch ?? globalThis.fetch;
	if (typeof fetcher !== "function") {
		throw new TopicModelError("INVALID_CONFIGURATION", "No HTTP client is available for topic generation.", {
			status: 500,
			provider: description.provider,
		});
	}

	if (description.provider === "glm") {
		return generateWithGLM(env, theme, input.tier, requestId, fetcher, timeoutMs);
	}
	return generateWithGemma(env, theme, input.tier, requestId, fetcher, timeoutMs);
}

async function generateWithWorkersAI(
	env: TopicProviderBindings,
	theme: string,
	tier: TopicModelTier,
	requestId: string,
	timeoutMs: number,
): Promise<TopicGenerationResult> {
	const binding = workersAIBinding(env.AI);
	const payload = {
		messages: [
			{ role: "system", content: SYSTEM_INSTRUCTION },
			{ role: "user", content: theme },
		],
		stream: false,
		reasoning_effort: "low",
		store: false,
		max_completion_tokens: 1_200,
		response_format: { type: "json_object" },
	};
	const body = boundedBindingJSON(
		await runWorkersAIWithTimeout(binding, payload, timeoutMs),
		"glm53",
	);
	const parsed = asRecord(body) as ChatCompletionResponse | null;
	const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
	const firstChoice = asRecord(choices[0]);
	const message = asRecord(firstChoice?.message);
	const usage = workersAIUsage(parsed?.usage);
	if (
		choices.length !== 1
		|| firstChoice?.finish_reason !== "stop"
		|| typeof message?.content !== "string"
	) {
		throw invalidResponse("glm53", usage);
	}

	return {
		topics: parseTopicObject(message.content, "glm53", usage),
		tier,
		provider: "glm53",
		model: GLM53_MODEL,
		usage,
		requestId,
	};
}

async function runWorkersAIWithTimeout(
	binding: TopicWorkersAIBinding,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<unknown> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(timeoutError("glm53"));
		}, timeoutMs);
	});
	try {
		const request = binding.run(GLM53_WORKERS_AI_MODEL, payload, { signal: controller.signal });
		// Abort is best-effort at the inference service. The race enforces the
		// local deadline even if a request keeps running (and may still be billed).
		return await Promise.race([request, timeout]);
	} catch {
		if (controller.signal.aborted) throw timeoutError("glm53");
		throw new TopicModelError("REMOTE_ERROR", "The topic provider could not be reached.", {
			status: 502,
			provider: "glm53",
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function boundedBindingJSON(value: unknown, provider: Exclude<TopicProvider, "offline">): unknown {
	// AI.run materializes its result before returning it. This bounds strict
	// validation/accounting input, while max_completion_tokens is the upstream cap.
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw invalidResponse(provider);
	}
	if (serialized === undefined) throw invalidResponse(provider);
	if (new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) {
		throw responseTooLarge(provider);
	}
	try {
		return JSON.parse(serialized);
	} catch {
		throw invalidResponse(provider);
	}
}

async function generateWithGLM(
	env: TopicProviderBindings,
	theme: string,
	tier: TopicModelTier,
	requestId: string,
	fetcher: typeof globalThis.fetch,
	timeoutMs: number,
): Promise<TopicGenerationResult> {
	const apiKey = credential(env.ZAI_API_KEY, "glm");
	const payload = {
		model: GLM_MODEL,
		messages: [
			{ role: "system", content: SYSTEM_INSTRUCTION },
			{ role: "user", content: theme },
		],
		stream: false,
		thinking: { type: "disabled" },
		temperature: 1,
		top_p: 0.95,
		max_tokens: 1_200,
		response_format: { type: "json_object" },
	};
	const body = await fetchJSONWithTimeout(
		fetcher,
		ZAI_CHAT_COMPLETIONS_URL,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"Accept-Language": "en-US,en",
			},
			body: JSON.stringify(payload),
		},
		timeoutMs,
		"glm",
	);
	const parsed = asRecord(body) as ChatCompletionResponse | null;
	const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
	const firstChoice = asRecord(choices[0]);
	const message = asRecord(firstChoice?.message);
	const usage = glmUsage(parsed?.usage);
	if (firstChoice?.finish_reason !== "stop" || typeof message?.content !== "string") {
		throw invalidResponse("glm", usage);
	}

	return {
		topics: parseTopicObject(message.content, "glm", usage),
		tier,
		provider: "glm",
		model: GLM_MODEL,
		usage,
		requestId,
	};
}

async function generateWithGemma(
	env: TopicProviderBindings,
	theme: string,
	tier: TopicModelTier,
	requestId: string,
	fetcher: typeof globalThis.fetch,
	timeoutMs: number,
): Promise<TopicGenerationResult> {
	const apiKey = credential(env.GEMINI_API_KEY, "gemma31");
	const payload = {
		systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
		contents: [{ role: "user", parts: [{ text: theme }] }],
		generationConfig: {
			responseMimeType: "application/json",
			maxOutputTokens: 1_200,
			temperature: 0.7,
			thinkingConfig: { thinkingLevel: "minimal" },
		},
	};
	const body = await fetchJSONWithTimeout(
		fetcher,
		GEMINI_GEMMA_31B_URL,
		{
			method: "POST",
			headers: {
				"x-goog-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
		timeoutMs,
		"gemma31",
	);
	const parsed = asRecord(body) as GeminiResponse | null;
	const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
	const candidate = asRecord(candidates[0]);
	const content = asRecord(candidate?.content);
	const parts = Array.isArray(content?.parts) ? content.parts : [];
	const textParts = parts
		.map(asRecord)
		.filter((part) => part?.thought !== true && typeof part?.text === "string")
		.map((part) => String(part?.text));
	const usage = geminiUsage(parsed?.usageMetadata);
	if (candidate?.finishReason !== "STOP" || textParts.length !== 1) {
		throw invalidResponse("gemma31", usage);
	}

	return {
		topics: parseTopicObject(textParts[0], "gemma31", usage),
		tier,
		provider: "gemma31",
		model: GEMMA_MODEL,
		usage,
		requestId,
	};
}

async function fetchJSONWithTimeout(
	fetcher: typeof globalThis.fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	provider: Exclude<TopicProvider, "offline">,
): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetcher(url, { ...init, signal: controller.signal, redirect: "error" });
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new TopicModelError("REMOTE_ERROR", "The topic provider request failed.", {
				status: 502,
				provider,
				retryable: response.status === 429 || response.status >= 500,
			});
		}
		return await responseJSON(response, provider);
	} catch (error) {
		if (controller.signal.aborted) {
			throw new TopicModelError("TIMEOUT", "The topic provider request timed out.", {
				status: 504,
				provider,
				retryable: true,
			});
		}
		if (error instanceof TopicModelError) throw error;
		throw new TopicModelError("REMOTE_ERROR", "The topic provider could not be reached.", {
			status: 502,
			provider,
			retryable: true,
		});
	} finally {
		clearTimeout(timer);
	}
}

async function responseJSON(response: Response, provider: Exclude<TopicProvider, "offline">): Promise<unknown> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const bytes = Number(contentLength);
		if (Number.isFinite(bytes) && bytes > MAX_RESPONSE_BYTES) {
			await response.body?.cancel().catch(() => undefined);
			throw responseTooLarge(provider);
		}
	}

	const body = response.body;
	if (body === null) throw invalidResponse(provider);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw responseTooLarge(provider);
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof TopicModelError) throw error;
		throw invalidResponse(provider);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw invalidResponse(provider);
	}
}

function parseTopicObject(
	content: string,
	provider: Exclude<TopicProvider, "offline">,
	usage: TopicUsage | null,
): string[] {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw invalidResponse(provider, usage);
	}
	const record = asRecord(value);
	if (record === null || Object.keys(record).length !== 1 || !Array.isArray(record.topics)) {
		throw invalidResponse(provider, usage);
	}
	if (record.topics.length !== TOPIC_COUNT) throw invalidResponse(provider, usage);

	const topics: string[] = [];
	const unique = new Set<string>();
	for (const value of record.topics) {
		if (typeof value !== "string" || value !== value.trim()) throw invalidResponse(provider, usage);
		if (
			value.length === 0 ||
			[...value].length > MAX_TOPIC_CHARACTERS ||
			/[\r\n\u0000-\u001f\u007f]/u.test(value)
		) {
			throw invalidResponse(provider, usage);
		}
		const key = value.toLocaleLowerCase("en-US");
		if (unique.has(key)) throw invalidResponse(provider, usage);
		unique.add(key);
		topics.push(value);
	}
	return topics;
}

function glmUsage(value: unknown): TopicUsage | null {
	const usage = asRecord(value);
	if (usage === null) return null;
	const details = asRecord(usage.prompt_tokens_details);
	return {
		inputTokens: tokenCount(usage.prompt_tokens),
		outputTokens: tokenCount(usage.completion_tokens),
		totalTokens: tokenCount(usage.total_tokens),
		cachedInputTokens: tokenCount(details?.cached_tokens),
		reasoningTokens: null,
	};
}

function workersAIUsage(value: unknown): TopicUsage | null {
	const usage = asRecord(value);
	if (usage === null) return null;
	const promptDetails = asRecord(usage.prompt_tokens_details);
	const completionDetails = asRecord(usage.completion_tokens_details);
	return {
		inputTokens: tokenCount(usage.prompt_tokens),
		outputTokens: tokenCount(usage.completion_tokens),
		totalTokens: tokenCount(usage.total_tokens),
		cachedInputTokens: tokenCount(promptDetails?.cached_tokens),
		reasoningTokens: tokenCount(completionDetails?.reasoning_tokens),
	};
}

function geminiUsage(value: unknown): TopicUsage | null {
	const usage = asRecord(value);
	if (usage === null) return null;
	return {
		inputTokens: tokenCount(usage.promptTokenCount),
		outputTokens: tokenCount(usage.candidatesTokenCount),
		totalTokens: tokenCount(usage.totalTokenCount),
		cachedInputTokens: tokenCount(usage.cachedContentTokenCount),
		reasoningTokens: tokenCount(usage.thoughtsTokenCount),
	};
}

function tokenCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function providerForTier(env: TopicProviderBindings, tier: TopicModelTier): TopicProvider {
	const raw = tier === "routine" ? env.TOPIC_ROUTINE_PROVIDER : env.TOPIC_ESCALATION_PROVIDER;
	const value = typeof raw === "string" ? raw.trim().toLocaleLowerCase() : "";
	if (value === "" || value === "default" || value === "off" || value === "offline") return "offline";
	if (tier === "routine" && value === "glm") return "glm";
	if (tier === "routine" && value === "glm53") return "glm53";
	if (tier === "escalated" && value === "gemma31") return "gemma31";
	throw new TopicModelError(
		"INVALID_CONFIGURATION",
		`The ${tier} topic provider configuration is invalid.`,
		{ status: 500 },
	);
}

function normalizeTheme(value: string): string {
	if (typeof value !== "string") throw invalidInput("Theme must be text.");
	const theme = value.trim().replace(/[\t ]+/gu, " ");
	if (
		theme.length === 0 ||
		[...theme].length > MAX_THEME_CHARACTERS ||
		new TextEncoder().encode(theme).byteLength > MAX_THEME_BYTES ||
		/[\r\n\u0000-\u001f\u007f]/u.test(theme)
	) {
		throw invalidInput("Theme must be a short single line.");
	}
	return theme;
}

function fillOfflineTemplate(template: string, theme: string): string {
	const [prefix, suffix = ""] = template.split("{theme}");
	const available = MAX_TOPIC_CHARACTERS - [...prefix].length - [...suffix].length;
	const boundedTheme = [...theme].slice(0, Math.max(1, available)).join("");
	return `${prefix}${boundedTheme}${suffix}`;
}

function normalizeRequestId(value: string): string {
	if (
		typeof value !== "string" ||
		value.length < 6 ||
		value.length > 64 ||
		!/^[A-Za-z0-9._:-]+$/u.test(value)
	) {
		throw invalidInput("Request ID is invalid.");
	}
	return value;
}

function normalizeTimeout(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
		throw invalidInput("Topic provider timeout is invalid.");
	}
	return value;
}

function assertTier(value: TopicModelTier): void {
	if (value !== "routine" && value !== "escalated") throw invalidInput("Topic model tier is invalid.");
}

function credential(value: string | undefined, provider: Exclude<TopicProvider, "offline">): string {
	if (!hasCredential(value)) {
		throw new TopicModelError("MISSING_CREDENTIALS", "The selected topic provider is not configured.", {
			status: 503,
			provider,
		});
	}
	return value.trim();
}

function hasCredential(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function workersAIBinding(value: TopicWorkersAIBinding | undefined): TopicWorkersAIBinding {
	if (!hasWorkersAIBinding(value)) {
		throw new TopicModelError("MISSING_CREDENTIALS", "The selected topic provider is not configured.", {
			status: 503,
			provider: "glm53",
		});
	}
	return value;
}

function hasWorkersAIBinding(value: unknown): value is TopicWorkersAIBinding {
	return (
		(typeof value === "object" && value !== null) || typeof value === "function"
	) && typeof (value as { run?: unknown }).run === "function";
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function invalidInput(message: string): TopicModelError {
	return new TopicModelError("INVALID_INPUT", message, { status: 400 });
}

function invalidResponse(
	provider: Exclude<TopicProvider, "offline">,
	usage: TopicUsage | null = null,
): TopicModelError {
	return new TopicModelError("INVALID_RESPONSE", "The topic provider returned an invalid response.", {
		status: 502,
		provider,
		usage,
	});
}

function timeoutError(provider: Exclude<TopicProvider, "offline">): TopicModelError {
	return new TopicModelError("TIMEOUT", "The topic provider request timed out.", {
		status: 504,
		provider,
		retryable: true,
	});
}

function responseTooLarge(provider: Exclude<TopicProvider, "offline">): TopicModelError {
	return new TopicModelError("RESPONSE_TOO_LARGE", "The topic provider response exceeded the size limit.", {
		status: 502,
		provider,
	});
}
