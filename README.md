# Don't Stop Talking

Don't Stop Talking is a multiplayer party game where players take turns speaking about random topics without pausing. It supports local pass-and-play first, then online rooms, custom topic packs, and optional AI-assisted speech relevance scoring.

## Core Idea

On each turn, a player receives a topic and must speak continuously for a configured duration. If they stop speaking for longer than the silence timeout, their turn ends. Each player gets turns across one or more rounds, and the player with the highest score wins.

Default settings:

- Speaking duration: 60 seconds
- Silence timeout: 2 seconds
- Rounds: 1
- Play style: local multiplayer

## MVP Scope

The first playable version should be a web app focused on local multiplayer:

- Add and reorder players
- Pick preset or custom topics
- Configure timer, silence timeout, and rounds
- Detect speech and silence through the browser microphone
- Run each turn with clear host controls
- Score every turn
- Show round standings and final winner

## Online Rooms

Every game runs in a room with a six-character join code:

- The host creates a room, optionally taking a seat, and controls settings, topics, pacing, and score overrides.
- Remote players join with the code, get their own seat bound to their browser, and see the game update live over Server-Sent Events.
- Pass-and-play still works: local seats the host adds run from the host's screen.
- The current speaker runs the mic on their own device; the server keeps its own turn clock, so remote players cannot claim more speaking time than the server observed.
- Reconnecting is automatic: rejoin with the same browser and you keep your seat.

Protections: same-origin checks on all state changes, per-IP rate limits on room create/join, capped request bodies, name/topic length limits, room and seat caps, and idle-room cleanup.

## AI Judge Mode (optional)

The host can enable an AI judge in game settings. When on:

- The current speaker's browser transcribes their words with the Web Speech API. Audio never leaves the device; only the transcript of the current turn is submitted with the turn.
- The server asks Claude (model `claude-opus-4-8`) how relevant the speech was to the topic and applies a bonus of up to 20 points, with a short explanation shown on the score screen.
- Grading is asynchronous and best-effort: classic scoring always lands first, and a judge failure just means no bonus. The host can override any score.
- Without an `ANTHROPIC_API_KEY`, a transparent offline keyword-overlap judge is used instead, so the mode stays playable and testable everywhere.

The host can also generate a themed topic pack: type a theme (for example "road trips with dragons") and Claude writes ten speaking prompts into the editable custom list. Only the theme text is sent to the provider; without an API key, simple offline templates are used instead.

Run with the AI judge backed by Claude:

```text
ANTHROPIC_API_KEY=sk-ant-... go run ./cmd/web
```

See [AI and Privacy](docs/AI_AND_PRIVACY.md) for the consent and data-handling rules this implements.

## Preferred Web Stack

The preferred implementation path is a Go web application using HTMX for server-rendered interactions.

- Backend: Go
- Rendering: Go templates
- UI interactions: HTMX
- Browser-only behavior: small vanilla JavaScript modules for microphone access, voice activity, and precise timers
- Future online play: Go server with WebSocket or Server-Sent Events room updates

HTMX can cover setup forms, player lists, topic selection, scoreboards, and host actions. Microphone detection still requires browser JavaScript because server-rendered HTML cannot directly access the user's audio input.

## Future Scope

- Online room codes
- Real-time multiplayer
- AI transcription and topic relevance grading
- Party voting
- Topic pack sharing
- Accessibility and family-safe content filters
- Saved game presets

## Documents

- [Product Context](PRODUCT.md)
- [Design Direction](DESIGN.md)
- [Game Design](docs/GAME_DESIGN.md)
- [Requirements](docs/REQUIREMENTS.md)
- [Technical Architecture](docs/TECHNICAL_ARCHITECTURE.md)
- [Web Version Plan](docs/WEB_VERSION_PLAN.md)
- [Desktop Application](docs/DESKTOP_APPLICATION.md)
- [Roadmap](docs/ROADMAP.md)
- [AI and Privacy](docs/AI_AND_PRIVACY.md)

## Run the Desktop Version

```text
go run ./cmd/desktop
```

This starts a local Go server and opens the game in your browser as the first desktop target.

## Run the Web Server

```text
go run ./cmd/web
```

Then open `http://localhost:8080`.

Set `PORT` to run the server on a different port:

```text
$env:PORT=8081; go run ./cmd/web
```

## Test

Run Go tests:

```text
go test ./...
```

Run the local browser smoke test:

```text
npm.cmd install
npm.cmd run smoke
```

The smoke test starts its own Go server on a temporary port and drives three full games in a browser: a pass-and-play game with the mic-denied manual timer fallback, an automatic-ending game with a mocked microphone, and a two-browser remote room game joined by code and synced over Server-Sent Events.

If the Playwright-managed browser is not installed, point the smoke test at an existing Chromium binary:

```text
SMOKE_CHROMIUM=/path/to/chromium npm run smoke
```
