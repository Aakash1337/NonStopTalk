import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CHECKPOINT_FILENAME_PREFIX,
	CREATE_ONLY_DELTAS,
	FAULT_CONFIG_FILENAME,
	JOIN_ONLY_DELTAS,
	LEGACY_CREATE_DELTAS,
	RELEASE_A_SCRIPT_ETAG,
	RELEASE_A_STAGING_VERSION,
	RELEASE_B_SCRIPT_ETAG,
	RELEASE_B_STAGING_VERSION,
	STAGING_D1_DATABASE_ID,
	STAGING_DURABLE_OBJECT_NAMESPACE_ID,
	STAGING_WORKER,
	assertOnlyReceiverFaultConfigChange,
	assertReceiverFaultVersionDiff,
	assertSingleVersionDeployment,
	buildReceiverFaultConfig,
	checkpointFilename,
	createStagingTailObservers,
	createStagingWranglerReaders,
	findCandidateSeedProof,
	findFaultSeededJoinProof,
	findFaultTraceProof,
	hasFaultStateBarrier,
	hasRollbackTraceProof,
	locateAggregateCheckpoint,
	parseCliArguments,
	parseDeploymentStatus,
	parseJsonc,
	parseTailTraceStream,
	pollForCreateDrain,
	pollForJoinedDrain,
	prepareRollbackDrainProof,
	readAggregateCheckpoint,
	requireDrillCoordinates,
	stagingTailArguments,
	validateFaultPreflight,
	verifyRollbackDrainProof,
	writeAggregateCheckpoint,
	writeReceiverFaultConfig,
} from "./drill-staging-outbox-rollback.mjs";
import { D1_SNAPSHOT_SQL, STAGING_ORIGIN } from "./smoke-staging-outbox.mjs";

const CANDIDATE_VERSION = RELEASE_B_STAGING_VERSION;
const FAULT_VERSION = "22222222-2222-4222-8222-222222222222";
const ROLLBACK_VERSION = RELEASE_A_STAGING_VERSION;
const CANDIDATE_DEPLOYMENT = "66666666-6666-4666-8666-666666666666";
const FAULT_DEPLOYMENT = "77777777-7777-4777-8777-777777777777";
const ROLLBACK_DEPLOYMENT = "88888888-8888-4888-8888-888888888888";
const HOST_TOKEN = "a".repeat(64);
const GUEST_TOKEN = "b".repeat(64);
const PROOF_DIGEST = "c".repeat(64);
const CREATED_DO_ID = "a".repeat(64);
const OTHER_DO_ID = "b".repeat(64);

function snapshot(overrides = {}) {
	return {
		receiptCount: 7,
		roomFactCount: 4,
		roomCreatedCount: 4,
		roomJoinedCount: 1,
		gameStartedCount: 1,
		turnCompletedCount: 2,
		gameFinishedCount: 1,
		...overrides,
	};
}

function addDeltas(baseline, deltas) {
	return Object.fromEntries(
		Object.entries(baseline).map(([field, value]) => [field, value + deltas[field]]),
	);
}

function requiredBindings({ database = true, mode = "outbox" } = {}) {
	return [
		{
			name: "ROOMS",
			type: "durable_object_namespace",
			class_name: "RoomDurableObject",
			namespace_id: STAGING_DURABLE_OBJECT_NAMESPACE_ID,
		},
		{ name: "ASSETS", type: "assets" },
		{ name: "ANALYTICS_ADMIN_TOKEN", type: "secret_text" },
		{ name: "ROOM_FACT_HASH_KEY", type: "secret_text" },
		{ name: "PRODUCT_ANALYTICS", type: "analytics_engine", dataset: "staging" },
		{ name: "ROOM_MILESTONE_DELIVERY_MODE", type: "plain_text", text: mode },
		...(database ? [{ name: "PLATFORM_DB", type: "d1", id: STAGING_D1_DATABASE_ID }] : []),
	];
}

function versionDocument(id, {
	database = true,
	script = RELEASE_B_SCRIPT_ETAG,
	mode = "outbox",
	bindings,
} = {}) {
	return {
		id,
		metadata: { created_on: "2026-09-01T12:00:00.000Z" },
		resources: {
			script: { etag: script, handlers: ["fetch"] },
			script_runtime: { compatibility_date: "2026-09-01" },
			bindings: bindings ?? requiredBindings({ database, mode }),
		},
	};
}

function rollbackDocument(overrides = {}) {
	return versionDocument(ROLLBACK_VERSION, {
		script: RELEASE_A_SCRIPT_ETAG,
		mode: "best-effort",
		...overrides,
	});
}

function deployment(version, id = version === CANDIDATE_VERSION
	? CANDIDATE_DEPLOYMENT
	: version === FAULT_VERSION ? FAULT_DEPLOYMENT : ROLLBACK_DEPLOYMENT) {
	return { id, versions: [{ version_id: version, percentage: 100 }] };
}

function faultStatus() {
	return new Response(JSON.stringify({
		error: {
			code: "DATABASE_UNAVAILABLE",
			message: "The platform data service is temporarily unavailable.",
		},
		requestId: "request-only",
	}), { status: 503, headers: { "Content-Type": "application/json" } });
}

function healthyCandidateStatus() {
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

function healthyRollbackStatus() {
	return new Response(JSON.stringify({
		status: "ok",
		schemaVersion: 6,
		capabilities: {
			aggregateAnalytics: { delivery: "best-effort" },
			roomFacts: { status: "ready" },
			retentionCleanup: { status: "ready" },
		},
	}), { status: 200, headers: { "Content-Type": "application/json" } });
}

function createdRoomResponse() {
	return new Response(JSON.stringify({
		room: {
			code: "ABC234",
			version: 1,
			phase: "setup",
			players: [{ id: "private-player", score: 0 }],
			activeTurn: null,
			completedTurns: [],
			viewer: { isHost: true, isMember: true },
		},
	}), {
		status: 201,
		headers: {
			"Content-Type": "application/json",
			"Set-Cookie": `nonstoptalk_token=${HOST_TOKEN}; Path=/; HttpOnly; Secure`,
		},
	});
}

function guestIdentityResponse() {
	return new Response(JSON.stringify({ error: "Not found." }), {
		status: 404,
		headers: {
			"Content-Type": "application/json",
			"Set-Cookie": `nonstoptalk_token=${GUEST_TOKEN}; Path=/; HttpOnly; Secure`,
		},
	});
}

function seededRoomStateResponse() {
	return new Response(JSON.stringify({
		room: {
			code: "ABC234",
			version: 1,
			phase: "setup",
			players: [{ id: "private-player", score: 0 }],
			activeTurn: null,
			completedTurns: [],
			viewer: { isHost: false, isMember: false },
		},
	}), { status: 200, headers: { "Content-Type": "application/json" } });
}

function joinedRoomResponse() {
	return new Response(JSON.stringify({
		room: {
			code: "ABC234",
			version: 2,
			phase: "setup",
			players: [
				{ id: "private-player", score: 0 },
				{ id: "private-guest", score: 0 },
			],
			activeTurn: null,
			completedTurns: [],
			viewer: { isHost: false, isMember: true },
		},
	}), { status: 200, headers: { "Content-Type": "application/json" } });
}

function coordinates(overrides = {}) {
	return {
		origin: STAGING_ORIGIN,
		worker: STAGING_WORKER,
		candidateVersion: CANDIDATE_VERSION,
		faultVersion: FAULT_VERSION,
		rollbackVersion: ROLLBACK_VERSION,
		...overrides,
	};
}

function traceDocument({
	version = FAULT_VERSION,
	durableObjectId = CREATED_DO_ID,
	scriptName = STAGING_WORKER,
	entrypoint = "RoomDurableObject",
	event,
	logs = [],
	outcome = "ok",
	truncated = false,
	exceptions = [],
	executionModel = "durableObject",
} = {}) {
	return {
		scriptName,
		scriptVersion: { id: version },
		entrypoint,
		durableObjectId,
		executionModel,
		outcome,
		truncated,
		exceptions,
		logs: logs.map((record) => ({ level: "warn", message: [record] })),
		event,
	};
}

function createTrace(overrides = {}) {
	return traceDocument({
		event: {
			request: {
				method: "POST",
				url: "https://room.internal/create",
				headers: { "X-NonStopTalk-Token": "must-not-survive-projection" },
				cf: { city: "must-not-survive-projection" },
			},
			response: { status: 201 },
		},
		...overrides,
	});
}

function seedAcknowledgementTrace(overrides = {}) {
	return traceDocument({
		version: CANDIDATE_VERSION,
		event: { scheduledTime: 1_788_271_199_000 },
		logs: [],
		...overrides,
	});
}

function stateTrace(overrides = {}) {
	return traceDocument({
		event: {
			request: {
				method: "GET",
				url: "https://room.internal/state",
				headers: { "X-NonStopTalk-Token": "must-not-survive-projection" },
			},
			response: { status: 200 },
		},
		...overrides,
	});
}

function joinTrace(overrides = {}) {
	return traceDocument({
		event: {
			request: {
				method: "POST",
				url: "https://room.internal/join",
				headers: { "X-NonStopTalk-Token": "must-not-survive-projection" },
			},
			response: { status: 200 },
		},
		...overrides,
	});
}

function retryAlarmTrace(overrides = {}) {
	return traceDocument({
		event: { scheduledTime: 1_788_271_200_000 },
		logs: [
			{ event: "room_milestone_outbox_delivery_failed", error: "Error" },
			{
				event: "room_milestone_outbox_retry_scheduled",
				failure: "database-unavailable",
				attemptCount: 1,
			},
		],
		...overrides,
	});
}

function rollbackAlarmTrace(overrides = {}) {
	return traceDocument({
		version: ROLLBACK_VERSION,
		event: { scheduledTime: 1_788_271_201_000 },
		logs: [],
		...overrides,
	});
}

test("coordinates fail closed on production, another Worker, malformed IDs, or unreviewed releases", () => {
	assert.deepEqual(requireDrillCoordinates(coordinates()), coordinates());
	for (const unsafe of [
		{ origin: "https://dontstoptalking.org" },
		{ worker: "nonstoptalk" },
		{ candidateVersion: "not-a-version" },
		{ candidateVersion: "11111111-1111-4111-8111-111111111111" },
		{ faultVersion: CANDIDATE_VERSION },
		{ rollbackVersion: "33333333-3333-4333-8333-333333333333" },
	]) assert.throws(() => requireDrillCoordinates(coordinates(unsafe)), /Refusing to run/u);
	assert.deepEqual(parseCliArguments(["make-fault-config"]), { phase: "make-fault-config" });
	assert.equal(parseCliArguments(["validate-fault", CANDIDATE_VERSION, FAULT_VERSION, ROLLBACK_VERSION]).phase, "validate-fault");
	assert.equal(parseCliArguments(["verify", CANDIDATE_VERSION, FAULT_VERSION, ROLLBACK_VERSION]).phase, "verify");
});

test("fault config generation changes only staging PLATFORM_DB and writes mode 0600", async () => {
	const source = `{
		// Production stays best effort.
		"name": "nonstoptalk",
		"main": "cloudflare/worker.ts",
		"vars": { "ROOM_MILESTONE_DELIVERY_MODE": "best-effort" },
		"d1_databases": [{ "binding": "PLATFORM_DB", "database_id": "production" }],
		"env": {
			"staging": {
				"name": "nonstoptalk-staging",
				"vars": { "ROOM_MILESTONE_DELIVERY_MODE": "outbox" },
				"d1_databases": [{ "binding": "PLATFORM_DB", "database_id": "staging" }],
			},
		},
	}`;
	const candidate = parseJsonc(source);
	const fault = parseJsonc(buildReceiverFaultConfig(source));
	assert.deepEqual(fault.env.staging.d1_databases, []);
	assert.deepEqual(fault.d1_databases, candidate.d1_databases);
	assert.doesNotThrow(() => assertOnlyReceiverFaultConfigChange(candidate, fault));
	assert.throws(() => assertOnlyReceiverFaultConfigChange(candidate, {
		...fault,
		vars: { ROOM_MILESTONE_DELIVERY_MODE: "outbox" },
	}), /remove only staging PLATFORM_DB|Production/u);

	const directory = await mkdtemp(join(tmpdir(), "nonstoptalk-fault-config-test-"));
	try {
		const sourcePath = join(directory, "wrangler.jsonc");
		const outputPath = join(directory, FAULT_CONFIG_FILENAME);
		await writeFile(sourcePath, source, "utf8");
		await writeReceiverFaultConfig({ sourcePath, outputPath });
		assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
		await assert.rejects(writeReceiverFaultConfig({ sourcePath, outputPath }), /could not be written safely/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("version preflight pins both releases and permits only PLATFORM_DB to disappear", async () => {
	const candidateDocument = versionDocument(CANDIDATE_VERSION);
	const faultDocument = versionDocument(FAULT_VERSION, { database: false });
	assert.doesNotThrow(() => assertReceiverFaultVersionDiff({
		candidateDocument,
		faultDocument,
		candidateVersion: CANDIDATE_VERSION,
		faultVersion: FAULT_VERSION,
	}));
	assert.deepEqual(await validateFaultPreflight({
		...coordinates(),
		readDeployment: async () => deployment(CANDIDATE_VERSION),
		readVersion: async (version) => version === CANDIDATE_VERSION
			? candidateDocument
			: version === FAULT_VERSION ? faultDocument : rollbackDocument(),
	}), { status: "ok", phase: "fault-version-validated", activationPerformed: false });

	for (const changed of [
		versionDocument(FAULT_VERSION, { database: false, script: "different-script" }),
		versionDocument(FAULT_VERSION, {
			database: false,
			bindings: requiredBindings({ database: false }).filter((binding) => binding.name !== "ASSETS"),
		}),
	]) assert.throws(() => assertReceiverFaultVersionDiff({
		candidateDocument,
		faultDocument: changed,
		candidateVersion: CANDIDATE_VERSION,
		faultVersion: FAULT_VERSION,
	}), /differs|required reviewed binding/u);
	assert.throws(() => assertReceiverFaultVersionDiff({
		candidateDocument: versionDocument(CANDIDATE_VERSION, { script: "wrong-release-b" }),
		faultDocument,
		candidateVersion: CANDIDATE_VERSION,
		faultVersion: FAULT_VERSION,
	}), /pinned reviewed Release-B/u);
	await assert.rejects(validateFaultPreflight({
		...coordinates(),
		readDeployment: async () => deployment(CANDIDATE_VERSION),
		readVersion: async (version) => version === CANDIDATE_VERSION
			? candidateDocument
			: version === FAULT_VERSION ? faultDocument : rollbackDocument({ script: "wrong-release-a" }),
	}), /pinned reviewed Release-A/u);
});

test("deployment validation requires one exact version at 100 percent", () => {
	const parsed = parseDeploymentStatus(JSON.stringify(deployment(FAULT_VERSION)));
	assert.doesNotThrow(() => assertSingleVersionDeployment(parsed, FAULT_VERSION));
	for (const invalid of [
		{ versions: [] },
		{ versions: [{ version_id: FAULT_VERSION, percentage: 99 }] },
		{ versions: [{ version_id: CANDIDATE_VERSION, percentage: 100 }] },
		{ versions: [
			{ version_id: FAULT_VERSION, percentage: 50 },
			{ version_id: CANDIDATE_VERSION, percentage: 50 },
		] },
	]) assert.throws(() => assertSingleVersionDeployment(invalid, FAULT_VERSION), /single version/u);
});

test("fault trace proof requires one 201 create and one same-object first retry alarm", () => {
	const proof = findFaultTraceProof([createTrace(), retryAlarmTrace()], FAULT_VERSION);
	assert.match(proof, /^[0-9a-f]{64}$/u);
	assert.equal(hasRollbackTraceProof([rollbackAlarmTrace()], ROLLBACK_VERSION, proof), true);
	assert.equal(hasRollbackTraceProof([rollbackAlarmTrace({ durableObjectId: OTHER_DO_ID })], ROLLBACK_VERSION, proof), false);
	assert.throws(() => findFaultTraceProof([
		createTrace(),
		retryAlarmTrace({ durableObjectId: OTHER_DO_ID }),
	], FAULT_VERSION), /not caused by the one created/u);
	assert.throws(() => findFaultTraceProof([
		createTrace(),
		retryAlarmTrace({ logs: [{ event: "room_milestone_outbox_delivery_failed" }] }),
		retryAlarmTrace({ logs: [{
			event: "room_milestone_outbox_retry_scheduled",
			failure: "database-unavailable",
			attemptCount: 1,
		}] }),
	], FAULT_VERSION), /split or incomplete/u);
	assert.equal(findFaultTraceProof([
		createTrace({ entrypoint: "AnotherObject" }),
		retryAlarmTrace(),
	], FAULT_VERSION), null);
	assert.throws(() => findFaultTraceProof([
		{ ...createTrace(), scriptName: "another-worker" },
		retryAlarmTrace(),
	], FAULT_VERSION), /incomplete or malformed/u);
	assert.throws(() => findFaultTraceProof([
		createTrace(),
		retryAlarmTrace({ logs: [
			{ event: "room_milestone_outbox_delivery_failed" },
			{
				event: "room_milestone_outbox_retry_scheduled",
				failure: "database-unavailable",
				attemptCount: 1,
			},
			{ event: "room_milestone_outbox_dead_lettered" },
		] }),
	], FAULT_VERSION), /terminal outbox event/u);
	assert.throws(() => findFaultTraceProof([
		createTrace({ logs: [{ event: "room_alarm_schedule_failed" }] }),
		retryAlarmTrace(),
	], FAULT_VERSION), /create trace emitted an unexpected log/u);
});

test("seeded-room proof requires candidate ACK, then fault state, join, and first retry on one object", () => {
	const seedProof = findCandidateSeedProof([
		createTrace({ version: CANDIDATE_VERSION }),
		seedAcknowledgementTrace(),
	], CANDIDATE_VERSION);
	assert.match(seedProof, /^[0-9a-f]{64}$/u);
	assert.equal(hasFaultStateBarrier([stateTrace()], FAULT_VERSION, seedProof), true);
	assert.equal(findFaultSeededJoinProof([
		stateTrace(),
		stateTrace(),
		joinTrace(),
		retryAlarmTrace(),
	], FAULT_VERSION, seedProof), seedProof);
	assert.equal(findCandidateSeedProof([
		createTrace({ version: CANDIDATE_VERSION }),
	], CANDIDATE_VERSION), null);
	assert.throws(() => findCandidateSeedProof([
		createTrace({ version: CANDIDATE_VERSION }),
		seedAcknowledgementTrace({ logs: [{ event: "room_milestone_outbox_retry_scheduled" }] }),
	], CANDIDATE_VERSION), /cleanly acknowledge/u);
	assert.throws(() => findFaultSeededJoinProof([
		stateTrace(),
		joinTrace({ durableObjectId: OTHER_DO_ID }),
		retryAlarmTrace(),
	], FAULT_VERSION, seedProof), /concurrent staging room mutation/u);
	assert.throws(() => findFaultSeededJoinProof([
		stateTrace(),
		retryAlarmTrace(),
		joinTrace(),
	], FAULT_VERSION, seedProof), /not one ordered/u);
	assert.throws(() => findFaultSeededJoinProof([
		stateTrace(),
		joinTrace(),
		retryAlarmTrace({ logs: [
			{ event: "room_milestone_outbox_delivery_failed" },
			{
				event: "room_milestone_outbox_retry_scheduled",
				failure: "database-unavailable",
				attemptCount: 2,
			},
		] }),
	], FAULT_VERSION, seedProof), /first retry evidence/u);
	assert.throws(() => findFaultSeededJoinProof([
		stateTrace(),
		createTrace(),
	], FAULT_VERSION, seedProof), /concurrent staging room mutation/u);
});

test("tail proof rejects truncation, missing metadata, overload, exceptions, and dirty A alarms", () => {
	const proof = findFaultTraceProof([createTrace(), retryAlarmTrace()], FAULT_VERSION);
	for (const invalid of [
		[createTrace({ truncated: true }), retryAlarmTrace()],
		[{ ...createTrace(), scriptVersion: undefined }, retryAlarmTrace()],
		[createTrace({ exceptions: [{ name: "Error" }] }), retryAlarmTrace()],
		[{ event: { type: "overload", message: "traces dropped" } }],
	]) assert.throws(() => findFaultTraceProof(invalid, FAULT_VERSION), /overload|incomplete|malformed/u);
	assert.throws(() => hasRollbackTraceProof([
		rollbackAlarmTrace({ logs: [{ event: "room_milestone_outbox_retry_scheduled" }] }),
	], ROLLBACK_VERSION, proof), /cleanly drain/u);
	assert.throws(() => hasRollbackTraceProof([
		rollbackAlarmTrace({ logs: [{ event: "room_alarm_schedule_failed" }] }),
	], ROLLBACK_VERSION, proof), /unexpected log/u);
	const projected = parseTailTraceStream(
		`${JSON.stringify(createTrace())}\n${JSON.stringify(retryAlarmTrace())}\n`,
	);
	assert.equal(findFaultTraceProof(projected, FAULT_VERSION), proof);
	assert.doesNotMatch(JSON.stringify(projected), /headers|cf|must-not-survive-projection|room\.internal/u);
	const projectedUnexpected = parseTailTraceStream(
		`${JSON.stringify(createTrace({ logs: [{ event: "room_alarm_schedule_failed" }] }))}\n${JSON.stringify(retryAlarmTrace())}\n`,
	);
	assert.throws(() => findFaultTraceProof(projectedUnexpected, FAULT_VERSION), /unexpected log/u);
	const projectedOuter = parseTailTraceStream(JSON.stringify(traceDocument({
		durableObjectId: undefined,
		entrypoint: "fetch",
		executionModel: "stateless",
		event: {
			request: {
				method: "GET",
				url: "https://example.invalid/api/rooms/ABC234/state",
				headers: { Cookie: "must-not-survive-projection" },
				cf: { city: "must-not-survive-projection" },
			},
			response: { status: 200 },
		},
	})));
	assert.doesNotMatch(
		JSON.stringify(projectedOuter),
		/ABC234|pathname|headers|Cookie|cf|city|must-not-survive-projection/u,
	);
	assert.equal(projectedOuter[0].event.request.method, "GET");
	assert.equal(projectedOuter[0].event.response.status, 200);
	assert.equal(hasRollbackTraceProof([
		rollbackAlarmTrace({ entrypoint: "AnotherObject" }),
	], ROLLBACK_VERSION, proof), false);
	assert.throws(() => parseTailTraceStream("sampling warning\n"), /non-JSON/u);
	assert.throws(() => parseTailTraceStream('{"truncated":false'), /ended inside/u);
});

test("tail argv selects config staging, filters one version, omits duplicate name and sampling", () => {
	const args = stagingTailArguments("fault", FAULT_VERSION);
	assert.match(args[0], /node_modules\/wrangler\/bin\/wrangler\.js$/u);
	assert.deepEqual(args.slice(1), [
		"tail", "--env", "staging", "--format", "json", "--version-id", FAULT_VERSION,
	]);
	assert.equal(args.includes(STAGING_WORKER), false);
	assert.equal(args.includes("--sampling-rate"), false);
	assert.deepEqual(stagingTailArguments("rollback", ROLLBACK_VERSION, "pretty").slice(1), [
		"tail", "--env", "staging", "--format", "pretty", "--version-id", ROLLBACK_VERSION,
	]);
	assert.deepEqual(stagingTailArguments("seed", CANDIDATE_VERSION).slice(1), [
		"tail", "--env", "staging", "--format", "json", "--version-id", CANDIDATE_VERSION,
	]);
});

test("tail observer signals before activation, safely retries state, and never retries join", async () => {
	const jsonChildren = new Map();
	function childProcess(format, version) {
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		const child = new EventEmitter();
		child.stdout = stdout;
		child.stderr = stderr;
		let stopped = false;
		child.kill = () => {
			if (!stopped) {
				stopped = true;
				child.emit("exit", 0, null);
			}
		};
		if (format === "pretty") {
			queueMicrotask(() => stdout.emit("data", `Connected to ${STAGING_WORKER}, waiting for logs...\n`));
		} else jsonChildren.set(version, child);
		return child;
	}
	const sequence = [];
	let activated = false;
	const observers = createStagingTailObservers({
		spawnImpl: (_executable, args) => {
			const format = args[args.indexOf("--format") + 1];
			const version = args[args.indexOf("--version-id") + 1];
			return childProcess(format, version);
		},
		onReady(kind) {
			assert.equal(kind, "fault");
			sequence.push("fault-observer-ready");
			activated = true;
		},
		delay: async () => undefined,
		warmupMs: 0,
		stateBarrierAttempts: 2,
		stateBarrierTraceWaitMs: 1,
		stateBarrierRetryDelayMs: 0,
	});
	const seed = await observers.observeCandidateSeed(async () => {
		jsonChildren.get(CANDIDATE_VERSION).stdout.emit("data", [
			JSON.stringify(createTrace({ version: CANDIDATE_VERSION })),
			JSON.stringify(seedAcknowledgementTrace()),
			"",
		].join("\n"));
		return { privateRoom: "must-not-be-output" };
	}, CANDIDATE_VERSION, async () => sequence.push("seed-tail-ready"));
	assert.match(seed.proofDigest, /^[0-9a-f]{64}$/u);
	let stateAttempts = 0;
	let joinAttempts = 0;
	const fault = await observers.observeFaultSeededJoin({
		async awaitActivation() {
			assert.equal(activated, true);
			sequence.push("fault-activated");
		},
		async stateOperation() {
			stateAttempts += 1;
			sequence.push(`state-${stateAttempts}`);
			if (stateAttempts === 2) {
				// Model the first trace arriving late alongside the deliberate retry.
				jsonChildren.get(FAULT_VERSION).stdout.emit("data", [
					JSON.stringify(stateTrace()),
					JSON.stringify(stateTrace()),
					"",
				].join("\n"));
			}
		},
		async beforeJoinOperation() {
			sequence.push("before-join");
		},
		async joinOperation() {
			joinAttempts += 1;
			sequence.push("join");
			jsonChildren.get(FAULT_VERSION).stdout.emit("data", [
				JSON.stringify(joinTrace()),
				JSON.stringify(retryAlarmTrace()),
				"",
			].join("\n"));
			return { privateGuest: "must-not-be-output" };
		},
	}, FAULT_VERSION, seed.proofDigest, async () => sequence.push("fault-precheck"));
	assert.equal(fault.proofDigest, seed.proofDigest);
	assert.equal(stateAttempts, 2);
	assert.equal(joinAttempts, 1);
	assert.deepEqual(sequence, [
		"seed-tail-ready",
		"fault-precheck",
		"fault-observer-ready",
		"fault-activated",
		"state-1",
		"state-2",
		"before-join",
		"join",
	]);
	assert.doesNotMatch(JSON.stringify({ proofDigest: fault.proofDigest }), /privateRoom|privateGuest/u);
});

test("prepare seeds and drains under B, signals a ready fault observer, then proves one same-object join", async () => {
	const beforeSeed = snapshot();
	const baseline = addDeltas(beforeSeed, CREATE_ONLY_DELTAS);
	let activeVersion = CANDIDATE_VERSION;
	let seedCreated = false;
	let seedPrivateResult;
	let seedPrivateHost;
	let joinAttempts = 0;
	let faultStatusReads = 0;
	const sequence = [];
	const result = await prepareRollbackDrainProof({
		...coordinates(),
		fetchImpl: async (url, init = {}) => {
			const pathname = new URL(url).pathname;
			if (pathname === "/api/v1/platform/status") {
				if (activeVersion === CANDIDATE_VERSION) return healthyCandidateStatus();
				faultStatusReads += 1;
				return faultStatusReads === 1 ? healthyCandidateStatus() : faultStatus();
			}
			if (pathname === "/api/rooms") {
				assert.equal(activeVersion, CANDIDATE_VERSION);
				seedCreated = true;
				sequence.push("seed-create");
				return createdRoomResponse();
			}
			if (pathname === "/api/nonstoptalk-rollback-guest-identity") {
				assert.equal(new Headers(init.headers).get("Cookie"), null);
				sequence.push("guest-identity");
				return guestIdentityResponse();
			}
			if (pathname.endsWith("/state")) {
				assert.equal(activeVersion, FAULT_VERSION);
				assert.equal(new Headers(init.headers).get("Cookie"), `nonstoptalk_token=${GUEST_TOKEN}`);
				sequence.push("fault-state");
				return seededRoomStateResponse();
			}
			assert.match(pathname, /\/join$/u);
			assert.equal(activeVersion, FAULT_VERSION);
			assert.equal(new Headers(init.headers).get("Cookie"), `nonstoptalk_token=${GUEST_TOKEN}`);
			joinAttempts += 1;
			sequence.push("fault-join");
			return joinedRoomResponse();
		},
		readDeployment: async () => deployment(activeVersion),
		readVersion: async (version) => version === CANDIDATE_VERSION
			? versionDocument(CANDIDATE_VERSION)
			: versionDocument(FAULT_VERSION, { database: false }),
		readSnapshot: async () => seedCreated ? baseline : beforeSeed,
		observeCandidateSeed: async (operation, version, readyOperation) => {
			assert.equal(version, CANDIDATE_VERSION);
			await readyOperation();
			sequence.push("seed-observer-ready");
			seedPrivateResult = await operation();
			seedPrivateHost = seedPrivateResult.host;
			return { result: seedPrivateResult, proofDigest: PROOF_DIGEST };
		},
		observeFaultSeededJoin: async (operations, version, proofDigest, readyOperation) => {
			assert.equal(version, FAULT_VERSION);
			assert.equal(proofDigest, PROOF_DIGEST);
			assert.equal(activeVersion, CANDIDATE_VERSION);
			assert.equal(seedPrivateResult.host, undefined);
			assert.equal(seedPrivateResult.created, undefined);
			assert.equal(seedPrivateHost.cookie, "");
			await readyOperation();
			sequence.push("fault-observer-ready");
			activeVersion = FAULT_VERSION;
			sequence.push("fault-activated");
			await operations.awaitActivation();
			await operations.stateOperation();
			await operations.beforeJoinOperation();
			return { result: await operations.joinOperation(), proofDigest: PROOF_DIGEST };
		},
		delay: async () => undefined,
		faultObservationDelayMs: 1,
		deploymentWaitAttempts: 1,
		deploymentWaitDelayMs: 0,
		faultStatusWaitAttempts: 2,
		faultStatusWaitDelayMs: 0,
		pollAttempts: 1,
		pollDelayMs: 0,
	});
	assert.deepEqual(result.baseline, baseline);
	assert.equal(result.proofDigest, PROOF_DIGEST);
	assert.equal(joinAttempts, 1);
	assert.equal(faultStatusReads, 2);
	assert.deepEqual(sequence, [
		"seed-observer-ready",
		"seed-create",
		"guest-identity",
		"fault-observer-ready",
		"fault-activated",
		"fault-state",
		"fault-join",
	]);
	assert.deepEqual(result.summary, {
		status: "ok",
		phase: "pending-joined-row-established",
		rollbackRequired: true,
		expectedReceiptsAfterRollback: 1,
		expectedRoomJoinedEventsAfterRollback: 1,
	});
	assert.doesNotMatch(JSON.stringify(result), /ABC234|private-player|aaaa|bbbb|e237d4e3|22222222/u);
});

test("prepare fails closed on an undrained seed or a deployment change between state and join", async () => {
	const beforeSeed = snapshot();
	const baseline = addDeltas(beforeSeed, CREATE_ONLY_DELTAS);
	const common = {
		...coordinates(),
		readVersion: async (version) => version === CANDIDATE_VERSION
			? versionDocument(CANDIDATE_VERSION)
			: versionDocument(FAULT_VERSION, { database: false }),
		delay: async () => undefined,
		faultObservationDelayMs: 1,
		deploymentWaitAttempts: 1,
		deploymentWaitDelayMs: 0,
		pollAttempts: 1,
		pollDelayMs: 0,
	};
	let activeVersion = CANDIDATE_VERSION;
	await assert.rejects(prepareRollbackDrainProof({
		...common,
		fetchImpl: async (url) => new URL(url).pathname === "/api/v1/platform/status"
			? healthyCandidateStatus()
			: createdRoomResponse(),
		readDeployment: async () => deployment(activeVersion),
		readSnapshot: async () => beforeSeed,
		observeCandidateSeed: async (operation, _version, readyOperation) => {
			await readyOperation();
			return { result: await operation(), proofDigest: PROOF_DIGEST };
		},
		observeFaultSeededJoin: async () => assert.fail("Fault observer must not start before seed drain."),
	}), /candidate seed create did not drain/u);

	activeVersion = CANDIDATE_VERSION;
	let activeDeploymentId = CANDIDATE_DEPLOYMENT;
	let seedCreated = false;
	await assert.rejects(prepareRollbackDrainProof({
		...common,
		fetchImpl: async (url) => {
			const pathname = new URL(url).pathname;
			if (pathname === "/api/v1/platform/status") {
				return activeVersion === CANDIDATE_VERSION ? healthyCandidateStatus() : faultStatus();
			}
			if (pathname === "/api/rooms") {
				seedCreated = true;
				return createdRoomResponse();
			}
			if (pathname === "/api/nonstoptalk-rollback-guest-identity") return guestIdentityResponse();
			if (pathname.endsWith("/state")) return seededRoomStateResponse();
			return joinedRoomResponse();
		},
		readDeployment: async () => deployment(activeVersion, activeDeploymentId),
		readSnapshot: async () => seedCreated ? baseline : beforeSeed,
		observeCandidateSeed: async (operation, _version, readyOperation) => {
			await readyOperation();
			return { result: await operation(), proofDigest: PROOF_DIGEST };
		},
		observeFaultSeededJoin: async (operations, _version, _proof, readyOperation) => {
			await readyOperation();
			activeVersion = FAULT_VERSION;
			activeDeploymentId = FAULT_DEPLOYMENT;
			await operations.awaitActivation();
			await operations.stateOperation();
			activeDeploymentId = "99999999-9999-4999-8999-999999999999";
			await operations.beforeJoinOperation();
			return { proofDigest: PROOF_DIGEST };
		},
	}), /changed deployments/u);
});

test("verify observes fault-to-pinned-A drain, rechecks proof, then proves legacy best-effort control", async () => {
	const baseline = snapshot();
	const drained = addDeltas(baseline, JOIN_ONLY_DELTAS);
	const legacy = addDeltas(drained, LEGACY_CREATE_DELTAS);
	const observations = [baseline, baseline, drained, drained, legacy];
	let observationIndex = 0;
	let rolledBack = false;
	let fetchCount = 0;
	const summary = await verifyRollbackDrainProof({
		...coordinates(),
		baseline,
		proofDigest: PROOF_DIGEST,
		fetchImpl: async (url) => {
			fetchCount += 1;
			return new URL(url).pathname === "/api/v1/platform/status"
				? healthyRollbackStatus()
				: createdRoomResponse();
		},
		readDeployment: async () => deployment(rolledBack ? ROLLBACK_VERSION : FAULT_VERSION),
		readVersion: async (version) => {
			if (version === CANDIDATE_VERSION) return versionDocument(CANDIDATE_VERSION);
			if (version === FAULT_VERSION) return versionDocument(FAULT_VERSION, { database: false });
			return rollbackDocument();
		},
		readSnapshot: async () => observations[observationIndex++],
		observeRollbackAlarm: async (operation, version, proofDigest, readyOperation) => {
			assert.equal(version, ROLLBACK_VERSION);
			assert.equal(proofDigest, PROOF_DIGEST);
			await readyOperation();
			rolledBack = true;
			return operation();
		},
		delay: async () => undefined,
		deploymentWaitAttempts: 2,
		deploymentWaitDelayMs: 0,
		pollAttempts: 1,
		pollDelayMs: 0,
	});
	assert.equal(observationIndex, observations.length);
	assert.equal(fetchCount, 2);
	assert.deepEqual(summary, {
		status: "ok",
		phase: "rollback-joined-drain-and-legacy-proved",
		receiptsAdded: 1,
		roomFactsAdded: 0,
		roomCreatedEventsAdded: 0,
		roomJoinedEventsAdded: 1,
		legacyReceiptsAdded: 0,
		legacyRoomFactsAdded: 1,
		legacyRoomCreatedEventsAdded: 1,
	});
	assert.doesNotMatch(JSON.stringify(summary), /ABC234|aaaa|e237d4e3|22222222/u);
});

test("verify refuses a changed pre-rollback snapshot and any third deployment", async () => {
	const common = {
		...coordinates(),
		baseline: snapshot(),
		proofDigest: PROOF_DIGEST,
		fetchImpl: async () => healthyRollbackStatus(),
		readVersion: async (version) => version === CANDIDATE_VERSION
			? versionDocument(CANDIDATE_VERSION)
			: version === FAULT_VERSION ? versionDocument(FAULT_VERSION, { database: false }) : rollbackDocument(),
		delay: async () => undefined,
		pollAttempts: 1,
		pollDelayMs: 0,
	};
	await assert.rejects(verifyRollbackDrainProof({
		...common,
		readDeployment: async () => deployment(FAULT_VERSION),
		readSnapshot: async () => snapshot({ receiptCount: 8 }),
		observeRollbackAlarm: async () => assert.fail("Observer must not start after baseline drift."),
	}), /changed a durable aggregate/u);

	let inObserver = false;
	await assert.rejects(verifyRollbackDrainProof({
		...common,
		readDeployment: async () => deployment(inObserver
			? "44444444-4444-4444-8444-444444444444"
			: FAULT_VERSION),
		readSnapshot: async () => snapshot(),
		observeRollbackAlarm: async (operation, _version, _proof, readyOperation) => {
			await readyOperation();
			inObserver = true;
			return operation();
		},
		deploymentWaitAttempts: 1,
		deploymentWaitDelayMs: 0,
	}), /left the reviewed fault-to-Release-A/u);
});

test("drain polling fails closed on overlap, cleanup, or exhaustion", async () => {
	const baseline = snapshot();
	const exact = addDeltas(baseline, JOIN_ONLY_DELTAS);
	for (const invalid of [
		{ ...exact, receiptCount: exact.receiptCount + 1 },
		{ ...baseline, roomFactCount: baseline.roomFactCount - 1 },
	]) await assert.rejects(pollForJoinedDrain({
		baseline,
		readSnapshot: async () => invalid,
		delay: async () => assert.fail("Overlap must stop immediately."),
		attempts: 2,
		delayMs: 1,
	}), /overlapped/u);
	await assert.rejects(pollForJoinedDrain({
		baseline,
		readSnapshot: async () => baseline,
		delay: async () => undefined,
		attempts: 2,
		delayMs: 1,
	}), /bounded window/u);
	assert.deepEqual(await pollForCreateDrain({
		baseline,
		readSnapshot: async () => addDeltas(baseline, CREATE_ONLY_DELTAS),
		attempts: 1,
		delayMs: 0,
	}), addDeltas(baseline, CREATE_ONLY_DELTAS));
});

test("checkpoint is private, coordinate/proof-bound, aggregate-only, exclusive, and bounded", async () => {
	const directory = await mkdtemp(join(tmpdir(), "nonstoptalk-checkpoint-test-"));
	try {
		const filename = checkpointFilename(coordinates(), PROOF_DIGEST);
		assert.match(filename, /^\.nonstoptalk-staging-rollback-drill-[0-9a-f]{64}-[0-9a-f]{64}\.json$/u);
		const pathname = join(directory, filename);
		const baseline = snapshot();
		await writeAggregateCheckpoint(pathname, baseline);
		assert.equal((await stat(pathname)).mode & 0o777, 0o600);
		assert.deepEqual(await readAggregateCheckpoint(pathname), baseline);
		assert.deepEqual(await locateAggregateCheckpoint(coordinates(), directory), {
			filename,
			pathname,
			proofDigest: PROOF_DIGEST,
		});
		await assert.rejects(writeAggregateCheckpoint(pathname, baseline), /could not be written safely/u);
		const hostilePath = join(directory, "hostile.json");
		await writeFile(hostilePath, JSON.stringify({ ...baseline, roomCode: "ABC234" }));
		await chmod(hostilePath, 0o600);
		await assert.rejects(readAggregateCheckpoint(hostilePath), /counters only/u);
		assert.notEqual(
			checkpointFilename(coordinates({ faultVersion: "55555555-5555-4555-8555-555555555555" }), PROOF_DIGEST),
			filename,
		);
		assert.match(CHECKPOINT_FILENAME_PREFIX, /^\.nonstoptalk/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Wrangler readers use fixed read-only staging argv and reject unsafe versions", async () => {
	const calls = [];
	const row = {
		receipt_count: 7,
		room_fact_count: 4,
		room_created_count: 4,
		room_joined_count: 1,
		game_started_count: 1,
		turn_completed_count: 2,
		game_finished_count: 1,
	};
	const readers = createStagingWranglerReaders({
		execFileImpl: async (executable, args, options) => {
			calls.push({ executable, args, options });
			if (args.includes("deployments")) return { stdout: JSON.stringify(deployment(FAULT_VERSION)), stderr: "" };
			if (args.includes("versions")) return { stdout: JSON.stringify(versionDocument(FAULT_VERSION, { database: false })), stderr: "" };
			return { stdout: JSON.stringify([{ success: true, results: [row] }]), stderr: "" };
		},
	});
	assert.deepEqual(await readers.readDeployment(), deployment(FAULT_VERSION));
	assert.equal((await readers.readVersion(FAULT_VERSION)).id, FAULT_VERSION);
	assert.deepEqual(await readers.readSnapshot(), snapshot());
	assert.deepEqual(calls[0].args.slice(1), ["deployments", "status", "--env", "staging", "--json"]);
	assert.deepEqual(calls[1].args.slice(1), ["versions", "view", FAULT_VERSION, "--env", "staging", "--json"]);
	assert.deepEqual(calls[2].args.slice(1), [
		"d1", "execute", "PLATFORM_DB", "--remote", "--env", "staging", "--json", "--command", D1_SNAPSHOT_SQL,
	]);
	for (const call of calls) {
		assert.equal(call.executable, process.execPath);
		assert.match(call.args[0], /node_modules\/wrangler\/bin\/wrangler\.js$/u);
		assert.equal(call.args.includes("--name"), false);
		assert.match(call.options.cwd, /\/NonStopTalk\/?$/u);
	}
	await assert.rejects(readers.readVersion("$(unsafe)"), /lowercase Worker UUID/u);
	assert.equal(calls.length, 3);
});
