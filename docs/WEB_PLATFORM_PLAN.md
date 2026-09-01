# Web platform plan

This is the implementation plan for making the Cloudflare edition the canonical hosted NonStopTalk product. It is intentionally incremental: the existing game remains playable while the central database, APIs, analytics, and eventual accounts are added behind replaceable modules.

## Outcome

The target is one HTTPS web product with:

- live multiplayer rooms that survive deploys and hibernation;
- a central, queryable product database;
- explicitly consented cloud backup for compact coaching summaries;
- privacy-safe product and operational analytics;
- versioned APIs that can later support mobile or educator clients;
- optional external providers behind narrow adapters, beginning with consented theme-to-topics generation and never embedded throughout the application;
- documented migrations, retention, observability, and recovery.

The current application already supplies the first item. Workers Static Assets serves the SPA, a Worker owns the API edge, and one SQLite-backed Durable Object coordinates each room. The work is therefore a platform extension, not a rewrite.

## Design constraints

1. **Free or cheap by default.** Static Assets, Workers, Durable Objects, D1, Workers observability, and Analytics Engine are the preferred primitives. Topic generation remains deterministic unless an operator enables a model API; a Queue, R2 bucket, email service, or broader model feature is added only when it earns its ongoing cost.
2. **Modular boundaries.** Realtime room coordination, relational data, product analytics, identity, coaching storage, and model providers are separate modules with small interfaces.
3. **Local-first coaching.** Audio frames, recordings, and captured transcript text stay in the browser. Only an allowlisted compact summary can be uploaded, and only after the user selects cloud backup.
4. **Graceful degradation.** The game and local coaching history remain usable when D1, Analytics Engine, or a provider is unavailable. Topic generation returns deterministic drafts when external work cannot safely run.
5. **Measure outcomes, not people.** Initial analytics contain aggregate event counts and coarse product dimensions. They do not store IP addresses, names, room-member tokens, audio, or transcript text.

## Target architecture

```text
Browser SPA
  |-- local audio analysis + IndexedDB artifacts
  |-- host theme (<= 200 characters) + one-request provider consent
  |-- versioned HTTPS API
          |
          +-- Room Durable Object (authoritative live room state + WebSockets;
          |                         gated atomic v1-outbox producer/consumer)
          +-- D1 platform store (summaries, consent, internal profile mappings,
          |                      room facts, daily rollups, model-usage budget,
          |                      internal milestone receiver + receipt cleanup)
          +-- Analytics Engine (best-effort time-series events)
          +-- Workers Logs/Traces (runtime health)
          +-- topic-provider adapter
          |     +-- deterministic templates (default/fallback)
          |     +-- direct Z.AI GLM-4.7-Flash (optional routine tier)
          |     +-- Workers AI GLM-5.3-Flash (optional routine tier)
          |     +-- Gemma 4 31B (optional explicit escalation tier)
          +-- future Queue (only for work that later needs durable retry)
```

Durable Objects and D1 have different jobs. A room object serializes concurrent game actions and broadcasts state. D1 stores records that must be queried across rooms or returned through a user-facing data API. Analytics Engine is telemetry, not the source of truth.

## Platform slice being built

The first slice uses these modules:

- `cloudflare/platform.ts`: validation, hashed anonymous identity, internal sync-profile membership, D1 repositories, consent records, retention, room facts, and aggregate analytics.
- `cloudflare/public/cloud-progress.js`: a browser-side allowlist and the optional summary-backup API client.
- `cloudflare/model-provider.ts`: bounded deterministic, direct GLM-4.7-Flash, Workers AI GLM-5.3-Flash, and Gemma 4 31B topic adapters.
- `cloudflare/model-routes.ts`: host/setup authorization, per-request consent, D1 budget reservation/reconciliation, response metadata, and deterministic remote-failure fallback.
- `cloudflare/migrations/`: append-only D1 migrations.
- `cloudflare/worker.ts`: platform and provider composition/routing; existing room behavior remains in the Durable Object and game rules.

The topic-provider boundary is independently configurable. `TOPIC_ROUTINE_PROVIDER=offline` and `TOPIC_ESCALATION_PROVIDER=off` are the disabled-by-default settings. An operator may set routine to `glm` for direct Z.AI model `glm-4.7-flash` with a `ZAI_API_KEY` Wrangler secret, or to `glm53` for public model `glm-5.3-flash` through the declared Workers AI binding ID `@cf/zai-org/glm-5.3-flash`. The latter needs Workers Paid in this build but no vendor API key. The operator may separately set escalation to `gemma31` for Gemini Developer API model `gemma-4-31b-it` with a `GEMINI_API_KEY` secret. Configuration only makes a tier available: the host still chooses the tier and grants explicit external-processing consent for each generation attempt. Gemma is never an automatic fallback from either routine provider.

### Versioned API

```text
GET/HEAD /api/v1/platform/status
GET     /api/v1/progress/sessions
POST    /api/v1/progress/sessions
DELETE  /api/v1/progress/sessions
GET     /api/v1/progress/export
GET     /api/v1/admin/analytics?days=30
GET     /api/v1/admin/model-usage?days=30
POST    /api/v1/models/topics
```

Every new API response includes a request ID and a no-store policy. Mutations require same-origin requests. Both admin endpoints require the same `ANALYTICS_ADMIN_TOKEN` bearer secret. Progress ownership remains the SHA-256 digest of the existing high-entropy browser token; the raw token is not stored in D1. Schema v4 also assigns an opaque internal sync profile, but its ID is never returned or accepted for access. The public status route verifies D1 readiness and returns top-level `status` (`ok` or `degraded`), `apiVersion`, `schemaVersion`, and `degradedCapabilities`. Its non-secret `capabilities` object reports cloud-progress status, retention, and `newSaveLimit`; retention-cleanup health; keyed-room-fact status; aggregate-analytics delivery/admin-read/Analytics-Engine configuration; and only non-secret topic-provider availability/degradation. Every non-exact mode reports `best-effort`. The Release-B producer reports `durable-outbox` only with exact `outbox`, schema 6, and a secure room-fact HMAC key; an unready exact configuration reports `degraded-outbox` and degrades `aggregateAnalyticsDelivery` rather than overstating delivery.

`POST /api/v1/models/topics` is host-only and setup-only. It accepts a room code for authorization, a routine/escalated tier, an explicit consent boolean, and a trimmed theme capped at 200 characters. The normalized theme is the only host or room content forwarded to a model. Fixed instructions and model settings accompany it, but room authorization fields and NonStopTalk request IDs never leave the Worker. The response is a bounded editable topic draft plus provider/fallback metadata; applying that draft remains an ordinary room action. There is at most one external call, no retry, and no automatic escalation. A configured external request without consent is rejected before budget reservation or provider contact. Missing credentials/bindings, invalid provider selectors, unavailable/exhausted D1 budget, provider errors, timeouts, or invalid output return the deterministic draft. Public status reports invalid or incomplete provider configuration as degraded; authorization and input failures remain explicit errors. Status checks binding shape, not Workers Paid entitlement, so a denied first GLM-5.3 request can still fail closed. Provider output is materialized before the 64 KiB validation bound; a timeout stops local waiting, but an upstream that ignores abort may still complete and bill.

Anonymous cloud progress is deliberately transitional. Its access cookie is not an account or recovery credential. Cloud use refreshes one device-level lease, bucketed to a UTC day and lasting at least 30 days (and less than 31 days), for all of that browser's summaries. Ordinary reads do not rewrite each summary merely to renew retention. The daily cleanup deletes bounded batches of expired detail, continues within a capped run budget, and leaves any remaining backlog for the next cron. Clearing the browser cookie can make a backup unreachable before cleanup. A real account will eventually adopt these records into a durable user identity.

Schema v5 makes that cron observable with one initialized `platform_maintenance` singleton. A successful invocation advances its scheduled/completed heartbeat only after every attempted batch succeeds and stores one backlog bit; an older delayed event cannot regress a newer heartbeat. Status returns only `ready`, `stale`, or `backlog`, never its timestamps or deletion counts. The migration supplies the initial grace heartbeat, and status becomes degraded when the daily schedule is more than 36 hours old or an exact final probe finds eligible rows still remaining after the 20-batch run budget. This adds one tiny D1 write per successful day and, only at that full-budget boundary, one small existence read; it needs no service, secret, model call, or user record.

Schema v6 is an additive receipt foundation. `room_milestone_receipts` starts empty and permits only opaque lowercase 256-bit event IDs/payload hashes plus canonical UTC receipt, optional application, and exact 90-day expiry timestamps. The Worker includes a strict internal schema-6 receiver that can receipt-gate one canonical D1 application, plus bounded schema-6 expiry cleanup. Marker-5 cleanup never prepares receipt-table SQL. Release A can lazily recognize and drain a version-1 local Durable Object outbox. Release B adds the matching producer: only exact `outbox` mode atomically commits room state, stable lifecycle metadata, the complete ordered event group, and the multiplexed alarm before responding or broadcasting. Expected capacity/canonicalization drops commit gameplay and bounded counters without a legacy fallback; storage or alarm failures roll the whole mutation back. Production remains `best-effort`, so normal production traffic creates no local outbox or receipt. Staging intentionally uses exact `outbox` and is currently healthy with `durable-outbox`; its rollback/drain/restoration proof remains pending before any production cutover. Release A is the minimum safe rollback floor after any rows have been produced.

Schema v4 is Stage 1 of that identity transition and is deliberately behavior-preserving. `sync_profiles` stores an opaque internal profile and lifecycle metadata; `sync_profile_devices` maps one current device digest to one profile. Existing devices are backfilled one-to-one, and new browsers still receive separate profiles. `coaching_sessions`, consent receipts, authorization, the API response shape, and every visible backup/list/export/delete flow remain device-owned and unchanged. Device deletion cascades the membership, and bounded retention cleanup removes an expired orphan profile. This introduces no visible profile, account, linking, recovery, cross-device access, data upload, or new consent behavior.

The rollout follows expand/contract sequencing: add and backfill the mapping first, validate it while device SQL remains authoritative, then add compatibility behavior in a later release before contracting any device-owned session path. The first proposed linking feature is a bilateral, short-lived numeric-code exchange. It must HMAC code material with a separate `IDENTITY_HASH_KEY`, require explicit confirmation and consent on both browsers, leave existing cloud-summary consent unchanged, and fail without moving or exposing data when either side does not confirm. That flow, profile-scoped session ownership, authentication, and account recovery are future work.

New saves are rejected when an anonymous browser identity already owns 250 cloud summaries. This is a new-save guard, not a retroactive retention cap: the v2 migration preserves every valid, unexpired v1 summary even when an identity has more than 250, while excluding v1 rows whose summary or device lease had already expired. An identity above the guard can still list, export, and delete its records; it must fall below 250 before creating another summary.

### D1 records

| Record | Purpose | Sensitive data excluded |
| --- | --- | --- |
| `devices` | Anonymous owner key and expiry | Cookie token, IP, user agent |
| `sync_profiles` | Opaque internal profile lifecycle/generation; one profile per browser in Stage 1 | Credentials, content, names, IP, user agent |
| `sync_profile_devices` | Internal device-to-profile membership and lifecycle | Raw cookie token, content, consent |
| `platform_maintenance` | Singleton scheduled-cleanup heartbeat and backlog bit | User/content identifiers, deletion counts, secrets |
| `coaching_sessions` | Allowlisted compact measurement/advice summary | Audio, samples, recording, captured transcript |
| `consent_records` | Versioned proof of the summary-backup choice | Form text, media |
| `room_facts` | Room lifecycle counts keyed by an operator-secret HMAC of the short room code | Raw room code, player names and member tokens |
| `room_milestone_receipts` | Idempotency receipts for the internal schema-6 receiver; production best-effort rooms create none, while staging exact outbox delivery populates them and bounded cleanup expires them | Room codes, names, topics, member/authentication tokens, IP data, audio, transcripts, coaching content |
| `analytics_daily` | Queryable daily event rollups; staging exact room-milestone increments are receipt-gated and other increments remain best-effort | Per-person identifiers |
| `model_usage_daily` | Aggregate UTC-day provider attempts, model-token totals, and latency used to enforce and monitor the external-call ceiling | Theme and generated-topic text, room/player identity, room/member/authentication tokens, audio, transcripts |

Analytics Engine receives the same coarse event vocabulary for inexpensive time-series exploration. D1 rollups provide a small protected readout for the admin API. Production room milestones and progress/consent events in both environments remain best-effort through `waitUntil`. Staging exact outbox uses the internal receiver to receipt-gate each eligible room-milestone D1 batch and make replay idempotent. It then offers Analytics Engine one best-effort post-commit opportunity only for a newly applied event; that opportunity is not retried after a failure or interruption. Analytics Engine is therefore never delivery-exact, and neither analytics surface is an audit or billing ledger.

The implemented operator surface at `/admin/analytics` uses the same bearer guard and no new service. It concurrently requests one 90-day product extract and one 90-day model-usage extract, validates their matching UTC windows and row invariants, reconciles API totals against daily/global/provider rows, then derives 1/7/30/90-day views locally. Event ratios are labeled as non-cohort operating signals, zero denominators stay unavailable, and the current UTC day is disclosed as partial. The token-bearing page is a separate document with no public navigation link, no storage, a self-only script/connect policy, and a `no-transform` response that prevents automatic Cloudflare Web Analytics injection.

Model usage is a separate cost-control path rather than product telemetry. Its D1 reservation/check must succeed before an external request; if it cannot, generation falls back to deterministic topics. `MODEL_DAILY_CALL_LIMIT` defaults to 100 aggregate external attempts per UTC day. The usage state aggregates reservations/completions, successes/failures, provider/model/task, input/output/total/cached-input/reasoning token totals, total latency, and timestamps—not the host theme, generated topics, identities, or room/member/authentication tokens. `GET /api/v1/admin/model-usage?days=30` exposes global totals plus daily global/provider rows for those operational aggregates, without prompts, responses, room data, or identity. A failed/timed-out call without returned usage is counted but contributes zero token totals, so this operational view can undercount vendor-billed inference.

## Analytics contract

The initial funnel is intentionally small:

| Event | Question answered |
| --- | --- |
| `room_created` | Are people starting multiplayer sessions? |
| `room_joined` | Do invites produce participation? |
| `game_started` | Do configured rooms reach play? |
| `turn_completed` | Is the core loop functioning? |
| `game_finished` | Do games reach a result? |
| `coaching_summary_saved` | Do users explicitly value cloud progress? |
| `coaching_summary_deleted` | Are privacy/data controls functioning? An event is attempted after a successful delete operation; value is summaries removed. |
| `cloud_consent_granted` | Is online backup being explicitly adopted? Attempted only on an absent/revoked/older-policy-to-granted transition. |
| `cloud_consent_revoked` | Are consent controls functioning? Attempted only on a granted-to-revoked transition. |

Server-authoritative room events are preferred over browser events. A coaching-save event is attempted only when D1 creates a new allowlisted summary; consent and deletion events are likewise attempted only after their documented state transition succeeds. Measurements such as speaking ratio are user progress data, not product telemetry, and are not copied into either analytics sink.

## Delivery phases

### Phase 1 — central platform foundation

- Add D1 migrations and local migration commands.
- Add strict summary validation at both browser and Worker boundaries.
- Add opt-in cloud summary create/list/delete/export.
- Add a single device-level, day-bucketed anonymous-data lease, a 250-existing-summary new-save guard, bounded scheduled cleanup with backlog continuation, and a one-row cleanup heartbeat.
- Add server-authoritative room lifecycle events, room facts, and daily counters; production room and all progress/consent increments remain best-effort, while staging exact room milestones are now receipt-gated.
- Add a protected analytics summary endpoint and a public status response that distinguishes configured from degraded capabilities without exposing secrets.
- Add request IDs, tests, deployment steps, and privacy copy.

Exit: the complete slice runs against local Wrangler/D1, existing game and coaching tests stay green, and a default/offline production deploy needs only Cloudflare authentication, a D1 UUID, migrations, an admin secret, and a separate room-fact HMAC secret. Optional topic tiers additionally require their non-secret provider selectors and matching Z.AI/Gemini Wrangler secret.

### Phase 2 — durable identity and cross-device progress

- Validate the schema-v4 one-device/one-profile foundation before any ownership migration; keep current device queries available through the rollback window.
- Add bilateral, expiring numeric-code linking only with a separate `IDENTITY_HASH_KEY` and explicit confirmation/consent on both devices. Linking must not silently grant cloud-summary consent.
- Select an authentication approach after domain/email requirements are known. Prefer passkeys or email magic links; avoid building password storage.
- Add users, auth identities, revocable sessions, account deletion, and anonymous-to-account adoption.
- Add paginated sync, offline retry/outbox behavior, and conflict rules.
- Preserve the implemented explicit baseline/retry relationship fields and goal-specific comparison semantics across account adoption; never replace them with averages across unrelated attempts.

Exit: a user can sign in on a second device, see consented summaries, export them, and delete the account/data.

### Phase 3 — normalized game history and product operations

- Persist finished-game and turn facts to D1 without moving live authority out of Durable Objects.
- **Implemented behind a mode gate:** the constrained schema-v6 receipt table, strict receiver, bounded cleanup, Release-A-compatible FIFO consumer, and Release-B atomic normal-room producer with stable replay IDs, all-or-drop event groups, bounded retries, and privacy-minimal dead letters.
- **In progress:** staging is intentionally active and currently healthy in exact `outbox`; complete its pending rollback/drain/candidate-restoration proof and repeat the exact smoke before a separate production cutover. Production remains `best-effort`.
- **Implemented:** add a small, protected, source-reconciled admin dashboard without a new dependency or service.
- **Implemented:** add isolated staging/production environments, migration checks, cleanup heartbeat/room alarms, deployment smoke probes, and incident runbooks.

Exit: deployments are repeatable, game outcomes are queryable across rooms, and support can diagnose failures without reading private room content.

### Phase 4 — optional external analysis (partially implemented)

- **Implemented first sub-slice:** a replaceable theme-to-topics provider interface with deterministic default/fallback behavior.
- **Implemented first sub-slice:** direct GLM-4.7-Flash as the strict-free routine option, Workers AI GLM-5.3-Flash as the preferred cheap Workers Paid routine option, and Gemma 4 31B as an independently configured, explicitly host-selected escalation tier.
- **Implemented first sub-slice:** plain-language consent for each external attempt; the normalized theme (maximum 200 characters) is the only host or room content sent to a provider, never audio, transcript text, names, room codes/member/authentication tokens, game history, or coaching summaries.
- **Implemented first sub-slice:** aggregate D1 daily call budgeting with a default ceiling of 100, provider/output validation, and one external attempt at most. There is no retry or Queue yet.
- **Still future:** transcription, semantic coaching, external coaching RAG, or any audio/transcript provider path. Each requires its own consent, retention, evaluation, and cost design.
- Add a Queue only when a later provider job genuinely requires durable asynchronous retry; topic drafts use immediate deterministic fallback instead.

Partial exit reached: topic providers can be enabled, disabled, or replaced without changing game rules, storage repositories, or the deterministic generator. Phase 4 remains open until any broader external-analysis feature is separately designed and validated.

## Cost controls

- Do not write D1 on socket presence ticks or page views. Persist summaries and consent changes, coarse room-milestone/analytics aggregates, and aggregate provider-budget counters. Production best-effort traffic creates neither a local outbox nor receipts; staging exact outbox writes one bounded local event per milestone and one expiring D1 receipt per delivered event, without adding Queues or another database.
- Keep one day-bucketed inactivity lease per anonymous device, reject new saves once 250 summaries exist without forcibly deleting valid legacy rows, bound each cleanup run so unusual backlogs cannot monopolize Worker execution, and spend only one small heartbeat write after a successful daily cleanup.
- Keep the Stage-1 identity expansion to two small metadata rows per browser and the existing bounded cleanup; it requires no additional Cloudflare product, model call, email sender, or paid plan.
- Use Analytics Engine for high-volume exploratory telemetry because writes are non-blocking and sampled at scale; never depend on it for billing or user-visible state.
- Keep raw coaching artifacts in IndexedDB. Add R2 only if users explicitly request cloud media storage and a storage/egress budget is approved.
- Add Queue only for work that genuinely needs retry/delivery semantics. The current topic route makes no retry and falls back deterministically.
- Keep both topic tiers off by default, require per-attempt host consent, make escalation explicit, pass the general 60-requests-per-minute scoped API limiter plus the dedicated five-requests-per-minute `MODEL_RATE_LIMITER`, and enforce `MODEL_DAILY_CALL_LIMIT` (100 by default) in D1 before an external call.
- Cost snapshot checked August 31, 2026: [Z.AI lists direct GLM-4.7-Flash input, cached input, storage, and output as free](https://docs.z.ai/guides/overview/pricing), avoiding a fixed Workers Paid charge. [Cloudflare lists GLM-5.3-Flash](https://developers.cloudflare.com/workers-ai/platform/pricing/) at $0.15/M input, $0.03/M cached-input, and $0.50/M output, while [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) lists a $5 USD/account/month Paid minimum; this adapter's plain binding path requires that plan. [Google lists Gemma 4](https://ai.google.dev/gemini-api/docs/pricing#gemma-4) as free-only and says free-tier content is used to improve its products, so Gemma remains explicit escalation and receives only the theme. Terms and quotas can change.
- At the same check date, [D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) included 5M rows read/day, 100K rows written/day, and 5 GB, while [Analytics Engine Free](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) published 100K writes/day and 10K reads/day and said billing was not yet active. Recheck before launch.
- Add per-user/account provider budgets only after durable accounts exist; the current slice has an aggregate UTC-day ceiling.
- Review current Cloudflare quotas before launch; the free allowances and product pricing can change.

## Decisions intentionally deferred

The following require product or operational input and are not safe to guess:

- production custom domain and Cloudflare account;
- auth method, email sender/domain, and account recovery policy;
- data residency and retention beyond the anonymous 30-day bootstrap;
- whether any audio or transcript may ever be uploaded;
- external coaching model/provider and any monthly spend ceiling beyond the current aggregate topic-call guard;
- who may access the analytics admin endpoint.

None of these blocks the local platform slice or the existing web product.
