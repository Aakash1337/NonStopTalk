# NonStopTalk

NonStopTalk is a work-in-progress speaking-practice product and multiplayer party game. The native Cloudflare app now includes a private speech-coaching prototype for individual rehearsal, while the original game still supports pass-and-play and online rooms for players on separate devices.

The playable game and a demonstrable coaching prototype exist today. The project is still being validated and hardened; the [roadmap](docs/ROADMAP.md) separates implemented work, prototype claims, and future ideas.

An incremental [web platform foundation](docs/WEB_PLATFORM_PLAN.md) is now in progress. It keeps the existing local-first product intact while adding a central D1 database, opt-in compact-summary backup, and privacy-safe aggregate analytics through small replaceable modules. The design prefers Cloudflare's free allowances and adds paid services only when a validated feature needs them.

## Implemented now

- A Cloudflare-SPA coaching prototype at `/practice`: 30–90 second interview, presentation, or impromptu attempts; microphone calibration; browser-side audio measurements; an explicit review-only baseline → review → unassisted-retry loop by default; an alternative single coached attempt with sparse deterministic live tips; and evidence-based review
- A small local RAG layer: goal/evidence queries lexically retrieve curated in-app coaching cards; normally the top card supplies an intact base drill, but an evidence-safety rule can use the measured priority's drill instead when the card is unsupported. The review distinguishes used guidance from context-only retrieval, with no LLM, free-form model prose, embeddings, vector database, or network call
- Optional pace and word-pattern estimates only when the user consents and the browser supports strict on-device speech recognition; the summary retains derived filler/repetition patterns, while captured transcript text is discarded by default
- Origin-local coaching summaries, explicit loop grouping, goal-specific baseline/retry comparisons, JSON export, and deletion at `/progress` through IndexedDB in the current browser profile. Legacy and single coached attempts remain independent; unrelated records are never paired by recency
- A separate, off-by-default retention choice that can keep the attempt recording and any locally captured transcript in the same origin-local IndexedDB database; recognition gets up to two seconds to flush at finish, and a timeout or error after text was captured preserves it but marks it as possibly partial in Review and Progress. JSON export excludes these artifacts. Each attempt's artifacts can be deleted while its compact summary and comparison remain, and full history deletion clears both stores
- Six-character rooms with a host, remote seats, browser-based reconnect, live updates (SSE in the local Go app and hibernatable WebSockets online), host transfer, and takeover after a short absence grace period
- Local pass-and-play and remote turns in the same room
- Player add, rename, remove, and reorder controls
- Configurable 10–300 second turns, 1–10 second silence limits, and 1–10 rounds
- Five built-in topic packs plus custom lists; the local Go edition also has import/export, offline or provider-assisted theme generation, and device-local saved presets. The Cloudflare edition can turn a host theme into an editable draft through deterministic templates by default, direct Z.AI GLM-4.7-Flash as the strict-free routine option, Workers AI GLM-5.3-Flash as the preferred low-cost paid routine option, or Gemma 4 31B for an explicitly selected escalation.
- A shuffled topic deck that uses every available topic before repeating; with more than one topic, a new cycle does not immediately repeat the previous draw
- Local voice-activity and silence detection plus a manual timer fallback; the Go edition also has microphone selection and sound cues
- Classic scoring, score explanations, host adjustments, standings, winner view, and the last 20 finished games in each room; optional AI relevance bonuses are available in the local Go edition
- Periodic JSON room snapshots locally and SQLite-backed Durable Object room persistence online

## Web platform foundation — in progress

The first platform slice adds versioned Worker APIs, a central D1 store, consent records, anonymous-cloud-progress cleanup, and privacy-safe aggregate analytics. Cloud progress is off by default. When selected for an attempt, it sends only an allowlisted compact measurement/advice summary—including consented derived word-pattern fields—to D1. Access is tied to the existing high-entropy HTTP-only browser token; D1 stores its SHA-256 digest, never the raw token. One UTC-day-bucketed device lease controls inactivity retention for that browser's summaries, lasts at least 30 and less than 31 days after cloud use, and avoids rewriting every summary merely to renew access. New saves stop when that identity already has 250 summaries; valid unexpired legacy rows are preserved rather than forcibly deleted. Scheduled cleanup uses bounded batches so a backlog can continue on the next run. Schema v5 adds one monotonic cleanup heartbeat row; public status reports only `ready`, `stale`, or `backlog`, so the twice-hourly read-only monitor detects a missed cron without exposing timestamps, counts, or user data.

Schema v4 adds an internal identity foundation without changing that behavior. D1 creates one opaque `sync_profiles` row and one `sync_profile_devices` membership per anonymous browser for now; the profile ID is never exposed or accepted as a credential, and summary SQL remains owned and queried by the device digest. The mapping follows the existing device lease and cleanup, adds no account, visible linking, recovery, cross-device access, or new consent choice, and requires no new service or secret. A future bilateral numeric-code linking flow must use a separate `IDENTITY_HASH_KEY` and explicit consent on both browsers before it can join profiles.

Schema v6 adds a privacy-minimal milestone-receipt table, a strict internal canonical receiver, and bounded receipt expiry cleanup. The Release-B Worker also contains a normal-room producer behind the exact `ROOM_MILESTONE_DELIVERY_MODE=outbox` opt-in. For a real milestone it commits the room JSON, stable lifecycle metadata, the complete ordered event group, and the shared alarm in one Durable Object transaction; capacity or canonicalization drops keep gameplay available and never fall back to the legacy path. The FIFO consumer uses persisted bounded retry and privacy-minimal dead letters, while receipt replay makes the eligible D1 effects idempotent. Production remains explicitly `best-effort`, so ordinary production traffic continues through the response-header/`waitUntil` path and creates neither local outbox tables nor D1 receipt rows. Staging intentionally uses exact `outbox` and is currently healthy with `durable-outbox` delivery; eligible staging room milestones use the local queue and receipt-gated D1 path. Its rollback-to-Release-A, drain, candidate-restoration, and repeat-smoke proof remains pending. Release A is the minimum rollback floor after any activation because it can drain Release-B rows. Cleanup reads/deletes receipts only on schema 6, while schema-5 cleanup never prepares receipt-table SQL. Analytics Engine still receives only one best-effort post-D1-commit opportunity for a newly applied receipt, with no retry on failure or replay.

Raw microphone samples, browser-encoded recordings, and captured transcript text always stay in the browser. Live rooms remain in per-room Durable Objects; D1 is the queryable platform store, and aggregate analytics intentionally exclude names, IP addresses, room-member tokens, audio, transcript text, and per-person identifiers. Production room milestones, plus progress and consent analytics in both environments, remain best-effort. Staging alone currently uses exact outbox delivery for receipt-gated room-milestone D1 effects. Analytics Engine stays best-effort everywhere. Protected admin readouts expose aggregate product analytics and model usage for operations, not audit or billing truth. `/api/v1/admin/model-usage` returns only global/daily call, outcome, provider/model/task, input/output/total/cached-input/reasoning token, and latency aggregates—never prompts, responses, room data, identities, or authentication tokens. A timed-out provider call is counted even when it returns no usage; its token totals can therefore undercount vendor-billed work. The public status route checks D1 and reports non-secret configured or degraded platform capabilities, including cleanup health. Delivery is `best-effort` for every non-exact mode, `durable-outbox` only for the compiled producer plus exact `outbox`, schema 6, and a secure room-fact key, and `degraded-outbox` when exact mode is requested without those readiness gates. Accounts and cross-device authentication, external coaching AI, Queues, and R2 are future options, not parts of this slice.

Operators can open the unlinked `/admin/analytics` document and enter the existing numeric `ANALYTICS_ADMIN_TOKEN`. The token is cleared from the password field immediately, used for exactly two same-origin 90-day aggregate requests, and never placed in a URL, browser storage, page output, or telemetry. The dashboard validates and reconciles its source rows before rendering 1/7/30/90-day views. Its dedicated document uses `Cache-Control: public, max-age=0, must-revalidate, no-transform` and a self-only script policy so Cloudflare's optional public-site Web Analytics beacon is not injected into the token-bearing page.

Cloudflare Web Analytics is a separate, optional browser performance service, not the application's D1 rollups or Analytics Engine telemetry. When an operator enables automatic setup for the proxied domain, Cloudflare injects its browser beacon; NonStopTalk application code never sends coaching audio, captured transcript text, or compact-summary payloads to that service. See [AI and Privacy](docs/AI_AND_PRIVACY.md) for the provider-policy boundary.

The platform also includes a narrow, disabled-by-default theme-to-topics provider boundary. The host must explicitly approve each external generation attempt. The only host or room content sent to a provider is that request's normalized theme, capped at 200 characters: never audio, transcript text, names, room authorization data, or a room token. `TOPIC_ROUTINE_PROVIDER=glm` selects direct Z.AI GLM-4.7-Flash with `ZAI_API_KEY`; `TOPIC_ROUTINE_PROVIDER=glm53` selects the `AI` binding's `@cf/zai-org/glm-5.3-flash` model without a vendor key. GLM-4.7 is the strict-free choice, while GLM-5.3 is the preferred cheap model when Workers Paid is acceptable. `TOPIC_ESCALATION_PROVIDER=gemma31` makes Gemma 4 31B available only when the host selects the escalated tier. Each topic request passes the general 60-requests-per-minute scoped API limiter and a dedicated `MODEL_RATE_LIMITER` capped at five requests per source connection per minute. D1 keeps aggregate daily provider usage and enforces a configurable call ceiling; the default is 100 external calls per UTC day. A missing key or binding, invalid selector, unavailable budget/database, or provider failure uses deterministic topics; status reports invalid or incomplete deployment configuration as degraded. Missing consent rejects a configured external request before budget reservation or provider contact. There is one external attempt at most and no provider retry or Queue in this slice.

## Privacy and AI

Classic play does not require an account, an API key, transcription, or audio upload. The browser uses its microphone locally for voice-activity detection. Coaching similarly processes microphone frames in the browser and never uploads audio or captured transcript text. With cloud summary backup off—the default—a coaching attempt makes no coaching-data API call. If the user explicitly enables backup, the app sends only the compact allowlisted summary to the NonStopTalk Worker/D1 platform. Attempt-recording/captured-transcript retention is a separate, off-by-default local-storage option; without it, audio is reduced to measurements and captured transcript text is discarded.

The free Cloudflare multiplayer game remains classic-only for scoring. Its optional topic generator can make a single external request only after the host consents for that generation attempt; the normalized theme, capped at 200 characters, is the only host or room content sent to the provider. Audio, transcript text, names, and room tokens are excluded. Deterministic topic generation remains the default and fallback. The separate coaching path may create a transcript only after explicit consent and only when the browser supports mandatory on-device recognition. Derived filler/repetition patterns are saved with its compact summary and may be part of an explicitly selected cloud backup; captured transcript text is never part of that backup. By default captured transcript text is discarded; if the user separately enables full-session retention, the recording and available captured transcript are stored only for that site origin and browser profile. A finalization warning is persisted and shown whenever retained text may be partial. Coaching-card retrieval and deterministic review assembly also stay in the browser. The following AI-judge behavior belongs to the local Go game edition.

The AI judge is opt-in at two levels: the host enables it for the room, then the current speaker chooses whether to use transcription for that turn. Transcription starts only when the browser exposes `SpeechRecognition` with `processLocally` support and accepts the selected live microphone track. If any of those checks fail, the turn continues with classic scoring or the manual timer.

When a speaker consents, the resulting text transcript is submitted to the NonStopTalk server with that turn. The transcript is used for grading and is not stored in room history or JSON snapshots.

- `NONSTOPTALK_AI_PROVIDER=offline|anthropic|glm` selects the local Go judge and topic generator. Explicit `offline` wins even when API keys exist. If the selector is unset, an existing `ANTHROPIC_API_KEY` preserves the legacy Anthropic behavior; otherwise the server stays offline, and a Z.AI key alone does not opt in.
- Explicit `anthropic` requires `ANTHROPIC_API_KEY`; explicit `glm` requires `ZAI_API_KEY` and uses GLM-4.7-Flash. An invalid selector or missing selected credential logs a warning and fails closed to deterministic local heuristics.
- After the speaker's existing per-turn transcript consent, the selected external judge receives the assigned topic and transcript. Local theme generation sends the selected provider only the host theme as user content. Runtime judge failure preserves classic scoring.
- Choosing classic or manual play sends no transcript and awards no AI bonus.

Browser support for guaranteed on-device speech recognition is limited. AI grading is therefore an enhancement, not a requirement. See [AI and Privacy](docs/AI_AND_PRIVACY.md) for the exact data flow.

## Run locally

The module currently requires Go 1.26.

Run the web server:

```sh
go run ./cmd/web
```

Open [http://localhost:8080](http://localhost:8080). The web command saves room snapshots to `data/rooms.json` by default.

Run the desktop-style launcher:

```sh
go run ./cmd/desktop
```

The launcher starts the same app on an available `127.0.0.1` port and opens the default browser. Its room state is in memory for that process.

Templates, CSS, and JavaScript are embedded in production binaries, so a built executable does not depend on the repository as its working directory:

```sh
go build -o nonstoptalk-web ./cmd/web
go build -o nonstoptalk-desktop ./cmd/desktop
```

Online microphone access requires HTTPS. Browsers treat `localhost` as a secure context for local development; if microphone access is unavailable, the manual timer remains playable.

## Run online

The repository includes a separate native Cloudflare edition for no-cost online hosting. Static files are served through Workers Static Assets, each room is coordinated and persisted by a SQLite-backed Durable Object, and live updates use hibernatable WebSockets. The local Go edition remains independent.

With a Cloudflare Workers Free account, Node.js 22+, and Wrangler authentication:

```sh
npm ci
npx wrangler login
npm run db:create
# copy the returned database UUID into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put ANALYTICS_ADMIN_TOKEN
npx wrangler secret put ROOM_FACT_HASH_KEY
npm run deploy
```

External topic generation needs no secret in the default `offline`/`off` configuration. Direct GLM-4.7 and Gemma escalation need their matching Wrangler secret; Workers AI GLM-5.3 uses the declared `AI` binding and no vendor API key:

```sh
npx wrangler secret put ZAI_API_KEY       # TOPIC_ROUTINE_PROVIDER=glm
npx wrangler secret put GEMINI_API_KEY    # TOPIC_ESCALATION_PROVIDER=gemma31
```

No Docker engine, Container subscription, or static build-output setting is required. The public routes include `/`, `/practice`, `/progress`, and `/room/ABC234`; the Durable Object binding is internal and has no separate public URL. Coaching never puts summaries, recordings, or transcripts into a room object. The optional platform API stores only compact summaries in D1; recordings and captured transcript text remain local. See [Cloudflare Deployment](docs/CLOUDFLARE_DEPLOYMENT.md) for bindings, migrations, free-tier considerations, local Worker development, and custom-domain routing.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Web server port. A value with or without a leading colon is accepted. |
| `NONSTOPTALK_DATA_FILE` | `data/rooms.json` | Local JSON snapshot path. Set to `off` for memory-only rooms. |
| `DST_DATA_FILE` | unset | Deprecated compatibility fallback used only when `NONSTOPTALK_DATA_FILE` is not set. |
| `NONSTOPTALK_AI_PROVIDER` | unset (legacy auto-selection) | Local Go provider selector: `offline`, `anthropic`, or `glm`. Unset selects Anthropic only when `ANTHROPIC_API_KEY` exists; an invalid/incomplete explicit selection warns and uses the offline heuristic. |
| `ANTHROPIC_API_KEY` | unset | Local Go credential for explicit `anthropic` selection and the legacy unset-selector behavior. The current Anthropic adapter uses Claude Opus 4.8. |
| `ZAI_API_KEY` | unset | Local Go credential used only with `NONSTOPTALK_AI_PROVIDER=glm`; that adapter uses GLM-4.7-Flash. The Cloudflare Worker can use the same-named value as a separate Wrangler secret. |
| `NONSTOPTALK_TRUST_CLOUDFLARE_IP` | `false` | For the local Go server only: trust `CF-Connecting-IP` for rate limiting when an operator has placed the server behind a trusted Cloudflare proxy. |

The Cloudflare Worker has a separate, modular topic-provider configuration. API keys are secrets; the provider selectors and limit are ordinary Worker variables. Leaving the selectors at their defaults and omitting provider keys keeps generation deterministic and free.

| Cloudflare variable or secret | Default | Purpose |
| --- | --- | --- |
| `TOPIC_ROUTINE_PROVIDER` | `offline` | `offline` uses deterministic templates; `glm` selects direct Z.AI model `glm-4.7-flash` with `ZAI_API_KEY`; `glm53` selects public model `glm-5.3-flash` through Workers AI binding ID `@cf/zai-org/glm-5.3-flash`. Every external attempt still needs fresh host consent. |
| `TOPIC_ESCALATION_PROVIDER` | `off` | `off` disables escalation; `gemma31` makes Gemini Developer API model `gemma-4-31b-it` available only when the host explicitly selects escalation and consents. |
| `MODEL_DAILY_CALL_LIMIT` | `100` | Maximum external topic-provider attempts per UTC day, enforced with aggregate D1 usage state. |
| `ZAI_API_KEY` | unset | Wrangler secret required only for the `glm` routine provider. |
| `GEMINI_API_KEY` | unset | Wrangler secret required only for the `gemma31` escalation provider. |

Cost snapshot, checked August 31, 2026: [Z.AI's pricing](https://docs.z.ai/guides/overview/pricing) lists direct GLM-4.7-Flash input, cached input, storage, and output as free, so the default/direct path avoids a fixed Workers Paid charge. [Cloudflare's Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) lists GLM-5.3-Flash at $0.15/M input, $0.03/M cached-input, and $0.50/M output tokens; [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) lists a $5 USD/account/month Workers Paid minimum. This build's plain `AI.run()` path requires Workers Paid; prepaid AI Gateway credits would need a gateway ID and Unified billing, which are not implemented. [Google's Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing#gemma-4) lists Gemma 4 input, output, and caching as free, with no paid tier, and says free-tier content is used to improve Google's products. That privacy tradeoff is why Gemma remains explicit escalation and receives only the normalized theme. Prices, quotas, and provider terms can change. Platform status can verify that `AI.run` exists, not that the account has billing entitlement; a denied first request fails closed to deterministic topics.

Example memory-only local run:

```sh
NONSTOPTALK_DATA_FILE=off go run ./cmd/web
```

## Scoring

Classic scoring is deliberately simple:

```text
score = seconds_spoken + 25 points when the full timer is completed
```

The optional judge adds `round(relevance × 20)` points. Judge work is asynchronous and best-effort, so a timeout, missing transcript, provider error, or interrupted restore leaves the classic score intact. The host can adjust any player's total in five-point increments.

For remote speakers, the server keeps its own turn clock and caps client-reported speaking time. This is lightweight party-game authority, not an anti-cheat system.

## Test

Run the Go suite, race detector, and static checks:

```sh
go test ./...
go test -race ./...
go vet ./...
```

The browser smoke test requires Node.js/npm and Playwright's Chromium:

```sh
npm ci
npx playwright install chromium
npm run smoke
```

The smoke suite drives five flows: microphone-denied manual play with reload/resume, automatic timer completion with a mocked microphone, a two-browser online room synchronized by SSE, an on-device AI-judge turn using the offline provider, and a fail-closed classic fallback when local transcription is unavailable.

To use an existing Chromium binary:

```sh
SMOKE_CHROMIUM=/path/to/chromium npm run smoke
```

Set `HEADED=1` to watch the browser run.

Validate the native Cloudflare game rules and deploy bundle:

```sh
npm run typecheck:cloudflare
npm run test:cloudflare
npm run test:coach
npm run test:cloud-progress
npm run test:admin
npm run test:production-monitor
npm run test:worker-runtime-runner
npm run test:staging-outbox-smoke
npm run test:staging-outbox-rollback-drill
npm run test:cloudflare-runtime
npm run test:cloudflare-runtime-outbox
npm run check:cloudflare
npm run smoke:multiplayer
npm run smoke:accessibility
npm run smoke:coach
npm run smoke:admin
npm run smoke:platform
```

`test:cloudflare` and the Go test suite both consume `testdata/game-contract.v1.json`, which locks six core rule families to the same expected behavior in both editions: Unicode limits, remote-clock tolerance, completion normalization, score corrections, atomic custom topics, and persisted turn-ID repair. Cloudflare tests also cover canonical milestone payloads, receipt replay/conflict behavior, the isolated post-commit Analytics Engine attempt, schema-6 receipt expiry, the absence of receipt SQL from schema-5 cleanup, and the Release-A rollback bridge. A separate exact-outbox Workers runtime proves atomic room/event/alarm commits, deterministic transaction replay, FIFO lifecycle delivery, marker-5 recovery, eviction and concurrent joins, expected fail-open drops, second-event and alarm rollback, capacity boundaries, exactly-one routing, and both Worker/Durable-Object propagation-skew directions; the original runtime remains a best-effort control that proves ordinary rooms create no outbox. A bounded wrapper rejects known teardown, pending-RPC, uncaught-runtime, and other false-green signatures even when Vitest exits zero. `test:coach` runs 34 deterministic measurement, continuity, transcript-analysis, retrieval, grounding-safety, advice, relationship, grouping, persistence-gating, and paired-comparison tests without a microphone. `smoke:coach` drives synthetic media through the single coached path and the default review-only baseline → Progress/reload → locked unassisted-retry path; it checks that local-first attempts make no coaching-data API request, and covers local storage, per-attempt artifact deletion, lifecycle, review, and comparison behavior. `test:cloud-progress` checks the separate opt-in client's summary allowlist, relationship metadata, legacy compatibility, merge behavior, API calls, and preference state. `test:admin` validates dashboard source reconciliation, UTC windows, request/token boundaries, empty data, and hostile display text. `smoke:admin` exercises the isolated document, strict headers, two-request authorization flow, 320px layout, keyboard focus, and absence of third-party requests or persistence. `smoke:accessibility` runs automated axe WCAG-rule scans plus heading, focus, title, skip-link, reduced-motion, and narrow-layout assertions across the public routes and core room states; it is regression coverage, not formal conformance certification. `smoke:multiplayer` boots a hermetic local Worker/D1/Durable Object and drives two isolated browser identities through WebSocket propagation, host authorization, scoring, reload persistence, and a finished game. Its verified process-tree cleanup requires Linux or macOS; use WSL or the Ubuntu CI job instead of native Windows. `test:production-monitor` prevents the scheduled read-only health workflow from gaining secrets, mutation commands, unpinned actions, or unbounded runtime. `smoke:platform` starts a local Wrangler/D1 instance and exercises status, summary backup, relationship-column persistence, export, analytics, privacy, and deletion boundaries.

## Architecture

- Go `net/http` server and domain packages for local/self-hosted play
- Embedded Go templates and static assets
- Official HTMX 2.0.10 vendored for server-rendered interactions
- Vanilla JavaScript for microphone selection, Web Audio voice activity, on-device speech recognition, timers, presets, and SSE refreshes
- In-memory Go room manager with optional periodic JSON snapshots
- Replaceable offline, Anthropic, and Z.AI GLM adapters behind small Go judge/topic-generator interfaces
- Native TypeScript Worker, Workers Static Assets, and one SQLite-backed Durable Object per online room
- Hibernatable WebSockets for cost-efficient online synchronization
- Browser `AudioWorklet` (with an `AnalyserNode` compatibility fallback) for coaching signal reduction, plus deterministic analysis and local lexical coaching-card retrieval
- Origin-scoped IndexedDB v2 for compact coaching summaries—including explicit loop/baseline/role metadata—and a separate, explicitly opted-in recording/captured-transcript store; exports exclude those artifacts, per-attempt deletion preserves the compact record, and full local deletion clears both stores
- An in-progress modular platform layer using D1 for queryable consented summaries and protected daily rollups, plus Analytics Engine for coarse best-effort telemetry; Durable Objects remain responsible for live rooms, and a configuration-gated atomic outbox producer is enabled in staging while remaining off in production, with a Release-A-compatible consumer and no additional service
- A dependency-free, protected operator dashboard over the existing aggregate APIs, isolated from public-site RUM and backed by reconciled daily tables
- A separate Cloudflare topic-provider adapter with deterministic default/fallback behavior, optional direct GLM-4.7 or Workers AI GLM-5.3-Flash routine generation, explicit Gemma 4 31B escalation, and aggregate D1 cost controls
- Playwright browser smoke coverage plus Go unit and handler tests

There is no frontend build step for local play.

## Explicit future backlog

These ideas are not presented as current features:

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- A packaged native desktop wrapper
- Visible user profiles and profile management
- Family/content filters
- Post-turn AI summaries
- Full multiplayer-game feature parity between the local Go and free Cloudflare editions (AI judge, saved presets, import/export, microphone picker, and sound cues)
- Validated learning outcomes from baseline-to-unassisted-retry coaching programs; the product now implements descriptive pairing but does not claim that a changed measurement is improvement
- Coaching accuracy, usability, accessibility, and accent/language fairness validation across browsers and microphones
- Guided programs, accounts and cross-device authentication/progress, educator tools, and optional external semantic/AI coaching
- Queue-backed provider jobs or R2 media storage; neither is configured in the first platform slice
- Complete the pending staging rollback/drain/restoration proof for the active exact outbox lane, then separately review production activation; staging is currently healthy `durable-outbox`, while production remains `best-effort`

## Documents

Start with the [documentation index](docs/INDEX.md), which routes readers by task and identifies the canonical reference for each subject.

For a presentation or quick return to the project:

- [Learn NonStopTalk in 45 minutes](docs/LEARN_IN_45_MINUTES.md)
- [Presentation cheat sheet](docs/PRESENTATION_CHEAT_SHEET.md)
- [Coaching presentation guide](docs/COACHING_PRESENTATION_GUIDE.md)

Core references:

- [Product context](PRODUCT.md) and [design direction](DESIGN.md)
- [Requirements and implementation status](docs/REQUIREMENTS.md) and [roadmap](docs/ROADMAP.md)
- [Speech coaching prototype](docs/SPEECH_COACHING_PROTOTYPE.md) and [technical architecture](docs/TECHNICAL_ARCHITECTURE.md)
- [AI and privacy](docs/AI_AND_PRIVACY.md) and [Cloudflare deployment](docs/CLOUDFLARE_DEPLOYMENT.md)
- [Web platform plan](docs/WEB_PLATFORM_PLAN.md) for the central database, APIs, analytics, cost controls, and phased delivery
- [Game design](docs/GAME_DESIGN.md), [desktop application](docs/DESKTOP_APPLICATION.md), and the [historical web version plan](docs/WEB_VERSION_PLAN.md)
