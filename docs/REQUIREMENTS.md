# Requirements and Implementation Status

NonStopTalk is a work in progress. This file records what the repository currently satisfies and what remains backlog; future items are not implied to be implemented.

## Runtime requirements

- Go 1.26, as declared by `go.mod`
- A modern browser with JavaScript for gameplay
- A secure browser context for microphone access: HTTPS online or `localhost` locally
- Node.js 22+/npm for Playwright smoke tests and Cloudflare tooling
- A Cloudflare Workers Free account only when deploying the native online edition
- An Anthropic API key only for Anthropic-backed grading and topic generation

## Implemented functional requirements

### Local and online play

- The local/self-hosted browser app runs from a Go `net/http` server.
- The free online edition runs as a native TypeScript Worker with Static Assets and SQLite-backed Durable Objects.
- Local pass-and-play works without accounts.
- Six-character online rooms support a host and remote player seats.
- Room state refreshes live through Server-Sent Events locally and hibernatable WebSockets on Cloudflare.
- Browser-token identity supports reconnect, explicit host transfer, and host claim after absence.
- The desktop-style command starts a loopback server and opens the default browser.

### Setup and players

- A room supports 2–12 players.
- The host can add, rename, remove, and reorder players.
- A remote player can rename their own seat and leave.
- The host can configure speaking duration, silence limit, rounds, and topic source. The local Go edition also exposes AI-judge availability.
- Input normalization enforces server-side limits for settings, names, topics, and topic count.

### Topics

- Five preset packs are included.
- Custom lists accept one topic per line.
- The Go edition can import/export custom lists as text and save browser-local presets.
- The Go edition's theme generation uses Anthropic when configured and local templates otherwise.
- Topics are shuffled without repeats until the current deck is exhausted; an immediate repeat across deck cycles is avoided when possible.
- The active topic can be redrawn.

### Turn play

- The active player, topic, round, timer, voice state, and standings are shown.
- Both editions support local Web Audio voice-activity detection; the Go edition also supports explicit microphone selection.
- A microphone-driven turn ends at full duration or after the configured silence period.
- Timer completion takes precedence if completion and silence cross in the same update.
- A manual timer handles denied, missing, or unsupported microphone access.
- The host can end or mark a turn complete.
- A server-side clock caps remote time claims.
- An in-progress server clock is reflected after a page reload.

### Scoring and retention

- Classic scoring awards one point per spoken second plus 25 points for completion.
- Each scored turn shows a breakdown.
- The host can adjust totals by ±5 points.
- Standings update through the game and a winner is shown at the end.
- Each room keeps the last 20 finished-game summaries.
- The local web command loads and autosaves JSON room snapshots unless persistence is disabled.
- The Cloudflare edition persists each room in a private SQLite-backed Durable Object and removes it after 30 days without a state change.

### Optional AI (local Go edition)

- The host must enable the judge, and each speaker must separately choose transcription for their own turn.
- Transcription is attempted only with browser-reported `processLocally` support and the selected live microphone track.
- NonStopTalk does not upload microphone audio.
- The transcript is capped, used for current-turn grading, and not persisted in room or history state.
- Anthropic receives the topic and transcript only when `ANTHROPIC_API_KEY` is configured; otherwise the server uses an offline heuristic.
- Judge feedback is short, reports confidence, and can add at most 20 relevance points.
- Judge work is asynchronous and failures preserve classic scoring.
- Host score adjustments remain available.

### Request and room safeguards

- State-changing requests receive same-origin validation and a request-body cap.
- The Go edition rate-limits room creation, join, topic generation, and judge work, including a process-wide external-provider ceiling.
- The Cloudflare edition rate-limits room creation per source connection, rejects cross-origin WebSocket upgrades, and caps live sockets per member and room.
- Player, room, name, topic, and transcript sizes are bounded.
- Local rooms expire after three hours without a state mutation; Cloudflare rooms expire after 30 days without one.
- Stateful turn and judge actions are matched to the intended turn so delayed results cannot be applied to a later turn.

## Non-functional status

| Area | Current status |
| --- | --- |
| Usability | Fast defaults, large turn UI, mobile layout, manual fallback, and visible host controls are implemented. Formal time-to-start usability testing has not been run. |
| Accessibility | Semantic labels, keyboard-operable native controls, visible focus styling, non-color text states, and reduced-motion CSS exist. WCAG 2.1 AA conformance has not been audited. |
| Reliability | Go unit/handler tests and a five-flow Playwright smoke suite cover the main game. Microphone behavior still depends on browser and hardware support. |
| Local persistence | `cmd/web` autosaves JSON every 10 seconds by default. `cmd/desktop` is memory-only. |
| Online durability | Each Cloudflare room has one SQLite-backed Durable Object, so state survives hibernation, Worker restarts, and deployments until its 30-day idle expiry. |
| Privacy | Audio remains in the browser. The Cloudflare edition is classic-only and never creates transcripts. Local Go transcripts are opt-in, short-lived grading inputs; any configured external provider remains part of that edition's trust boundary. |

## Current acceptance baseline

The repository's playable baseline is:

1. A host creates a room and seats at least two players.
2. Players can complete every turn in one or more rounds locally or from separate browsers.
3. Turns end through completion, silence detection, manual submission, or host override.
4. Scores and their components are visible.
5. Final standings and a winner are visible.
6. A bad microphone or judge outcome can fall back to classic/manual play and host score correction.
7. The local Go app and native Cloudflare edition both provide the documented core game flow.

## Explicit backlog

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- Native desktop wrapper and installers
- User profiles
- Family/content filters
- Post-turn AI summaries
- Full feature parity between the Go and Cloudflare editions
- A formal accessibility audit
