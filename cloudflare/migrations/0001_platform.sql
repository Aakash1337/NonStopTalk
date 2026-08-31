PRAGMA foreign_keys = ON;

-- Deployment/readiness marker used by /api/v1/platform/status.
CREATE TABLE platform_meta (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
	applied_at TEXT NOT NULL
);

INSERT INTO platform_meta (id, schema_version, applied_at)
VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- The key is SHA-256(token). The HttpOnly browser token itself has no column.
CREATE TABLE devices (
	device_key TEXT PRIMARY KEY
		CHECK (length(device_key) = 64 AND device_key NOT GLOB '*[^0-9a-f]*'),
	created_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	CHECK (created_at <= last_seen_at),
	CHECK (last_seen_at < expires_at)
);

CREATE INDEX devices_expires_at_idx ON devices (expires_at);

-- One explicit, versioned consent receipt per device/purpose. Revocation keeps
-- the last granted timestamp while preventing all future summary writes.
CREATE TABLE consent_records (
	device_key TEXT NOT NULL,
	purpose TEXT NOT NULL CHECK (purpose = 'cloud_summary'),
	policy_version TEXT NOT NULL CHECK (
		length(policy_version) BETWEEN 1 AND 64
		AND policy_version NOT GLOB '*[^a-z0-9._-]*'
	),
	granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
	granted_at TEXT,
	revoked_at TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (device_key, purpose),
	FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE CASCADE,
	CHECK (
		(granted = 1 AND granted_at IS NOT NULL AND revoked_at IS NULL)
		OR (granted = 0 AND revoked_at IS NOT NULL)
	)
);

CREATE INDEX consent_records_granted_idx
	ON consent_records (purpose, granted, updated_at);

-- summary_json is a normalized allowlist. There are intentionally no audio,
-- transcript-text, IP, cookie-token, sample, segment, or recording columns.
CREATE TABLE coaching_sessions (
	device_key TEXT NOT NULL,
	session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
	analysis_schema_version INTEGER NOT NULL CHECK (analysis_schema_version = 2),
	client_created_at TEXT NOT NULL,
	received_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	scenario TEXT NOT NULL CHECK (scenario IN ('interview', 'presentation', 'impromptu')),
	goal TEXT NOT NULL CHECK (goal IN ('pace', 'pauses', 'energy')),
	target_duration_ms INTEGER NOT NULL CHECK (target_duration_ms BETWEEN 15000 AND 180000),
	duration_ms REAL NOT NULL CHECK (duration_ms BETWEEN 0 AND 600000),
	speaking_ratio REAL NOT NULL CHECK (speaking_ratio BETWEEN 0 AND 1),
	pause_count INTEGER NOT NULL CHECK (pause_count BETWEEN 0 AND 10000),
	audio_confidence TEXT NOT NULL CHECK (audio_confidence IN ('low', 'medium', 'high', 'unknown')),
	transcript_metrics_used INTEGER NOT NULL CHECK (transcript_metrics_used IN (0, 1)),
	summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND length(summary_json) <= 65536),
	-- Reserved now so baseline -> retry pairing does not require reshaping this table.
	practice_loop_id TEXT,
	baseline_attempt_id TEXT,
	attempt_role TEXT NOT NULL DEFAULT 'standalone'
		CHECK (attempt_role IN ('standalone', 'baseline', 'retry')),
	client_release TEXT,
	PRIMARY KEY (device_key, session_id),
	FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE CASCADE
);

CREATE INDEX coaching_sessions_device_created_idx
	ON coaching_sessions (device_key, client_created_at DESC, session_id DESC);
CREATE INDEX coaching_sessions_expires_at_idx ON coaching_sessions (expires_at);
CREATE INDEX coaching_sessions_received_at_idx ON coaching_sessions (received_at);

-- Room state remains authoritative in its Durable Object. This table contains
-- only an operator-keyed HMAC room key and aggregate public facts, never player
-- names/topics. The HMAC secret is a Worker secret and is not stored in D1.
CREATE TABLE room_facts (
	room_key TEXT PRIMARY KEY
		CHECK (length(room_key) = 64 AND room_key NOT GLOB '*[^0-9a-f]*'),
	first_observed_at TEXT NOT NULL,
	last_observed_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	state_version INTEGER NOT NULL CHECK (state_version >= 1),
	last_milestone TEXT NOT NULL CHECK (
		last_milestone IN (
			'created', 'joined', 'game-started', 'turn-completed',
			'game-finished', 'reset', 'snapshot'
		)
	),
	phase TEXT NOT NULL CHECK (phase IN ('setup', 'playing', 'finished')),
	player_count INTEGER NOT NULL CHECK (player_count BETWEEN 0 AND 12),
	online_player_count INTEGER NOT NULL CHECK (
		online_player_count BETWEEN 0 AND player_count
	),
	configured_rounds INTEGER NOT NULL CHECK (configured_rounds BETWEEN 1 AND 10),
	turn_duration_seconds INTEGER NOT NULL CHECK (turn_duration_seconds BETWEEN 10 AND 300),
	topic_pack TEXT NOT NULL CHECK (
		topic_pack IN ('everyday', 'story', 'absurd', 'debate', 'expert', 'custom')
	),
	completed_turn_count INTEGER NOT NULL CHECK (completed_turn_count BETWEEN 0 AND 1200),
	finished_game_count INTEGER NOT NULL CHECK (finished_game_count BETWEEN 0 AND 21),
	total_score INTEGER NOT NULL CHECK (total_score BETWEEN 0 AND 12000000),
	last_turn_spoken_seconds REAL NOT NULL CHECK (last_turn_spoken_seconds BETWEEN 0 AND 300),
	CHECK (first_observed_at <= last_observed_at),
	CHECK (last_observed_at < expires_at)
);

CREATE INDEX room_facts_expires_at_idx ON room_facts (expires_at);
CREATE INDEX room_facts_phase_observed_idx ON room_facts (phase, last_observed_at DESC);

-- Only UTC-day totals and fixed metric enums are accepted. There is no freeform
-- dimension in which an IP, token, room code, or display name could be hidden.
CREATE TABLE analytics_daily (
	day TEXT NOT NULL CHECK (length(day) = 10),
	metric TEXT NOT NULL CHECK (
		metric IN (
			'room_created', 'room_joined', 'game_started', 'turn_completed',
			'game_finished', 'coaching_summary_saved',
			'coaching_summary_deleted', 'cloud_consent_granted',
			'cloud_consent_revoked'
		)
	),
	event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
	value_sum REAL NOT NULL DEFAULT 0,
	value_min REAL NOT NULL DEFAULT 0,
	value_max REAL NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (day, metric)
);

CREATE INDEX analytics_daily_day_idx ON analytics_daily (day DESC);
