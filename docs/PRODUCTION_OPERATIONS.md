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
npm run test:admin
npm run test:production-monitor
npm run test:deployment-contract
npm run test:smoke-support
npm run check:cloudflare-types
npm run typecheck:cloudflare
npm run test:cloudflare
npm run test:cloudflare-runtime
npm run check:cloudflare
npm run check:cloudflare-staging
npm run check:cloudflare-startup
npm run smoke:platform
npm run smoke:multiplayer
npm run smoke:accessibility
npm run smoke:coach
npm run smoke:admin
npm run smoke
```

The GitHub workflow runs this same verification matrix. A
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

The `Production health` GitHub Actions workflow runs this same probe at minutes
17 and 47 of every hour and supports manual dispatch. It installs no packages,
uses no repository or Cloudflare secrets, has read-only repository permission,
and stops after five minutes. GitHub reports a failed probe in Actions and sends
scheduled-workflow notifications to the current schedule actor (initial
creator, a later cron editor, or the user who re-enables it); do not assume
repository watchers receive them. The probe itself retries each public GET up
to five times before failing, which absorbs a short network interruption
without concealing a sustained outage.

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
verifies its reviewed schema-5/6 cleanup-heartbeat contract, profile-foundation, and relationship round-trips, and
deletes the device-scoped cloud history. The mutating probe refuses to run
against a host that is not the designated HTTPS staging Workers.dev hostname.
It never sends audio, transcript text, user content, or an external model
request.

## Migration discipline

1. Never edit a migration that has reached any shared environment.
2. Create the next numbered SQL file and advance `platform_meta.schema_version`
   in the same transaction.
3. Keep every migration compatible with the currently deployed Worker. D1 is
   migrated before code when deployment automation applies both.
   The earlier compatibility release accepted schema markers 4 and 5 while
   using only the schema-v4 contract. Migration `0005_cleanup_heartbeat.sql` is
   additive, and the matching feature Worker requires marker 5. That older
   compatibility Worker remains data-compatible after migration 0005, but it
   does not report `retentionCleanup`; the strict smoke probe and twice-hourly
   monitor intentionally fail during that temporary loss of observability.
   Fix forward promptly.

   The current compatibility-only release adds no migration. It accepts and
   reports only schema markers 5 and 6 while every platform route, scheduled
   cleanup, and model-budget operation continues to read and write only the
   schema-v5 SQL contract. Each logical D1 operation performs an uncached
   singleton marker read first, so unsupported markers fail closed immediately
   without a Worker restart. Deploy and
   verify this bridge on marker 5 before adding or applying migration `0006`.
   That migration must be additive and preserve all schema-v5 tables, columns,
   constraints, and behavior so this Worker remains a safe code rollback on
   marker 6. Exercise the bridge against both markers and the old/new Worker
   paths; after the schema-v6 feature release and rollback window are complete,
   narrow the feature Worker and its probes to require exactly marker 6.
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
- ready cloud progress, retention cleanup, room facts, and aggregate admin analytics;
- Analytics Engine enabled;
- either offline or ready topic-provider tiers.

The probe proves configuration and D1 readiness. It cannot prove Workers Paid
entitlement for GLM 5.3 Flash. The first consented call still fails closed to a
deterministic topic draft if the account cannot run that model.

## Operator analytics dashboard

Open `https://dontstoptalking.org/admin/analytics` directly. It is deliberately
absent from public navigation. Enter the same numeric `ANALYTICS_ADMIN_TOKEN`
configured as a Worker secret; do not put it in the URL, a bookmark, a shell
argument, a screenshot, or a ticket. The page clears the password field before
requesting data and does not retain the token after the two requests finish.
Refreshing data requires entering it again.

The dashboard requests the protected product and model endpoints once each for
90 UTC days, then computes its 1/7/30/90-day views locally. It refuses to render
when source windows, row invariants, product totals, global model totals, or
provider/global reconciliation disagree. Event ratios are not cohorts and may
cross a selected window boundary. The current UTC day is partial. An em dash
means a rate or latency has no denominator. `reserved - completed` is the model
reconciliation guardrail; investigate an unexpected nonzero value before
enabling or expanding provider spend.

A request that straddles 00:00 UTC can rarely see adjacent source windows and
fail closed with a source-consistency error. Re-enter the token and retry after
the rollover; the dashboard deliberately does not auto-retry or show a partial
mix of the two extracts.

This document intentionally differs from public pages: the Worker routes it
first, returns `Cache-Control: public, max-age=0, must-revalidate, no-transform`,
allows only same-origin scripts and connections, sends no referrer, and marks
the page noindex. `no-transform` prevents Cloudflare's automatically injected
Web Analytics beacon from entering the token-bearing document. The production
smoke probe verifies the document and headers without possessing or exercising
the admin secret.

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

The scheduled GitHub workflow is the zero-secret, cheap-first baseline. It runs
twice per hour and checks the public pages, the isolated dashboard document,
security headers, and the canonical status response. GitHub schedules are
best-effort: runs can be delayed or dropped during load, and public-repository
schedules are automatically disabled after 60 days without repository activity.
The cron actor should periodically verify recent runs and re-enable the workflow
after a long inactive period. Actions notifications are not an uptime SLA. For
an attended launch or a service with a response-time commitment, add an
independent HTTPS monitor for the status endpoint at five-minute intervals and
alert only after two consecutive failures. Alert on a non-200 response,
`status != ok`, or a non-empty degraded list. Keep model providers offline
during a D1 or budget-control incident. See GitHub's current
[schedule-event notes](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
and [scheduled-run troubleshooting](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#scheduled-workflows-running-at-unexpected-times).

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

Schema v5 stores one non-sensitive cleanup heartbeat row. A successful cron
updates it only after all attempted batches succeed and records whether expired
rows remain after the 20-batch invocation budget. Public status exposes only
`ready`, `stale`, or `backlog`; it never returns deletion counts, timestamps,
identities, or content. The migration timestamp supplies the first-run grace
heartbeat. A heartbeat becomes stale after 36 hours, so a normal daily run has
12 hours of scheduling grace before the twice-hourly production probe fails.
If status reports `backlog`, confirm the next cron clears it. If it reports
`stale`, inspect cron history and `platform_cleanup_failed`. A production
redeploy does not invoke `scheduled()`, and the local Wrangler test URL is not a
production trigger. Deploy any required fix, verify the configured Cron Trigger,
wait for its next scheduled run, and then rerun `npm run smoke:production`.

Quarterly, verify:

- Cloudflare allowances and provider terms;
- D1 size, pending migrations, and cleanup backlog signals;
- active secret names and operator access;
- current Wrangler, Workers types, compatibility date, and startup profile;
- recovery commands against a non-production environment;
- the privacy, security, accessibility, and browser test findings.
