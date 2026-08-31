import assert from "node:assert/strict";
import test from "node:test";

import {
	TopicModelError,
	describeTopicProvider,
	generateOfflineTopics,
	generateTopics,
} from "./model-provider.ts";

const tenTopics = Array.from({ length: 10 }, (_, index) => `Speaking prompt number ${index + 1}`);

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(value), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

function expectModelError(
	operation: () => unknown,
	code: InstanceType<typeof TopicModelError>["code"],
): void {
	const predicate = (error: unknown): boolean => error instanceof TopicModelError && error.code === code;
	assert.throws(operation, predicate);
}

test("default, off, and offline providers never make a network request", async () => {
	for (const value of [undefined, "default", "off", "offline"]) {
		let calls = 0;
		const result = await generateTopics(
			{
				TOPIC_ROUTINE_PROVIDER: value,
				TOPIC_ESCALATION_PROVIDER: value,
				ZAI_API_KEY: "must-not-be-used",
				GEMINI_API_KEY: "must-not-be-used",
			},
			{ theme: "city parks", tier: "routine", requestId: "request-001" },
			{
				fetch: (async () => {
					calls += 1;
					throw new Error("network must remain off");
				}) as typeof fetch,
			},
		);
		assert.equal(calls, 0);
		assert.equal(result.provider, "offline");
		assert.equal(result.model, null);
		assert.equal(result.usage, null);
		assert.equal(result.topics.length, 10);
	}
});

test("describes only the provider allowed for each tier and exposes missing configuration", () => {
	assert.deepEqual(describeTopicProvider({ TOPIC_ROUTINE_PROVIDER: "glm" }, "routine"), {
		tier: "routine",
		provider: "glm",
		model: "glm-4.7-flash",
		remote: true,
		configured: false,
	});
	assert.deepEqual(
		describeTopicProvider(
			{
				TOPIC_ROUTINE_PROVIDER: "glm53",
				AI: { run: async () => ({}) },
			},
			"routine",
		),
		{
			tier: "routine",
			provider: "glm53",
			model: "glm-5.3-flash",
			remote: true,
			configured: true,
		},
	);
	assert.deepEqual(
		describeTopicProvider({ TOPIC_ROUTINE_PROVIDER: "glm53" }, "routine"),
		{
			tier: "routine",
			provider: "glm53",
			model: "glm-5.3-flash",
			remote: true,
			configured: false,
		},
	);
	assert.deepEqual(
		describeTopicProvider(
			{ TOPIC_ESCALATION_PROVIDER: "gemma31", GEMINI_API_KEY: "google-key" },
			"escalated",
		),
		{
			tier: "escalated",
			provider: "gemma31",
			model: "gemma-4-31b-it",
			remote: true,
			configured: true,
		},
	);
	expectModelError(
		() => describeTopicProvider({ TOPIC_ROUTINE_PROVIDER: "gemma31" }, "routine"),
		"INVALID_CONFIGURATION",
	);
	expectModelError(
		() => describeTopicProvider({ TOPIC_ESCALATION_PROVIDER: "glm" }, "escalated"),
		"INVALID_CONFIGURATION",
	);
	expectModelError(
		() => describeTopicProvider({ TOPIC_ESCALATION_PROVIDER: "glm53" }, "escalated"),
		"INVALID_CONFIGURATION",
	);
});

test("offline generation is deterministic, tier-aware, bounded, and validates themes", () => {
	const routine = generateOfflineTopics("public transit", "routine");
	const escalated = generateOfflineTopics("public transit", "escalated");
	assert.equal(routine.length, 10);
	assert.equal(escalated.length, 10);
	assert.deepEqual(routine, generateOfflineTopics(" public   transit ", "routine"));
	assert.notDeepEqual(routine, escalated);
	assert.equal(new Set(routine.map((topic) => topic.toLocaleLowerCase())).size, 10);
	assert.ok(routine.every((topic) => topic.includes("public transit") && [...topic].length <= 200));
	expectModelError(() => generateOfflineTopics("", "routine"), "INVALID_INPUT");
	expectModelError(() => generateOfflineTopics("line one\nline two", "routine"), "INVALID_INPUT");
	assert.ok(generateOfflineTopics("x".repeat(200), "routine").every((topic) => [...topic].length <= 200));
	expectModelError(() => generateOfflineTopics("x".repeat(201), "routine"), "INVALID_INPUT");
});

test("GLM uses the general Z.AI API with theme-only user content and maps usage", async () => {
	const theme = "renewable energy";
	const secret = "zai-secret-key";
	let calls = 0;
	const result = await generateTopics(
		{ TOPIC_ROUTINE_PROVIDER: "glm", ZAI_API_KEY: secret },
		{ theme, tier: "routine", requestId: "request-glm-001" },
		{
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				calls += 1;
				assert.equal(String(input), "https://api.z.ai/api/paas/v4/chat/completions");
				assert.equal(init?.redirect, "error");
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("authorization"), `Bearer ${secret}`);
				const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
				assert.equal(payload.model, "glm-4.7-flash");
				assert.equal("request_id" in payload, false);
				assert.deepEqual(payload.thinking, { type: "disabled" });
				assert.equal("reasoning_effort" in payload, false);
				const messages = payload.messages as Array<Record<string, unknown>>;
				assert.deepEqual(messages.at(-1), { role: "user", content: theme });
				assert.equal(JSON.stringify(payload).split(theme).length - 1, 1);
				assert.equal(JSON.stringify(payload).includes("request-glm-001"), false);
				return jsonResponse({
					request_id: "request-glm-001",
					choices: [
						{
							finish_reason: "stop",
							message: { role: "assistant", content: JSON.stringify({ topics: tenTopics }) },
						},
					],
					usage: {
						prompt_tokens: 90,
						completion_tokens: 70,
						total_tokens: 160,
						prompt_tokens_details: { cached_tokens: 30 },
					},
				});
			}) as typeof fetch,
		},
	);
	assert.equal(calls, 1);
	assert.deepEqual(result, {
		topics: tenTopics,
		tier: "routine",
		provider: "glm",
		model: "glm-4.7-flash",
		usage: {
			inputTokens: 90,
			outputTokens: 70,
			totalTokens: 160,
			cachedInputTokens: 30,
			reasoningTokens: null,
		},
		requestId: "request-glm-001",
	});
});

test("Workers AI GLM 5.3 uses one binding call with a private, bounded chat-completions payload", async () => {
	const theme = "renewable energy";
	const requestId = "request-private-room-001";
	let calls = 0;
	let fetchCalls = 0;
	const result = await generateTopics(
		{
			TOPIC_ROUTINE_PROVIDER: "glm53",
			AI: {
				run: async (model, inputs, options) => {
					calls += 1;
					assert.equal(model, "@cf/zai-org/glm-5.3-flash");
					assert.ok(options?.signal instanceof AbortSignal);
					assert.deepEqual(Object.keys(inputs).sort(), [
						"max_completion_tokens",
						"messages",
						"reasoning_effort",
						"response_format",
						"store",
						"stream",
					]);
					assert.equal(inputs.max_completion_tokens, 1_200);
					assert.equal(inputs.reasoning_effort, "low");
					assert.equal(inputs.store, false);
					assert.equal(inputs.stream, false);
					assert.deepEqual(inputs.response_format, { type: "json_object" });
					const messages = inputs.messages as Array<Record<string, unknown>>;
					assert.equal(messages.length, 2);
					assert.equal(messages[0]?.role, "system");
					assert.equal(typeof messages[0]?.content, "string");
					assert.deepEqual(messages[1], { role: "user", content: theme });
					const serialized = JSON.stringify(inputs);
					assert.equal(serialized.split(theme).length - 1, 1);
					assert.equal(serialized.includes(requestId), false);
					assert.equal(serialized.includes("roomCode"), false);
					assert.equal(serialized.includes("browser"), false);
					return {
						id: "workers-ai-response",
						choices: [{
							finish_reason: "stop",
							message: { role: "assistant", content: JSON.stringify({ topics: tenTopics }) },
						}],
						usage: {
							prompt_tokens: 80,
							completion_tokens: 60,
							total_tokens: 150,
							prompt_tokens_details: { cached_tokens: 20 },
							completion_tokens_details: { reasoning_tokens: 10 },
						},
					};
				},
			},
		},
		{ theme: "  renewable   energy  ", tier: "routine", requestId },
		{
			fetch: (async () => {
				fetchCalls += 1;
				throw new Error("Workers AI must not use fetch");
			}) as typeof fetch,
		},
	);
	assert.equal(calls, 1);
	assert.equal(fetchCalls, 0);
	assert.deepEqual(result, {
		topics: tenTopics,
		tier: "routine",
		provider: "glm53",
		model: "glm-5.3-flash",
		usage: {
			inputTokens: 80,
			outputTokens: 60,
			totalTokens: 150,
			cachedInputTokens: 20,
			reasoningTokens: 10,
		},
		requestId,
	});
});

test("Workers AI GLM 5.3 failures are single-call, sanitized, strict, and bounded", async () => {
	const theme = "private-theme-canary";
	const bindingError = "private-binding-error-canary";
	let calls = 0;
	await assert.rejects(
		generateTopics(
			{
				TOPIC_ROUTINE_PROVIDER: "glm53",
				AI: {
					run: async () => {
						calls += 1;
						throw new Error(`${bindingError} ${theme}`);
					},
				},
			},
			{ theme, tier: "routine", requestId: "request-binding-failure" },
		),
		(error: unknown) => {
			assert.ok(error instanceof TopicModelError);
			assert.equal(error.code, "REMOTE_ERROR");
			assert.equal(error.provider, "glm53");
			assert.equal(error.retryable, false);
			assert.equal(error.message.includes(theme), false);
			assert.equal(error.message.includes(bindingError), false);
			return true;
		},
	);
	assert.equal(calls, 1);

	for (const response of [
		{
			choices: [{
				finish_reason: "stop",
				message: { content: JSON.stringify({ topics: tenTopics, extra: true }) },
			}],
		},
		{
			choices: [
				{ finish_reason: "stop", message: { content: JSON.stringify({ topics: tenTopics }) } },
				{ finish_reason: "stop", message: { content: JSON.stringify({ topics: tenTopics }) } },
			],
		},
	]) {
		await assert.rejects(
			generateTopics(
				{ TOPIC_ROUTINE_PROVIDER: "glm53", AI: { run: async () => response } },
				{ theme: "science", tier: "routine", requestId: "request-binding-invalid" },
			),
			(error: unknown) => error instanceof TopicModelError && error.code === "INVALID_RESPONSE",
		);
	}

	await assert.rejects(
		generateTopics(
			{
				TOPIC_ROUTINE_PROVIDER: "glm53",
				AI: { run: async () => ({ padding: "x".repeat(64 * 1024) }) },
			},
			{ theme: "science", tier: "routine", requestId: "request-binding-oversized" },
		),
		(error: unknown) => error instanceof TopicModelError && error.code === "RESPONSE_TOO_LARGE",
	);
});

test("Workers AI GLM 5.3 aborts its binding call at the logical timeout", async () => {
	let calls = 0;
	let observedAbort = false;
	await assert.rejects(
		generateTopics(
			{
				TOPIC_ROUTINE_PROVIDER: "glm53",
				AI: {
					run: async (_model, _inputs, options) => {
						calls += 1;
						return await new Promise((_resolve, reject) => {
							options?.signal?.addEventListener("abort", () => {
								observedAbort = true;
								reject(new Error("private-abort-error"));
							}, { once: true });
						});
					},
				},
			},
			{ theme: "architecture", tier: "routine", requestId: "request-binding-timeout" },
			{ timeoutMs: 5 },
		),
		(error: unknown) =>
			error instanceof TopicModelError
			&& error.code === "TIMEOUT"
			&& error.status === 504
			&& error.provider === "glm53",
	);
	assert.equal(calls, 1);
	assert.equal(observedAbort, true);
});

test("Workers AI GLM 5.3 enforces its logical timeout when the binding ignores abort", async () => {
	let calls = 0;
	let signal: AbortSignal | undefined;
	await assert.rejects(
		generateTopics(
			{
				TOPIC_ROUTINE_PROVIDER: "glm53",
				AI: {
					run: async (_model, _inputs, options) => {
						calls += 1;
						signal = options?.signal;
						return await new Promise(() => undefined);
					},
				},
			},
			{ theme: "architecture", tier: "routine", requestId: "request-binding-race" },
			{ timeoutMs: 5 },
		),
		(error: unknown) => error instanceof TopicModelError && error.code === "TIMEOUT",
	);
	assert.equal(calls, 1);
	assert.equal(signal?.aborted, true);
});

test("Gemma 31B uses generateContent without putting its key in the URL", async () => {
	const theme = "urban gardening";
	const secret = "gemini-secret-key";
	const result = await generateTopics(
		{ TOPIC_ESCALATION_PROVIDER: "gemma31", GEMINI_API_KEY: secret },
		{ theme, tier: "escalated", requestId: "request-gemma-001" },
		{
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				assert.equal(init?.redirect, "error");
				assert.equal(
					url,
					"https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent",
				);
				assert.equal(url.includes(secret), false);
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("x-goog-api-key"), secret);
				const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
				assert.deepEqual(payload.contents, [{ role: "user", parts: [{ text: theme }] }]);
				const systemInstruction = payload.systemInstruction as {
					parts: Array<{ text: unknown }>;
				};
				assert.equal(typeof systemInstruction.parts[0]?.text, "string");
				assert.deepEqual(payload.generationConfig, {
					responseMimeType: "application/json",
					maxOutputTokens: 1_200,
					temperature: 0.7,
					thinkingConfig: { thinkingLevel: "minimal" },
				});
				assert.equal(JSON.stringify(payload).split(theme).length - 1, 1);
				return jsonResponse({
					candidates: [
						{
							finishReason: "STOP",
							content: { role: "model", parts: [{ text: JSON.stringify({ topics: tenTopics }) }] },
						},
					],
					usageMetadata: {
						promptTokenCount: 40,
						candidatesTokenCount: 80,
						totalTokenCount: 130,
						cachedContentTokenCount: 10,
						thoughtsTokenCount: 10,
					},
				});
			}) as typeof fetch,
		},
	);
	assert.equal(result.provider, "gemma31");
	assert.equal(result.model, "gemma-4-31b-it");
	assert.deepEqual(result.topics, tenTopics);
	assert.deepEqual(result.usage, {
		inputTokens: 40,
		outputTokens: 80,
		totalTokens: 130,
		cachedInputTokens: 10,
		reasoningTokens: 10,
	});
});

test("missing credentials fail before fetch and never silently change providers", async () => {
	let calls = 0;
	await assert.rejects(
		generateTopics(
			{ TOPIC_ROUTINE_PROVIDER: "glm" },
			{ theme: "history", tier: "routine", requestId: "request-credential" },
			{
				fetch: (async () => {
					calls += 1;
					return jsonResponse({});
				}) as typeof fetch,
			},
		),
		(error: unknown) => error instanceof TopicModelError && error.code === "MISSING_CREDENTIALS",
	);
	assert.equal(calls, 0);
});

test("remote failures are single-attempt, typed, and do not expose secrets or response bodies", async () => {
	const secret = "do-not-leak-key";
	const theme = "do-not-leak-theme";
	const responseSecret = "do-not-leak-body";
	let calls = 0;
	await assert.rejects(
		generateTopics(
			{ TOPIC_ROUTINE_PROVIDER: "glm", ZAI_API_KEY: secret },
			{ theme, tier: "routine", requestId: "request-failure" },
			{
				fetch: (async () => {
					calls += 1;
					return new Response(`${responseSecret} ${secret} ${theme}`, { status: 429 });
				}) as typeof fetch,
			},
		),
		(error: unknown) => {
			assert.ok(error instanceof TopicModelError);
			assert.equal(error.code, "REMOTE_ERROR");
			assert.equal(error.retryable, true);
			assert.equal(error.message.includes(secret), false);
			assert.equal(error.message.includes(theme), false);
			assert.equal(error.message.includes(responseSecret), false);
			return true;
		},
	);
	assert.equal(calls, 1);
});

test("strictly rejects malformed, extra-key, duplicate, and oversized outputs", async () => {
	const invalidTopicObjects = [
		{ topics: tenTopics.slice(0, 9) },
		{ topics: [...tenTopics.slice(0, 9), tenTopics[0]] },
		{ topics: tenTopics, explanation: "extra" },
		{ topics: [...tenTopics.slice(0, 9), "line one\nline two"] },
	];
	for (const modelOutput of invalidTopicObjects) {
		await assert.rejects(
			generateTopics(
				{ TOPIC_ROUTINE_PROVIDER: "glm", ZAI_API_KEY: "key" },
				{ theme: "science", tier: "routine", requestId: "request-invalid" },
				{
					fetch: (async () =>
						jsonResponse({
							choices: [
								{
									finish_reason: "stop",
									message: { content: JSON.stringify(modelOutput) },
								},
							],
						})) as typeof fetch,
				},
			),
			(error: unknown) => error instanceof TopicModelError && error.code === "INVALID_RESPONSE",
		);
	}

	await assert.rejects(
		generateTopics(
			{ TOPIC_ROUTINE_PROVIDER: "glm", ZAI_API_KEY: "key" },
			{ theme: "science", tier: "routine", requestId: "request-oversized" },
			{
				fetch: (async () => new Response("x".repeat(64 * 1024 + 1))) as typeof fetch,
			},
		),
		(error: unknown) => error instanceof TopicModelError && error.code === "RESPONSE_TOO_LARGE",
	);
});

test("aborts timed-out requests and returns a sanitized TopicModelError", async () => {
	let observedAbort = false;
	await assert.rejects(
		generateTopics(
			{ TOPIC_ROUTINE_PROVIDER: "glm", ZAI_API_KEY: "key" },
			{ theme: "architecture", tier: "routine", requestId: "request-timeout" },
			{
				timeoutMs: 5,
				fetch: ((_: string | URL | Request, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							observedAbort = true;
							reject(new DOMException("aborted", "AbortError"));
						});
					})) as typeof fetch,
			},
		),
		(error: unknown) =>
			error instanceof TopicModelError && error.code === "TIMEOUT" && error.status === 504,
	);
	assert.equal(observedAbort, true);

	let bodyAbort = false;
	await assert.rejects(
		generateTopics(
			{ TOPIC_ROUTINE_PROVIDER: "glm", ZAI_API_KEY: "key" },
			{ theme: "architecture", tier: "routine", requestId: "request-body-timeout" },
			{
				timeoutMs: 5,
				fetch: (async (_: string | URL | Request, init?: RequestInit) =>
					new Response(
						new ReadableStream({
							start(controller): void {
								init?.signal?.addEventListener("abort", () => {
									bodyAbort = true;
									controller.error(new DOMException("aborted", "AbortError"));
								});
							},
						}),
					)) as typeof fetch,
			},
		),
		(error: unknown) => error instanceof TopicModelError && error.code === "TIMEOUT",
	);
	assert.equal(bodyAbort, true);
});
