import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import {
	D1_SNAPSHOT_SQL,
	EXPECTED_DELTAS,
	assertCanaryOutboxReadiness,
	createCanaryRequester,
	parseCanaryD1Snapshot,
	pollForCanaryExpectedDeltas,
	requireExactOrigin,
	runCanaryPublicRoomCreate,
	runCanaryPublicRoomLifecycle,
	runOutboxActivationCanary,
} from "./outbox-activation-canary.mjs";

export { D1_SNAPSHOT_SQL, EXPECTED_DELTAS };
export const STAGING_ORIGIN = "https://nonstoptalk-staging.aakashplays656.workers.dev";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER_ENTRY = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const execFileAsync = promisify(execFile);

const STAGING_MESSAGES = Object.freeze({
	origin: "Refusing to run: the exact Release B staging origin is required.",
	requestAdapter: "A staging request adapter is required.",
	requestFailed: "A staging API request failed.",
	responseTooLarge: "A staging API response exceeded the smoke-test size limit.",
	responseUnreadable: "A staging API response body could not be read.",
	responseInvalidJson: "A staging API response was not valid JSON.",
	readinessUnhealthy: "Release B staging readiness was not healthy.",
	readinessStatus: "Release B staging readiness requires an overall healthy status.",
	readinessSchema: "Release B staging readiness requires platform schema 6.",
	readinessDelivery: "Release B staging readiness requires durable-outbox delivery.",
	readinessCapabilities: "Release B staging readiness requires room facts and retention cleanup.",
	d1Shape: "The staging aggregate D1 query returned an unexpected shape.",
	overlap: "Another staging write or cleanup overlapped the isolated Release B lifecycle.",
	convergence: "The durable Release B counters did not converge inside the bounded polling window.",
});

function fail(message) {
	throw new Error(message);
}

export function requireStagingOrigin(value) {
	return requireExactOrigin(value, STAGING_ORIGIN, { messages: STAGING_MESSAGES });
}

export function createStagingRequester({ origin = STAGING_ORIGIN, fetchImpl = globalThis.fetch } = {}) {
	return createCanaryRequester({
		origin,
		expectedOrigin: STAGING_ORIGIN,
		fetchImpl,
		messages: STAGING_MESSAGES,
	});
}

export function assertOutboxReadiness(result) {
	return assertCanaryOutboxReadiness(result, { messages: STAGING_MESSAGES });
}

export function runPublicRoomCreate(request) {
	return runCanaryPublicRoomCreate(request, { messages: STAGING_MESSAGES });
}

export function runPublicRoomLifecycle(request) {
	return runCanaryPublicRoomLifecycle(request, { messages: STAGING_MESSAGES });
}

export function parseD1Snapshot(stdout) {
	return parseCanaryD1Snapshot(stdout, { messages: STAGING_MESSAGES });
}

export async function readRemoteD1Snapshot() {
	let output;
	try {
		output = await execFileAsync(process.execPath, [
			WRANGLER_ENTRY,
			"d1",
			"execute",
			"PLATFORM_DB",
			"--remote",
			"--env",
			"staging",
			"--json",
			"--command",
			D1_SNAPSHOT_SQL,
		], {
			cwd: PROJECT_ROOT,
			encoding: "utf8",
			maxBuffer: 1_024 * 1_024,
			timeout: 30_000,
			windowsHide: true,
			env: { ...process.env, CI: "1", NO_COLOR: "1" },
		});
	} catch {
		return fail("The staging aggregate D1 counters could not be read.");
	}
	return parseD1Snapshot(output.stdout);
}

export function pollForExpectedDeltas(options) {
	return pollForCanaryExpectedDeltas({ ...options, messages: STAGING_MESSAGES });
}

export function runStagingOutboxActivationSmoke({
	origin = STAGING_ORIGIN,
	fetchImpl = globalThis.fetch,
	readSnapshot = readRemoteD1Snapshot,
	delay = sleep,
	pollAttempts,
	pollDelayMs,
} = {}) {
	return runOutboxActivationCanary({
		origin,
		expectedOrigin: STAGING_ORIGIN,
		fetchImpl,
		readSnapshot,
		delay,
		...(pollAttempts === undefined ? {} : { pollAttempts }),
		...(pollDelayMs === undefined ? {} : { pollDelayMs }),
		messages: STAGING_MESSAGES,
	});
}

const isMain = process.argv[1]
	&& fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
	const requestedOrigin = process.argv[2] ?? STAGING_ORIGIN;
	if (process.argv.length > 3) fail("This command accepts at most one staging-origin argument.");
	const summary = await runStagingOutboxActivationSmoke({ origin: requestedOrigin });
	console.log(JSON.stringify(summary));
}
