# Speech coaching presentation guide

This guide turns the prototype into a clear product story. It is written for a five-minute presentation, with optional technical depth for questions afterward.

**Short preparation path:** Follow [Learn NonStopTalk in 45 minutes](LEARN_IN_45_MINUTES.md), then keep the [presentation cheat sheet](PRESENTATION_CHEAT_SHEET.md) beside the live demo. This document remains the canonical long-form narrative and Q&A reference.

> **Prototype status:** The coaching experience is an early, local-first prototype in the native Cloudflare SPA. It demonstrates objective browser analysis, optional strict on-device transcription, deterministic retrieval/template advice, an explicit review-only baseline → review → unassisted-retry loop, descriptive goal-specific comparison, local progress, separately opted-in recording/captured-transcript retention with per-attempt deletion, and an independent compact-summary backup. It is not a medical tool, a speech-language assessment, a validated learning intervention, or a finished AI coach.

## The one-sentence pitch

NonStopTalk turns private speaking rehearsal into a deliberate-practice loop: speak, see a small number of explainable signals, receive one useful next action, and try again.

## The narrative

### 1. Problem

People know that rehearsing helps, but practicing alone has a missing feedback loop:

- They cannot reliably notice their own pacing, long pauses, filler words, or microphone problems while speaking.
- Listening back takes time and still does not tell them what to work on first.
- Generic scores such as “72% confident” are hard to trust or act on.
- A live human coach is valuable, but is not always available for every repetition.

The opportunity is not to replace a human coach. It is to make the repetitions between human feedback sessions more focused and measurable.

### 2. Constraints

The prototype was designed around constraints that materially change the solution:

| Constraint | Why it matters |
| --- | --- |
| Privacy | A voice can contain personal and sensitive information. Microphone audio and transcripts should not leave the browser merely to produce basic coaching. |
| Consent and retention | Derived word patterns, attempt recordings, and captured transcripts have different sensitivity. The product must make their storage choices independent, default full-artifact retention off, and provide understandable export/delete controls. |
| Browser variability | Microphones, room noise, device gain, and browser speech APIs differ. The product must expose fallbacks and avoid pretending every signal is equally reliable. |
| Cognitive load | The user is already planning what to say. Too many live warnings would make speaking harder instead of helping. |
| Explainability | Advice must connect to an observable measurement and a concrete next attempt. A single opaque “speech quality” score would hide both uncertainty and tradeoffs. |
| Fairness | Accent and dialect are not defects. The prototype must not infer confidence, emotion, honesty, personality, health, or identity from voice. |
| Cost and deployment | The demonstrator must run locally and on low-cost/free Cloudflare primitives without a paid speech or AI service. |
| Time | This is a presentation prototype, so it proves the core loop before accounts, synchronization, curriculum, or production validation. |

### 3. Design

The resulting design has seven layers:

1. **Private signal extraction.** An `AudioWorklet` receives microphone sample frames on the browser's audio rendering thread and reduces them to objective measurements such as level, clipping, speech time, and pauses. Raw frames are not stored or sent to the application server.
2. **Optional local words.** If the browser can guarantee `SpeechRecognition.processLocally`, the user may opt into transcript analysis for pace and word-pattern estimates. Bounded derived filler/repetition patterns stay with the summary; captured transcript text is discarded by default. If strict local recognition is unavailable, the audio-only coach still works.
3. **Small local retrieval.** The selected goal and measured evidence form a query over a curated set of coaching cards shipped with the application. Lexical retrieval selects relevant context; there are no embeddings, vector database, model, or network request.
4. **Review-only comparison plus optional sparse coaching.** The recommended baseline and linked retry withhold live meters, statistics, and tips until review. The alternative single coached format can show sparse live acoustic tips. Transparent rules separately choose review strength/focus. Normally the highest-ranked card supplies the intact base drill. If the measurements do not support that card's advice, a safety rule keeps the measurement-backed drill and labels the card as retrieved context instead of used guidance. A fixed template appends what to compare. The same inputs produce the same result.
5. **Explicit, safe local progress.** The browser stores compact summaries—including consented derived patterns and opaque loop/baseline/role/feedback metadata—in origin-scoped IndexedDB for `/progress`. Progress groups only validated explicit relationships, never recency, and shows raw selected-goal deltas with limited-evidence reasons/caveats. JSON export contains those summaries, not retained audio or captured transcript text.
6. **Separate artifact choice.** An unchecked `MediaRecorder` option can retain the active-attempt recording and any available captured transcript in a second local store. Recognition gets up to two seconds to finish; if it times out or errors after returning text, Review and Progress warn that the retained transcript may be partial. These artifacts never upload and can be deleted per attempt without deleting its compact summary or comparison.
7. **Separate compact backup choice.** A third unchecked control may send only allowlisted measurements/advice and bounded derived word-pattern fields to central D1. One UTC-day-bucketed device lease controls this anonymous browser's summaries and lasts at least 30 and less than 31 days after cloud use. New saves stop when 250 summaries already exist; migration does not forcibly delete valid unexpired legacy rows. It is not an account or cross-device credential.

This is **retrieval-augmented deterministic generation**: a retrieved card normally supplies an unchanged base drill, then bounded template assembly appends one prewritten metric-comparison sentence. Evidence-safety rules can substitute a supported drill and leave the card as context only. It is a small local RAG pattern, not the common “vector database + LLM” stack. It was chosen because it is private, no-cost, fast, inspectable, and testable card by card. A production LLM-backed RAG layer could retrieve richer curriculum passages and generate contextual language, but it would add model/version behavior, embeddings or another search index, latency, cost, privacy/consent boundaries, source governance, prompt-injection defenses, and substantially more evaluation.

The multiplayer game remains available as **Play**. Coaching is a new **Practice** path rather than a replacement for the game.

### 4. Measurement

The product should be evaluated as a deliberate-practice tool, not by maximizing time on site or the number of tips shown.

#### Primary outcomes

| Metric | Operational definition | Decision it supports |
| --- | --- | --- |
| Completed deliberate-practice loop | Number of comparable practice loops in which a user completes a baseline, reviews the evidence and advice, and completes an unassisted retry, divided by loops started. | Are people reaching the part of the experience that can create learning? |
| Unassisted retry change | Paired raw change from baseline to an unassisted retry on the one goal selected for that loop, reported as a distribution rather than a universal score or automatic improvement direction. | What changes after review, and is that change distinguishable from normal measurement noise in a consented pilot? |

The current prototype supplies secure loop IDs, exact baseline links, fixed attempt-role/feedback-mode fields, locked scenario/goal/duration on retry, and a review-only mode with live meter/stat/tip surfaces absent. It reports raw selected-goal baseline → retry values and descriptive deltas only for valid explicit pairs. Evidence is labeled limited when either attempt is under 15 analyzed seconds, under 75% coverage, low/unknown confidence, or lacks a shared measurement. Until repeated pilot data establishes normal measurement noise and interpretation, report those raw deltas and limitations—not a pass threshold, learning outcome, or better/worse verdict.

The platform's in-progress analytics attempt only coarse room/summary-save/delete/consent aggregates, including bounded timing/count values. D1 rollups and Analytics Engine delivery are both best-effort and can miss events; neither is an audit log. They do not contain speaking ratios, word patterns, advice, or evidence that establishes learning outcomes. An initial study still needs separately consented paired attempt data and facilitator/user ratings. Do not treat every browser event as an independent person.

#### Drivers

- Baseline completion, review reach, retry start, and retry completion rates.
- Percentage of sessions that produce enough valid audio for the selected goal.
- Percentage of sessions in which strict on-device transcription is available when a transcript-dependent goal is selected.
- Time from the end of speaking to a usable review.

#### Guardrails

| Guardrail | How to measure it | What a bad result means |
| --- | --- | --- |
| False-tip rate | Tips marked “not accurate” by the speaker or a consented human reviewer, divided by tips rated; also audit against labeled pilot recordings. | Thresholds, calibration, or rule wording need revision. |
| Distraction | Post-session report that a live tip interrupted the speaker, paired with tips per minute and abandoned sessions immediately after a tip. | Reduce live-tip frequency or move that class of advice to the review. |
| Microphone availability | Sessions with a usable input and successful calibration divided by microphone attempts, segmented by browser/device. | Improve setup, compatibility, and fallback guidance. |
| Local-transcription availability | Sessions where the browser verifies strict on-device recognition divided by requests for transcript-assisted coaching, segmented by browser/language. | Do not make transcript metrics part of the universal experience. |
| Privacy network violations | Automated and manual network audits that observe audio samples, audio blobs, or transcript text leaving the browser. | This is a release blocker; the expected count is zero. |
| Retention-boundary violations | Automated checks that full retention starts unchecked, artifacts appear only after that choice, summary export excludes full artifacts, per-attempt deletion preserves the compact pair, and full-history deletion clears both local stores. | Stop release and repair consent/storage boundaries before adding more data features. |
| Retrieval grounding quality | Human review of whether the retrieved card matches the goal/evidence and whether the review truthfully labels it as used guidance or context only, plus the percentage of advice views that display a valid curated source. | Revise card vocabulary, ranking, evidence-safety rules, fallback, or wording before expanding the library. |
| Subgroup fairness | Compare availability, false-tip rate, and selected-goal deltas across voluntary, sufficiently sized language/accent groups and device classes. Never infer group membership from audio. | Investigate thresholds, copy, recognition coverage, and sampling before broad claims. |

No adoption, improvement, or fairness target is claimed yet. The first pilot should validate event definitions, measurement repeatability, and subgroup coverage; targets come after there is a trustworthy baseline.

## Five-minute talk track

### 0:00–0:35 — Open with the problem

> “Most of us know we should rehearse interviews and presentations. The hard part is that, while we are speaking, we cannot reliably observe our own pace, pauses, filler words, or audio setup. Afterward, a vague score is not useful. We need one piece of evidence and one next action.”

Show the NonStopTalk landing page and point out that **Play**, the original game, remains intact while **Practice** adds a new product direction.

### 0:35–1:15 — State the constraints

> “Voice is sensitive, browser support is uneven, and feedback can itself become distracting. I also wanted this to run without a paid speech service. Those constraints led to a local-first design: objective signal processing in the browser, optional transcription only when the browser guarantees on-device processing, and no audio or transcript upload.”

Open `/practice` and show the privacy explanation before granting microphone access.

### 1:15–2:25 — Demonstrate the loop

1. Start a short practice attempt.
2. Speak naturally and intentionally include one observable behavior, such as a long pause or an audible filler.
3. Point out that the recommended baseline is review-only: the timer and prompt remain visible, while the live meter, statistics, and tips are deliberately absent. Mention that sparse live cues exist only in the alternative single coached format.
4. End the attempt and open the analysis.
5. Connect one measurement to one recommendation and its provenance: “The browser observed X, retrieved this curated product card, so the next attempt asks me to do Y.” Make clear that the source label identifies the bundled card; it is not an independent evidence rating.
6. Show **Prepare unassisted retry** and its locked setup. For a five-minute talk, use a non-sensitive completed pair prepared on the same origin rather than spending another calibration/attempt live; show the raw selected-goal comparison and its limitation/caveat copy.

Use careful language:

- Say “the browser detected signal above its speech threshold,” not “the system understood that I was confident.”
- Say “estimated words per minute from an on-device transcript,” not “your true speaking speed.”
- Say “practice signal,” not “diagnosis” or “speech quality score.”

### 2:25–3:30 — Explain the technical design

> “The microphone feeds an AudioWorklet, which reduces sample blocks into RMS and peak measurements. The page aggregates those into speech time and pauses. After the attempt, the goal and evidence query a small local card library. Optional on-device recognition adds pace and word-pattern estimates. The compact summary stays local unless I separately select online backup; recordings and captured transcripts always stay in this browser.”

Show the architecture diagram in [Speech Coaching Prototype](SPEECH_COACHING_PROTOTYPE.md#architecture-and-data-flow).

### 3:30–4:20 — Show progress and measurement

Open `/progress`.

> “Progress is intentionally not one universal grade. It pairs only an explicitly linked review-only baseline and unassisted retry, then shows raw measurements for the selected goal with signal limitations and caveats. That is a descriptive comparison, not proof that the person improved.”

Name the guardrails: false tips, distraction, hardware and local-transcription availability, network privacy, and subgroup fairness.

### 4:20–5:00 — Close with the boundary and next step

> “This prototype proves that private, explainable coaching and an explicit baseline/retry measurement loop can coexist with the original social game and deploy on the free web stack. It does not prove learning outcomes, work equally on every microphone, or replace a speech-language professional. The next step is a small, consented pilot: validate repeatability and interpretation of those pairs, then set targets only after we have evidence.”

## Demo runbook

### Before the presentation

The coaching-capable edition supports Node.js 22 or newer. CI uses Node 24, so selecting 24 gives the closest parity. If `node --version` prints `v20...`, install Node 24 from the [official Node.js download](https://nodejs.org/en/download), reopen the terminal, and check again. If `nvm` is already installed, run `nvm install 24` and `nvm use 24`. Then, from the repository root:

```sh
node --version
npm ci
npx playwright install chromium
npm run test:coach
npm run test:cloud-progress
npm run smoke:coach
npm run db:migrate:local
npm run dev -- --local --ip 127.0.0.1 --port 8787
```

Confirm that `node --version` prints `v22...` or newer; `v24...` matches CI. Do not continue with Node 20. The smoke check launches and stops its own Wrangler process, so run it before the stable presentation server. If port 8787 is occupied, omit the explicit port and use the exact URL Wrangler prints.

Then:

1. Open `http://127.0.0.1:8787/practice` in the browser you tested.
2. Grant microphone permission and perform one throwaway attempt so permission prompts and device levels are known.
3. Confirm `/progress` displays the completed summary at the exact origin you will present (scheme, host, and port all matter).
4. Decide whether the demo needs full-artifact retention. It starts unchecked. If you demonstrate it, use non-sensitive words, verify the recording/transcript download buttons, then delete local history and any downloaded test files.
5. Clear practice history only if you want a clean presentation state; this clears summaries and browser-stored artifacts for that origin.
6. Close video-conference audio processing or other applications that may take exclusive microphone control.
7. Keep a second tab with this guide and the architecture document open.

Use headphones if the presentation is remote to reduce echo cancellation and feedback. Do not promise that the audience's browser will support strict on-device transcription; demonstrate the audio-only path first.

### A stable live sequence

1. Show the landing page and choose **Practice**.
2. Explain the two independent options. Transcript analysis may retain bounded derived patterns; full-session recording/captured-transcript retention is separate and starts off.
3. Keep the recommended baseline/retry format and start a short baseline with all optional choices off for the safest primary demo.
4. Speak, pause for about one second, resume speaking, then finish. A measured pause needs voice on both sides; ending on silence is intentionally treated as trailing quiet, not a completed pause.
5. Explain the analysis, deterministic recommendation, and the Local RAG label that distinguishes used guidance from retrieved context.
6. Show **Prepare unassisted retry**, the locked scenario/goal/duration, and the explicit no-live-cue promise. Complete it only when presentation time allows; otherwise use a prepared pair from this exact origin.
7. Open **Progress** to show the grouped loop, resumable state or completed goal comparison, raw delta, and signal limitations.
8. If your tested browser supports strict local recognition, demonstrate it separately and show pace/filler estimates as an enhancement.
9. If artifact retention is part of the presentation, repeat with that box explicitly enabled, then show per-attempt download and deletion controls and explain that JSON export still excludes retained artifacts while deletion preserves the compact summary.

### Fallbacks

- **Microphone permission fails:** Explain that a secure context and permission are required, then use the already completed summary in `/progress`.
- **No strict local transcription:** This is expected on many browser/language combinations. Show audio-only metrics and explain fail-closed behavior.
- **No `MediaRecorder`:** Full-session retention is disabled, but coaching and compact summaries still work.
- **No IndexedDB:** Review can still render, but the attempt may not save and Progress cannot load local history. Use a prepared result in the tested browser profile.
- **Noisy room:** Use the result to explain why calibration, confidence indicators, and device testing are explicit roadmap items.
- **Network is unavailable:** An already-running local Wrangler server can demonstrate browser processing. A loaded deployed tab is not a guaranteed offline fallback because there is no service worker and the coaching engine is loaded as a separate module.
- **Live demo risk is unacceptable:** Keep a completed summary at `/progress` on the same presentation origin and walk through it while narrating the data flow. If artifact buttons matter, prepare a non-sensitive opted-in attempt on that exact origin. If you want a screenshot fallback, capture it before the talk; no prepared screenshot is shipped in the repository. Do not enable a remote transcription fallback.

Practice requires microphone input. Play's manual timer is a game fallback, not a coaching fallback.

## Likely audience questions

### “Is this AI?”

The prototype does not use a generative model. It analyzes measured signals with transparent rules and retrieves a local card. Normally that card contributes its unchanged drill; if its advice lacks measurement support, a safety rule uses the measured priority's drill and shows the card as context only. A fixed comparison sentence is appended either way. Some people group this retrieval-and-response-assembly pattern under AI; the precise explanation is lexical retrieval plus deterministic template assembly, all in the browser. The optional transcript comes from the browser only when strict on-device recognition is supported.

### “Are we using RAG?”

Yes, in a deliberately small local form. The selected goal and aggregate evidence become a lexical query over bundled coaching cards. The top card normally contributes its prewritten drill. If an evidence-safety rule substitutes the measured priority's drill, the review calls the card retrieved context rather than used guidance. Deterministic assembly appends one comparison sentence, and separate rules supply strength/focus. There is no LLM, free-form model prose, embedding model, vector database, or network call, so call it **retrieval-augmented deterministic generation**, not LLM RAG.

That choice makes tomorrow's prototype private, free, low-latency, auditable, and deterministic. A production LLM RAG system could add semantic retrieval and more personalized phrasing, but it would also add provider/model behavior, cost, latency, source/version governance, privacy consent, prompt-injection risk, and a larger evaluation burden.

### “Does my voice go to Cloudflare?”

No audio, recording, or captured transcript goes to Cloudflare. Compact summaries are written locally to IndexedDB. If the user explicitly selects online backup, only an allowlisted summary goes to the NonStopTalk Worker/D1 platform; with backup off, coaching makes no coaching-data API request. Room Durable Objects never receive coaching data.

### “What is stored by default?”

Every successfully saved attempt gets a compact local summary with aggregate measurements and advice. If transcript analysis was explicitly enabled, that summary can also contain bounded filler/repeated-word labels and counts; those derived words may still be sensitive. An attempt recording and the captured transcript are not retained by default.

### “Can I keep or download the recording and transcript?”

The separate unchecked full-session-retention option records the active attempt. It keeps a captured transcript only when transcript analysis also returned text. Recordings and captured transcripts live in a separate origin-local artifact store, never enter cloud backup, and are excluded from JSON export. A finalization error/timeout is visibly marked possibly partial. Progress can delete one attempt's artifacts while preserving its summary/pair. Local artifacts still have no automatic expiration, and deleting browser data cannot delete downloaded files.

### “How does it know when I am speaking?”

It calculates signal energy from small blocks of microphone samples and compares that level with a threshold. Sustained above-threshold blocks count as speech; below-threshold time contributes to pauses. This is voice-activity estimation, not speech understanding, and noise can fool it.

### “Why use an AudioWorklet?”

AudioWorklet processing runs with the browser's audio rendering work instead of relying on irregular UI timers. It provides regular sample blocks while keeping heavy per-sample work away from rendering and input handlers. The page receives compact measurements rather than storing raw sound.

### “What proves these boundaries work?”

Thirty-four deterministic coaching/loop tests cover calibration, segmentation, confidence, tips, transcript analysis, retrieval, grounding safety, template assembly, relationship validation, persistence gating, safe grouping, goal-specific comparison, and advice. The browser smoke covers both feedback modes, baseline → Progress/reload/resume → retry, local storage, artifact-only deletion, lifecycle behavior, and no coaching-data API request on local-first default/off paths. Separate cloud-progress and platform tests cover relationship metadata, legacy compatibility, the summary allowlist, reserved D1 columns, versioned APIs, anonymous ownership/expiry, and aggregate analytics. These are implementation checks, not real-device accuracy, accessibility, privacy certification, fairness, usefulness, or learning-outcome studies.

### “Why not send audio to a more accurate model?”

That could improve some metrics, but it changes the privacy, cost, latency, consent, and vendor boundaries. This prototype first tests how useful a local, explainable baseline can be. Remote or bring-your-own-key analysis can be a separate, explicit opt-in later.

### “Can it judge confidence, emotion, or honesty?”

No, and it should not claim to. The prototype reports observable acoustic and transcript-derived behaviors. It does not infer internal state, identity, health, truthfulness, personality, or professionalism.

### “Does it penalize accents?”

It is not designed to grade an accent. Transcript-dependent metrics are unavailable when strict local recognition is unsupported and can still contain recognition errors when enabled. Fairness must be validated across voluntary language/accent groups, and users should be compared primarily with their own baseline. ASHA notes that accents and dialects are natural language variations, not communication disorders.

### “Is this speech therapy?”

No. It is a general speaking-practice tool for rehearsal. It does not diagnose or treat communication disorders and is not a substitute for a qualified speech-language pathologist.

### “How do you know it helps?”

We do not claim that yet. The prototype implements the loop and descriptive measurement, not its learning effect. A pilot must measure repeatability, completed baseline/retry loops, paired goal-specific distributions, false tips, distraction, availability, privacy, and fairness before learning-outcome claims, direction labels, or numeric targets are justified.

### “Why keep the game?”

The game is an approachable way to practice speaking under pressure with other people. Practice provides deliberate individual feedback; Play provides social repetition. They share a mission but keep separate rules and scoring so an intentional coaching pause is not treated like a game failure.

## What to learn before presenting

1. Follow the timed [45-minute learning guide](LEARN_IN_45_MINUTES.md), including its checkpoints and one audio-only attempt.
2. Trace one signal from microphone sample to summary, then trace one Play action from the public Worker API to a room Durable Object.
3. Practice the exact RAG, storage, and Durable Object answers on the [presentation cheat sheet](PRESENTATION_CHEAT_SHEET.md).
4. Use the [prototype file tour](SPEECH_COACHING_PROTOTYPE.md#file-tour) only when you need deeper implementation detail.
5. Rehearse the five-minute talk once with the live demo and once using only the prepared Progress fallback.

## Sources and responsible-use basis

- The [Web Audio specification](https://www.w3.org/TR/webaudio-1.1/) defines the control/rendering thread model and `AudioWorkletProcessor`.
- MDN documents [AudioWorkletNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode), including its secure-context requirement and browser availability.
- MDN's [on-device Web Speech guide](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API#on-device_speech_recognition) documents `processLocally` and language-pack availability; these APIs remain browser-dependent.
- Lewis et al.'s [original RAG paper](https://papers.nips.cc/paper_files/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html) provides the retrieval-plus-generation framing. NonStopTalk uses a deliberately smaller deterministic local adaptation, not its neural architecture.
- Cloudflare documents [SPA routing with Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/) and [SQLite-backed Durable Objects on Workers Free](https://developers.cloudflare.com/durable-objects/). Durable Objects remain part of multiplayer coordination, not coaching-media processing.
- Liang et al.'s [survey of automated presentation coaching](https://aclanthology.org/2026.bea-1.4/) identifies low-latency diagnosis, limited annotated corpora, and accent-fair feedback as open challenges.
- ASHA's [Accent Modification practice guidance](https://www.asha.org/Practice-Portal/Professional-Issues/Accent-Modification/) explains that accents are natural language variations, not communication disorders, and emphasizes functional, user-chosen goals.
