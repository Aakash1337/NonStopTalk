# Technical Architecture

This is the current NonStopTalk architecture, not a future stack proposal.

## System overview

```text
local/self-hosted browser
  ├─ full pages + HTMX form requests ───────────────┐
  ├─ Server-Sent Events + partial refreshes ────────┤
  ├─ Web Audio voice activity + local timer         ├─> Go net/http server
  └─ optional on-device SpeechRecognition transcript┘       │
                                                             ├─ game/room state in memory
                                                             ├─ optional JSON snapshots
                                                             └─ offline, Anthropic, or Z.AI GLM judge

online browser SPA
  ├─ static HTML/CSS/JS ───────────────────────> Workers Static Assets
  ├─ JSON actions ─────────────────────────────> Worker /api/* router
  ├─ host theme + one-request consent ─────────> topic-provider adapter
  │                                                ├─ deterministic templates
  │                                                ├─ direct GLM-4.7-Flash (routine, optional)
  │                                                ├─ Workers AI GLM-5.3-Flash (routine, optional)
  │                                                └─ Gemma 4 31B (explicit escalation, optional)
  └─ hibernatable WebSocket updates ───────────> room Durable Object
                                                        └─ private SQLite state

online browser coaching path (/practice and /progress)
  ├─ microphone ─> AudioWorklet ─> objective measurement frames ─┐
  ├─ optional strict on-device SpeechRecognition ─> word patterns┤
  ├─ optional MediaRecorder ─> full artifact store                ┤
  └─ goal + evidence ─> local lexical coaching-card retrieval     │
                         └─ card drill or evidence-safety override  │
                              + deterministic assembly              │
                               └─ IndexedDB v2 ─────────────────────┘
                                  ├─ session-summaries
                                  └─ session-artifacts (opt-in)
                                  │
                     optional compact-summary backup
                                  ▼
                     Worker /api/v1 → central D1
       (default/off: no coaching-data API; never audio/transcript upload or room DO)

server-authoritative milestones → best-effort D1 daily rollups + Analytics Engine
external topic attempts ────────> aggregate D1 daily usage budget/counters
```

There are two runtime editions. The richer local/self-hosted game edition is one Go application shared by the normal web and desktop-style launchers. The free online edition is a native TypeScript Worker with a separately tested implementation of the core classic-game rules. Its static SPA also contains the browser-only coaching prototype; that prototype is not currently served by the Go application.

## Current stack

- Backend and routing: Go 1.26, `net/http`, and Go's method-aware `ServeMux`
- Rendering: embedded `html/template` files
- Server-rendered interaction: official HTMX 2.0.10 vendored in `web/static/js/htmx.min.js`
- Browser logic: vanilla JavaScript
- Microphone analysis: `getUserMedia` and Web Audio; the coaching path prefers `AudioWorklet` and has an `AnalyserNode` compatibility fallback
- Optional transcription: browser `SpeechRecognition` only when `processLocally` is supported
- Optional local recording retention: browser `MediaRecorder`, behind a separate unchecked consent control
- Real-time updates: Server-Sent Events, followed by HTMX partial fetches
- State: in-memory rooms and optional periodic JSON snapshots
- External AI: provider-neutral local Go judge/topic-generator interfaces; separate disabled-by-default Cloudflare topic-provider adapters for direct GLM-4.7 or Workers AI GLM-5.3-Flash routine generation and explicit Gemma 4 31B escalation
- Tests: Go unit/handler/race/vet checks, a shared Go/TypeScript game-rule contract, and Playwright browser smoke flows
- Free online runtime: Workers Static Assets, a TypeScript fetch router, SQLite-backed Durable Objects, and hibernatable WebSockets
- In-progress web platform: versioned Worker APIs, central D1 repositories/migrations, an internal sync-profile foundation, scheduled anonymous-data expiry, coarse D1/Analytics Engine event aggregation, an unhooked schema-v6 milestone receiver with active receipt expiry cleanup, and aggregate D1 model-usage budgeting
- Cloudflare rule tests: Node's test runner through `tsx`, plus a Wrangler deploy dry run
- Coaching state: ephemeral browser objects plus IndexedDB v2 summary and opt-in artifact stores
- Coaching knowledge: curated in-app cards with local lexical retrieval and deterministic template assembly; no LLM, open-ended prose synthesis, embeddings, or vector database
- Coaching verification: 21 Node tests for the deterministic engine, a Playwright SPA smoke flow asserting no coaching-data API request on the default/off path, and separate cloud-progress/platform tests for the allowlist, APIs, ownership, retention, and analytics

There is no SPA framework, frontend bundler, account system, server-side coaching analysis service, or server-side audio pipeline. The online edition uses browser-native modules, Durable Object SQLite/WebSockets for live rooms, and an in-progress D1/Analytics Engine platform layer; the Go edition does not.

## Repository layout

```text
assets.go                         embedded template/static filesystem
cmd/web/                          normal HTTP server entry point
cmd/desktop/                      loopback server + default-browser launcher
internal/game/                    session, turn deck/progression, scoring, history
internal/judge/                   offline, Anthropic, and Z.AI GLM grading/topic generation
internal/room/                    synchronized rooms, identity, presence, SSE signals,
                                  server clock, persistence
internal/topics/                  built-in topic packs
internal/web/handlers/            routing, authorization, validation, rendering
testdata/game-contract.v1.json    versioned cross-edition core-rule fixtures
internal/web/templates/           full-page and swappable HTML templates
web/static/css/                   UI styles
web/static/js/                    HTMX and focused browser modules
scripts/smoke-local.mjs           Playwright end-to-end smoke suite
cloudflare/game.ts                native online classic-game rules
cloudflare/worker.ts              Worker composition + SQLite-backed room object
cloudflare/routes.ts              public API route parser
cloudflare/public/app.js          online SPA routing, game UI, coaching lifecycle,
                                  IndexedDB summaries/artifacts, downloads, and review
cloudflare/public/cloud-progress.js
                                  allowlisted opt-in compact-summary API client
cloudflare/public/app.css         shared Play, Practice, and Progress visual system
cloudflare/public/coach-engine.js deterministic audio aggregation, tips, transcript
                                  counts, curated-card retrieval, grounding, advice,
                                  and summary calculations
cloudflare/public/coach-audio-worklet.js
                                  ~100 ms microphone RMS/peak reduction
cloudflare/public/coach-engine.test.js
                                  deterministic coaching-engine coverage
cloudflare/*.test.ts              native Worker rule/route tests
cloudflare/platform.ts            anonymous identity, D1 repositories, retention,
                                  room facts, and aggregate analytics
cloudflare/platform-routes.ts     versioned APIs, admin guard, telemetry fan-out,
                                  request IDs, and scheduled cleanup adapter
cloudflare/model-provider.ts      offline, direct GLM-4.7, Workers AI GLM-5.3,
                                  and Gemma 4 31B topic adapters
                                  adapters plus bounded output normalization
cloudflare/model-routes.ts        host/setup authorization, one-request consent,
                                  D1 budget reservation/reconciliation, fallback
cloudflare/migrations/            append-only D1 schema migrations
scripts/smoke-coach.mjs           synthetic-microphone coaching browser flow
wrangler.jsonc                    Assets, Durable Object, D1, analytics, limits, cron
```

## Domain boundaries

### Game

`internal/game` owns rules that do not depend on HTTP:

- Roster order and score totals
- Normalized settings
- Turn and round progression
- Shuffled topic decks and redraws
- Classic and optional relevance scoring
- Winner standings and completed-game history
- Unique turn IDs used to reject stale asynchronous work

The source topic list is not shuffled in place. A persisted deck of indexes and cursor allows a random cycle to survive JSON restore.

### Room

`internal/room` wraps one game session with shared online concerns:

- Cryptographically random room codes and browser tokens
- Host token and token-to-player bindings
- Presence counts and SSE subscriber notifications
- A mutex around session reads and writes
- Server-side turn start time
- Host transfer/absence tracking
- Idle lifetime and capacity limits
- JSON snapshot save/restore

Handler code reads or mutates a session through room locking helpers. Mutations bump a version and wake subscribers.

### Web

`internal/web/handlers` owns:

- Route registration and page/partial rendering
- Browser-token cookies and room authorization
- Host/current-speaker action checks
- Input parsing, normalization, body limits, origin checks, and request quotas
- Remote time-claim capping
- Asynchronous judge dispatch
- Selection of an offline, Anthropic, or Z.AI GLM provider, with invalid or incomplete selections warned and failed closed to offline behavior

Templates receive a view model containing room identity, authorization flags, presence, clock state, and game state.

### Browser

Browser scripts are intentionally narrow:

- `setup.js`: browser-local custom topics and presets, including migration from old storage keys
- `room.js`: one SSE connection, debounced HTMX partial refreshes, spectator countdown, and host-claim refresh
- `turn.js`: microphone/device lifecycle, Web Audio voice activity, local/manual timers, optional local transcription, sound cues, and result submission
- `htmx.min.js`: unmodified official HTMX distribution

The server remains authoritative for room state and remote score caps. Browser timers provide responsive display and local detection, not durable truth.

### Native Cloudflare edition

`cloudflare/worker.ts` routes public `/api/rooms/{code}` requests to one Durable Object selected by the normalized room code. The object serializes actions, stores the complete classic-game state in its private SQLite database, and broadcasts per-viewer public state through hibernatable WebSockets. `cloudflare/game.ts` owns the online rule implementation; identity tokens never appear in public state.

Static navigation paths such as `/`, `/practice`, `/progress`, and `/room/ABC234` are served by Workers Static Assets with SPA fallback. The online multiplayer game performs microphone voice-activity analysis locally and remains classic-only for scoring. During setup, its host-only `/api/v1/models/topics` boundary can produce an editable topic draft from a theme capped at 200 characters. Routine generation is deterministic unless `TOPIC_ROUTINE_PROVIDER=glm` selects direct Z.AI GLM-4.7-Flash or `TOPIC_ROUTINE_PROVIDER=glm53` selects Workers AI GLM-5.3-Flash through the `AI` binding. Gemma 4 31B is available only when `TOPIC_ESCALATION_PROVIDER=gemma31` and the host explicitly selects escalation. Every external path also requires fresh consent for that generation attempt. The separate coaching route can create an explicitly consented transcript only through strict on-device browser recognition; it never uses the topic providers or sends captured transcript text or a recording to the Worker. Compact summary backup is an independent, off-by-default API boundary; captured-transcript/recording retention remains local-only.

### Web platform foundation (in progress)

The platform slice keeps composition in `cloudflare/worker.ts` and separates live room coordination, relational storage, coaching backup, identity, maintenance health, analytics, and model providers behind small modules. D1 is the central queryable store for anonymous device expiry, consented compact summaries, consent records, HMAC-pseudonymous room facts, one retention-cleanup heartbeat, best-effort daily analytics counters, schema-v6 milestone receipts for an unhooked internal receiver, and aggregate model-usage budget state. The room-fact HMAC uses a separate Worker secret because a plain hash of the short code space would be enumerable; raw codes and the key never enter D1. Normal room traffic still sends Analytics Engine and D1 the same coarse event vocabulary best-effort through the Durable Object response header and top-level Worker's `waitUntil`; either sink can miss events and neither is audit, billing, or user-visible truth. Durable Objects remain authoritative for concurrent room actions and WebSocket broadcasts.

The topic-provider adapter is intentionally narrower than a general coaching model. The browser submits the room code for host/setup authorization, a routine/escalated tier, per-request consent, and the theme. The normalized theme is the only host or room content sent externally; the adapter strips room authorization data before the provider call, while fixed instructions and model settings accompany the theme. `ZAI_API_KEY` and `GEMINI_API_KEY` are Worker secrets; Workers AI GLM-5.3 uses the `AI` binding and needs no vendor key. `TOPIC_ROUTINE_PROVIDER=offline|glm|glm53` and `TOPIC_ESCALATION_PROVIDER=off|gemma31` independently enable the routine and escalation tiers, while `MODEL_DAILY_CALL_LIMIT` defaults to 100 external attempts per UTC day. D1 usage rows aggregate reservations/completions, successes/failures, provider/model/task, input/output/total/cached-input/reasoning token totals, and total latency without themes, generated topics, identities, or room/member/authentication tokens. A configured external request without consent is rejected before reservation or contact. A missing key or binding, invalid selector, or budget/database/provider/output failure returns deterministic topics; status marks invalid or incomplete configuration as degraded. There is no automatic escalation, retry, or Queue in this slice.

Anonymous progress ownership is the SHA-256 digest of the existing high-entropy HTTP-only browser token. The raw token is never stored in D1; IP address, user agent, names, and room-member tokens are excluded from platform records. Cloud use refreshes one device-level UTC-day-bucketed lease for all summaries; it lasts at least 30 and less than 31 days and does not require per-summary renewal writes. New saves are rejected once 250 summaries exist, but valid unexpired legacy rows are not forcibly deleted. Scheduled cleanup deletes bounded batches and leaves excess backlog for a later cron run. After a wholly successful invocation, one singleton records its monotonic scheduled/completed heartbeat and final backlog bit. This bootstrap identity is not an account, recovery credential, or cross-device authentication system.

#### Schema-v4 identity expansion

Schema v4 is an expand-only identity step. `sync_profiles` holds an opaque internal profile ID, sync generation, and lifecycle metadata; `sync_profile_devices` maps each device digest to one profile. Migration backfill and new-device writes create one profile per browser, so no two browsers are linked in this stage. Neither table contains coaching content, consent receipts, raw cookie tokens, IP addresses, or user agents. Profile IDs are not returned by an API, shown in the UI, or accepted for authorization.

The current device-owned `coaching_sessions` primary key, foreign key, repositories, list/export/delete queries, 250-summary guard, and consent behavior remain unchanged. Deleting an expired device cascades its membership; bounded cleanup removes the now-orphaned profile when its mirrored expiry is due. The two small metadata rows per browser add only D1 row/write overhead and require no model, Queue, email provider, paid service, or new production secret.

This sequencing preserves rollback: first expand and backfill, then validate profile/device membership while all product reads and writes stay on the device path. A later release may add bilateral, short-lived numeric-code linking under a separate `IDENTITY_HASH_KEY` with explicit consent on both browsers, followed by compatibility reads/writes before any session-ownership contraction. Device-key ownership must not be removed until linked-profile behavior, retention, deletion, export, and rollback have been verified. Numeric linking and that contraction are not implemented in schema v4.

#### Schema-v5 cleanup heartbeat

Schema v5 is another additive step. `platform_maintenance` contains one row with the latest successful cron's scheduled timestamp, completion timestamp, and a backlog bit. Migration time initializes the row as a first-run grace heartbeat. Cleanup advances it only after all attempted batches succeed, using a monotonic upsert so an older delayed cron cannot replace newer health. An exact existence read runs only when the twentieth batch is full, preventing an exactly empty boundary from becoming a false backlog. Public status derives `ready`, `stale`, or `backlog` and exposes none of the stored timestamps, deletion counts, or user data. A schedule older than 36 hours or a remaining backlog degrades readiness. The design adds one tiny D1 write per successful daily cron and no binding, service, secret, provider, or per-user row.

#### Schema-v6 internal milestone receiver and receipt cleanup

Schema v6 is an expand-only migration. It creates an empty `room_milestone_receipts` table with constrained lowercase 64-hex event IDs and payload hashes; canonical UTC `received_at`, optional `applied_at`, and exact-90-day `expires_at` timestamps; ordering constraints; and an expiry index. It contains no room code, name, topic, member/authentication token, IP data, audio, transcript, or coaching content.

The Worker accepts markers 5 and 6 through an uncached schema guard. Existing routes retain the schema-v5 application contract. Two paths are isolated to marker 6: `receiveRoomMilestone()` and receipt expiry cleanup. The internal receiver accepts an exact canonical 17-field payload tuple plus an opaque event ID, hashes the payload, and HMAC-pseudonymizes the opaque room-instance ID before any eligible room fact reaches D1. It inserts the receipt, conditionally upserts the room fact, conditionally increments the daily rollup, marks the receipt applied, and reads the outcome in one receipt-gated D1 batch. An exact replay returns `duplicate` without repeating those D1 effects; reuse of an event ID with another payload hash returns `conflict`. Analytics Engine is outside that batch and receives at most one best-effort post-commit write opportunity after the first applied result. Failure or interruption can lose that point, and replay does not retry it.

This primitive is not imported by `cloudflare/worker.ts` and has no public route. Normal rooms continue to emit `X-NonStopTalk-Room-Milestones` and use the existing best-effort `waitUntil` fan-out, so they do not create receipts. Scheduled cleanup deletes expired receipts within the existing bounded schema-6 run and includes remaining receipt work in its shared backlog result; marker-5 cleanup never prepares SQL that names the receipt table. A Durable Object SQLite outbox, alarm retries, dead-letter handling, and end-to-end durable-delivery semantics are not implemented. The schema-5/6 bridge remains the safe marker-6 rollback target until that future activation and rollback window complete.

The versioned platform API exposes `GET`/`HEAD` status, compact-summary create/list/delete/export, and separate aggregate product-analytics and model-usage readouts protected by `ANALYTICS_ADMIN_TOKEN`. Best-effort product events are deferred through `ExecutionContext.waitUntil`, so a slow or failed telemetry sink cannot make an already-successful progress mutation look failed. The model-usage readout returns global and per-day provider aggregates for calls, outcomes, model tokens, and latency, never content or identity. Status checks D1 and reports non-secret configured or degraded capabilities, including retention-cleanup health, optional analytics, keyed-room-fact configuration, and topic-provider readiness. Same-origin checks protect mutations and responses are non-cacheable with request IDs. The browser allowlist omits artifact metadata; the Worker validates the current v2 shape and optional all-or-none loop/baseline/role/feedback relationship, then strips any artifact metadata before storage, return, or export. D1's reserved relationship columns are populated on insert and update. Raw audio/transcript/sample/segment keys hard-fail, and arbitrary extra properties are rejected.

`cloudflare/public/admin/analytics/index.html` is an isolated operator document rather than an SPA route. `admin-analytics-page.js` owns its short-lived authorization lifecycle, while `admin-analytics.js` owns the two-request client, source validation/reconciliation, UTC window model, formatting, and dependency-free view. The Worker routes only this document before Static Assets so it can add `no-transform`, noindex/no-referrer headers, and a CSP that permits only same-origin scripts, styles, and API connections. Public pages retain their separate Cloudflare Web Analytics policy; a beacon already running in the public SPA can never survive into the admin page through `pushState` because no client-side route exists.

### Browser coaching prototype

`cloudflare/public/app.js` owns the Practice and Progress route state machine:

```text
setup → microphone permission → quiet calibration → voice calibration
      → active attempt → finishing → review
      → [baseline review] locked retry setup → second review → comparison
```

Setup first chooses the recommended baseline + unassisted retry format or the alternative single coached format, then one of three scenarios, one focus goal, a 30/45/60/90-second duration, optional local transcript analysis, optional full-session retention, and optional compact cloud backup. All three data choices start unchecked and are independent: transcript analysis controls derived pace/word-pattern evidence; full-session retention controls an encoded attempt recording and whatever captured transcript is available; cloud backup controls only the allowlisted summary API call. A retry locks scenario, goal, and duration. Direct retry preserves visible optional selections; a retry resumed from Progress resets them to unchecked. The retention control is disabled without `MediaRecorder`. Calibration collects approximately two seconds of quiet frames and two seconds of normal-speaking frames. It derives a session-specific threshold instead of treating one absolute amplitude as universal.

The preferred signal path is:

1. `getUserMedia` opens one audio `MediaStream` with echo cancellation and noise suppression requested and automatic gain control disabled.
2. `AudioContext.createMediaStreamSource` adds the stream to a Web Audio graph.
3. `audioWorklet.addModule("/coach-audio-worklet.js")` loads `CoachingMeterProcessor`.
4. The worklet mixes input channels, accumulates squared sample energy and absolute peak, and posts one compact frame approximately every 100 ms.
5. `CoachingAnalyzer` classifies frames using the derived calibration, accumulates voice/silence/unknown segments and objective metrics, and exposes snapshots. A level frame is held for at most 250 ms; any longer callback remainder becomes unknown rather than invented voice, silence, or clipping. With zero callbacks, the entire elapsed attempt is unknown with zero signal coverage/confidence and input-recovery advice.
6. `CoachingTipPolicy` evaluates snapshots only for a standalone single coached attempt. The UI does not consider a tip during the first five seconds, enforces a ten-second gap between displayed tips, shows one cue for five seconds, and clears it before another cue. A paired baseline or retry creates no tip policy and mounts no live meter, statistics, or tip surface; it shows only the prompt, goal, timer, and microphone-connected state until Review.
7. The selected goal and measured evidence form a lexical query over curated coaching cards bundled in `coach-engine.js`.
8. `buildAdvice` normally starts with the highest-ranked card's prewritten drill and appends one priority-specific comparison sentence. If an evidence-safety rule rejects unsupported card advice, it uses the measured priority's drill instead. Grounding records the card ID only when that card contributed; separate rules select the strength, focus, and measured evidence.

This is labeled a small **retrieval-augmented deterministic generation** pipeline. “Generation” is bounded template assembly: a supported retrieved-card drill normally remains intact and a fixed comparison sentence selected by the top measurement priority is appended. An evidence-safety override can instead preserve the priority drill; then `grounding.usedCardId` is `null`, and the UI labels the card as retrieved context rather than used guidance. Missing callbacks, for example, must produce restore-input advice rather than unsupported microphone-distance guidance. The pipeline uses no LLM, open-ended prose synthesis, embedding model, vector database, remote corpus, or network call. That boundary keeps the prototype no-cost, low-latency, private, auditable, and deterministic.

If the worklet cannot be loaded, an `AnalyserNode` reads `Float32` time-domain frames every 100 ms and produces the same RMS/peak input shape. Both paths stay in the browser. The fallback is a compatibility path, not evidence that every browser/device combination has been validated.

Optional transcript assistance creates `SpeechRecognition`, requires its `processLocally` property, sets that property to `true`, and supplies the current microphone track. Transcript text is limited to 20,000 characters in memory. Failed initialization or no captured text yields no transcript metrics and never selects a remote mode. At finish, the page calls `stop()` and waits up to two seconds for final results. An error/timeout after text arrived preserves it for analysis but marks it as possibly partial; Review warns immediately, and retained artifacts persist `transcriptMayBePartial` so Progress warns too. Error payloads are never retained. The default summary keeps aggregate pace/counts plus bounded filler/repeated-word pattern arrays (up to 50 entries per array and 64 characters per label) after transcript consent. Captured transcript text is then cleared unless full-session retention was separately selected.

Finishing writes to IndexedDB database `nonstoptalk-coaching`, version 2. Every completed saved attempt puts an allowlisted record in `session-summaries`: schema version, ID/time, scenario, goal, target duration, explicit practice-loop/baseline IDs plus attempt-role/feedback-mode fields, observed/unknown/coverage measurements, other aggregate measurements, optional transcript counts/patterns, normalized advice, and artifact metadata including `transcriptMayBePartial`. Standalone attempts store null relationship IDs; pre-loop schema-v2 records that omit the four fields remain legacy standalone attempts. The summary excludes segments, per-frame values, grounding details, audio payloads, and captured transcript text. If full-session retention was selected and a recording or transcript was captured, the same read/write transaction also puts an ID-linked record in `session-artifacts` containing the encoded audio `Blob`, MIME type, captured transcript, partial-text flag, and creation time.

After the local save, an explicitly selected cloud backup passes the summary through the narrower `cloud-progress.js` allowlist and posts it to D1. Artifact metadata is not included. Failure leaves the local summary usable; no Queue or provider retry system is part of this slice.

`/progress` reads local summaries and, after this browser has opted into cloud backup, merges its reachable D1 summaries by session ID; the local record wins so artifact download metadata remains available. `coach-loop.js` validates explicit relationships and supported setup before grouping. It never pairs by recency: legacy/standalone attempts stay independent, and duplicates, orphans, mismatches, or malformed records remain visible as unpaired. An incomplete valid baseline can restore a locked retry after reload.

Valid pairs compare only the selected goal. Pace uses eligible estimated WPM, longest speaking run, and median pause; pauses uses measured pauses per observed minute, median pause, and longest speaking run; energy uses level consistency and clipping. Raw baseline/retry values and descriptive deltas are labeled limited when either attempt is under 15 analyzed seconds, under 75% coverage, low/unknown confidence, or lacks a shared measurement. Goal-specific caveats prohibit a universal score or automatic better/worse direction.

JSON export never includes an artifact `Blob` or captured transcript text. Per-attempt download buttons read the local artifact store only. Per-attempt artifact deletion removes that record and resets summary artifact metadata in one transaction while preserving the compact attempt/pair. Confirmed full-history deletion clears both local object stores and, when enabled and reachable, this anonymous browser's cloud summaries. Local artifacts have no automatic expiration.

The version-2 upgrade preserves an existing version-1 `session-summaries` store and creates `session-artifacts` when missing. The browser smoke suite constructs a v1 database and verifies that both stores exist after Progress opens it.

Navigating away or canceling stops recognition and an active recorder, discards unsaved recording chunks, closes the worklet message port, stops every media track, closes the audio context, and clears interval work. Route/token checks prevent a delayed permission result or delayed worklet load from attaching hardware or starting an attempt after cancellation. A seven-second calibration watchdog fails cleanly when no analysis frames arrive; a separate wall-clock attempt timer finishes the attempt even if audio callbacks stall, and missing intervals appear as unknown evidence. An ended input track either fails calibration or finishes the active attempt with a warning. Client-side navigation moves focus to the destination `h1`.

## Local Go request and update flow

1. A browser creates or joins a room through a normal form POST.
2. The server sets or reads an HTTP-only SameSite browser-token cookie.
3. A room page opens an SSE connection to `/room/{code}/events`.
4. Mutations run under the room lock, increment the room version, and signal subscribers.
5. A client receiving a new version asks HTMX for `/room/{code}/partial` and swaps `#app`.
6. While that client is actively running a local turn or microphone dialog, refresh is deferred to avoid destroying live browser resources.
7. Spectators render the server's remaining time and approximate the countdown between refreshes.

SSE is a long-lived response, so any reverse proxy or host must support streaming without buffering.

## Turn flow and authority

Both editions follow this core sequence; transcript/judge steps apply only to the Go edition.

1. The game engine creates a unique active turn and draws from the shuffled deck.
2. The current speaker or eligible pass-and-play host begins the timer.
3. The browser notifies the server to start its own clock.
4. Web Audio measures volume locally, or the player uses manual timing.
5. Submission includes intended turn ID, timing result, completion/elimination flags, and an optional consented transcript.
6. The server rejects stale/duplicate turn actions and caps a remote speaker's time against observed server elapsed time.
7. Classic score is applied synchronously.
8. If eligible, judge grading runs asynchronously and can resolve that exact pending turn once.

An AI response cannot be applied twice or to a later turn. Pending judge work cannot resume across a process restart; restore reconciles it to a failed judge state with classic scoring.

## AI and privacy path

The microphone stream stays in the browser. Web Audio analyzes it without uploading it in both game and coaching paths. Coaching can optionally copy the active-attempt stream into a local `MediaRecorder` artifact after separate consent; calibration is not part of that recording.

The coaching path calls no server-side judge. Goal/evidence queries retrieve a curated card locally; deterministic assembly normally combines its unchanged drill with a metric-specific comparison sentence, while an evidence-safety rule can substitute a supported priority drill and label the card context only. Optional transcript analysis saves aggregate counts and derived filler/repetition patterns in the summary. Captured text is cleared by default or stored only after the artifact-retention choice. The independent cloud choice may back up the compact summary, including bounded derived pattern fields, but never captured text or media.

The Cloudflare game's topic-generation path is separate from both coaching and the Go judge. A room host must consent for each external attempt. The routine tier can call direct GLM-4.7-Flash or Workers AI GLM-5.3-Flash only when the corresponding selector is enabled; the escalated tier can call Gemma 4 31B only when independently enabled and explicitly chosen. The normalized theme, capped at 200 characters, is the only host or room content sent to a provider—never audio, transcript text, player/room names, room codes or member/authentication tokens, game history, or coaching summaries. Fixed instructions and model settings accompany it; NonStopTalk request IDs do not. Generated topics are validated and returned as an editable custom-topic draft. Deterministic generation is the default and the fallback for missing credentials/bindings, invalid configuration, budget unavailability/exhaustion, and remote provider/output failures. Authorization, input, and missing-consent errors remain explicit rather than being disguised as successful generation; invalid deployment configuration is reported by platform status while generation fails closed to offline topics. The status check can establish that `AI.run` exists but not that the account has GLM-5.3 billing entitlement. Provider output is materialized before its 64 KiB validation bound, and an upstream request may still finish or bill after the local timeout if it ignores cancellation.

In the local Go game's separate AI-judge path, transcription starts only after per-turn consent and only when the browser exposes `processLocally` and accepts the selected live audio track. The server receives text, not audio. `NONSTOPTALK_AI_PROVIDER=offline|anthropic|glm` selects the provider for both judging and local theme generation; explicit `offline` overrides any keys. With the selector unset, `ANTHROPIC_API_KEY` preserves legacy Anthropic auto-selection; otherwise the server stays offline, and `ZAI_API_KEY` alone does not opt in. Explicit `anthropic` requires `ANTHROPIC_API_KEY`, while explicit `glm` requires `ZAI_API_KEY` and uses GLM-4.7-Flash. Invalid selectors and selected providers without their credential emit an operator warning and fail closed to the offline heuristic. The local Go runtime does not use the Cloudflare-only `glm53` selector.

After the existing per-turn consent, an external judge receives the assigned topic and size-capped transcript, not audio or room metadata. A runtime judge failure preserves classic scoring. For local theme generation, the theme is the selected external provider's only user content; the offline path uses fixed templates, and an external runtime failure is returned to the host instead of silently switching providers.

The game session model does not contain transcripts, so they are absent from score history and persisted room snapshots. The coaching summary schema likewise excludes captured transcript text; opted-in captured text can exist only in the separate browser artifact store and may carry a partial warning. See [AI and Privacy](AI_AND_PRIVACY.md).

## Persistence and process model

Rooms are memory-resident and guarded within one process.

`cmd/web`:

- Defaults to `data/rooms.json`.
- Loads valid non-expired rooms at startup.
- Writes an atomic snapshot every 10 seconds.
- Uses `NONSTOPTALK_DATA_FILE` for a custom path.
- Accepts deprecated `DST_DATA_FILE` only as a compatibility fallback.
- Disables snapshots when the chosen value is `off`.

`cmd/desktop` does not enable snapshot persistence.

The Cloudflare edition stores each room in its own SQLite-backed Durable Object. State survives hibernation, Worker restarts, and deployments. A per-room alarm deletes storage after 30 days without a state change. Hibernatable WebSockets preserve live connections without holding JavaScript memory active while idle.

Local coaching history remains independent of both room persistence systems. It uses best-effort IndexedDB scoped to the current site origin and browser profile; full local artifacts have no automatic expiration. The optional D1 backup is a separate compact-summary store controlled by one device-level, UTC-day-bucketed anonymous inactivity lease and a new-save guard once 250 summaries exist. There is no account adoption, recovery, or cross-device sync yet.

## Embedded assets

`assets.go` uses `go:embed` for templates and the complete static directory. Both entry points construct the server from that embedded filesystem. A compiled executable therefore works without a repository-relative working directory and does not need a separate static asset deployment.

Handler tests can still construct a server from filesystem templates for focused test fixtures.

## Online deployment

`wrangler.jsonc` declares `cloudflare/worker.ts`, the `cloudflare/public` asset directory, SPA fallback, the `ROOMS` binding, D1 and Analytics Engine bindings, room-creation/general-API/model rate-limit bindings, and a `new_sqlite_classes` migration. This is a Worker-with-Assets deployment designed around free/low-cost Cloudflare primitives; it is not a Container and not a Pages-only static project.

Public routes include `/practice`, `/progress`, and rooms of the form `/room/ABC234`. Durable Objects have no separately exposed route. Practice and Progress navigation uses the static SPA fallback; only explicit compact-summary backup uses the versioned coaching API. See [Cloudflare Deployment](CLOUDFLARE_DEPLOYMENT.md), the [Web platform plan](WEB_PLATFORM_PLAN.md), and Cloudflare's [SPA routing documentation](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).

## Limits and safeguards

Current controls include:

- Same-origin checks for mutations
- 64 KiB request-body cap and explicit form parsing
- 8 KiB transcript cap
- Name, topic length, topic-count, room, and player caps
- Rate limits for creation, joins, generation, and grading
- Bounded concurrent judge work, a process-wide external-provider budget, and a 30-second judge timeout
- Host/current-speaker authorization
- Turn-generation IDs and next-turn replay guards for stale and duplicate actions
- Member-only SSE, per-member/per-room/process stream caps, and automatic gone-room handling in the Go edition
- Three-hour local room lifetime and 30-day Durable Object room retention
- Same-origin JSON mutations and WebSocket upgrades, 64 KiB bodies, per-source room-creation throttling, a general 60-requests-per-minute scoped API limiter, a dedicated five-topic-requests-per-minute `MODEL_RATE_LIMITER`, per-member socket caps, and private identity state online
- Host/setup authorization, per-generation external consent, a 200-character theme cap, independent routine/escalation enablement, and an aggregate D1 daily provider limit of 100 by default
- At most one external topic call per request, with no automatic escalation, provider retry, or Queue and a deterministic fallback on every unavailable/error path
- Explicit microphone, transcript-analysis, artifact-retention, and compact-backup boundaries; route-scoped media/recorder cleanup; no coaching-data request on the default/off path; dual-sided summary allowlists; and separate local artifact storage

These are sensible work-in-progress controls, not a formal security, privacy, measurement-validity, or fairness guarantee.

## Verification

```sh
go test ./...
go test -race ./...
go vet ./...
npm ci
npx playwright install chromium
npm run smoke
npm run typecheck:cloudflare
npm run test:cloudflare
npm run test:coach
npm run test:cloud-progress
npm run check:cloudflare
npm run smoke:multiplayer
npm run smoke:coach
```

The local Playwright suite covers manual fallback with reload/resume, mocked microphone completion, two-browser SSE play, offline AI judging, and fail-closed classic play. A separate hermetic Wrangler smoke uses two isolated browser contexts to cover the Cloudflare WebSocket room, host authorization, deterministic host scoring, Durable Object persistence across browser reconnect, and final-state convergence. Go and Cloudflare adapters both execute the versioned `testdata/game-contract.v1.json` cases for six core invariant families; endpoint-level Go tests additionally verify that rejected topic and score actions do not mutate room state or version. Cloudflare tests also cover persistence/public-state boundaries, platform routing, D1 validation/ownership/retention, relationship metadata, aggregate analytics, canonical milestone payload validation, receipt replay/conflict behavior, post-commit Analytics Engine isolation, schema-6 receipt cleanup, and the absence of receipt SQL from schema-5 cleanup. The 34 coaching tests cover the deterministic signal/retrieval engine plus relationship validation, persistence gating, safe grouping, and goal-specific comparison guardrails. The coaching smoke verifies standalone live cues, the default review-only baseline → Progress/reload/resume → retry path, local storage, artifact-only deletion, and that local-first default/off paths make no coaching-data API request; cloud-progress tests separately exercise the opt-in client and allowlist. The platform smoke confirms the relationship round trip and reserved D1 columns. Wrangler validates the deploy bundle.

## Architectural backlog

- Expand the shared cross-edition contract beyond its six current core invariant families, or generate more rules from a common source
- Cloudflare parity for AI, presets, import/export, explicit microphone selection, and sound cues
- Validation of coaching thresholds, repeatability, false-tip rate, distraction, browser/device availability, accessibility, and accent/language fairness
- Learning-outcome, repeatability, usability, and fairness validation for the implemented baseline-to-unassisted-retry comparison
- Coaching parity or a shared client strategy for the local Go edition
- User-controlled prompts/goals, stronger calibration diagnostics, a larger validated card library, and optional production semantic/LLM RAG adapters
- Accounts, cross-device authentication/progress, anonymous-record adoption, and account deletion
- Queue-backed provider execution and R2 media storage, only if later features justify their cost and consent boundaries
- A Durable Object SQLite milestone outbox, multiplexed alarm retries, dead-letter handling, and normal-room activation of the internal schema-6 receiver
- Native desktop wrapper
- Party-vote domain and UI
- Profiles and content-filter policy
- Production observability and formal security review
