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
- An Anthropic API key only for Anthropic-backed grading and topic generation

## Implemented functional requirements

### Speech coaching prototype (native Cloudflare SPA)

- `/practice` offers interview-answer, presentation-opening, and impromptu prompts.
- The user chooses one focus: intentional pace, purposeful pauses, or steady delivery, plus a 30, 45, 60, or 90 second attempt.
- Microphone permission is requested after an explicit local-processing explanation.
- A four-second calibration samples the quiet room for two seconds and normal speaking for two seconds before the attempt.
- A browser `AudioWorklet` reduces microphone samples to RMS and peak frames; an `AnalyserNode` keeps the prototype usable when the worklet path cannot start.
- Browser-side analysis estimates speaking/silence time, pause events, longest speaking run, input-level consistency, clipping, signal coverage, unobserved time, and signal confidence. A level frame is held for at most 250 ms; longer callback gaps become unknown rather than fabricated delivery evidence. Zero callbacks produce an entirely unknown attempt with zero coverage/confidence and input-recovery advice.
- A seven-second calibration watchdog returns to setup if analysis frames stop. A wall-clock attempt deadline still finishes an active attempt when callbacks stall, and an ended input track either fails calibration or finishes the attempt with a warning.
- The selected goal and measured evidence lexically retrieve a curated coaching card bundled with the app; no LLM, embedding model, vector database, or network request is involved.
- Deterministic acoustic rules show at most one sparse live tip and separately select a post-attempt strength/focus. Local retrieval normally supplies the top card's prewritten drill; when an evidence-safety rule rejects an unsupported card, the measured priority supplies the drill instead. Deterministic template assembly appends a priority-specific comparison sentence, and the review says whether the card was used or retrieved only as context.
- Transcript analysis is optional. It starts only after consent and only when the browser exposes mandatory local-processing support; failed initialization or no captured text preserves the acoustic review without transcript metrics or a remote-recognition fallback.
- Transcript text is capped at 20,000 characters in memory and used to estimate word count, words per minute, filler patterns, and immediate repeated words. Finishing gives recognition up to two seconds to flush final results. A later timeout/error does not discard text already received, but that text is never described as complete.
- The compact summary retains bounded derived filler/repetition patterns after transcript consent; captured transcript text is discarded by default.
- Full-session retention is a separate, unchecked setup choice. When enabled in a `MediaRecorder`-capable browser, the attempt recording and any captured local transcript are stored in the separate `session-artifacts` IndexedDB store for this origin and browser profile. A timeout/error after captured text sets `transcriptMayBePartial` in persisted artifact-presence metadata and produces warnings in Review and Progress.
- `/progress` stores and displays compact summaries, exports summary JSON without audio or captured transcript text, and exposes individual recording/transcript downloads only when those artifacts exist.
- **Delete local history** clears both `session-summaries` and `session-artifacts` for the current origin and browser profile after confirmation.
- Coaching sample frames, summaries, recordings, and transcripts are never placed in a Durable Object or uploaded by the coaching code.

This is an implemented presentation prototype, not a validated measurement instrument. It is not a medical assessment, speech therapy, or a production learning-outcome claim.

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
| Usability | Fast game defaults, a focused coaching flow, large live surfaces, mobile layouts, and visible fallbacks are implemented. Formal time-to-start, distraction, or learning-loop usability testing has not been run. |
| Accessibility | Semantic labels, keyboard-operable native controls, visible focus styling, non-color text states, and reduced-motion CSS exist. WCAG 2.1 AA conformance has not been audited. |
| Reliability | Go unit/handler tests, Cloudflare rules tests, 21 deterministic coaching-engine tests, and Playwright smoke flows cover core paths, including grounding safety, zero/missing callback evidence, partial-transcript finalization, storage migration/download boundaries, and calibration/active-input stalls. Microphone calibration and optional local transcription still depend on browser, language pack, device, and room conditions. |
| Local persistence | `cmd/web` autosaves JSON every 10 seconds by default. `cmd/desktop` is memory-only. |
| Online durability | Each Cloudflare room has one SQLite-backed Durable Object, so state survives hibernation, Worker restarts, and deployments until its 30-day idle expiry. |
| Coaching persistence | IndexedDB v2 is scoped to the current site origin and browser profile and is best-effort browser storage. The summary store keeps aggregate measurements/advice and consented derived word patterns. The separate artifact store is populated only after an explicit full-session-retention choice. Site-data deletion, private browsing, storage pressure, or the in-app delete action may remove both. No account or cross-device sync exists. |
| Privacy | Coaching data remains in the browser and is not uploaded. The default path stores no attempt recording or captured transcript text; a separate opt-in can retain them locally and warns if transcript finalization may be partial. The Cloudflare game is classic-only. Local Go game transcripts are opt-in grading inputs; any configured external provider remains part of that edition's trust boundary. |
| Measurement validity | Signal formulas, local retrieval, and rules are inspectable, but thresholds and coaching-card relevance have not been validated across devices, noise conditions, languages, accents, disabilities, or speaking contexts. No universal speech-quality score or improvement target is claimed. |

## Current acceptance baseline

The repository's playable baseline is:

1. A host creates a room and seats at least two players.
2. Players can complete every turn in one or more rounds locally or from separate browsers.
3. Turns end through completion, silence detection, manual submission, or host override.
4. Scores and their components are visible.
5. Final standings and a winner are visible.
6. A bad microphone or judge outcome can fall back to classic/manual play and host score correction.
7. The local Go app and native Cloudflare edition both provide the documented core game flow.

The coaching-prototype baseline is:

1. A user can open `/practice`, understand the privacy boundary, choose a scenario/goal/duration, and grant or deny microphone access.
2. With a synthetic or supported real microphone, calibration leads to a timed attempt with live objective measurements and no coaching-media network request.
3. Ending or completing the attempt produces explainable evidence, a voice/quiet/unobserved timeline, one rule-selected strength/focus, one comparison drill, and retrieved-card provenance that distinguishes used guidance from context-only retrieval.
4. When strict local recognition is absent, cannot initialize, or captures no text, the attempt completes without transcript-derived metrics or a remote fallback. A later error/timeout preserves text already received while marking it as possibly partial.
5. The default saved `/progress` summary contains aggregate metrics/advice and consented derived word patterns but no audio, raw sample frames, or captured transcript text.
6. Full-session retention starts unchecked; when selected, a recording and any available captured transcript are saved only in the separate local artifact store and receive individual download controls. Persisted `transcriptMayBePartial` metadata and Review/Progress warnings prevent a finalization error/timeout from being presented as complete text.
7. JSON export excludes full artifacts, and confirmed local-history deletion clears both stores.
8. Canceling during microphone permission or delayed worklet loading cannot start a late attempt and releases any acquired media/interval work.
9. Missing active callbacks become unknown evidence and cannot manufacture continuous-speech advice; callback-free calibration fails with actionable copy instead of hanging.

## Explicit backlog

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- Native desktop wrapper and installers
- User profiles
- Family/content filters
- Post-turn AI summaries
- Full multiplayer-game feature parity between the Go and Cloudflare editions
- A formal accessibility audit
- Validated audio thresholds and confidence across representative microphones, browsers, room noise, and assistive setups
- An explicit baseline → review → unassisted retry relationship with goal-specific paired comparison
- Human-labeled false-tip, distraction, learning-outcome, privacy, and accent/language fairness studies
- Larger expert-reviewed/source-cited coaching-card curricula and validated retrieval relevance
- Coaching support in the local Go edition
- Accounts, cross-device history, guided programs, educator features, and optional semantic/LLM RAG analysis
