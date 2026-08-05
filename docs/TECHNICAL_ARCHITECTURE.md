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
                                                             └─ offline judge or Anthropic

online browser SPA
  ├─ static HTML/CSS/JS ───────────────────────> Workers Static Assets
  ├─ JSON actions ─────────────────────────────> Worker /api/* router
  └─ hibernatable WebSocket updates ───────────> room Durable Object
                                                        └─ private SQLite state

online browser coaching path (/practice and /progress)
  ├─ microphone ─> AudioWorklet ─> objective measurement frames ─┐
  ├─ optional strict on-device SpeechRecognition ─> word patterns┤
  ├─ optional MediaRecorder ─> full artifact store                ┤
  └─ goal + evidence ─> local lexical coaching-card retrieval     │
                         └─ retrieved drill + deterministic assembly│
                               └─ IndexedDB v2 ─────────────────────┘
                                  ├─ session-summaries
                                  └─ session-artifacts (opt-in)
       (no coaching API, Durable Object, audio upload, or transcript upload)
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
- External AI: Anthropic Go SDK behind judge and topic-generator interfaces
- Tests: Go unit/handler/race/vet checks and Playwright browser smoke flows
- Free online runtime: Workers Static Assets, a TypeScript fetch router, SQLite-backed Durable Objects, and hibernatable WebSockets
- Cloudflare rule tests: Node's test runner through `tsx`, plus a Wrangler deploy dry run
- Coaching state: ephemeral browser objects plus IndexedDB v2 summary and opt-in artifact stores
- Coaching knowledge: curated in-app cards with local lexical retrieval and deterministic template assembly; no LLM, open-ended prose synthesis, embeddings, or vector database
- Coaching verification: 20 Node tests for the deterministic engine and a Playwright SPA smoke flow with synthetic media, no-`/api` assertion, default-off/opted-in storage, v1→v2 migration, real downloads/export, focus checks, cancellation races, and stalled-input handling

There is no SPA framework, frontend bundler, account system, server-side coaching service, or server-side audio pipeline. The online edition uses browser-native modules and Durable Object SQLite/WebSockets; the Go edition does not.

## Repository layout

```text
assets.go                         embedded template/static filesystem
cmd/web/                          normal HTTP server entry point
cmd/desktop/                      loopback server + default-browser launcher
internal/game/                    session, turn deck/progression, scoring, history
internal/judge/                   offline and Anthropic grading/topic generation
internal/room/                    synchronized rooms, identity, presence, SSE signals,
                                  server clock, persistence
internal/topics/                  built-in topic packs
internal/web/handlers/            routing, authorization, validation, rendering
internal/web/templates/           full-page and swappable HTML templates
web/static/css/                   UI styles
web/static/js/                    HTMX and focused browser modules
scripts/smoke-local.mjs           Playwright end-to-end smoke suite
cloudflare/game.ts                native online classic-game rules
cloudflare/worker.ts              Worker router + SQLite-backed room object
cloudflare/routes.ts              public API route parser
cloudflare/public/app.js          online SPA routing, game UI, coaching lifecycle,
                                  IndexedDB summaries/artifacts, downloads, and review
cloudflare/public/app.css         shared Play, Practice, and Progress visual system
cloudflare/public/coach-engine.js deterministic audio aggregation, tips, transcript
                                  counts, curated-card retrieval, grounding, advice,
                                  and summary calculations
cloudflare/public/coach-audio-worklet.js
                                  ~100 ms microphone RMS/peak reduction
cloudflare/public/coach-engine.test.js
                                  deterministic coaching-engine coverage
cloudflare/*.test.ts              native Worker rule/route tests
scripts/smoke-coach.mjs           synthetic-microphone coaching browser flow
wrangler.jsonc                    Static Assets and Durable Object configuration
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
- Selection of an offline or Anthropic provider

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

Static navigation paths such as `/`, `/practice`, `/progress`, and `/room/ABC123` are served by Workers Static Assets with SPA fallback. The online multiplayer game performs microphone voice-activity analysis locally and remains classic-only. The separate coaching route can create an explicitly consented transcript only through strict on-device browser recognition; it never calls Anthropic or sends that text, a recording, or its summaries to the Worker. Full transcript/recording retention is a second local-only consent boundary.

### Browser coaching prototype

`cloudflare/public/app.js` owns the Practice and Progress route state machine:

```text
setup → microphone permission → quiet calibration → voice calibration
      → active attempt → finishing → review
```

Setup chooses one of three scenarios, one focus goal, a 30/45/60/90-second duration, optional local transcript analysis, and optional full-session retention. Both options start unchecked on a fresh page load and are independent: transcript analysis controls derived pace/word-pattern evidence; full-session retention controls an encoded attempt recording and whatever captured transcript is available. **Try again** preserves the visible setup selections for the next attempt, so the user can review or uncheck them. The retention control is disabled without `MediaRecorder`. Calibration collects approximately two seconds of quiet frames and two seconds of normal-speaking frames. It derives a session-specific threshold instead of treating one absolute amplitude as universal.

The preferred signal path is:

1. `getUserMedia` opens one audio `MediaStream` with echo cancellation and noise suppression requested and automatic gain control disabled.
2. `AudioContext.createMediaStreamSource` adds the stream to a Web Audio graph.
3. `audioWorklet.addModule("/coach-audio-worklet.js")` loads `CoachingMeterProcessor`.
4. The worklet mixes input channels, accumulates squared sample energy and absolute peak, and posts one compact frame approximately every 100 ms.
5. `CoachingAnalyzer` classifies frames using the derived calibration, accumulates voice/silence/unknown segments and objective metrics, and exposes snapshots. A level frame is held for at most 250 ms; any longer callback remainder becomes unknown rather than invented voice, silence, or clipping. With zero callbacks, the entire elapsed attempt is unknown with zero signal coverage/confidence and input-recovery advice.
6. `CoachingTipPolicy` evaluates those snapshots. The UI does not consider a tip during the first five seconds, enforces a ten-second gap between displayed tips, shows one cue for five seconds, and clears it before another cue.
7. The selected goal and measured evidence form a lexical query over curated coaching cards bundled in `coach-engine.js`.
8. `buildAdvice` starts with the highest-ranked card's prewritten drill and deterministically appends one priority-specific comparison sentence. It exposes the card's provenance; separate rules select the strength, focus, and measured evidence.

This is labeled a small **retrieval-augmented deterministic generation** pipeline. “Generation” is bounded template assembly: the retrieved card drill remains intact and a fixed comparison sentence selected by the top measurement priority is appended. It uses the RAG pattern—retrieve context, then use it in an output—without an LLM, open-ended prose synthesis, embedding model, vector database, remote corpus, or network call. That boundary keeps the prototype no-cost, low-latency, private, auditable, and deterministic. A production LLM RAG layer would add semantic retrieval and flexible language generation, but also provider/model behavior, cost, latency, consent, source governance, prompt-injection defenses, and broader evaluation.

If the worklet cannot be loaded, an `AnalyserNode` reads `Float32` time-domain frames every 100 ms and produces the same RMS/peak input shape. Both paths stay in the browser. The fallback is a compatibility path, not evidence that every browser/device combination has been validated.

Optional transcript assistance creates `SpeechRecognition`, requires its `processLocally` property, sets that property to `true`, and supplies the current microphone track. Transcript text is limited to 20,000 characters in memory. Recognition failure merely removes transcript metrics; it never selects a remote mode. The default summary keeps aggregate pace/counts plus bounded filler/repeated-word pattern arrays (up to 50 entries per array and 64 characters per label) after transcript consent. The full transcript is then cleared unless full-session retention was separately selected.

Finishing writes to IndexedDB database `nonstoptalk-coaching`, version 2. Every completed saved attempt puts an allowlisted record in `session-summaries`: schema version, ID/time, scenario, goal, target duration, observed/unknown/coverage measurements, other aggregate measurements, optional transcript counts/patterns, normalized advice, and artifact metadata. It excludes segments, per-frame values, grounding details, audio payloads, and the full transcript. If full-session retention was selected and a recording or transcript was captured, the same read/write transaction also puts an ID-linked record in `session-artifacts` containing the encoded audio `Blob`, MIME type, captured transcript, and creation time.

`/progress` reads only summaries for its history view. JSON export serializes the summary store—including derived word patterns and artifact-presence metadata—but never the artifact `Blob` or full transcript. Per-attempt buttons read the artifact store and download the recording in its supported media extension or the transcript as UTF-8 text. Confirmed deletion clears both object stores. There is no automatic artifact expiration or per-attempt deletion in this prototype.

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

The coaching path calls no server-side judge. Goal/evidence queries retrieve a curated card locally; deterministic assembly combines its unchanged drill with a metric-specific comparison sentence, while separate rules select review strength/focus and the source remains visible. Optional transcript analysis saves aggregate counts and derived filler/repetition patterns in the summary. The full text is cleared by default or stored only in the separate local artifact store after the second consent.

In the local Go game's separate AI-judge path, transcription starts only after per-turn consent and only when the browser exposes `processLocally` and accepts the selected live audio track. The server receives text, not audio.

- No `ANTHROPIC_API_KEY`: the server grades topic/transcript overlap locally and generates themes from templates.
- Key configured: Anthropic receives topic + transcript for grading or the theme alone for topic generation.

The game session model does not contain transcripts, so they are absent from score history and persisted room snapshots. The coaching summary schema likewise excludes the full transcript; an opted-in full transcript can exist only in the separate browser artifact store. See [AI and Privacy](AI_AND_PRIVACY.md).

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

Coaching history is independent of both server persistence systems. It uses best-effort IndexedDB scoped to the current site origin and browser profile. The in-app action clears that origin's summary and artifact stores; site-data deletion, private browsing, or storage pressure may also remove them. Full artifacts otherwise have no prototype expiration timer. There is no automatic server retention, account sync, or cloud backup.

## Embedded assets

`assets.go` uses `go:embed` for templates and the complete static directory. Both entry points construct the server from that embedded filesystem. A compiled executable therefore works without a repository-relative working directory and does not need a separate static asset deployment.

Handler tests can still construct a server from filesystem templates for focused test fixtures.

## Online deployment

`wrangler.jsonc` declares `cloudflare/worker.ts`, the `cloudflare/public` asset directory, SPA fallback, the `ROOMS` binding, a room-creation rate limiter, and a `new_sqlite_classes` migration. This is a Worker-with-Assets deployment supported by Workers Free; it is not a Container and not a Pages-only static project.

Public routes include `/practice`, `/progress`, and rooms of the form `/room/ABC123`. Durable Objects have no separately exposed route: `/api/*` reaches the Worker, which forwards room operations through its internal binding. Practice and Progress navigation uses the static SPA fallback and does not invoke a coaching API. See [Cloudflare Deployment](CLOUDFLARE_DEPLOYMENT.md) and Cloudflare's [SPA routing documentation](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).

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
- Same-origin JSON mutations and WebSocket upgrades, 64 KiB bodies, per-source room-creation throttling, per-member socket caps, and private identity state online
- Explicit microphone, transcript-analysis, and full-artifact-retention boundaries; route-scoped media/recorder cleanup; no coaching `fetch` path; allowlisted summary and separate artifact schemas; and confirmed two-store deletion

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
npm run check:cloudflare
npm run smoke:coach
```

The local Playwright suite covers manual fallback with reload/resume, mocked microphone completion, two-browser SSE play, offline AI judging with a selected local audio track, and fail-closed classic play when local recognition is unavailable. Go unit tests cover game/scoring/topic behavior, room concurrency/persistence, provider parsing, and HTTP authorization/flows. Cloudflare tests cover the mirrored classic-game rules, replay protection, persistence-safe state, public-state redaction, and API route parsing. The 20 coaching unit tests cover deterministic calibration, segmentation—including zero-callback attempts with zero coverage—observed/unknown time, continuity confidence, metrics, tip selection, transcript aggregation, lexical card retrieval/grounding, deterministic drill assembly, and advice. The coaching smoke uses synthetic media to verify a default-off attempt creates no recorder/artifact, v1 history upgrades to both v2 stores, an opted-in `Blob`/transcript persists, actual recording/transcript downloads contain data, JSON export excludes full artifacts, Progress survives reload, focus moves, both stores delete, permission/worklet cancellation cleans up, active/calibration stalls fail safely, and no application `/api` request occurs. Wrangler validates the deploy bundle.

## Architectural backlog

- Shared rule generation or stronger parity checks between the Go and TypeScript editions
- Cloudflare parity for AI, presets, import/export, explicit microphone selection, and sound cues
- Validation of coaching thresholds, repeatability, false-tip rate, distraction, browser/device availability, accessibility, and accent/language fairness
- Explicit baseline-to-unassisted-retry pairing and goal-specific progress comparison
- Coaching parity or a shared client strategy for the local Go edition
- User-controlled prompts/goals, stronger calibration diagnostics, a larger validated card library, and optional production semantic/LLM RAG adapters
- Native desktop wrapper
- Party-vote domain and UI
- Profiles and content-filter policy
- Production observability and formal security review
