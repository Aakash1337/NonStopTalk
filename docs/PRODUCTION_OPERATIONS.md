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

The optional game judge is a separate default-off feature. It uses per-turn
speaker consent, strict on-device transcription, and the same-origin Worker's
deterministic offline heuristic. Audio never uploads. Transcript text exists
only in browser/Worker request memory and never enters Durable Object/D1
storage, logs, analytics, history, or a provider; only bounded transcript-free
pending metadata and normalized verdicts enter room state. Classic scoring lands
first and remains the fallback. This release adds no judge-specific API key,
secret, binding, migration, provider budget, paid service, or runbook step.

Named game setup kits are not an inventory resource. The current source stores
the saved library—names, applied settings, and custom topics—in unencrypted,
best-effort `localStorage` for one origin/browser profile. Save/delete and
plain-text import/export make no application network, model, analytics, D1, or
Durable Object request. Explicit Apply sends the selected settings/topics—but
not the local kit name—through one existing same-origin room action and uses
normal Durable Object room persistence. The Apply action itself creates no D1
or Analytics Engine work; later ordinary milestones may include coarse applied
settings under the existing pseudonymous room-fact policy. There is no setup-kit
server backup, recovery, synchronization, or new Cloudflare product, resource,
or binding; Apply still consumes an existing Worker/Durable Object request and
write allocation. Deleting coaching history does not delete setup kits, and an
exported `.txt` file is outside app control.

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
npm run test:microphone-selection
npm run test:sound-cues
npm run test:turn-transcription
npm run test:admin
npm run test:production-monitor
npm run test:deployment-contract
npm run test:worker-runtime-runner
npm run test:smoke-support
npm run test:staging-outbox-smoke
npm run test:staging-outbox-rollback-drill
npm run test:production-outbox-smoke
npm run check:cloudflare-types
npm run typecheck:cloudflare
npm run test:cloudflare
npm run test:setup-kits
npm run test:cloudflare-runtime
npm run test:cloudflare-runtime-outbox
npm run check:cloudflare
npm run check:cloudflare-staging
npm run check:cloudflare-startup
npm run smoke:platform
npx playwright install --with-deps chromium
npm run smoke:multiplayer
npm run smoke:accessibility
npm run smoke:coach
npm run smoke:coach-storage
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
the explicit best-effort compatibility lane creating neither local outbox tables
nor receipts;
exact-mode room state, complete milestone group, and alarm persistence in one
local transaction; stable lifecycle/event entropy across a transaction replay;
all-or-drop final-turn pairs at the queue boundary; no legacy dual delivery;
and FIFO one-at-a-time drain, persisted bounded retry, and privacy-minimal
dead-letter handling for a version-1 local outbox. A failed Analytics Engine
write remains non-fatal and is not retried.

The committed production and staging configurations select the exact,
case-sensitive `ROOM_MILESTONE_DELIVERY_MODE=outbox` value. During the dated
2026-09-02 activation proofs, both reported healthy `durable-outbox`; the
read-only monitor requires every current deployment to keep doing so. In exact mode, a
milestone-producing mutation commits room state, the complete canonical event
group (or bounded all-or-drop counter), and the shared alarm atomically before
the response or WebSocket broadcast. The activation adds no D1 migration,
Cloudflare service, binding, secret, Queue, model, paid product, fixed monthly
cost, or separate alarm configuration. It reuses bounded room-local Durable
Object SQLite and the existing alarm and creates one exact-90-day D1 receipt per
delivered milestone. Progress/consent D1 analytics and Analytics Engine remain
best-effort in both environments. On 2026-09-02, the staging drill proved one
pending Release-B joined event drained exactly once after rollback to Release A,
proved an independent Release-A legacy control, restored Release B, and repeated
the exact seven-receipt, one-room-fact, six-rollup smoke. The separate attended
production activation canary then passed with the same exact aggregate deltas.

After deployment, run the read-only production probe:

```sh
npm run smoke:production
```

The expected delivery policy defaults to exact `durable-outbox`. To probe another
HTTPS environment with a different reviewed policy, pass both values
explicitly; the only accepted policies are `best-effort` and
`durable-outbox`:

```sh
node scripts/smoke-production.mjs \
  https://nonstoptalk-staging.aakashplays656.workers.dev \
  durable-outbox
```

`NONSTOPTALK_PRODUCTION_ORIGIN` and
`NONSTOPTALK_EXPECTED_ANALYTICS_DELIVERY` provide the equivalent environment
interface; an explicit second command-line argument takes precedence. The
probe never creates a room, changes consent, or writes a coaching record.

The `Production health` GitHub Actions workflow runs this same probe at minutes
17 and 47 of every hour and supports manual dispatch. It installs no packages,
uses no repository or Cloudflare secrets, has read-only repository permission,
and stops after five minutes. GitHub reports a failed probe in Actions and sends
scheduled-workflow notifications to the current schedule actor (initial
creator, a later cron editor, or the user who re-enables it); do not assume
repository watchers receive them. The probe retries ordinary page and API GETs
up to five times before failing, which absorbs a short network interruption
without concealing a sustained outage. It recursively discovers every deployable
`.js` or `.mjs` file under `cloudflare/public` and validates that complete Static Assets
set as one generation for up to eight bounded attempts. There are currently 12:
the public SPA modules (including the sound-cue and turn-transcription
boundaries), the coaching audio worklet, and the two isolated admin modules.
`cloudflare/public/.assetsignore` excludes the nine current exact `*.test.js`
and `*.test.mjs` paths from both deployments with Wrangler's case-insensitive
gitignore semantics. The deployment contract locks that packaging boundary, and
each live probe also requires every discovered excluded script path to resolve
to protected HTML rather than executable JavaScript. Source
discovery is capped at 64 scripts, 16 directory levels, 512 bytes per encoded
public path, and 4 MiB across the checked-out JavaScript generation. Every
checked-out and served JavaScript asset must be canonical UTF-8 without a BOM;
every served asset must match its checked-out release source byte-for-byte, use
a JavaScript media type, carry `X-Content-Type-Options: nosniff`, contain a
non-empty non-HTML body, parse as module syntax, and stay within the 512 KiB
decompressed-body ceiling. The existing semantic checks additionally verify the
reviewed core SPA import/consumption/export graph. These source and shape checks
are deployment canaries, not general JavaScript reachability proofs; CI and the
browser smokes exercise the runtime integrations. The bounded whole-generation
retry accommodates the brief mixed asset generation an edge can expose
immediately after a deployment while still failing a persistent mixed
generation, missing or unexpectedly exposed asset, wrong source/MIME type, HTML fallback, oversized
body, noncanonical encoding or BOM, invalid syntax, or missing security header.
The recursive source manifest automatically brings a future deployable `.js` or
`.mjs` asset not matched by the exact test exclusions into both production and
staging monitoring; the fixed current-inventory test then requires an explicit
review before CI accepts that expanded set.

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

The general staging probe does not invoke the internal room-milestone receiver
and is not an end-to-end durable-delivery test. Before promotion, use both local
runtime lanes above to exercise the receiver, cleanup, bridge, and exact
producer. Because staging now runs exact `outbox`, follow a staging deployment
with `npm run smoke:staging-outbox` in a quiet window and require the exact
receipt, room-fact, and rollup deltas described below. The isolated local
best-effort runtime remains the no-outbox/no-receipt compatibility control;
production is exact.

### Completed room-milestone outbox activation evidence

Staging completed its separate exact-mode configuration activation after the
producer-capable Worker ran safely in `best-effort`, and production completed its
separate full-version activation and attended canary on 2026-09-02. An exact room
claims ownership with a comma-only v1 sentinel in the existing private milestone
header only after that object version owns delivery. Release A already parses
the sentinel as an empty event list and removes the header; Release B recognizes
it as authoritative. An older/best-effort object returns real milestone values
for the legacy fallback. This covers unavoidable Cloudflare propagation skew in
both directions. Still avoid
an intentional gradual deployment, traffic split, or mixed-configuration
rollout so activation evidence and rollback remain unambiguous. Activate and
roll back one complete environment/version at a time.

The following order records the completed staging proof and production
activation. Its pinned production-`best-effort` precondition and staging version
IDs describe the dated 2026-09-02 release; they are historical evidence, not a
routine deployment checklist or current production policy.

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
   Unexpected aggregate movement fails the check, but the privacy-minimal schema
   intentionally has no probe correlation ID: a permanently missing synthetic
   event plus an unrelated identical event could theoretically substitute. The
   quiet window is therefore part of the evidence. Discard any overlapped or
   ambiguous run, restore a quiet window, and start again from a fresh baseline;
   never loosen the exact-delta assertions to force a pass.
   Local runtime tests separately prove strict FIFO head order and an empty drained
   queue because Durable Object SQLite has no public inspection route. Confirm
   clean retry/dead-letter logs. Never dump room SQLite or canonical payloads into
   a ticket or log.
4. Prove the rollback bridge with the release-pinned, staging-only
   receiver-fault drill. This drill accepts only Release B
   `f0c9fd39-cd0c-46b2-949d-756ea6ab1e5e` and Release A
   `3116a969-0f6f-4977-959a-97fc3643ad79`. Create the private temporary config,
   upload it without activating it, and run the read-only resource preflight:

   ```sh
   npm run drill:staging-outbox-rollback -- make-fault-config
   npx wrangler versions upload --strict --env staging --config .nonstoptalk-staging-receiver-fault.jsonc
   # Record FAULT_UUID from the upload. Nothing has been activated yet.
   npm run drill:staging-outbox-rollback -- validate-fault f0c9fd39-cd0c-46b2-949d-756ea6ab1e5e <FAULT_UUID> 3116a969-0f6f-4977-959a-97fc3643ad79

   # Terminal 1: start while Release B is still alone at 100%; leave it running.
   npm run drill:staging-outbox-rollback -- prepare f0c9fd39-cd0c-46b2-949d-756ea6ab1e5e <FAULT_UUID> 3116a969-0f6f-4977-959a-97fc3643ad79

   # Terminal 2: run only after Terminal 1 reports fault-observer-ready.
   npx wrangler versions deploy <FAULT_UUID>@100% --env staging --message "Staging receiver-fault rollback drill" --yes
   ```

   The generator hard-requires production `outbox` plus staging `outbox`
   and writes a mode-0600, Git-ignored config whose only semantic change is an
   explicit empty `env.staging.d1_databases`. `validate-fault` requires the pinned
   Release-B candidate alone at 100%, authenticates both reviewed script etags,
   D1 database, Durable Object namespace, assets, secrets, and delivery modes,
   and proves the uploaded fault version differs only by the missing staging
   `PLATFORM_DB`. Do not activate a fault upload unless that preflight succeeds.

   `prepare` starts while the pinned Release-B candidate is still alone at 100%.
   It repeats the version/resource checks, requires healthy schema-6
   `durable-outbox` readiness, and brackets every aggregate read with candidate
   deployment checks. It first starts one unsampled candidate-version JSON tail.
   Pinned Wrangler 4.128.0 has no JSON readiness banner, so the helper requires
   the ordered transport ping and pong emitted by that same child/WebSocket;
   a reviewed preload keeps every other debug record out of the proof pipe. It
   then bounded-retries only a read-only `HEAD` status canary until that exact
   JSON stream receives a candidate-version trace, rechecks the deployment and
   unchanged baseline, and only then creates one seed room. There is no auxiliary
   pretty tail, and room creation is never retried. The seed is accepted only
   after the retained JSON tail observes the
   same Durable Object's successful `POST /create` and clean acknowledgement
   alarm within the bounded two-minute trace window and D1 converges by exactly
   +1 receipt, +1 room fact, and +1
   `room_created`, with every other tracked counter unchanged. That post-seed
   snapshot becomes the fault and rollback baseline; the clean alarm proves the
   seed row was locally acknowledged before fault activation.

   The helper then obtains a distinct guest identity through a 404 path that
   reaches neither D1 nor a Durable Object. After proving that identity differs
   from the host, it clears the host cookie and retains only the seed room code
   plus guest cookie inside the running process. It attaches a JSON tail filtered
   to the still-inactive fault version and requires that same child/WebSocket's
   ordered transport ping and pong before rechecking the candidate
   deployment and baseline, and prints
   `{"status":"waiting","phase":"fault-observer-ready",...}`. This line is the
   authorization boundary for Terminal 2. Do not activate the fault version
   before it appears, and do not stop Terminal 1 after it appears.

   After activation, `prepare` permits only the candidate-to-fault
   single-version transition. It requires failed D1 readiness and unchanged
   aggregates, then uses the distinct non-host guest for `GET /state` on the
   seeded room. The handler creates no room milestone or D1 effect for that
   guest; a reset object may only reconcile its existing local alarm. The
   version-filtered tail must attribute the successful state read to the exact
   seeded Durable Object under the exact fault version. For one unchanged
   deployment, [Cloudflare assigns each Durable Object one Worker version for
   every request](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/).
   The helper therefore needs no fixed propagation soak: the observed state read,
   same-object digest, and unchanged fault deployment are the positive barrier.

   Only after that barrier does `prepare` immediately `POST /join` with the same
   guest. It requires an ordered, complete fault-version trace containing the
   same object's successful state read, successful join, and first single,
   post-commit `database-unavailable` attempt-1 retry schedule. The D1
   baseline must remain unchanged immediately and through the bounded observation
   window. The local reader may accumulate a later, separate alarm document
   before the helper next evaluates attempt 1; matching-object evidence is
   accepted only when it is a contiguous attempt-2, attempt-3, ...
   `database-unavailable` retry. Because a
   version-filtered tail can also receive an already-scheduled alarm from an
   older room, the helper requires a complete, successful Durable Object
   envelope before ignoring another object's proof logs. That alarm can neither
   satisfy nor invalidate the seeded-room chain, and any unique D1 effect remains
   guarded by the exact aggregate deltas.
   A compare-and-swap that loses before committing emits a distinct
   `room_milestone_outbox_retry_stale` record and can never satisfy the proof.
   A missing attempt 1, a duplicate or gap on the proved object, another failure,
   a malformed retry, or a terminal record fails closed. Those facts
   establish one pending local `joined` row; a timed wait or a fresh random
   object is never accepted as proof. Sampling, truncation, exceptions,
   terminal/unexpected outbox logs on the seeded object, unidentifiable alarm
   metadata, concurrent room mutations, cleanup, aggregate movement, split
   traffic, or a third version fails closed.

   Tail data is bounded and immediately projected to proof-only fields. Request
   headers, cookies, client/TLS metadata, room data, event IDs, payloads, and
   unrelated logs are discarded at the parser boundary. The raw Durable Object
   ID is held only in bounded process memory long enough to correlate and hash
   the traces; it is never printed or written. The room code and guest cookie
   likewise remain only in the running `prepare` process and are discarded when
   that operation ends. A seed timeout reports only six numeric projected-trace
   counts so an operator can distinguish attachment, create, alarm, and
   correlation gaps without exposing proof data. If a retry record is malformed,
   the failure reports only three bounded record counts, a boolean for the
   expected failure enum,
   and a categorical attempt-count type. It never reports raw attempt values,
   identifiers, or log content. Only after the full fault proof succeeds does
   `prepare` write a checkpoint: its mode-0600 body contains exactly seven
   aggregate counters, and its opaque filename digests bind the reviewed versions
   and Durable Object without exposing private values.

   Start `verify` in the first terminal **while the fault version is still at
   100%**. It attaches the pinned Release-A JSON tail, requires that same
   child/WebSocket's ordered transport ping and pong, rechecks that the fault
   deployment and aggregate checkpoint are unchanged, and then prints
   `{"status":"waiting","phase":"rollback-observer-ready",...}`. Only after
   that line appears, perform the reviewed rollback in a second terminal:

   ```sh
   # Terminal 1: leave this running before rollback.
   npm run drill:staging-outbox-rollback -- verify f0c9fd39-cd0c-46b2-949d-756ea6ab1e5e <FAULT_UUID> 3116a969-0f6f-4977-959a-97fc3643ad79

   # Terminal 2: run only after Terminal 1 reports rollback-observer-ready.
   npx wrangler rollback 3116a969-0f6f-4977-959a-97fc3643ad79 --env staging --message "Staging outbox rollback drill" --yes
   ```

   `verify` permits only the fault-to-pinned-A single-version transition. It
   requires healthy schema-6 `best-effort` readiness, attributes an `ok` alarm
   to the checkpointed Durable Object under the pinned A version, brackets every
   D1 read with A-at-100% checks, and proves the pending join drains as exactly
   +1 receipt, +0 room-fact rows, and +1 `room_joined`; `room_created` and every
   other tracked counter remain unchanged. The room fact count does not grow
   because the joined state updates the seed room's existing fact. While A
   remains at 100%, `verify` then creates a separate ordinary legacy room and
   proves +1 room fact and +1 `room_created` with receipt count unchanged; all
   other tracked counters remain unchanged in that control. Concurrent traffic,
   cleanup, split traffic, a third version, a counter decrease, or an overshoot
   fails closed. A successful verify removes the checkpoint and fault config.
   Restore the pinned Release-B candidate only after verify exits, then repeat
   the exact-mode smoke:

   ```sh
   npx wrangler versions deploy f0c9fd39-cd0c-46b2-949d-756ea6ab1e5e@100% --env staging --message "Restore reviewed Release-B staging candidate" --yes
   npm run smoke:staging-outbox
   ```

   Wrangler 4.128.0 is pinned because the JSON-tail transport-readiness contract
   is version-specific; any Wrangler update must repeat the preload, marker,
   stream-parser, and live read-only canary review before this drill may run.
   With current Wrangler, `--env staging` resolves the exact environment Worker
   name from `wrangler.jsonc`. Do not also pass the already suffixed
   `nonstoptalk-staging` positional name to `wrangler tail`; Wrangler would target
   `nonstoptalk-staging-staging`. The helper therefore uses the config-resolved
   target and independently requires every proof trace to report exact
   `scriptName: nonstoptalk-staging`, entrypoint `RoomDurableObject`, and the
   pinned version ID. If `prepare` fails before attempting the join, it writes no
   checkpoint and has established no pending proof row. If it loses the causal
   trace after the join attempt, it also writes no checkpoint, and that same
   fault activation must not be retried: the attempted row cannot be classified
   safely without its trace. Restore the reviewed Release-B candidate at 100%,
   wait for healthy exact readiness and aggregate stabilization, and accept only
   no joined-row delta or the exact candidate drain of +1 receipt, +0 room-fact
   rows, and +1 `room_joined`, according to whether the join was attempted. Any
   other delta is an overlap and stops the drill. Then rerun `validate-fault` and
   start a fresh seeded-room prepare/activation sequence. If a later phase aborts
   after a checkpoint exists, preserve that checkpoint for diagnosis and restore
   the candidate first. Remove only the two narrowly named Git-ignored files
   after the result is resolved. Never select a pre-Release-A version.

5. Production activated the reviewed release as one complete version without an
   intentional traffic split. The durable record is:

   | Evidence | Completed value |
   | --- | --- |
   | Reviewed source | PR [#37](https://github.com/Aakash1337/NonStopTalk/pull/37), commit `78b4506c7584a69c7206bca2ec4b503411cbbd60` |
   | Repository-connected Cloudflare build | `d09f9aa9-4cf3-4a63-b490-1966f071dd0b` |
   | Production deployment | `3caa4b53-bfbf-4d02-9869-d95563c101d4` |
   | Activation Worker version | `9b263bb3-5bbb-499f-9784-5600a2c4c4b7`, alone at 100% |
   | Verified Release-A-compatible rollback floor | `58df8c9f-b4d7-4f3e-b15c-32dfec579355` |
   | Attended quiet-window canary | +7 receipts, +1 room fact, +6 rollup events: +1 `room_created`, +1 `room_joined`, +1 `game_started`, +2 `turn_completed`, +1 `game_finished` |

   Before mutation, the release gate verified schema 6, zero pending migrations,
   a secure room-fact key, cleanup health, exact `durable-outbox` readiness, the
   root production resources and secret inventory, the rollback floor, and the
   activation version alone at 100%. The target-locked canary created one
   synthetic lifecycle and confirmed the exact bounded deltas again after a
   delay. This is quiet-window aggregate evidence, not per-event cryptographic
   attribution: a permanently missing canary event plus an unrelated identical
   event could theoretically substitute. No such overlap was observed, but the
   privacy-minimal aggregate schema intentionally cannot prove attribution.

The completed production canary must not be rerun for routine releases,
availability checks, or reassurance. Use `npm run smoke:production` and the
scheduled/manual `Production health` workflow for those read-only checks. A
future high-risk delivery-policy activation or restoration may reuse the
generic canary design only after a reviewed release freshly pins its expected
script artifact and independently verified rollback version. Reserve a quiet
window outside cleanup and UTC rollover, verify one candidate at 100% and all
readiness/resource gates, and then run exactly once with that newly reviewed
bookmark:

```sh
npm run smoke:production-outbox -- <FRESHLY_REVIEWED_ROLLBACK_VERSION_ID>
```

The placeholder is not accepted by the command. Update and review the
release-specific constants and their unit contract first; never reuse the
completed activation's pins by convenience. The argument is a code-version
rollback bookmark, not a D1 Time Travel bookmark. Keep the proof attended,
outside automation and schedules, and watch outbox retry, dead-letter, drop, D1,
and room-error events while it runs. Discard an overlapped or ambiguous run
rather than weakening the exact-delta assertions.

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

   The committed production and staging exact `outbox` modes atomically persist each
   milestone-producing room mutation with all canonical events or one bounded
   drop decision and the alarm. The internal receiver receipt-gates one staging
   or production D1 application; schema-6 cleanup removes expired receipts in the existing
   bounded cleanup lifecycle. Analytics Engine receives only one best-effort
   post-commit opportunity for a newly applied event in either environment.

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
- room-milestone analytics `delivery: "durable-outbox"` in healthy production
  and staging. Release B reports it
  only when its producer is compiled, the mode is exact `outbox`, the schema is
  exactly 6, and `ROOM_FACT_HASH_KEY` is secure. An
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
| `room_milestone_delivery_failed` | The conditional best-effort compatibility path failed | Do not interrupt play; inspect aggregate impact and unexpected delivery policy |
| `room_milestone_outbox_dropped` | An exact-mode event group was dropped for bounded capacity or canonicalization reasons while gameplay committed | Check only reason/count and queue health; do not dump room state or payloads |
| `room_milestone_outbox_retry_scheduled` | The bridge/consumer persisted another bounded attempt; this is the single post-commit failure record | Check D1/schema/key health; later FIFO events remain blocked behind the head |
| `room_milestone_outbox_retry_stale` | A retry compare-and-swap did not own the current FIFO head | Treat it as non-proof observability; investigate repeated occurrences without exposing the room or event ID |
| `room_milestone_outbox_dead_lettered` | A head reached a terminal conflict, validation failure, deadline, or attempt limit | Investigate the reason field without dumping private Durable Object storage |
| `product_analytics_rollup_failed` | A best-effort progress/consent D1 telemetry write failed | Do not treat analytics as a ledger |
| `analytics_engine_write_failed` | Analytics Engine delivery failed | D1 rollup may still exist |
| `model_usage_reconciliation_failed` | A completed model attempt was not reconciled | Keep providers disabled until cost counters are understood |

The scheduled GitHub workflow is the zero-secret, cheap-first baseline. It runs
twice per hour as one two-row matrix. The production row probes
`https://dontstoptalking.org`, the staging row probes the designated staging
Workers.dev origin, and both require `durable-outbox` room-milestone delivery.
`fail-fast: false` lets either row report even when
the other fails. Each row has a five-minute bound, checks the public pages, the
isolated dashboard document, security headers, canonical status response, and
the complete recursively discovered deployable `.js`/`.mjs` asset generation,
plus the protected-HTML negative probes for every case-insensitive `*.test.js`
and `*.test.mjs` path excluded by `.assetsignore`. It fails on exact source,
canonical UTF-8 or BOM, MIME, `nosniff`, body/count/path/aggregate bounds,
module syntax, packaging, core SPA semantic checks, or
healthy-but-wrong delivery-policy drift as well as normal readiness failures.
It has read-only repository permission, persists no checkout
credential, installs no dependency, possesses no secret, and makes no mutation.
The manual dispatch uses the same fixed matrix; it cannot accept an arbitrary
origin or relax the expected policy.

GitHub schedules are best-effort: runs can be delayed or dropped during load,
and public-repository schedules are automatically disabled after 60 days
without repository activity. The cron actor should periodically verify recent
runs and re-enable the workflow after a long inactive period. Actions
notifications are not an uptime SLA. For an attended launch or a service with
a response-time commitment, add an independent HTTPS monitor for each status
endpoint at five-minute intervals and alert only after two consecutive
failures. Alert on a non-200 response, `status != ok`, a non-empty degraded
list, or delivery that differs from that environment's policy. Keep model
providers offline during a D1 or budget-control incident. See GitHub's current
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

Staging and production have crossed the exact-mode boundary and can contain
version-1 local outbox rows, so Release A is the minimum safe code-compatibility
floor for both environments. The activation release independently verified
`58df8c9f-b4d7-4f3e-b15c-32dfec579355` as that production best-effort floor.
This is historical activation evidence, not the automatic rollback target for
a later code or asset release, permanent configuration, or a D1 Time Travel
bookmark. For an ordinary later regression, use the version-list procedure
above and prefer the most recent verified healthy exact-outbox version that is
compatible with the current schema and resources. If incident response truly
requires the older best-effort floor, reconfirm its exact ID and bindings before
an attended full-version rollback. A compatible rollback may intentionally restore
`best-effort`: existing rows continue to drain through the Release-A-compatible
consumer while new milestones use the legacy path. During that incident window,
the twice-hourly production monitor will fail its normal `durable-outbox` policy
check by design; use an attended read-only probe with explicit expected
`best-effort`, repair or fix forward, and restore exact mode only after D1 and
queue health are understood. The ownership response keeps ordinary
Release-A/Release-B propagation skew safe, but avoid an intentional
mixed-configuration rollback and never select a pre-Release-A Worker; it can
overwrite the shared alarm and strand rows. Do not delete the namespace, local
tables, pending rows, receipts, or dead letters as a rollback technique. The
staging rollback drill completed successfully on 2026-09-02; repeat the
read-only status and appropriate aggregate checks after any real rollback. If an
incident deliberately restores `best-effort`, returning to exact mode is a
high-risk delivery-policy restoration and must use the freshly reviewed,
re-pinned attended procedure above; ordinary exact-to-exact releases do not
repeat the mutating canary.

## Retention checks

The Worker cron runs daily at 03:17 UTC. Anonymous cloud-summary ownership uses
one roughly 30-day device lease; pseudonymous room facts expire after 90 days.
Cleanup is bounded and can continue a backlog on the next run. Raw audio,
recordings, and captured coaching transcript text are not present in D1 and
remain in the user's browser only when separately retained. A consented game
judge transcript is also absent from D1: it is never retained and exists only in
browser/Worker request memory for the immediate offline grade.

Schema v5 stores one non-sensitive cleanup heartbeat row. A successful cron
updates it only after all attempted batches succeed and records whether expired
rows remain after the 20-batch invocation budget. Public status exposes only
`ready`, `stale`, or `backlog`; it never returns deletion counts, timestamps,
identities, or content. The migration timestamp supplies the first-run grace
heartbeat. A heartbeat becomes stale after 36 hours, so a normal daily run has
12 hours of scheduling grace before the production row in the twice-hourly
health matrix fails.
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
