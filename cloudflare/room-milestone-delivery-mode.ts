import type { SupportedPlatformSchemaVersion } from "./platform-schema";

/**
 * This build contains the complete normal-room producer path. Keep this
 * explicit so configuration alone can never make an older bridge-only Worker
 * claim durable delivery.
 */
export const ROOM_MILESTONE_OUTBOX_PRODUCER_CAPABLE = true as const;

export type RoomMilestoneDeliveryMode = "best-effort" | "outbox";
export type RoomMilestoneDeliveryStatus =
	| "best-effort"
	| "durable-outbox"
	| "degraded-outbox";

export interface RoomMilestoneDeliveryReadiness {
	configuredMode: RoomMilestoneDeliveryMode;
	delivery: RoomMilestoneDeliveryStatus;
	degraded: boolean;
}

/** Only the exact, case-sensitive literal enables the durable producer. */
export function resolveRoomMilestoneDeliveryMode(value: unknown): RoomMilestoneDeliveryMode {
	return value === "outbox" ? "outbox" : "best-effort";
}

export function roomMilestoneOutboxProducerEnabled(value: unknown): boolean {
	return ROOM_MILESTONE_OUTBOX_PRODUCER_CAPABLE
		&& resolveRoomMilestoneDeliveryMode(value) === "outbox";
}

/**
 * HMAC keys are checked by encoded byte length, not JavaScript character
 * count. This is shared by status and the receiver so readiness cannot drift
 * from the actual keyed-room-fact behavior.
 */
export function isSecureRoomFactHashKey(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const bytes = new TextEncoder().encode(value).byteLength;
	return bytes >= 32 && bytes <= 1_024;
}

export function describeRoomMilestoneDelivery(
	configuredValue: unknown,
	schemaVersion: SupportedPlatformSchemaVersion,
	roomFactHashKey: unknown,
): RoomMilestoneDeliveryReadiness {
	const configuredMode = resolveRoomMilestoneDeliveryMode(configuredValue);
	if (configuredMode === "best-effort") {
		return { configuredMode, delivery: "best-effort", degraded: false };
	}
	if (
		ROOM_MILESTONE_OUTBOX_PRODUCER_CAPABLE
		&& schemaVersion === 6
		&& isSecureRoomFactHashKey(roomFactHashKey)
	) {
		return { configuredMode, delivery: "durable-outbox", degraded: false };
	}
	return { configuredMode, delivery: "degraded-outbox", degraded: true };
}
