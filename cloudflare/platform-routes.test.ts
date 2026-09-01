import assert from "node:assert/strict";
import test from "node:test";

import { handlePlatformRoute } from "./platform-routes.ts";

interface ModelUsageTestRow {
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

class FakeModelUsageD1 {
	readonly queries: string[] = [];
	readonly bindings: unknown[][] = [];
	readonly rows: ModelUsageTestRow[];

	constructor(rows: ModelUsageTestRow[]) {
		this.rows = rows;
	}

	prepare(query: string): D1PreparedStatement {
		this.queries.push(query);
		return new FakeModelUsageStatement(this, query) as unknown as D1PreparedStatement;
	}
}

class FakeModelUsageStatement {
	readonly #database: FakeModelUsageD1;
	readonly #query: string;
	#bindings: unknown[] = [];

	constructor(database: FakeModelUsageD1, query: string) {
		this.#database = database;
		this.#query = query;
	}

	bind(...values: unknown[]): FakeModelUsageStatement {
		this.#bindings = values;
		this.#database.bindings.push(values);
		return this;
	}

	async first<T>(): Promise<T | null> {
		assert.match(this.#query, /SELECT schema_version FROM platform_meta/u);
		return { schema_version: 4 } as T;
	}

	async all<T>(): Promise<D1Result<T>> {
		assert.match(this.#query, /FROM model_usage_daily/u);
		return {
			success: true,
			results: this.#database.rows as T[],
			meta: {},
		} as unknown as D1Result<T>;
	}
}

class FakeStatusD1 {
	constructor(readonly schemaVersion: number) {}

	prepare(query: string): D1PreparedStatement {
		assert.match(query, /SELECT schema_version FROM platform_meta/u);
		return new FakeStatusStatement(this.schemaVersion) as unknown as D1PreparedStatement;
	}
}

class FakeStatusStatement {
	constructor(readonly schemaVersion: number) {}

	async first<T>(): Promise<T | null> {
		return { schema_version: this.schemaVersion } as T;
	}
}

function usageRow(overrides: Partial<ModelUsageTestRow> = {}): ModelUsageTestRow {
	return {
		day: "2026-08-31",
		scope: "global",
		provider: "all",
		model: "all",
		task: "all",
		reservedCalls: 2,
		completedCalls: 1,
		successCount: 1,
		failureCount: 0,
		inputTokens: 10,
		outputTokens: 20,
		totalTokens: 35,
		cachedInputTokens: 4,
		reasoningTokens: 5,
		latencyMsTotal: 100,
		updatedAt: "2026-08-31T12:00:00.000Z",
		...overrides,
	};
}

test("platform status requires and reports the schema-v4 identity foundation", async () => {
	const handled = await handlePlatformRoute(
		new Request("https://nonstoptalk.test/api/v1/platform/status"),
		{
			PLATFORM_DB: new FakeStatusD1(4) as unknown as D1Database,
			ANALYTICS_ADMIN_TOKEN: "1".repeat(64),
			ROOM_FACT_HASH_KEY: "2".repeat(64),
		},
		"3".repeat(64),
		"status-schema-4",
	);

	assert(handled);
	assert.equal(handled.response.status, 200);
	const body = await handled.response.json() as { status: string; schemaVersion: number };
	assert.equal(body.status, "ok");
	assert.equal(body.schemaVersion, 4);
});

test("platform status rejects schema markers outside the reviewed compatibility window", async () => {
	for (const schemaVersion of [2, 3, 5]) {
		const handled = await handlePlatformRoute(
			new Request("https://nonstoptalk.test/api/v1/platform/status"),
			{ PLATFORM_DB: new FakeStatusD1(schemaVersion) as unknown as D1Database },
			"4".repeat(64),
			`unsupported-schema-${schemaVersion}`,
		);

		assert(handled);
		assert.equal(handled.response.status, 503);
		assert.equal(handled.response.headers.get("Retry-After"), "30");
		const body = await handled.response.json() as { error: { code: string } };
		assert.equal(body.error.code, "DATABASE_UNAVAILABLE");
	}
});

test("admin model usage reports complete global token totals without double-counting provider rows", async () => {
	const database = new FakeModelUsageD1([
		usageRow(),
		usageRow({
			day: "2026-08-30",
			reservedCalls: 3,
			completedCalls: 3,
			successCount: 2,
			failureCount: 1,
			inputTokens: 30,
			outputTokens: 40,
			totalTokens: 80,
			cachedInputTokens: 6,
			reasoningTokens: 10,
			latencyMsTotal: 200,
		}),
		usageRow({
			scope: "provider",
			provider: "glm",
			model: "glm-4.7-flash",
			task: "topics",
			reservedCalls: 0,
			inputTokens: 999,
			outputTokens: 999,
			totalTokens: 999,
			cachedInputTokens: 999,
			reasoningTokens: 999,
		}),
	]);
	const adminToken = "admin-test-token-long-enough-123456";
	const handled = await handlePlatformRoute(
		new Request("https://nonstoptalk.test/api/v1/admin/model-usage?days=2", {
			headers: { Authorization: `Bearer ${adminToken}` },
		}),
		{
			PLATFORM_DB: database as unknown as D1Database,
			ANALYTICS_ADMIN_TOKEN: adminToken,
		},
		"private-browser-token-must-not-appear",
		"model-usage-request",
	);

	assert(handled);
	assert.equal(handled.response.status, 200);
	const body = await handled.response.json() as Record<string, unknown>;
	assert.deepEqual(body.totals, {
		reservedCalls: 5,
		completedCalls: 4,
		successCount: 3,
		failureCount: 1,
		inputTokens: 40,
		outputTokens: 60,
		totalTokens: 115,
		cachedInputTokens: 10,
		reasoningTokens: 15,
		latencyMsTotal: 300,
	});
	assert.equal((body.daily as unknown[]).length, 3);
	assert.equal((body.window as { days: number }).days, 2);
	assert.match(String(body.privacy), /Aggregate model operations only/u);
	const serialized = JSON.stringify(body);
	assert.equal(serialized.includes(adminToken), false);
	assert.equal(serialized.includes("private-browser-token-must-not-appear"), false);
	assert.equal(database.bindings.length, 1);
	assert.equal(database.bindings[0]?.length, 2);
	assert.match(database.queries.at(-1) ?? "", /total_tokens AS totalTokens/u);
	assert.match(database.queries.at(-1) ?? "", /cached_input_tokens AS cachedInputTokens/u);
	assert.match(database.queries.at(-1) ?? "", /reasoning_tokens AS reasoningTokens/u);
});
