# Cloudflare deployment (Workers Free)

NonStopTalk has a native Cloudflare edition designed for the Workers Free plan. It does not run the Go server or use Cloudflare Containers.

The deployment consists of:

- Workers Static Assets serving the Play, Practice, and Progress SPA in `cloudflare/public`
- a TypeScript Worker handling `/api/*`
- one SQLite-backed Durable Object per six-character room code
- hibernatable WebSockets for live room updates
- a central D1 database for consented compact summaries, anonymous expiry, internal sync-profile mappings, room facts, and queryable best-effort daily analytics rollups
- Analytics Engine for best-effort coarse product events
- a modular, disabled-by-default theme-to-topics adapter with aggregate D1 usage budgeting

The multiplayer game uses the Worker and Durable Objects. Speech analysis, recordings, and captured transcript text remain in the browser. Compact-summary backup is a separate, off-by-default choice: when selected, the SPA sends only allowlisted measurements/advice to the versioned Worker API and D1. With backup off, coaching makes no coaching-data API request. No coaching data enters a room Durable Object or external model. Separately, a room host can consent to one topic-generation attempt; the normalized theme, capped at 200 characters, is the only host or room content sent to the provider. The request never includes coaching data, audio, transcript text, names, or a room token.

Cloudflare Web Analytics is an optional zone-level browser RUM/performance service, not the `PLATFORM_DB` D1 binding or the `PRODUCT_ANALYTICS` Analytics Engine binding. With automatic setup enabled on a proxied domain, Cloudflare injects an SRI-protected beacon from `https://static.cloudflareinsights.com/beacon.min.js`, and the beacon reports to the same-origin `/cdn-cgi/rum` endpoint. It therefore needs no manually embedded application snippet. NonStopTalk application code never supplies coaching audio, captured transcript text, or compact-summary payloads to Web Analytics. Cloudflare describes Web Analytics as free and says it does not collect or use visitors' personal data or track individuals across customers' sites; treat those as provider-policy claims subject to change, not an application-enforced privacy guarantee. See Cloudflare's [overview][web-analytics-about], [data-collection description][web-analytics-data], and [automatic-setup/SRI FAQ][web-analytics-faq].

The Durable Object binding is internal. Players use the normal public Worker URL:

```text
https://nonstoptalk.<account-subdomain>.workers.dev/
https://nonstoptalk.<account-subdomain>.workers.dev/practice
https://nonstoptalk.<account-subdomain>.workers.dev/progress
https://nonstoptalk.<account-subdomain>.workers.dev/room/ABC234
```

## Cost and free limits

Cloudflare makes SQLite-backed Durable Objects available on Workers Free. As checked August 31, 2026, its published Durable Object daily allocation includes 100,000 requests and 13,000 GB-seconds of duration, plus 5 million SQLite rows read and 100,000 rows written per day and 5 GB of stored data. The separate D1 Free allocation includes 5 million rows read and 100,000 rows written per day plus 5 GB of storage. Workers Free also has a 100,000-request daily Worker limit, Static Asset requests are free and unlimited, and Analytics Engine's published Free allocation includes 100,000 data points written and 10,000 queries per day. Cloudflare says Analytics Engine billing is not active yet; its published prices are advance guidance.

Workers Logs is also included: as checked September 1, 2026, [Cloudflare publishes][workers-logs] 200,000 log events per day with three-day retention on Workers Free, or 20 million events per month with seven-day retention on Workers Paid and $0.60 per additional million. Invocation logs and each custom log, error, or uncaught exception are events, so log-event volume can exceed request volume. The current pilot configuration keeps 100% head-sampled logs and 1% traces for production and staging while traffic is low. [Trace spans][workers-traces] are free during the current beta but begin sharing the Workers Logs event allowance and pricing on October 1, 2026. The production runbook defines the cheap-first monitoring and sampling step-down policy; recheck these terms before launch because they can change.

This small party game is designed to stay inside those allocations: inactive objects do not accrue duration, and the WebSocket Hibernation API lets an idle room sleep without disconnecting its players. The platform also avoids D1 writes for page views and presence ticks, uses one day-bucketed retention lease per anonymous browser, rejects new saves once 250 summaries exist, uses small daily aggregate rows, and treats both D1 rollups and Analytics Engine writes as best-effort. Schema v4 adds only one small profile row and one membership row per browser, plus bounded cleanup; it adds no Cloudflare product or fixed monthly charge. Workers Free does not silently begin paid overage billing. If a daily allocation is exhausted, affected operations may fail until the allocation resets.

Cloudflare's general [Workers limits][worker-limits] documentation describes Error 1027 after the Free-plan daily Worker request limit is exhausted, with fail-open or fail-closed behavior configurable for zone Routes. Its [Static Assets billing][assets-billing] documentation defines the more specific rule used here: requests matching `run_worker_first` receive `429 Too Many Requests` instead of falling back to asset serving. This project applies `run_worker_first` to `/api/*` plus the exact `/admin/analytics` document paths; API and operator-document requests therefore receive 429 at an exhausted Worker allowance while all other asset-only routes continue without invoking the Worker. The operator route needs the Worker so its response can disable edge transformation/beacon injection and impose the strict token-page policy. Zone Route fail modes are separate from this `workers.dev` behavior. Confirm the current [Durable Objects][do-pricing], [D1][d1-pricing], and [Analytics Engine][analytics-pricing] pricing plus [Worker routing options][worker-routing] before deployment because allowances can change.

The Worker also uses Cloudflare's built-in [Rate Limiting binding][rate-limit-binding] to allow at most ten room creations per source connection per minute in each Cloudflare location. A general limiter allows 60 requests per source connection per minute in each scoped platform, room-read, room-connect, or room-mutation bucket, falling back to the anonymous browser identity in local development. Topic generation first shares that 60-request platform bucket and then passes a dedicated `MODEL_RATE_LIMITER` capped at five requests per source connection per minute. Limiter keys are SHA-256 digests rather than raw addresses or browser tokens. These permissive, eventually consistent counters reduce trivial Free-plan quota abuse; they are not authentication, accounting boundaries, or a defense against a distributed attack.

The optional transcript-judging integrations belong to the local Go game edition. The supplied Cloudflare multiplayer game still uses classic scoring, but its host-only theme generator has its own narrow provider adapter. It is free and deterministic by default. Operators may use direct Z.AI GLM-4.7-Flash as the strict-free routine option, Workers AI GLM-5.3-Flash as the preferred cheap Workers Paid routine option, and independently make Gemma 4 31B available for explicit host escalation. Cloud coaching continues to use bundled cards, local lexical retrieval, deterministic templates, and optional strict on-device recognition; it never uses any topic provider. External coaching AI, Queues, and R2 remain future modules, not deployment requirements.

Provider cost snapshot, checked August 31, 2026: [Z.AI pricing][zai-pricing] lists direct GLM-4.7-Flash input, cached input, storage, and output as free, so the default/direct option avoids a fixed Workers Paid charge. [Workers AI pricing][workers-ai-pricing] lists `@cf/zai-org/glm-5.3-flash` at $0.15/M input, $0.03/M cached-input, and $0.50/M output tokens; [Workers pricing][workers-pricing] lists a $5 USD/account/month Workers Paid minimum. This build's plain `AI.run()` path requires Workers Paid. Cloudflare also supports prepaid AI Gateway credits for this model, but that path needs a gateway ID and Unified billing and is not implemented here. [Google's Gemini Developer API pricing][gemini-pricing] lists Gemma 4 input/output/cache as free, paid tier unavailable, and free-tier content as used to improve Google's products. That privacy tradeoff is why Gemma is operator-disabled by default, host-selected per attempt, and receives only the normalized theme. Prices, limits, model availability, and provider terms can change.

## Requirements

- A Cloudflare account using Workers Free
- Node.js 22 or newer and npm
- Wrangler authentication (`npx wrangler login`) or a suitable Cloudflare API token in CI
- A D1 database created from the supplied migrations for the platform slice
- A numeric Wrangler secret named `ANALYTICS_ADMIN_TOKEN` (24–1,024 digits; 64 cryptographically generated digits recommended) for the protected aggregate analytics endpoints and dashboard
- A Wrangler secret named `ROOM_FACT_HASH_KEY` (32–1,024 random UTF-8 bytes) so six-character room codes use keyed HMACs in D1 room facts
- A `ZAI_API_KEY` Wrangler secret only when `TOPIC_ROUTINE_PROVIDER=glm`
- The declared Workers AI `AI` binding plus Workers Paid billing only when `TOPIC_ROUTINE_PROVIDER=glm53`; no vendor API-key secret is needed for this option
- A `GEMINI_API_KEY` Wrangler secret only when `TOPIC_ESCALATION_PROVIDER=gemma31`

Docker, a Cloudflare Container, and the Workers Paid plan are not required for the default deployment. Workers AI GLM-5.3-Flash is the exception: this implementation needs Workers Paid billing.

Schema-v4 profile assignment needs no additional Worker secret. `IDENTITY_HASH_KEY` is reserved for a future bilateral numeric-code linking phase; do not set it or treat linking/accounts as available in this stage.

## Deploy from a terminal

From the repository root:

```sh
npm clean-install
npm run audit:dependencies
npm run typecheck:cloudflare
npm run test:cloudflare
npm run test:cloudflare-runtime
npm run test:coach
npm run test:cloud-progress
npm run check:cloudflare
npm run check:cloudflare-staging
npm run check:cloudflare-startup
npm run smoke:platform
npx wrangler login
npm run db:create
# copy the returned database UUID into wrangler.jsonc once per environment
npm run db:migrate:remote
npx wrangler secret put ANALYTICS_ADMIN_TOKEN
npx wrangler secret put ROOM_FACT_HASH_KEY
npm run deploy
```

The default topic configuration needs no model secret. Direct GLM-4.7 and Gemma escalation need their corresponding API key; Workers AI GLM-5.3 uses the declared `AI` binding and no vendor secret:

```sh
npx wrangler secret put ZAI_API_KEY       # routine GLM-4.7-Flash
npx wrangler secret put GEMINI_API_KEY    # optional Gemma 4 31B escalation
```

`TOPIC_ROUTINE_PROVIDER`, `TOPIC_ESCALATION_PROVIDER`, and `MODEL_DAILY_CALL_LIMIT` are non-secret deployment policy in `wrangler.jsonc`. Their production defaults are `offline`, `off`, and `100` respectively. Change and review them in source control rather than only in the dashboard, because Wrangler configuration is the deployment source of truth. The routine selector accepts `offline`, `glm`, or `glm53`; `wrangler.jsonc` already declares the `AI` binding used by `glm53` with binding model ID `@cf/zai-org/glm-5.3-flash`.

`npm run deploy` applies pending production D1 migrations, deploys in Wrangler strict mode, and probes `https://dontstoptalking.org`. The configured Worker name is `nonstoptalk`; its Workers.dev route remains available as a diagnostic fallback.

`npm run check:cloudflare` performs a strict Wrangler dry run. It validates the TypeScript bundle, assets, and declared bindings without changing a Cloudflare account. `db:create` is a one-time environment step; D1 migrations are append-only and run before code in both deployment scripts.

`wrangler.jsonc` assigns account-local production namespace IDs `6677867`–`6677869` and separate staging IDs `6677870`–`6677872` for room creation, general API work, and topic-model requests. If another Worker in the same account already uses any value, choose independent positive integers.

### Promote to isolated staging

The named `staging` environment uses a separate Worker, D1 database, Analytics Engine dataset, rate-limit namespaces, secrets, cron, and Workers.dev hostname. It has no custom-domain route. After setting its two required secrets once, deploy and exercise both read and write paths with:

```sh
npm run deploy:staging
```

The post-deploy probe writes one synthetic compact baseline summary, verifies its explicit relationship metadata, and deletes that browser-scoped staging history. It refuses to run against the production domain. Version preview URLs are disabled in both environments because they would share the selected environment's stateful bindings.

## Deploy with Workers Builds

For the repository-connected flow in the Cloudflare dashboard:

1. Create or connect a **Worker** project, not a Pages-only static project.
2. Use the repository root (`/`) as the root directory.
3. Use Node.js 22 or newer (Node.js 24 is also supported).
4. Use the repository CI workflow as the full verification gate; if Workers Builds also runs a build command, include typecheck, Worker/unit/runtime tests, coaching tests, and the strict dry run.
5. Provision the environment's D1 database once, commit/configure its UUID, apply remote migrations, and add `ANALYTICS_ADMIN_TOKEN` plus `ROOM_FACT_HASH_KEY` as dashboard secrets before the first platform deploy; do not create a database on every build. If topic providers are enabled, set the provider variables, add `ZAI_API_KEY` or `GEMINI_API_KEY` only for its matching selector, and ensure Workers Paid access for `glm53`.
6. Use `npm run deploy` as the deploy command.
7. Keep the Worker name aligned with `name` in `wrangler.jsonc` (`nonstoptalk` by default).

Workers Builds installs dependencies before running those commands. No build-output directory is needed because `wrangler.jsonc` explicitly points Static Assets at `cloudflare/public`.

## Develop the Cloudflare edition locally

```sh
npm clean-install
npm run db:migrate:local
cp .dev.vars.example .dev.vars
# replace the platform placeholders; replace model keys only for enabled providers
npm run dev
```

Wrangler starts the Worker, local Durable Object/D1 storage, Analytics Engine binding, and static assets. Its local state lives under `.wrangler`, which is ignored by Git.

Open `http://127.0.0.1:8787/practice` for coaching or `/progress` for local history and optional cloud summaries. A different port is a different IndexedDB origin and anonymous cookie scope. These pages do not create a Durable Object. Microphone processing, optional recordings, and captured transcripts stay in the browser; only explicitly backed-up compact summaries enter local/remote D1.

The original Go edition is still the richer local app and remains available independently:

```sh
go run ./cmd/web
```

It listens on `http://localhost:8080` and keeps its JSON snapshot behavior. Running the Worker does not replace or reconfigure it.

## Room durability and retention

Each online room owns one Durable Object selected by its room code. The object stores the complete classic-game state as a row in its private SQLite database, so hibernation, Worker deployments, and ordinary process restarts do not erase an active room.

A room is deleted after 30 days without a state change. The alarm closes any remaining sockets and clears the object's storage. Browser identity is an unguessable, HTTP-only cookie; clearing that cookie loses the corresponding seat/host identity.

The free online multiplayer game currently mirrors the core room, setup, topic, microphone/manual timer, classic scoring, score override, standings, history, host transfer, and host-claim flows. It also produces editable topic drafts through deterministic templates or the optional provider boundary described below. It does not yet include the Go game's AI judge, saved presets, text import/export, microphone picker, or sound cues.

## Optional theme-to-topics providers

The Worker exposes one modular generation surface during room setup. The room host enters a theme of at most 200 characters, chooses routine or escalated generation, and explicitly approves external processing for that single attempt. Provider enablement and host consent are both required; one does not substitute for the other.

| Setting | Default | Allowed values and effect |
| --- | --- | --- |
| `TOPIC_ROUTINE_PROVIDER` | `offline` | `offline` always uses deterministic templates; `glm` calls direct Z.AI model `glm-4.7-flash` at `https://api.z.ai/api/paas/v4/chat/completions` when the host consents and `ZAI_API_KEY` is present; `glm53` uses public model `glm-5.3-flash` through the `AI` binding's `@cf/zai-org/glm-5.3-flash` model when the host consents. |
| `TOPIC_ESCALATION_PROVIDER` | `off` | `off` disables escalation; `gemma31` permits Gemini Developer API model `gemma-4-31b-it` only after the host chooses the escalated tier, consents, and `GEMINI_API_KEY` is present. |
| `MODEL_DAILY_CALL_LIMIT` | `100` | Maximum aggregate external provider attempts per UTC day. |

The normalized theme is the only host or room content sent to the selected provider. Fixed instructions and model settings accompany it, but audio, captured transcript text, player or room names, room codes or member/authentication tokens, game history, coaching data, and NonStopTalk request IDs do not leave the Worker. D1 aggregates reservations/completions, successes/failures, provider/model, input/output/total/cached-input/reasoning token totals, and total latency to authorize and monitor the daily budget; it stores no themes or generated topics. A configured external request without consent is rejected before budget reservation or provider contact. A missing key or Workers AI binding, invalid selector, exhausted or unavailable D1 budget, timeout, non-success response, or invalid model output returns a bounded deterministic draft. Public status reports invalid or incomplete provider configuration as degraded, and escalation is never an automatic fallback from either routine model: the host must select it explicitly.

[Cloudflare's Workers AI data-use policy][workers-ai-data] says it does not use customer content to train models or improve services without explicit consent and stores content only if the customer separately uses a storage product (checked August 31, 2026). Treat that as provider policy subject to change, not as a NonStopTalk-controlled retention guarantee.

Status can verify only that the `AI` binding exposes a callable `run` method, not that the Cloudflare account has GLM-5.3 billing entitlement; a denied first request is reconciled as a failed attempt and falls back deterministically. Provider outputs are materialized and then rejected above 64 KiB; this is an output-validation bound, not a streaming wire cap. A timeout aborts local waiting, but an upstream that ignores cancellation may still finish and bill the request.

Each host action can make at most one external request. This slice has no automatic provider retry and no Queue. Those omissions keep cost and behavior predictable; deterministic generation remains usable whenever an external dependency is unavailable.

`GET /api/v1/admin/model-usage?days=30` uses the same `ANALYTICS_ADMIN_TOKEN` bearer guard as the aggregate product-analytics readout. It returns UTC windows, global totals, and daily global/provider rows with call, outcome, token, and latency aggregates. It never returns a theme, generated topic, provider response, room code, identity, or authentication token. A timeout or other failure without returned usage still counts the reservation/call, but its token totals remain zero and can undercount vendor-billed work.

The unlinked `/admin/analytics` document is the supported operator UI over both endpoints. It uses exactly two `days=90` requests and derives shorter windows locally, so opening it does not require another database, analytics vendor, library, or secret. The page accepts the numeric secret format documented below, clears the password control immediately, and never writes browser storage or history state. Its source validator fails closed on mismatched windows, duplicates, invalid counts, or totals that do not reconcile. A dedicated Worker response uses `public, max-age=0, must-revalidate, no-transform`; Cloudflare documents `public, no-transform` as preventing automatic Web Analytics injection. The CSP also excludes `static.cloudflareinsights.com` while public pages continue to permit the optional beacon.

The browser coaching prototype is a separate path, not game-feature parity. IndexedDB remains the local source and the only home for opted-in recordings/captured transcripts. A third, independent choice can back up the compact summary to D1 under an anonymous browser identity. Cloud access refreshes one device-level UTC-day-bucketed lease for all of that browser's summaries; it lasts at least 30 and less than 31 days. Summary records are not rewritten merely to renew that lease, and new saves are rejected once 250 summaries exist. This is not an account or cross-device sync mechanism; clearing the identity cookie can make a backup unreachable before cleanup.

## Custom domain

Production declares the apex Custom Domain directly in `wrangler.jsonc`, so a Git deployment preserves it as code-reviewed configuration:

```json
"routes": [
  {
    "pattern": "dontstoptalking.org",
    "custom_domain": true
  }
]
```

The player URL is therefore `https://dontstoptalking.org/room/ABC234`. A whole alternate domain or subdomain also works because the app uses root-relative `/api`, `/room`, and asset paths. Hosting below a prefix such as `example.com/nonstoptalk/*` requires application path changes and is not currently supported.

## Why the original deployment failed

The earlier repository had neither a Wrangler entry point nor a declared static asset directory. A config-free `npx wrangler deploy` therefore failed with:

```text
Could not detect a directory containing static files
```

`wrangler.jsonc` now supplies the Worker entry point, Static Assets SPA fallback, Durable Object binding/migration, central D1 binding, Analytics Engine dataset, Workers AI binding, and rate-limit bindings. It is a Worker-with-Assets deployment rather than a Pages-only site. `/practice` and `/progress` are handled by the static SPA fallback, so no separate output directory or Pages project is required.

## Durable Object migrations

The `v1` migration creates `RoomDurableObject` with the SQLite backend required by Workers Free. Do not edit or reuse an already-deployed migration tag. Future class renames or storage-class changes must add a new migration entry.

## D1 migrations and platform secrets

Files in `cloudflare/migrations` are append-only. Apply them locally with `npm run db:migrate:local` and remotely with `npm run db:migrate:remote`. Migration `0003_model_usage.sql` advances the platform schema to version 3 and adds the aggregate-only `model_usage_daily` reservation/reconciliation table. Migration `0004_sync_profiles.sql` then expands D1 with `sync_profiles` and `sync_profile_devices`, backfills one opaque profile per existing device, and leaves `coaching_sessions` and every device-owned query unchanged. Apply v4 before deploying Worker code that writes the new tables. Rollback remains safe because the previously deployed Worker accepts schema 4 and ignores these additive tables; do not contract the device-owned schema until later compatibility releases and retention/deletion validation are complete.

Production also needs the created D1 UUID in `wrangler.jsonc`; set the protected bearer value with `npx wrangler secret put ANALYTICS_ADMIN_TOKEN` and a separate random room-fact key with `npx wrangler secret put ROOM_FACT_HASH_KEY`, never in source control. Numeric-only secrets work: generate each independently with a password manager's cryptographic numeric generator or, on Linux, `LC_ALL=C tr -dc '0-9' </dev/urandom | head -c 64`, then paste the 64 digits into Wrangler's hidden prompt. Optional Z.AI and Gemini keys are likewise Wrangler secrets and are required only for their enabled topic tier. Without the room key, coarse room-event totals continue best-effort but linkable D1 room facts are deliberately skipped. `GET` or `HEAD` on `/api/v1/platform/status` checks D1 and reports non-secret configured or degraded capabilities, including admin analytics, keyed room facts, and routine/escalated topic-provider readiness.

The `17 3 * * *` cron invokes retention cleanup daily at 03:17 UTC. One device-level UTC-day-bucketed lease keeps anonymous detail active for at least 30 and less than 31 days after cloud use; summary rows do not need per-read lease rewrites. The v2 migration preserves every valid v1 summary whose own expiry and device lease are still active, even when an identity has more than 250 rows, and excludes already-expired v1 detail. The 250 threshold blocks only new saves; it does not force-delete preserved history. In schema v4, deleting an expired device cascades its `sync_profile_devices` membership, then the same bounded cleanup removes a now-orphaned profile after its mirrored expiry is due. HMAC-pseudonymous room facts expire after 90 days. Cleanup deletes bounded batches, continues through a capped number of batches in one invocation, and leaves any remaining backlog for the next cron. Aggregate daily analytics rows are retained, but their event delivery is best-effort rather than a durable ledger. Separate aggregate daily model-usage rows enforce the topic-provider budget and retain only provider/model/task dimensions, call outcomes, model token aggregates, latency, and timestamps—not theme or generated-topic text, room/member/authentication tokens, identities, audio, or transcripts.

D1 is authoritative for successfully stored consented summaries, consent records, anonymous ownership, and room facts described in the [web platform plan](WEB_PLATFORM_PLAN.md). Its analytics increments are fail-open and best-effort, as are Analytics Engine writes; neither is audit or billing truth. Room-triggered analytics run in the Durable Object's `waitUntil`, so live room actions and local coaching continue if analytics delivery fails. Live room state remains authoritative in Durable Objects.

[do-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[d1-pricing]: https://developers.cloudflare.com/d1/platform/pricing/
[analytics-pricing]: https://developers.cloudflare.com/analytics/analytics-engine/pricing/
[workers-ai-pricing]: https://developers.cloudflare.com/workers-ai/platform/pricing/
[workers-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[workers-ai-data]: https://developers.cloudflare.com/workers-ai/platform/data-usage/
[zai-pricing]: https://docs.z.ai/guides/overview/pricing
[gemini-pricing]: https://ai.google.dev/gemini-api/docs/pricing#gemma-4
[worker-limits]: https://developers.cloudflare.com/workers/platform/limits/
[assets-billing]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
[worker-routing]: https://developers.cloudflare.com/workers/configuration/routing/
[rate-limit-binding]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
[workers-logs]: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
[workers-traces]: https://developers.cloudflare.com/workers/observability/traces/
[web-analytics-about]: https://developers.cloudflare.com/web-analytics/about/
[web-analytics-data]: https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/
[web-analytics-faq]: https://developers.cloudflare.com/web-analytics/faq/
