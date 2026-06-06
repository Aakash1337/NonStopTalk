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

The smoke test starts its own Go server on a temporary port, drives a full local game in a browser, verifies the mic-denied manual timer fallback, and checks the winner screen.
