"use strict";

// Wrangler 4.127.1 exposes no JSON-tail readiness record. Its debug channel
// does emit these two transport-only markers from the same WebSocket after it
// opens. Keep every other debug record inside the child process so telemetry,
// local paths, and authentication diagnostics can never enter the proof pipe.
const ALLOWED_TAIL_MARKERS = new Set([
	"Tail: Sending ping to tail websocket",
	"Tail: Received pong from tail websocket",
]);
const originalDebug = console.debug.bind(console);

console.debug = (...values) => {
	if (
		values.length === 1
		&& typeof values[0] === "string"
		&& ALLOWED_TAIL_MARKERS.has(values[0])
	) originalDebug(values[0]);
};
