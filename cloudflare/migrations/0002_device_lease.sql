-- Replace per-summary expiry with one device-level inactivity lease. The
-- foreign key already cascades device deletion to every consent and summary.
CREATE TABLE coaching_sessions_v2 (
	device_key TEXT NOT NULL,
	session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
	analysis_schema_version INTEGER NOT NULL CHECK (analysis_schema_version = 2),
	client_created_at TEXT NOT NULL,
	received_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	scenario TEXT NOT NULL CHECK (scenario IN ('interview', 'presentation', 'impromptu')),
	goal TEXT NOT NULL CHECK (goal IN ('pace', 'pauses', 'energy')),
	target_duration_ms INTEGER NOT NULL CHECK (target_duration_ms BETWEEN 15000 AND 180000),
	duration_ms REAL NOT NULL CHECK (duration_ms BETWEEN 0 AND 600000),
	speaking_ratio REAL NOT NULL CHECK (speaking_ratio BETWEEN 0 AND 1),
	pause_count INTEGER NOT NULL CHECK (pause_count BETWEEN 0 AND 10000),
	audio_confidence TEXT NOT NULL CHECK (audio_confidence IN ('low', 'medium', 'high', 'unknown')),
	transcript_metrics_used INTEGER NOT NULL CHECK (transcript_metrics_used IN (0, 1)),
	summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND length(summary_json) <= 65536),
	practice_loop_id TEXT,
	baseline_attempt_id TEXT,
	attempt_role TEXT NOT NULL DEFAULT 'standalone'
		CHECK (attempt_role IN ('standalone', 'baseline', 'retry')),
	client_release TEXT,
	PRIMARY KEY (device_key, session_id),
	FOREIGN KEY (device_key) REFERENCES devices(device_key) ON DELETE CASCADE
);

INSERT INTO coaching_sessions_v2 (
	device_key, session_id, analysis_schema_version, client_created_at,
	received_at, updated_at, scenario, goal, target_duration_ms, duration_ms,
	speaking_ratio, pause_count, audio_confidence, transcript_metrics_used,
	summary_json, practice_loop_id, baseline_attempt_id, attempt_role, client_release
)
SELECT
	session.device_key, session.session_id, session.analysis_schema_version,
	session.client_created_at, session.received_at, session.updated_at,
	session.scenario, session.goal, session.target_duration_ms, session.duration_ms,
	session.speaking_ratio, session.pause_count, session.audio_confidence,
	session.transcript_metrics_used, session.summary_json, session.practice_loop_id,
	session.baseline_attempt_id, session.attempt_role, session.client_release
FROM coaching_sessions AS session
JOIN devices AS device ON device.device_key = session.device_key
WHERE session.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	AND device.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

DROP TABLE coaching_sessions;
ALTER TABLE coaching_sessions_v2 RENAME TO coaching_sessions;

CREATE INDEX coaching_sessions_device_created_idx
	ON coaching_sessions (device_key, client_created_at DESC, session_id DESC);
CREATE INDEX coaching_sessions_received_at_idx ON coaching_sessions (received_at);

UPDATE platform_meta
SET schema_version = 2,
	applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1 AND schema_version = 1;
