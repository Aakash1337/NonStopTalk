# Speech coaching prototype

This document explains the prototype as both a product walkthrough and a technical tour. It is written for someone who needs to demonstrate the feature, understand the code, and explain its limitations honestly.

> **Current boundary:** Practice and Progress are implemented only in the native Cloudflare SPA at `/practice` and `/progress`. The local Go game at port 8080 is unchanged. The multiplayer game is preserved. This is a work-in-progress rehearsal tool, not a clinical assessment, speech therapy product, or validated measure of speaking ability.

## What the prototype proves

The prototype demonstrates that NonStopTalk can add useful individual coaching without requiring a paid speech service or sending a person's voice to the application server.

It currently supports:

- Interview-answer, presentation-opening, and impromptu prompts
- One focus per attempt: intentional pace, purposeful pauses, or steady delivery
- 30, 45, 60, or 90 second attempts
- A four-second, session-specific microphone calibration
- Browser-side acoustic analysis through `AudioWorklet`, with an `AnalyserNode` compatibility path
- A recommended review-only baseline → review → unassisted-retry format, plus an alternative standalone format with sparse deterministic live cues
- A post-attempt strength, highest-value focus, evidence, and retry drill
- Explicit safe grouping and selected-goal baseline/retry measurements with limited-evidence guardrails and no improvement verdict
- Optional transcript-derived pace/filler/repetition evidence through strict on-device browser recognition; consented derived word patterns remain in the compact summary
- Aggregate session summaries in IndexedDB, plus JSON export
- Separate, off-by-default local retention of the attempt recording and available captured transcript, with partial-text warnings, per-attempt downloads, artifact-only deletion that preserves the summary/pair, and confirmed all-local-store history deletion

It does not prove that the current thresholds work equally well across microphones, rooms, languages, accents, disabilities, or browsers. The explicit pair and descriptive comparison are implemented, but they do not establish a learning outcome or prove that the retry improved.

## Try it locally

The coaching prototype is part of the Worker-with-Assets edition and supports Node.js 22 or newer. CI uses Node 24, so selecting 24 gives the closest parity. If `node --version` prints `v20...`, install Node 24 from the [official Node.js download](https://nodejs.org/en/download), reopen the terminal, and check again. If `nvm` is already installed, run `nvm install 24` followed by `nvm use 24`. Then:

```sh
node --version
npm ci
npm run test:coach
npm run test:cloud-progress
npm run db:migrate:local
npm run dev -- --local --ip 127.0.0.1 --port 8787
```

Confirm that the version check prints `v22...` or newer; `v24...` matches CI. Do not continue with Node 20.

Open:

```text
http://127.0.0.1:8787/practice
```

If port 8787 is occupied, stop the process using it or rerun `npm run dev -- --local --ip 127.0.0.1` without `--port`; then use the exact URL Wrangler prints. Loopback development and deployed HTTPS are secure contexts, which browsers require for microphone access and `AudioWorklet` module loading.

The local Go command serves the game, not this prototype:

```sh
go run ./cmd/web
# game at http://localhost:8080
```

## User flow

### 1. Set one goal

The setup asks for:

- **Practice format:** Baseline + unassisted retry (recommended) or Single coached attempt
- **Scenario:** Interview answer, Presentation opening, or Impromptu response
- **Goal:** Intentional pace, Purposeful pauses, or Steady delivery
- **Length:** 30, 45, 60, or 90 seconds
- **Optional transcript:** A separate checkbox that is enabled only when the browser exposes mandatory local-processing support
- **Optional full-session retention:** An independent, unchecked checkbox that is enabled only when the browser exposes `MediaRecorder`
- **Optional compact cloud backup:** An independent, unchecked checkbox that sends only the compact allowlisted summary

Choosing one goal limits the amount of advice and makes a later retry interpretable. The three prompts are fixed prototype content, not a curriculum or generated AI content.

The three optional data choices do different jobs. Transcript analysis adds pace/count/pattern evidence and bounded derived patterns to the summary. Full-session retention records the active attempt and can keep captured transcript text locally. Compact cloud backup sends only the narrower allowlisted summary to D1. None silently enables another, and all start off.

### 2. Consent and calibrate

The page explains the browser-local boundary and any selected retention before calling `getUserMedia`. The browser remains responsible for displaying and enforcing microphone permission.

Calibration lasts four seconds:

1. Approximately two seconds of quiet room sound estimate the local noise floor.
2. Approximately two seconds of normal speech estimate a useful speaking level.

The analyzer derives a threshold between those observations. This is more resilient than one global amplitude cutoff, but it is still sensitive to sudden noise, distance changes, automatic device processing, and a user who speaks during the quiet phase.

### 3. Speak in review-only or single-coached mode

The recommended baseline/retry format deliberately withholds live coaching. Both attempts show the prompt, selected focus, remaining time, and a microphone-connected state, but they do not mount the live level meter, live statistics, or coaching-tip surface. Measurements appear only after speaking, so the retry does not depend on live help.

The alternative **Single coached attempt** keeps the prior sparse-live-cue behavior. Its live page shows:

- Seconds remaining
- Normalized microphone level
- Estimated speaking ratio
- Detected pause count
- A simple Low/Clear/High input label
- At most one live cue

Tips are deliberately gated. No tip is considered during the first five seconds. A displayed cue stays visible for five seconds, and at least ten seconds must pass between displayed cues. Deeper advice waits for review.

### 4. Review evidence and one next action

The review contains:

- One measured strength
- One next focus with evidence
- One short retry drill
- Analyzed duration
- Speaking ratio
- Pause count and median pause
- Longest uninterrupted speaking run
- Input-level consistency
- A voice/quiet/unobserved timeline for the current review
- Unobserved duration when audio-level callbacks were missing
- Optional word count, words per minute, filler/repetition counts, and derived pattern labels when local transcript analysis captured text
- A warning when recognition finalization did not finish cleanly and captured text may be partial

The timeline exists only in the in-memory review. It is intentionally excluded from the stored summary.

### 5. Complete or resume the explicit practice loop

After a review-only baseline, **Prepare unassisted retry** opens a setup that locks the scenario, goal, and target duration to the baseline. The optional transcript, artifact-retention, and compact-backup controls remain visible and independently controllable. If the user leaves after the baseline, Progress shows **Complete unassisted retry**; resuming from there restores the locked comparison setup after reload and starts all three optional data controls unchecked. A single coached review instead offers **Try again** and remains an independent attempt.

The compact summaries store a secure opaque loop ID, the exact baseline attempt ID, an attempt role (`baseline`, `retry`, or `standalone`), and a feedback mode (`review-only` or `live-cues`). A baseline points to itself; a retry points to that exact baseline. Pre-loop analysis-schema-v2 summaries are treated as legacy standalone attempts.

Progress never pairs by timestamp. It compares only a valid explicit relationship with matching supported scenario, goal, target duration, and analysis schema. Duplicate baselines, malformed relationships, missing baselines, and setup mismatches remain visible as unpaired records.

For a valid pair, Progress and retry Review display raw baseline → retry values and descriptive deltas for only the selected goal:

- **Intentional pace:** eligible estimated WPM when both attempts contain at least 15 analyzed seconds and 25 recognized words, plus longest speaking run and median measured pause.
- **Purposeful pauses:** measured pauses per observed minute, median measured pause, and longest speaking run.
- **Steady delivery:** level consistency and clipping-frame percentage.

The comparison is labeled **Limited evidence** when either attempt contains less than 15 analyzed seconds, less than 75% signal coverage, low/unknown signal confidence, or no shared measurement for the selected goal. It still exposes the raw available values and explains the limitation. The UI explicitly says that slower/faster, more/fewer pauses, or another numerical direction is not automatically better, that input-level measures also reflect microphone/setup conditions, and that the pair is not a universal speaking score.

`/progress` always reads summaries for the current site origin and browser profile. After this browser has opted into compact backup, it also reads reachable D1 summaries and merges them by session ID; local records win so local-only artifact controls survive. This anonymous cookie is not an account or cross-device credential. One device-level UTC-day-bucketed lease controls all of its cloud summaries and lasts at least 30 and less than 31 days after cloud use. New saves stop when 250 summaries already exist; valid unexpired legacy rows remain available rather than being forcibly deleted.

The user can export merged summary JSON. When a completed attempt has separately retained artifacts, Progress shows local download and **Delete saved artifacts** controls and repeats any partial-transcript warning. Artifact-only deletion removes that attempt's artifact record and resets its artifact metadata in one IndexedDB transaction while preserving the compact summary and loop comparison. JSON never includes retained artifacts. Confirmed full-history deletion clears every local coaching store and, when backup is enabled and reachable, this anonymous browser's cloud summaries. Another domain, scheme, port, or browser profile has separate IndexedDB and cookie scope.

## Architecture and data flow

```text
Workers Static Assets
  └─ index.html + app.css + browser modules
       │
       ├─ /room/ABC234 ── JSON/WebSocket ──> Worker ──> room Durable Object
       │                                         (multiplayer game only)
       │
       └─ /practice
            │
            ├─ getUserMedia microphone track
            │    └─ AudioContext
            │         ├─ AudioWorklet preferred
            │         │    raw samples → ~100 ms RMS + peak frames
            │         └─ AnalyserNode compatibility path
            │              time-domain frames → RMS + peak
            │
            ├─ CoachingAnalyzer
            │    calibration → speech/pause segments → aggregate metrics
            │
            ├─ CoachingTipPolicy
            │    standalone snapshots → deterministic sparse cue
            │    review-only pair → policy disabled; no live cue/meter/stats
            │
            ├─ optional SpeechRecognition(processLocally = true)
            │    text → aggregate counts + bounded derived word patterns
            │
            ├─ optional MediaRecorder (separate consent)
            │    active attempt → encoded audio Blob
            │
            ├─ goal + evidence query
            │    → lexical retrieval over bundled coaching cards
            │    → normally top card's prewritten drill
            │    → evidence-safety fallback when card is unsupported
            │
            └─ rule-selected strength/focus
                 + supported drill + fixed comparison sentence → review
                  ├─ card labeled used guidance or retrieved context
                  ├─ explicit loop/baseline/role/feedback relationship
                  └─ IndexedDB v3 → safe relationship grouping → /progress
                       ├─ session-summaries ── optional allowlist ──> Worker API → D1
                       ├─ session-artifacts (only after separate opt-in)
                       └─ artifact-lifecycle (content-free policy ledger)

Default/off: no coaching-data API request
No audio, recording, or captured-transcript upload
No room Durable Object or external model in the coaching path
```

Cloudflare's [SPA asset routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/) serves `index.html` for `/practice` and `/progress`. The Worker/Durable Object remain responsible for multiplayer; the separate versioned platform API can store only compact summaries in central D1. It never receives coaching media or captured transcript text.

## Audio signal processing

### Why `AudioWorklet`

The Web Audio model separates page/control work from audio rendering work. `AudioWorkletProcessor.process()` receives small blocks of channel samples on the audio rendering thread. That provides a regular source of samples without running a per-sample loop inside DOM rendering or input handlers. See the [Web Audio specification](https://www.w3.org/TR/webaudio-1.1/) and MDN's [`AudioWorkletNode` reference](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode).

The processor does not recognize words. Its job is deliberately small: mix channels and reduce samples to two objective values.

### Channel mix

For each frame index, the worklet averages the available input channels:

```text
x[i] = (channel₁[i] + channel₂[i] + … + channelₘ[i]) / m
```

This produces one scalar sample `x[i]` per frame even when the microphone stream is multi-channel.

### Root-mean-square level

For `N` mixed samples:

```text
RMS = sqrt((x[1]² + x[2]² + … + x[N]²) / N)
```

RMS is an energy-like amplitude measurement. Digital audio samples normally lie between -1 and 1, so RMS is also in that range. It is not a sound-pressure-level measurement in decibels and cannot compare physical loudness across uncalibrated devices.

### Peak level

```text
peak = max(|x[1]|, |x[2]|, …, |x[N]|)
```

Peak helps detect samples close to the digital limit. It does not prove that the analog microphone never distorted before digitization.

### Frame interval

The worklet accumulates approximately `sampleRate / 10` samples before posting a message. At 48 kHz that is about 4,800 samples, or one message every 100 ms. It posts:

```js
{ atMs, rms, peak }
```

The application consumes the relative timing and levels. It does not retain the underlying samples.

### Compatibility path

If the worklet module or `AudioWorkletNode` cannot start, the page connects an `AnalyserNode`, reads 2,048 floating-point time-domain samples every 100 ms, and calculates the same RMS/peak shape on the page thread. This remains on-device but has less regular timing and more page-thread involvement.

## Calibration and speech classification

Calibration receives quiet and normal-speaking RMS/peak frames. It derives a noise estimate, speaking-level estimate, and speech thresholds for the current attempt; the analyzer carries a fixed digital clipping boundary of `0.98`.

The core idea is:

```text
quiet observations ─┐
                    ├─> session threshold ─> classify each ~100 ms frame
speech observations ┘                         as voice, silence, or unknown
```

### Calibration statistics

The engine sorts the RMS observations and uses quantiles so one unusually loud frame has less influence than it would have on a simple maximum:

```text
quiet median  = Q50(quiet RMS)
quiet ceiling = Q90(quiet RMS)
voice floor   = Q20(voice RMS)
voice median  = Q50(voice RMS)
voice upper   = Q80(voice RMS)
separation    = voice floor − quiet ceiling
```

When usable separation is at least `0.002`, the on/off boundaries are placed inside that gap:

```text
speech-on  = quiet ceiling + 0.45 × separation
speech-off = quiet ceiling + 0.20 × separation
```

When the two calibration phases do not separate, conservative fallbacks derive boundaries from the quiet ceiling and voice median and mark confidence low. Final thresholds are clamped to valid digital-amplitude ranges.

The engine also derives a target voiced-RMS band from the speech-on threshold and the 20th/50th/80th voice quantiles. That band is relative to this microphone session; it is not a physical decibel target.

### Hysteresis and segments

Hysteresis means a silent frame must rise to `speech-on` to enter voice, while an existing voice segment stays active until it falls below the lower `speech-off` boundary. The two boundaries reduce rapid voice/silence flicker around one value.

After classification:

- An interior segment shorter than `120 ms` is merged when both neighbors have the opposite, matching label. This removes a brief classification glitch.
- A **pause** is an interior silence of at least `400 ms` with voice before and after it. Leading and trailing quiet are not counted as pauses.
- A speaking run bridges an interior quiet gap of at most `250 ms`, so a tiny dip does not split the run.
- One level frame describes at most the next `250 ms`. If another callback arrives later, the remainder is labeled **unknown**, not projected as voice, silence, or clipping.
- Unknown segments are never glitch-merged into speech, never counted as a pause, and always break a speaking run.

These values live in `COACHING_THRESHOLDS` and have deterministic boundary tests. They are engineering defaults, not universal definitions of speech quality.

If an active analyzer receives zero level callbacks, the whole elapsed attempt is one unknown segment: observed duration and coverage are `0`, confidence is `0`, and the first priority is to restore stable input rather than change delivery.

### Calibration confidence

Calibration confidence combines sample evidence and relative quiet/voice separation:

```text
sample evidence      = clamp(min(quiet count, voice count) / 12, 0, 1)
relative separation  = clamp(separation / max(voice median, quiet ceiling + 0.01), 0, 1)
calibration score    = 0.45 × sample evidence
                     + 0.55 × clamp(relative separation / 0.45, 0, 1)
```

Scores at least `0.75` are labeled high; scores at least `0.50` are medium; the rest are low. The label describes available signal evidence, never the speaker.

## Metrics and what they mean

| Metric | Calculation shape | What it can support | Important limitation |
| --- | --- | --- | --- |
| Attempt duration | End time minus attempt start, capped by target duration | Wall-clock attempt/progress timing | It includes both observed and unobserved time, but never exceeds the selected target |
| Observed duration | Voice duration plus silence duration | Amount of time backed by held level frames | Each frame is held for at most 250 ms; missing callbacks reduce it |
| Unobserved duration | Attempt duration minus observed duration | Discloses missing level evidence instead of inventing delivery behavior | It does not explain why callbacks stopped |
| Signal coverage | `observed duration / attempt duration` | Caps confidence and protects advice when input is unstable | It is an availability measure, not speaking quality |
| Voiced time | Sum of frames/segments classified as speech | Speaking ratio and speech-run lengths | Music, echo, and noise can be classified as voice |
| Speaking ratio | `voiced duration / observed duration` | Describing talk/silence balance only where frames exist | Higher is not inherently better; unknown time is deliberately excluded |
| Pause count | Count of qualifying unvoiced segments between speech | Identifying delivery breaks | It is not a linguistic sentence-boundary detector |
| Median pause | Median duration of qualifying pause segments | A robust description of typical measured pauses | A short attempt may have too few pauses to be meaningful |
| Longest pause | Maximum qualifying pause duration | Finding a possible loss-of-flow moment | Silence at the edge of an attempt must be interpreted differently from mid-speech silence |
| Longest speaking run | Longest voiced run after bridging interior quiet gaps of at most `250 ms` | Detecting a long run without a reset | Noise can merge runs; a long run is not automatically bad |
| Level consistency | `0.7 × in-calibrated-band ratio + 0.3 × stability`, where `stability = clamp(1 − coefficient of variation / 0.75)` | Input/delivery stability for this setup | It mixes voice behavior with distance, gain, compression, and mic handling |
| Clipping percentage | Frames with `peak ≥ 0.98` divided by analyzed frames | Warning about possible digital overload | This is a sample-frame ratio, not a physical loudness value; analog distortion and browser processing can occur below that point |
| Audio confidence | Heuristic label based on calibration separation and usable evidence | Communicating uncertainty | It is not a statistical confidence interval |

Metrics are evidence for a chosen practice goal, not components of one hidden score. A user should primarily compare like-for-like attempts on the same goal, device, and environment.

Level consistency is withheld until at least eight voiced frames and one second of measured speech are available. A consistency of at least `0.75` is labeled consistent, at least `0.50` mixed, and lower values variable.

Attempt-level measurement confidence combines five pieces of evidence:

```text
score = 0.25 × calibration confidence
      + 0.20 × sample density
      + 0.25 × observed-duration evidence (full at 15 seconds)
      + 0.25 × voice evidence (full at 5 seconds)
      + 0.05 × callback continuity

final score = min(weighted score, signal coverage)
```

Sample density compares observed frames with a conservative minimum of `max(8, observed duration / 250 ms)`. Signal coverage is the observed/attempt-duration ratio and acts as a hard confidence ceiling: missing frames are not evidence. The same high/medium/low label boundaries apply. This is a transparent heuristic, not a probability that the advice is correct.

## Optional transcript measurements

The prototype does not send audio to a transcription service. When the user checks the option and the browser exposes mandatory local processing, it creates `SpeechRecognition`, sets `processLocally = true`, supplies the active microphone track, and keeps interim text in memory up to 20,000 characters. Failed initialization or an attempt with no captured text yields no transcript metrics.

At finish, the page calls `recognition.stop()` and allows up to two seconds for final `onresult` delivery and clean termination. A recognition error or timeout after text arrived does not erase that text: the analyzer may use it, but Review warns that it may be partial. With separate full-session retention, both the artifact and summary artifact metadata set `transcriptMayBePartial`, so Progress repeats the warning. Error events and their payloads are never retained, and the application never describes captured text as complete.

At finish, the deterministic transcript analyzer computes:

- Word count
- Words per minute as `word count / (analyzed milliseconds / 60,000)`
- Filler count and rate per 100 words from the explicit prototype list: `you know`, `I mean`, `kind of`, `sort of`, `um`, `uh`, `erm`, `er`, and `hmm`
- Adjacent repeated-word count and rate per 100 words

Words are Unicode letter/number tokens with internal apostrophes; matching is case-normalized. Multiword filler matches reserve their token positions so the same words are not double-counted by another filler pattern. “Very very” counts one immediate repetition; separated repetitions do not.

The compact summary retains numeric aggregates plus bounded derived pattern arrays: each array keeps at most 50 filler/repeated-word entries, and each label is trimmed to at most 64 characters. These labels are not the captured transcript, but they can still contain sensitive lexical content—for example, an immediately repeated name. Captured transcript text is then cleared by default. A summary without that text cannot support later context review. Filler markers and repetitions can be intentional, and recognition errors, punctuation, language mismatch, or an unavailable local language pack can make these estimates wrong. The prototype does not attempt a remote fallback, semantic relevance, structure, sentiment, emotion, or accent scoring.

The Web Speech on-device APIs are experimental and browser-dependent. MDN documents [`processLocally`, availability checks, and language packs](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API#on-device_speech_recognition). The current prototype detects the mandatory-local property and fails back to acoustic analysis if recognition cannot start; it does not manage language-pack installation.

## Optional full-session artifacts

Attempt-recording/captured-transcript retention is independent from transcript analysis and starts unchecked on a fresh page load. The standalone **Try again** and direct baseline-to-retry setup preserve visible selections so the user can review or uncheck them; resuming an unfinished retry from Progress resets transcript analysis, artifact retention, and compact backup to unchecked. If `MediaRecorder` is unavailable, the setup disables retention and compact summaries still work.

When selected:

1. `MediaRecorder` attaches to the same microphone stream after calibration, so the four-second calibration is not part of the recording.
2. It prefers Opus WebM, then WebM, then Opus Ogg when the browser reports support; otherwise it lets the browser choose a default.
3. Approximately one-second encoded chunks remain in page memory while the attempt runs.
4. Finishing stops the recorder and combines non-empty chunks into an audio `Blob`.
5. The application saves that encoded `Blob` and any captured transcript to `session-artifacts`, linked to the summary by ID.

Recording retention does not enable transcription. If transcript analysis was off or produced no text, the artifact may contain audio only. If the recorder failed but captured transcript text exists, a transcript-only artifact can be saved. Canceling or navigating away stops the recorder, clears pending chunks, and saves no unfinished artifact.

Progress can delete one attempt's saved recording/captured transcript without deleting its compact summary. The summary metadata, artifact, and required lifecycle row change in one transaction, so an explicit baseline/retry relationship and its measurement comparison remain available. IndexedDB v3 gives new artifacts exactly 30 days and gives valid v1/v2 artifacts exactly 30 days from migration. New artifacts share a 128 MiB logical cap without eviction; app-limit and browser-quota outcomes retain the compact summary only and report that the artifact was not retained. Browser storage is best-effort and may disappear earlier, and expiry cleanup occurs on a later storage access. There is no quota dashboard or app-level encryption, and downloaded files remain outside application control.

## Small local RAG, deterministic tips, and advice

The prototype uses a small retrieval-augmented generation pattern entirely inside `coach-engine.js`:

```text
selected goal + measured evidence
  → lexical query
  → ranked match from curated in-app coaching cards
  → normally keep top card's prewritten drill intact
  → otherwise keep an evidence-backed priority drill
  → fixed comparison sentence selected from the top measurement priority
  → separate rules select strength/focus and assemble the review
  → review labels the card as used guidance or retrieved context
```

It is labeled **retrieval-augmented deterministic generation**, where “generation” is bounded template assembly. Normally the engine keeps the retrieved drill intact and appends one prewritten, metric-specific comparison sentence. An evidence-safety rule can substitute the measured priority's drill when the retrieved card would add unsupported advice. This is not the common production RAG stack: there is no LLM, embedding model, vector database, remote corpus, or network request.

“Deterministic” means the same measurements and goal lead to the same live-tip, strength/focus, retrieved-card, used-card, safety-override, and comparison-template decisions. When a card contributes the base drill, that contribution is traceable to curated product material without introducing a variable model response.

This design was chosen for the presentation prototype because it is:

- **Private:** the query and card library stay in the browser.
- **No-cost:** there is no inference, embedding, or database service.
- **Low-latency:** the card library is already loaded with the application.
- **Auditable:** a reviewer can inspect every card, ranking rule, and source label.
- **Testable:** controlled evidence can assert the exact retrieved card, whether it was actually used, and the resulting advice.

A future LLM-backed RAG layer could retrieve richer curriculum passages and generate more contextual explanations. It would also add provider/model behavior, embeddings or another semantic index, latency, cost, consent and retention boundaries, source/version governance, prompt-injection defenses, and a much larger relevance, safety, and fairness evaluation.

### Curated corpus and ranking

Version 1 freezes six product-owned cards:

| Card ID | Coaching idea | Source label |
| --- | --- | --- |
| `idea-boundary-pause` | Use a pause to separate complete ideas | NonStopTalk Coaching Library · Delivery foundations v1 |
| `recover-after-gap` | Recover from a long gap with one landing sentence | NonStopTalk Coaching Library · Delivery foundations v1 |
| `protect-input-level` | Stabilize gain and microphone distance | NonStopTalk Coaching Library · Recording basics v1 |
| `pace-with-breaths` | Shape pace at sentence boundaries | NonStopTalk Coaching Library · Delivery foundations v1 |
| `replace-fillers-with-silence` | Replace one filler/repetition pattern with a quiet beat | NonStopTalk Coaching Library · Delivery foundations v1 |
| `repeat-and-compare` | Build a longer, comparable practice baseline | NonStopTalk Coaching Library · Practice method v1 |

The retrieval query contains only the selected goal and aggregate evidence flags, such as unstable signal coverage, clipping, variable level, long run/gap, estimated fast pace, filler count, or a short attempt. Raw or recognized transcript text is never inserted into the retrieval query.

The lexical ranker:

1. Lowercases Unicode letter/number tokens.
2. Removes a small English stop-word list and normalizes a simple trailing plural `s` on longer tokens.
3. Gives each query match `4` points in card tags, `2` in its title, `1` in its excerpt, and `0.5` in its drill.
4. Sorts by descending score and uses frozen corpus order as the deterministic tie-break.
5. Treats a score below `4` as too weak to claim grounding, returns at most two qualifying cards in the current advice call, and otherwise returns `repeat-and-compare` as a score-zero fallback.

The grounding record exposes retrieval mode, generation mode `deterministic-template`, library version, `usedCardId`, retrieved cards, source labels, scores, and matched terms. `usedCardId` identifies the card only when its drill actually contributed; it is `null` when an evidence-safety rule supplies the drill. The review therefore says either that the card shaped the retry or that it was retrieved as context. For example, missing callbacks require the restore-input drill and must not turn a lexical match into unsupported microphone-distance advice. The numeric retrieval score is a ranking aid, not a probability or coaching-quality score.

The live policy evaluates acoustic conditions for pauses/long speech runs, level consistency, and clipping. Choosing the pace or pauses goal lowers the acoustic long-run threshold; transcript-derived WPM, fillers, and local card retrieval happen only after the attempt for review advice, not live tips. The surrounding UI adds three anti-distraction controls:

1. Five seconds of attempt evidence before any cue is considered.
2. Only one visible cue at a time, shown for five seconds.
3. A minimum ten-second interval between displayed cues.

The main engineering defaults are:

| Decision | Current qualifying evidence |
| --- | --- |
| Live clipping cue | At least 20 analyzed frames over at least 3 seconds, with at least 3 clipping frames and at least 2% of frames clipping |
| Live resume cue | Current silence at least 2.5 seconds after at least 1.5 seconds of measured speech |
| Live intentional-pause cue | Current bridged speaking run at least 18 seconds for a pace/pauses goal, or 28 seconds otherwise |
| Live steady-distance cue | Variable input status after at least 8 seconds of speech and 20 voiced frames |
| Review: restore stable input | Attempt at least 3 seconds and either at least 1 second unknown or signal coverage below 75%; this priority outranks delivery advice |
| Review: protect recording | At least 20 frames, at least 3 clipping frames, and at least 2% clipping |
| Review: create idea boundary | Longest bridged speaking run at least 25 seconds and no completed pause of at least 400 ms |
| Review: plan next landing point | At least one pause and longest pause at least 3 seconds |
| Transcript review eligibility | Attempt at least 15 seconds and at least 25 recognized words |
| Review: reduce pace | Eligible transcript estimate above 180 words per minute |
| Review: replace filler | At least 3 filler markers and at least 4 per 100 recognized words |
| Review: immediate repetition | At least 2 adjacent repeats and at least 2 per 100 recognized words |
| Review: collect longer baseline | Attempt shorter than 8 seconds |

Transcript word count, WPM, fillers, and repetitions never drive live cues. They are calculated after the attempt and can influence only review advice. When signal coverage is unstable, the engine prioritizes restoring input, avoids calling level consistency a strength, and suppresses the long-run/long-pause delivery priorities that missing frames could fabricate. These thresholds make the prototype behavior easy to reproduce; they have not been validated as universal coaching norms.

The post-attempt builder assembles this structure:

```text
strength
  ├─ title
  └─ measured evidence

focus next
  ├─ title
  └─ measured evidence

drill
  ├─ title
  └─ normally top retrieved card's intact retry instruction
       or evidence-backed priority instruction after a safety override
       + one fixed comparison sentence selected by the top priority

grounding
  ├─ curated coaching-card identity/source
  ├─ lexical score and matched terms for this goal/evidence
  └─ usedCardId = card ID when used, otherwise null
```

Advice wording is intentionally behavioral. It may say to insert a reset pause, move closer to the microphone, or reduce clipping; it must not say the speaker is anxious, dishonest, unprofessional, or medically impaired.

The fixed comparison suffix makes the retry measurable:

| Top priority | Appended comparison |
| --- | --- |
| Restore a stable input signal | Confirm stable signal coverage before comparing delivery measurements |
| Protect the recording | Compare clipping-frame percentage |
| Keep microphone distance steady | Compare level consistency |
| Create an idea boundary | Compare longest speaking run and measured pause count |
| Plan the next landing point | Compare longest measured pause |
| Leave more room between phrases | Compare estimated WPM and repeat its transcript-dependent caveat |
| Replace one filler pattern | Compare possible filler markers per 100 words |
| Finish the word, then continue | Compare immediate repetitions per 100 words |
| Collect a longer baseline | Use the longer attempt as the baseline for one comparable retry |
| No priority | Compare the same selected measurement with this attempt |

## IndexedDB v3 storage schema

Database and stores:

```text
database: nonstoptalk-coaching (version 3)
stores:   session-summaries
          session-artifacts
          artifact-lifecycle
key:      id in all three stores
indexes:  createdAt in summary/artifact stores
          expiresAtMs in artifact-lifecycle
```

Opening version 3 upgrades an existing version-1 or version-2 database by preserving `session-summaries`, adding missing stores/indexes, and backfilling every structurally valid retained artifact in the same atomic upgrade. Every artifact that needs a backfilled row uses one upgrade timestamp and receives `expiresAtMs = retainedAtMs + 2_592_000_000`, exactly 30 days. A valid earlier lifecycle deadline is preserved rather than extended. Structural incompatibility or a failed migration aborts the upgrade and leaves the prior version intact.

`coach-storage.js` owns this persistence boundary. `artifact-lifecycle` is required, content-free bookkeeping: each row contains the matching ID, retained/expiry times, logical byte count, lifecycle schema version, and migration-grace flag, but never audio, MIME type, transcript text, or derived words. Logical size is `audioBlob.size` plus the transcript's exact UTF-8 byte length. A new artifact receives exactly 30 days from its save timestamp. Expired artifacts become unavailable and are removed on the next storage operation, along with their lifecycle row and summary artifact-presence flags; compact analysis and pair relationships remain.

New retained artifacts share a 128 MiB logical cap. Reconciliation and save occur in one read/write transaction, so overlapping tabs cannot commit beyond the limit. The app does not evict another valid, unexpired artifact to make room. Structurally valid migrated content is marked `legacyGrace` and is preserved for its one-time 30-day window even if it is over the individual or aggregate cap; new saves remain blocked until they fit. An app-limit outcome commits only the compact summary. If the browser raises `QuotaExceededError`, the complete artifact transaction aborts before a second summary-only transaction is attempted. Review distinguishes `app-limit` from `browser-quota`; if the summary-only retry also fails, the save fails rather than claiming persistence.

Storage corruption fails closed. Incompatible required stores or key paths abort/reject opening, and an incompatible already-current/future expiry index is rejected. Malformed, future-dated, expired, orphaned, summary-mismatched, or byte-mismatched artifacts are not returned; reconciliation removes the artifact and ledger row and clears only the summary's artifact flags. Connections close on `versionchange`. Active v3 code can reopen a compatible newer version after `VersionError`, and the deployed Release-A floor can similarly operate on an already-upgraded v3 or compatible newer origin without requesting a downgrade. IndexedDB stays at its current version, and rollback cannot restore an artifact already expired or deleted.

“Compatible newer version” has a narrow, frozen meaning: the three stores keep `id` key paths; the lifecycle `expiresAtMs` index remains single-entry and non-unique; lifecycle-v1 core fields keep their existing types/meaning; expiry remains no later than the exact 30-day boundary; and logical bytes remain exact `Blob.size + UTF-8 transcript bytes`. Additive fields/stores/indexes are allowed. Reinterpreting those invariants requires a new rollback floor.

Conceptual summary record:

```js
{
  analysisSchemaVersion: 2,
  id,
  createdAt,
  scenario,
  goal,
  targetDurationMs,
  practiceLoopId,       // null for standalone
  baselineAttemptId,    // null for standalone; self ID for a baseline
  attemptRole,          // standalone | baseline | retry
  feedbackMode,         // live-cues | review-only
  metrics: {
    durationMs,
    observedDurationMs,
    unknownMs,
    coverageRatio,
    maxSampleGapMs,
    voicedMs,
    speakingRatio,
    pauseCount,
    medianPauseMs,
    longestPauseMs,
    longestSpeakingRunMs,
    levelConsistencyPct,
    clippingPct,
    audioConfidence,
    transcriptMetrics: null | {
      wordCount,
      wordsPerMinute,
      fillerCount,
      fillerRatePer100Words,
      repeatedWordCount,
      repetitionRatePer100Words,
      fillerOccurrences: [{ phrase, count }],
      repeatedWords: [{ word, count }]
    }
  },
  advice: {
    strength,
    strengthEvidence,
    focus,
    focusEvidence,
    drill,
    drillDetail
  },
  artifacts: {
    audioStored,
    audioBytes,
    audioMimeType,
    transcriptStored,
    transcriptMayBePartial
  }
}
```

Conceptual full-artifact record, created only after the separate retention choice:

```js
{
  id,            // same ID as its summary
  createdAt,
  audioBlob,     // Blob | null
  audioMimeType,
  transcript,    // captured string, possibly empty
  transcriptMayBePartial
}
```

The full in-memory review also contains speech/pause segments and local-retrieval grounding (retrieved cards, `usedCardId`, source, score, and matched terms). `buildCoachingSummary` deliberately excludes segments, grounding metadata, raw frames, raw audio, and captured transcript text, while retaining the allowlisted aggregate metrics, derived word patterns, advice, and artifact-presence metadata—including `transcriptMayBePartial`. If an artifact exists, the summary and artifact are written in one IndexedDB transaction.

The cloud allowlist is narrower again: it keeps schema/ID/time, scenario/goal/target duration, the four explicit relationship fields when present, aggregate metrics, optional bounded derived word patterns, and normalized advice. It strips the complete `artifacts` object as well as arbitrary extra fields before the Worker validates the payload again. Raw samples, recordings, captured transcript text, and artifact-presence metadata therefore remain local. D1 also populates its reserved `practice_loop_id`, `baseline_attempt_id`, and `attempt_role` columns; `feedbackMode` remains in validated summary JSON.

JSON export reads only `session-summaries` and adds product/export schema metadata. It therefore includes explicit loop relationships, consented derived pattern labels, and artifact-presence metadata—including the partial-text flag—but never the audio `Blob` or captured transcript text. The visible card source remains available only in the immediate review, not historical `/progress` records. Artifact download/delete buttons address one `session-artifacts` record at a time; recording extensions follow its MIME type, and transcripts download as UTF-8 `.txt` files.

## Privacy and consent checklist

| Boundary | Prototype behavior |
| --- | --- |
| Opening Practice | Does not open the microphone |
| Microphone | Browser permission requested after an explanation |
| Default audio path | Reduced in the audio graph; not recorded, persisted, or uploaded |
| Live measurement frames | Kept in page memory for the active attempt |
| Transcript analysis | Separate opt-in; mandatory local processing; derived counts/patterns enter the summary; captured text cleared by default |
| Transcript finalization | Waits up to two seconds after `stop()`; preserves returned text on error/timeout, warns that it may be partial, and never retains error payloads |
| Full-session retention | Independent, unchecked opt-in; stores attempt audio and any available captured transcript in `session-artifacts` |
| Stored summary | Aggregate metrics, consented derived patterns, normalized advice, and artifact-presence metadata—including `transcriptMayBePartial`—in origin-scoped IndexedDB |
| Practice relationship | Secure opaque loop and baseline IDs plus fixed attempt-role/feedback-mode enums; contains no media or captured transcript text |
| Compact cloud backup | Independent, unchecked opt-in; sends only the narrower summary allowlist to D1 under a hashed anonymous browser identity; one device-level day-bucketed 30–31-day inactivity lease; new saves stop once 250 exist |
| Export | Summary store only; excludes audio `Blob` and captured transcript text |
| Individual download | Reads the opted-in artifact and creates a recording file or UTF-8 transcript file |
| Delete one artifact | Removes one `session-artifacts` record and its required lifecycle row, and resets that summary's artifact metadata in one transaction; the compact summary/pair remains |
| Delete all history | Clears every local coaching store after confirmation; previously downloaded files are outside its scope |
| Navigation/cancel | Stops recognition/recorder, discards unsaved chunks, stops microphone tracks/worklet/intervals/context, and rejects delayed permission/worklet activation |
| Cloudflare Durable Object | Multiplayer room state only; receives no coaching data |
| Central D1 | Explicitly backed-up compact summaries, consent, anonymous expiry, and aggregate platform facts; never media/captured transcripts |
| External model | None in the coaching prototype |

See [AI and Privacy](AI_AND_PRIVACY.md) for how this differs from the local Go game's optional AI judge.

## File tour

Read the implementation in this order:

1. **`cloudflare/public/index.html`** — the persistent document shell and primary navigation.
2. **`cloudflare/public/app.js`** — the Practice/Progress lifecycle and storage/cloud handoff.
3. **`cloudflare/public/coach-storage.js`** — IndexedDB v3 lifecycle persistence, typed summary-only outcomes, migration, and Release-A/future-schema rollback compatibility.
4. **`cloudflare/public/coach-loop.js`** — pure relationship validation, safe grouping, and descriptive selected-goal comparison guardrails.
5. **`cloudflare/public/cloud-progress.js`** — the narrow cloud-summary allowlist and versioned API client.
6. **`cloudflare/public/coach-audio-worklet.js`** — the small sample-to-RMS/peak processor.
7. **`cloudflare/public/coach-engine.js`** — calibration, metrics, retrieval, tips, grounding, and advice.
8. **`cloudflare/platform.ts`** — Worker-side validation, anonymous ownership, relationship columns, D1 retention, and aggregate analytics.
9. **`scripts/smoke-coach.mjs`** — browser-level proof using synthetic media, the complete pair/resume flow, local stores, lifecycle races, and default/off network assertions.
10. **`scripts/smoke-coach-storage.mjs`** — hash-pinned, same-origin browser proof for v3 migration, retention/cap/corruption behavior, and Release-A rollback/restoration.
11. **`wrangler.jsonc`** — Static Assets SPA fallback plus Worker/Durable Object bindings for the separate multiplayer API.

## How to explain the implementation

Use this sequence instead of starting with file names:

1. **Capture:** `getUserMedia` provides a live track after permission.
2. **Reduce:** AudioWorklet turns thousands of samples into about ten RMS/peak frames per second.
3. **Calibrate:** Quiet and speaking examples adapt the threshold to this attempt.
4. **Classify:** The analyzer turns frames into voiced/unvoiced segments with timing stability.
5. **Measure:** Segment durations and voiced levels produce inspectable aggregate metrics.
6. **Retrieve:** The selected goal and measured evidence rank curated local coaching cards.
7. **Assemble advice:** The top retrieved card normally supplies the intact base drill; an evidence-safety rule can keep the measured priority's drill instead. Deterministic rules append one metric-specific comparison sentence, select strength/focus, and record whether the card was used.
8. **Store and relate by consent:** The default path clears live media/captured text and writes a local summary with explicit standalone or baseline/retry metadata. Separate choices may write a linked local artifact or send the narrower compact-summary allowlist to D1. Progress validates relationships before grouping or comparing them.

This makes the privacy boundary and the coaching mechanism understandable without calling every calculation “AI.”

## Verification

Run the focused checks:

```sh
npm ci
npm run test:coach
npm run test:cloud-progress
npm run smoke:coach
npm run typecheck:cloudflare
npm run check:cloudflare
```

Run the complete repository baseline before release:

```sh
go test ./...
go test -race ./...
go vet ./...
npm run test:coach
npm run test:cloud-progress
npm run typecheck:cloudflare
npm run test:cloudflare
npm run check:cloudflare
npm run smoke:platform
npm run smoke:coach
npm run smoke:coach-storage
npm run smoke
```

What each coaching check demonstrates:

- `test:coach` runs 41 tests: 34 across controlled frames/transcripts, the pure engine, legacy/explicit relationships, persistence gating, safe grouping, immutable comparisons, exact goal measures, and limited-evidence guardrails, plus seven storage-contract tests for the required v3 schema, exact retention, Blob/UTF-8 byte accounting, conservative lifecycle validation, metadata scrubbing, and quota classification.
- `smoke:coach` drives `/practice` with synthetic media through both the standalone live-cue path and the default baseline → Progress/reload/resume → review-only retry path. It covers UI integration, comparison, artifact-only deletion, v1→v3 opening, active-v3 operation against a compatible future schema, expiry, app-limit/browser-quota summary-only messages, composed warnings, and asserts that default/off local-first paths make no coaching-data API request.
- `smoke:coach-storage` serves immutable Release-A and current modules on one origin. It covers fresh schema/atomic triads, shared-timestamp v2→v3 Unicode backfill, exact expiry, fail-closed corruption, summary-only cleanup, exact cap edges, grace migration/no eviction, a real two-tab cap race, upgrade abort/retry, malformed/blocked/incompatible schemas, and hash-pinned v3 → Release A → v3 rollback/restoration.
- `test:cloud-progress` checks the separate opt-in allowlist, relationship metadata/legacy compatibility, merged-history behavior, API calls, and preference state; platform tests cover Worker relationship validation, identity, expiry, analytics, and local-artifact stripping.
- `smoke:platform` starts an isolated local Wrangler/D1 environment and exercises status, backup, relationship-field round trip and reserved D1 columns, export, aggregate analytics, privacy rejection, and cloud deletion.
- `check:cloudflare` confirms that the Worker and all Static Assets, including the coaching modules, form a valid deploy bundle.

These tests do not replace real-device, accessibility, security, or fairness validation.

## Known limitations and explicit work in progress

- Audio thresholds and advice rules are prototype defaults, not validated norms.
- Calibration is short and can be contaminated by noise or incorrect user behavior.
- Browser-requested echo cancellation/noise suppression changes the signal; actual device behavior varies.
- The AudioWorklet fallback has different timing characteristics.
- Strict on-device speech recognition is experimental and uneven across browsers/languages.
- Transcript analysis uses simple English token/rule matching, not semantic understanding.
- Fixed prompts, fixed goals, and English UI are prototype content.
- Progress implements explicit baseline/retry pairing and descriptive selected-goal changes, but those changes have not been validated as learning outcomes or improvement directions.
- The local coaching-card library is intentionally small; retrieval is lexical rather than semantic and still requires relevance/fairness evaluation.
- Derived filler/repetition labels may contain sensitive words even though they are not captured transcript text.
- Retained artifacts support per-attempt deletion, exact 30-day app retention, and a no-eviction 128 MiB logical cap. IndexedDB remains best-effort: storage pressure, private mode, browser policy, site-data deletion, or database failure can remove or block data earlier, and deadline cleanup happens only on a later storage operation. There is no quota dashboard, persistent-storage request, configurable retention, or app-level encryption, and anyone with access to the unlocked browser profile may reach artifacts before deletion or expiry.
- No accounts, recovery, cross-device authentication/sync, educator view, or shared report exists. Anonymous D1 backup is tied to one browser identity.
- No external coaching AI, Queue-backed provider work, or R2 media storage exists.
- No formal WCAG, security, privacy, microphone/device, learning-outcome, or subgroup-fairness study has been completed.
- The coaching feature is absent from the local Go edition.
- The tool does not diagnose or treat a communication disorder.

## Next measurement plan

The first pilot should collect enough evidence to decide whether to refine or expand the coach:

- Completed baseline → review → unassisted retry loops
- Paired goal-specific changes, reported as distributions
- Human/user-rated false-tip rate
- Reported distraction and tip frequency
- Microphone/calibration and strict-local-transcription availability by device/browser/language
- Automated network privacy violations
- Measurement repeatability under the same setup
- Availability and false-tip differences across voluntary, sufficiently sized language/accent groups

Do not set adoption or improvement targets until the event definitions, measurement noise, and pilot population are known. See [Coaching Presentation Guide](COACHING_PRESENTATION_GUIDE.md#4-measurement) for operational definitions and guardrails.

## Glossary

| Term | Plain-language meaning |
| --- | --- |
| Acoustic measurement | A number calculated from the sound signal, such as energy, peak level, or timing; it does not imply that words were understood. |
| `getUserMedia` | The browser API that asks permission for a live microphone/camera stream. NonStopTalk requests audio only. |
| `AudioContext` | The browser object that owns a Web Audio processing graph. |
| `AudioWorklet` | A small custom audio processor that runs with the browser's audio rendering work and receives blocks of samples. |
| RMS | Root mean square: an energy-like average amplitude for a block of samples. |
| Peak | The largest absolute sample amplitude in a block. |
| Voice-activity detection | Estimating whether a time region contains speech-like signal. This is not word recognition. |
| Calibration | Observing the current quiet room and speaking level to derive session-specific thresholds. |
| Threshold | A boundary used to classify a measurement, such as speech versus non-speech. It is an engineering rule, not a human diagnosis. |
| Hysteresis | Using different enter/exit boundaries or timing so classifications do not flicker when a signal sits near one threshold. |
| Segment | A contiguous measured interval labeled voice or pause. |
| Deterministic | Given the same inputs and configuration, the rule produces the same output. |
| `SpeechRecognition` | An experimental browser API that can turn speech into text. NonStopTalk uses it only when mandatory on-device processing is exposed and chosen. |
| `MediaRecorder` | A browser API that encodes a live media stream. NonStopTalk uses it only after the separate full-session-retention choice. |
| Artifact | An explicitly retained encoded attempt recording and/or captured transcript stored separately from the compact summary. |
| WPM | Words per minute: transcript word count divided by analyzed minutes. It inherits transcription errors. |
| IndexedDB | Best-effort structured browser storage scoped to one site origin and browser profile. It is not a server database or automatic cloud backup, and storage pressure may remove it. |
| SPA | Single-page application: one HTML shell changes the visible page in JavaScript as the URL changes. |
| Worker | Cloudflare's server-side JavaScript runtime. It handles multiplayer APIs and the opt-in compact-summary platform API, but never receives coaching audio/recordings/captured transcripts. |
| Durable Object | A Cloudflare object that coordinates and stores one multiplayer room. It is not used for coaching analysis/history. |
| D1 | The central relational store for explicitly backed-up compact summaries and aggregate platform records. It is not used for coaching media or live room authority. |
| RAG | Retrieval-augmented generation: retrieve relevant context, then use it to shape an output. This prototype uses lexical retrieval plus deterministic templates locally—no LLM, embeddings, vector database, or network. |
| Baseline | A first, unassisted attempt used as the comparison point for a specific goal. |
| Unassisted retry | A linked second attempt made with the same scenario, goal, and target duration and without live measurements or coaching cues. Its raw delta is descriptive evidence, not proof of learning or improvement. |
| Driver metric | A measurable step that helps explain whether users can reach the desired outcome. |
| Guardrail metric | A measurement that detects harm or a tradeoff while optimizing the main outcome. |

## Sources

- [Web Audio API 1.1 specification](https://www.w3.org/TR/webaudio-1.1/)
- [MDN: AudioWorkletNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode)
- [MDN: on-device speech recognition](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API#on-device_speech_recognition)
- [Lewis et al.: Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://papers.nips.cc/paper_files/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html) — origin of the RAG framing; this prototype uses a much smaller deterministic local adaptation, not that paper's neural architecture
- [Cloudflare: Single Page Application routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Cloudflare: Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Liang et al., A Survey of Automated Presentation Coaching](https://aclanthology.org/2026.bea-1.4/)
- [ASHA: Accent Modification](https://www.asha.org/Practice-Portal/Professional-Issues/Accent-Modification/)
