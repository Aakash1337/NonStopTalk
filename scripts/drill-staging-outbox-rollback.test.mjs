import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CHECKPOINT_FILENAME_PREFIX,
	CREATE_ONLY_DELTAS,
	FAULT_CONFIG_FILENAME,
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
	createStagingWranglerReaders,
	findFaultTraceProof,
	hasRollbackTraceProof,
	locateAggregateCheckpoint,
	parseCliArguments,
	parseDeploymentStatus,
	parseJsonc,
	parseTailTraceStream,
	pollForCreateDrain,
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
const HOST_TOKEN = "a".repeat(64);
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

function deployment(version) {
	return { versions: [{ version_id: version, percentage: 100 }] };
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
		assert.deepEqual(parseJsonc(await readFile(outputPath, "utf8")).env.staging.d1_databases, []);
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
});

test("prepare claims pending only after causal trace proof and unchanged fault-bracketed counters", async () => {
	const baseline = snapshot();
	let fetchCount = 0;
	let snapshotCount = 0;
	const result = await prepareRollbackDrainProof({
		...coordinates(),
		fetchImpl: async (url) => {
			fetchCount += 1;
			return new URL(url).pathname === "/api/v1/platform/status" ? faultStatus() : createdRoomResponse();
		},
		readDeployment: async () => deployment(FAULT_VERSION),
		readVersion: async (version) => version === CANDIDATE_VERSION
			? versionDocument(CANDIDATE_VERSION)
			: versionDocument(FAULT_VERSION, { database: false }),
		readSnapshot: async () => { snapshotCount += 1; return baseline; },
		observeFaultRetry: async (operation, version, readyOperation) => {
			assert.equal(version, FAULT_VERSION);
			await readyOperation();
			return { result: await operation(), proofDigest: PROOF_DIGEST };
		},
		delay: async () => undefined,
		faultObservationDelayMs: 17,
	});
	assert.deepEqual(result.baseline, baseline);
	assert.equal(result.proofDigest, PROOF_DIGEST);
	assert.equal(fetchCount, 2);
	assert.equal(snapshotCount, 3);
	assert.deepEqual(result.summary, {
		status: "ok",
		phase: "pending-row-established",
		rollbackRequired: true,
		expectedReceiptsAfterRollback: 1,
	});
	assert.doesNotMatch(JSON.stringify(result.summary), /ABC234|private-player|aaaa|e237d4e3|22222222/u);
});

test("prepare never claims pending without observer proof or when a counter changes", async () => {
	const baseline = snapshot();
	const base = {
		...coordinates(),
		fetchImpl: async (url) => new URL(url).pathname === "/api/v1/platform/status"
			? faultStatus()
			: createdRoomResponse(),
		readDeployment: async () => deployment(FAULT_VERSION),
		readVersion: async (version) => version === CANDIDATE_VERSION
			? versionDocument(CANDIDATE_VERSION)
			: versionDocument(FAULT_VERSION, { database: false }),
		delay: async () => undefined,
		faultObservationDelayMs: 1,
	};
	await assert.rejects(prepareRollbackDrainProof({
		...base,
		readSnapshot: async () => baseline,
		observeFaultRetry: async () => ({ proofDigest: "not-a-proof" }),
	}), /proof digest/u);
	let reads = 0;
	await assert.rejects(prepareRollbackDrainProof({
		...base,
		readSnapshot: async () => ++reads === 1 ? baseline : addDeltas(baseline, CREATE_ONLY_DELTAS),
		observeFaultRetry: async (operation) => ({ result: await operation(), proofDigest: PROOF_DIGEST }),
	}), /changed a durable aggregate/u);
});

test("verify observes fault-to-pinned-A drain, rechecks proof, then proves legacy best-effort control", async () => {
	const baseline = snapshot();
	const drained = addDeltas(baseline, CREATE_ONLY_DELTAS);
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
		phase: "rollback-drain-and-legacy-proved",
		receiptsAdded: 1,
		roomFactsAdded: 1,
		roomCreatedEventsAdded: 1,
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
	const exact = addDeltas(baseline, CREATE_ONLY_DELTAS);
	for (const invalid of [
		{ ...exact, receiptCount: exact.receiptCount + 1 },
		{ ...baseline, roomFactCount: baseline.roomFactCount - 1 },
	]) await assert.rejects(pollForCreateDrain({
		baseline,
		readSnapshot: async () => invalid,
		delay: async () => assert.fail("Overlap must stop immediately."),
		attempts: 2,
		delayMs: 1,
	}), /overlapped/u);
	await assert.rejects(pollForCreateDrain({
		baseline,
		readSnapshot: async () => baseline,
		delay: async () => undefined,
		attempts: 2,
		delayMs: 1,
	}), /bounded window/u);
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
		assert.deepEqual(Object.keys(JSON.parse(await readFile(pathname, "utf8"))).sort(), Object.keys(baseline).sort());
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
