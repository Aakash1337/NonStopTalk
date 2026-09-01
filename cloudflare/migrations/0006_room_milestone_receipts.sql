PRAGMA foreign_keys = ON;

-- Refuse partial or out-of-order application. The schema-5/6 compatibility
-- Worker must be live before this additive migration runs.
CREATE TABLE _migration_0006_schema_guard (
	schema_version INTEGER NOT NULL CHECK (schema_version = 5)
);

INSERT INTO _migration_0006_schema_guard (schema_version)
VALUES ((SELECT schema_version FROM platform_meta WHERE id = 1));

-- Reserve one privacy-minimal receipt per future room-milestone delivery. The
-- feature Worker is intentionally not part of this migration-only release, so
-- this table remains empty until its idempotent receiver is deployed.
CREATE TABLE room_milestone_receipts (
	event_id TEXT PRIMARY KEY NOT NULL CHECK (
		length(event_id) = 64
		AND event_id NOT GLOB '*[^0-9a-f]*'
	),
	payload_hash TEXT NOT NULL CHECK (
		length(payload_hash) = 64
		AND payload_hash NOT GLOB '*[^0-9a-f]*'
	),
	received_at TEXT NOT NULL CHECK (
		length(received_at) = 24
		AND substr(received_at, 12, 2) BETWEEN '00' AND '23'
		AND strftime('%Y-%m-%dT%H:%M:%fZ', received_at) IS NOT NULL
		AND strftime('%Y-%m-%dT%H:%M:%fZ', received_at) = received_at
	),
	applied_at TEXT CHECK (
		applied_at IS NULL OR (
			length(applied_at) = 24
			AND substr(applied_at, 12, 2) BETWEEN '00' AND '23'
			AND strftime('%Y-%m-%dT%H:%M:%fZ', applied_at) IS NOT NULL
			AND strftime('%Y-%m-%dT%H:%M:%fZ', applied_at) = applied_at
		)
	),
	expires_at TEXT NOT NULL CHECK (
		length(expires_at) = 24
		AND substr(expires_at, 12, 2) BETWEEN '00' AND '23'
		AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL
		AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at
	),
	CHECK (
		strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+90 days') IS NOT NULL
		AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+90 days')
	),
	CHECK (
		applied_at IS NULL OR (
			received_at <= applied_at
			AND applied_at < expires_at
		)
	)
);

CREATE INDEX room_milestone_receipts_expires_at_idx
	ON room_milestone_receipts (expires_at);

DROP TABLE _migration_0006_schema_guard;

UPDATE platform_meta
SET schema_version = 6,
	applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1 AND schema_version = 5;
