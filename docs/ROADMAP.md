# Roadmap

Status labels in this document are explicit:

- **Implemented**: present in the current repository.
- **Implemented prototype**: demonstrable end to end, but not yet validated as a production or learning-outcome claim.
- **In progress**: usable work exists, but the stated outcome is not complete.
- **Backlog**: not implemented and not a current product claim.

## 1. Speech coaching — Implemented prototype

The native Cloudflare SPA now has a private individual-practice path at `/practice` and origin-local browser history at `/progress`.

Implemented prototype scope:

- Interview, presentation-opening, and impromptu practice prompts
- One selected focus per attempt: intentional pace, purposeful pauses, or steady delivery
- Microphone sample reduction in a browser `AudioWorklet`
- Objective audio measurements for input level, clipping, speech/silence time, and pauses
- Optional pace and filler estimates only when the browser supports strict on-device speech recognition and the user opts in
- Lexical retrieval over a curated in-app coaching-card library, with no embeddings, vector database, model, or network request
- Deterministic, sparse acoustic live tips, rule-selected review evidence/focus, and a post-attempt instruction assembled from the top retrieved card's prewritten drill plus a metric-specific comparison sentence, with visible provenance
- Compact session summaries in origin-scoped IndexedDB in the current browser profile, including consented derived filler/repetition patterns
- Separate, off-by-default retention of the attempt recording and available full transcript in an origin-local artifact store, with individual downloads; full artifacts are excluded from summary JSON export
- No coaching audio or transcript upload; confirmed deletion clears both local coaching stores
- Twenty deterministic coaching-engine tests and a strengthened browser smoke flow covering default-off and opted-in storage, v1→v2 migration, real downloads/export, observed/unknown timing, timeline rendering, focus, cancellation/stall cleanup, and no coaching API request

This prototype demonstrates the technical and interaction loop. It does not yet establish measurement accuracy across devices, learning outcomes, clinical value, accessibility conformance, or accent/language fairness.

Next coaching milestones:

1. Run a consented pilot to validate audio events, false-tip rate, distraction, browser/device availability, privacy network behavior, and subgroup fairness.
2. Add an explicit baseline → review → unassisted retry relationship and compare only the selected goal.
3. Add user-authored prompts/goals, stronger calibration guidance, per-attempt artifact deletion/retention controls, and clearer signal-confidence explanations.
4. Build guided interview and presentation programs after the core measurements are validated.
5. Evaluate a production semantic/LLM RAG layer, local model, self-hosted service, or bring-your-own-key coaching as separate opt-in adapters; keep the private deterministic/local-retrieval core complete without them.
6. Decide whether to share a coaching client with the Go edition; the prototype is available only in the Cloudflare SPA today.

See [Speech Coaching Prototype](SPEECH_COACHING_PROTOTYPE.md) for the implementation boundary and [Coaching Presentation Guide](COACHING_PRESENTATION_GUIDE.md) for the Problem → Constraints → Design → Measurement narrative.

## 2. Playable web game — Implemented

- Go game engine, handlers, embedded templates/static assets, and official HTMX 2.0.10
- Player roster and configurable settings
- Five preset packs and editable custom topics
- Random, non-repeating topic cycles
- Browser microphone selection, voice-activity/silence detection, sound cues, and manual timing
- Multi-round turn progression, classic scoring, breakdowns, standings, winner, and host corrections
- Responsive layout, focus styles, and reduced-motion support

The game loop is playable. Formal accessibility and broad hardware/browser validation remain in progress.

## 3. Online rooms — Implemented

- Six-character room codes
- Remote join, leave, browser-token reconnect, and live presence
- Host-gated setup and scoring controls
- Pass-and-play and remote seats in one room
- Server-Sent Events synchronization in the Go edition and hibernatable WebSockets on Cloudflare
- Server-side turn clock for remote score caps
- Explicit host transfer and claim after a short absence grace period (30 seconds normally; up to 45 seconds for coalesced HTTP-only presence)
- Same-origin checks, rate/capacity/input limits, and idle-room cleanup

The supplied native Cloudflare edition runs on Workers Free. Each room has one SQLite-backed Durable Object, so room state survives hibernation, restarts, and deployments until its 30-day idle expiry.

## 4. Content, sharing, and retention — Implemented locally

- Preset packs with difficulty labels
- Offline or Anthropic-assisted theme generation
- Browser-local saved presets
- Plain-text custom-topic import/export
- Per-room history for the last 20 completed games
- Local web JSON snapshots with restore and 10-second autosave

Profiles and server-side custom-pack libraries are not part of this phase's implemented scope.

## 5. Optional AI judge — Implemented locally

- Host opt-in plus per-speaker, per-turn consent
- Fail-closed on-device `SpeechRecognition` requirement
- No microphone-audio upload by NonStopTalk
- Anthropic relevance grading when configured
- Transparent server-side offline heuristic without an API key
- Asynchronous, capped relevance bonus with confidence and short feedback
- Classic-score preservation on missing transcript, timeout, provider failure, or interrupted restore
- Host score correction

Because strict local-recognition support is not widely available, classic/manual play remains the primary compatibility path.

## 6. Deployment and hardening — In progress

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
- Deterministic coaching-engine tests and a Cloudflare-SPA coaching smoke flow

Remaining hardening:

- Game-feature parity between the Go and Cloudflare editions
- Stronger automated cross-edition rule-parity checks
- Broader browser/device testing
- Observability and production operations guidance
- Formal security and accessibility reviews

## 7. Explicit product backlog

These are future ideas, not current features:

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- Native desktop wrapper, installers, signing, and updates
- User profiles
- Family/content filters
- Post-turn AI summaries
- Validated baseline/retry coaching programs and progress comparisons
- Accounts, cross-device coaching sync, educator assignments, and shared reports
- Semantic structure, relevance, concision, and answer-completeness coaching
- Server-side or external coaching analysis; any such path requires separate consent and privacy design
