# Web Version Plan — Historical

> Historical planning record. The original Go + HTMX web milestone has been implemented and expanded. This file explains the initial direction and the important differences in the current build; [Technical Architecture](TECHNICAL_ARCHITECTURE.md) is the canonical description.

## Original direction

The first plan chose a Go and HTMX web application because most product actions are forms and state transitions:

- Player setup
- Topic and settings selection
- Host actions
- Turn submission
- Scoreboards and winner view

Vanilla JavaScript was reserved for capabilities that server-rendered HTML cannot provide:

- Microphone permission and device selection
- Web Audio voice-activity analysis
- Precise timer display
- Optional browser speech recognition
- Browser-local presets

That boundary remains in the implementation. The browser is not a full SPA.

## Original milestones and outcome

| Milestone | Outcome |
| --- | --- |
| Go server and templates | Implemented with `net/http` and embedded `html/template` assets |
| Static UI shell | Implemented with token-based CSS and responsive/reduced-motion rules |
| Game engine and scoring | Implemented in `internal/game` |
| HTMX setup flow | Implemented with official HTMX 2.0.10 |
| Topic packs | Implemented with five packs, custom lists, randomized deck, import/export, and generation |
| Turn screen | Implemented |
| Microphone and timer JavaScript | Implemented with device selection, Web Audio, sound cues, and manual fallback |
| Result submission | Implemented with server clock caps and stable turn identity |
| Scoreboard and winner | Implemented, plus score corrections and room history |
| Browser smoke test | Implemented with five Playwright flows |

## Expansion beyond the original local plan

The first plan treated online play, AI judging, and persistence as later upgrades. They now exist:

- Six-character rooms with remote seats
- Server-Sent Events synchronization
- Host transfer and claim after absence
- Browser-token reconnect
- Optional JSON snapshots
- Optional on-device transcription and relevance judging
- Offline, Anthropic-backed, and Z.AI GLM-backed topic generation selected through `NONSTOPTALK_AI_PROVIDER`
- Native Workers Static Assets + SQLite-backed Durable Object deployment path

## Current request shape

The exact route set has evolved from the early sketch. Current endpoints are room-oriented:

```text
GET  /                              landing page
POST /rooms                         create room
POST /rooms/join                    join room

GET  /room/{code}                   full current state
GET  /room/{code}/partial           current state partial
GET  /room/{code}/events            SSE update stream

POST /room/{code}/players...        roster actions
POST /room/{code}/settings          game settings
POST /room/{code}/topics...         custom or generated topics
POST /room/{code}/game...           start/reset
POST /room/{code}/turn...           start/begin/redraw/submit
POST /room/{code}/score/override    host correction
POST /room/{code}/host...           transfer/claim
POST /room/{code}/presets/apply     apply browser-local preset data
```

Most POSTs return a newly rendered `#app` fragment for HTMX. Full-page form navigation and redirects remain available for entry flows.

## Decisions that changed

- **Real-time transport:** the Go edition uses SSE; the native Cloudflare edition uses hibernatable WebSockets.
- **Storage:** local persistence uses an atomic JSON snapshot; Cloudflare rooms use private Durable Object SQLite databases.
- **Assets:** templates and static files are embedded in Go binaries.
- **Online hosting:** the free online edition is a Worker-with-Assets app backed by Durable Objects. It is separate from the Go runtime and is not a Pages-only static site.
- **Transcription privacy:** the app requires browser-reported on-device recognition and fails closed instead of accepting cloud-backed browser recognition.
- **Topics:** prompt order is randomized in persisted non-repeating cycles.

## Work that remains outside this completed plan

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- Native desktop wrapper
- Profiles and family/content filters
- Post-turn AI summaries
- Full feature parity and stronger cross-edition rule tests
