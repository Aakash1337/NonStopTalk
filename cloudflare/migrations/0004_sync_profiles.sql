PRAGMA foreign_keys = ON;

-- Refuse partial or out-of-order application. The throwaway table makes a
-- missing marker fail its NOT NULL constraint and any version other than 3
-- fail its CHECK constraint before the durable schema changes begin.
CREATE TABLE _migration_0004_schema_guard (
	schema_version INTEGER NOT NULL CHECK (schema_version = 3)
);

INSERT INTO _migration_0004_schema_guard (schema_version)
VALUES ((SELECT schema_version FROM platform_meta WHERE id = 1));

-- A sync profile is the future cross-device ownership boundary. Stage 1 does
-- not expose account linking: every existing anonymous device receives its
-- own independent, opaque profile. Expiry initially mirrors the device lease.
CREATE TABLE sync_profiles (
	profile_id TEXT PRIMARY KEY NOT NULL
		CHECK (length(profile_id) = 64 AND profile_id NOT GLOB '*[^0-9a-f]*'),
	created_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	sync_generation INTEGER NOT NULL DEFAULT 1 CHECK (sync_generation >= 1),
	CHECK (created_at <= last_seen_at),
	CHECK (last_seen_at < expires_at)
);

CREATE INDEX sync_profiles_expires_at_idx ON sync_profiles (expires_at);

-- Membership is deliberately one-device-to-one-profile in this foundation.
-- The UNIQUE device key prevents accidental multi-profile ownership while a
-- profile may later contain several device memberships after explicit linking.
CREATE TABLE sync_profile_devices (
	membership_id TEXT PRIMARY KEY NOT NULL
		CHECK (length(membership_id) = 64 AND membership_id NOT GLOB '*[^0-9a-f]*'),
	profile_id TEXT NOT NULL,
	device_key TEXT NOT NULL UNIQUE,
	joined_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	FOREIGN KEY (profile_id) REFERENCES sync_profiles(profile_id) ON DELETE CASCADE,
	FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE CASCADE,
	CHECK (membership_id <> profile_id),
	CHECK (membership_id <> device_key),
	CHECK (profile_id <> device_key),
	CHECK (joined_at <= last_seen_at)
);

CREATE INDEX sync_profile_devices_profile_idx
	ON sync_profile_devices (profile_id);

-- Keep the random IDs associated with their source device while both new
-- tables are populated. randomblob(32) yields independent 256-bit identifiers;
-- the lower-case hex encoding matches the strict opaque-ID contract.
CREATE TABLE _migration_0004_profile_backfill (
	device_key TEXT PRIMARY KEY,
	profile_id TEXT NOT NULL UNIQUE,
	membership_id TEXT NOT NULL UNIQUE,
	CHECK (profile_id <> device_key),
	CHECK (membership_id <> device_key),
	CHECK (membership_id <> profile_id)
);

INSERT INTO _migration_0004_profile_backfill (
	device_key, profile_id, membership_id
)
SELECT
	device_key,
	lower(hex(randomblob(32))),
	lower(hex(randomblob(32)))
FROM devices;

INSERT INTO sync_profiles (
	profile_id, created_at, last_seen_at, expires_at, sync_generation
)
SELECT
	backfill.profile_id,
	device.created_at,
	device.last_seen_at,
	device.expires_at,
	1
FROM _migration_0004_profile_backfill AS backfill
JOIN devices AS device ON device.device_key = backfill.device_key;

INSERT INTO sync_profile_devices (
	membership_id, profile_id, device_key, joined_at, last_seen_at
)
SELECT
	backfill.membership_id,
	backfill.profile_id,
	device.device_key,
	device.created_at,
	device.last_seen_at
FROM _migration_0004_profile_backfill AS backfill
JOIN devices AS device ON device.device_key = backfill.device_key;

DROP TABLE _migration_0004_profile_backfill;
DROP TABLE _migration_0004_schema_guard;

UPDATE platform_meta
SET schema_version = 4,
	applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1 AND schema_version = 3;
