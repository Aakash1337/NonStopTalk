# Roadmap

Status labels in this document are explicit:

- **Implemented**: present in the current repository.
- **In progress**: usable work exists, but the stated outcome is not complete.
- **Backlog**: not implemented and not a current product claim.

## 1. Playable web game — Implemented

- Go game engine, handlers, embedded templates/static assets, and official HTMX 2.0.10
- Player roster and configurable settings
- Five preset packs and editable custom topics
- Random, non-repeating topic cycles
- Browser microphone selection, voice-activity/silence detection, sound cues, and manual timing
- Multi-round turn progression, classic scoring, breakdowns, standings, winner, and host corrections
- Responsive layout, focus styles, and reduced-motion support

The game loop is playable. Formal accessibility and broad hardware/browser validation remain in progress.

## 2. Online rooms — Implemented

- Six-character room codes
- Remote join, leave, browser-token reconnect, and live presence
- Host-gated setup and scoring controls
- Pass-and-play and remote seats in one room
- Server-Sent Events synchronization in the Go edition and hibernatable WebSockets on Cloudflare
- Server-side turn clock for remote score caps
- Explicit host transfer and claim after 30 seconds of absence
- Same-origin checks, rate/capacity/input limits, and idle-room cleanup

The supplied native Cloudflare edition runs on Workers Free. Each room has one SQLite-backed Durable Object, so room state survives hibernation, restarts, and deployments until its 30-day idle expiry.

## 3. Content, sharing, and retention — Implemented locally

- Preset packs with difficulty labels
- Offline or Anthropic-assisted theme generation
- Browser-local saved presets
- Plain-text custom-topic import/export
- Per-room history for the last 20 completed games
- Local web JSON snapshots with restore and 10-second autosave

Profiles and server-side custom-pack libraries are not part of this phase's implemented scope.

## 4. Optional AI judge — Implemented locally

- Host opt-in plus per-speaker, per-turn consent
- Fail-closed on-device `SpeechRecognition` requirement
- No microphone-audio upload by NonStopTalk
- Anthropic relevance grading when configured
- Transparent server-side offline heuristic without an API key
- Asynchronous, capped relevance bonus with confidence and short feedback
- Classic-score preservation on missing transcript, timeout, provider failure, or interrupted restore
- Host score correction

Because strict local-recognition support is not widely available, classic/manual play remains the primary compatibility path.

## 5. Deployment and hardening — In progress

Implemented work includes:

- Embedded assets so compiled binaries run outside the repository
- Unique persisted turn identities for delayed-action safety
- Persisted shuffled topic-deck state
- Reconciliation of unfinished judge work after restore
- Browser timer resume from the server clock
- Native Workers Static Assets + SQLite-backed Durable Object deployment and guide
- Hibernatable online room WebSockets and 30-day storage cleanup alarms
- Atomic host authorization, external-provider ceilings, connection caps, and replay-safe turn transitions
- Go unit, handler, race, vet, and Playwright smoke validation
- TypeScript game/route tests and a Wrangler deploy dry run

Remaining hardening:

- Feature parity between the Go and Cloudflare editions
- Stronger automated cross-edition rule-parity checks
- Broader browser/device testing
- Observability and production operations guidance
- Formal security and accessibility reviews

## 6. Explicit product backlog

These are future ideas, not current features:

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- Native desktop wrapper, installers, signing, and updates
- User profiles
- Family/content filters
- Post-turn AI summaries
