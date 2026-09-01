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
npm run test:worker-runtime-runner
npm run test:smoke-support
npm run test:staging-outbox-smoke
npm run check:cloudflare-types
npm run typecheck:cloudflare
npm run test:cloudflare
npm run test:cloudflare-runtime
npm run test:cloudflare-runtime-outbox
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

For the receiver, cleanup, compatibility bridge, and gated Release-B producer,
the green test gate must prove all of the following without adding a public
receiver route:
canonical payload rejection and hashing; one first D1 application; no repeated
D1 or Analytics Engine effect for an exact replay; conflict on event-ID reuse
with a different payload; fail-closed receipt behavior on marker 5; marker-5
cleanup that never prepares receipt SQL; marker-6 cleanup that deletes only
expired receipts and includes any remainder in the bounded backlog result;
ordinary best-effort rooms that create neither local outbox tables nor receipts;
exact-mode room state, complete milestone group, and alarm persistence in one
local transaction; stable lifecycle/event entropy across a transaction replay;
all-or-drop final-turn pairs at the queue boundary; no legacy dual delivery;
and FIFO one-at-a-time drain, persisted bounded retry, and privacy-minimal
dead-letter handling for a version-1 local outbox. A failed Analytics Engine
write remains non-fatal and is not retried.

The current committed production and staging configurations explicitly remain
`ROOM_MILESTONE_DELIVERY_MODE=best-effort`. Release B includes the exact-mode
producer, but configuration keeps it dormant: ordinary traffic retains the
header plus `waitUntil` path and creates no local outbox tables. Only the exact,
case-sensitive value `outbox` selects the producer. In that mode, a
milestone-producing mutation commits room state, the complete canonical event
group (or bounded all-or-drop counter), and the shared alarm atomically before
the response or WebSocket broadcast. This release adds no D1 migration,
Cloudflare service, binding, Queue, paid product, or separate alarm
configuration, so the normal best-effort `npm run deploy` sequence remains
unchanged.

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

For any migration PR, run this staging promotion and verify it before merging.
The repository-connected production build runs `npm run deploy`, so merging to
`main` can apply the production migration automatically; a post-merge staging
test would be too late to preserve staging-first order.

That command applies only staging migrations, deploys with strict mode, checks
the public pages and status API, writes one synthetic compact baseline summary,
verifies its reviewed schema-5/6 cleanup-heartbeat contract, profile-foundation, and relationship round-trips, and
deletes the device-scoped cloud history. The mutating probe refuses to run
against a host that is not the designated HTTPS staging Workers.dev hostname.
It never sends audio, transcript text, user content, or an external model
request.

The staging probe does not invoke the internal room-milestone receiver and is not
an end-to-end durable-delivery test. Before promotion, use both local runtime
lanes above to exercise the receiver, cleanup, bridge, and exact producer. While
staging remains on its committed best-effort value, an ordinary staging
multiplayer smoke must create no local outbox tables, and receipt-row counts
inspected before and after that smoke must not increase.

### Room-milestone outbox activation

Treat exact-mode activation as a separate configuration release after the
producer-capable Worker has already run safely in `best-effort`. An exact room
claims ownership with a comma-only v1 sentinel in the existing private milestone
header only after that object version owns delivery. Release A already parses
the sentinel as an empty event list and removes the header; Release B recognizes
it as authoritative. An older/best-effort object returns real milestone values
for the legacy fallback. This
covers unavoidable Cloudflare propagation skew in both directions. Still avoid
an intentional gradual deployment, traffic split, or mixed-configuration
rollout so activation evidence and rollback remain unambiguous. Activate and
roll back one complete environment/version at a time.

Use this order:

1. Confirm staging is on the reviewed Release-B code, D1 reports schema exactly
   6, and its independent `ROOM_FACT_HASH_KEY` secret has 32 through 1,024 UTF-8
   bytes. The admin token and Analytics Engine binding do not gate outbox
   delivery.
2. Reserve a quiet staging window outside its 03:47 UTC cleanup and a UTC-day
   rollover; stop other staging probes and clients. Record staging receipt and
   daily-rollup baselines, change only staging to the exact `outbox` value, and
   perform one full-version deployment. Status must report room-milestone
   delivery as `durable-outbox`; `degraded-outbox` is a stop condition.
3. Run `npm run smoke:staging-outbox`. It hard-refuses any non-staging origin,
   requires overall healthy schema-6 `durable-outbox` readiness before mutation,
   drives isolated synthetic create/join/start/two-turn finish/reset traffic,
   rejects leaked private protocol headers, and bounded-polls fixed aggregate-only
   D1 queries for seven receipts, one room fact, and the exact rollup deltas.
   The privacy-minimal schema intentionally has no probe correlation ID, so any
   concurrent staging write or cleanup makes this check fail closed. Discard
   that run, restore a quiet window, and start again from a fresh baseline;
   never loosen the exact-delta assertions to force a pass.
   Local runtime tests separately prove strict FIFO head order and an empty drained
   queue because Durable Object SQLite has no public inspection route. Confirm
   clean retry/dead-letter logs. Never dump room SQLite or canonical payloads into
   a ticket or log.
4. Drill rollback by deploying Release A or a newer reviewed bridge with
   `best-effort`, then prove any locally queued exact-mode row still drains once.
   Confirm new ordinary traffic uses the legacy path without adding outbox rows.
   Do not select a pre-Release-A version. Restore the Release-B staging candidate
   and repeat the exact-mode smoke.
5. Only after the staging activation and rollback drill pass, make a separate
   production configuration change. Reconfirm schema 6, the secure production
   room-fact key, zero pending migrations, the exact version, and recent cleanup
   health; then deploy the entire production version without an intentional traffic split.
   Compare the same bounded receipt/rollup/fact deltas and watch outbox retry,
   dead-letter, drop, D1, and room-error events.

If the room-fact key is missing or outside its byte boundary after activation,
public status changes to `degraded-outbox`, but the receiver still applies and
ACKs the opaque receipt and eligible daily rollup while deliberately skipping
the keyed room fact. Restoring the key does not backfill that fact: the local row
has been ACKed, and an exact replay is a duplicate while its receipt remains.
Treat key readiness as a hard pre-activation and ongoing operational gate.

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

   The schema-5/6 bridge was deployed and verified on marker 5 before
   `0006_room_milestone_receipts.sql` was added. Migration 0006 is additive and
   schema-only: it creates an empty, privacy-minimal receipt table, advances the
   marker to 6, and preserves all schema-v5 tables, columns, constraints, queries,
   and records. Existing platform routes continue to use the schema-v5 SQL
   contract. The internal room-milestone receiver and receipt expiry cleanup are
   isolated schema-6-only paths. Each logical D1 operation performs an uncached
   singleton marker read first; marker-5 cleanup never prepares receipt-table SQL,
   and unsupported markers fail closed immediately without a Worker restart.

   With the currently committed production and staging value of `best-effort`,
   normal room traffic retains its header plus `waitUntil` fan-out, initializes
   no local outbox schema, and does not insert receipts. Release B also contains
   a gated producer selected only by the exact `outbox` value. Its
   milestone-producing room mutations atomically persist state, all canonical
   events or one bounded drop decision, and the alarm. The internal receiver
   receipt-gates one D1 application; schema-6 cleanup removes expired receipts in
   the existing bounded cleanup lifecycle. Analytics Engine receives only one
   best-effort post-commit opportunity for a newly applied event.

   Release A imports the receiver and can lazily recognize an already-existing
   version-1 Durable Object outbox left by Release B or a rollback.
   It drains only the FIFO head, one event per alarm, and persists bounded retry
   and privacy-minimal dead-letter state. It does not enqueue normal-room events,
   so Release A itself makes no end-to-end durable-delivery claim. The D1 receipt
   table permits only opaque lowercase 256-bit IDs/hashes and canonical UTC
   receipt/application/exact-90-day-expiry timestamps. After applying migration
   0006, roll code back only to a reviewed marker-6-compatible bridge—not an older
   Worker that requires exact marker 5. After any exact-mode Release-B row has
   been produced, Release A is the permanent minimum rollback floor;
   pre-Release-A code cannot drain those rows and can overwrite their shared
   alarm. Keep probes compatible with both markers through the activation and
   rollback window, then contract a later release to exact marker 6 only after
   that separate compatibility decision.
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
- room-milestone analytics `delivery: "best-effort"` under the currently
  committed production and staging configuration. Release B reports
  `durable-outbox` only when its producer is compiled, the mode is exact
  `outbox`, the schema is exactly 6, and `ROOM_FACT_HASH_KEY` is secure. An
  exact-mode schema/key mismatch reports `degraded-outbox` and adds
  `aggregateAnalyticsDelivery` to the degraded list. Coaching/progress product
  events remain best-effort even when the room-milestone lane is durable;
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
| `room_alarm_schedule_failed` | The shared room-expiry/outbox alarm could not be renewed | Check Durable Object incidents and repeat activity |
| `room_expiry_delete_failed` | An expired room could not be deleted; a retry was scheduled | Check Durable Object storage and confirm a later retry succeeds |
| `worker_request_failed` | An unexpected edge/API dependency failed behind a request ID | Correlate request ID and Worker version; check dependent services |
| `room_milestone_delivery_failed` | Best-effort D1/analytics milestone failed | Do not interrupt play; inspect aggregate impact |
| `room_milestone_outbox_dropped` | An exact-mode event group was dropped for bounded capacity or canonicalization reasons while gameplay committed | Check only reason/count and queue health; do not dump room state or payloads |
| `room_milestone_outbox_delivery_failed` | A local-outbox head could not reach the internal receiver | Confirm the persisted retry is scheduled; do not expose the room or event ID |
| `room_milestone_outbox_retry_scheduled` | The bridge/consumer persisted another bounded attempt | Check D1/schema/key health; later FIFO events remain blocked behind the head |
| `room_milestone_outbox_dead_lettered` | A head reached a terminal conflict, validation failure, deadline, or attempt limit | Investigate the reason field without dumping private Durable Object storage |
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
or migration record during incident response. Marker 6 already excludes Workers
that require exact marker 5.

Before exact-mode activation, the current Release-B deployment remains on the
same ordinary best-effort path. After any environment has produced even one
version-1 exact-mode row, Release A becomes its minimum safe rollback floor:
deploy Release A or a newer compatible bridge with `best-effort` so existing
rows continue to drain while new milestones use the legacy path. The ownership
response keeps ordinary Release-A/Release-B propagation skew safe, but avoid an
intentional mixed-configuration rollback and never select a pre-Release-A
Worker; it can overwrite the shared alarm and strand rows. Do not delete the namespace,
local tables, pending rows, or dead letters as a rollback technique. Run the
staging rollback drill above before production activation, and repeat the
read-only status/receipt/rollup checks after any real rollback.

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

Schema v6 defines `room_milestone_receipts`, and scheduled cleanup actively
removes expired rows from it within the same bounded run budget. The final
backlog probe includes receipt work only on marker 6. Marker-5 cleanup never
prepares SQL that names the table. Each receipt expires exactly 90 days after
its first receiver timestamp; this is a bounded deduplication window, not a
permanent delivery ledger. Normal best-effort room traffic initializes no local
outbox and creates no receipt rows. Exact-mode Release-B delivery does create
them, and Release A can continue creating them while draining rows during a
rollback. Public cleanup status still exposes only the shared `ready`, `stale`,
or `backlog` result, not receipt counts or timestamps.

A local outbox event has a seven-day hard deadline and at most 16 attempts.
Terminal events retain only bounded reason/milestone/attempt/timing metadata—no
event ID, payload, room code, token, name, topic, audio, or transcript—in a
256-row dead-letter table for at most 30 days. The room's 30-day privacy expiry
outranks telemetry retention and deletes the entire Durable Object, including
its queue, dead letters, and alarm. Because normal local rows are ACKed or
terminal long before the 90-day D1 receipt expires, receipt cleanup does not
cause a producer replay. Conversely, a receipt applied while the room-fact key
is unavailable prevents an exact duplicate from backfilling the skipped fact;
restoring the key cannot reconstruct it after the local ACK.

Quarterly, verify:

- Cloudflare allowances and provider terms;
- D1 size, pending migrations, and cleanup backlog signals;
- active secret names and operator access;
- current Wrangler, Workers types, compatibility date, and startup profile;
- recovery commands against a non-production environment;
- the privacy, security, accessibility, and browser test findings.
