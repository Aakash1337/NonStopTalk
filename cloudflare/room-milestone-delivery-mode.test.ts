import assert from "node:assert/strict";
import test from "node:test";

import {
	ROOM_MILESTONE_OUTBOX_PRODUCER_CAPABLE,
	describeRoomMilestoneDelivery,
	isSecureRoomFactHashKey,
	resolveRoomMilestoneDeliveryMode,
	roomMilestoneOutboxProducerEnabled,
} from "./room-milestone-delivery-mode.ts";

test("only the exact outbox literal enables the compiled producer", () => {
	assert.equal(ROOM_MILESTONE_OUTBOX_PRODUCER_CAPABLE, true);
	assert.equal(resolveRoomMilestoneDeliveryMode("outbox"), "outbox");
	assert.equal(roomMilestoneOutboxProducerEnabled("outbox"), true);

	for (const value of [
		undefined,
		null,
		"",
		"best-effort",
		"OUTBOX",
		" outbox",
		"outbox ",
		0,
		false,
		{},
	] as const) {
		assert.equal(resolveRoomMilestoneDeliveryMode(value), "best-effort");
		assert.equal(roomMilestoneOutboxProducerEnabled(value), false);
	}
});

test("room-fact keys use the shared UTF-8 byte-length boundary", () => {
	assert.equal(isSecureRoomFactHashKey(undefined), false);
	assert.equal(isSecureRoomFactHashKey(123), false);
	assert.equal(isSecureRoomFactHashKey("1".repeat(31)), false);
	assert.equal(isSecureRoomFactHashKey("1".repeat(32)), true);
	assert.equal(isSecureRoomFactHashKey("1".repeat(1_024)), true);
	assert.equal(isSecureRoomFactHashKey("1".repeat(1_025)), false);
	assert.equal(isSecureRoomFactHashKey("é".repeat(15)), false);
	assert.equal(isSecureRoomFactHashKey("é".repeat(16)), true);
});

test("durable status requires exact mode, schema 6, and a secure fact key", () => {
	const secureKey = "2".repeat(64);
	assert.deepEqual(describeRoomMilestoneDelivery("outbox", 6, secureKey), {
		configuredMode: "outbox",
		delivery: "durable-outbox",
		degraded: false,
	});
	assert.deepEqual(describeRoomMilestoneDelivery("outbox", 5, secureKey), {
		configuredMode: "outbox",
		delivery: "degraded-outbox",
		degraded: true,
	});
	assert.deepEqual(describeRoomMilestoneDelivery("outbox", 6, "too-short"), {
		configuredMode: "outbox",
		delivery: "degraded-outbox",
		degraded: true,
	});
	assert.deepEqual(describeRoomMilestoneDelivery("OUTBOX", 6, secureKey), {
		configuredMode: "best-effort",
		delivery: "best-effort",
		degraded: false,
	});
});
