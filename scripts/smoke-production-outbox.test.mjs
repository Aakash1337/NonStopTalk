import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { EXPECTED_DELTAS } from "./outbox-activation-canary.mjs";
import {
	PRODUCTION_D1_DATABASE_ID,
	PRODUCTION_ENVIRONMENT,
	PRODUCTION_ORIGIN,
	PRODUCTION_WORKER,
	REQUIRED_PRODUCTION_ROLLBACK_VERSION,
	REQUIRED_PRODUCTION_SCRIPT_ETAG,
	assertProductionSecretInventory,
	assertProductionSourceConfig,
	assertProductionVersionResources,
	createProductionWranglerReaders,
	discoverProductionDeployment,
	parseProductionCliArguments,
	parseProductionSecrets,
	productionDeploymentIdentity,
	requireManualProductionEnvironment,
	requireProductionCoordinates,
	runProductionOutboxActivationSmoke,
} from "./smoke-production-outbox.mjs";

const CURRENT_VERSION = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const ROOM_NAMESPACE = "4adbcd44e5b347a6916e3a08066c4efd";
const HOST_TOKEN = "a".repeat(64);
const GUEST_TOKEN = "b".repeat(64);

function productionConfig(overrides = {}) {
	return {
		name: PRODUCTION_WORKER,
		routes: [{ pattern: "dontstoptalking.org", custom_domain: true }],
		vars: { ROOM_MILESTONE_DELIVERY_MODE: "outbox" },
		d1_databases: [{
			binding: "PLATFORM_DB",
			database_name: "nonstoptalk-platform",
			database_id: PRODUCTION_D1_DATABASE_ID,
		}],
		durable_objects: {
			bindings: [{ name: "ROOMS", class_name: "RoomDurableObject" }],
		},
		analytics_engine_datasets: [{
			binding: "PRODUCT_ANALYTICS",
			dataset: "nonstoptalk_product",
		}],
		assets: { binding: "ASSETS" },
		ai: { binding: "AI" },
		...overrides,
	};
}

function versionBindings(mode, overrides = []) {
	return [
		{ name: "AI", project: "<catalog>", type: "ai" },
		{ name: "ANALYTICS_ADMIN_TOKEN", type: "secret_text" },
		{
			name: "API_RATE_LIMITER",
			namespace_id: "6677868",
			simple: { limit: 60, period: 60 },
			type: "ratelimit",
		},
		{ name: "ASSETS", type: "assets" },
		{ name: "CF_VERSION_METADATA", type: "version_metadata" },
		{ name: "MODEL_DAILY_CALL_LIMIT", text: "100", type: "plain_text" },
		{
			name: "MODEL_RATE_LIMITER",
			namespace_id: "6677869",
			simple: { limit: 5, period: 60 },
			type: "ratelimit",
		},
		{
			database_id: PRODUCTION_D1_DATABASE_ID,
			id: PRODUCTION_D1_DATABASE_ID,
			name: "PLATFORM_DB",
			type: "d1",
		},
		{ dataset: "nonstoptalk_product", name: "PRODUCT_ANALYTICS", type: "analytics_engine" },
		{
			name: "ROOM_CREATION_RATE_LIMITER",
			namespace_id: "6677867",
			simple: { limit: 10, period: 60 },
			type: "ratelimit",
		},
		{ name: "ROOM_FACT_HASH_KEY", type: "secret_text" },
		{ name: "ROOM_MILESTONE_DELIVERY_MODE", text: mode, type: "plain_text" },
		{
			class_name: "RoomDurableObject",
			name: "ROOMS",
			namespace_id: ROOM_NAMESPACE,
			type: "durable_object_namespace",
		},
		{ name: "TOPIC_ESCALATION_PROVIDER", text: "off", type: "plain_text" },
		{ name: "TOPIC_ROUTINE_PROVIDER", text: "offline", type: "plain_text" },
		...overrides,
	];
}

function versionDocument(id, mode, { bindings, script = REQUIRED_PRODUCTION_SCRIPT_ETAG } = {}) {
	return {
		id,
		resources: {
			script: {
				etag: script,
				handlers: ["fetch", "scheduled"],
				named_handlers: [{ name: "RoomDurableObject", handlers: ["class"] }],
				last_deployed_from: "wrangler",
			},
			script_runtime: {
				migration_tag: "v1",
				assets: {
					not_found_handling: "single-page-application",
					headers: {
						version: 2,
						rules: {
							"/*": {
								set: {
									"cache-control": "no-cache",
									"content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
									"cross-origin-opener-policy": "same-origin",
									"cross-origin-resource-policy": "same-origin",
									"permissions-policy": "camera=(), geolocation=(), microphone=(self)",
									"referrer-policy": "same-origin",
									"strict-transport-security": "max-age=31536000",
									"x-content-type-options": "nosniff",
									"x-frame-options": "DENY",
									"x-permitted-cross-domain-policies": "none",
								},
								unset: [],
							},
						},
					},
					raw_headers: "/*\n  Cache-Control: no-cache\n  Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'\n  Permissions-Policy: camera=(), geolocation=(), microphone=(self)\n  Referrer-Policy: same-origin\n  Strict-Transport-Security: max-age=31536000\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Resource-Policy: same-origin\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  X-Permitted-Cross-Domain-Policies: none\n",
					static_routing: {
						user_worker: ["/api/*", "/admin/analytics", "/admin/analytics/*"],
					},
					serve_directly: true,
					raw_run_worker_first: ["/api/*", "/admin/analytics", "/admin/analytics/*"],
				},
				compatibility_date: "2026-09-01",
				usage_model: "standard",
			},
			bindings: bindings ?? versionBindings(mode),
		},
	};
}

function deployment(id = DEPLOYMENT_ID, version = CURRENT_VERSION) {
	return { id, versions: [{ version_id: version, percentage: 100 }] };
}

function snapshot(overrides = {}) {
	return {
		receiptCount: 40,
		roomFactCount: 12,
		roomCreatedCount: 20,
		roomJoinedCount: 18,
		gameStartedCount: 16,
		turnCompletedCount: 30,
		gameFinishedCount: 14,
		...overrides,
	};
}

function addExpected(baseline) {
	return Object.fromEntries(
		Object.entries(baseline).map(([field, value]) => [field, value + EXPECTED_DELTAS[field]]),
	);
}

function publicRoom(overrides = {}) {
	return {
		code: "ABC234",
		version: 1,
		phase: "setup",
		players: [{ id: "p1", score: 0 }],
		activeTurn: null,
		completedTurns: [],
		history: [],
		winner: null,
		viewer: { isHost: true, isMember: true },
		...overrides,
	};
}

function healthyStatus() {
	return new Response(JSON.stringify({
		status: "ok",
		schemaVersion: 6,
		capabilities: {
			aggregateAnalytics: { delivery: "durable-outbox" },
			roomFacts: { status: "ready" },
			retentionCleanup: { status: "ready" },
		},
	}), { status: 200, headers: { "Content-Type": "application/json" } });
}

function jsonRoom(room, status = 200, headers = {}) {
	return new Response(JSON.stringify({ room }), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function lifecycleFetch(trace = []) {
	let step = 0;
	const actionRooms = [
		publicRoom({
			version: 3,
			phase: "playing",
			players: [{ id: "p1", score: 0 }, { id: "p2", score: 0 }],
		}),
		publicRoom({
			version: 4,
			phase: "playing",
			players: [{ id: "p1", score: 0 }, { id: "p2", score: 0 }],
			activeTurn: { id: "t1" },
		}),
		publicRoom({
			version: 5,
			phase: "playing",
			players: [{ id: "p1", score: 1 }, { id: "p2", score: 0 }],
			completedTurns: [{ id: "t1" }],
		}),
		publicRoom({
			version: 6,
			phase: "playing",
			players: [{ id: "p1", score: 1 }, { id: "p2", score: 0 }],
			activeTurn: { id: "t2" },
			completedTurns: [{ id: "t1" }],
		}),
		publicRoom({
			version: 7,
			phase: "finished",
			players: [{ id: "p1", score: 1 }, { id: "p2", score: 1 }],
			completedTurns: [{ id: "t1" }, { id: "t2" }],
			winner: { id: "p1", score: 1 },
		}),
		publicRoom({
			version: 8,
			players: [{ id: "p1", score: 0 }, { id: "p2", score: 0 }],
			history: [{}],
		}),
	];
	return async (url, init) => {
		const parsed = new URL(url);
		assert.equal(parsed.origin, PRODUCTION_ORIGIN);
		const headers = new Headers(init.headers);
		if (step === 0) {
			trace.push("status");
			assert.equal(parsed.pathname, "/api/v1/platform/status");
			assert.equal(init.method, "GET");
			step += 1;
			return healthyStatus();
		}
		if (step === 1) {
			trace.push("create");
			assert.equal(parsed.pathname, "/api/rooms");
			assert.deepEqual(JSON.parse(init.body), { name: "Outbox canary host" });
			assert.equal(headers.get("Origin"), PRODUCTION_ORIGIN);
			step += 1;
			return jsonRoom(publicRoom(), 201, {
				"Set-Cookie": `nonstoptalk_token=${HOST_TOKEN}; Path=/; HttpOnly; Secure`,
			});
		}
		if (step === 2) {
			trace.push("join");
			assert.equal(parsed.pathname, "/api/rooms/ABC234/join");
			assert.deepEqual(JSON.parse(init.body), { name: "Outbox canary guest" });
			step += 1;
			return jsonRoom(publicRoom({
				version: 2,
				players: [{ id: "p1", score: 0 }, { id: "p2", score: 0 }],
				viewer: { isHost: false, isMember: true },
			}), 200, {
				"Set-Cookie": `nonstoptalk_token=${GUEST_TOKEN}; Path=/; HttpOnly; Secure`,
			});
		}
		trace.push(`action-${step - 2}`);
		assert.equal(headers.get("Cookie"), `nonstoptalk_token=${HOST_TOKEN}`);
		const room = actionRooms[step - 3];
		step += 1;
		return jsonRoom(room);
	};
}

function validAdapters(overrides = {}) {
	return {
		readSourceConfig: async () => productionConfig(),
		readDeployment: async () => deployment(),
		readVersion: async (version) => version === CURRENT_VERSION
			? versionDocument(CURRENT_VERSION, "outbox")
			: versionDocument(REQUIRED_PRODUCTION_ROLLBACK_VERSION, "best-effort"),
		readSecrets: async () => ["ANALYTICS_ADMIN_TOKEN", "ROOM_FACT_HASH_KEY"],
		readSnapshot: async () => snapshot(),
		...overrides,
	};
}

function runOptions(overrides = {}) {
	return {
		rollbackVersion: REQUIRED_PRODUCTION_ROLLBACK_VERSION,
		automationEnvironment: {},
		fetchImpl: lifecycleFetch(),
		delay: async () => undefined,
		pollAttempts: 1,
		pollDelayMs: 0,
		...validAdapters(),
		...overrides,
	};
}

test("production coordinates hard-lock origin, root environment, and the reviewed rollback version", () => {
	const exact = {
		origin: PRODUCTION_ORIGIN,
		worker: PRODUCTION_WORKER,
		environment: PRODUCTION_ENVIRONMENT,
		rollbackVersion: REQUIRED_PRODUCTION_ROLLBACK_VERSION,
	};
	assert.deepEqual(requireProductionCoordinates(exact), exact);
	assert.deepEqual(parseProductionCliArguments([REQUIRED_PRODUCTION_ROLLBACK_VERSION]), exact);
	for (const changed of [
		{ origin: "https://example.com" },
		{ worker: "nonstoptalk-staging" },
		{ environment: "staging" },
		{ rollbackVersion: "44444444-4444-4444-8444-444444444444" },
	]) assert.throws(() => requireProductionCoordinates({ ...exact, ...changed }), /Refusing to run/u);
	for (const args of [[], ["a"], [REQUIRED_PRODUCTION_ROLLBACK_VERSION, CURRENT_VERSION]]) {
		assert.throws(() => parseProductionCliArguments(args), /no default|Refusing to run/u);
	}
});

test("automation markers refuse the mutating command while an ordinary shell is allowed", () => {
	assert.doesNotThrow(() => requireManualProductionEnvironment({ PATH: "/bin" }));
	for (const name of ["CI", "GITHUB_ACTIONS", "CF_PAGES", "CLOUDFLARE_PAGES"]) {
		assert.throws(() => requireManualProductionEnvironment({ [name]: "true" }), /from automation/u);
	}
});

test("the exported production runner refuses automation before any adapter or network I/O", async () => {
	for (const name of ["CI", "GITHUB_ACTIONS", "CF_PAGES", "CLOUDFLARE_PAGES"]) {
		let io = 0;
		const count = async () => {
			io += 1;
			return productionConfig();
		};
		await assert.rejects(runProductionOutboxActivationSmoke(runOptions({
			automationEnvironment: { [name]: "true" },
			fetchImpl: count,
			readSourceConfig: count,
			readDeployment: count,
			readVersion: count,
			readSecrets: count,
			readSnapshot: count,
		})), /from automation/u);
		assert.equal(io, 0);
	}
});

test("source configuration requires exact root routing, outbox mode, and production resources", () => {
	assert.equal(assertProductionSourceConfig(productionConfig()).name, PRODUCTION_WORKER);
	for (const config of [
		productionConfig({ name: "other" }),
		productionConfig({ env: { production: {} } }),
		productionConfig({ vars: { ROOM_MILESTONE_DELIVERY_MODE: "best-effort" } }),
		productionConfig({ routes: [{ pattern: "*.dontstoptalking.org", custom_domain: true }] }),
		productionConfig({ d1_databases: [{
			binding: "PLATFORM_DB",
			database_name: "nonstoptalk-platform",
			database_id: "wrong",
		}] }),
		productionConfig({ durable_objects: { bindings: [] } }),
		productionConfig({ analytics_engine_datasets: [] }),
		productionConfig({ assets: { binding: "OTHER" } }),
	]) assert.throws(() => assertProductionSourceConfig(config), /production|Production/u);
});

test("the config-only comparator uses the complete live Wrangler 4.128 resource shape", () => {
	const rollback = versionDocument(REQUIRED_PRODUCTION_ROLLBACK_VERSION, "best-effort");
	const current = structuredClone(rollback);
	current.id = CURRENT_VERSION;
	const mode = current.resources.bindings.find((binding) => (
		binding.name === "ROOM_MILESTONE_DELIVERY_MODE"
	));
	mode.text = "outbox";
	assert.equal(rollback.resources.bindings.length, 15);
	assert.deepEqual(
		rollback.resources.bindings.map((binding) => binding.name),
		[
			"AI",
			"ANALYTICS_ADMIN_TOKEN",
			"API_RATE_LIMITER",
			"ASSETS",
			"CF_VERSION_METADATA",
			"MODEL_DAILY_CALL_LIMIT",
			"MODEL_RATE_LIMITER",
			"PLATFORM_DB",
			"PRODUCT_ANALYTICS",
			"ROOM_CREATION_RATE_LIMITER",
			"ROOM_FACT_HASH_KEY",
			"ROOM_MILESTONE_DELIVERY_MODE",
			"ROOMS",
			"TOPIC_ESCALATION_PROVIDER",
			"TOPIC_ROUTINE_PROVIDER",
		],
	);
	assert.equal(rollback.resources.bindings[0].project, "<catalog>");
	assert.equal(rollback.resources.bindings[8].dataset, "nonstoptalk_product");
	assert.deepEqual(rollback.resources.script.handlers, ["fetch", "scheduled"]);
	assert.deepEqual(rollback.resources.script.named_handlers, [{
		name: "RoomDurableObject",
		handlers: ["class"],
	}]);
	assert.equal(rollback.resources.script_runtime.migration_tag, "v1");
	assert.equal(rollback.resources.script_runtime.compatibility_date, "2026-09-01");
	assert.equal(rollback.resources.script_runtime.usage_model, "standard");
	assert.deepEqual(
		rollback.resources.script_runtime.assets.static_routing.user_worker,
		["/api/*", "/admin/analytics", "/admin/analytics/*"],
	);
	assert.doesNotThrow(() => assertProductionVersionResources({
		currentDocument: current,
		rollbackDocument: rollback,
		currentVersion: CURRENT_VERSION,
		rollbackVersion: REQUIRED_PRODUCTION_ROLLBACK_VERSION,
	}));
});

test("deployment, version resources, and secret inventory fail closed on drift", () => {
	assert.deepEqual(
		discoverProductionDeployment(deployment(), REQUIRED_PRODUCTION_ROLLBACK_VERSION),
		{ deploymentId: DEPLOYMENT_ID, currentVersion: CURRENT_VERSION },
	);
	assert.equal(productionDeploymentIdentity(deployment(), CURRENT_VERSION), DEPLOYMENT_ID);
	for (const document of [
		{ id: DEPLOYMENT_ID, versions: [] },
		{ id: DEPLOYMENT_ID, versions: [{ version_id: CURRENT_VERSION, percentage: 99 }] },
		{ id: DEPLOYMENT_ID, versions: [{ version_id: REQUIRED_PRODUCTION_ROLLBACK_VERSION, percentage: 100 }] },
		{ id: "bad", versions: [{ version_id: CURRENT_VERSION, percentage: 100 }] },
	]) assert.throws(() => productionDeploymentIdentity(document, CURRENT_VERSION), /deployment|version|100 percent/u);
	assert.throws(
		() => discoverProductionDeployment(
			deployment(DEPLOYMENT_ID, REQUIRED_PRODUCTION_ROLLBACK_VERSION),
			REQUIRED_PRODUCTION_ROLLBACK_VERSION,
		),
		/still serving the rollback version/u,
	);

	const checked = assertProductionVersionResources({
		currentDocument: versionDocument(CURRENT_VERSION, "outbox"),
		rollbackDocument: versionDocument(REQUIRED_PRODUCTION_ROLLBACK_VERSION, "best-effort"),
		currentVersion: CURRENT_VERSION,
		rollbackVersion: REQUIRED_PRODUCTION_ROLLBACK_VERSION,
	});
	assert.deepEqual(checked.secretNames, ["ANALYTICS_ADMIN_TOKEN", "ROOM_FACT_HASH_KEY"]);
	assert.doesNotThrow(() => assertProductionSecretInventory(checked.secretNames, checked.secretNames));
	assert.deepEqual(parseProductionSecrets(JSON.stringify([
		{ name: "ROOM_FACT_HASH_KEY", type: "secret_text" },
		{ name: "ANALYTICS_ADMIN_TOKEN", type: "secret_text" },
	])), checked.secretNames);
	for (const invalid of [
		[{ name: "ROOM_FACT_HASH_KEY", type: "plain_text" }],
		[
			{ name: "ROOM_FACT_HASH_KEY", type: "secret_text" },
			{ name: "ROOM_FACT_HASH_KEY", type: "secret_text" },
		],
	]) assert.throws(() => parseProductionSecrets(JSON.stringify(invalid)), /unexpected shape/u);

	for (const changed of [
		versionDocument(CURRENT_VERSION, "best-effort"),
		versionDocument(CURRENT_VERSION, "outbox", {
			bindings: versionBindings("outbox").filter((binding) => binding.name !== "ROOM_FACT_HASH_KEY"),
		}),
		versionDocument(CURRENT_VERSION, "outbox", {
			bindings: versionBindings("outbox").map((binding) => binding.name === "PLATFORM_DB"
				? { ...binding, id: "wrong" }
				: binding),
		}),
		versionDocument(CURRENT_VERSION, "outbox", {
			bindings: versionBindings("outbox").map((binding) => binding.name === "PLATFORM_DB"
				? { ...binding, database_id: "wrong" }
				: binding),
		}),
		versionDocument(CURRENT_VERSION, "outbox", {
			bindings: [...versionBindings("outbox"), { name: "DRIFT", type: "plain_text", text: "1" }],
		}),
		versionDocument(CURRENT_VERSION, "outbox", { script: "wrong-script" }),
	]) assert.throws(() => assertProductionVersionResources({
		currentDocument: changed,
		rollbackDocument: versionDocument(REQUIRED_PRODUCTION_ROLLBACK_VERSION, "best-effort"),
		currentVersion: CURRENT_VERSION,
		rollbackVersion: REQUIRED_PRODUCTION_ROLLBACK_VERSION,
	}), /mode|required|database|drift|script artifact/u);
	assert.throws(
		() => assertProductionSecretInventory(["ANALYTICS_ADMIN_TOKEN"], checked.secretNames),
		/differs/u,
	);
});

test("invalid coordinates, adapters, and polling bounds perform zero I/O", async () => {
	for (const invalid of [
		{ origin: "https://example.com" },
		{ worker: "nonstoptalk-staging" },
		{ environment: "staging" },
		{ rollbackVersion: "bad" },
		{ pollAttempts: 0 },
		{ pollAttempts: 61 },
		{ pollDelayMs: -1 },
		{ pollDelayMs: 60_001 },
		{ delay: "bad" },
		{ fetchImpl: "bad" },
		{ readDeployment: "bad" },
	]) {
		let io = 0;
		const count = async () => {
			io += 1;
			return productionConfig();
		};
		await assert.rejects(runProductionOutboxActivationSmoke(runOptions({
			readSourceConfig: count,
			readVersion: count,
			readSecrets: count,
			readSnapshot: count,
			fetchImpl: async () => {
				io += 1;
				return healthyStatus();
			},
			...invalid,
		})), /invalid|Refusing to run/u);
		assert.equal(io, 0);
	}
});

test("every infrastructure and readiness mismatch stops before production mutation", async () => {
	const cases = [
		{ readSourceConfig: async () => productionConfig({ vars: { ROOM_MILESTONE_DELIVERY_MODE: "best-effort" } }) },
		{ readDeployment: async () => deployment(DEPLOYMENT_ID, REQUIRED_PRODUCTION_ROLLBACK_VERSION) },
		{
			readVersion: async (version) => version === CURRENT_VERSION
				? versionDocument(CURRENT_VERSION, "best-effort")
				: versionDocument(REQUIRED_PRODUCTION_ROLLBACK_VERSION, "best-effort"),
		},
		{
			readVersion: async (version) => version === CURRENT_VERSION
				? versionDocument(CURRENT_VERSION, "outbox", {
					bindings: versionBindings("outbox").map((binding) => binding.name === "PLATFORM_DB"
						? { ...binding, id: "wrong" }
						: binding),
				})
				: versionDocument(REQUIRED_PRODUCTION_ROLLBACK_VERSION, "best-effort"),
		},
		{ readSecrets: async () => ["ANALYTICS_ADMIN_TOKEN"] },
	];
	for (const changed of cases) {
		let fetches = 0;
		let databaseReads = 0;
		await assert.rejects(runProductionOutboxActivationSmoke(runOptions({
			fetchImpl: async () => {
				fetches += 1;
				return healthyStatus();
			},
			readSnapshot: async () => {
				databaseReads += 1;
				return snapshot();
			},
			...changed,
		})), /production|Production/u);
		assert.equal(fetches, 0);
		assert.equal(databaseReads, 0);
	}

	let fetches = 0;
	let databaseReads = 0;
	await assert.rejects(runProductionOutboxActivationSmoke(runOptions({
		fetchImpl: async () => {
			fetches += 1;
			return new Response(JSON.stringify({
				status: "ok",
				schemaVersion: 6,
				capabilities: {
					aggregateAnalytics: { delivery: "best-effort" },
					roomFacts: { status: "ready" },
					retentionCleanup: { status: "ready" },
				},
			}), { headers: { "Content-Type": "application/json" } });
		},
		readSnapshot: async () => {
			databaseReads += 1;
			return snapshot();
		},
	})), /requires durable-outbox/u);
	assert.equal(fetches, 1);
	assert.equal(databaseReads, 0);
});

test("deployment drift before baseline or immediately before mutation creates no room", async () => {
	for (const driftAtRead of [2, 3]) {
		let deploymentReads = 0;
		let databaseReads = 0;
		const paths = [];
		await assert.rejects(runProductionOutboxActivationSmoke(runOptions({
			readDeployment: async () => {
				deploymentReads += 1;
				return deployment(deploymentReads === driftAtRead ? OTHER_DEPLOYMENT_ID : DEPLOYMENT_ID);
			},
			readSnapshot: async () => {
				databaseReads += 1;
				return snapshot();
			},
			fetchImpl: async (url) => {
				paths.push(new URL(url).pathname);
				return healthyStatus();
			},
		})), /changed deployments/u);
		assert.deepEqual(paths, ["/api/v1/platform/status"]);
		assert.equal(databaseReads, driftAtRead === 2 ? 0 : 1);
	}
});

test("the production run proves the exact lifecycle and checks deployment at every boundary", async () => {
	const trace = [];
	let deploymentReads = 0;
	let configReads = 0;
	let secretReads = 0;
	let snapshotReads = 0;
	const baseline = snapshot();
	const summary = await runProductionOutboxActivationSmoke(runOptions({
		fetchImpl: lifecycleFetch(trace),
		readSourceConfig: async () => {
			configReads += 1;
			trace.push(`config-${configReads}`);
			return productionConfig();
		},
		readDeployment: async () => {
			deploymentReads += 1;
			trace.push(`deployment-${deploymentReads}`);
			return deployment();
		},
		readVersion: async (version) => {
			trace.push(version === CURRENT_VERSION ? "current-version" : "rollback-version");
			return version === CURRENT_VERSION
				? versionDocument(CURRENT_VERSION, "outbox")
				: versionDocument(REQUIRED_PRODUCTION_ROLLBACK_VERSION, "best-effort");
		},
		readSecrets: async () => {
			secretReads += 1;
			trace.push(`secrets-${secretReads}`);
			return ["ANALYTICS_ADMIN_TOKEN", "ROOM_FACT_HASH_KEY"];
		},
		readSnapshot: async () => {
			snapshotReads += 1;
			trace.push(`snapshot-${snapshotReads}`);
			return snapshotReads === 1 ? baseline : addExpected(baseline);
		},
	}));
	assert.equal(deploymentReads, 5);
	assert.equal(configReads, 2);
	assert.equal(secretReads, 2);
	assert.equal(snapshotReads, 3);
	assert.deepEqual(summary, {
		status: "ok",
		origin: PRODUCTION_ORIGIN,
		receiptsAdded: 7,
		roomFactsAdded: 1,
		analyticsEventsAdded: {
			roomCreated: 1,
			roomJoined: 1,
			gameStarted: 1,
			turnCompleted: 2,
			gameFinished: 1,
		},
		worker: PRODUCTION_WORKER,
		environment: "root",
		currentVersion: CURRENT_VERSION,
		rollbackVersion: REQUIRED_PRODUCTION_ROLLBACK_VERSION,
		deploymentId: DEPLOYMENT_ID,
	});
	assert.deepEqual(trace, [
		"config-1",
		"deployment-1",
		"current-version",
		"rollback-version",
		"secrets-1",
		"status",
		"deployment-2",
		"config-2",
		"secrets-2",
		"snapshot-1",
		"deployment-3",
		"create",
		"join",
		"action-1",
		"action-2",
		"action-3",
		"action-4",
		"action-5",
		"action-6",
		"deployment-4",
		"snapshot-2",
		"snapshot-3",
		"deployment-5",
	]);
});

test("Wrangler readers use only root-environment read queries and the fixed aggregate SELECT", async () => {
	const calls = [];
	const readers = createProductionWranglerReaders({
		readFileImpl: async (pathname, encoding) => {
			assert.match(pathname, /wrangler\.jsonc$/u);
			assert.equal(encoding, "utf8");
			return JSON.stringify(productionConfig());
		},
		execFileImpl: async (executable, args, options) => {
			calls.push({ executable, args, options });
			if (args.includes("deployments")) return { stdout: JSON.stringify(deployment()), stderr: "" };
			if (args.includes("versions")) {
				const version = args[args.indexOf("view") + 1];
				return {
					stdout: JSON.stringify(version === CURRENT_VERSION
						? versionDocument(CURRENT_VERSION, "outbox")
						: versionDocument(REQUIRED_PRODUCTION_ROLLBACK_VERSION, "best-effort")),
					stderr: "",
				};
			}
			if (args.includes("secret")) return {
				stdout: JSON.stringify([
					{ name: "ANALYTICS_ADMIN_TOKEN", type: "secret_text" },
					{ name: "ROOM_FACT_HASH_KEY", type: "secret_text" },
				]),
				stderr: "",
			};
			return {
				stdout: JSON.stringify([{ success: true, results: [{
					receipt_count: 1,
					room_fact_count: 1,
					room_created_count: 1,
					room_joined_count: 1,
					game_started_count: 1,
					turn_completed_count: 2,
					game_finished_count: 1,
				}] }]),
				stderr: "",
			};
		},
	});
	await readers.readSourceConfig();
	await readers.readDeployment();
	await readers.readVersion(CURRENT_VERSION);
	await readers.readSecrets();
	await readers.readSnapshot();
	assert.deepEqual(calls.map((call) => call.args.slice(1)), [
		["deployments", "status", "--env=", "--json"],
		["versions", "view", CURRENT_VERSION, "--env=", "--json"],
		["secret", "list", "--env=", "--format", "json"],
		["d1", "execute", "PLATFORM_DB", "--remote", "--env=", "--json", "--command", calls[3].args.at(-1)],
	]);
	assert.match(calls[3].args.at(-1), /^SELECT\s/u);
	assert.doesNotMatch(calls[3].args.at(-1), /\b(?:ALTER|CREATE|DELETE|DROP|INSERT|REPLACE|UPDATE|UPSERT|VACUUM)\b/iu);
	for (const call of calls) {
		assert.equal(call.executable, process.execPath);
		assert.equal(call.options.env.CI, "1");
		assert.equal(call.options.env.NO_COLOR, "1");
	}
});

test("the live production canary is absent from CI, deploy commands, and scheduled health", async () => {
	const packageDocument = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(
		packageDocument.scripts["smoke:production-outbox"],
		"node scripts/smoke-production-outbox.mjs",
	);
	for (const name of ["deploy", "deploy:staging", "smoke:production"]) {
		assert.doesNotMatch(packageDocument.scripts[name], /smoke:production-outbox/u);
	}
	const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
	for (const entry of await readdir(workflowDirectory, { withFileTypes: true })) {
		if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) continue;
		const source = await readFile(new URL(entry.name, workflowDirectory), "utf8");
		assert.doesNotMatch(
			source,
			/(?:npm run smoke:production-outbox(?:\s|$)|node scripts\/smoke-production-outbox\.mjs)/u,
			entry.name,
		);
	}
});
