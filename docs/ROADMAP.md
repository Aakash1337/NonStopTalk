# Roadmap

## Phase 1: Web Local Playable MVP

Goal: Make the Go + HTMX web version fun and complete without online multiplayer or AI.

Deliverables:

- Go web project scaffold
- Go templates and HTMX partials
- Static CSS tokens
- Small browser JavaScript module for microphone and timer behavior
- Local player setup
- Game settings
- Preset topic packs
- Custom topic list
- Turn screen
- Microphone permission flow
- Basic voice and silence detection
- Classic scoring
- Scoreboard
- Winner screen
- Host override controls

Exit criteria:

- Two or more people can play a full local game.
- The app can recover from bad microphone detection through host controls.
- Scores are understandable.
- The app runs locally from a Go server.

## Phase 2: Game Feel and Content

Goal: Make repeated local play more polished.

Deliverables:

- More topic packs
- Topic difficulty tags
- Saved custom topic lists
- Sound cues
- Better timer pressure states
- Mobile layout pass
- Keyboard accessibility pass
- Reduced motion support

Exit criteria:

- A host can set up a game quickly on laptop or mobile.
- The game has enough topic variety for replay.

## Phase 3: Online Multiplayer

Goal: Support remote players through rooms.

Status: core delivered — rooms with join codes, host-gated controls, join/leave/reconnect, SSE-synced state, a server-side turn clock capping remote score claims, and abuse protections (origin checks, rate limits, input and capacity caps, idle-room cleanup). Remaining: host migration if the host disappears, and persistence across server restarts.

Deliverables:

- Room codes
- Host controls over room state
- Player join and leave
- Reconnect handling
- Synced turn state
- Server-authoritative scoring
- Server-Sent Events or WebSocket transport
- Basic abuse prevention

Exit criteria:

- Players on separate devices can complete a full game.
- Host controls remain clear.

## Phase 4: AI Judge Mode

Goal: Add optional relevance grading without making AI mandatory.

Status: core delivered — host-toggled AI judge with explicit consent copy, browser-side transcription (Web Speech API, no audio upload), Claude-backed relevance grading applied asynchronously as a capped bonus with plain-language feedback, an offline heuristic fallback when no API key is configured, host score override, and AI topic-pack generation from a host-supplied theme (offline template fallback included). Remaining: repetition detection and confidence display.

Deliverables:

- Audio recording per turn
- Transcription provider
- Relevance grading provider
- AI scoring modifier
- Explainable feedback
- Consent and privacy messaging
- Host override

Exit criteria:

- AI mode can grade a turn without blocking Classic mode.
- Players can understand and challenge the score.

## Phase 5: Sharing and Retention

Goal: Make the game easier to return to and share.

Deliverables:

- Saved presets
- Topic pack import/export
- Shareable custom packs
- Game history
- Lightweight profiles later if needed
