# NonStopTalk

NonStopTalk is a work-in-progress multiplayer party game about speaking on a surprise topic without pausing for too long. It supports pass-and-play on one device and online rooms for players on separate devices.

The playable core exists today. The project is still being hardened, and the [roadmap](docs/ROADMAP.md) separates implemented features from future ideas.

## Implemented now

- Six-character rooms with a host, remote seats, browser-based reconnect, live updates (SSE in the local Go app and hibernatable WebSockets online), host transfer, and takeover after the host has been absent for 30 seconds
- Local pass-and-play and remote turns in the same room
- Player add, rename, remove, and reorder controls
- Configurable 10–300 second turns, 1–10 second silence limits, and 1–10 rounds
- Five built-in topic packs plus custom lists; the local Go edition also has import/export, offline or Anthropic-assisted theme generation, and device-local saved presets
- A shuffled topic deck that uses every available topic before repeating; with more than one topic, a new cycle does not immediately repeat the previous draw
- Local voice-activity and silence detection plus a manual timer fallback; the Go edition also has microphone selection and sound cues
- Classic scoring, score explanations, host adjustments, standings, winner view, and the last 20 finished games in each room; optional AI relevance bonuses are available in the local Go edition
- Periodic JSON room snapshots locally and SQLite-backed Durable Object room persistence online

## Privacy and AI

Classic play does not require an account, an API key, transcription, or audio upload. The browser uses its microphone locally for voice-activity detection. NonStopTalk does not upload or persist microphone audio.

The free Cloudflare edition is classic-only: it does not transcribe speech or call an AI provider. The following optional AI behavior belongs to the local Go edition.

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

No Docker engine, Container subscription, or static build-output setting is required. The public routes are `/` and `/room/ABC123`; the Durable Object binding is internal and has no separate public URL. See [Cloudflare Deployment](docs/CLOUDFLARE_DEPLOYMENT.md) for the free-tier limits, dashboard settings, local Worker development, and custom-domain routing.

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
npm run test:cloudflare
npm run check:cloudflare
```

## Architecture

- Go `net/http` server and domain packages for local/self-hosted play
- Embedded Go templates and static assets
- Official HTMX 2.0.10 vendored for server-rendered interactions
- Vanilla JavaScript for microphone selection, Web Audio voice activity, on-device speech recognition, timers, presets, and SSE refreshes
- In-memory Go room manager with optional periodic JSON snapshots
- Anthropic Go SDK behind a small judge/topic-generator interface
- Native TypeScript Worker, Workers Static Assets, and one SQLite-backed Durable Object per online room
- Hibernatable WebSockets for cost-efficient online synchronization
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
- Full feature parity between the local Go and free Cloudflare editions (AI judge, saved presets, import/export, microphone picker, and sound cues)

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
