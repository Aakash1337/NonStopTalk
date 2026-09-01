# Production operations

This runbook covers the native Cloudflare deployment of NonStopTalk. It is
deliberately small enough for one operator and uses only the services already
declared in `wrangler.jsonc`.

## Production inventory

| Responsibility | Cloudflare resource | Source of truth |
| --- | --- | --- |
| HTTPS application and versioned API | Worker `nonstoptalk` + Static Assets | Git `main` and `wrangler.jsonc` |
| Live room coordination | `RoomDurableObject`, one object per room code | Durable Object SQLite |
| Consented compact progress and aggregate facts | D1 `nonstoptalk-platform` | Append-only files in `cloudflare/migrations` |
| Product telemetry | D1 daily rollups + Analytics Engine `nonstoptalk_product` | Fixed event contract in `platform.ts` |
| Runtime health | Workers Logs and sampled traces | Structured events from `observability.ts` |
| External topic generation | Deterministic by default; optional adapters | Provider selectors in `wrangler.jsonc`, keys in Wrangler secrets |

The default provider policy is `offline` / `off` with a daily external-call
ceiling of 100. A normal deploy must not contact a model.

`dontstoptalking.org` is declared as the production custom domain in
`wrangler.jsonc`. Version preview URLs are disabled because a preview would
otherwise share its environment's Durable Objects and D1 bindings. Source maps
are uploaded privately for stack-trace symbolication, and the version-metadata
binding can identify a deployed Worker version in structured failures.

## Deployment gates

Run these from a clean checkout before a production deployment:

```sh
npm clean-install
npm run audit:dependencies
go test ./...
go test -race ./...
go vet ./...
npm run test:coach
npm run test:cloud-progress
npm run check:cloudflare-types
npm run typecheck:cloudflare
npm run test:cloudflare
npm run test:cloudflare-runtime
npm run check:cloudflare
npm run check:cloudflare-staging
npm run check:cloudflare-startup
npm run smoke:platform
```

The GitHub workflow runs the same checks plus all browser smoke suites. A
production deploy should come from a reviewed, green `main` commit. Workers
Builds uses the repository root and `npm run deploy` as its deploy command.
That command applies production migrations, deploys in strict mode, then runs
the retrying read-only production probe. Direct dashboard edits can conflict
with strict mode and should be reconciled into `wrangler.jsonc` before retrying.

After deployment, run the read-only production probe:

```sh
npm run smoke:production
```

Set `NONSTOPTALK_PRODUCTION_ORIGIN` to probe another HTTPS environment. The
probe never creates a room, changes consent, or writes a coaching record.

## Staging promotion

The `staging` Wrangler environment is a separate Worker with its own D1
database, Analytics Engine dataset, rate-limit namespaces, secrets, cron, and
Workers.dev hostname. It has no production custom-domain route. Promote a
candidate with:

```sh
npm run deploy:staging
```

That command applies only staging migrations, deploys with strict mode, checks
the public pages and status API, writes one synthetic compact baseline summary,
verifies its relationship round-trip, and deletes the device-scoped cloud
history. The mutating probe refuses to run against a host that is not the
designated HTTPS staging Workers.dev hostname. It never sends audio, transcript
text, user content, or an external model request.

## Migration discipline

1. Never edit a migration that has reached any shared environment.
2. Create the next numbered SQL file and advance `platform_meta.schema_version`
   in the same transaction.
3. Keep every migration compatible with the currently deployed Worker. D1 is
   migrated before code when deployment automation applies both.
   The schema-v3 Worker intentionally accepts and reports schema markers 3 and
   4 so the reviewed schema-v4 expand migration can land without a readiness
   outage. Do not widen that one-version window without another compatibility
   release and explicit old/new Worker tests.
4. Exercise a fresh database and every supported upgrade path through
   `npm run smoke:platform`.
5. Apply production migrations with `npm run db:migrate:remote`. Wrangler asks
   for confirmation interactively, skips the prompt in CI, captures a backup,
   and rolls back the failing migration transaction.
6. Deploy the matching Worker immediately after a successful migration and run
   `npm run smoke:production`.

List pending production migrations without changing data:

```sh
npx wrangler d1 migrations list PLATFORM_DB --remote --env=
```

Export a separate logical backup before a high-risk data migration:

```sh
npx wrangler d1 export PLATFORM_DB --remote --env= --output nonstoptalk-platform-backup.sql
```

Store exports outside the repository. They contain user-consented summaries
and must be handled as private data.

### Point-in-time recovery

D1 Time Travel is always enabled and has no separate restore charge. The Free
plan retains seven days of database history; Paid retains 30 days. Before risky
work, capture and privately record the current production bookmark:

```sh
npx wrangler d1 time-travel info PLATFORM_DB --env=
```

To identify a candidate recovery point without changing data, request its
bookmark using an RFC3339 timestamp:

```sh
npx wrangler d1 time-travel info PLATFORM_DB --env= --timestamp "2026-09-01T12:00:00Z"
```

Restoring is destructive: it cancels in-flight queries and overwrites the
production database in place. Do not run it until the target bookmark, current
bookmark, incident window, and matching Worker version have been independently
checked. The recovery command is:

```sh
npx wrangler d1 time-travel restore PLATFORM_DB --env= --bookmark <TARGET_BOOKMARK>
```

Record the previous bookmark printed by Wrangler; it is the undo point. After
the restore, verify schema version, aggregate row counts, status, and the
read-only production smoke probe. If the recovery point was wrong, restore the
previous bookmark and repeat the same verification. Time Travel is for incident
recovery, not for testing migrations or creating staging copies.

## Health checks

`GET /api/v1/platform/status` is the canonical unauthenticated readiness probe.
A healthy response has:

- HTTP 200 and `status: "ok"`;
- the API and D1 schema versions expected by the deployed code;
- an empty `degradedCapabilities` array;
- ready cloud progress, room facts, and aggregate admin analytics;
- Analytics Engine enabled;
- either offline or ready topic-provider tiers.

The probe proves configuration and D1 readiness. It cannot prove Workers Paid
entitlement for GLM 5.3 Flash. The first consented call still fails closed to a
deterministic topic draft if the account cannot run that model.

Useful read-only commands:

```sh
npx wrangler whoami
npx wrangler deployments list --env=
npx wrangler versions list --env=
npx wrangler secret list --env=
npx wrangler d1 info PLATFORM_DB --env=
npx wrangler d1 migrations list PLATFORM_DB --remote --env=
```

Never paste secret values into a ticket, log, chat, command argument, dashboard
query, or Git commit. `wrangler secret list` exposes names only.

## Logs and alerts

The cheap-first baseline in `wrangler.jsonc` samples 100% of logs and 1% of
traces in both environments while pilot traffic is low. Check each Worker's
Observability page plus account usage/billing after a release and weekly; if a
Free deployment starts growing, check daily. Count invocation and custom/error
events, not requests alone. Before measured Free daily usage or the Paid monthly
projection reaches 80% of its included event allowance, lower production logs
from `1` to `0.1`; use `0.01` if that projection still crosses the guardrail.
Staging may use `0.1` between promotions and return temporarily to `1` for a
promotion or incident. Keep traces at `0.01` unless their shared event forecast
requires a further reduction.

Make sampling changes in source control: production uses the top-level
`observability` block, while an independent staging rate belongs in a complete
`env.staging.observability` block. Run the matching strict dry run, deploy only
that environment, and revert temporary diagnostic sampling afterward. Sampling
is head-based, so an unsampled request can also hide its error event; the
external status monitor remains mandatory at every sampling rate.

Worker code emits one JSON object per operational event. Search by the stable
`event` field rather than message text. Important events include:

| Event | Meaning | First response |
| --- | --- | --- |
| `platform_api_failed` | D1 or an unexpected platform route failure | Check status, D1, and recent deployment |
| `platform_cleanup_failed` | Scheduled retention did not complete | Inspect D1 availability; cleanup retries on the next cron |
| `platform_cleanup_budget_exhausted` | More expired rows remain | Expected for a backlog; confirm later runs reduce it |
| `room_request_failed` | A Durable Object request failed unexpectedly | Correlate time/version and inspect room-error rate |
| `room_expiry_schedule_failed` | A room alarm could not be renewed | Check Durable Object incidents and repeat activity |
| `room_expiry_delete_failed` | An expired room could not be deleted; a retry was scheduled | Check Durable Object storage and confirm a later retry succeeds |
| `worker_request_failed` | An unexpected edge/API dependency failed behind a request ID | Correlate request ID and Worker version; check dependent services |
| `room_milestone_delivery_failed` | Best-effort D1/analytics milestone failed | Do not interrupt play; inspect aggregate impact |
| `product_analytics_rollup_failed` | Best-effort D1 telemetry write failed | Do not treat analytics as a ledger |
| `analytics_engine_write_failed` | Analytics Engine delivery failed | D1 rollup may still exist |
| `model_usage_reconciliation_failed` | A completed model attempt was not reconciled | Keep providers disabled until cost counters are understood |

For the pilot stage, configure an external HTTPS monitor for the status endpoint
at five-minute intervals and alert only after two consecutive failures. Alert
on a non-200 response, `status != ok`, or a non-empty degraded list. Keep model
providers offline during a D1 or budget-control incident.

Tail only when actively diagnosing; live tails can contain operational request
paths and should not be left running unattended:

```sh
npx wrangler tail nonstoptalk --format json --status error
```

## Incident playbooks

### Site or API unavailable

1. Confirm the custom domain and Workers.dev status endpoints independently.
2. Check Cloudflare service status and the latest Workers deployment.
3. Inspect structured error events around the first failure.
4. If the failure began with a code-only deployment, roll back to the last known
   good Worker version.
5. Run the production smoke probe and record the affected window.

### D1 unavailable or schema degraded

1. Do not recreate or delete the database.
2. List migrations and query only `platform_meta` plus aggregate row counts.
3. If a migration is pending, apply it and deploy the matching code.
4. If a migration failed, preserve Wrangler's backup and fix forward with a new
   numbered migration. Never rewrite the applied file.
5. Local coaching and live game rules should continue; cloud progress may be
   temporarily unavailable.

### Room failures

1. Check whether failures affect one room or all room requests.
2. Do not enumerate or dump Durable Object room content.
3. Verify Worker version, Durable Object binding, migration tag, and socket
   errors. A code rollback does not delete room SQLite state.
4. If only aggregate milestone delivery fails, keep gameplay available and
   repair telemetry separately.

### Unexpected model usage

1. Set the relevant provider selector back to `offline` or `off` in
   `wrangler.jsonc`, deploy, and verify public status.
2. Do not delete the AI binding; the deterministic policy is the cost switch.
3. Inspect protected aggregate model usage and provider billing without exposing
   themes or responses.
4. Rotate only the affected provider key and re-enable after the cause and daily
   ceiling are verified.

### Suspected secret exposure

1. Replace the affected Wrangler secret immediately.
2. Redeploy if necessary and verify status.
3. For `ANALYTICS_ADMIN_TOKEN`, invalidate all existing operator copies.
4. For `ROOM_FACT_HASH_KEY`, understand that rotation breaks linkage to existing
   pseudonymous room facts; retain or delete old aggregates according to the
   incident decision.
5. Review Git history and logs without committing a replacement value.

## Rollback and recovery

List versions before selecting a target:

```sh
npx wrangler versions list
npx wrangler rollback <VERSION_ID>
```

Rollback is appropriate for a code or asset regression. D1 migrations are
forward-only: after a schema change, choose a Worker version compatible with the
new schema or fix forward. Do not delete a D1 database, Durable Object namespace,
or migration record during incident response.

## Retention checks

The Worker cron runs daily at 03:17 UTC. Anonymous cloud-summary ownership uses
one roughly 30-day device lease; pseudonymous room facts expire after 90 days.
Cleanup is bounded and can continue a backlog on the next run. Raw audio,
recordings, and captured transcript text are not present in D1 and remain in the
user's browser only when separately retained.

Quarterly, verify:

- Cloudflare allowances and provider terms;
- D1 size, pending migrations, and cleanup backlog signals;
- active secret names and operator access;
- current Wrangler, Workers types, compatibility date, and startup profile;
- recovery commands against a non-production environment;
- the privacy, security, accessibility, and browser test findings.
