import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkerLogRecord } from "./observability";

test("formats bounded structured Worker log records with protected fields", () => {
	const payload = buildWorkerLogRecord("warn", "room_fact_write_failed", {
		level: "not-allowed-to-override",
		event: "not-allowed-to-override",
		requestId: "request-123",
		deletedCount: 4,
		omitted: undefined,
	});

	assert.equal(payload.level, "warn");
	assert.equal(payload.event, "room_fact_write_failed");
	assert.equal(payload.requestId, "request-123");
	assert.equal(payload.deletedCount, 4);
	assert.equal(Object.hasOwn(payload, "omitted"), false);
	assert.match(String(payload.timestamp), /^\d{4}-\d{2}-\d{2}T/);
});
