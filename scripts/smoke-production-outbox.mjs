import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import {
	D1_SNAPSHOT_SQL,
	assertCanaryPollingBounds,
	parseCanaryD1Snapshot,
	runOutboxActivationCanary,
} from "./outbox-activation-canary.mjs";

export const PRODUCTION_ORIGIN = "https://dontstoptalking.org";
export const PRODUCTION_WORKER = "nonstoptalk";
export const PRODUCTION_ENVIRONMENT = "";
export const PRODUCTION_D1_DATABASE_ID = "df98e497-cd4e-4e78-b201-2a393ea0d7cf";
export const REQUIRED_PRODUCTION_ROLLBACK_VERSION = "58df8c9f-b4d7-4f3e-b15c-32dfec579355";
export const REQUIRED_PRODUCTION_SCRIPT_ETAG = "b99c1688ea707556bcf92d6c5fd1e6f8f0a0875651ce422af2eb66d61aa2ed5c";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_CONFIG_PATH = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const WRANGLER_ENTRY = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RESOURCE_ID_PATTERN = /^[0-9a-z_-]{1,256}$/u;
const MAX_WRANGLER_OUTPUT_BYTES = 1_024 * 1_024;
const MAX_CONFIG_BYTES = 1_024 * 1_024;
const REQUIRED_SECRET_NAMES = Object.freeze([
	"ANALYTICS_ADMIN_TOKEN",
	"ROOM_FACT_HASH_KEY",
]);
const AUTOMATION_MARKERS = Object.freeze([
	"CI",
	"GITHUB_ACTIONS",
	"CF_PAGES",
	"CLOUDFLARE_PAGES",
]);
const execFileAsync = promisify(execFile);

const PRODUCTION_MESSAGES = Object.freeze({
	origin: "Refusing to run: the exact production origin is required.",
	requestAdapter: "A production request adapter is required.",
	requestFailed: "A production API request failed.",
	responseTooLarge: "A production API response exceeded the smoke-test size limit.",
	responseUnreadable: "A production API response body could not be read.",
	responseInvalidJson: "A production API response was not valid JSON.",
	readinessUnhealthy: "Production outbox readiness was not healthy.",
	readinessStatus: "Production outbox readiness requires an overall healthy status.",
	readinessSchema: "Production outbox readiness requires platform schema 6.",
	readinessDelivery: "Production outbox readiness requires durable-outbox delivery.",
	readinessCapabilities: "Production outbox readiness requires room facts and retention cleanup.",
	d1Shape: "The production aggregate D1 query returned an unexpected shape.",
	overlap: "Another production write or cleanup overlapped the isolated outbox lifecycle.",
	convergence: "The production durable-outbox counters did not converge inside the bounded polling window.",
});

function fail(message) {
	throw new Error(message);
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value) {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!isObject(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalString(value) {
	return JSON.stringify(canonicalValue(value));
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
			else if (character === "\"") inString = false;
			continue;
		}
		if (character === "\"") {
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
			else if (character === "\"") inString = false;
			continue;
		}
		if (character === "\"") {
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

export function parseProductionJsonc(source) {
	if (typeof source !== "string" || source.trim() === "" || Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) {
		return fail("The production Wrangler JSONC configuration is invalid.");
	}
	try {
		const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(source)));
		if (!isObject(parsed)) fail("The production Wrangler JSONC configuration is invalid.");
		return parsed;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("The Wrangler")) throw error;
		if (error instanceof Error && error.message.startsWith("The production Wrangler")) throw error;
		return fail("The production Wrangler JSONC configuration is invalid.");
	}
}

export function requireProductionCoordinates({
	origin,
	worker,
	environment,
	rollbackVersion,
}) {
	let parsedOrigin;
	try {
		parsedOrigin = new URL(origin);
	} catch {
		return fail("Refusing to run: the exact production origin is required.");
	}
	if (
		parsedOrigin.href !== `${PRODUCTION_ORIGIN}/`
		|| parsedOrigin.username !== ""
		|| parsedOrigin.password !== ""
	) return fail("Refusing to run: the exact production origin is required.");
	if (worker !== PRODUCTION_WORKER) {
		return fail("Refusing to run: the exact production Worker is required.");
	}
	if (environment !== PRODUCTION_ENVIRONMENT) {
		return fail("Refusing to run: the Wrangler root environment is required.");
	}
	if (rollbackVersion !== REQUIRED_PRODUCTION_ROLLBACK_VERSION) {
		return fail("Refusing to run: the caller must supply the exact reviewed production rollback version.");
	}
	return {
		origin: PRODUCTION_ORIGIN,
		worker: PRODUCTION_WORKER,
		environment: PRODUCTION_ENVIRONMENT,
		rollbackVersion,
	};
}

export function requireManualProductionEnvironment(environment = process.env) {
	if (!isObject(environment)) fail("The production canary environment is invalid.");
	for (const name of AUTOMATION_MARKERS) {
		if (typeof environment[name] === "string" && environment[name].trim() !== "") {
			return fail("Refusing to run the mutating production canary from automation.");
		}
	}
}

function oneConfigBinding(bindings, predicate, message) {
	if (!Array.isArray(bindings)) return fail(message);
	const matches = bindings.filter(predicate);
	if (matches.length !== 1 || !isObject(matches[0])) return fail(message);
	return matches[0];
}

export function assertProductionSourceConfig(config) {
	if (!isObject(config) || config.name !== PRODUCTION_WORKER || config.env?.production !== undefined) {
		return fail("The source configuration is not the exact root production Worker.");
	}
	if (config.vars?.ROOM_MILESTONE_DELIVERY_MODE !== "outbox") {
		return fail("The root production configuration must use exact outbox delivery.");
	}
	if (
		!Array.isArray(config.routes)
		|| config.routes.length !== 1
		|| !isObject(config.routes[0])
		|| config.routes[0].pattern !== "dontstoptalking.org"
		|| config.routes[0].custom_domain !== true
	) return fail("The root production configuration must own only the exact production origin.");

	const database = oneConfigBinding(
		config.d1_databases,
		(binding) => isObject(binding) && binding.binding === "PLATFORM_DB",
		"The root production configuration must contain exactly one PLATFORM_DB binding.",
	);
	if (
		config.d1_databases.length !== 1
		|| database.database_id !== PRODUCTION_D1_DATABASE_ID
		|| database.database_name !== "nonstoptalk-platform"
	) return fail("The root production configuration is not bound to the exact production D1 database.");

	const rooms = oneConfigBinding(
		config.durable_objects?.bindings,
		(binding) => isObject(binding) && binding.name === "ROOMS",
		"The root production configuration must contain exactly one ROOMS binding.",
	);
	if (
		config.durable_objects.bindings.length !== 1
		|| rooms.class_name !== "RoomDurableObject"
	) return fail("The root production configuration must contain exactly one ROOMS binding.");
	const analytics = oneConfigBinding(
		config.analytics_engine_datasets,
		(binding) => isObject(binding) && binding.binding === "PRODUCT_ANALYTICS",
		"The root production analytics binding is invalid.",
	);
	if (
		config.analytics_engine_datasets.length !== 1
		|| analytics.dataset !== "nonstoptalk_product"
	) return fail("The root production analytics binding is invalid.");
	if (config.assets?.binding !== "ASSETS" || config.ai?.binding !== "AI") {
		return fail("The root production resource bindings are incomplete.");
	}
	return config;
}

function parseJsonDocument(stdout, description) {
	if (
		typeof stdout !== "string"
		|| stdout.length === 0
		|| Buffer.byteLength(stdout, "utf8") > MAX_WRANGLER_OUTPUT_BYTES
	) return fail(`${description} returned an unexpected shape.`);
	try {
		return JSON.parse(stdout);
	} catch {
		return fail(`${description} returned an unexpected shape.`);
	}
}

export function parseProductionDeployment(stdout) {
	const document = parseJsonDocument(stdout, "The production deployment query");
	if (!isObject(document) || !Array.isArray(document.versions)) {
		return fail("The production deployment query returned an unexpected shape.");
	}
	return document;
}

function requireVersionId(value, label) {
	if (typeof value !== "string" || !VERSION_ID_PATTERN.test(value)) {
		return fail(`The ${label} production version identity is invalid.`);
	}
	return value;
}

export function discoverProductionDeployment(document, rollbackVersion) {
	const checkedRollback = requireVersionId(rollbackVersion, "rollback");
	if (
		!isObject(document)
		|| typeof document.id !== "string"
		|| !VERSION_ID_PATTERN.test(document.id)
		|| !Array.isArray(document.versions)
		|| document.versions.length !== 1
		|| !isObject(document.versions[0])
		|| document.versions[0].percentage !== 100
	) {
		return fail("Production is not serving exactly one current version at 100 percent.");
	}
	const currentVersion = requireVersionId(document.versions[0].version_id, "current");
	if (currentVersion === checkedRollback) {
		return fail("Production is still serving the rollback version; the outbox activation is not current.");
	}
	return { deploymentId: document.id, currentVersion };
}

export function productionDeploymentIdentity(document, expectedVersion) {
	const checkedVersion = requireVersionId(expectedVersion, "expected");
	if (
		!isObject(document)
		|| typeof document.id !== "string"
		|| !VERSION_ID_PATTERN.test(document.id)
		|| !Array.isArray(document.versions)
		|| document.versions.length !== 1
		|| !isObject(document.versions[0])
		|| document.versions[0].version_id !== checkedVersion
		|| document.versions[0].percentage !== 100
	) return fail("Production changed deployments or is no longer serving the discovered current version alone.");
	return document.id;
}

function versionResources(document, expectedVersion, label) {
	const checkedVersion = requireVersionId(expectedVersion, label);
	if (
		!isObject(document)
		|| document.id !== checkedVersion
		|| !isObject(document.resources)
		|| !isObject(document.resources.script)
		|| typeof document.resources.script.etag !== "string"
		|| document.resources.script.etag.length === 0
		|| !Array.isArray(document.resources.bindings)
	) return fail(`The ${label} production version query returned an unexpected shape.`);
	return document.resources;
}

function requireVersionBinding(bindings, name, type, label) {
	const matches = bindings.filter((binding) => (
		isObject(binding) && binding.name === name && binding.type === type
	));
	if (matches.length !== 1) {
		return fail(`The ${label} production version is missing a required resource binding.`);
	}
	return matches[0];
}

function assertVersionBindingContract(resources, label, expectedMode) {
	const bindings = resources.bindings;
	const database = requireVersionBinding(bindings, "PLATFORM_DB", "d1", label);
	if (
		database.id !== PRODUCTION_D1_DATABASE_ID
		|| database.database_id !== PRODUCTION_D1_DATABASE_ID
	) {
		return fail(`The ${label} production version is not bound to the exact production D1 database.`);
	}
	const rooms = requireVersionBinding(bindings, "ROOMS", "durable_object_namespace", label);
	if (
		typeof rooms.namespace_id !== "string"
		|| !RESOURCE_ID_PATTERN.test(rooms.namespace_id)
		|| rooms.class_name !== "RoomDurableObject"
	) return fail(`The ${label} production room resource is invalid.`);
	requireVersionBinding(bindings, "ASSETS", "assets", label);
	requireVersionBinding(bindings, "PRODUCT_ANALYTICS", "analytics_engine", label);
	requireVersionBinding(bindings, "AI", "ai", label);
	for (const name of REQUIRED_SECRET_NAMES) requireVersionBinding(bindings, name, "secret_text", label);
	const mode = requireVersionBinding(bindings, "ROOM_MILESTONE_DELIVERY_MODE", "plain_text", label);
	if (mode.text !== expectedMode) {
		return fail(`The ${label} production version has an unexpected room-milestone delivery mode.`);
	}
}

function comparableResources(resources) {
	const copy = structuredClone(resources);
	copy.bindings = copy.bindings
		.filter((binding) => !(
			isObject(binding)
			&& binding.name === "ROOM_MILESTONE_DELIVERY_MODE"
			&& binding.type === "plain_text"
		))
		.sort((left, right) => canonicalString(left).localeCompare(canonicalString(right)));
	return canonicalValue(copy);
}

function secretBindingNames(resources) {
	return resources.bindings
		.filter((binding) => isObject(binding) && binding.type === "secret_text")
		.map((binding) => binding.name)
		.sort();
}

export function assertProductionVersionResources({
	currentDocument,
	rollbackDocument,
	currentVersion,
	rollbackVersion,
}) {
	const current = versionResources(currentDocument, currentVersion, "current");
	const rollback = versionResources(rollbackDocument, rollbackVersion, "rollback");
	assertVersionBindingContract(current, "current", "outbox");
	assertVersionBindingContract(rollback, "rollback", "best-effort");
	if (
		current.script.etag !== REQUIRED_PRODUCTION_SCRIPT_ETAG
		|| rollback.script.etag !== REQUIRED_PRODUCTION_SCRIPT_ETAG
	) {
		return fail("The production activation must retain the exact reviewed config-only script artifact.");
	}
	if (!isDeepStrictEqual(comparableResources(current), comparableResources(rollback))) {
		return fail("The current production version has resource drift beyond the reviewed mode-only change.");
	}
	const currentSecrets = secretBindingNames(current);
	const rollbackSecrets = secretBindingNames(rollback);
	if (!isDeepStrictEqual(currentSecrets, rollbackSecrets)) {
		return fail("The current and rollback production versions have different secret bindings.");
	}
	return { current, rollback, secretNames: currentSecrets };
}

export function parseProductionSecrets(stdout) {
	const document = parseJsonDocument(stdout, "The production secret query");
	if (!Array.isArray(document)) return fail("The production secret query returned an unexpected shape.");
	const names = document.map((entry) => {
		if (
			!isObject(entry)
			|| entry.type !== "secret_text"
			|| typeof entry.name !== "string"
			|| !/^[A-Z][A-Z0-9_]{0,127}$/u.test(entry.name)
		) {
			return fail("The production secret query returned an unexpected shape.");
		}
		return entry.name;
	}).sort();
	if (new Set(names).size !== names.length) {
		return fail("The production secret query returned an unexpected shape.");
	}
	return names;
}

export function assertProductionSecretInventory(actualNames, versionSecretNames) {
	if (!Array.isArray(actualNames) || !Array.isArray(versionSecretNames)) {
		return fail("The production secret inventory is invalid.");
	}
	for (const required of REQUIRED_SECRET_NAMES) {
		if (!versionSecretNames.includes(required)) {
			return fail("The production secret inventory is missing a required secret.");
		}
	}
	if (!isDeepStrictEqual([...actualNames].sort(), [...versionSecretNames].sort())) {
		return fail("The production secret inventory differs from the active version bindings.");
	}
}

export function createProductionWranglerReaders({
	execFileImpl = execFileAsync,
	readFileImpl = readFile,
} = {}) {
	if (typeof execFileImpl !== "function" || typeof readFileImpl !== "function") {
		fail("A production Wrangler process and file adapter are required.");
	}
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
		async readSourceConfig() {
			let source;
			try {
				source = await readFileImpl(SOURCE_CONFIG_PATH, "utf8");
			} catch {
				return fail("The production Wrangler configuration could not be read.");
			}
			return parseProductionJsonc(source);
		},
		async readDeployment() {
			return parseProductionDeployment(await run([
				"deployments", "status", "--env=", "--json",
			], "The production deployment could not be read."));
		},
		async readVersion(version) {
			const checked = requireVersionId(version, "queried");
			return parseJsonDocument(await run([
				"versions", "view", checked, "--env=", "--json",
			], "The production Worker version could not be read."), "The production Worker version query");
		},
		async readSecrets() {
			return parseProductionSecrets(await run([
				"secret", "list", "--env=", "--format", "json",
			], "The production secret inventory could not be read."));
		},
		async readSnapshot() {
			return parseCanaryD1Snapshot(await run([
				"d1", "execute", "PLATFORM_DB", "--remote", "--env=", "--json", "--command", D1_SNAPSHOT_SQL,
			], "The production aggregate D1 counters could not be read."), { messages: PRODUCTION_MESSAGES });
		},
	};
}

function assertSameDeployment(document, currentVersion, deploymentId) {
	if (productionDeploymentIdentity(document, currentVersion) !== deploymentId) {
		return fail("Production changed deployments during the outbox activation canary.");
	}
}

export async function runProductionOutboxActivationSmoke({
	origin = PRODUCTION_ORIGIN,
	worker = PRODUCTION_WORKER,
	environment = PRODUCTION_ENVIRONMENT,
	rollbackVersion,
	automationEnvironment = process.env,
	fetchImpl = globalThis.fetch,
	readSourceConfig,
	readDeployment,
	readVersion,
	readSecrets,
	readSnapshot,
	delay = sleep,
	pollAttempts,
	pollDelayMs,
} = {}) {
	requireManualProductionEnvironment(automationEnvironment);
	const coordinates = requireProductionCoordinates({
		origin,
		worker,
		environment,
		rollbackVersion,
	});
	if (typeof fetchImpl !== "function" || typeof delay !== "function") {
		fail("The production fetch and polling adapters are invalid.");
	}
	assertCanaryPollingBounds(pollAttempts ?? 24, pollDelayMs ?? 1_000);
	const defaults = createProductionWranglerReaders();
	const adapters = {
		readSourceConfig: readSourceConfig ?? defaults.readSourceConfig,
		readDeployment: readDeployment ?? defaults.readDeployment,
		readVersion: readVersion ?? defaults.readVersion,
		readSecrets: readSecrets ?? defaults.readSecrets,
		readSnapshot: readSnapshot ?? defaults.readSnapshot,
	};
	for (const [name, adapter] of Object.entries(adapters)) {
		if (typeof adapter !== "function") fail(`The production ${name} adapter is invalid.`);
	}

	const sourceConfig = assertProductionSourceConfig(await adapters.readSourceConfig());
	const sourceFingerprint = canonicalString(sourceConfig);
	const deployment = await adapters.readDeployment();
	const { deploymentId, currentVersion } = discoverProductionDeployment(
		deployment,
		coordinates.rollbackVersion,
	);
	const currentDocument = await adapters.readVersion(currentVersion);
	const rollbackDocument = await adapters.readVersion(coordinates.rollbackVersion);
	const resources = assertProductionVersionResources({
		currentDocument,
		rollbackDocument,
		currentVersion,
		rollbackVersion: coordinates.rollbackVersion,
	});
	const secretNames = await adapters.readSecrets();
	assertProductionSecretInventory(secretNames, resources.secretNames);

	const assertStableBeforeBaseline = async () => {
		assertSameDeployment(await adapters.readDeployment(), currentVersion, deploymentId);
		const currentSource = assertProductionSourceConfig(await adapters.readSourceConfig());
		if (canonicalString(currentSource) !== sourceFingerprint) {
			return fail("The production source configuration changed before canary mutation.");
		}
		assertProductionSecretInventory(await adapters.readSecrets(), resources.secretNames);
	};
	const assertStableBeforeMutation = async () => {
		assertSameDeployment(await adapters.readDeployment(), currentVersion, deploymentId);
	};
	const assertStableAfterLifecycle = async () => {
		assertSameDeployment(await adapters.readDeployment(), currentVersion, deploymentId);
	};
	const assertStableAfterMutation = async () => {
		assertSameDeployment(await adapters.readDeployment(), currentVersion, deploymentId);
	};

	const summary = await runOutboxActivationCanary({
		origin: coordinates.origin,
		expectedOrigin: PRODUCTION_ORIGIN,
		fetchImpl,
		readSnapshot: adapters.readSnapshot,
		delay,
		...(pollAttempts === undefined ? {} : { pollAttempts }),
		...(pollDelayMs === undefined ? {} : { pollDelayMs }),
		messages: PRODUCTION_MESSAGES,
		assertStableBeforeBaseline,
		assertStableBeforeMutation,
		assertStableAfterLifecycle,
		assertStableAfterMutation,
	});
	return {
		...summary,
		worker: coordinates.worker,
		environment: "root",
		currentVersion,
		rollbackVersion: coordinates.rollbackVersion,
		deploymentId,
	};
}

export function parseProductionCliArguments(args) {
	if (!Array.isArray(args) || args.length !== 1) {
		return fail("Supply the exact rollback version; this command has no default and discovers the active version.");
	}
	return requireProductionCoordinates({
		origin: PRODUCTION_ORIGIN,
		worker: PRODUCTION_WORKER,
		environment: PRODUCTION_ENVIRONMENT,
		rollbackVersion: args[0],
	});
}

const isMain = process.argv[1]
	&& fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
	requireManualProductionEnvironment(process.env);
	const coordinates = parseProductionCliArguments(process.argv.slice(2));
	const summary = await runProductionOutboxActivationSmoke(coordinates);
	console.log(JSON.stringify(summary));
}
