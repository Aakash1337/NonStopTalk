import assert from "node:assert/strict";
import test from "node:test";

import {
	RETENTION_CLEANUP_STALE_MS,
	classifyRetentionCleanupStatus,
	handlePlatformRoute,
	runPlatformCleanup,
} from "./platform-routes.ts";
import { recordCleanupHeartbeat } from "./platform.ts";

const noDeferredTasks = (task: Promise<void>): void => {
	void task.catch(() => undefined);
};

interface Deferred<Value> {
	promise: Promise<Value>;
	resolve(value: Value | PromiseLike<Value>): void;
}

function deferred<Value>(): Deferred<Value> {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	const promise = new Promise<Value>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function coachingSummary(): Record<string, unknown> {
	return {
		analysisSchemaVersion: 2,
		id: "attempt-2026-09-01-1",
		createdAt: "2026-09-01T10:15:16.000Z",
		scenario: "interview",
		goal: "pauses",
		targetDurationMs: 45_000,
		metrics: {
			durationMs: 44_500,
			voicedMs: 31_000,
			speakingRatio: 0.6966,
			pauseCount: 4,
			observedDurationMs: 44_000,
			unknownMs: 500,
			coverageRatio: 0.9888,
			maxSampleGapMs: 500,
			medianPauseMs: 740,
			longestPauseMs: 1_300,
			longestSpeakingRunMs: 12_500,
			levelConsistencyPct: 82.5,
			clippingPct: 0.25,
			audioConfidence: "high",
			transcriptMetrics: null,
		},
		advice: {
			strength: "Usable pause length",
			strengthEvidence: "Four measured pauses separated ideas.",
			focus: "Leave more room between phrases",
			focusEvidence: "The longest speaking run was 12.5 seconds.",
			drill: "Retry with one change.",
			drillDetail: "Take one breath between complete ideas.",
		},
	};
}

function progressRequest(method: "POST" | "DELETE"): Request {
	return new Request("https://nonstoptalk.test/api/v1/progress/sessions", {
		method,
		headers: {
			Origin: "https://nonstoptalk.test",
			...(method === "POST" ? { "Content-Type": "application/json" } : {}),
		},
		...(method === "POST" ? { body: JSON.stringify({ session: coachingSummary() }) } : {}),
	});
}

function fakeResult(changes = 0): D1Result<unknown> {
	return {
		success: true,
		results: [],
		meta: { changes },
	} as unknown as D1Result<unknown>;
}

interface FakeProgressOptions {
	created?: boolean;
	consentChanged?: boolean;
	deletedCount?: number;
	consentRevoked?: boolean;
	failAnalytics?: boolean;
}

class FakeProgressD1 {
	readonly analyticsStarted = deferred<void>();
	readonly analyticsRelease = deferred<void>();
	readonly analyticsBindings: unknown[][] = [];
	readonly options: FakeProgressOptions;

	constructor(options: FakeProgressOptions) {
		this.options = options;
	}

	prepare(query: string): D1PreparedStatement {
		return new FakeProgressStatement(this, query) as unknown as D1PreparedStatement;
	}

	async batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
		return statements.map((statement) => {
			const query = (statement as unknown as FakeProgressStatement).query;
			if (/INSERT OR IGNORE INTO consent_records/u.test(query)) {
				return fakeResult(this.options.consentChanged ? 1 : 0);
			}
			if (/UPDATE consent_records/u.test(query)) {
				return fakeResult(this.options.consentChanged || this.options.consentRevoked ? 1 : 0);
			}
			if (/INSERT INTO coaching_sessions/u.test(query)) {
				return fakeResult(this.options.created ? 1 : 0);
			}
			if (/DELETE FROM coaching_sessions/u.test(query)) {
				return fakeResult(this.options.deletedCount ?? 0);
			}
			return fakeResult();
		});
	}
}

class FakeProgressStatement {
	readonly database: FakeProgressD1;
	readonly query: string;

	constructor(database: FakeProgressD1, query: string) {
		this.database = database;
		this.query = query;
	}

	bind(...values: unknown[]): FakeProgressStatement {
		if (/INSERT INTO analytics_daily/u.test(this.query)) {
			this.database.analyticsBindings.push(values);
		}
		return this;
	}

	async run<T>(): Promise<D1Result<T>> {
		if (/INSERT INTO analytics_daily/u.test(this.query)) {
			this.database.analyticsStarted.resolve();
			if (this.database.options.failAnalytics) throw new Error("analytics D1 unavailable");
			await this.database.analyticsRelease.promise;
		}
		return fakeResult(1) as D1Result<T>;
	}

	async first<T>(): Promise<T | null> {
		if (/SELECT 1 AS found FROM devices/u.test(this.query)) return { found: 1 } as T;
		if (/FROM coaching_sessions/u.test(this.query)) {
			return { summary_json: JSON.stringify(coachingSummary()) } as T;
		}
		if (/SELECT \* FROM analytics_daily/u.test(this.query)) {
			return {
				day: "2026-09-01",
				metric: "coaching_summary_saved",
				event_count: 1,
				value_sum: 44_500,
				value_min: 44_500,
				value_max: 44_500,
				updated_at: "2026-09-01T10:15:16.000Z",
			} as T;
		}
		throw new Error(`Unexpected first query: ${this.query}`);
	}
}

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
		return { schema_version: 5 } as T;
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
	readonly schemaVersion: number;
	readonly heartbeat: { scheduledAt: string | null; completedAt: string | null; backlog: boolean };

	constructor(
		schemaVersion: number,
		heartbeat?: { scheduledAt: string | null; completedAt: string | null; backlog: boolean },
	) {
		this.schemaVersion = schemaVersion;
		const currentTimestamp = new Date().toISOString();
		this.heartbeat = heartbeat ?? {
			scheduledAt: currentTimestamp,
			completedAt: currentTimestamp,
			backlog: false,
		};
	}

	prepare(query: string): D1PreparedStatement {
		return new FakeStatusStatement(this, query) as unknown as D1PreparedStatement;
	}
}

class FakeStatusStatement {
	readonly database: FakeStatusD1;
	readonly query: string;

	constructor(database: FakeStatusD1, query: string) {
		this.database = database;
		this.query = query;
	}

	async first<T>(): Promise<T | null> {
		if (/SELECT schema_version FROM platform_meta/u.test(this.query)) {
			return { schema_version: this.database.schemaVersion } as T;
		}
		if (/FROM platform_maintenance WHERE id = 1/u.test(this.query)) {
			return {
				cleanup_scheduled_at: this.database.heartbeat.scheduledAt,
				cleanup_completed_at: this.database.heartbeat.completedAt,
				cleanup_backlog: this.database.heartbeat.backlog ? 1 : 0,
			} as T;
		}
		throw new Error(`Unexpected status query: ${this.query}`);
	}
}

class FakeCleanupD1 {
	readonly failCleanup: boolean;
	readonly cleanupChanges: number;
	readonly backlogAfterBudget: boolean;
	readonly failBacklogCheck: boolean;
	readonly failHeartbeat: boolean;
	cleanupBatches = 0;
	backlogChecks = 0;
	heartbeatAttempts = 0;
	heartbeatWrites = 0;
	heartbeatBindings: unknown[] = [];
	heartbeatQuery = "";

	constructor({
		failCleanup = false,
		cleanupChanges = 0,
		backlogAfterBudget = true,
		failBacklogCheck = false,
		failHeartbeat = false,
	}: {
		failCleanup?: boolean;
		cleanupChanges?: number;
		backlogAfterBudget?: boolean;
		failBacklogCheck?: boolean;
		failHeartbeat?: boolean;
	} = {}) {
		this.failCleanup = failCleanup;
		this.cleanupChanges = cleanupChanges;
		this.backlogAfterBudget = backlogAfterBudget;
		this.failBacklogCheck = failBacklogCheck;
		this.failHeartbeat = failHeartbeat;
	}

	prepare(query: string): D1PreparedStatement {
		return new FakeCleanupStatement(this, query) as unknown as D1PreparedStatement;
	}

	async batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
		this.cleanupBatches += 1;
		if (this.failCleanup) throw new Error("cleanup unavailable");
		return statements.map(() => fakeResult(this.cleanupChanges));
	}
}

class FakeCleanupStatement {
	readonly database: FakeCleanupD1;
	readonly query: string;
	bindings: unknown[] = [];

	constructor(database: FakeCleanupD1, query: string) {
		this.database = database;
		this.query = query;
	}

	bind(...values: unknown[]): FakeCleanupStatement {
		this.bindings = values;
		return this;
	}

	async run<T>(): Promise<D1Result<T>> {
		assert.match(this.query, /INSERT INTO platform_maintenance/u);
		assert.match(this.query, /strftime\('%Y-%m-%dT%H:%M:%fZ'/u);
		assert.match(this.query, /excluded\.cleanup_scheduled_at >= platform_maintenance\.cleanup_scheduled_at/u);
		assert.match(this.query, /platform_maintenance\.cleanup_backlog = 0/u);
		this.database.heartbeatAttempts += 1;
		this.database.heartbeatQuery = this.query;
		if (this.database.failHeartbeat) throw new Error("heartbeat unavailable");
		const currentScheduledAt = this.database.heartbeatBindings[0];
		const currentCompletedAt = this.database.heartbeatBindings[1];
		const nextScheduledAt = this.bindings[0];
		const nextCompletedAt = this.bindings[1];
		const canonicalTimestamp = (value: unknown): value is string => {
			if (typeof value !== "string") return false;
			const parsed = Date.parse(value);
			return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
		};
		const currentScheduleIsCanonical = canonicalTimestamp(currentScheduledAt);
		const currentIsCanonical = currentScheduleIsCanonical && canonicalTimestamp(currentCompletedAt);
		if (
			canonicalTimestamp(nextScheduledAt)
			&& canonicalTimestamp(nextCompletedAt)
			&& (
				!currentScheduleIsCanonical
				|| nextScheduledAt >= currentScheduledAt
			)
		) {
			this.database.heartbeatWrites += 1;
			if (currentIsCanonical && nextScheduledAt === currentScheduledAt) {
				this.database.heartbeatBindings = [
					nextScheduledAt,
					nextCompletedAt >= currentCompletedAt ? nextCompletedAt : currentCompletedAt,
					currentScheduledAt === nextScheduledAt
						&& (this.database.heartbeatBindings[2] === 0 || this.bindings[2] === 0)
						? 0
						: this.bindings[2],
				];
			} else {
				this.database.heartbeatBindings = this.bindings;
			}
			return fakeResult(1) as D1Result<T>;
		}
		return fakeResult(0) as D1Result<T>;
	}

	async first<T>(): Promise<T | null> {
		assert.match(this.query, /AS has_more/u);
		this.database.backlogChecks += 1;
		if (this.database.failBacklogCheck) throw new Error("backlog check unavailable");
		return { has_more: this.database.backlogAfterBudget ? 1 : 0 } as T;
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

test("platform status reports the cleanup-heartbeat schema", async () => {
	for (const schemaVersion of [5]) {
		const handled = await handlePlatformRoute(
			new Request("https://nonstoptalk.test/api/v1/platform/status"),
			{
				PLATFORM_DB: new FakeStatusD1(schemaVersion) as unknown as D1Database,
				ANALYTICS_ADMIN_TOKEN: "1".repeat(64),
				ROOM_FACT_HASH_KEY: "2".repeat(64),
			},
			"3".repeat(64),
			`status-schema-${schemaVersion}`,
			noDeferredTasks,
		);

		assert(handled);
		assert.equal(handled.response.status, 200);
		const body = await handled.response.json() as { status: string; schemaVersion: number };
		assert.equal(body.status, "ok");
		assert.equal(body.schemaVersion, schemaVersion);
	}
});

test("platform status rejects schema markers outside its exact feature schema", async () => {
	for (const schemaVersion of [2, 3, 4, 6]) {
		const handled = await handlePlatformRoute(
			new Request("https://nonstoptalk.test/api/v1/platform/status"),
			{ PLATFORM_DB: new FakeStatusD1(schemaVersion) as unknown as D1Database },
			"4".repeat(64),
			`unsupported-schema-${schemaVersion}`,
			noDeferredTasks,
		);

		assert(handled);
		assert.equal(handled.response.status, 503);
		assert.equal(handled.response.headers.get("Retry-After"), "30");
		const body = await handled.response.json() as { error: { code: string } };
		assert.equal(body.error.code, "DATABASE_UNAVAILABLE");
	}
});

test("cleanup heartbeat classification covers never, current, stale, backlog, and clock corruption", () => {
	const now = new Date("2026-09-01T12:00:00.000Z");
	assert.equal(classifyRetentionCleanupStatus({ scheduledAt: null, completedAt: null, backlog: false }, now), "stale");
	assert.equal(classifyRetentionCleanupStatus({
		scheduledAt: "2026-09-01T11:59:00.000Z",
		completedAt: "2026-09-01T11:59:00.000Z",
		backlog: false,
	}, now), "ready");
	assert.equal(classifyRetentionCleanupStatus({
		scheduledAt: "2026-09-01T11:59:00.000Z",
		completedAt: "2026-09-01T11:59:00.000Z",
		backlog: true,
	}, now), "backlog");
	assert.equal(classifyRetentionCleanupStatus({
		scheduledAt: new Date(now.getTime() - RETENTION_CLEANUP_STALE_MS).toISOString(),
		completedAt: new Date(now.getTime() - RETENTION_CLEANUP_STALE_MS).toISOString(),
		backlog: false,
	}, now), "ready");
	assert.equal(classifyRetentionCleanupStatus({
		scheduledAt: new Date(now.getTime() - RETENTION_CLEANUP_STALE_MS - 1).toISOString(),
		completedAt: new Date(now.getTime() - RETENTION_CLEANUP_STALE_MS - 1).toISOString(),
		backlog: false,
	}, now), "stale");
	assert.equal(classifyRetentionCleanupStatus({
		scheduledAt: "not-a-timestamp",
		completedAt: "not-a-timestamp",
		backlog: false,
	}, now), "stale");
	assert.equal(classifyRetentionCleanupStatus({
		scheduledAt: "2026-09-01T12:06:00.000Z",
		completedAt: "2026-09-01T12:06:00.000Z",
		backlog: false,
	}, now), "stale");
});

test("platform status exposes only cleanup health and degrades for stale or backlogged work", async () => {
	for (const scenario of [
		{
			status: "stale",
			scheduledAt: "2000-01-01T00:00:00.000Z",
			completedAt: "2000-01-01T00:00:00.000Z",
			backlog: false,
		},
		{
			status: "backlog",
			scheduledAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			backlog: true,
		},
	] as const) {
		const handled = await handlePlatformRoute(
			new Request("https://nonstoptalk.test/api/v1/platform/status"),
			{
				PLATFORM_DB: new FakeStatusD1(5, scenario) as unknown as D1Database,
				ANALYTICS_ADMIN_TOKEN: "1".repeat(64),
				ROOM_FACT_HASH_KEY: "2".repeat(64),
			},
			"3".repeat(64),
			`cleanup-${scenario.status}`,
			noDeferredTasks,
		);

		assert(handled);
		assert.equal(handled.response.status, 200);
		const body = await handled.response.json() as {
			status: string;
			degradedCapabilities: string[];
			capabilities: { retentionCleanup: Record<string, unknown> };
		};
		assert.equal(body.status, "degraded");
		assert.deepEqual(body.degradedCapabilities, ["retentionCleanup"]);
		assert.deepEqual(body.capabilities.retentionCleanup, { status: scenario.status });
	}
});

test("cleanup failure never advances the heartbeat", async () => {
	const database = new FakeCleanupD1({ failCleanup: true });
	await assert.rejects(
		runPlatformCleanup({ PLATFORM_DB: database as unknown as D1Database }),
		/clean up expired platform data/u,
	);
	assert.equal(database.cleanupBatches, 1);
	assert.equal(database.heartbeatAttempts, 0);
	assert.equal(database.heartbeatWrites, 0);
});

test("final backlog-probe and heartbeat-write failures cannot advance cleanup health", async () => {
	const failedProbe = new FakeCleanupD1({
		cleanupChanges: 500,
		failBacklogCheck: true,
	});
	await assert.rejects(
		runPlatformCleanup({ PLATFORM_DB: failedProbe as unknown as D1Database }),
		/check for an expired platform-data backlog/u,
	);
	assert.equal(failedProbe.cleanupBatches, 20);
	assert.equal(failedProbe.backlogChecks, 1);
	assert.equal(failedProbe.heartbeatAttempts, 0);

	const failedHeartbeat = new FakeCleanupD1({ failHeartbeat: true });
	await assert.rejects(
		runPlatformCleanup({ PLATFORM_DB: failedHeartbeat as unknown as D1Database }),
		/record the platform cleanup heartbeat/u,
	);
	assert.equal(failedHeartbeat.cleanupBatches, 1);
	assert.equal(failedHeartbeat.heartbeatAttempts, 1);
	assert.equal(failedHeartbeat.heartbeatWrites, 0);
});

test("cleanup records a successful bounded run and its remaining-backlog flag", async () => {
	const completedAt = new Date("2026-09-01T03:17:00.000Z");
	for (const scenario of [
		{ changes: 0, remaining: true, expectedBatches: 1, expectedChecks: 0, expectedBacklog: 0 },
		{ changes: 500, remaining: true, expectedBatches: 20, expectedChecks: 1, expectedBacklog: 1 },
		{ changes: 500, remaining: false, expectedBatches: 20, expectedChecks: 1, expectedBacklog: 0 },
	]) {
		const database = new FakeCleanupD1({
			cleanupChanges: scenario.changes,
			backlogAfterBudget: scenario.remaining,
		});
		await runPlatformCleanup(
			{ PLATFORM_DB: database as unknown as D1Database },
			completedAt,
			() => completedAt,
		);
		assert.equal(database.cleanupBatches, scenario.expectedBatches);
		assert.equal(database.backlogChecks, scenario.expectedChecks);
		assert.equal(database.heartbeatWrites, 1);
		assert.deepEqual(database.heartbeatBindings, [
			completedAt.toISOString(),
			completedAt.toISOString(),
			scenario.expectedBacklog,
		]);
	}
});

test("an older delayed cleanup event cannot regress a newer heartbeat", async () => {
	const database = new FakeCleanupD1();
	const newer = new Date("2026-09-02T03:17:00.000Z");
	const older = new Date("2026-09-01T03:17:00.000Z");
	await runPlatformCleanup(
		{ PLATFORM_DB: database as unknown as D1Database },
		newer,
		() => newer,
	);
	await runPlatformCleanup(
		{ PLATFORM_DB: database as unknown as D1Database },
		older,
		() => newer,
	);
	assert.equal(database.heartbeatAttempts, 2);
	assert.equal(database.heartbeatWrites, 1);
	assert.equal(database.heartbeatBindings[0], newer.toISOString());
});

test("equal-schedule retries merge completion/backlog and repair malformed stored timestamps", async () => {
	const database = new FakeCleanupD1();
	const scheduledAt = new Date("2026-09-02T03:17:00.000Z");
	const earlierCompletion = new Date("2026-09-02T03:18:00.000Z");
	const laterCompletion = new Date("2026-09-02T03:19:00.000Z");
	database.heartbeatBindings = ["z".repeat(24), "z".repeat(24), 1];
	await recordCleanupHeartbeat(
		database as unknown as D1Database,
		scheduledAt,
		laterCompletion,
		true,
	);
	await recordCleanupHeartbeat(
		database as unknown as D1Database,
		scheduledAt,
		earlierCompletion,
		false,
	);
	assert.deepEqual(database.heartbeatBindings, [
		scheduledAt.toISOString(),
		laterCompletion.toISOString(),
		0,
	], "An earlier duplicate must preserve completion while a cleared backlog dominates.");

	const newestCompletion = new Date("2026-09-02T03:20:00.000Z");
	await recordCleanupHeartbeat(
		database as unknown as D1Database,
		scheduledAt,
		newestCompletion,
		true,
	);
	assert.equal(database.heartbeatWrites, 3);
	assert.equal(database.heartbeatBindings[1], newestCompletion.toISOString());
	assert.equal(database.heartbeatBindings[2], 0, "A later duplicate must not reintroduce cleared backlog.");

	database.heartbeatBindings = [scheduledAt.toISOString(), "z".repeat(24), 1];
	await recordCleanupHeartbeat(
		database as unknown as D1Database,
		scheduledAt,
		newestCompletion,
		false,
	);
	assert.deepEqual(database.heartbeatBindings, [
		scheduledAt.toISOString(),
		newestCompletion.toISOString(),
		0,
	], "An equal-schedule retry must replace a malformed completion timestamp.");

	const newerSchedule = new Date("2026-09-03T03:17:00.000Z");
	database.heartbeatBindings = [newerSchedule.toISOString(), "z".repeat(24), 1];
	await recordCleanupHeartbeat(
		database as unknown as D1Database,
		scheduledAt,
		newestCompletion,
		false,
	);
	assert.deepEqual(database.heartbeatBindings, [
		newerSchedule.toISOString(),
		"z".repeat(24),
		1,
	], "An older delayed event must not regress a valid newer schedule while completion awaits repair.");
});

test("admin analytics configuration requires a numeric high-entropy token", async () => {
	const weakToken = "letters-are-not-the-reviewed-secret-format";
	const database = new FakeStatusD1(5) as unknown as D1Database;
	const status = await handlePlatformRoute(
		new Request("https://nonstoptalk.test/api/v1/platform/status"),
		{
			PLATFORM_DB: database,
			ANALYTICS_ADMIN_TOKEN: weakToken,
			ROOM_FACT_HASH_KEY: "2".repeat(64),
		},
		"4".repeat(64),
		"status-nonnumeric-admin-token",
		noDeferredTasks,
	);
	assert(status);
	const statusBody = await status.response.json() as { degradedCapabilities: string[] };
	assert.deepEqual(statusBody.degradedCapabilities, ["adminAnalytics"]);

	const readout = await handlePlatformRoute(
		new Request("https://nonstoptalk.test/api/v1/admin/model-usage", {
			headers: { Authorization: `Bearer ${weakToken}` },
		}),
		{ PLATFORM_DB: database, ANALYTICS_ADMIN_TOKEN: weakToken },
		"4".repeat(64),
		"readout-nonnumeric-admin-token",
		noDeferredTasks,
	);
	assert(readout);
	assert.equal(readout.response.status, 503);
});

test("progress mutations return 201/200 before a pending analytics rollup settles", async (t) => {
	const cases: Array<{
		name: string;
		method: "POST" | "DELETE";
		expectedStatus: number;
		options: FakeProgressOptions;
		expectedAnalyticsWrites: number;
	}> = [
		{
			name: "new save",
			method: "POST",
			expectedStatus: 201,
			options: { created: true },
			expectedAnalyticsWrites: 1,
		},
		{
			name: "idempotent save with a consent transition",
			method: "POST",
			expectedStatus: 200,
			options: { consentChanged: true },
			expectedAnalyticsWrites: 1,
		},
		{
			name: "clear saved progress",
			method: "DELETE",
			expectedStatus: 200,
			options: { deletedCount: 2, consentRevoked: true },
			expectedAnalyticsWrites: 2,
		},
	];

	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const database = new FakeProgressD1(scenario.options);
			const deferredTasks: Promise<void>[] = [];
			let analyticsEngineWrites = 0;
			const routePromise = handlePlatformRoute(
				progressRequest(scenario.method),
				{
					PLATFORM_DB: database as unknown as D1Database,
					PRODUCT_ANALYTICS: {
						writeDataPoint: () => {
							analyticsEngineWrites += 1;
						},
					} as unknown as AnalyticsEngineDataset,
				},
				"5".repeat(64),
				`progress-${scenario.name}`,
				(task) => deferredTasks.push(task),
			);

			await database.analyticsStarted.promise;
			const firstOutcome = await Promise.race([
				routePromise.then((handled) => ({ kind: "response" as const, handled })),
				new Promise<{ kind: "blocked" }>((resolve) => {
					setImmediate(() => resolve({ kind: "blocked" }));
				}),
			]);
			database.analyticsRelease.resolve();

			assert.equal(firstOutcome.kind, "response", "the analytics promise held the API response open");
			if (firstOutcome.kind !== "response") {
				await routePromise;
				return;
			}
			assert(firstOutcome.handled);
			assert.equal(firstOutcome.handled.response.status, scenario.expectedStatus);
			assert.equal(deferredTasks.length, 1);
			await Promise.all(deferredTasks);
			assert.equal(analyticsEngineWrites, scenario.expectedAnalyticsWrites);
			assert.equal(database.analyticsBindings.length, scenario.expectedAnalyticsWrites);
			assert.equal(
				new Set(database.analyticsBindings.map((bindings) => bindings[6])).size,
				1,
				"one progress mutation split its analytics events across observation times",
			);
		});
	}
});

test("deferred analytics failures remain non-fatal and produce bounded warning events", async (t) => {
	const warnings: unknown[] = [];
	t.mock.method(console, "warn", (value: unknown) => {
		warnings.push(value);
	});
	const database = new FakeProgressD1({ created: true, failAnalytics: true });
	const deferredTasks: Promise<void>[] = [];
	const handled = await handlePlatformRoute(
		progressRequest("POST"),
		{
			PLATFORM_DB: database as unknown as D1Database,
			PRODUCT_ANALYTICS: {
				writeDataPoint: () => {
					throw new Error("Analytics Engine unavailable");
				},
			} as unknown as AnalyticsEngineDataset,
		},
		"6".repeat(64),
		"progress-analytics-failures",
		(task) => deferredTasks.push(task),
	);

	assert(handled);
	assert.equal(handled.response.status, 201);
	assert.equal(deferredTasks.length, 1);
	await Promise.all(deferredTasks);
	assert.deepEqual(
		warnings.map((warning) => (warning as { event?: unknown }).event),
		["product_analytics_rollup_failed", "analytics_engine_write_failed"],
	);
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
	const adminToken = "7".repeat(64);
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
		noDeferredTasks,
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
