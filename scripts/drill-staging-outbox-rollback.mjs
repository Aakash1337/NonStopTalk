import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	lstat,
	open,
	readFile,
	readdir,
	unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import {
	D1_SNAPSHOT_SQL,
	EXPECTED_DELTAS,
	STAGING_ORIGIN,
	assertOutboxReadiness,
	createStagingRequester,
	parseD1Snapshot,
	runPublicRoomCreate,
} from "./smoke-staging-outbox.mjs";

export const STAGING_WORKER = "nonstoptalk-staging";
export const FAULT_CONFIG_FILENAME = ".nonstoptalk-staging-receiver-fault.jsonc";
export const CHECKPOINT_FILENAME_PREFIX = ".nonstoptalk-staging-rollback-drill-";
export const RELEASE_B_STAGING_VERSION = "f0c9fd39-cd0c-46b2-949d-756ea6ab1e5e";
export const RELEASE_B_SCRIPT_ETAG = "280b663aa9070bd051dc053deba6d3bc335d5d6855d4bde1b4fc4676772174f6";
export const RELEASE_A_STAGING_VERSION = "3116a969-0f6f-4977-959a-97fc3643ad79";
export const RELEASE_A_SCRIPT_ETAG = "197656136b6ace480ffbbc503c29f2d6c348fbc9c00aeb2fe7d318b4efcf78c1";
export const STAGING_D1_DATABASE_ID = "f9c14523-6f11-4cbe-99a1-85853a73ba96";
export const STAGING_DURABLE_OBJECT_NAMESPACE_ID = "9125b9bb4db94637ba0eaaeaa594fb49";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER_ENTRY = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const WRANGLER_PACKAGE_PATH = fileURLToPath(new URL("../node_modules/wrangler/package.json", import.meta.url));
const WRANGLER_TAIL_READINESS_PRELOAD = fileURLToPath(new URL("./wrangler-tail-readiness-preload.cjs", import.meta.url));
const SOURCE_CONFIG_PATH = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const FAULT_CONFIG_PATH = fileURLToPath(new URL(`../${FAULT_CONFIG_FILENAME}`, import.meta.url));
const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PROOF_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const DURABLE_OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_FAULT_OBSERVATION_DELAY_MS = 8_000;
const DEFAULT_DRAIN_POLL_ATTEMPTS = 120;
const DEFAULT_DRAIN_POLL_DELAY_MS = 5_000;
const DEFAULT_DEPLOYMENT_WAIT_ATTEMPTS = 300;
const DEFAULT_DEPLOYMENT_WAIT_DELAY_MS = 2_000;
const DEFAULT_FAULT_STATUS_WAIT_ATTEMPTS = 120;
const DEFAULT_FAULT_STATUS_WAIT_DELAY_MS = 2_000;
const MAX_WRANGLER_OUTPUT_BYTES = 1_024 * 1_024;
const MAX_TAIL_OUTPUT_BYTES = 512 * 1_024;
const MAX_CHECKPOINT_BYTES = 4_096;
export const PINNED_WRANGLER_TAIL_VERSION = "4.127.1";
export const WRANGLER_TAIL_PING_LINE = "Tail: Sending ping to tail websocket";
export const WRANGLER_TAIL_PONG_LINE = "Tail: Received pong from tail websocket";
const SNAPSHOT_FIELDS = Object.freeze(Object.keys(EXPECTED_DELTAS));
const execFileAsync = promisify(execFile);

export const CREATE_ONLY_DELTAS = Object.freeze({
	receiptCount: 1,
	roomFactCount: 1,
	roomCreatedCount: 1,
	roomJoinedCount: 0,
	gameStartedCount: 0,
	turnCompletedCount: 0,
	gameFinishedCount: 0,
});

export const JOIN_ONLY_DELTAS = Object.freeze({
	receiptCount: 1,
	roomFactCount: 0,
	roomCreatedCount: 0,
	roomJoinedCount: 1,
	gameStartedCount: 0,
	turnCompletedCount: 0,
	gameFinishedCount: 0,
});

export const LEGACY_CREATE_DELTAS = Object.freeze({
	receiptCount: 0,
	roomFactCount: 1,
	roomCreatedCount: 1,
	roomJoinedCount: 0,
	gameStartedCount: 0,
	turnCompletedCount: 0,
	gameFinishedCount: 0,
});

function fail(message) {
	throw new Error(message);
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function requirePinnedWranglerTailVersion(value) {
	if (value !== PINNED_WRANGLER_TAIL_VERSION) {
		return fail("The rollback drill's pinned Wrangler tail contract is unavailable.");
	}
	return value;
}

async function assertPinnedWranglerTailRuntime() {
	let document;
	try {
		document = JSON.parse(await readFile(WRANGLER_PACKAGE_PATH, "utf8"));
	} catch {
		return fail("The rollback drill's pinned Wrangler tail contract is unavailable.");
	}
	requirePinnedWranglerTailVersion(document?.version);
}

export function requireStagingWorker(value) {
	if (value !== STAGING_WORKER) {
		return fail("Refusing to run: the exact staging Worker name is required.");
	}
	return STAGING_WORKER;
}

export function requireVersionId(value, label = "Worker") {
	if (typeof value !== "string" || !VERSION_ID_PATTERN.test(value)) {
		return fail(`Refusing to run: ${label} version must be a lowercase Worker UUID.`);
	}
	return value;
}

export function requireDrillCoordinates({
	origin,
	worker,
	candidateVersion,
	faultVersion,
	rollbackVersion,
}) {
	const checkedOrigin = new URL(STAGING_ORIGIN);
	let suppliedOrigin;
	try {
		suppliedOrigin = new URL(origin);
	} catch {
		return fail("Refusing to run: the exact staging origin is required.");
	}
	if (
		suppliedOrigin.href !== checkedOrigin.href
		|| suppliedOrigin.username !== ""
		|| suppliedOrigin.password !== ""
	) {
		return fail("Refusing to run: the exact staging origin is required.");
	}
	requireStagingWorker(worker);
	const versions = [
		requireVersionId(candidateVersion, "candidate"),
		requireVersionId(faultVersion, "fault"),
		requireVersionId(rollbackVersion, "rollback"),
	];
	if (versions[0] !== RELEASE_B_STAGING_VERSION) {
		return fail("Refusing to run: candidate must use the pinned reviewed Release-B staging version.");
	}
	if (versions[2] !== RELEASE_A_STAGING_VERSION) {
		return fail("Refusing to run: rollback must use the pinned reviewed Release-A staging version.");
	}
	if (new Set(versions).size !== versions.length) {
		return fail("Refusing to run: candidate, fault, and rollback versions must be distinct.");
	}
	return {
		origin: STAGING_ORIGIN,
		worker: STAGING_WORKER,
		candidateVersion: versions[0],
		faultVersion: versions[1],
		rollbackVersion: versions[2],
	};
}

function coordinateDigest(coordinates) {
	const checked = requireDrillCoordinates(coordinates);
	return createHash("sha256")
		.update([
			checked.candidateVersion,
			checked.faultVersion,
			checked.rollbackVersion,
		].join("\n"), "utf8")
		.digest("hex");
}

function requireProofDigest(value) {
	if (typeof value !== "string" || !PROOF_DIGEST_PATTERN.test(value)) {
		return fail("The rollback proof digest is invalid.");
	}
	return value;
}

function durableObjectProofDigest(value) {
	if (typeof value !== "string" || !DURABLE_OBJECT_ID_PATTERN.test(value)) {
		return fail("The Durable Object trace identity is invalid.");
	}
	return createHash("sha256")
		.update(`nonstoptalk-staging-rollback-drill-v1\n${value}`, "utf8")
		.digest("hex");
}

export function checkpointFilename(coordinates, proofDigest) {
	return `${CHECKPOINT_FILENAME_PREFIX}${coordinateDigest(coordinates)}-${requireProofDigest(proofDigest)}.json`;
}

function stripJsonComments(source) {
	let output = "";
	let inString = false;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		const next = source[index + 1];
		if (lineComment) {
			if (character === "\n" || character === "\r") {
				lineComment = false;
				output += character;
			} else output += " ";
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				output += "  ";
				index += 1;
				blockComment = false;
			} else output += character === "\n" || character === "\r" ? character : " ";
			continue;
		}
		if (inString) {
			output += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			output += character;
			continue;
		}
		if (character === "/" && next === "/") {
			lineComment = true;
			output += "  ";
			index += 1;
			continue;
		}
		if (character === "/" && next === "*") {
			blockComment = true;
			output += "  ";
			index += 1;
			continue;
		}
		output += character;
	}
	if (inString || blockComment) fail("The Wrangler JSONC configuration is incomplete.");
	return output;
}

function stripTrailingCommas(source) {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (inString) {
			output += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			output += character;
			continue;
		}
		if (character === ",") {
			let cursor = index + 1;
			while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
			if (source[cursor] === "}" || source[cursor] === "]") continue;
		}
		output += character;
	}
	return output;
}

export function parseJsonc(source) {
	if (typeof source !== "string" || source.trim() === "") {
		return fail("The Wrangler JSONC configuration is empty.");
	}
	try {
		const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(source)));
		if (!isObject(parsed)) fail("The Wrangler JSONC root must be an object.");
		return parsed;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("The Wrangler")) throw error;
		return fail("The Wrangler JSONC configuration could not be parsed.");
	}
}

function expectedStagingD1(config) {
	if (config.name !== "nonstoptalk") {
		return fail("The source configuration is not the reviewed NonStopTalk Worker.");
	}
	if (config.vars?.ROOM_MILESTONE_DELIVERY_MODE !== "best-effort") {
		return fail("Production must remain explicitly configured for best-effort delivery.");
	}
	const staging = config.env?.staging;
	if (!isObject(staging) || staging.name !== STAGING_WORKER) {
		return fail("The source configuration does not contain the exact staging Worker.");
	}
	if (staging.vars?.ROOM_MILESTONE_DELIVERY_MODE !== "outbox") {
		return fail("The staging candidate must be explicitly configured for exact outbox delivery.");
	}
	const databases = staging.d1_databases;
	if (
		!Array.isArray(databases)
		|| databases.length !== 1
		|| !isObject(databases[0])
		|| databases[0].binding !== "PLATFORM_DB"
		|| typeof databases[0].database_id !== "string"
		|| databases[0].database_id === ""
	) {
		return fail("The staging candidate must contain exactly one PLATFORM_DB binding.");
	}
	return databases[0];
}

export function assertOnlyReceiverFaultConfigChange(candidate, fault) {
	if (!isObject(candidate) || !isObject(fault)) {
		return fail("The receiver-fault configuration comparison is invalid.");
	}
	expectedStagingD1(candidate);
	const expected = structuredClone(candidate);
	expected.env.staging.d1_databases = [];
	if (!isDeepStrictEqual(expected, fault)) {
		return fail("The receiver-fault configuration may remove only staging PLATFORM_DB.");
	}
	if (fault.vars?.ROOM_MILESTONE_DELIVERY_MODE !== "best-effort") {
		return fail("Production must remain explicitly configured for best-effort delivery.");
	}
	if (fault.env?.staging?.vars?.ROOM_MILESTONE_DELIVERY_MODE !== "outbox") {
		return fail("The receiver-fault staging configuration must remain exact outbox.");
	}
}

export function buildReceiverFaultConfig(source) {
	const candidate = parseJsonc(source);
	expectedStagingD1(candidate);
	const fault = structuredClone(candidate);
	fault.env.staging.d1_databases = [];
	assertOnlyReceiverFaultConfigChange(candidate, fault);
	return `${JSON.stringify(fault, null, "\t")}\n`;
}

async function writeExclusivePrivateFile(pathname, contents, description) {
	let handle;
	let created = false;
	try {
		const noFollow = fsConstants.O_NOFOLLOW ?? 0;
		handle = await open(
			pathname,
			fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
			0o600,
		);
		created = true;
		await handle.writeFile(contents, { encoding: "utf8" });
		await handle.sync();
		await handle.chmod(0o600);
	} catch {
		if (created) await unlink(pathname).catch(() => undefined);
		return fail(`${description} could not be written safely; remove any stale temporary file first.`);
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function writeReceiverFaultConfig({
	sourcePath = SOURCE_CONFIG_PATH,
	outputPath = FAULT_CONFIG_PATH,
} = {}) {
	let source;
	try {
		source = await readFile(sourcePath, { encoding: "utf8" });
	} catch {
		return fail("The reviewed Wrangler configuration could not be read.");
	}
	const contents = buildReceiverFaultConfig(source);
	await writeExclusivePrivateFile(outputPath, contents, "The temporary receiver-fault configuration");
	return outputPath;
}

function normalizedSnapshot(value, exactKeys = false) {
	if (!isObject(value)) return fail("The aggregate D1 snapshot is invalid.");
	if (
		exactKeys
		&& (
			Object.keys(value).length !== SNAPSHOT_FIELDS.length
			|| Object.keys(value).some((field) => !SNAPSHOT_FIELDS.includes(field))
		)
	) {
		return fail("The aggregate checkpoint may contain counters only.");
	}
	const result = {};
	for (const field of SNAPSHOT_FIELDS) {
		if (!safeInteger(value[field])) return fail("The aggregate D1 snapshot is invalid.");
		result[field] = value[field];
	}
	return result;
}

export async function writeAggregateCheckpoint(pathname, snapshot) {
	const checked = normalizedSnapshot(snapshot, true);
	await writeExclusivePrivateFile(
		pathname,
		`${JSON.stringify(checked)}\n`,
		"The aggregate rollback checkpoint",
	);
}

export async function readAggregateCheckpoint(pathname) {
	let handle;
	try {
		const noFollow = fsConstants.O_NOFOLLOW ?? 0;
		handle = await open(pathname, fsConstants.O_RDONLY | noFollow);
		const metadata = await handle.stat();
		if (
			!metadata.isFile()
			|| (metadata.mode & 0o077) !== 0
			|| metadata.size < 2
			|| metadata.size > MAX_CHECKPOINT_BYTES
		) {
			return fail("The aggregate rollback checkpoint is invalid.");
		}
		const document = JSON.parse(await handle.readFile({ encoding: "utf8" }));
		return normalizedSnapshot(document, true);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("The aggregate")) throw error;
		return fail("The aggregate rollback checkpoint could not be read.");
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function locateAggregateCheckpoint(coordinates, directory = PROJECT_ROOT) {
	const prefix = `${CHECKPOINT_FILENAME_PREFIX}${coordinateDigest(coordinates)}-`;
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return fail("The aggregate rollback checkpoint directory could not be read.");
	}
	const matching = entries.filter((entry) => entry.name.startsWith(prefix));
	if (matching.length !== 1 || !matching[0].isFile()) {
		return fail("Exactly one coordinate-bound aggregate rollback checkpoint is required.");
	}
	const filename = matching[0].name;
	const proofDigest = filename.slice(prefix.length, -".json".length);
	if (
		!filename.endsWith(".json")
		|| checkpointFilename(coordinates, proofDigest) !== filename
	) return fail("The aggregate rollback checkpoint name is invalid.");
	return {
		filename,
		pathname: resolve(directory, filename),
		proofDigest,
	};
}

function parseJsonDocument(stdout, description) {
	if (typeof stdout !== "string" || stdout.length === 0 || stdout.length > MAX_WRANGLER_OUTPUT_BYTES) {
		return fail(`${description} returned an unexpected shape.`);
	}
	try {
		return JSON.parse(stdout);
	} catch {
		return fail(`${description} returned an unexpected shape.`);
	}
}

export function parseDeploymentStatus(stdout) {
	const document = parseJsonDocument(stdout, "The staging deployment query");
	if (!isObject(document) || !Array.isArray(document.versions)) {
		return fail("The staging deployment query returned an unexpected shape.");
	}
	return document;
}

export function assertSingleVersionDeployment(document, expectedVersion) {
	const checkedVersion = requireVersionId(expectedVersion, "expected");
	const activeVersion = singleVersionDeploymentId(document);
	if (activeVersion !== checkedVersion) {
		return fail("The staging Worker is not serving the expected single version at 100 percent.");
	}
}

function singleVersionDeploymentId(document) {
	if (
		!isObject(document)
		|| !Array.isArray(document.versions)
		|| document.versions.length !== 1
		|| !isObject(document.versions[0])
		|| document.versions[0].percentage !== 100
	) {
		return fail("The staging Worker is not serving the expected single version at 100 percent.");
	}
	return requireVersionId(document.versions[0].version_id, "active");
}

function deploymentIdentity(document, expectedVersion) {
	assertSingleVersionDeployment(document, expectedVersion);
	if (typeof document.id !== "string" || !VERSION_ID_PATTERN.test(document.id)) {
		return fail("The staging deployment identity is missing or invalid.");
	}
	return document.id;
}

function assertSameDeployment(document, expectedVersion, expectedDeploymentId) {
	if (deploymentIdentity(document, expectedVersion) !== expectedDeploymentId) {
		return fail("Staging changed deployments during the same-object version-affinity proof.");
	}
}

function canonicalValue(value) {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
	);
}

function canonicalString(value) {
	return JSON.stringify(canonicalValue(value));
}

function versionResources(document, expectedVersion, label) {
	const checkedVersion = requireVersionId(expectedVersion, label);
	if (
		!isObject(document)
		|| document.id !== checkedVersion
		|| !isObject(document.resources)
		|| !isObject(document.resources.script)
		|| !Array.isArray(document.resources.bindings)
	) {
		return fail(`The ${label} version query returned an unexpected shape.`);
	}
	return document.resources;
}

function requireBinding(bindings, name, type, label) {
	const matches = bindings.filter((binding) => (
		isObject(binding) && binding.name === name && binding.type === type
	));
	if (matches.length !== 1) {
		return fail(`The ${label} version is missing a required reviewed binding.`);
	}
	return matches[0];
}

function assertOperationalBindings(bindings, label, requireDatabase) {
	requireBinding(bindings, "ROOMS", "durable_object_namespace", label);
	requireBinding(bindings, "ASSETS", "assets", label);
	requireBinding(bindings, "ANALYTICS_ADMIN_TOKEN", "secret_text", label);
	requireBinding(bindings, "ROOM_FACT_HASH_KEY", "secret_text", label);
	const databases = bindings.filter((binding) => isObject(binding) && binding.type === "d1");
	if (requireDatabase) {
		requireBinding(bindings, "PLATFORM_DB", "d1", label);
		if (databases.length !== 1) return fail(`The ${label} version has an unexpected D1 binding set.`);
	} else if (databases.length !== 0) {
		return fail(`The ${label} version must not contain a D1 binding.`);
	}
}

function normalizeResources(resources, removePlatformDatabase) {
	const copy = structuredClone(resources);
	copy.bindings = copy.bindings
		.filter((binding) => !(
			removePlatformDatabase
			&& isObject(binding)
			&& binding.name === "PLATFORM_DB"
			&& binding.type === "d1"
		))
		.sort((left, right) => canonicalString(left).localeCompare(canonicalString(right)));
	return canonicalValue(copy);
}

export function assertReceiverFaultVersionDiff({
	candidateDocument,
	faultDocument,
	candidateVersion,
	faultVersion,
}) {
	const candidate = versionResources(candidateDocument, candidateVersion, "candidate");
	const fault = versionResources(faultDocument, faultVersion, "fault");
	assertOperationalBindings(candidate.bindings, "candidate", true);
	assertOperationalBindings(fault.bindings, "fault", false);
	if (candidate.script.etag !== RELEASE_B_SCRIPT_ETAG) {
		return fail("The candidate version is not the pinned reviewed Release-B script artifact.");
	}
	const database = requireBinding(candidate.bindings, "PLATFORM_DB", "d1", "candidate");
	if (database.id !== STAGING_D1_DATABASE_ID) {
		return fail("The candidate version is not bound to the reviewed staging D1 database.");
	}
	const rooms = requireBinding(candidate.bindings, "ROOMS", "durable_object_namespace", "candidate");
	if (rooms.namespace_id !== STAGING_DURABLE_OBJECT_NAMESPACE_ID) {
		return fail("The candidate version is not bound to the reviewed staging room namespace.");
	}
	const mode = requireBinding(candidate.bindings, "ROOM_MILESTONE_DELIVERY_MODE", "plain_text", "candidate");
	if (mode.text !== "outbox") {
		return fail("The candidate version is not configured for exact outbox delivery.");
	}
	if (!isDeepStrictEqual(normalizeResources(candidate, true), normalizeResources(fault, false))) {
		return fail("The fault version differs from the candidate by more than staging PLATFORM_DB.");
	}
}

export function assertRollbackVersionResources(document, expectedVersion) {
	const resources = versionResources(document, expectedVersion, "rollback");
	assertOperationalBindings(resources.bindings, "rollback", true);
	if (resources.script.etag !== RELEASE_A_SCRIPT_ETAG) {
		return fail("The rollback version is not the pinned reviewed Release-A script artifact.");
	}
	const database = requireBinding(resources.bindings, "PLATFORM_DB", "d1", "rollback");
	if (database.id !== STAGING_D1_DATABASE_ID) {
		return fail("The rollback version is not bound to the reviewed staging D1 database.");
	}
	const rooms = requireBinding(resources.bindings, "ROOMS", "durable_object_namespace", "rollback");
	if (rooms.namespace_id !== STAGING_DURABLE_OBJECT_NAMESPACE_ID) {
		return fail("The rollback version is not bound to the reviewed staging room namespace.");
	}
	const mode = requireBinding(resources.bindings, "ROOM_MILESTONE_DELIVERY_MODE", "plain_text", "rollback");
	if (mode.text !== "best-effort") {
		return fail("The rollback version is not configured for reviewed best-effort delivery.");
	}
}

export function createStagingWranglerReaders({ execFileImpl = execFileAsync } = {}) {
	if (typeof execFileImpl !== "function") fail("A Wrangler process adapter is required.");
	async function run(args, errorMessage) {
		let output;
		try {
			output = await execFileImpl(process.execPath, [WRANGLER_ENTRY, ...args], {
				cwd: PROJECT_ROOT,
				encoding: "utf8",
				maxBuffer: MAX_WRANGLER_OUTPUT_BYTES,
				timeout: 30_000,
				windowsHide: true,
				env: { ...process.env, CI: "1", NO_COLOR: "1" },
			});
		} catch {
			return fail(errorMessage);
		}
		if (!isObject(output) || typeof output.stdout !== "string") return fail(errorMessage);
		return output.stdout;
	}
	return {
		async readDeployment() {
			// The staging environment already declares name=nonstoptalk-staging.
			// Supplying that suffixed name again alongside --env targets a different
			// script in current Wrangler; proof traces validate scriptName in-band.
			const stdout = await run([
				"deployments", "status",
				"--env", "staging",
				"--json",
			], "The staging deployment could not be read.");
			return parseDeploymentStatus(stdout);
		},
		async readVersion(version) {
			const checked = requireVersionId(version, "queried");
			const stdout = await run([
				"versions", "view", checked,
				"--env", "staging",
				"--json",
			], "The staging Worker version could not be read.");
			return parseJsonDocument(stdout, "The staging Worker version query");
		},
		async readSnapshot() {
			const stdout = await run([
				"d1", "execute", "PLATFORM_DB",
				"--remote",
				"--env", "staging",
				"--json",
				"--command", D1_SNAPSHOT_SQL,
			], "The staging aggregate D1 counters could not be read.");
			return parseD1Snapshot(stdout);
		},
	};
}

export function stagingTailArguments(kind, version, format = "json") {
	const checked = requireVersionId(version, "tailed");
	if (kind !== "seed" && kind !== "fault" && kind !== "rollback") {
		return fail("The staging tail proof kind is invalid.");
	}
	if (format !== "json" && format !== "pretty") {
		return fail("The staging tail format is invalid.");
	}
	return [
		WRANGLER_ENTRY,
		"tail",
		// Deliberately config-resolved: a positional already-suffixed Worker plus
		// --env staging resolves as nonstoptalk-staging-staging in current Wrangler.
		"--env", "staging",
		"--format", format,
		"--version-id", checked,
	];
}

function traceLogRecords(document) {
	const records = [];
	for (const log of document.logs) {
		const message = log.message;
		const values = Array.isArray(message) ? message : [message];
		for (const value of values) if (isObject(value)) records.push(value);
	}
	return records;
}

function traceLogValueCount(document) {
	let count = 0;
	for (const log of document.logs) count += Array.isArray(log.message) ? log.message.length : 1;
	return count;
}

function unexpectedTraceLogCount(document) {
	if (safeInteger(document.unexpectedLogs)) return document.unexpectedLogs;
	const outboxCount = traceLogRecords(document).filter((record) => (
		typeof record.event === "string" && record.event.startsWith("room_milestone_outbox_")
	)).length;
	return traceLogValueCount(document) - outboxCount;
}

function projectTailDocument(document) {
	if (!isObject(document)) return document;
	const event = isObject(document.event) ? document.event : undefined;
	let projectedEvent;
	if (typeof event?.type === "string") {
		projectedEvent = { type: event.type };
	} else if (isObject(event?.request)) {
		let pathname = null;
		const retainInternalRoomPath = document.executionModel === "durableObject"
			&& document.entrypoint === "RoomDurableObject";
		if (retainInternalRoomPath) {
			try {
				pathname = new URL(event.request.url).pathname;
			} catch {
				// Retain only a null invalid marker; never retain the raw URL.
			}
		}
		projectedEvent = {
			request: {
				method: event.request.method,
				...(retainInternalRoomPath ? { pathname } : {}),
			},
			...(isObject(event.response) ? { response: { status: event.response.status } } : {}),
		};
	} else if (event?.scheduledTime !== undefined) {
		projectedEvent = {
			scheduledTime: true,
			...(event.cron !== undefined ? { cron: true } : {}),
		};
	} else if (event) projectedEvent = {};

	let projectedLogs;
	let unexpectedLogs;
	if (Array.isArray(document.logs)) {
		projectedLogs = [];
		unexpectedLogs = 0;
		for (const log of document.logs) {
			const values = Array.isArray(log.message) ? log.message : [log.message];
			for (const record of values) {
				if (
					!isObject(record)
					|| typeof record.event !== "string"
					|| !record.event.startsWith("room_milestone_outbox_")
				) {
					unexpectedLogs += 1;
					continue;
				}
				projectedLogs.push({
					level: "proof",
					message: [{
						event: record.event,
						...(record.failure !== undefined ? { failure: record.failure } : {}),
						...(record.attemptCount !== undefined ? { attemptCount: record.attemptCount } : {}),
					}],
				});
			}
		}
	}
	return {
		scriptName: document.scriptName,
		scriptVersion: isObject(document.scriptVersion) ? { id: document.scriptVersion.id } : undefined,
		entrypoint: document.entrypoint,
		durableObjectId: document.durableObjectId,
		executionModel: document.executionModel,
		outcome: document.outcome,
		truncated: document.truncated,
		exceptions: Array.isArray(document.exceptions)
			? (document.exceptions.length === 0 ? [] : [true])
			: undefined,
		logs: projectedLogs,
		unexpectedLogs,
		event: projectedEvent,
	};
}

function isAlarmTrace(document) {
	return isObject(document.event)
		&& document.event.scheduledTime !== undefined
		&& document.event.cron === undefined;
}

function retryAttemptValueKind(retryScheduled) {
	if (retryScheduled.length !== 1) return "ambiguous-record-count";
	const value = retryScheduled[0].attemptCount;
	if (value === undefined) return "missing";
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return "non-finite-number";
		if (!Number.isInteger(value)) return "fractional-number";
		if (!Number.isSafeInteger(value)) return "unsafe-integer-number";
		if (value > 0) return "positive-safe-integer";
		return value === 0 ? "zero" : "negative-safe-integer";
	}
	if (isObject(value)) return "object";
	if (typeof value === "string") return "string";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "bigint") return "bigint";
	if (typeof value === "symbol") return "symbol";
	if (typeof value === "function") return "function";
	return "other";
}

function safeFaultRetryShape(outboxLogs, deliveryFailed, retryScheduled) {
	return {
		outboxLogCount: outboxLogs.length,
		deliveryFailedCount: deliveryFailed.length,
		retryScheduledCount: retryScheduled.length,
		databaseUnavailable: retryScheduled.length === 1
			&& retryScheduled[0].failure === "database-unavailable",
		attemptCountKind: retryAttemptValueKind(retryScheduled),
	};
}

function faultRetryAlarmEvidence(document) {
	if (!isAlarmTrace(document)) return null;
	const logs = traceLogRecords(document);
	const outboxLogs = logs.filter((record) => (
		typeof record.event === "string"
		&& record.event.startsWith("room_milestone_outbox_")
	));
	if (outboxLogs.length === 0) return null;
	if (!isSuccessfulDurableObjectTrace(document)) {
		return fail("A fault-version outbox alarm did not have successful Room Durable Object metadata.");
	}
	if (unexpectedTraceLogCount(document) !== 0) {
		return fail("A fault-version outbox alarm emitted an unexpected log.");
	}
	if (outboxLogs.some((record) => (
		record.event !== "room_milestone_outbox_delivery_failed"
		&& record.event !== "room_milestone_outbox_retry_scheduled"
	))) return fail("A fault-version outbox alarm emitted an unexpected or terminal outbox event.");
	const deliveryFailed = outboxLogs.filter((record) => (
		record.event === "room_milestone_outbox_delivery_failed"
	));
	const retryScheduled = outboxLogs.filter((record) => (
		record.event === "room_milestone_outbox_retry_scheduled"
	));
	if (
		outboxLogs.length !== 1
		|| deliveryFailed.length !== 0
		|| retryScheduled.length !== 1
		|| retryScheduled[0].failure !== "database-unavailable"
		|| !safeInteger(retryScheduled[0].attemptCount)
		|| retryScheduled[0].attemptCount < 1
	) return fail(
		`A fault-version retry alarm was split or incomplete. Safe retry shape: ${JSON.stringify(
			safeFaultRetryShape(outboxLogs, deliveryFailed, retryScheduled),
		)}`,
	);
	return {
		durableObjectId: document.durableObjectId,
		attemptCount: retryScheduled[0].attemptCount,
	};
}

function assertSafeTailDocuments(documents, version) {
	const checkedVersion = requireVersionId(version, "tailed");
	if (!Array.isArray(documents)) return fail("The staging tail trace stream is malformed.");
	for (const document of documents) {
		if (!isObject(document)) return fail("The staging tail trace stream is malformed.");
		if (isObject(document.event) && typeof document.event.type === "string") {
			return fail("The staging tail reported overload, sampling, or dropped trace data.");
		}
		if (
			document.truncated !== false
			|| document.scriptName !== STAGING_WORKER
			|| document.scriptVersion?.id !== checkedVersion
			|| !Array.isArray(document.logs)
			|| !Array.isArray(document.exceptions)
			|| document.exceptions.length !== 0
			|| !isObject(document.event)
			|| typeof document.outcome !== "string"
			|| typeof document.executionModel !== "string"
		) return fail("The staging tail trace stream is incomplete or malformed.");
	}
}

function isSuccessfulDurableObjectTrace(document) {
	return document.executionModel === "durableObject"
		&& document.entrypoint === "RoomDurableObject"
		&& document.outcome === "ok"
		&& typeof document.durableObjectId === "string"
		&& DURABLE_OBJECT_ID_PATTERN.test(document.durableObjectId);
}

function traceRequestPathname(document) {
	const request = document.event?.request;
	if (!isObject(request) || typeof request.method !== "string") return null;
	if (typeof request.pathname === "string") return request.pathname;
	try {
		return new URL(request.url).pathname;
	} catch {
		return fail("A Durable Object proof trace URL is malformed.");
	}
}

function assertTraceHasNoLogs(document, message) {
	if (traceLogValueCount(document) !== 0 || unexpectedTraceLogCount(document) !== 0) {
		return fail(message);
	}
}

function candidateSeedEvidence(documents, version) {
	assertSafeTailDocuments(documents, version);
	const creates = [];
	const cleanAlarms = [];
	let candidateAttachmentTraceCount = 0;
	let roomDurableObjectTraceCount = 0;
	for (const [index, document] of documents.entries()) {
		if (
			document.executionModel === "stateless"
			&& document.outcome === "ok"
			&& document.event.request?.method === "HEAD"
			&& document.event.response?.status === 200
			&& traceLogValueCount(document) === 0
			&& unexpectedTraceLogCount(document) === 0
		) candidateAttachmentTraceCount += 1;
		if (!isSuccessfulDurableObjectTrace(document)) continue;
		roomDurableObjectTraceCount += 1;
		const pathname = traceRequestPathname(document);
		if (document.event.request?.method === "POST" && pathname === "/create") {
			if (document.event.response?.status !== 201) {
				return fail("The candidate seed Durable Object create was not a successful 201 response.");
			}
			assertTraceHasNoLogs(document, "The candidate seed create emitted an unexpected log.");
			creates.push({ index, durableObjectId: document.durableObjectId });
		}
		if (!isAlarmTrace(document)) continue;
		if (unexpectedTraceLogCount(document) !== 0) {
			return fail("The candidate seed alarm emitted an unexpected log.");
		}
		if (traceLogRecords(document).some((record) => (
			typeof record.event === "string"
			&& record.event.startsWith("room_milestone_outbox_")
		))) return fail("The candidate seed alarm did not cleanly acknowledge its outbox row.");
		if (traceLogValueCount(document) === 0) {
			cleanAlarms.push({ index, durableObjectId: document.durableObjectId });
		}
	}
	const matchingAlarms = creates.length === 1
		? cleanAlarms.filter((alarm) => (
			alarm.durableObjectId === creates[0].durableObjectId && alarm.index > creates[0].index
		))
		: [];
	return {
		candidateAttachmentTraceCount,
		cleanAlarms,
		creates,
		matchingAlarms,
		roomDurableObjectTraceCount,
	};
}

export function candidateSeedProofProgress(documents, version) {
	const evidence = candidateSeedEvidence(documents, version);
	return {
		projectedTraceCount: documents.length,
		candidateAttachmentTraceCount: evidence.candidateAttachmentTraceCount,
		roomDurableObjectTraceCount: evidence.roomDurableObjectTraceCount,
		successfulCreateCount: evidence.creates.length,
		cleanAlarmCount: evidence.cleanAlarms.length,
		matchingCleanAlarmCount: evidence.matchingAlarms.length,
	};
}

export function hasCandidateTailAttachmentBarrier(documents, version) {
	return candidateSeedEvidence(documents, version).candidateAttachmentTraceCount >= 1;
}

export function findCandidateSeedProof(documents, version) {
	const { creates, matchingAlarms } = candidateSeedEvidence(documents, version);
	if (creates.length > 1) return fail("Concurrent staging room creation made the candidate seed proof ambiguous.");
	if (creates.length === 0) return null;
	const create = creates[0];
	if (matchingAlarms.length === 0) return null;
	if (matchingAlarms.length !== 1) return fail("The candidate seed acknowledgement proof was ambiguous.");
	return durableObjectProofDigest(create.durableObjectId);
}

export function hasFaultStateBarrier(documents, version, expectedProofDigest) {
	assertSafeTailDocuments(documents, version);
	const checkedDigest = requireProofDigest(expectedProofDigest);
	const matchingStates = [];
	for (const [index, document] of documents.entries()) {
		if (!isSuccessfulDurableObjectTrace(document)) continue;
		const pathname = traceRequestPathname(document);
		if (document.event.request?.method !== "GET" || pathname !== "/state") continue;
		if (durableObjectProofDigest(document.durableObjectId) !== checkedDigest) continue;
		if (document.event.response?.status !== 200) {
			return fail("The fault-version seeded-room state barrier was not a successful 200 response.");
		}
		assertTraceHasNoLogs(document, "The fault-version seeded-room state barrier emitted an unexpected log.");
		matchingStates.push({ index, durableObjectId: document.durableObjectId });
	}
	return matchingStates.length >= 1;
}

export function findFaultSeededJoinProof(documents, version, expectedProofDigest) {
	assertSafeTailDocuments(documents, version);
	const checkedDigest = requireProofDigest(expectedProofDigest);
	const states = [];
	const joins = [];
	const retryAlarms = [];
	for (const [index, document] of documents.entries()) {
		// A version-filtered tail can include an already-scheduled alarm from an
		// older room after the fault version becomes active. A complete successful
		// alarm attributed to another object cannot satisfy this causal proof and
		// is ignored; exact D1 deltas independently guard any aggregate effect.
		const unrelatedAlarm = isAlarmTrace(document)
			&& isSuccessfulDurableObjectTrace(document)
			&& durableObjectProofDigest(document.durableObjectId) !== checkedDigest;
		const retryAlarm = unrelatedAlarm ? null : faultRetryAlarmEvidence(document);
		if (
			retryAlarm
			&& durableObjectProofDigest(retryAlarm.durableObjectId) === checkedDigest
		) retryAlarms.push({ index, ...retryAlarm });
		if (!isSuccessfulDurableObjectTrace(document)) continue;
		const pathname = traceRequestPathname(document);
		const method = document.event.request?.method;
		const digest = durableObjectProofDigest(document.durableObjectId);
		if (method === "GET" && pathname === "/state" && digest === checkedDigest) {
			if (document.event.response?.status !== 200) {
				return fail("The fault-version seeded-room state barrier was not a successful 200 response.");
			}
			assertTraceHasNoLogs(document, "The fault-version seeded-room state barrier emitted an unexpected log.");
			states.push({ index, durableObjectId: document.durableObjectId });
		}
		if (method === "POST") {
			if (pathname !== "/join" || digest !== checkedDigest) {
				return fail("A concurrent staging room mutation made the seeded-room fault proof ambiguous.");
			}
			if (document.event.response?.status !== 200) {
				return fail("The fault-version seeded-room join was not a successful 200 response.");
			}
			assertTraceHasNoLogs(document, "The fault-version seeded-room join emitted an unexpected log.");
			joins.push({ index, durableObjectId: document.durableObjectId });
		}
	}
	if (joins.length > 1) {
		return fail("The seeded-room fault proof was ambiguous.");
	}
	if (states.length === 0 || joins.length === 0 || retryAlarms.length === 0) return null;
	if (
		retryAlarms[0].attemptCount !== 1
		|| retryAlarms.some((alarm, index) => (
			index > 0 && alarm.attemptCount !== retryAlarms[index - 1].attemptCount + 1
		))
	) return fail("The seeded-room fault proof did not retain one complete sequential first-retry chain.");
	const stateBeforeJoin = states.findLast((state) => state.index < joins[0].index);
	if (
		!stateBeforeJoin
		|| stateBeforeJoin.durableObjectId !== joins[0].durableObjectId
		|| retryAlarms.some((alarm) => (
			joins[0].durableObjectId !== alarm.durableObjectId
			|| joins[0].index >= alarm.index
		))
	) return fail("The seeded-room state, join, and first retry were not one ordered Durable Object proof.");
	return checkedDigest;
}

export function findFaultTraceProof(documents, version) {
	assertSafeTailDocuments(documents, version);
	const creates = [];
	for (const [index, document] of documents.entries()) {
		if (!isSuccessfulDurableObjectTrace(document)) continue;
		const request = document.event.request;
		if (isObject(request) && request.method === "POST") {
			let pathname;
			if (typeof request.pathname === "string") pathname = request.pathname;
			else try {
				pathname = new URL(request.url).pathname;
			} catch {
				return fail("The fault Durable Object create trace URL is malformed.");
			}
			if (pathname === "/create") {
				if (document.event.response?.status !== 201) {
					return fail("The fault Durable Object create trace was not a successful 201 response.");
				}
				if (traceLogValueCount(document) !== 0 || unexpectedTraceLogCount(document) !== 0) {
					return fail("The fault Durable Object create trace emitted an unexpected log.");
				}
				creates.push({ index, durableObjectId: document.durableObjectId });
			}
		}
	}
	if (creates.length > 1) return fail("Concurrent staging room creation made the fault proof ambiguous.");
	if (creates.length === 0) return null;
	const create = creates[0];
	const matchingRetryAlarms = [];
	for (const [index, document] of documents.entries()) {
		const unrelatedAlarm = isAlarmTrace(document)
			&& isSuccessfulDurableObjectTrace(document)
			&& document.durableObjectId !== create.durableObjectId;
		const retryAlarm = unrelatedAlarm ? null : faultRetryAlarmEvidence(document);
		if (retryAlarm) matchingRetryAlarms.push({ index, ...retryAlarm });
	}
	if (matchingRetryAlarms.length === 0) return null;
	if (
		matchingRetryAlarms[0].attemptCount !== 1
		|| matchingRetryAlarms.some((alarm, index) => (
			alarm.index <= create.index
			|| (index > 0 && alarm.attemptCount !== matchingRetryAlarms[index - 1].attemptCount + 1)
		))
	) return fail("The fault retry was not caused by the one created Durable Object.");
	return durableObjectProofDigest(create.durableObjectId);
}

export function hasRollbackTraceProof(documents, version, expectedProofDigest) {
	assertSafeTailDocuments(documents, version);
	const checkedDigest = requireProofDigest(expectedProofDigest);
	for (const document of documents) {
		if (
			!isAlarmTrace(document)
			|| document.executionModel !== "durableObject"
			|| document.entrypoint !== "RoomDurableObject"
		) continue;
		if (
			typeof document.durableObjectId === "string"
			&& DURABLE_OBJECT_ID_PATTERN.test(document.durableObjectId)
			&& durableObjectProofDigest(document.durableObjectId) === checkedDigest
		) {
			if (document.outcome !== "ok") {
				return fail("The pinned Release-A alarm for the proved Durable Object was not successful.");
			}
			if (unexpectedTraceLogCount(document) !== 0) {
				return fail("The pinned Release-A alarm emitted an unexpected log.");
			}
			if (traceLogRecords(document).some((record) => (
				typeof record.event === "string"
				&& record.event.startsWith("room_milestone_outbox_")
			))) {
				return fail("The pinned Release-A alarm did not cleanly drain the proved Durable Object.");
			}
			return true;
		}
	}
	return false;
}

function createJsonDocumentAccumulator({ ignoredLines = [] } = {}) {
	let pending = "";
	let totalBytes = 0;
	let parsingError;
	const documents = [];
	const ignored = new Set(ignoredLines);
	function parseAvailable() {
		let cursor = 0;
		while (cursor < pending.length) {
			while (/\s/u.test(pending[cursor] ?? "")) cursor += 1;
			if (cursor >= pending.length) break;
			if (pending[cursor] !== "{") {
				const lineEnd = pending.indexOf("\n", cursor);
				if (lineEnd < 0) {
					pending = pending.slice(cursor);
					return;
				}
				const line = pending.slice(cursor, lineEnd).replace(/\r$/u, "");
				if (ignored.has(line)) {
					cursor = lineEnd + 1;
					continue;
				}
				parsingError = new Error("The staging tail emitted non-JSON output.");
				return;
			}
			const start = cursor;
			let depth = 0;
			let inString = false;
			let escaped = false;
			for (; cursor < pending.length; cursor += 1) {
				const character = pending[cursor];
				if (inString) {
					if (escaped) escaped = false;
					else if (character === "\\") escaped = true;
					else if (character === '"') inString = false;
					continue;
				}
				if (character === '"') inString = true;
				else if (character === "{" || character === "[") depth += 1;
				else if (character === "}" || character === "]") depth -= 1;
				if (depth < 0) {
					parsingError = new Error("The staging tail emitted malformed JSON.");
					return;
				}
				if (depth === 0) {
					cursor += 1;
					try {
						documents.push(projectTailDocument(JSON.parse(pending.slice(start, cursor))));
					} catch {
						parsingError = new Error("The staging tail emitted malformed JSON.");
						return;
					}
					break;
				}
			}
			if (depth > 0 || inString) {
				pending = pending.slice(start);
				return;
			}
		}
		pending = pending.slice(cursor);
	}
	return {
		append(chunk) {
			if (parsingError) return;
			const text = typeof chunk === "string" ? chunk : chunk?.toString?.("utf8") ?? "";
			totalBytes += Buffer.byteLength(text, "utf8");
			if (totalBytes > MAX_TAIL_OUTPUT_BYTES) {
				parsingError = new Error("The staging tail exceeded its output bound.");
				return;
			}
			pending += text;
			parseAvailable();
		},
		state() {
			if (parsingError) throw parsingError;
			return { documents, atBoundary: pending.trim() === "" };
		},
	};
}

export function createWranglerJsonTailAccumulator() {
	const documents = createJsonDocumentAccumulator({
		ignoredLines: [WRANGLER_TAIL_PING_LINE, WRANGLER_TAIL_PONG_LINE],
	});
	let pendingLine = "";
	let preReadyBytes = 0;
	let readinessError;
	let sawPing = false;
	let ready = false;

	return {
		append(chunk) {
			if (readinessError) return;
			const text = typeof chunk === "string" ? chunk : chunk?.toString?.("utf8") ?? "";
			if (ready) {
				documents.append(text);
				return;
			}
			preReadyBytes += Buffer.byteLength(text, "utf8");
			if (preReadyBytes > MAX_TAIL_OUTPUT_BYTES) {
				readinessError = new Error("The staging tail readiness stream exceeded its output bound.");
				return;
			}
			pendingLine += text;
			while (!ready) {
				const lineEnd = pendingLine.indexOf("\n");
				if (lineEnd < 0) break;
				const line = pendingLine.slice(0, lineEnd).replace(/\r$/u, "");
				pendingLine = pendingLine.slice(lineEnd + 1);
				if (line === WRANGLER_TAIL_PING_LINE) sawPing = true;
				else if (sawPing && line === WRANGLER_TAIL_PONG_LINE) {
					ready = true;
					const remaining = pendingLine;
					pendingLine = "";
					if (remaining !== "") documents.append(remaining);
				}
			}
		},
		state() {
			if (readinessError) throw readinessError;
			const state = documents.state();
			return { ...state, ready };
		},
	};
}

export function parseTailTraceStream(source) {
	if (typeof source !== "string") return fail("The staging tail trace stream is malformed.");
	const accumulator = createJsonDocumentAccumulator();
	accumulator.append(source);
	const state = accumulator.state();
	if (!state.atBoundary) return fail("The staging tail trace stream ended inside a JSON document.");
	return state.documents;
}

export function createStagingTailObservers({
	spawnImpl = spawn,
	onReady = () => undefined,
	delay = sleep,
	warmupMs = 250,
	tailReadyWaitMs = 30_000,
	candidateAttachmentTraceWaitMs = 45_000,
	candidateAttachmentProbeWaitMs = 2_000,
	candidateSeedTraceWaitMs = 120_000,
	stateBarrierAttempts = 12,
	stateBarrierTraceWaitMs = 5_000,
	stateBarrierRetryDelayMs = 1_000,
} = {}) {
	if (typeof spawnImpl !== "function" || typeof onReady !== "function" || typeof delay !== "function") {
		fail("A staging tail process adapter is required.");
	}
	if (!Number.isSafeInteger(warmupMs) || warmupMs < 0 || warmupMs > 30_000) {
		fail("The staging tail warm-up bound is invalid.");
	}
	if (!Number.isSafeInteger(tailReadyWaitMs) || tailReadyWaitMs < 1 || tailReadyWaitMs > 60_000) {
		fail("The staging tail readiness bound is invalid.");
	}
	if (
		!Number.isSafeInteger(candidateAttachmentTraceWaitMs)
		|| candidateAttachmentTraceWaitMs < 1
		|| candidateAttachmentTraceWaitMs > 120_000
		|| !Number.isSafeInteger(candidateAttachmentProbeWaitMs)
		|| candidateAttachmentProbeWaitMs < 1
		|| candidateAttachmentProbeWaitMs > 30_000
		|| !Number.isSafeInteger(candidateSeedTraceWaitMs)
		|| candidateSeedTraceWaitMs < 1
		|| candidateSeedTraceWaitMs > 180_000
	) fail("The candidate seed trace observation bound is invalid.");
	if (
		!Number.isSafeInteger(stateBarrierAttempts)
		|| stateBarrierAttempts < 1
		|| stateBarrierAttempts > 30
		|| !Number.isSafeInteger(stateBarrierTraceWaitMs)
		|| stateBarrierTraceWaitMs < 1
		|| stateBarrierTraceWaitMs > 30_000
		|| !Number.isSafeInteger(stateBarrierRetryDelayMs)
		|| stateBarrierRetryDelayMs < 0
		|| stateBarrierRetryDelayMs > 30_000
	) fail("The seeded-room state barrier retry bound is invalid.");

	function startTail(kind, version, format) {
		let child;
		try {
			const childArguments = stagingTailArguments(kind, version, format);
			const childEnvironment = {
				...process.env,
				CI: "1",
				NO_COLOR: "1",
				WRANGLER_SEND_METRICS: "false",
				WRANGLER_WRITE_LOGS: "false",
			};
			if (format === "json") {
				childArguments.unshift("--require", WRANGLER_TAIL_READINESS_PRELOAD);
				// Isolate the proof child from unreviewed inherited Node preloads and
				// policies; the reviewed readiness preload is supplied as exact argv.
				childEnvironment.NODE_OPTIONS = "";
				childEnvironment.WRANGLER_LOG = "debug";
				childEnvironment.WRANGLER_LOG_SANITIZE = "true";
			}
			child = spawnImpl(process.execPath, childArguments, {
				cwd: PROJECT_ROOT,
				env: childEnvironment,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
			});
		} catch {
			return fail("The version-filtered staging tail could not be started.");
		}
		if (
			!isObject(child)
			|| typeof child.stdout?.on !== "function"
			|| typeof child.stderr?.on !== "function"
			|| typeof child.kill !== "function"
			|| typeof child.once !== "function"
		) return fail("The version-filtered staging tail could not be started.");
		let terminal = false;
		let stderrBytes = 0;
		let stderrSeen = false;
		let text = "";
		const stdoutDecoder = new StringDecoder("utf8");
		const accumulator = format === "json" ? createWranglerJsonTailAccumulator() : null;
		child.stdout.on("data", (chunk) => {
			const decoded = typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
			if (accumulator) accumulator.append(decoded);
			else {
				text += decoded;
				if (Buffer.byteLength(text, "utf8") > MAX_TAIL_OUTPUT_BYTES) child.kill("SIGINT");
			}
		});
		child.stdout.on("end", () => {
			const decoded = stdoutDecoder.end();
			if (decoded === "") return;
			if (accumulator) accumulator.append(decoded);
			else text += decoded;
		});
		child.stderr.on("data", (chunk) => {
			stderrSeen = true;
			stderrBytes += Buffer.byteLength(
				typeof chunk === "string" ? chunk : chunk?.toString?.("utf8") ?? "",
				"utf8",
			);
			if (stderrBytes > MAX_TAIL_OUTPUT_BYTES) child.kill("SIGINT");
		});
		child.once("error", () => { terminal = true; });
		child.once("exit", () => { terminal = true; });
		return {
			get terminal() { return terminal; },
			get hasStderr() { return stderrSeen; },
			get text() { return text; },
			accumulator,
			async stop() {
				if (!terminal) child.kill("SIGINT");
				for (let attempt = 0; attempt < 40 && !terminal; attempt += 1) await delay(50);
				if (!terminal) child.kill("SIGKILL");
			},
		};
	}

	function resolveWaitMessage(message) {
		const resolved = typeof message === "function" ? message() : message;
		if (typeof resolved !== "string" || resolved === "") {
			return fail("A staging tail wait failure message is invalid.");
		}
		return resolved;
	}

	async function waitFor(tail, predicate, timeoutMs, message) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			if (tail.hasStderr) return fail("The version-filtered staging tail emitted an error or warning.");
			if (predicate()) return;
			if (tail.terminal) return fail(resolveWaitMessage(message));
			await delay(50);
		}
		return fail(resolveWaitMessage(message));
	}

	async function waitForMaybe(tail, predicate, timeoutMs, terminalMessage) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			if (tail.hasStderr) return fail("The version-filtered staging tail emitted an error or warning.");
			if (predicate()) return true;
			if (tail.terminal) return fail(terminalMessage);
			await delay(50);
		}
		return false;
	}

	async function attachJsonTail(kind, version) {
		await assertPinnedWranglerTailRuntime();
		const jsonTail = startTail(kind, version, "json");
		try {
			// Pinned Wrangler emits this ordered debug ping/pong pair only from the
			// same JSON tail process after that exact WebSocket opens. The preload
			// suppresses every other debug record before it enters the proof pipe.
			await waitFor(
				jsonTail,
				() => jsonTail.accumulator.state().ready,
				tailReadyWaitMs,
				"The version-filtered staging JSON tail did not prove its own transport readiness.",
			);
			await delay(warmupMs);
			await waitFor(
				jsonTail,
				() => {
					const state = jsonTail.accumulator.state();
					return state.ready && state.atBoundary;
				},
				5_000,
				"The version-filtered staging JSON tail did not reach a trace boundary.",
			);
			return jsonTail;
		} catch (error) {
			await jsonTail.stop();
			throw error;
		}
	}

	async function observeCandidateSeed(
		operation,
		version,
		readyOperation = () => undefined,
		attachmentOperation = () => undefined,
	) {
		if (
			typeof operation !== "function"
			|| typeof readyOperation !== "function"
			|| typeof attachmentOperation !== "function"
		) {
			fail("A candidate seed tail operation is required.");
		}
		const jsonTail = await attachJsonTail("seed", version);
		try {
			const startIndex = jsonTail.accumulator.state().documents.length;
			const observedDocuments = () => (
				jsonTail.accumulator.state().documents.slice(startIndex)
			);
			await readyOperation();
			const attachmentDeadline = Date.now() + candidateAttachmentTraceWaitMs;
			let attachmentObserved = false;
			do {
				await attachmentOperation();
				const remaining = Math.max(1, attachmentDeadline - Date.now());
				attachmentObserved = await waitForMaybe(
					jsonTail,
					() => hasCandidateTailAttachmentBarrier(observedDocuments(), version),
					Math.min(candidateAttachmentProbeWaitMs, remaining),
					"The candidate JSON tail stopped before its exact-version attachment barrier.",
				);
			} while (!attachmentObserved && Date.now() < attachmentDeadline);
			if (!attachmentObserved) {
				fail(`The candidate JSON tail emitted no exact-version attachment barrier inside the bounded observation window. Safe projected progress: ${JSON.stringify(candidateSeedProofProgress(observedDocuments(), version))}`);
			}
			// Recheck the pinned candidate deployment and unchanged D1 snapshot
			// after proving that the JSON stream itself receives live traces.
			await readyOperation();
			const result = await operation();
			let proofDigest;
			await waitFor(
				jsonTail,
				() => {
					proofDigest = findCandidateSeedProof(
						observedDocuments(),
						version,
					);
					return proofDigest !== null;
				},
				candidateSeedTraceWaitMs,
				() => `The candidate seed emitted no same-object create and clean acknowledgement proof inside the bounded observation window. Safe projected progress: ${JSON.stringify(candidateSeedProofProgress(observedDocuments(), version))}`,
			);
			return { result, proofDigest };
		} finally {
			await jsonTail.stop();
		}
	}

	async function observeFaultSeededJoin(operations, version, expectedProofDigest, readyOperation = () => undefined) {
		const required = [
			"awaitActivation", "stateOperation", "beforeJoinOperation", "joinOperation",
		];
		if (!isObject(operations) || required.some((name) => typeof operations[name] !== "function")) {
			fail("The seeded-room fault tail operations are invalid.");
		}
		if (typeof readyOperation !== "function") fail("A staging tail readiness operation is required.");
		const checkedDigest = requireProofDigest(expectedProofDigest);
		const jsonTail = await attachJsonTail("fault", version);
		try {
			const startIndex = jsonTail.accumulator.state().documents.length;
			await readyOperation();
			// This signal is the authorization boundary for the separate shell to
			// activate the already-validated receiver-fault version.
			await onReady("fault");
			await operations.awaitActivation();
			let stateBarrierObserved = false;
			for (let attempt = 1; attempt <= stateBarrierAttempts; attempt += 1) {
				await operations.stateOperation();
				stateBarrierObserved = await waitForMaybe(
					jsonTail,
					() => hasFaultStateBarrier(
						jsonTail.accumulator.state().documents.slice(startIndex),
						version,
						checkedDigest,
					),
					stateBarrierTraceWaitMs,
					"The fault-version staging tail stopped before the seeded-room state barrier.",
				);
				if (stateBarrierObserved) break;
				if (attempt < stateBarrierAttempts) await delay(stateBarrierRetryDelayMs);
			}
			if (!stateBarrierObserved) {
				fail("The fault version emitted no same-object seeded-room state barrier inside the bounded retry window.");
			}
			await operations.beforeJoinOperation();
			const result = await operations.joinOperation();
			let proofDigest;
			await waitFor(
				jsonTail,
				() => {
					proofDigest = findFaultSeededJoinProof(
						jsonTail.accumulator.state().documents.slice(startIndex),
						version,
						checkedDigest,
					);
					return proofDigest !== null;
				},
				45_000,
				"The fault version emitted no causal seeded-room join retry proof. Do not retry under this fault deployment; restore Release B, verify the one attempted join has resolved, rebaseline, and start a fresh seeded-room drill.",
			);
			return { result, proofDigest };
		} finally {
			await jsonTail.stop();
		}
	}

	async function observeRollbackAlarm(operation, version, proofDigest, readyOperation = () => undefined) {
		if (typeof operation !== "function" || typeof readyOperation !== "function") {
			fail("A rollback tail operation is required.");
		}
		const checkedDigest = requireProofDigest(proofDigest);
		const jsonTail = await attachJsonTail("rollback", version);
		try {
			const startIndex = jsonTail.accumulator.state().documents.length;
			await readyOperation();
			await onReady("rollback");
			const result = await operation();
			await waitFor(
				jsonTail,
				() => hasRollbackTraceProof(
					jsonTail.accumulator.state().documents.slice(startIndex),
					version,
					checkedDigest,
				),
				20_000,
				"The pinned Release-A version emitted no correlated successful alarm proof.",
			);
			return result;
		} finally {
			await jsonTail.stop();
		}
	}
	return {
		observeCandidateSeed,
		observeFaultSeededJoin,
		observeRollbackAlarm,
	};
}

export function assertReceiverFaultStatus(result) {
	if (
		!isObject(result)
		|| result.status !== 503
		|| !isObject(result.payload)
		|| !isObject(result.payload.error)
		|| result.payload.error.code !== "DATABASE_UNAVAILABLE"
		|| result.payload.status !== undefined
		|| result.payload.capabilities !== undefined
	) {
		return fail("The temporary fault version did not fail readiness at the D1 receiver boundary.");
	}
}

export function assertRollbackReadiness(result) {
	if (
		!isObject(result)
		|| result.status !== 200
		|| !isObject(result.payload)
		|| result.payload.status !== "ok"
		|| result.payload.schemaVersion !== 6
		|| result.payload.capabilities?.aggregateAnalytics?.delivery !== "best-effort"
		|| result.payload.capabilities?.roomFacts?.status !== "ready"
		|| result.payload.capabilities?.retentionCleanup?.status !== "ready"
	) {
		return fail("Release A staging readiness is not healthy best-effort on schema 6.");
	}
}

function exactSnapshotDelta(baseline, observed, deltas) {
	const start = normalizedSnapshot(baseline);
	const current = normalizedSnapshot(observed);
	for (const field of SNAPSHOT_FIELDS) {
		if (!safeInteger(deltas[field])) return fail("The expected aggregate delta is invalid.");
		if (current[field] !== start[field] + deltas[field]) return false;
	}
	return true;
}

function assertUnchangedSnapshot(baseline, observed) {
	if (!exactSnapshotDelta(baseline, observed, Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, 0])))) {
		return fail("The receiver-fault interval changed a durable aggregate counter.");
	}
}

async function pollForExactDelta({
	baseline,
	deltas,
	readSnapshot,
	delay = sleep,
	attempts = DEFAULT_DRAIN_POLL_ATTEMPTS,
	delayMs = DEFAULT_DRAIN_POLL_DELAY_MS,
	overlapMessage,
	exhaustedMessage,
}) {
	const start = normalizedSnapshot(baseline);
	const checkedDeltas = normalizedSnapshot(deltas, true);
	if (typeof readSnapshot !== "function" || typeof delay !== "function") {
		return fail("The rollback drain adapters are invalid.");
	}
	if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 240) {
		return fail("The rollback drain polling bound is invalid.");
	}
	if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
		return fail("The rollback drain polling delay is invalid.");
	}
	const expected = Object.fromEntries(
		SNAPSHOT_FIELDS.map((field) => [field, start[field] + checkedDeltas[field]]),
	);
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const observed = normalizedSnapshot(await readSnapshot());
		if (SNAPSHOT_FIELDS.every((field) => observed[field] === expected[field])) return observed;
		if (SNAPSHOT_FIELDS.some((field) => observed[field] < start[field] || observed[field] > expected[field])) {
			return fail(overlapMessage);
		}
		if (attempt < attempts) await delay(delayMs);
	}
	return fail(exhaustedMessage);
}

export async function pollForCreateDrain(options) {
	return pollForExactDelta({
		...options,
		deltas: CREATE_ONLY_DELTAS,
		overlapMessage: "Another staging write or cleanup overlapped the candidate seed drain proof.",
		exhaustedMessage: "The candidate seed create did not drain inside the bounded window.",
	});
}

export async function pollForJoinedDrain(options) {
	return pollForExactDelta({
		...options,
		deltas: JOIN_ONLY_DELTAS,
		overlapMessage: "Another staging write or cleanup overlapped the rollback joined-row drain proof.",
		exhaustedMessage: "The Release-A rollback bridge did not drain the pending joined row inside the bounded window.",
	});
}

export async function pollForLegacyCreate(options) {
	return pollForExactDelta({
		...options,
		deltas: LEGACY_CREATE_DELTAS,
		overlapMessage: "Another staging write or cleanup overlapped the Release-A legacy control.",
		exhaustedMessage: "The Release-A legacy best-effort create did not converge inside the bounded window.",
	});
}

function requireAdapters(adapters, names) {
	for (const name of names) {
		if (typeof adapters[name] !== "function") return fail("A rollback drill adapter is missing.");
	}
}

async function waitForRollbackDeployment({
	readDeployment,
	delay,
	faultVersion,
	rollbackVersion,
	attempts,
	delayMs,
}) {
	if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 600) {
		return fail("The rollback deployment wait bound is invalid.");
	}
	if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
		return fail("The rollback deployment wait delay is invalid.");
	}
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const active = singleVersionDeploymentId(await readDeployment());
		if (active === rollbackVersion) return;
		if (active !== faultVersion) {
			return fail("Staging left the reviewed fault-to-Release-A deployment path.");
		}
		if (attempt < attempts) await delay(delayMs);
	}
	return fail("The reviewed Release-A staging rollback was not observed inside the bounded window.");
}

async function waitForFaultDeployment({
	readDeployment,
	delay,
	candidateVersion,
	faultVersion,
	attempts,
	delayMs,
}) {
	if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 600) {
		return fail("The fault deployment wait bound is invalid.");
	}
	if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
		return fail("The fault deployment wait delay is invalid.");
	}
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const deployment = await readDeployment();
		const active = singleVersionDeploymentId(deployment);
		if (active === faultVersion) return deploymentIdentity(deployment, faultVersion);
		if (active !== candidateVersion) {
			return fail("Staging left the reviewed Release-B-to-fault deployment path.");
		}
		if (attempt < attempts) await delay(delayMs);
	}
	return fail("The reviewed staging receiver-fault deployment was not observed inside the bounded window.");
}

async function waitForReceiverFaultStatus({
	request,
	assertDeployment,
	delay,
	attempts,
	delayMs,
}) {
	if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 240) {
		return fail("The receiver-fault readiness wait bound is invalid.");
	}
	if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
		return fail("The receiver-fault readiness wait delay is invalid.");
	}
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		await assertDeployment();
		const status = await request(null, "/api/v1/platform/status");
		await assertDeployment();
		try {
			assertReceiverFaultStatus(status);
			return;
		} catch (error) {
			// The deployment API can converge before public request routing. Permit
			// only the exact reviewed candidate readiness shape while it catches up.
			try {
				assertOutboxReadiness(status);
			} catch {
				throw error;
			}
		}
		if (attempt < attempts) await delay(delayMs);
	}
	return fail("The receiver-fault public readiness boundary did not converge inside the bounded window.");
}

export async function validateFaultPreflight({
	origin = STAGING_ORIGIN,
	worker = STAGING_WORKER,
	candidateVersion,
	faultVersion,
	rollbackVersion,
	readDeployment,
	readVersion,
}) {
	const coordinates = requireDrillCoordinates({
		origin,
		worker,
		candidateVersion,
		faultVersion,
		rollbackVersion,
	});
	requireAdapters({ readDeployment, readVersion }, ["readDeployment", "readVersion"]);
	assertSingleVersionDeployment(await readDeployment(), coordinates.candidateVersion);
	const [candidateDocument, faultDocument, rollbackDocument] = await Promise.all([
		readVersion(coordinates.candidateVersion),
		readVersion(coordinates.faultVersion),
		readVersion(coordinates.rollbackVersion),
	]);
	assertReceiverFaultVersionDiff({
		candidateDocument,
		faultDocument,
		candidateVersion: coordinates.candidateVersion,
		faultVersion: coordinates.faultVersion,
	});
	assertRollbackVersionResources(rollbackDocument, coordinates.rollbackVersion);
	assertSingleVersionDeployment(await readDeployment(), coordinates.candidateVersion);
	return {
		status: "ok",
		phase: "fault-version-validated",
		activationPerformed: false,
	};
}

export async function prepareRollbackDrainProof({
	origin = STAGING_ORIGIN,
	worker = STAGING_WORKER,
	candidateVersion,
	faultVersion,
	rollbackVersion,
	fetchImpl,
	readDeployment,
	readVersion,
	readSnapshot,
	observeCandidateSeed,
	observeFaultSeededJoin,
	delay = sleep,
	faultObservationDelayMs = DEFAULT_FAULT_OBSERVATION_DELAY_MS,
	deploymentWaitAttempts = DEFAULT_DEPLOYMENT_WAIT_ATTEMPTS,
	deploymentWaitDelayMs = DEFAULT_DEPLOYMENT_WAIT_DELAY_MS,
	faultStatusWaitAttempts = DEFAULT_FAULT_STATUS_WAIT_ATTEMPTS,
	faultStatusWaitDelayMs = DEFAULT_FAULT_STATUS_WAIT_DELAY_MS,
	pollAttempts = DEFAULT_DRAIN_POLL_ATTEMPTS,
	pollDelayMs = DEFAULT_DRAIN_POLL_DELAY_MS,
}) {
	const coordinates = requireDrillCoordinates({
		origin,
		worker,
		candidateVersion,
		faultVersion,
		rollbackVersion,
	});
	requireAdapters({
		fetchImpl,
		readDeployment,
		readVersion,
		readSnapshot,
		observeCandidateSeed,
		observeFaultSeededJoin,
		delay,
	}, [
		"fetchImpl", "readDeployment", "readVersion", "readSnapshot",
		"observeCandidateSeed", "observeFaultSeededJoin", "delay",
	]);
	if (
		!Number.isSafeInteger(faultObservationDelayMs)
		|| faultObservationDelayMs < 1
		|| faultObservationDelayMs > 60_000
	) return fail("The receiver-fault observation window is invalid.");

	assertSingleVersionDeployment(await readDeployment(), coordinates.candidateVersion);
	const [candidateDocument, faultDocument] = await Promise.all([
		readVersion(coordinates.candidateVersion),
		readVersion(coordinates.faultVersion),
	]);
	assertReceiverFaultVersionDiff({
		candidateDocument,
		faultDocument,
		candidateVersion: coordinates.candidateVersion,
		faultVersion: coordinates.faultVersion,
	});

	const request = createStagingRequester({ origin: coordinates.origin, fetchImpl });
	assertOutboxReadiness(await request(null, "/api/v1/platform/status"));
	const readCandidateSnapshot = async () => {
		assertSingleVersionDeployment(await readDeployment(), coordinates.candidateVersion);
		const observed = await readSnapshot();
		assertSingleVersionDeployment(await readDeployment(), coordinates.candidateVersion);
		return observed;
	};
	const beforeSeed = normalizedSnapshot(await readCandidateSnapshot(), true);
	const observedSeed = await observeCandidateSeed(
		async () => runPublicRoomCreate(request),
		coordinates.candidateVersion,
		async () => {
			assertSingleVersionDeployment(await readDeployment(), coordinates.candidateVersion);
			assertUnchangedSnapshot(beforeSeed, await readCandidateSnapshot());
		},
		async () => {
			assertSingleVersionDeployment(await readDeployment(), coordinates.candidateVersion);
			const attachment = await request(null, "/api/v1/platform/status", { method: "HEAD" });
			if (attachment.status !== 200) {
				return fail("The candidate JSON-tail attachment barrier did not return a successful 200 response.");
			}
			assertSingleVersionDeployment(await readDeployment(), coordinates.candidateVersion);
		},
	);
	if (!isObject(observedSeed) || !isObject(observedSeed.result)) {
		return fail("The candidate seed observer returned an invalid proof.");
	}
	const proofDigest = requireProofDigest(observedSeed.proofDigest);
	const seedHost = observedSeed.result.host;
	const seedCode = observedSeed.result.created?.code;
	if (
		!isObject(seedHost)
		|| typeof seedHost.cookie !== "string"
		|| seedHost.cookie === ""
		|| typeof seedCode !== "string"
		|| !/^[A-HJ-NP-Z2-9]{6}$/u.test(seedCode)
	) return fail("The candidate seed observer returned an invalid public room result.");
	// The create observer has already validated the public payload. Retain only
	// the one routing code needed for the same-object barrier.
	observedSeed.result.created = undefined;
	const baseline = normalizedSnapshot(await pollForCreateDrain({
		baseline: beforeSeed,
		readSnapshot: readCandidateSnapshot,
		delay,
		attempts: pollAttempts,
		delayMs: pollDelayMs,
	}), true);

	// Mint a distinct outer-Worker identity before attaching the inactive fault
	// tail. This 404 path reaches neither a Durable Object nor D1.
	const guest = { cookie: "" };
	const guestIdentity = await request(guest, "/api/nonstoptalk-rollback-guest-identity");
	if (
		guestIdentity.status !== 404
		|| guestIdentity.payload?.error !== "Not found."
		|| !guest.cookie
		|| guest.cookie === seedHost.cookie
	) return fail("The seeded-room drill could not establish a distinct guest identity.");
	// Distinctness is now proved. The host credential is never needed again.
	seedHost.cookie = "";
	observedSeed.result.host = undefined;
	observedSeed.result = undefined;
	assertUnchangedSnapshot(baseline, await readCandidateSnapshot());

	let faultDeploymentId;
	const assertFaultDeployment = async () => {
		if (!faultDeploymentId) return fail("The fault deployment identity has not been established.");
		assertSameDeployment(
			await readDeployment(),
			coordinates.faultVersion,
			faultDeploymentId,
		);
	};
	const readFaultSnapshot = async () => {
		await assertFaultDeployment();
		const observed = await readSnapshot();
		await assertFaultDeployment();
		return observed;
	};
	const roomPath = `/api/rooms/${seedCode}`;
	const observedProof = await observeFaultSeededJoin({
		async awaitActivation() {
			faultDeploymentId = await waitForFaultDeployment({
				readDeployment,
				delay,
				candidateVersion: coordinates.candidateVersion,
				faultVersion: coordinates.faultVersion,
				attempts: deploymentWaitAttempts,
				delayMs: deploymentWaitDelayMs,
			});
			await waitForReceiverFaultStatus({
				request,
				assertDeployment: assertFaultDeployment,
				delay,
				attempts: faultStatusWaitAttempts,
				delayMs: faultStatusWaitDelayMs,
			});
			assertUnchangedSnapshot(baseline, await readFaultSnapshot());
		},
		async stateOperation() {
			await assertFaultDeployment();
			const state = await request(guest, `${roomPath}/state`);
			const room = state.payload?.room;
			if (
				state.status !== 200
				|| !isObject(room)
				|| room.code !== seedCode
				|| room.version !== 1
				|| !Array.isArray(room.players)
				|| room.players.length !== 1
				|| room.viewer?.isHost !== false
				|| room.viewer?.isMember !== false
				|| !guest.cookie
			) return fail("The seeded-room fault state barrier returned an invalid public room state.");
			await assertFaultDeployment();
		},
		async beforeJoinOperation() {
			assertUnchangedSnapshot(baseline, await readFaultSnapshot());
		},
		async joinOperation() {
			await assertFaultDeployment();
			const joined = await request(guest, `${roomPath}/join`, {
				method: "POST",
				body: { name: "Rollback drill guest" },
			});
			const room = joined.payload?.room;
			if (
				joined.status !== 200
				|| !isObject(room)
				|| room.code !== seedCode
				|| room.version !== 2
				|| !Array.isArray(room.players)
				|| room.players.length !== 2
				|| room.viewer?.isHost !== false
				|| room.viewer?.isMember !== true
				|| !guest.cookie
			) return fail("The seeded-room fault join returned an invalid public room state.");
			await assertFaultDeployment();
			return { joined: true };
		},
	},
		coordinates.faultVersion,
		proofDigest,
		async () => {
			assertSingleVersionDeployment(await readDeployment(), coordinates.candidateVersion);
			assertUnchangedSnapshot(baseline, await readCandidateSnapshot());
		},
	);
	if (
		!isObject(observedProof)
		|| requireProofDigest(observedProof.proofDigest) !== proofDigest
	) return fail("The seeded-room fault observer returned an invalid proof.");
	assertUnchangedSnapshot(baseline, await readFaultSnapshot());
	await delay(faultObservationDelayMs);
	assertUnchangedSnapshot(baseline, await readFaultSnapshot());
	guest.cookie = "";
	return {
		baseline,
		proofDigest,
		summary: {
			status: "ok",
			phase: "pending-joined-row-established",
			rollbackRequired: true,
			expectedReceiptsAfterRollback: JOIN_ONLY_DELTAS.receiptCount,
			expectedRoomJoinedEventsAfterRollback: JOIN_ONLY_DELTAS.roomJoinedCount,
		},
	};
}

export async function verifyRollbackDrainProof({
	origin = STAGING_ORIGIN,
	worker = STAGING_WORKER,
	candidateVersion,
	faultVersion,
	rollbackVersion,
	baseline,
	proofDigest,
	fetchImpl,
	readDeployment,
	readVersion,
	readSnapshot,
	observeRollbackAlarm,
	delay = sleep,
	deploymentWaitAttempts = 300,
	deploymentWaitDelayMs = 2_000,
	pollAttempts = DEFAULT_DRAIN_POLL_ATTEMPTS,
	pollDelayMs = DEFAULT_DRAIN_POLL_DELAY_MS,
}) {
	const coordinates = requireDrillCoordinates({
		origin,
		worker,
		candidateVersion,
		faultVersion,
		rollbackVersion,
	});
	requireAdapters({ fetchImpl, readDeployment, readVersion, readSnapshot, observeRollbackAlarm, delay }, [
		"fetchImpl", "readDeployment", "readVersion", "readSnapshot", "observeRollbackAlarm", "delay",
	]);
	const checkedBaseline = normalizedSnapshot(baseline, true);
	const checkedProofDigest = requireProofDigest(proofDigest);
	assertSingleVersionDeployment(await readDeployment(), coordinates.faultVersion);
	const [candidateDocument, faultDocument, rollbackDocument] = await Promise.all([
		readVersion(coordinates.candidateVersion),
		readVersion(coordinates.faultVersion),
		readVersion(coordinates.rollbackVersion),
	]);
	assertReceiverFaultVersionDiff({
		candidateDocument,
		faultDocument,
		candidateVersion: coordinates.candidateVersion,
		faultVersion: coordinates.faultVersion,
	});
	assertRollbackVersionResources(rollbackDocument, coordinates.rollbackVersion);
	assertSingleVersionDeployment(await readDeployment(), coordinates.faultVersion);
	assertUnchangedSnapshot(checkedBaseline, await readSnapshot());
	assertSingleVersionDeployment(await readDeployment(), coordinates.faultVersion);
	let request;
	const drainSnapshot = await observeRollbackAlarm(async () => {
		await waitForRollbackDeployment({
			readDeployment,
			delay,
			faultVersion: coordinates.faultVersion,
			rollbackVersion: coordinates.rollbackVersion,
			attempts: deploymentWaitAttempts,
			delayMs: deploymentWaitDelayMs,
		});
		request = createStagingRequester({ origin: coordinates.origin, fetchImpl });
		assertRollbackReadiness(await request(null, "/api/v1/platform/status"));
		const checkedSnapshot = async () => {
			assertSingleVersionDeployment(await readDeployment(), coordinates.rollbackVersion);
			const observed = await readSnapshot();
			assertSingleVersionDeployment(await readDeployment(), coordinates.rollbackVersion);
			return observed;
		};
		const drained = await pollForJoinedDrain({
			baseline: checkedBaseline,
			readSnapshot: checkedSnapshot,
			delay,
			attempts: pollAttempts,
			delayMs: pollDelayMs,
		});
		assertSingleVersionDeployment(await readDeployment(), coordinates.rollbackVersion);
		return drained;
	}, coordinates.rollbackVersion, checkedProofDigest, async () => {
		assertSingleVersionDeployment(await readDeployment(), coordinates.faultVersion);
		assertUnchangedSnapshot(checkedBaseline, await readSnapshot());
		assertSingleVersionDeployment(await readDeployment(), coordinates.faultVersion);
	});
	const checkedDrainSnapshot = normalizedSnapshot(drainSnapshot, true);
	assertSingleVersionDeployment(await readDeployment(), coordinates.rollbackVersion);
	const postProofSnapshot = normalizedSnapshot(await readSnapshot(), true);
	assertSingleVersionDeployment(await readDeployment(), coordinates.rollbackVersion);
	if (!exactSnapshotDelta(checkedDrainSnapshot, postProofSnapshot, Object.fromEntries(
		SNAPSHOT_FIELDS.map((field) => [field, 0]),
	))) return fail("A staging write or cleanup overlapped the correlated Release-A alarm proof.");
	await runPublicRoomCreate(request);
	assertSingleVersionDeployment(await readDeployment(), coordinates.rollbackVersion);
	const checkedSnapshot = async () => {
		assertSingleVersionDeployment(await readDeployment(), coordinates.rollbackVersion);
		const observed = await readSnapshot();
		assertSingleVersionDeployment(await readDeployment(), coordinates.rollbackVersion);
		return observed;
	};
	await pollForLegacyCreate({
		baseline: postProofSnapshot,
		readSnapshot: checkedSnapshot,
		delay,
		attempts: pollAttempts,
		delayMs: pollDelayMs,
	});
	assertSingleVersionDeployment(await readDeployment(), coordinates.rollbackVersion);
	return {
		status: "ok",
		phase: "rollback-joined-drain-and-legacy-proved",
		receiptsAdded: JOIN_ONLY_DELTAS.receiptCount,
		roomFactsAdded: JOIN_ONLY_DELTAS.roomFactCount,
		roomCreatedEventsAdded: JOIN_ONLY_DELTAS.roomCreatedCount,
		roomJoinedEventsAdded: JOIN_ONLY_DELTAS.roomJoinedCount,
		legacyReceiptsAdded: LEGACY_CREATE_DELTAS.receiptCount,
		legacyRoomFactsAdded: LEGACY_CREATE_DELTAS.roomFactCount,
		legacyRoomCreatedEventsAdded: LEGACY_CREATE_DELTAS.roomCreatedCount,
	};
}

export function parseCliArguments(argv) {
	if (!Array.isArray(argv) || argv.length < 1) return fail("A rollback drill phase is required.");
	const [phase, candidateVersion, faultVersion, rollbackVersion, origin = STAGING_ORIGIN, worker = STAGING_WORKER] = argv;
	if (phase === "make-fault-config") {
		if (argv.length !== 1) return fail("make-fault-config accepts no additional arguments.");
		return { phase };
	}
	if (
		!new Set(["validate-fault", "prepare", "verify"]).has(phase)
		|| argv.length < 4
		|| argv.length > 6
	) {
		return fail("Use validate-fault, prepare, or verify with candidate, fault, and rollback version UUIDs.");
	}
	return {
		phase,
		...requireDrillCoordinates({ origin, worker, candidateVersion, faultVersion, rollbackVersion }),
	};
}

async function requireTemporaryPathAbsent(pathname, description) {
	try {
		await lstat(pathname);
		return fail(`${description} already exists; resolve the earlier drill before continuing.`);
	} catch (error) {
		if (isObject(error) && error.code === "ENOENT") return;
		if (error instanceof Error && error.message.includes("already exists")) throw error;
		return fail(`${description} could not be checked safely.`);
	}
}

async function requireCoordinateCheckpointAbsent(coordinates) {
	const prefix = `${CHECKPOINT_FILENAME_PREFIX}${coordinateDigest(coordinates)}-`;
	let entries;
	try {
		entries = await readdir(PROJECT_ROOT);
	} catch {
		return fail("The aggregate rollback checkpoint directory could not be read.");
	}
	if (entries.some((entry) => entry.startsWith(prefix))) {
		return fail("A coordinate-bound aggregate rollback checkpoint already exists.");
	}
}

async function removeTemporaryPath(pathname) {
	try {
		await unlink(pathname);
	} catch (error) {
		if (!isObject(error) || error.code !== "ENOENT") {
			return fail("A rollback drill temporary file could not be removed.");
		}
	}
}

async function main(argv) {
	const options = parseCliArguments(argv);
	if (options.phase === "make-fault-config") {
		await requireTemporaryPathAbsent(FAULT_CONFIG_PATH, "The temporary receiver-fault configuration");
		await writeReceiverFaultConfig();
		console.log(JSON.stringify({
			status: "ok",
			phase: "fault-config-created",
			config: FAULT_CONFIG_FILENAME,
			deploymentPerformed: false,
		}));
		return;
	}

	const readers = createStagingWranglerReaders();
	if (options.phase === "validate-fault") {
		console.log(JSON.stringify(await validateFaultPreflight({ ...options, ...readers })));
		return;
	}
	const observers = createStagingTailObservers({
		onReady(kind) {
			if (kind === "fault" || kind === "rollback") {
				console.error(JSON.stringify({
					status: "waiting",
					phase: kind === "fault"
						? "fault-observer-ready"
						: "rollback-observer-ready",
					deploymentPerformed: false,
				}));
			}
		},
	});
	if (options.phase === "prepare") {
		await requireCoordinateCheckpointAbsent(options);
		const result = await prepareRollbackDrainProof({
			...options,
			fetchImpl: globalThis.fetch,
			...readers,
			...observers,
		});
		const checkpointName = checkpointFilename(options, result.proofDigest);
		const checkpointPath = resolve(PROJECT_ROOT, checkpointName);
		await writeAggregateCheckpoint(checkpointPath, result.baseline);
		console.log(JSON.stringify({ ...result.summary, checkpoint: checkpointName }));
		return;
	}

	const checkpoint = await locateAggregateCheckpoint(options);
	const baseline = await readAggregateCheckpoint(checkpoint.pathname);
	const summary = await verifyRollbackDrainProof({
		...options,
		baseline,
		proofDigest: checkpoint.proofDigest,
		fetchImpl: globalThis.fetch,
		...readers,
		...observers,
	});
	await removeTemporaryPath(checkpoint.pathname);
	await removeTemporaryPath(FAULT_CONFIG_PATH);
	console.log(JSON.stringify(summary));
}

const isMain = process.argv[1]
	&& fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) await main(process.argv.slice(2));
