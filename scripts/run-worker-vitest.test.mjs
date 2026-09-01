import assert from "node:assert/strict";
import test from "node:test";

import { runtimeHarnessFailure } from "./run-worker-vitest.mjs";

test("accepts a clean Workers Vitest transcript", () => {
	assert.equal(runtimeHarnessFailure("Test Files 4 passed\nTests 30 passed\n"), null);
});

for (const [name, transcript] of [
	["environment teardown", "EnvironmentTeardownError: Closing pool"],
	["pending RPC", "Error: Closing rpc while \"resolve\" was pending"],
	["global state", "AssertionError: Expected global Vitest state"],
	["unhandled errors", "Vitest caught 2 unhandled errors during the test run"],
	["unhandled rejection", "Unhandled Rejection"],
	["generic workerd exception", "uncaught exception; exception = Error: novel runtime failure"],
	["workerd async I/O", "exception = kj/async-io-unix.c++:775: disconnected: writev failed"],
]) {
	test(`rejects a false-green ${name} transcript`, () => {
		assert.ok(runtimeHarnessFailure(transcript));
	});
}
