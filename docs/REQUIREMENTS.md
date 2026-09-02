# Requirements and Implementation Status

NonStopTalk is a work in progress. This file records what the repository currently satisfies and what remains backlog; future items are not implied to be implemented.

## Runtime requirements

- Go 1.26, as declared by `go.mod`
- A modern browser with JavaScript for gameplay
- A secure browser context for microphone access: HTTPS online or `localhost` locally
- `getUserMedia`, Web Audio, and IndexedDB for the Cloudflare speech-coaching prototype; `AudioWorklet` is preferred and an `AnalyserNode` compatibility path is available
- `MediaRecorder` only for the separate, optional full-session recording-retention choice; compact coaching summaries remain available without it
- Browser support for mandatory on-device `SpeechRecognition.processLocally` only for optional transcript-assisted coaching; acoustic coaching remains available without it
- Browser `localStorage` only for optional device-local game setup kits in the Cloudflare edition; room play remains available if that best-effort store is unavailable
- Node.js 22+/npm for Playwright smoke tests and Cloudflare tooling
- A Cloudflare Workers Free account only when deploying the native online edition
- A D1 database binding and migrations for the in-progress central platform slice; Analytics Engine is best-effort telemetry rather than a runtime dependency for gameplay or local coaching
- `NONSTOPTALK_AI_PROVIDER=offline|anthropic|glm` only when overriding the local Go server's legacy auto-selection: unset selects Anthropic only when `ANTHROPIC_API_KEY` exists, while `ZAI_API_KEY` alone does not opt in
- An Anthropic API key for an explicit local `anthropic` selection or the legacy unset-selector behavior
- A Z.AI API key in the local Go environment only for explicit local `glm`, or stored separately as a Wrangler secret when the Cloudflare routine topic provider is set to `glm`
- The Wrangler `AI` binding and Workers Paid billing only when the Cloudflare routine topic provider is set to `glm53`; no vendor API-key secret is required
- A Gemini API key stored as a Wrangler secret only when the Cloudflare escalation provider is set to `gemma31`
- A cryptographically random `ROOM_FACT_HASH_KEY` of 32–1024 UTF-8 bytes before enabling exact room-milestone outbox mode; numeric-only output from a cryptographic generator is valid

## Functional requirements and status

### Speech coaching prototype — implemented (native Cloudflare SPA)

- `/practice` offers interview-answer, presentation-opening, and impromptu prompts.
- The user chooses one focus: intentional pace, purposeful pauses, or steady delivery, plus a 30, 45, 60, or 90 second attempt.
- Microphone permission is requested after an explicit local-processing explanation.
- A four-second calibration samples the quiet room for two seconds and normal speaking for two seconds before the attempt. Medium/high evidence follows the direct start path. Low evidence pauses before the attempt on a distinct readiness screen and offers native-button choices to retry using the still-connected microphone, continue with limited evidence, or cancel and release the microphone.
- Neither `MediaRecorder` nor optional on-device `SpeechRecognition` starts while low-confidence calibration is waiting for a choice. Retry clears only the calibration samples and does not make a second permission request; continue starts the selected optional features only with the attempt. A current-run/phase guard prevents a stale frame, ended track, navigation, cancellation, or competing choice from starting a late attempt.
- A browser `AudioWorklet` reduces microphone samples to RMS and peak frames; an `AnalyserNode` keeps the prototype usable when the worklet path cannot start.
- Browser-side analysis estimates speaking/silence time, pause events, longest speaking run, input-level consistency, clipping, signal coverage, unobserved time, and measurement confidence. A level frame is held for at most 250 ms; longer callback gaps become unknown rather than fabricated delivery evidence. Zero callbacks produce an entirely unknown attempt with zero coverage/confidence and input-recovery advice.
- A seven-second calibration watchdog returns to setup if analysis frames stop. A wall-clock attempt deadline still finishes an active attempt when callbacks stall, and an ended input track either fails calibration or finishes the attempt with a warning.
- The selected goal and measured evidence lexically retrieve a curated coaching card bundled with the app; no LLM, embedding model, vector database, or network request is involved.
- Deterministic acoustic rules show at most one sparse live tip and separately select a post-attempt strength/focus. Local retrieval normally supplies the top card's prewritten drill; when an evidence-safety rule rejects an unsupported card, the measured priority supplies the drill instead. Deterministic template assembly appends a priority-specific comparison sentence, and the review says whether the card was used or retrieved only as context.
- Review explains that measurement confidence concerns captured evidence rather than the speaker. It shows calibration confidence, signal coverage and unobserved time, the longest callback gap, the evidence factors used by the heuristic, and each returned reason that limited the measurement.
- The recommended practice format creates an explicit baseline → review → unassisted-retry relationship. Both paired attempts are `review-only`: the active page shows the prompt, goal, timer, and microphone-connected state but does not mount the live meter, live statistics, or coaching-tip surface. The alternative single coached format remains a standalone `live-cues` attempt.
- A retry preserves and locks the baseline scenario, goal, and target duration. Progress can resume a baseline after reload and starts transcript analysis, full-session retention, and compact cloud backup unchecked on that resumed retry.
- Transcript analysis is optional. It starts only after consent and only when the browser exposes mandatory local-processing support; failed initialization or no captured text preserves the acoustic review without transcript metrics or a remote-recognition fallback.
- Transcript text is capped at 20,000 characters in memory and used to estimate word count, words per minute, filler patterns, and immediate repeated words. Finishing gives recognition up to two seconds to flush final results. A later timeout/error does not discard text already received, but that text is never described as complete.
- The compact summary retains bounded derived filler/repetition patterns after transcript consent; captured transcript text is discarded by default.
- Full-session retention is a separate, unchecked setup choice. When enabled in a `MediaRecorder`-capable browser, the attempt recording and any captured local transcript are stored in the separate `session-artifacts` IndexedDB store for this origin and browser profile. A timeout/error after captured text sets `transcriptMayBePartial` in persisted artifact-presence metadata and produces warnings in Review and Progress.
- IndexedDB v3 requires a content-free `artifact-lifecycle` row for every retained artifact. Its logical byte count is the audio `Blob` size plus exact UTF-8 transcript bytes. New artifacts expire exactly 30 days after save; valid v1/v2 artifacts receive exactly 30 days from the v3 upgrade time without eviction, including a one-time grace for legacy content above the 128 MiB logical cap. New content that would take aggregate retained artifacts above that cap is not stored, but its compact summary is.
- `/progress` stores and displays compact summaries, exports summary JSON without audio or captured transcript text, and exposes individual recording/transcript downloads only when those artifacts exist. A point-in-time local panel must derive exact aggregate/per-attempt logical bytes and deadlines from reconciled payload and lifecycle state, distinguish the 128 MiB app limit from unknown browser quota, disclose migration grace, and make no network request.
- Summaries may carry explicit `practiceLoopId`, `baselineAttemptId`, `attemptRole`, and `feedbackMode` fields. Pre-loop analysis-v2 summaries remain valid independent attempts. Progress groups only a valid explicit relationship; duplicate baselines, missing baselines, malformed relationships, unsupported setup, and mismatched scenario/goal/duration/schema remain visible but unpaired.
- A valid pair compares only its selected goal with raw baseline → retry values and descriptive deltas. Pace uses eligible estimated WPM plus longest speaking run and median measured pause; purposeful pauses uses measured pauses per observed minute plus median pause and longest speaking run; steady delivery uses level consistency and clipping. Attempts under 15 analyzed seconds, below 75% coverage, with low/unknown measurement confidence, or without the needed measurements are labeled limited evidence. Continuing after low-confidence calibration caps the attempt score below the medium boundary, so that attempt and any pair containing it remain visibly limited even if later frame coverage is complete. No change direction is automatically called better or improvement.
- **Delete saved artifacts** removes one attempt's recording/captured transcript and required lifecycle row, and resets its artifact metadata in one local transaction while preserving the compact summary, explicit pair, and comparison.
- IndexedDB is origin-scoped, best-effort browser storage: site-data deletion, private browsing, storage pressure, browser policy, or database failure may remove data or prevent saving earlier than the app's retention deadline. Expiry cleanup runs on a later storage access. A browser-quota failure aborts the combined artifact write and retries the compact summary alone. The app never evicts another valid unexpired artifact to admit a new one.
- Storage fails closed: structurally incompatible stores/key paths reject opening, and malformed, orphaned, mismatched, or expired artifact state is never returned. Reconciliation deletes that artifact and lifecycle row and clears its summary's artifact-presence fields while retaining the compact analysis and loop relationship. The deployed Release-A floor can reopen and operate on an already-upgraded v3 or compatible newer database after `VersionError`; it does not downgrade IndexedDB or restore expired/deleted content.
- Future database versions are compatible only if they preserve all three `id` key paths, the non-unique/non-multi-entry `expiresAtMs` index, lifecycle-v1 core field types/semantics, a deadline no later than 30 days after retention, and exact `Blob.size + UTF-8 transcript bytes` accounting. Additive fields/stores/indexes are allowed; changing a frozen invariant requires a new compatibility floor.
- **Delete local history** clears every local coaching store for the current origin and browser profile after confirmation.
- Coaching sample frames, recordings, and captured transcript text are never placed in a Durable Object or uploaded. With compact cloud backup off—the default—the coaching path makes no coaching-data API request. When explicitly selected, only a strictly allowlisted measurement/advice summary is sent to D1.

This is an implemented presentation prototype, not a validated measurement instrument. It is not a medical assessment, speech therapy, or a production learning-outcome claim.

### Central web platform foundation (in progress)

- Versioned Worker routes provide `GET`/`HEAD` platform status, compact-summary create/list/delete and export, and secret-protected aggregate product-analytics and model-usage readouts. Status checks D1 and reports non-secret configured or degraded capabilities, including retention-cleanup and topic-provider readiness. Aggregate room delivery is `best-effort` for every non-exact mode, `durable-outbox` only for the compiled producer plus exact `outbox`, schema 6, and a secure room-fact key, and `degraded-outbox` when an exact request is not ready.
- D1 is the central queryable store for hashed anonymous device ownership/expiry, opaque internal sync-profile mappings, consented compact summaries, versioned consent records, operator-keyed HMAC room facts, one maintenance heartbeat, milestone receipts, and daily event rollups. Raw room codes and the HMAC secret are excluded.
- Anonymous cloud access is tied to a high-entropy browser cookie; only its SHA-256 digest is stored. It is not an account, recovery credential, or cross-device identity.
- Schema v4 creates one opaque `sync_profiles` row and one `sync_profile_devices` membership per browser. The profile ID is not exposed or accepted as a credential; summary ownership, authorization, SQL, API responses, visible flows, and cloud-summary consent remain device-scoped. Device expiry cascades membership deletion, and bounded cleanup later removes the expired orphan profile.
- One UTC-day-bucketed device lease controls all cloud summaries for an anonymous browser and lasts at least 30 and less than 31 days after cloud use. Summary rows are not rewritten merely to renew access. New saves are rejected once 250 summaries exist; valid unexpired legacy rows are preserved rather than forcibly deleted. HMAC-pseudonymous room facts expire after 90 days. Scheduled cleanup uses bounded batches and continues any remaining backlog on a later cron while aggregate daily rollup rows remain. Schema v5 advances one monotonic singleton only after a successful cleanup; public status exposes `ready`, `stale`, or `backlog` without timestamps, counts, or user data.
- Analytics use coarse server-authoritative room milestones plus accepted coaching summary-save/delete and cloud-consent transitions, including aggregate timing/count values needed for funnel health. They exclude names, IP addresses, user agents, raw/member tokens, audio, captured transcript text, advice, word patterns, and delivery-quality measurements such as speaking ratio.
- Progress/consent events in both environments, production room events, and every Analytics Engine write remain best-effort. Staging exact outbox changes only room milestones: their eligible D1 effects are retried and receipt-gated. D1 supplies the protected admin readout, but neither sink is audit or billing truth.
- Schema v6 adds a constrained `room_milestone_receipts` table and expiry index. A strict internal receiver receipt-gates one canonical D1 application, and bounded scheduled cleanup removes expired receipts only on marker 6. Marker-5 cleanup never prepares receipt-table SQL. Release A can lazily recognize and drain a valid version-1 local Durable Object outbox FIFO, one head per alarm, with persisted bounded retry and privacy-minimal dead-letter state. Release B adds a normal-room producer behind exact lowercase `ROOM_MILESTONE_DELIVERY_MODE=outbox`: a milestone mutation atomically commits room state, stable lifecycle metadata, the complete ordered event group, and the shared alarm before response or broadcast. Expected capacity/canonicalization drops preserve gameplay and record bounded counters; other local storage or alarm failures roll back the mutation. Production remains configured `best-effort`, so ordinary production rooms initialize no outbox and create no receipt. Staging is intentionally configured exact `outbox`, is healthy with `durable-outbox`, and passed its rollback/drain/restoration proof plus repeated exact smoke on 2026-09-02. Receipt fields are limited to opaque lowercase 256-bit IDs/hashes and canonical UTC receipt/application/exact-90-day-expiry timestamps.
- One scheduled/manual, bounded, read-only workflow probes production and staging as independent matrix rows without credentials, dependency installation, or mutations. It requires production to report `best-effort` and staging to report `durable-outbox`, so an otherwise healthy delivery-policy drift fails visibly.
- Room authority remains in Durable Objects. D1 and analytics failures must not break live rooms or local coaching history.
- Raw audio, browser-encoded recordings, and captured transcript text always remain in the browser. Optional D1 backup contains only the compact allowlisted summary.
- A separate host-only theme-to-topics boundary is deterministic by default. An operator can select direct Z.AI GLM-4.7-Flash (`glm`) as the strict-free routine option or Workers AI GLM-5.3-Flash (`glm53`) as the preferred cheap Workers Paid option, and can independently enable Gemma 4 31B for explicit escalation. Every external attempt still requires fresh host consent. The normalized theme, capped at 200 characters, is the only host or room content sent to a provider.
- Aggregate D1 model-usage rows enforce `MODEL_DAILY_CALL_LIMIT` (100 external attempts per UTC day by default) without retaining themes or generated topics. They aggregate reservation/completion and outcome counts, provider/model/task, input/output/total/cached-input/reasoning token totals, latency, and timestamps; they exclude room/member/authentication tokens and identities, not the model-token aggregates needed for cost monitoring. The protected `/api/v1/admin/model-usage` route returns global and daily provider aggregates. A configured external request without consent is rejected before budget reservation or provider contact. Missing credentials, invalid selectors, unavailable/exhausted budget, and provider/output failures return deterministic topics, while public status marks invalid or incomplete provider configuration as degraded. The slice performs no provider retry or Queue delivery.

The slice is modular and designed around Workers, Durable Objects, D1, Static Assets, Analytics Engine, and observability on free or low-cost allocations. The schema-v4 mapping adds only two small D1 metadata rows per browser; schema v5 adds one global row and one write per successful daily cleanup. Schema v6 adds one D1 table/index, while the Release-A consumer and Release-B producer add no Cloudflare service, binding, provider call, paid product, or user row; the D1 marker remains 6. Production best-effort room traffic adds neither a local outbox table nor a receipt write. Staging exact mode reuses private Durable Object SQLite and its existing alarm, and requires the already-documented room-fact HMAC secret. Visible profiles, accounts/authentication, cross-device access, external coaching AI, Queues, and R2 are not implemented. A future bilateral numeric-code linking flow must use a separate `IDENTITY_HASH_KEY`, require explicit consent on both browsers, and preserve the independent cloud-summary consent boundary. The topic-only providers do not perform coaching or transcript analysis.

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
- In the Cloudflare source, only the current host during setup can save, apply, or delete a named device-local setup kit. A kit captures the currently applied duration, silence limit, rounds, topic-pack selection, and custom topics; an unsent editor draft is not silently saved as applied room state.
- The kit store permits at most 25 records, limits a name to 40 Unicode code points, limits custom lists to 500 topics of 200 Unicode code points each, limits editor text to 20,000 characters, and caps the complete serialized store at 512 KiB. Duplicate names require an explicit overwrite. Storage corruption, an unsupported future store version, read failure, or quota failure must fail closed without overwriting the previous bytes.
- Applying a kit uses one existing same-origin `apply-setup-kit` room action. The Durable Object normalizes the bounded numeric settings, validates the topic source before committing, substitutes the server-canonical list for a built-in pack, rejects an unknown pack or empty normalized custom list without partial mutation, resets topic-deck state, and commits one atomic room version and topic generation. The local kit name is never sent, and non-host or already-started requests cannot mutate the room.
- Input normalization enforces server-side limits for settings, names, topics, and topic count.

### Topics — implemented

- Five preset packs are included.
- Custom lists accept one topic per line.
- Both editions can import/export custom lists as plain text and save browser-local setups. In the Cloudflare edition, import only fills the custom-topic editor draft; it does not change the room until the host explicitly uses that custom list. Export validates and canonicalizes the editor into one-topic-per-line `nonstoptalk-topics.txt` content, trimming surrounding line whitespace and removing blank or case-insensitive duplicate topics.
- Saving/deleting a Cloudflare setup kit and importing/exporting text are local browser operations: they make no application API, model-provider, product-analytics, D1, Analytics Engine, or Durable Object request. Only explicit Apply sends the selected settings/topics to the existing room Durable Object. Guests never receive the undrawn room topic list.
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
| Reliability | Go unit/handler tests, Cloudflare rules/platform tests, a shared versioned six-family game-rule contract, setup-kit module/action tests, 38 deterministic coaching/loop tests plus eight IndexedDB storage-contract tests (46 total), cloud-progress tests, and Playwright smoke flows cover core paths—including rejected-action atomicity, a two-browser Cloudflare WebSocket game with isolated identities and host-authorization rejection, setup-kit persistence/isolation and one-action convergence, calibration fast/gated paths and confidence caps, gate-action races, keyboard/320-pixel behavior, recording/transcription deferral, baseline/retry persistence gating/resume, comparison, legacy grouping, v1→v3 lifecycle migration, exact expiry/usage reporting, cap/quota summary-only outcomes, artifact-only deletion, storage rollback/fail-closed behavior, and cleanup-heartbeat failure/backlog/staleness behavior. Microphone calibration and optional local transcription still depend on browser, language pack, device, and room conditions. |
| Local persistence | `cmd/web` autosaves JSON every 10 seconds by default. `cmd/desktop` is memory-only. |
| Online durability | Each Cloudflare room has one SQLite-backed Durable Object, so state survives hibernation, Worker restarts, and deployments until its 30-day idle expiry. |
| Coaching persistence | IndexedDB v3 is the best-effort local summary/artifact source. Its required content-free lifecycle ledger gives new artifacts exactly 30 days from save and migrated artifacts exactly 30 days from upgrade, enforces a 128 MiB logical cap for new retention without evicting valid content, and preserves compact summaries for app-limit or browser-quota outcomes. A one-pass local snapshot gives Progress exact aggregate/per-attempt usage and deadlines without estimating browser quota or loading all Blobs together. Individual artifacts can be deleted without deleting their compact summaries or loop relationships. Incompatible storage fails closed, and the deployed Release-A floor remains compatible with an already-upgraded database. An independent opt-in can back up only compact summaries—including explicit relationship metadata—to D1 under an anonymous browser identity. Schema v4 internally maps that browser one-to-one to an opaque sync profile while all session operations remain device-owned. One device-level UTC-day-bucketed lease lasts at least 30 and less than 31 days after cloud use; new cloud saves stop once 250 summaries exist without forcibly deleting valid legacy rows. No account recovery or cross-device sync exists. |
| Privacy | Audio samples, recordings, and captured transcript text remain local. Default/off coaching makes no coaching-data API request; explicit backup sends only allowlisted summary fields. The saved Cloudflare setup-kit library remains in unencrypted origin/browser-local `localStorage`, unsynced and without recovery; local save/delete/import/export is uninstrumented and makes no application network request. Applying a kit sends its selected settings/topics only to the existing room Durable Object and performs no D1, Analytics Engine, model-provider, or cloud-backup work in that action. A later ordinary room milestone may include the applied duration, rounds, and topic-pack ID in HMAC-pseudonymous D1 room facts under the existing telemetry policy; kit names and custom-topic text remain excluded. Cloudflare external topic generation requires per-attempt host consent; the normalized theme, capped at 200 characters, is the only host or room content sent to a provider. Product analytics and provider-budget state are coarse aggregates rather than content records. The local Go edition's separately consented AI-judge path retains its documented provider boundary. |
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
8. The Cloudflare host can save the applied setup as a bounded device-local named kit, reload and reapply it with exactly one atomic room action, and import/export custom-topic text without a network or analytics request. An import remains only an editor draft until explicit use, while guests never receive undrawn topics.
9. The local Go app and native Cloudflare edition both provide the documented core game flow.

The coaching-prototype baseline is:

1. A user can open `/practice`, understand the privacy boundary, choose a scenario/goal/duration, and grant or deny microphone access.
2. With a synthetic or supported real microphone, medium/high-confidence calibration starts the timed attempt directly. Low-confidence calibration pauses first with keyboard-operable retry, continue-with-limited-evidence, and cancel controls that reflow at 320 pixels, reuse or release the current microphone as stated, start no recording/transcription while waiting, and make no coaching-data API request.
3. Ending or completing the attempt produces explainable evidence, a voice/quiet/unobserved timeline, one rule-selected strength/focus, one comparison drill, retrieved-card provenance that distinguishes used guidance from context-only retrieval, and a measurement-confidence explanation with its calibration, coverage/unobserved-time, callback-gap, and limiting-reason evidence. Low calibration keeps the attempt confidence low and any linked comparison limited.
4. When strict local recognition is absent, cannot initialize, or captures no text, the attempt completes without transcript-derived metrics or a remote fallback. A later error/timeout preserves text already received while marking it as possibly partial.
5. The default saved `/progress` summary contains aggregate metrics/advice and consented derived word patterns but no audio, raw sample frames, or captured transcript text.
6. Full-session retention starts unchecked; when selected, a recording and any available captured transcript are saved only in the separate local artifact store and receive individual download controls. Persisted `transcriptMayBePartial` metadata and Review/Progress warnings prevent a finalization error/timeout from being presented as complete text.
7. Progress reports exact local artifact logical use, the fixed app limit, and absolute retention deadlines from reconciled v3 state; browser quota remains explicitly unknown, and the readout makes no coaching-data request.
8. JSON export excludes full artifacts, and confirmed local-history deletion clears all local coaching stores.
9. Per-attempt artifact deletion removes the chosen recording/transcript while preserving the compact attempt and any paired comparison.
10. The default format can complete a review-only baseline, reload/resume the same locked setup from Progress, finish a review-only retry, and display only explicitly linked goal-specific descriptive evidence; single coached and legacy summaries remain independent.
11. Canceling during microphone permission, delayed worklet loading, or the calibration-readiness choice cannot start a late attempt and releases acquired media/interval work. Retry/continue/cancel races and stale callbacks cannot activate more than the one current, explicitly chosen path.
12. Missing active callbacks become unknown evidence and cannot manufacture continuous-speech advice; callback-free calibration fails with actionable copy instead of hanging.
13. Selecting compact cloud backup sends only the allowlisted summary, never media or captured transcript text; without that choice, local coaching behavior remains independent of D1.
14. Applying schema v4 backfills and maintains a one-browser/one-profile mapping without changing device-scoped session create/list/export/delete behavior, API payloads, or consent choices.
15. Applying schema v5 preserves all user tables, initializes one cleanup grace heartbeat, advances it only after a successful bounded cron, and degrades public status after 36 hours or while backlog remains.
16. Applying schema v6 preserves all schema-v5 records and compatibility queries, creates the constrained empty receipt table, advances the marker to 6, and leaves the 5/6 bridge functional without changing the configured normal-room delivery mode.
17. On schema 6, a canonical internal delivery applies its receipt-gated D1 effects once; an exact replay does not repeat them, an event-ID/payload conflict is rejected, and Analytics Engine receives at most one best-effort post-commit opportunity. The receiver has no public route; it is reached only by the private Durable Object consumer or explicit tests.
18. Scheduled cleanup removes expired receipts in bounded schema-6 batches and includes remaining receipt work in its shared backlog result; marker-5 cleanup never prepares receipt-table SQL.
19. In any environment configured `best-effort`, an ordinary room creates no local outbox schema or D1 receipt. A pre-existing valid version-1 local outbox is drained FIFO one event per alarm with persisted bounded retry/dead-letter state, and switching back to `best-effort` does not disable that drain.
20. With exact `outbox`, each real room mutation commits its authoritative state and complete ordered milestone group together with the shared alarm. A comma-only v1 sentinel in the existing private milestone header claims outbox ownership; Release A parses it as an empty event list and already removes that header, while Release B treats it as authoritative. An older/best-effort room response carries real milestone values and falls back to legacy delivery. Transaction replay keeps stable lifecycle/event IDs, final-turn pairs are all-or-drop, and a receiver retry cannot repeat receipt-gated D1 effects.
21. Staging exact-mode activation occurs only after the dormant Release-B code is fully deployed and schema 6 plus a cryptographically random room-fact key report ready. Production exact-mode activation requires the staging rollback/drain/restoration proof and repeated healthy exact smoke, both completed on 2026-09-02, plus a separate production review. The rollout avoids intentional version/configuration traffic splits even though both unavoidable propagation-skew directions are covered, and Release A is the minimum code rollback once any exact-mode local row may exist.

## Explicit backlog

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- Native desktop wrapper and installers
- Visible user profiles and profile management
- Family/content filters
- Post-turn AI summaries
- Full multiplayer-game feature parity between the Go and Cloudflare editions beyond the implemented online topic-draft and setup-kit slices; AI judge, microphone picker, and sound cues remain
- A formal accessibility audit
- Validated audio thresholds and confidence across representative microphones, browsers, room noise, and assistive setups
- Validated learning outcomes, repeatability, and interpretation for the implemented baseline → review → unassisted-retry comparisons
- Human-labeled false-tip, distraction, learning-outcome, privacy, and accent/language fairness studies
- Larger expert-reviewed/source-cited coaching-card curricula and validated retrieval relevance
- Coaching support in the local Go edition
- Accounts, cross-device authentication/history, guided programs, educator features, and optional external semantic/LLM coaching analysis
- Queue-backed provider execution and R2 media storage
