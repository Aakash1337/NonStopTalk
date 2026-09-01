# Roadmap

Status labels in this document are explicit:

- **Implemented**: present in the current repository.
- **Implemented prototype**: demonstrable end to end, but not yet validated as a production or learning-outcome claim.
- **In progress**: usable work exists, but the stated outcome is not complete.
- **Backlog**: not implemented and not a current product claim.

## 1. Speech coaching — Implemented prototype

The native Cloudflare SPA now has a private individual-practice path at `/practice` and local-first browser history at `/progress`.

Implemented prototype scope:

- Interview, presentation-opening, and impromptu practice prompts
- One selected focus per attempt: intentional pace, purposeful pauses, or steady delivery
- Microphone sample reduction in a browser `AudioWorklet`
- Objective audio measurements for input level, clipping, speech/silence time, and pauses
- Optional pace and filler estimates only when the browser supports strict on-device speech recognition and the user opts in
- Lexical retrieval over a curated in-app coaching-card library, with no embeddings, vector database, model, or network request
- Deterministic, sparse acoustic live tips, rule-selected review evidence/focus, and a post-attempt instruction normally assembled from the top retrieved card's prewritten drill plus a metric-specific comparison sentence; an evidence-safety rule can supply the drill instead, and the review labels the card as used or context only
- A recommended review-only baseline → evidence/advice review → unassisted review-only retry format. Scenario, goal, and target duration stay locked for the retry; the alternative single coached format retains sparse live acoustic cues
- Explicit loop, baseline, and attempt-role metadata in local and optional compact cloud summaries; Progress groups only linked records, restores an unfinished retry, leaves legacy/malformed/orphan records unpaired, and never compares unrelated attempts by recency
- Descriptive selected-goal comparisons: pace uses eligible WPM, longest speaking run, and median pause; pauses uses measured pauses per observed minute, median pause, and longest speaking run; steady delivery uses level consistency and clipping. Short, low-coverage, low-confidence, or unavailable evidence is labeled limited, and no direction is declared improvement
- Compact session summaries in origin-scoped IndexedDB in the current browser profile, including consented derived filler/repetition patterns
- Separate, off-by-default retention of the attempt recording and available captured transcript in an origin-local artifact store, with individual downloads and per-attempt artifact-only deletion; finalization errors/timeouts mark retained text as possibly partial in Review and Progress, artifacts are excluded from summary JSON export, and deletion preserves the compact attempt/pair
- No coaching audio or captured-transcript upload; the independent compact-summary backup boundary is described in the platform section below
- Thirty-three deterministic coaching/loop tests and browser smoke flows covering the single coached format, the default baseline → Progress/reload/resume → unassisted-retry format, safe grouping/comparison, per-attempt artifact deletion, and no coaching-data API request when backup is off

This prototype demonstrates the technical and interaction loop. It does not yet establish measurement accuracy across devices, learning outcomes, clinical value, accessibility conformance, or accent/language fairness.

Next coaching milestones:

1. Run a consented pilot to validate audio events, false-tip rate, distraction, browser/device availability, privacy network behavior, and subgroup fairness.
2. Measure the implemented baseline/retry loop's repeatability and usability without turning raw paired deltas into an improvement verdict.
3. Add user-authored prompts/goals, stronger calibration guidance, automatic local artifact expiration/quota controls, and clearer signal-confidence explanations.
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

## 4. Central web platform — In progress

The first incremental platform slice is being built without replacing the playable app:

- Versioned Worker APIs and a central D1 database for explicitly backed-up compact coaching summaries, versioned consent, anonymous expiry, HMAC-pseudonymous room facts, and best-effort daily aggregate counters
- An off-by-default browser allowlist that excludes raw samples, audio/recordings, captured transcript text, and artifact metadata from cloud backup
- Anonymous browser ownership stored as a token digest, with one UTC-day-bucketed device lease lasting at least 30 and less than 31 days after cloud use, a new-save guard once 250 summaries exist, preservation of valid unexpired legacy rows, and bounded cleanup that can continue a backlog on later cron runs
- Coarse privacy-safe product events attempted best-effort in both D1 daily rollups and Analytics Engine; D1 supplies protected aggregate product-analytics and model-usage operational readouts, not audit or billing truth
- Server-authoritative room milestones plus coarse summary-save/delete/consent timing/count values; no page-view, presence-tick, per-person, speaking-ratio, transcript-pattern, or advice telemetry
- A modular Cloudflare theme-to-topics boundary: deterministic/offline by default; direct Z.AI GLM-4.7-Flash as the strict-free routine option; Workers AI GLM-5.3-Flash as the preferred cheap Workers Paid routine option; and independently enabled Gemma 4 31B only for explicit host escalation
- Per-generation host consent; a normalized theme capped at 200 characters as the only host or room content sent externally; aggregate D1 daily usage budgeting (100 calls by default); and deterministic fallback without provider retry or Queue delivery
- Modular separation among Durable Object room authority, D1 repositories, identity, coaching backup, analytics, and topic providers
- Local coaching and gameplay that continue to work when D1 or analytics is unavailable

This phase remains free-or-cheap by default: it uses existing Cloudflare primitives, keeps routine generation offline unless enabled, makes the larger model an explicit escalation, and caps aggregate external calls. Accounts, cross-device authentication/progress, external coaching AI, Queue-backed work, and R2 media storage remain later phases. See the [Web platform plan](WEB_PLATFORM_PLAN.md).

## 5. Content, sharing, and retention — Implemented locally

- Preset packs with difficulty labels
- Offline, Anthropic-assisted, or Z.AI GLM-assisted theme generation in the local Go edition, selected with `NONSTOPTALK_AI_PROVIDER`; invalid or incomplete selections warn and fail closed to offline templates
- Editable Cloudflare topic drafts from deterministic templates, optional direct GLM-4.7 or Workers AI GLM-5.3-Flash routine generation, or explicitly selected Gemma 4 31B escalation
- Browser-local saved presets
- Plain-text custom-topic import/export
- Per-room history for the last 20 completed games
- Local web JSON snapshots with restore and 10-second autosave

Profiles and server-side custom-pack libraries are not part of this phase's implemented scope.

## 6. Optional AI judge — Implemented locally

- Host opt-in plus per-speaker, per-turn consent
- Fail-closed on-device `SpeechRecognition` requirement
- No microphone-audio upload by NonStopTalk
- Anthropic or Z.AI GLM relevance grading when explicitly selected; an unset selector preserves legacy Anthropic auto-selection only when its key exists
- Transparent server-side offline heuristic without an API key
- Asynchronous, capped relevance bonus with confidence and short feedback
- Classic-score preservation on missing transcript, timeout, provider failure, or interrupted restore
- Host score correction

Because strict local-recognition support is not widely available, classic/manual play remains the primary compatibility path.

## 7. Deployment and hardening — In progress

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
- D1 migrations, platform API/repository tests, compact-summary client tests, configured/degraded capability status, and bounded scheduled anonymous-data cleanup
- Host-authorized Cloudflare topic generation with separate provider adapters, per-attempt consent, aggregate daily cost controls, and deterministic failure fallback

Remaining hardening:

- Game-feature parity between the Go and Cloudflare editions
- Stronger automated cross-edition rule-parity checks
- Broader browser/device testing
- Observability and production operations guidance
- Formal security and accessibility reviews

## 8. Explicit product backlog

These are future ideas, not current features:

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- Native desktop wrapper, installers, signing, and updates
- User profiles
- Family/content filters
- Post-turn AI summaries
- Validated learning outcomes, repeatability, and interpretation for baseline/retry coaching programs; descriptive progress comparisons are implemented
- Accounts, cross-device authentication/coaching sync, educator assignments, and shared reports
- Semantic structure, relevance, concision, and answer-completeness coaching
- Server-side or external coaching analysis beyond the implemented theme-only topic adapters; any such path requires separate consent and privacy design
- Queue-backed provider jobs and R2 media storage; neither is part of the first platform slice
