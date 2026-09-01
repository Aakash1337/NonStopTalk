import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const RUNTIME_FAILURES = [
	["Cloudflare environment teardown failed", /EnvironmentTeardownError/u],
	["Cloudflare/Vitest RPC closed with work pending", /Closing rpc while ["']/u],
	["Vitest global state was torn down early", /Expected global Vitest state/u],
	["Vitest reported unhandled errors", /(?:Unhandled Errors|Vitest caught \d+ unhandled errors?)/u],
	["Vitest reported an unhandled rejection", /Unhandled Rejection/u],
	["workerd reported an uncaught exception", /(?:^|\n)[^\n]*uncaught exception(?:;|:)/iu],
	["workerd reported an asynchronous I/O failure", /exception = kj\/async-io-[^\n]*(?:disconnected|failed)/iu],
];

export function runtimeHarnessFailure(transcript) {
	for (const [description, pattern] of RUNTIME_FAILURES) {
		if (pattern.test(transcript)) return description;
	}
	return null;
}

async function main() {
	const config = process.argv[2];
	if (!config || process.argv.length !== 3) {
		throw new Error("Usage: node scripts/run-worker-vitest.mjs <vitest-config>");
	}
	const projectRoot = path.resolve(import.meta.dirname, "..");
	const configPath = path.resolve(projectRoot, config);
	if (!configPath.startsWith(`${projectRoot}${path.sep}`)) {
		throw new Error("The Vitest config must be inside the project.");
	}
	const vitestCLI = path.join(projectRoot, "node_modules", "vitest", "vitest.mjs");
	let transcript = "";
	let overflowed = false;
	const remember = (chunk) => {
		if (overflowed) return;
		transcript += chunk;
		if (Buffer.byteLength(transcript) > MAX_TRANSCRIPT_BYTES) {
			overflowed = true;
			transcript = transcript.slice(-MAX_TRANSCRIPT_BYTES);
		}
	};

	const child = spawn(process.execPath, [vitestCLI, "run", "--config", configPath], {
		cwd: projectRoot,
		env: process.env,
		stdio: ["inherit", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => {
		process.stdout.write(chunk);
		remember(String(chunk));
	});
	child.stderr.on("data", (chunk) => {
		process.stderr.write(chunk);
		remember(String(chunk));
	});
	const { code, signal } = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (childCode, childSignal) => resolve({ code: childCode, signal: childSignal }));
	});
	if (signal) throw new Error(`Vitest ended from signal ${signal}.`);
	if (code !== 0) process.exitCode = code ?? 1;
	if (overflowed) {
		console.error("Worker runtime test output exceeded the bounded gate transcript.");
		process.exitCode = 1;
	}
	const harnessFailure = runtimeHarnessFailure(transcript);
	if (harnessFailure) {
		console.error(`Worker runtime test gate rejected a false-green run: ${harnessFailure}.`);
		process.exitCode = 1;
	}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	await main();
}
