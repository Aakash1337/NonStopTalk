# Web Version Plan

## Direction

Build the first version as a Go and HTMX web app. This fits the product because most screens are form, list, and state-transition driven: player setup, topic selection, game settings, host actions, scoreboards, and round summaries.

Use minimal vanilla JavaScript only where the browser requires it:

- Microphone permission
- Web Audio voice activity detection
- High-frequency timer display
- Local event dispatch during active turns

## Why Go and HTMX Fit

Go is a good fit for the game engine, topic system, scoring, room state, and future online multiplayer. HTMX keeps setup and host workflows simple by letting the server return HTML partials instead of building a large client app.

The result should be:

- Simple to run locally
- Easy to test server-side game rules
- Fast enough for party use
- Ready for online rooms later
- Less client state than a full SPA

## What HTMX Should Handle

- Add player
- Remove player
- Rename player
- Reorder player later
- Select topic pack
- Create custom topic list
- Update game settings
- Start game
- Start turn
- Submit turn result
- Apply score override
- Move to next player
- Show scoreboard
- Restart game

## What JavaScript Must Handle

HTMX cannot directly handle microphone access or precise audio analysis. A small client module should handle:

- Request microphone permission
- Create an `AudioContext`
- Measure input volume
- Smooth voice activity levels
- Detect speech and silence
- Track silence timeout
- Drive the visible active-turn timer
- Submit final turn results to the server

The JavaScript should stay isolated to `web/static/js/turn.js` or similar. It should not become a full client-side app.

## Suggested Request Flow

### Setup

```text
GET  /                    -> setup screen
POST /players             -> adds player, returns player list partial
POST /settings            -> updates settings, returns settings partial
POST /topics/custom       -> saves custom topics, returns topic summary
POST /games               -> creates game, redirects to first turn
```

### Turn

```text
GET  /games/{id}/turn     -> active turn screen
POST /games/{id}/turns    -> receives result, returns score summary
POST /games/{id}/next     -> advances turn, returns next turn screen
```

### Scoreboard

```text
GET  /games/{id}/scores   -> scoreboard screen or partial
POST /games/{id}/scores   -> host score override
GET  /games/{id}/winner   -> final winner screen
```

## Server State

For MVP, in-memory state is acceptable:

```text
map[GameID]*GameSession
```

This keeps the first version simple. Add SQLite once saved games, custom packs, or online rooms need persistence.

## Real-time Online Upgrade

For online multiplayer, keep Go as the room authority.

Use:

- HTMX for setup and host actions
- Server-Sent Events for broadcasting room state
- WebSocket if active turns need bidirectional low-latency updates

Do not make every interaction real time immediately. Local play and host-led online play can stay mostly request/response.

## Implementation Milestones

1. Scaffold Go server and template layout.
2. Add static CSS and base UI shell.
3. Implement game engine and scoring in Go.
4. Implement setup flow with HTMX.
5. Implement topic packs.
6. Implement turn screen.
7. Add microphone and timer JavaScript.
8. Submit turn results to Go.
9. Render scoreboard and winner screen.
10. Add Playwright smoke test for a full local game.

