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
```

There are two runtime editions. The richer local/self-hosted edition is one Go application shared by the normal web and desktop-style launchers. The free online edition is a native TypeScript Worker with a separately tested implementation of the core classic-game rules.

## Current stack

- Backend and routing: Go 1.26, `net/http`, and Go's method-aware `ServeMux`
- Rendering: embedded `html/template` files
- Server-rendered interaction: official HTMX 2.0.10 vendored in `web/static/js/htmx.min.js`
- Browser logic: vanilla JavaScript
- Microphone analysis: `getUserMedia` and Web Audio
- Optional transcription: browser `SpeechRecognition` only when `processLocally` is supported
- Real-time updates: Server-Sent Events, followed by HTMX partial fetches
- State: in-memory rooms and optional periodic JSON snapshots
- External AI: Anthropic Go SDK behind judge and topic-generator interfaces
- Tests: Go unit/handler/race/vet checks and Playwright browser smoke flows
- Free online runtime: Workers Static Assets, a TypeScript fetch router, SQLite-backed Durable Objects, and hibernatable WebSockets
- Cloudflare rule tests: Node's test runner through `tsx`, plus a Wrangler deploy dry run

There is no SPA framework, frontend bundler, account system, or server-side audio pipeline. The online edition uses browser-native modules and Durable Object SQLite/WebSockets; the Go edition does not.

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
cloudflare/public/                online SPA assets
cloudflare/*.test.ts              native Worker rule/route tests
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

Static navigation paths such as `/` and `/room/ABC123` are served by Workers Static Assets with SPA fallback. The online edition performs microphone voice-activity analysis locally and is classic-only; it does not call Anthropic or create transcripts.

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

The microphone stream stays in the browser. Web Audio analyzes it without uploading it.

AI transcription starts only after per-turn consent and only when the browser exposes `processLocally` and accepts the selected live audio track. The server receives text, not audio.

- No `ANTHROPIC_API_KEY`: the server grades topic/transcript overlap locally and generates themes from templates.
- Key configured: Anthropic receives topic + transcript for grading or the theme alone for topic generation.

The session model does not contain transcripts, so they are absent from score history and persisted room snapshots. See [AI and Privacy](AI_AND_PRIVACY.md).

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

## Embedded assets

`assets.go` uses `go:embed` for templates and the complete static directory. Both entry points construct the server from that embedded filesystem. A compiled executable therefore works without a repository-relative working directory and does not need a separate static asset deployment.

Handler tests can still construct a server from filesystem templates for focused test fixtures.

## Online deployment

`wrangler.jsonc` declares `cloudflare/worker.ts`, the `cloudflare/public` asset directory, the `ROOMS` binding, a room-creation rate limiter, and a `new_sqlite_classes` migration. This is a Worker-with-Assets deployment supported by Workers Free; it is not a Container and not a Pages-only static project.

Public room URLs keep the form `/room/ABC123`. Durable Objects have no separately exposed route: `/api/*` reaches the Worker, which forwards room operations through its internal binding. See [Cloudflare Deployment](CLOUDFLARE_DEPLOYMENT.md).

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

These are sensible work-in-progress controls, not a formal security guarantee.

## Verification

```sh
go test ./...
go test -race ./...
go vet ./...
npm ci
npx playwright install chromium
npm run smoke
npm run test:cloudflare
npm run check:cloudflare
```

The Playwright suite covers manual fallback with reload/resume, mocked microphone completion, two-browser SSE play, offline AI judging with a selected local audio track, and fail-closed classic play when local recognition is unavailable. Go unit tests cover game/scoring/topic behavior, room concurrency/persistence, provider parsing, and HTTP authorization/flows. Cloudflare tests cover the mirrored classic-game rules, replay protection, persistence-safe state, public-state redaction, and API route parsing; Wrangler validates the deploy bundle.

## Architectural backlog

- Shared rule generation or stronger parity checks between the Go and TypeScript editions
- Cloudflare parity for AI, presets, import/export, explicit microphone selection, and sound cues
- Native desktop wrapper
- Party-vote domain and UI
- Profiles and content-filter policy
- Production observability and formal security review
