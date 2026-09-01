import assert from "node:assert/strict";
import test from "node:test";

import {
	handleModelRoute,
	modelAuthorizationErrorForStatus,
	type ModelRouteBindings,
	type ModelRouteDependencies,
} from "./model-routes.ts";
import { TopicModelError } from "./model-provider.ts";
import type {
	TopicGenerationResult,
	TopicModelTier,
	TopicProviderDescription,
} from "./model-provider.ts";

interface UsageRow {
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

class FakeD1 {
	readonly global = new Map<string, UsageRow>();
	readonly providers = new Map<string, UsageRow>();
	readonly bindingLog: unknown[][] = [];
	failReservation = false;
	schemaVersion: unknown;
	markerReads = 0;

	constructor(schemaVersion: unknown = 5) {
		this.schemaVersion = schemaVersion;
	}

	prepare(query: string): D1PreparedStatement {
		return new FakeStatement(this, query) as unknown as D1PreparedStatement;
	}

	async batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
		const results: D1Result<unknown>[] = [];
		for (const statement of statements) {
			results.push(await (statement as unknown as FakeStatement).execute());
		}
		return results;
	}

	execute(query: string, bindings: unknown[]): D1Result<unknown> {
		this.bindingLog.push([...bindings]);
		if (query.includes("model_usage_reserve")) {
			if (this.failReservation) throw new Error("database unavailable with secret-canary");
			const [day, timestamp, limit] = bindings as [string, string, number];
			const current = this.global.get(day) ?? emptyRow(timestamp);
			if (current.reservedCalls >= limit) return d1Result(0);
			current.reservedCalls += 1;
			current.updatedAt = timestamp;
			this.global.set(day, current);
			return d1Result(1);
		}
		if (query.includes("model_usage_reconcile_global")) {
			const [success, failure, input, output, total, cached, reasoning, latency, timestamp, day] = bindings as [
				number, number, number, number, number, number, number, number, string, string,
			];
			const current = this.global.get(day);
			if (!current) return d1Result(0);
			current.completedCalls += 1;
			current.successCount += success;
			current.failureCount += failure;
			current.inputTokens += input;
			current.outputTokens += output;
			current.totalTokens += total;
			current.cachedInputTokens += cached;
			current.reasoningTokens += reasoning;
			current.latencyMsTotal += latency;
			current.updatedAt = timestamp;
			return d1Result(1);
		}
		if (query.includes("model_usage_reconcile_provider")) {
			const [day, provider, model, success, failure, input, output, total, cached, reasoning, latency, timestamp] = bindings as [
				string, string, string, number, number, number, number, number, number, number, number, string,
			];
			const key = `${day}:${provider}:${model}:topics`;
			const current = this.providers.get(key) ?? emptyRow(timestamp);
			current.completedCalls += 1;
			current.successCount += success;
			current.failureCount += failure;
			current.inputTokens += input;
			current.outputTokens += output;
			current.totalTokens += total;
			current.cachedInputTokens += cached;
			current.reasoningTokens += reasoning;
			current.latencyMsTotal += latency;
			current.updatedAt = timestamp;
			this.providers.set(key, current);
			return d1Result(1);
		}
		throw new Error("unexpected SQL in fake D1");
	}
}

class FakeStatement {
	readonly #database: FakeD1;
	readonly #query: string;
	#bindings: unknown[] = [];

	constructor(database: FakeD1, query: string) {
		this.#database = database;
		this.#query = query;
	}

	bind(...values: unknown[]): FakeStatement {
		this.#bindings = values;
		return this;
	}

	run(): Promise<D1Result<unknown>> {
		return Promise.resolve(this.execute());
	}

	async first<T>(): Promise<T | null> {
		assert.equal(this.#query, "SELECT schema_version FROM platform_meta WHERE id = 1");
		this.#database.markerReads += 1;
		return { schema_version: this.#database.schemaVersion } as T;
	}

	execute(): D1Result<unknown> {
		return this.#database.execute(this.#query, this.#bindings);
	}
}

function emptyRow(updatedAt: string): UsageRow {
	return {
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
		updatedAt,
	};
}

function d1Result(changes: number): D1Result<unknown> {
	return {
		success: true,
		results: [],
		meta: { changes },
	} as unknown as D1Result<unknown>;
}

function modelEnv(database: FakeD1, values: Partial<ModelRouteBindings> = {}): ModelRouteBindings {
	return {
		PLATFORM_DB: database as unknown as D1Database,
		...values,
	};
}

function topicRequest(overrides: Record<string, unknown> = {}, origin = "https://nonstoptalk.test"): Request {
	return new Request(`${origin}/api/v1/models/topics`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: origin,
		},
		body: JSON.stringify({
			roomCode: "ABC234",
			theme: "space travel",
			tier: "routine",
			externalConsent: false,
			...overrides,
		}),
	});
}

function topics(theme = "space travel"): string[] {
	return Array.from({ length: 10 }, (_, index) => `Prompt ${index + 1} about ${theme}`);
}

function offlineDescription(tier: TopicModelTier): TopicProviderDescription {
	return { tier, provider: "offline", model: null, remote: false, configured: true };
}

function remoteDescription(tier: TopicModelTier): TopicProviderDescription {
	return {
		tier,
		provider: tier === "routine" ? "glm" : "gemma31",
		model: tier === "routine" ? "glm-4.7-flash" : "gemma-4-31b-it",
		remote: true,
		configured: true,
	};
}

function generatedResult(tier: TopicModelTier, theme = "space travel"): TopicGenerationResult {
	return {
		topics: topics(theme),
		tier,
		provider: tier === "routine" ? "glm" : "gemma31",
		model: tier === "routine" ? "glm-4.7-flash" : "gemma-4-31b-it",
		usage: {
			inputTokens: 31,
			outputTokens: 79,
			totalTokens: 123,
			cachedInputTokens: 11,
			reasoningTokens: 13,
		},
		requestId: "provider-request",
	};
}

function routeDeps(overrides: Partial<ModelRouteDependencies> = {}): ModelRouteDependencies {
	return {
		authorizeHost: async () => {},
		describeProvider: (_env, tier) => offlineDescription(tier),
		generateTopics: async (_env, input) => ({
			topics: topics(input.theme),
			tier: input.tier,
			provider: "offline",
			model: null,
			usage: null,
			requestId: input.requestId,
		}),
		offline: (theme) => topics(theme),
		now: () => new Date("2026-08-31T12:00:00.000Z"),
		...overrides,
	};
}

async function payload(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

test("offline is the zero-external default and does not reserve model budget", async () => {
	const database = new FakeD1();
	let generated = 0;
	let authorized: [string, string] | null = null;
	const handled = await handleModelRoute(
		topicRequest(),
		modelEnv(database),
		"browser-token-canary",
		"request-1",
		routeDeps({
			authorizeHost: async (roomCode, browserToken) => {
				authorized = [roomCode, browserToken];
				return { topicGeneration: 7 };
			},
			generateTopics: async (_env, input) => {
				generated += 1;
				return {
					topics: topics(input.theme), tier: input.tier, provider: "offline", model: null,
					usage: null, requestId: input.requestId,
				};
			},
		}),
	);
	assert(handled);
	assert.equal(handled.response.status, 200);
	assert.deepEqual(authorized, ["ABC234", "browser-token-canary"]);
	assert.equal(generated, 1);
	assert.equal(database.global.size, 0);
	const body = await payload(handled.response);
	assert.equal(body.provider, "offline");
	assert.equal(body.external, false);
	assert.equal(body.externalProvider, null);
	assert.equal(body.topicGeneration, 7);
	assert.equal(handled.response.headers.get("Cache-Control"), "no-store");
	assert.equal(database.markerReads, 0, "offline generation must not consume D1 readiness reads");
});

test("a selected external provider requires provider-aware consent before reservation", async () => {
	const database = new FakeD1();
	let calls = 0;
	const handled = await handleModelRoute(
		topicRequest(),
		modelEnv(database),
		"token",
		"request-2",
		routeDeps({
			describeProvider: (_env, tier) => remoteDescription(tier),
			generateTopics: async (_env, input) => { calls += 1; return generatedResult(input.tier); },
		}),
	);
	assert(handled);
	assert.equal(handled.response.status, 428);
	assert.equal(calls, 0);
	assert.equal(database.global.size, 0);
	const body = await payload(handled.response);
	assert.equal((body.error as { code: string }).code, "EXTERNAL_CONSENT_REQUIRED");
});

test("an unsupported schema blocks remote reservation and provider delivery", async () => {
	const database = new FakeD1(7);
	let calls = 0;
	const handled = await handleModelRoute(
		topicRequest({ externalConsent: true }),
		modelEnv(database),
		"token",
		"request-unsupported-schema",
		routeDeps({
			describeProvider: (_env, tier) => remoteDescription(tier),
			generateTopics: async (_env, input) => {
				calls += 1;
				return generatedResult(input.tier);
			},
		}),
	);
	assert(handled);
	assert.equal(handled.response.status, 200);
	assert.equal(calls, 0);
	assert.equal(database.markerReads, 1);
	assert.equal(database.global.size, 0);
	assert.equal(database.providers.size, 0);
	assert.equal(database.bindingLog.length, 0);
	const body = await payload(handled.response);
	assert.equal(body.provider, "offline");
	assert.equal(body.fallbackCode, "MODEL_BUDGET_UNAVAILABLE");
});

test("an in-flight schema transition blocks success and failure reconciliation", async (t) => {
	for (const outcome of ["success", "failure"] as const) {
		await t.test(outcome, async () => {
			const database = new FakeD1(5);
			const handled = await handleModelRoute(
				topicRequest({ externalConsent: true }),
				modelEnv(database),
				"token",
				`request-transition-${outcome}`,
				routeDeps({
					describeProvider: (_env, tier) => remoteDescription(tier),
					generateTopics: async (_env, input) => {
						database.schemaVersion = 7;
						if (outcome === "failure") throw new Error("provider unavailable");
						return generatedResult(input.tier);
					},
				}),
			);
			assert(handled);
			assert.equal(handled.response.status, 200);
			assert.equal(database.markerReads, 2);
			assert.equal(database.bindingLog.length, 1, "only the admitted reservation may execute");
			const daily = database.global.get("2026-08-31");
			assert.equal(daily?.reservedCalls, 1);
			assert.equal(daily?.completedCalls, 0);
			assert.equal(database.providers.size, 0);
		});
	}
});

test("Workers AI GLM 5.3 is accepted for consent disclosure, normalized output, and telemetry", async () => {
	const database = new FakeD1();
	const description: TopicProviderDescription = {
		tier: "routine",
		provider: "glm53",
		model: "glm-5.3-flash",
		remote: true,
		configured: true,
	};
	const withoutConsent = await handleModelRoute(
		topicRequest(),
		modelEnv(database),
		"token",
		"request-glm53-consent",
		routeDeps({ describeProvider: () => description }),
	);
	assert(withoutConsent);
	assert.equal(withoutConsent.response.status, 428);
	assert.match(await withoutConsent.response.text(), /Cloudflare Workers AI \(GLM 5\.3 Flash\)/u);
	assert.equal(database.global.size, 0);

	const withConsent = await handleModelRoute(
		topicRequest({ externalConsent: true }),
		modelEnv(database),
		"token",
		"request-glm53-success",
		routeDeps({
			describeProvider: () => description,
			generateTopics: async (_env, input) => ({
				topics: topics(input.theme),
				tier: input.tier,
				provider: "glm53",
				model: "glm-5.3-flash",
				usage: {
					inputTokens: 29,
					outputTokens: 71,
					totalTokens: 110,
					cachedInputTokens: 7,
					reasoningTokens: 10,
				},
				requestId: input.requestId,
			}),
		}),
	);
	assert(withConsent);
	assert.equal(withConsent.response.status, 200);
	const body = await payload(withConsent.response);
	assert.equal(body.provider, "glm53");
	assert.equal(body.model, "glm-5.3-flash");
	assert.equal(body.externalProvider, "glm53");
	assert.equal(body.externalModel, "glm-5.3-flash");
	const provider = database.providers.get("2026-08-31:glm53:glm-5.3-flash:topics");
	assert.equal(provider?.completedCalls, 1);
	assert.equal(provider?.inputTokens, 29);
	assert.equal(provider?.outputTokens, 71);
	assert.equal(provider?.cachedInputTokens, 7);
	assert.equal(provider?.reasoningTokens, 10);
});

test("a remote selector with missing credentials falls back without consent or budget", async () => {
	const database = new FakeD1();
	let calls = 0;
	const handled = await handleModelRoute(
		topicRequest(),
		modelEnv(database),
		"token",
		"request-2b",
		routeDeps({
			describeProvider: (_env, tier) => ({ ...remoteDescription(tier), configured: false }),
			generateTopics: async (_env, input) => { calls += 1; return generatedResult(input.tier); },
		}),
	);
	assert(handled);
	assert.equal(handled.response.status, 200);
	assert.equal(calls, 0);
	assert.equal(database.global.size, 0);
	const body = await payload(handled.response);
	assert.equal(body.provider, "offline");
	assert.equal(body.external, false);
	assert.equal(body.fallbackCode, "MODEL_PROVIDER_UNAVAILABLE");
});

test("an invalid provider selector fails closed without exposing configuration", async () => {
	const database = new FakeD1();
	const deps = routeDeps();
	delete deps.describeProvider;
	let calls = 0;
	deps.generateTopics = async (_env, input) => { calls += 1; return generatedResult(input.tier); };
	const handled = await handleModelRoute(
		topicRequest({ externalConsent: true }),
		modelEnv(database, { TOPIC_ROUTINE_PROVIDER: "private-invalid-selector" }),
		"token",
		"request-2c",
		deps,
	);
	assert(handled);
	assert.equal(handled.response.status, 200);
	assert.equal(calls, 0);
	assert.equal(database.global.size, 0);
	const text = await handled.response.text();
	assert.equal(text.includes("private-invalid-selector"), false);
	const body = JSON.parse(text) as Record<string, unknown>;
	assert.equal(body.provider, "offline");
	assert.equal(body.external, false);
	assert.equal(body.fallbackCode, "MODEL_CONFIGURATION_FALLBACK");
});

test("room authorization runs before provider selection and sanitizes callback errors", async () => {
	const database = new FakeD1();
	let described = 0;
	const handled = await handleModelRoute(
		topicRequest({ externalConsent: true }),
		modelEnv(database),
		"token",
		"request-3",
		routeDeps({
			authorizeHost: async () => { throw new Error("private room details and secret-canary"); },
			describeProvider: (_env, tier) => { described += 1; return remoteDescription(tier); },
		}),
	);
	assert(handled);
	assert.equal(handled.response.status, 403);
	assert.equal(described, 0);
	assert.equal(database.global.size, 0);
	const text = await handled.response.text();
	assert.equal(text.includes("secret-canary"), false);
	assert.equal(text.includes("private room"), false);
});

test("room authorization preserves safe phase-conflict and outage semantics", async () => {
	assert.equal(modelAuthorizationErrorForStatus(404).status, 403);
	assert.equal(modelAuthorizationErrorForStatus(403).status, 403);
	assert.equal(modelAuthorizationErrorForStatus(409).status, 409);
	assert.equal(modelAuthorizationErrorForStatus(500).status, 503);
	assert.equal(modelAuthorizationErrorForStatus(524).status, 503);

	for (const expectation of [
		{ status: 409, code: "ROOM_PHASE_CONFLICT" },
		{ status: 503, code: "ROOM_AUTHORIZATION_UNAVAILABLE" },
	] as const) {
		let described = 0;
		const handled = await handleModelRoute(
			topicRequest({ externalConsent: true }),
			modelEnv(new FakeD1()),
			"token",
			`request-auth-${expectation.status}`,
			routeDeps({
				authorizeHost: async () => {
					throw modelAuthorizationErrorForStatus(expectation.status);
				},
				describeProvider: (_env, tier) => {
					described += 1;
					return remoteDescription(tier);
				},
			}),
		);
		assert(handled);
		assert.equal(handled.response.status, expectation.status);
		assert.equal(described, 0);
		const body = await payload(handled.response);
		assert.equal((body.error as { code: string }).code, expectation.code);
		assert.equal(JSON.stringify(body).includes("Durable Object"), false);
	}

	const invalidAuthorization = await handleModelRoute(
		topicRequest(),
		modelEnv(new FakeD1()),
		"token",
		"request-auth-invalid",
		routeDeps({
			authorizeHost: async () => ({ topicGeneration: 0 }),
		}),
	);
	assert(invalidAuthorization);
	assert.equal(invalidAuthorization.response.status, 503);
	assert.equal(
		((await payload(invalidAuthorization.response)).error as { code: string }).code,
		"ROOM_AUTHORIZATION_UNAVAILABLE",
	);
});

test("the atomic daily cap prevents a second external call and falls back offline", async () => {
	const database = new FakeD1();
	let calls = 0;
	const deps = routeDeps({
		describeProvider: (_env, tier) => remoteDescription(tier),
		generateTopics: async (_env, input) => {
			calls += 1;
			return generatedResult(input.tier, input.theme);
		},
	});
	const env = modelEnv(database, { MODEL_DAILY_CALL_LIMIT: "1" });
	const first = await handleModelRoute(
		topicRequest({ externalConsent: true }), env, "token", "request-4a", deps,
	);
	const second = await handleModelRoute(
		topicRequest({ externalConsent: true, theme: "second theme" }), env, "token", "request-4b", deps,
	);
	assert(first && second);
	assert.equal(first.response.status, 200);
	assert.equal(second.response.status, 200);
	assert.equal(calls, 1);
	assert.equal((await payload(first.response)).external, true);
	assert.equal((await payload(second.response)).fallbackCode, "MODEL_DAILY_LIMIT_REACHED");
	const daily = database.global.get("2026-08-31");
	assert.equal(daily?.reservedCalls, 1);
	assert.equal(daily?.completedCalls, 1);
	assert.equal(daily?.successCount, 1);
	assert.equal(daily?.inputTokens, 31);
	assert.equal(daily?.outputTokens, 79);
	assert.equal(daily?.totalTokens, 123);
	assert.equal(daily?.cachedInputTokens, 11);
	assert.equal(daily?.reasoningTokens, 13);
	const provider = database.providers.get("2026-08-31:glm:glm-4.7-flash:topics");
	assert.equal(provider?.reservedCalls, 0);
	assert.equal(provider?.completedCalls, 1);
	assert.equal(provider?.successCount, 1);
	assert.equal(provider?.failureCount, 0);
	assert.equal(provider?.inputTokens, 31);
	assert.equal(provider?.outputTokens, 79);
	assert.equal(provider?.totalTokens, 123);
	assert.equal(provider?.cachedInputTokens, 11);
	assert.equal(provider?.reasoningTokens, 13);
});

test("remote failure uses one deterministic offline fallback and records sanitized aggregate failure", async () => {
	const database = new FakeD1();
	let remoteCalls = 0;
	let offlineCalls = 0;
	const handled = await handleModelRoute(
		topicRequest({ externalConsent: true, theme: "transcript-like-sensitive-canary" }),
		modelEnv(database),
		"private-browser-token",
		"request-5",
		routeDeps({
			describeProvider: (_env, tier) => remoteDescription(tier),
			generateTopics: async () => {
				remoteCalls += 1;
				throw new TopicModelError(
					"INVALID_RESPONSE",
					"vendor failure containing API-key-secret-canary",
					{
						provider: "glm",
						usage: {
							inputTokens: 17,
							outputTokens: 23,
							totalTokens: 45,
							cachedInputTokens: 5,
							reasoningTokens: 5,
						},
					},
				);
			},
			offline: (theme) => { offlineCalls += 1; return topics(theme); },
		}),
	);
	assert(handled);
	assert.equal(handled.response.status, 200);
	assert.equal(remoteCalls, 1);
	assert.equal(offlineCalls, 1);
	const text = await handled.response.text();
	assert.equal(text.includes("API-key-secret-canary"), false);
	const body = JSON.parse(text) as Record<string, unknown>;
	assert.equal(body.provider, "offline");
	assert.equal(body.external, true);
	assert.equal(body.externalProvider, "glm");
	assert.equal(body.externalModel, "glm-4.7-flash");
	assert.equal(body.fallbackCode, "REMOTE_PROVIDER_FALLBACK");
	const daily = database.global.get("2026-08-31");
	assert.equal(daily?.reservedCalls, 1);
	assert.equal(daily?.failureCount, 1);
	assert.equal(daily?.successCount, 0);
	assert.equal(daily?.inputTokens, 17);
	assert.equal(daily?.outputTokens, 23);
	assert.equal(daily?.totalTokens, 45);
	assert.equal(daily?.cachedInputTokens, 5);
	assert.equal(daily?.reasoningTokens, 5);
	const provider = database.providers.get("2026-08-31:glm:glm-4.7-flash:topics");
	assert.equal(provider?.reservedCalls, 0);
	assert.equal(provider?.completedCalls, 1);
	assert.equal(provider?.successCount, 0);
	assert.equal(provider?.failureCount, 1);
	assert.equal(provider?.inputTokens, 17);
	assert.equal(provider?.outputTokens, 23);
	assert.equal(provider?.totalTokens, 45);
	assert.equal(provider?.cachedInputTokens, 5);
	assert.equal(provider?.reasoningTokens, 5);
	const persistedBindings = JSON.stringify(database.bindingLog);
	assert.equal(persistedBindings.includes("transcript-like-sensitive-canary"), false);
	assert.equal(persistedBindings.includes("private-browser-token"), false);
	assert.equal(persistedBindings.includes("API-key-secret-canary"), false);
});

test("strict request validation rejects extra fields and requires exact same origin", async () => {
	const database = new FakeD1();
	let authorized = 0;
	const deps = routeDeps({ authorizeHost: async () => { authorized += 1; } });
	const extra = await handleModelRoute(
		topicRequest({ transcript: "must not be accepted" }),
		modelEnv(database),
		"token",
		"request-6a",
		deps,
	);
	assert(extra);
	assert.equal(extra.response.status, 400);
	assert.equal((await payload(extra.response)).requestId, "request-6a");

	const missingOrigin = new Request("https://nonstoptalk.test/api/v1/models/topics", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ roomCode: "ABC234", theme: "space", tier: "routine", externalConsent: false }),
	});
	const origin = await handleModelRoute(
		missingOrigin, modelEnv(database), "token", "request-6b", deps,
	);
	assert(origin);
	assert.equal(origin.response.status, 403);
	assert.equal(authorized, 0);
	assert.equal(database.global.size, 0);
});

test("theme validation accepts 200 Unicode characters and rejects the next character", async () => {
	const database = new FakeD1();
	const deps = routeDeps({
		generateTopics: async (_env, input) => ({
			topics: topics("bounded theme"),
			tier: input.tier,
			provider: "offline",
			model: null,
			usage: null,
			requestId: input.requestId,
		}),
	});
	const accepted = await handleModelRoute(
		topicRequest({ theme: "🌍".repeat(200) }),
		modelEnv(database),
		"token",
		"request-6c",
		deps,
	);
	assert(accepted);
	assert.equal(accepted.response.status, 200);

	const rejected = await handleModelRoute(
		topicRequest({ theme: "a".repeat(201) }),
		modelEnv(database),
		"token",
		"request-6d",
		deps,
	);
	assert(rejected);
	assert.equal(rejected.response.status, 400);

	const multiline = await handleModelRoute(
		topicRequest({ theme: "first line\nsecond line" }),
		modelEnv(database),
		"token",
		"request-6e",
		deps,
	);
	assert(multiline);
	assert.equal(multiline.response.status, 400);
});

test("budget storage failure is fail-closed and never reaches the external provider", async () => {
	const database = new FakeD1();
	database.failReservation = true;
	let calls = 0;
	const handled = await handleModelRoute(
		topicRequest({ externalConsent: true }),
		modelEnv(database),
		"token",
		"request-7",
		routeDeps({
			describeProvider: (_env, tier) => remoteDescription(tier),
			generateTopics: async (_env, input) => { calls += 1; return generatedResult(input.tier); },
		}),
	);
	assert(handled);
	assert.equal(handled.response.status, 200);
	assert.equal(calls, 0);
	const text = await handled.response.text();
	assert.equal(text.includes("secret-canary"), false);
	assert.equal((JSON.parse(text) as Record<string, unknown>).fallbackCode, "MODEL_BUDGET_UNAVAILABLE");
});

test("unrelated routes are left to the existing platform and room routers", async () => {
	const handled = await handleModelRoute(
		new Request("https://nonstoptalk.test/api/v1/platform/status"),
		modelEnv(new FakeD1()),
		"token",
		"request-8",
		routeDeps(),
	);
	assert.equal(handled, null);
});
