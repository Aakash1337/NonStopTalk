PRAGMA foreign_keys = ON;

-- Refuse partial or out-of-order application. The compatibility Worker that
-- accepts markers 4 and 5 must be live before this additive migration runs.
CREATE TABLE _migration_0005_schema_guard (
	schema_version INTEGER NOT NULL CHECK (schema_version = 4)
);

INSERT INTO _migration_0005_schema_guard (schema_version)
VALUES ((SELECT schema_version FROM platform_meta WHERE id = 1));

-- One non-sensitive singleton makes scheduled retention work observable. The
-- migration timestamp is an intentional first-run grace heartbeat: the next
-- daily cron is due well before the Worker's 36-hour stale threshold.
CREATE TABLE platform_maintenance (
	id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
	cleanup_scheduled_at TEXT NOT NULL CHECK (
		length(cleanup_scheduled_at) = 24
		AND strftime('%Y-%m-%dT%H:%M:%fZ', cleanup_scheduled_at) IS NOT NULL
		AND strftime('%Y-%m-%dT%H:%M:%fZ', cleanup_scheduled_at) = cleanup_scheduled_at
	),
	cleanup_completed_at TEXT NOT NULL CHECK (
		length(cleanup_completed_at) = 24
		AND strftime('%Y-%m-%dT%H:%M:%fZ', cleanup_completed_at) IS NOT NULL
		AND strftime('%Y-%m-%dT%H:%M:%fZ', cleanup_completed_at) = cleanup_completed_at
	),
	cleanup_backlog INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_backlog IN (0, 1)),
	CHECK (cleanup_scheduled_at <= cleanup_completed_at)
);

INSERT INTO platform_maintenance (
	id, cleanup_scheduled_at, cleanup_completed_at, cleanup_backlog
) VALUES (
	1,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	0
);

DROP TABLE _migration_0005_schema_guard;

UPDATE platform_meta
SET schema_version = 5,
	applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1 AND schema_version = 4;
