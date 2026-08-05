# NonStopTalk

NonStopTalk is a work-in-progress speaking-practice product and multiplayer party game. The native Cloudflare app now includes a private speech-coaching prototype for individual rehearsal, while the original game still supports pass-and-play and online rooms for players on separate devices.

The playable game and a demonstrable coaching prototype exist today. The project is still being validated and hardened; the [roadmap](docs/ROADMAP.md) separates implemented work, prototype claims, and future ideas.

## Implemented now

- A Cloudflare-SPA coaching prototype at `/practice`: 30–90 second interview, presentation, or impromptu attempts; microphone calibration; browser-side audio measurements; sparse deterministic live tips; and evidence-based review
- A small local RAG layer: goal/evidence queries lexically retrieve curated in-app coaching cards; normally the top card supplies an intact base drill, but an evidence-safety rule can use the measured priority's drill instead when the card is unsupported. The review distinguishes used guidance from context-only retrieval, with no LLM, free-form model prose, embeddings, vector database, or network call
- Optional pace and word-pattern estimates only when the user consents and the browser supports strict on-device speech recognition; the summary retains derived filler/repetition patterns, while captured transcript text is discarded by default
- Origin-local coaching summaries, JSON export, and deletion at `/progress` through IndexedDB in the current browser profile
- A separate, off-by-default retention choice that can keep the attempt recording and any locally captured transcript in the same origin-local IndexedDB database; recognition gets up to two seconds to flush at finish, and a timeout or error after text was captured preserves it but marks it as possibly partial in Review and Progress. JSON export excludes these artifacts, and deletion clears both stores
- Six-character rooms with a host, remote seats, browser-based reconnect, live updates (SSE in the local Go app and hibernatable WebSockets online), host transfer, and takeover after a short absence grace period
- Local pass-and-play and remote turns in the same room
- Player add, rename, remove, and reorder controls
- Configurable 10–300 second turns, 1–10 second silence limits, and 1–10 rounds
- Five built-in topic packs plus custom lists; the local Go edition also has import/export, offline or Anthropic-assisted theme generation, and device-local saved presets
- A shuffled topic deck that uses every available topic before repeating; with more than one topic, a new cycle does not immediately repeat the previous draw
- Local voice-activity and silence detection plus a manual timer fallback; the Go edition also has microphone selection and sound cues
- Classic scoring, score explanations, host adjustments, standings, winner view, and the last 20 finished games in each room; optional AI relevance bonuses are available in the local Go edition
- Periodic JSON room snapshots locally and SQLite-backed Durable Object room persistence online

## Privacy and AI

Classic play does not require an account, an API key, transcription, or audio upload. The browser uses its microphone locally for voice-activity detection. The coaching prototype similarly processes microphone frames in the browser and makes no coaching API call. It does not upload coaching audio or transcripts. Attempt-recording/captured-transcript retention is a separate, off-by-default local-storage option; without it, audio is reduced to measurements and captured transcript text is discarded.

The free Cloudflare multiplayer game remains classic-only and calls no AI provider. Its separate coaching path may create a transcript only after explicit consent and only when the browser supports mandatory on-device recognition. Derived filler/repetition patterns are saved with its compact summary. By default captured transcript text is discarded; if the user separately enables full-session retention, the recording and available captured transcript are stored only for that site origin and browser profile. A finalization warning is persisted and shown whenever retained text may be partial. Coaching-card retrieval and deterministic review assembly also stay in the browser. The following AI-judge behavior belongs to the local Go game edition.

The AI judge is opt-in at two levels: the host enables it for the room, then the current speaker chooses whether to use transcription for that turn. Transcription starts only when the browser exposes `SpeechRecognition` with `processLocally` support and accepts the selected live microphone track. If any of those checks fail, the turn continues with classic scoring or the manual timer.

When a speaker consents, the resulting text transcript is submitted to the NonStopTalk server with that turn. The transcript is used for grading and is not stored in room history or JSON snapshots.

- With `ANTHROPIC_API_KEY` configured, the server sends the topic and transcript to Anthropic for relevance grading. Theme generation sends only the host's theme.
- Without the key, grading and theme generation use deterministic local heuristics on the server; no external AI provider is contacted.
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
npm run deploy
```

No Docker engine, Container subscription, or static build-output setting is required. The public routes include `/`, `/practice`, `/progress`, and `/room/ABC123`; the Durable Object binding is internal and has no separate public URL. Coaching pages are static SPA routes and never put coaching summaries, recordings, or transcripts into the room object. See [Cloudflare Deployment](docs/CLOUDFLARE_DEPLOYMENT.md) for the free-tier limits, dashboard settings, local Worker development, and custom-domain routing.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Web server port. A value with or without a leading colon is accepted. |
| `NONSTOPTALK_DATA_FILE` | `data/rooms.json` | Local JSON snapshot path. Set to `off` for memory-only rooms. |
| `DST_DATA_FILE` | unset | Deprecated compatibility fallback used only when `NONSTOPTALK_DATA_FILE` is not set. |
| `ANTHROPIC_API_KEY` | unset | Enables Anthropic relevance grading and topic generation. Without it, server-side offline heuristics are used. |
| `NONSTOPTALK_TRUST_CLOUDFLARE_IP` | `false` | For the local Go server only: trust `CF-Connecting-IP` for rate limiting when an operator has placed the server behind a trusted Cloudflare proxy. |

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
npm run check:cloudflare
npm run smoke:coach
```

`test:coach` runs 21 deterministic measurement, continuity, transcript-analysis, retrieval, grounding-safety, and advice tests without a microphone. `smoke:coach` drives the Cloudflare SPA with synthetic media; it proves a default-off attempt never constructs `MediaRecorder` or creates an artifact, exercises a v1→v2 storage upgrade, verifies opted-in recording/transcript and real downloads, preserves captured text with a partial-transcript warning after a late recognition error, checks JSON artifact exclusion and two-store deletion, renders a voice/quiet timeline, moves focus after SPA navigation, cleans up canceled permission/worklet work, handles active/calibration stalls, and makes no application `/api/*` request.

## Architecture

- Go `net/http` server and domain packages for local/self-hosted play
- Embedded Go templates and static assets
- Official HTMX 2.0.10 vendored for server-rendered interactions
- Vanilla JavaScript for microphone selection, Web Audio voice activity, on-device speech recognition, timers, presets, and SSE refreshes
- In-memory Go room manager with optional periodic JSON snapshots
- Anthropic Go SDK behind a small judge/topic-generator interface
- Native TypeScript Worker, Workers Static Assets, and one SQLite-backed Durable Object per online room
- Hibernatable WebSockets for cost-efficient online synchronization
- Browser `AudioWorklet` (with an `AnalyserNode` compatibility fallback) for coaching signal reduction, plus deterministic analysis and local lexical coaching-card retrieval
- Origin-scoped IndexedDB v2 for compact coaching summaries and a separate, explicitly opted-in recording/captured-transcript store; exports exclude those artifacts and local deletion clears both stores
- Playwright browser smoke coverage plus Go unit and handler tests

There is no frontend build step for local play.

## Explicit future backlog

These ideas are not presented as current features:

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- A packaged native desktop wrapper
- User profiles
- Family/content filters
- Post-turn AI summaries
- Full multiplayer-game feature parity between the local Go and free Cloudflare editions (AI judge, saved presets, import/export, microphone picker, and sound cues)
- Validated baseline-to-unassisted-retry coaching comparisons
- Coaching accuracy, usability, accessibility, and accent/language fairness validation across browsers and microphones
- Guided programs, accounts, cross-device progress, educator tools, and optional semantic coaching

## Documents

- [Product Context](PRODUCT.md)
- [Design Direction](DESIGN.md)
- [Game Design](docs/GAME_DESIGN.md)
- [Requirements and Status](docs/REQUIREMENTS.md)
- [Technical Architecture](docs/TECHNICAL_ARCHITECTURE.md)
- [Historical Web Version Plan](docs/WEB_VERSION_PLAN.md)
- [Desktop Application](docs/DESKTOP_APPLICATION.md)
- [Roadmap](docs/ROADMAP.md)
- [AI and Privacy](docs/AI_AND_PRIVACY.md)
- [Cloudflare Deployment](docs/CLOUDFLARE_DEPLOYMENT.md)
- [Speech Coaching Prototype](docs/SPEECH_COACHING_PROTOTYPE.md)
- [Coaching Presentation Guide](docs/COACHING_PRESENTATION_GUIDE.md)
