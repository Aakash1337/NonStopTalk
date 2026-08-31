-- Aggregate-only accounting for optional hosted model calls. The global row
-- is the atomic spend/call reservation gate; provider rows contain only
-- operational totals and never prompts, topics, transcripts, identities, or
-- provider responses.
CREATE TABLE model_usage_daily (
	day TEXT NOT NULL CHECK (
		length(day) = 10
		AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
	),
	scope TEXT NOT NULL CHECK (scope IN ('global', 'provider')),
	provider TEXT NOT NULL CHECK (
		length(provider) BETWEEN 1 AND 64
		AND provider NOT GLOB '*[^A-Za-z0-9._:-]*'
	),
	model TEXT NOT NULL CHECK (
		length(model) BETWEEN 1 AND 128
		AND model NOT GLOB '*[^A-Za-z0-9._:/-]*'
	),
	task TEXT NOT NULL CHECK (task IN ('all', 'topics')),
	reserved_calls INTEGER NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0),
	completed_calls INTEGER NOT NULL DEFAULT 0 CHECK (completed_calls >= 0),
	success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
	failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
	input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
	output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
	total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
	cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
	reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
	latency_ms_total INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms_total >= 0),
	updated_at TEXT NOT NULL,
	PRIMARY KEY (day, scope, provider, model, task),
	CHECK (
		(scope = 'global' AND provider = 'all' AND model = 'all' AND task = 'all')
		OR (scope = 'provider' AND provider <> 'all' AND model <> 'all' AND task = 'topics')
	),
	CHECK (completed_calls = success_count + failure_count),
	CHECK (scope = 'global' OR reserved_calls = 0),
	CHECK (scope = 'provider' OR reserved_calls >= completed_calls)
);

CREATE INDEX model_usage_daily_day_idx
	ON model_usage_daily (day DESC, scope, provider, model);

UPDATE platform_meta
SET schema_version = 3,
	applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1 AND schema_version = 2;
