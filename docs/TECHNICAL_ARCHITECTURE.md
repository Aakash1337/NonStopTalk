# Technical Architecture

## Recommended Stack

Preferred web-first stack:

- Backend: Go
- Routing: Go `net/http` with a small router if needed
- Rendering: Go templates
- Interactions: HTMX
- Styling: token-based CSS
- Browser-only behavior: small vanilla JavaScript modules
- Audio: Web Audio API
- Testing: Go tests, browser-level Playwright tests, targeted JavaScript unit tests only if the client logic grows
- Future real-time transport: WebSocket or Server-Sent Events
- Future storage: SQLite first, Postgres if online rooms need managed persistence

## Repository Shape

Recommended structure once implementation starts:

```text
cmd/
  web/
    main.go
internal/
  game/
  topics/
  scoring/
  rooms/
  web/
    handlers/
    templates/
    viewmodels/
web/
  static/
    css/
    js/
docs/
```

The MVP can start as one Go web app with in-memory game state and browser-side audio detection. Split storage, online rooms, and AI providers into separate packages when those features arrive.

## Core Domains

### Game Engine

Pure Go logic for:

- Player management
- Topic deck selection
- Turn sequencing
- Timer state
- Scoring
- Winner calculation

This should avoid HTTP and browser APIs so it can be tested directly.

### Web Layer

The Go web layer should handle:

- Rendering full pages
- Rendering HTMX partials
- Validating setup forms
- Applying host actions
- Returning updated player lists, settings panels, scoreboards, and turn summaries

Templates should receive view models rather than raw domain structs when the UI needs formatted values.

### Audio Detection

Browser-side audio module for:

- Microphone permission flow
- Input device selection later
- Voice activity detection
- Silence duration tracking
- Calibration threshold later

For MVP, use volume threshold detection with smoothing. Add calibration once the loop is playable.

HTMX is not responsible for audio detection. A small JavaScript module should publish turn events such as `speech-started`, `silence-warning`, `turn-completed`, and `turn-eliminated`. HTMX can then submit turn results back to the Go server.

### Topic System

Topic pack model:

```go
type TopicPack struct {
	ID          string
	Name        string
	Description string
	Tags        []string
	Topics      []string
}
```

Custom topics can start in server memory or browser local storage. Use SQLite once saved custom packs are needed.

### Scoring

Scoring should be implemented as a replaceable strategy:

```go
type ScoreInput struct {
	DurationSeconds int
	SpokenSeconds   int
	Completed       bool
	AIRelevanceScore *float64
	VoteBonus       int
}
```

This keeps Classic, AI Judge, and Party Vote modes from becoming tangled.

## Future Online Multiplayer

Online play should use a server-authoritative room model.

Server responsibilities:

- Room creation
- Player presence
- Host authority
- Turn state synchronization
- Score persistence within a room
- Reconnect handling

Transport options:

- HTMX for normal host actions and setup screens
- Server-Sent Events for one-way room state updates
- WebSocket when bidirectional real-time events become necessary

Client responsibilities:

- Render current room state
- Capture local host actions
- Capture microphone state for the active player when supported

## Future AI Architecture

AI mode should be provider-based:

```go
type TranscriptionProvider interface {
	Transcribe(ctx context.Context, input AudioInput) (TranscriptResult, error)
}

type GradingProvider interface {
	Grade(ctx context.Context, input GradingInput) (GradingResult, error)
}
```

Keep audio recording, transcription, and grading separate. This lets the game use different providers later without rewriting game rules.

## Testing Strategy

Unit tests:

- Scoring
- Turn progression
- Topic deck behavior
- Winner calculation
- HTTP handlers for setup, turns, and scoring

Template tests:

- Setup screen rendering
- Turn screen rendering
- Scoreboard rendering
- HTMX partial responses

Browser tests:

- Start local game
- Complete a turn
- End a turn manually
- Show winner

Manual tests:

- Microphone permission accepted
- Microphone permission denied
- Noisy room simulation
- Host override flow

