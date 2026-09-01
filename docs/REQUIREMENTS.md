# Requirements and Implementation Status

NonStopTalk is a work in progress. This file records what the repository currently satisfies and what remains backlog; future items are not implied to be implemented.

## Runtime requirements

- Go 1.26, as declared by `go.mod`
- A modern browser with JavaScript for gameplay
- A secure browser context for microphone access: HTTPS online or `localhost` locally
- `getUserMedia`, Web Audio, and IndexedDB for the Cloudflare speech-coaching prototype; `AudioWorklet` is preferred and an `AnalyserNode` compatibility path is available
- `MediaRecorder` only for the separate, optional full-session recording-retention choice; compact coaching summaries remain available without it
- Browser support for mandatory on-device `SpeechRecognition.processLocally` only for optional transcript-assisted coaching; acoustic coaching remains available without it
- Node.js 22+/npm for Playwright smoke tests and Cloudflare tooling
- A Cloudflare Workers Free account only when deploying the native online edition
- A D1 database binding and migrations for the in-progress central platform slice; Analytics Engine is best-effort telemetry rather than a runtime dependency for gameplay or local coaching
- `NONSTOPTALK_AI_PROVIDER=offline|anthropic|glm` only when overriding the local Go server's legacy auto-selection: unset selects Anthropic only when `ANTHROPIC_API_KEY` exists, while `ZAI_API_KEY` alone does not opt in
- An Anthropic API key for an explicit local `anthropic` selection or the legacy unset-selector behavior
- A Z.AI API key in the local Go environment only for explicit local `glm`, or stored separately as a Wrangler secret when the Cloudflare routine topic provider is set to `glm`
- The Wrangler `AI` binding and Workers Paid billing only when the Cloudflare routine topic provider is set to `glm53`; no vendor API-key secret is required
- A Gemini API key stored as a Wrangler secret only when the Cloudflare escalation provider is set to `gemma31`

## Functional requirements and status

### Speech coaching prototype — implemented (native Cloudflare SPA)

- `/practice` offers interview-answer, presentation-opening, and impromptu prompts.
- The user chooses one focus: intentional pace, purposeful pauses, or steady delivery, plus a 30, 45, 60, or 90 second attempt.
- Microphone permission is requested after an explicit local-processing explanation.
- A four-second calibration samples the quiet room for two seconds and normal speaking for two seconds before the attempt.
- A browser `AudioWorklet` reduces microphone samples to RMS and peak frames; an `AnalyserNode` keeps the prototype usable when the worklet path cannot start.
- Browser-side analysis estimates speaking/silence time, pause events, longest speaking run, input-level consistency, clipping, signal coverage, unobserved time, and signal confidence. A level frame is held for at most 250 ms; longer callback gaps become unknown rather than fabricated delivery evidence. Zero callbacks produce an entirely unknown attempt with zero coverage/confidence and input-recovery advice.
- A seven-second calibration watchdog returns to setup if analysis frames stop. A wall-clock attempt deadline still finishes an active attempt when callbacks stall, and an ended input track either fails calibration or finishes the attempt with a warning.
- The selected goal and measured evidence lexically retrieve a curated coaching card bundled with the app; no LLM, embedding model, vector database, or network request is involved.
- Deterministic acoustic rules show at most one sparse live tip and separately select a post-attempt strength/focus. Local retrieval normally supplies the top card's prewritten drill; when an evidence-safety rule rejects an unsupported card, the measured priority supplies the drill instead. Deterministic template assembly appends a priority-specific comparison sentence, and the review says whether the card was used or retrieved only as context.
- The recommended practice format creates an explicit baseline → review → unassisted-retry relationship. Both paired attempts are `review-only`: the active page shows the prompt, goal, timer, and microphone-connected state but does not mount the live meter, live statistics, or coaching-tip surface. The alternative single coached format remains a standalone `live-cues` attempt.
- A retry preserves and locks the baseline scenario, goal, and target duration. Progress can resume a baseline after reload and starts transcript analysis, full-session retention, and compact cloud backup unchecked on that resumed retry.
- Transcript analysis is optional. It starts only after consent and only when the browser exposes mandatory local-processing support; failed initialization or no captured text preserves the acoustic review without transcript metrics or a remote-recognition fallback.
- Transcript text is capped at 20,000 characters in memory and used to estimate word count, words per minute, filler patterns, and immediate repeated words. Finishing gives recognition up to two seconds to flush final results. A later timeout/error does not discard text already received, but that text is never described as complete.
- The compact summary retains bounded derived filler/repetition patterns after transcript consent; captured transcript text is discarded by default.
- Full-session retention is a separate, unchecked setup choice. When enabled in a `MediaRecorder`-capable browser, the attempt recording and any captured local transcript are stored in the separate `session-artifacts` IndexedDB store for this origin and browser profile. A timeout/error after captured text sets `transcriptMayBePartial` in persisted artifact-presence metadata and produces warnings in Review and Progress.
- `/progress` stores and displays compact summaries, exports summary JSON without audio or captured transcript text, and exposes individual recording/transcript downloads only when those artifacts exist.
- Summaries may carry explicit `practiceLoopId`, `baselineAttemptId`, `attemptRole`, and `feedbackMode` fields. Pre-loop analysis-v2 summaries remain valid independent attempts. Progress groups only a valid explicit relationship; duplicate baselines, missing baselines, malformed relationships, unsupported setup, and mismatched scenario/goal/duration/schema remain visible but unpaired.
- A valid pair compares only its selected goal with raw baseline → retry values and descriptive deltas. Pace uses eligible estimated WPM plus longest speaking run and median measured pause; purposeful pauses uses measured pauses per observed minute plus median pause and longest speaking run; steady delivery uses level consistency and clipping. Attempts under 15 analyzed seconds, below 75% coverage, with low/unknown signal confidence, or without the needed measurements are labeled limited evidence. No change direction is automatically called better or improvement.
- **Delete saved artifacts** removes one attempt's recording/captured transcript and resets its artifact metadata in one local transaction while preserving the compact summary, explicit pair, and comparison.
- **Delete local history** clears both `session-summaries` and `session-artifacts` for the current origin and browser profile after confirmation.
- Coaching sample frames, recordings, and captured transcript text are never placed in a Durable Object or uploaded. With compact cloud backup off—the default—the coaching path makes no coaching-data API request. When explicitly selected, only a strictly allowlisted measurement/advice summary is sent to D1.

This is an implemented presentation prototype, not a validated measurement instrument. It is not a medical assessment, speech therapy, or a production learning-outcome claim.

### Central web platform foundation (in progress)

- Versioned Worker routes provide `GET`/`HEAD` platform status, compact-summary create/list/delete and export, and secret-protected aggregate product-analytics and model-usage readouts. Status checks D1 and reports non-secret configured or degraded capabilities, including topic-provider readiness.
- D1 is the central queryable store for hashed anonymous device ownership/expiry, consented compact summaries, versioned consent records, operator-keyed HMAC room facts, and best-effort daily event rollups. Raw room codes and the HMAC secret are excluded.
- Anonymous cloud access is tied to a high-entropy browser cookie; only its SHA-256 digest is stored. It is not an account, recovery credential, or cross-device identity.
- One UTC-day-bucketed device lease controls all cloud summaries for an anonymous browser and lasts at least 30 and less than 31 days after cloud use. Summary rows are not rewritten merely to renew access. New saves are rejected once 250 summaries exist; valid unexpired legacy rows are preserved rather than forcibly deleted. HMAC-pseudonymous room facts expire after 90 days. Scheduled cleanup uses bounded batches and continues any remaining backlog on a later cron while aggregate daily rollup rows remain.
- Analytics use coarse server-authoritative room milestones plus accepted coaching summary-save/delete and cloud-consent transitions, including aggregate timing/count values needed for funnel health. They exclude names, IP addresses, user agents, raw/member tokens, audio, captured transcript text, advice, word patterns, and delivery-quality measurements such as speaking ratio.
- Analytics Engine and D1 daily rollups both receive coarse events best-effort. D1 supplies the protected admin readout, but failures fail open and events may be missed; neither sink is audit or billing truth.
- Room authority remains in Durable Objects. D1 and analytics failures must not break live rooms or local coaching history.
- Raw audio, browser-encoded recordings, and captured transcript text always remain in the browser. Optional D1 backup contains only the compact allowlisted summary.
- A separate host-only theme-to-topics boundary is deterministic by default. An operator can select direct Z.AI GLM-4.7-Flash (`glm`) as the strict-free routine option or Workers AI GLM-5.3-Flash (`glm53`) as the preferred cheap Workers Paid option, and can independently enable Gemma 4 31B for explicit escalation. Every external attempt still requires fresh host consent. The normalized theme, capped at 200 characters, is the only host or room content sent to a provider.
- Aggregate D1 model-usage rows enforce `MODEL_DAILY_CALL_LIMIT` (100 external attempts per UTC day by default) without retaining themes or generated topics. They aggregate reservation/completion and outcome counts, provider/model/task, input/output/total/cached-input/reasoning token totals, latency, and timestamps; they exclude room/member/authentication tokens and identities, not the model-token aggregates needed for cost monitoring. The protected `/api/v1/admin/model-usage` route returns global and daily provider aggregates. A configured external request without consent is rejected before budget reservation or provider contact. Missing credentials, invalid selectors, unavailable/exhausted budget, and provider/output failures return deterministic topics, while public status marks invalid or incomplete provider configuration as degraded. The slice performs no provider retry or Queue delivery.

The slice is modular and designed around Workers, Durable Objects, D1, Static Assets, Analytics Engine, and observability on free or low-cost allocations. Accounts/authentication, cross-device access, external coaching AI, Queues, and R2 are not implemented. The topic-only providers do not perform coaching or transcript analysis.

### Local and online play — implemented

- The local/self-hosted browser app runs from a Go `net/http` server.
- The free online edition runs as a native TypeScript Worker with Static Assets and SQLite-backed Durable Objects.
- Local pass-and-play works without accounts.
- Six-character online rooms support a host and remote player seats.
- Room state refreshes live through Server-Sent Events locally and hibernatable WebSockets on Cloudflare.
- Browser-token identity supports reconnect, explicit host transfer, and host claim after absence.
- The desktop-style command starts a loopback server and opens the default browser.

### Setup and players — implemented

- A room supports 2–12 players.
- The host can add, rename, remove, and reorder players.
- A remote player can rename their own seat and leave.
- The host can configure speaking duration, silence limit, rounds, and topic source. The local Go edition also exposes AI-judge availability.
- Input normalization enforces server-side limits for settings, names, topics, and topic count.

### Topics — implemented

- Five preset packs are included.
- Custom lists accept one topic per line.
- The Go edition can import/export custom lists as text and save browser-local presets.
- The Go edition's theme generation uses the same `NONSTOPTALK_AI_PROVIDER` selection as judging: explicit `offline`, `anthropic`, or `glm`; an unset selector preserves legacy Anthropic auto-selection only when `ANTHROPIC_API_KEY` exists. Invalid/incomplete selections warn and fail closed to local templates.
- The Cloudflare edition accepts a host theme of at most 200 characters and returns an editable draft. `TOPIC_ROUTINE_PROVIDER=offline` and `TOPIC_ESCALATION_PROVIDER=off` are the disabled/free defaults; routine also accepts `glm` or `glm53`.
- With per-attempt host consent, `glm` uses direct Z.AI GLM-4.7-Flash and `ZAI_API_KEY`, while `glm53` uses public model `glm-5.3-flash` through the Workers AI binding ID `@cf/zai-org/glm-5.3-flash`. The latter requires Workers Paid in this build but no vendor API key. Gemma 4 31B is used only when the host explicitly chooses escalation and the operator independently enabled that tier.
- The normalized theme is the only host or room content that reaches an external topic provider. Fixed instructions and model settings accompany it, but audio, transcript text, player/room names, room codes and member/authentication tokens, coaching data, game history, and NonStopTalk request IDs do not leave the Worker.
- Missing credentials, invalid operator selectors, unavailable/exhausted budget, and remote provider/output failures return deterministic topics, with invalid/incomplete configuration reported as degraded by public status. Missing consent rejects a configured external request without contact; authorization and input errors remain explicit. Escalation is not automatic and external calls are not retried.
- Worker status can verify only that `AI.run` exists, not GLM-5.3 billing entitlement; a denied first request falls back deterministically. Provider output is materialized before the 64 KiB validation bound is applied, and a timed-out upstream call may still incur cost if cancellation is ignored.
- Topics are shuffled without repeats until the current deck is exhausted; an immediate repeat across deck cycles is avoided when possible.
- The active topic can be redrawn.

### Turn play — implemented

- The active player, topic, round, timer, voice state, and standings are shown.
- Both editions support local Web Audio voice-activity detection; the Go edition also supports explicit microphone selection.
- A microphone-driven turn ends at full duration or after the configured silence period.
- Timer completion takes precedence if completion and silence cross in the same update.
- A manual timer handles denied, missing, or unsupported microphone access.
- The host can end or mark a turn complete.
- A server-side clock caps remote time claims.
- An in-progress server clock is reflected after a page reload.

### Scoring and retention — implemented

- Classic scoring awards one point per spoken second plus 25 points for completion.
- Each scored turn shows a breakdown.
- The host can adjust totals by ±5 points.
- Standings update through the game and a winner is shown at the end.
- Each room keeps the last 20 finished-game summaries.
- The local web command loads and autosaves JSON room snapshots unless persistence is disabled.
- The Cloudflare edition persists each room in a private SQLite-backed Durable Object and removes it after 30 days without a state change.

### Optional AI — implemented in the local Go edition

- The host must enable the judge, and each speaker must separately choose transcription for their own turn.
- Transcription is attempted only with browser-reported `processLocally` support and the selected live microphone track.
- NonStopTalk does not upload microphone audio.
- The transcript is capped, used for current-turn grading, and not persisted in room or history state.
- `NONSTOPTALK_AI_PROVIDER=offline|anthropic|glm` selects the local judge and theme generator. Unset preserves legacy Anthropic selection only when `ANTHROPIC_API_KEY` exists; otherwise it stays offline, and `ZAI_API_KEY` alone does not opt in. Explicit providers require their matching key; invalid or incomplete selections warn and fail closed to the offline heuristic.
- After the speaker's per-turn consent, Anthropic or Z.AI GLM receives only the assigned topic and capped transcript as user data, never microphone audio or room metadata. Local theme generation sends an external provider only the theme as user content.
- Judge feedback is short, reports confidence, and can add at most 20 relevance points.
- Judge work is asynchronous and failures preserve classic scoring.
- Host score adjustments remain available.

### Request and room safeguards — implemented

- State-changing requests receive same-origin validation and a request-body cap.
- The Go edition rate-limits room creation, join, topic generation, and judge work, including a process-wide external-provider ceiling.
- The Cloudflare edition rate-limits room creation per source connection, applies a general 60-requests-per-minute scoped API limiter, applies the dedicated `MODEL_RATE_LIMITER` at five topic requests per source connection per minute, rejects cross-origin WebSocket upgrades, caps live sockets per member and room, and authorizes topic generation against the current host and setup phase.
- External topic attempts share an aggregate D1 UTC-day budget, defaulting to 100 calls, before provider work begins.
- Player, room, name, topic, and transcript sizes are bounded.
- Local rooms expire after three hours without a state mutation; Cloudflare rooms expire after 30 days without one.
- Stateful turn and judge actions are matched to the intended turn so delayed results cannot be applied to a later turn.

## Non-functional status

| Area | Current status |
| --- | --- |
| Usability | Fast game defaults, a focused coaching flow, large live surfaces, mobile layouts, and visible fallbacks are implemented. Formal time-to-start, distraction, or learning-loop usability testing has not been run. |
| Accessibility | Semantic labels, keyboard-operable native controls, visible focus styling, non-color text states, and reduced-motion CSS exist. WCAG 2.1 AA conformance has not been audited. |
| Reliability | Go unit/handler tests, Cloudflare rules/platform tests, 34 deterministic coaching/loop tests, cloud-progress tests, and Playwright smoke flows cover core paths—including baseline/retry persistence gating/resume, comparison, legacy grouping, and artifact-only deletion. Microphone calibration and optional local transcription still depend on browser, language pack, device, and room conditions. |
| Local persistence | `cmd/web` autosaves JSON every 10 seconds by default. `cmd/desktop` is memory-only. |
| Online durability | Each Cloudflare room has one SQLite-backed Durable Object, so state survives hibernation, Worker restarts, and deployments until its 30-day idle expiry. |
| Coaching persistence | IndexedDB v2 remains the local summary/artifact source. Individual artifacts can be deleted without deleting their compact summaries or loop relationships. An independent opt-in can back up only compact summaries—including explicit relationship metadata—to D1 under an anonymous browser identity. One device-level UTC-day-bucketed lease lasts at least 30 and less than 31 days after cloud use; new saves stop once 250 summaries exist without forcibly deleting valid legacy rows. Local artifacts have no automatic expiry. No account recovery or cross-device sync exists. |
| Privacy | Audio samples, recordings, and captured transcript text remain local. Default/off coaching makes no coaching-data API request; explicit backup sends only allowlisted summary fields. Cloudflare external topic generation requires per-attempt host consent; the normalized theme, capped at 200 characters, is the only host or room content sent to a provider. Product analytics and provider-budget state are coarse aggregates rather than content records. The local Go edition's separately consented AI-judge path retains its documented provider boundary. |
| Measurement validity | Signal formulas, local retrieval, and rules are inspectable, but thresholds and coaching-card relevance have not been validated across devices, noise conditions, languages, accents, disabilities, or speaking contexts. No universal speech-quality score or improvement target is claimed. |

## Current acceptance baseline

The repository's playable baseline is:

1. A host creates a room and seats at least two players.
2. Players can complete every turn in one or more rounds locally or from separate browsers.
3. Turns end through completion, silence detection, manual submission, or host override.
4. Scores and their components are visible.
5. Final standings and a winner are visible.
6. A bad microphone or judge outcome can fall back to classic/manual play and host score correction.
7. The Cloudflare host can turn a bounded theme into an editable deterministic topic draft without a model key; when an external tier is configured, missing budget/credentials or provider failure preserves that fallback, while missing consent prevents the external attempt entirely.
8. The local Go app and native Cloudflare edition both provide the documented core game flow.

The coaching-prototype baseline is:

1. A user can open `/practice`, understand the privacy boundary, choose a scenario/goal/duration, and grant or deny microphone access.
2. With a synthetic or supported real microphone, calibration leads to a timed attempt with live objective measurements and no coaching-media network request; the default/off path also makes no coaching-data API request.
3. Ending or completing the attempt produces explainable evidence, a voice/quiet/unobserved timeline, one rule-selected strength/focus, one comparison drill, and retrieved-card provenance that distinguishes used guidance from context-only retrieval.
4. When strict local recognition is absent, cannot initialize, or captures no text, the attempt completes without transcript-derived metrics or a remote fallback. A later error/timeout preserves text already received while marking it as possibly partial.
5. The default saved `/progress` summary contains aggregate metrics/advice and consented derived word patterns but no audio, raw sample frames, or captured transcript text.
6. Full-session retention starts unchecked; when selected, a recording and any available captured transcript are saved only in the separate local artifact store and receive individual download controls. Persisted `transcriptMayBePartial` metadata and Review/Progress warnings prevent a finalization error/timeout from being presented as complete text.
7. JSON export excludes full artifacts, and confirmed local-history deletion clears both stores.
8. Per-attempt artifact deletion removes the chosen recording/transcript while preserving the compact attempt and any paired comparison.
9. The default format can complete a review-only baseline, reload/resume the same locked setup from Progress, finish a review-only retry, and display only explicitly linked goal-specific descriptive evidence; single coached and legacy summaries remain independent.
10. Canceling during microphone permission or delayed worklet loading cannot start a late attempt and releases any acquired media/interval work.
11. Missing active callbacks become unknown evidence and cannot manufacture continuous-speech advice; callback-free calibration fails with actionable copy instead of hanging.
12. Selecting compact cloud backup sends only the allowlisted summary, never media or captured transcript text; without that choice, local coaching behavior remains independent of D1.

## Explicit backlog

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- Native desktop wrapper and installers
- User profiles
- Family/content filters
- Post-turn AI summaries
- Full multiplayer-game feature parity between the Go and Cloudflare editions beyond the implemented online topic-draft slice
- A formal accessibility audit
- Validated audio thresholds and confidence across representative microphones, browsers, room noise, and assistive setups
- Validated learning outcomes, repeatability, and interpretation for the implemented baseline → review → unassisted-retry comparisons
- Human-labeled false-tip, distraction, learning-outcome, privacy, and accent/language fairness studies
- Larger expert-reviewed/source-cited coaching-card curricula and validated retrieval relevance
- Coaching support in the local Go edition
- Accounts, cross-device authentication/history, guided programs, educator features, and optional external semantic/LLM coaching analysis
- Queue-backed provider execution and R2 media storage
