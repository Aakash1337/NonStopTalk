/**
 * Internal sync-identity persistence for anonymous cloud progress.
 *
 * Profile and membership IDs are opaque database identifiers, never browser
 * credentials. Stage 1 keeps exactly one profile per browser device; this
 * boundary exists so a later, separately consented linking flow can evolve
 * without changing the current device-owned coaching API.
 */

const OPAQUE_ID_BYTES = 32;

declare const deviceKeyBrand: unique symbol;
declare const syncProfileIdBrand: unique symbol;
declare const syncMembershipIdBrand: unique symbol;

export type DeviceKey = string & { readonly [deviceKeyBrand]: "DeviceKey" };
type SyncProfileId = string & { readonly [syncProfileIdBrand]: "SyncProfileId" };
type SyncMembershipId = string & { readonly [syncMembershipIdBrand]: "SyncMembershipId" };

const UPSERT_DEVICE_SQL = `
	INSERT INTO devices (device_key, created_at, last_seen_at, expires_at)
	VALUES (?, ?, ?, ?)
	ON CONFLICT(device_key) DO UPDATE SET
		last_seen_at = excluded.last_seen_at,
		expires_at = excluded.expires_at
	WHERE excluded.expires_at > devices.expires_at
`;

const INSERT_PROFILE_SQL = `
	INSERT INTO sync_profiles (
		profile_id, created_at, last_seen_at, expires_at, sync_generation
	)
	SELECT ?, device.created_at, device.last_seen_at, device.expires_at, 1
	FROM devices AS device
	WHERE device.device_key = ?
		AND NOT EXISTS (
		SELECT 1 FROM sync_profile_devices WHERE device_key = ?
	)
`;

const INSERT_MEMBERSHIP_SQL = `
	INSERT INTO sync_profile_devices (
		membership_id, profile_id, device_key, joined_at, last_seen_at
	)
	SELECT ?, ?, device.device_key, device.created_at, device.last_seen_at
	FROM devices AS device
	WHERE device.device_key = ?
		AND NOT EXISTS (
		SELECT 1 FROM sync_profile_devices WHERE device_key = ?
	)
`;

const REFRESH_MEMBERSHIP_SQL = `
	UPDATE sync_profile_devices
	SET last_seen_at = (
		SELECT device.last_seen_at
		FROM devices AS device
		WHERE device.device_key = sync_profile_devices.device_key
	)
	WHERE device_key = ?
		AND last_seen_at <> (
			SELECT device.last_seen_at
			FROM devices AS device
			WHERE device.device_key = sync_profile_devices.device_key
		)
`;

const REFRESH_PROFILE_SQL = `
	UPDATE sync_profiles
	SET
		last_seen_at = (
			SELECT MAX(device.last_seen_at)
			FROM sync_profile_devices AS membership
			JOIN devices AS device ON device.device_key = membership.device_key
			WHERE membership.profile_id = sync_profiles.profile_id
		),
		expires_at = (
			SELECT MAX(device.expires_at)
			FROM sync_profile_devices AS membership
			JOIN devices AS device ON device.device_key = membership.device_key
			WHERE membership.profile_id = sync_profiles.profile_id
		)
	WHERE profile_id = (
		SELECT profile_id FROM sync_profile_devices WHERE device_key = ?
	)
		AND (
			last_seen_at <> (
				SELECT MAX(device.last_seen_at)
				FROM sync_profile_devices AS membership
				JOIN devices AS device ON device.device_key = membership.device_key
				WHERE membership.profile_id = sync_profiles.profile_id
			)
			OR expires_at <> (
				SELECT MAX(device.expires_at)
				FROM sync_profile_devices AS membership
				JOIN devices AS device ON device.device_key = membership.device_key
				WHERE membership.profile_id = sync_profiles.profile_id
			)
		)
`;

/**
 * Build one ordered D1 batch that refreshes the device lease and guarantees an
 * internal one-device profile membership. A candidate-ID collision aborts the
 * batch; it is never treated as an existing identity.
 */
export function prepareSyncIdentityTouch(
	database: D1Database,
	deviceKey: DeviceKey,
	timestamp: string,
	expiresAt: string,
): D1PreparedStatement[] {
	let profileValue = randomOpaqueId();
	while (profileValue === deviceKey) profileValue = randomOpaqueId();
	const profileId = profileValue as SyncProfileId;
	let membershipValue = randomOpaqueId();
	while (membershipValue === deviceKey || membershipValue === profileValue) {
		membershipValue = randomOpaqueId();
	}
	const membershipId = membershipValue as SyncMembershipId;
	return [
		database
			.prepare("DELETE FROM devices WHERE device_key = ? AND expires_at <= ?")
			.bind(deviceKey, timestamp),
		database
			.prepare(UPSERT_DEVICE_SQL)
			.bind(deviceKey, timestamp, timestamp, expiresAt),
		database
			.prepare(INSERT_PROFILE_SQL)
			.bind(profileId, deviceKey, deviceKey),
		database
			.prepare(INSERT_MEMBERSHIP_SQL)
			.bind(membershipId, profileId, deviceKey, deviceKey),
		database
			.prepare(REFRESH_MEMBERSHIP_SQL)
			.bind(deviceKey),
		database
			.prepare(REFRESH_PROFILE_SQL)
			.bind(deviceKey),
	];
}

function randomOpaqueId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(OPAQUE_ID_BYTES));
	let encoded = "";
	for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
	return encoded;
}
