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
- Calibration readiness and confidence guidance: medium/high evidence keeps the direct start path; low evidence pauses before the attempt for retry on the connected microphone, explicit limited-evidence continuation, or cancel. Recording and optional on-device transcription wait for that choice. Review exposes the measurement-confidence factors and limiting reasons, and low calibration caps attempt confidence below medium so a linked comparison remains limited
- A recommended review-only baseline → evidence/advice review → unassisted review-only retry format. Scenario, goal, and target duration stay locked for the retry; the alternative single coached format retains sparse live acoustic cues
- Explicit loop, baseline, and attempt-role metadata in local and optional compact cloud summaries; Progress groups only linked records, restores an unfinished retry, leaves legacy/malformed/orphan records unpaired, and never compares unrelated attempts by recency
- Descriptive selected-goal comparisons: pace uses eligible WPM, longest speaking run, and median pause; pauses uses measured pauses per observed minute, median pause, and longest speaking run; steady delivery uses level consistency and clipping. Short evidence, low coverage, low measurement confidence, or unavailable values keep the comparison limited, and no direction is declared improvement
- Compact session summaries in origin-scoped IndexedDB in the current browser profile, including consented derived filler/repetition patterns
- Separate, off-by-default retention of the attempt recording and available captured transcript in an origin-local artifact store, with individual downloads and per-attempt artifact-only deletion; finalization errors/timeouts mark retained text as possibly partial in Review and Progress, artifacts are excluded from summary JSON export, and deletion preserves the compact attempt/pair
- Active IndexedDB v3 lifecycle policy: a required content-free ledger, exact 30-day windows for new artifacts and v1/v2 artifacts migrated from one upgrade time, exact Blob-plus-UTF-8 logical byte accounting, a 128 MiB cap for new retention with no eviction of valid unexpired or grace-migrated content, explicit app-limit/browser-quota summary-only outcomes, privacy-safe fail-closed corruption handling, and compatibility with the deployed Release-A rollback floor. Progress has a one-pass, point-in-time local artifact dashboard with exact aggregate usage, earliest and per-attempt retention deadlines, migration-grace disclosure, and delete-refresh behavior. It does not estimate browser quota or send artifact metadata over the network. IndexedDB remains best-effort browser storage and can disappear earlier; expiry cleanup runs on a later storage access
- No coaching audio or captured-transcript upload; the independent compact-summary backup boundary is described in the platform section below
- Forty-six deterministic coaching tests—38 coaching/loop tests plus eight IndexedDB storage-contract tests—plus 23 shared microphone-selection contract/race tests and browser flows covering selected-input Practice and Play capture, calibration fast/gated paths, confidence caps and explanations, gate-action races, keyboard and 320-pixel behavior, recording/transcription deferral, the single coached format, the default baseline → Progress/reload/resume → unassisted-retry format, baseline persistence gating, safe grouping/comparison, v1→v3 migration, exact lifecycle retention and usage reporting, per-attempt artifact deletion, Release-A/future-schema compatibility, fail-closed corruption, no-eviction cap behavior, summary-only fallbacks, and no coaching-data API request while the calibration gate waits or when backup is off

This prototype demonstrates the technical and interaction loop. It does not yet establish measurement accuracy across devices, learning outcomes, clinical value, accessibility conformance, or accent/language fairness.

Next coaching milestones:

1. Run a consented pilot to validate audio events, false-tip rate, distraction, browser/device availability, privacy network behavior, and subgroup fairness.
2. Measure the implemented baseline/retry loop's repeatability and usability without turning raw paired deltas into an improvement verdict.
3. Add user-authored prompts and goals.
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
- Host-only device/origin-local setup kits in the Cloudflare source, applied through one atomic room action without exposing the undrawn topic list to guests
- Pass-and-play and remote seats in one room
- Server-Sent Events synchronization in the Go edition and hibernatable WebSockets on Cloudflare
- Server-side turn clock for remote score caps
- Explicit host transfer and claim after a short absence grace period (30 seconds normally; up to 45 seconds for coalesced HTTP-only presence)
- Same-origin checks, rate/capacity/input limits, and idle-room cleanup

The supplied native Cloudflare edition runs on Workers Free. Each room has one SQLite-backed Durable Object, so room state survives hibernation, restarts, and deployments until its 30-day idle expiry.

## 4. Central web platform — In progress

The first incremental platform slice is being built without replacing the playable app:

- Versioned Worker APIs and a central D1 database for explicitly backed-up compact coaching summaries, versioned consent, anonymous expiry, HMAC-pseudonymous room facts, and daily aggregate counters with receipt-gated staging room milestones
- An off-by-default browser allowlist that excludes raw samples, audio/recordings, captured transcript text, and artifact metadata from cloud backup
- Anonymous browser ownership stored as a token digest, with one UTC-day-bucketed device lease lasting at least 30 and less than 31 days after cloud use, a new-save guard once 250 summaries exist, preservation of valid unexpired legacy rows, and bounded cleanup that can continue a backlog on later cron runs
- A schema-v4 identity expansion with opaque `sync_profiles` and `sync_profile_devices`: one internal profile per browser for now, no exposed profile credential, and no change to device-owned sessions, API behavior, consent, or retention
- A schema-v5 singleton heartbeat that makes daily cleanup failures and bounded-run backlog visible through privacy-safe public readiness, using one D1 write per successful run and no new service or secret
- A schema-v6 additive, privacy-minimal `room_milestone_receipts` table, strict internal canonical receiver, bounded receipt expiry cleanup, Release-A rollback bridge, and Release-B normal-room producer. Production remains `best-effort`, so ordinary production rooms create neither local outbox tables nor receipts. Staging intentionally runs exact `outbox`, is healthy with `durable-outbox`, uses atomic state/event/alarm commits plus FIFO receipt-gated D1 delivery, and passed its rollback/drain/restoration proof plus repeated exact smoke on 2026-09-02
- Coarse privacy-safe product events: production room milestones and progress/consent transitions in both environments attempt D1 rollups best-effort, staging exact room milestones are receipt-gated, and Analytics Engine remains best-effort everywhere; D1 supplies protected aggregate product-analytics and model-usage operational readouts, not audit or billing truth
- A protected, dependency-free `/admin/analytics` operator document that validates and reconciles those daily aggregates, derives 1/7/30/90-day views locally, keeps its numeric bearer token out of storage/URLs/output, and blocks public-site browser telemetry on the token-bearing page
- Server-authoritative room milestones plus coarse summary-save/delete/consent timing/count values; no page-view, presence-tick, per-person, speaking-ratio, transcript-pattern, or advice telemetry
- A modular Cloudflare theme-to-topics boundary: deterministic/offline by default; direct Z.AI GLM-4.7-Flash as the strict-free routine option; Workers AI GLM-5.3-Flash as the preferred cheap Workers Paid routine option; and independently enabled Gemma 4 31B only for explicit host escalation
- Per-generation host consent; a normalized theme capped at 200 characters as the only host or room content sent externally; aggregate D1 daily usage budgeting (100 calls by default); and deterministic fallback without provider retry or Queue delivery
- Modular separation among Durable Object room authority, D1 repositories, identity, coaching backup, analytics, and topic providers
- Local coaching and gameplay that continue to work when D1 or analytics is unavailable

This phase remains free-or-cheap by default: it uses existing Cloudflare primitives, keeps routine generation offline unless enabled, makes the larger model an explicit escalation, and caps aggregate external calls. The identity foundation adds only two small D1 metadata rows per browser; cleanup health adds one global row and one write per successful day. The receipt/outbox lane adds no Cloudflare service, binding, provider call, paid product, or per-user row; it reuses each room's SQLite Durable Object, its alarm, central D1 schema 6, and the existing room-fact secret. Device-local setup kits likewise add no Cloudflare resource, binding, migration, provider call, or cloud-storage cost: only explicit Apply uses the existing room Durable Object action. Production `best-effort` traffic adds no local outbox table or receipt write; staging exact mode adds one bounded local event and one expiring D1 receipt per delivered room milestone. Accounts, cross-device authentication/progress, external coaching AI, Queue-backed work, and R2 media storage remain later phases. The next identity slice may add bilateral numeric-code linking only with a separate `IDENTITY_HASH_KEY` and explicit consent on both browsers; it must not silently grant cloud-summary consent. See the [Web platform plan](WEB_PLATFORM_PLAN.md).

## 5. Content, sharing, and retention — Implemented

- Preset packs with difficulty labels
- Offline, Anthropic-assisted, or Z.AI GLM-assisted theme generation in the local Go edition, selected with `NONSTOPTALK_AI_PROVIDER`; invalid or incomplete selections warn and fail closed to offline templates
- Editable Cloudflare topic drafts from deterministic templates, optional direct GLM-4.7 or Workers AI GLM-5.3-Flash routine generation, or explicitly selected Gemma 4 31B escalation
- Browser-local saved presets in the Go edition and host-only named setup kits in the Cloudflare source. A Cloudflare kit stores the currently applied duration, silence, rounds, topic-pack choice, and custom topics in unencrypted `localStorage` for that origin/browser only; it is best effort, unsynced, and has no recovery
- Plain-text custom-topic import/export in both editions. In Cloudflare, import fills only the editor draft until explicit use, while the downloaded `.txt` is outside app deletion/control
- Cloudflare local limits of 25 kits, 40 Unicode code points per name, 500 custom topics of 200 code points each, 20,000 editor characters, 64 KiB per imported topic file, and 512 KiB for the serialized store. Local save/delete/import/export calls no API, model, analytics sink, D1, or Durable Object; one explicit Apply sends the selected settings/topics to the existing same-origin room object
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
- A versioned machine-readable contract executed by both the Go and Cloudflare
  suites for Unicode limits, remote-clock tolerance, completion normalization,
  score corrections, atomic topic replacement, and persisted turn-ID repair
- A hermetic two-browser Cloudflare smoke flow covering isolated identities,
  live WebSocket state, host-only authorization, scoring, reconnect persistence,
  and a finished game
- Deterministic coaching-engine tests and a Cloudflare-SPA coaching smoke flow
- Automated axe-core WCAG rule scans across the public landing, practice,
  progress, room-lobby, ready, active-turn, and coaching review states, plus
  keyboard focus, skip-link, reduced-motion, and 320-pixel reflow checks; this
  is regression coverage, not a claim of formal accessibility conformance
- D1 migrations, platform API/repository tests, compact-summary client tests, configured/degraded capability status, and bounded scheduled anonymous-data cleanup
- Expand-only schema-v4 sync-profile tables and one-device/one-profile backfill while device-owned session queries remain the rollback-safe authority
- Schema-v5 cleanup heartbeat with monotonic cron timestamps, backlog/staleness readiness, and a twice-hourly zero-secret read-only matrix that independently checks production `best-effort` and staging `durable-outbox` policy
- A deployed schema-5/6 compatibility bridge plus the additive schema-v6 milestone-receipt table, strict internal receiver, bounded expiry cleanup, Release-A retry consumer, and configuration-gated Release-B normal-room producer, with canonical-payload, replay/conflict, post-commit analytics, physical-upgrade, rollback, FIFO retry/dead-letter, transaction replay, atomic alarm/state/event, capacity, exactly-one-routing, and schema-skew tests
- Host-authorized Cloudflare topic generation with separate provider adapters, per-attempt consent, aggregate daily cost controls, and deterministic failure fallback
- Bounded Cloudflare setup-kit storage, plain-text topic transfer, one-action atomic apply, host/phase authorization, browser-storage failure handling, and guest topic privacy coverage
- Shared Cloudflare Practice/Play microphone selection with opaque-ID-only browser persistence, memory-only labels, bounded unavailable-device fallback, driver/route race guards, and no application or analytics request
- A separate-document operator analytics dashboard with strict CSP/no-transform isolation, source-quality tests, and narrow/mobile browser smoke coverage
- Separate production/staging databases, analytics datasets, rate limits, secrets, cron schedules, deployment probes, migration checks, and production incident/recovery guidance

Remaining hardening:

- Game-feature parity between the Go and Cloudflare editions; the remaining known gaps are the AI judge and sound cues
- Expansion of the automated cross-edition contract beyond the implemented core rules
- Broader browser/device testing
- Formal security and accessibility reviews
- Separately review a single-version production activation now that the staging rollback/drain/candidate-restoration drill and repeated exact smoke have passed; staging is healthy exact `outbox`, production remains `best-effort`, and the Release-A-compatible one-header ownership sentinel covers unavoidable propagation skew in either direction

## 8. Explicit product backlog

These are future ideas, not current features:

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- Native desktop wrapper, installers, signing, and updates
- Visible user profiles and profile management
- Family/content filters
- Post-turn AI summaries
- Validated learning outcomes, repeatability, and interpretation for baseline/retry coaching programs; descriptive progress comparisons are implemented
- Accounts, cross-device authentication/coaching sync, educator assignments, and shared reports
- Semantic structure, relevance, concision, and answer-completeness coaching
- Server-side or external coaching analysis beyond the implemented theme-only topic adapters; any such path requires separate consent and privacy design
- Queue-backed provider jobs and R2 media storage; neither is part of the first platform slice
