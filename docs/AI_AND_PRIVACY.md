# AI and privacy

This document describes the current NonStopTalk implementation. There are three distinct paths with different boundaries:

1. The local and online multiplayer game, which can run with classic scoring and no transcript.
2. The optional AI judge and topic generator in the local Go game edition.
3. The speech-coaching prototype in the native Cloudflare SPA, which performs analysis and curated coaching-card retrieval in the browser and calls no coaching or AI service.

NonStopTalk does not upload microphone audio in any of these paths. In coaching only, a separate unchecked option can record the active attempt and retain it locally in this site's browser storage. That option never sends the recording to the Worker or another service.

## At a glance

| Situation | Microphone audio | Transcript | External AI |
| --- | --- | --- | --- |
| Coaching, default acoustic path | Reduced to measurements in the browser; no recording retained | None | None |
| Coaching with transcript analysis only | Reduced in the browser; no recording retained | Mandatory-on-device captured text is discarded after analysis; bounded derived counts and filler/repetition patterns remain in the summary | None |
| Coaching with separate full-session retention | When recording succeeds, the browser-encoded attempt is stored locally as a `Blob`; never uploaded | Captured text is also stored locally only if transcript analysis was enabled and produced text | None |
| Classic game with microphone detection | Read locally by Web Audio | None | None |
| Manual game timer | Not required | None | None |
| Local Go AI judge enabled, speaker chooses classic/manual | Not uploaded | None | None |
| Local Go AI judge, speaker consents, no Anthropic key | Read locally; not uploaded | Sent to the trusted Go server and graded by its offline heuristic | None |
| Local Go AI judge, speaker consents, Anthropic key configured | Read locally; not uploaded | Sent to the Go server, then topic + transcript are sent to Anthropic | Anthropic grading |
| Theme generation without an Anthropic key | Not involved | Not involved | None; server templates generate the pack |
| Theme generation with an Anthropic key | Not involved | Not involved | The host's theme text is sent to Anthropic |

## Coaching consent and boundary

Opening `/practice` does not start the microphone. The setup explains that analysis is on-device, and the browser asks for microphone permission only after the user starts calibration. Permission remains controlled by the browser and can be revoked.

The user can opt into experimental transcript analysis. That checkbox is enabled only when the browser exposes a `SpeechRecognition` object with the mandatory-local-processing property. NonStopTalk then:

1. Creates recognition for the current microphone track.
2. Sets `processLocally = true` before starting.
3. Uses transcript text for word count, words-per-minute, filler-pattern, and immediate repeated-word estimates.
4. Writes bounded derived counts and pattern labels to the compact local summary.
5. Clears the captured transcript after building the review unless the user also selected full-session retention.
6. Never falls back to browser-managed remote recognition.

If recognition is absent, cannot be initialized, rejects the track, or captures no text, the acoustic attempt continues without transcript metrics. At finish, NonStopTalk asks recognition to stop and allows up to two seconds for final results. If an error or timeout occurs after `onresult` has delivered text, NonStopTalk preserves and analyzes that text but never calls it complete; Review warns that it may be partial. When the separate full-session option retains the text, both the artifact and summary artifact metadata set `transcriptMayBePartial`, so Progress warns too. Recognition error events and their payloads are never retained. The browser owns its implementation of the experimental Web Speech API; NonStopTalk relies on the browser to honor mandatory local processing.

Full-session retention is an independent second checkbox and starts unchecked on a fresh page load. It is enabled only when `MediaRecorder` exists. If selected, recording begins after calibration when the attempt starts. On completion, the application saves the encoded attempt recording when recording succeeds and any captured transcript that is available to a separate local artifact store. A transcript-only artifact can still be saved if recording fails after transcript analysis returned text. Selecting recording retention does not silently enable transcription; selecting transcript analysis does not silently retain captured transcript text. **Try again** preserves both visible setup selections so the user can review or uncheck them before the next attempt. Canceling or navigating away before completion stops the recorder and discards its unsaved chunks.

This is intentionally stricter than detecting a generic `SpeechRecognition` API, whose default processing location may be chosen by the browser. MDN documents the [`processLocally` contract and on-device language-pack behavior](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API#on-device_speech_recognition). Availability is browser-, version-, language-, and device-dependent.

## Coaching data flow

### Audio-only attempt

```text
microphone MediaStream
  → AudioContext
  → AudioWorklet (preferred) or AnalyserNode compatibility path
  → short-lived RMS + peak frames
  → browser coaching analyzer
  → live cue + post-attempt metrics/advice
  → compact summary in this site's IndexedDB in the current browser profile
```

The `AudioWorklet` receives raw sample arrays because sample-level processing is its browser job. It immediately reduces roughly one-tenth-second windows to root-mean-square level and peak amplitude. The page receives those numbers. Raw arrays and live measurement frames are not written to IndexedDB, cookies, local storage, a Durable Object, or the Go server. This default analysis path does not create a recording.

### Consented transcript-assisted attempt

```text
same local audio path
  + exact live microphone track
      → mandatory on-device SpeechRecognition
      → transcript in page memory
      → counts, pace estimate, and derived word patterns
      → bounded derived fields enter the local summary
      → captured transcript text cleared by default
```

The summary stores word count, words per minute, filler and repetition counts/rates, plus bounded filler-phrase and immediately repeated-word labels with counts. This is derived lexical content and may still be sensitive—for example, an immediately repeated name could appear. Each pattern array is limited to 50 entries and each label to 64 characters. Captured transcript text is not displayed in Progress or included in JSON export. It enters the separate artifact store only after full-session-retention consent.

### Separately retained session artifacts

```text
same live microphone MediaStream
  → MediaRecorder starts after calibration
  → encoded audio chunks in page memory
  → audio Blob at completion ───────────────┐
                                             ├─ session-artifacts (IndexedDB)
optional captured transcript ───────────────┘
```

The artifact record is linked to its summary by the same random session ID. It contains creation time, the recording `Blob` and MIME type when recording succeeded, any text captured by transcript analysis, and `transcriptMayBePartial`. A partial artifact is possible: for example, a recording can be retained when transcription is unavailable. The transcript flag is true when final recognition results did not arrive cleanly within the two-second stop window; it is metadata about capture completeness, not a reconstruction of missing words. Progress exposes only the downloads supported by the artifact and repeats the warning for possibly partial text.

### Local retrieval-selected drill

```text
selected goal + measured evidence
  → lexical query in browser memory
  → curated coaching card bundled with the app
  → normally use top card's prewritten drill
  → or use evidence-backed priority drill when the card is unsupported
  → fixed priority-specific comparison sentence
  → review labels the card as used guidance or retrieved context
```

This small local RAG path introduces no new network or model trust boundary. It uses no LLM, embedding model, vector database, remote corpus, or open-ended prose synthesis. The curated, product-authored card library, lexical ranking, and comparison templates ship as application code. Normally the top card's drill remains intact and deterministic assembly appends a measurement-specific comparison sentence. If the card would introduce unsupported advice—for example, microphone-distance guidance when callbacks are missing—the evidence-safety rule keeps the restore-input drill instead. In that case `grounding.usedCardId` is `null`, and the UI calls the card retrieved context rather than claiming it shaped the drill. Separate rules select strength and focus. A source label is provenance, not proof that the guidance has been independently validated.

A future production LLM RAG system would be a materially different privacy design. Semantic queries, transcript-derived content, retrieved passages, and prompts could reach embedding/model providers; sources and model versions would need retention, consent, injection, access-control, and evaluation policies. None of that is silently enabled by the current microphone or transcript checkbox.

### Network behavior

The coaching pages, curated coaching cards, and JavaScript are delivered as Workers Static Assets. After those files load, coaching analysis/retrieval does not call `/api/*`, a Durable Object, the Go server, Anthropic, a vector database, or another speech service. Multiplayer room requests continue to use the Worker normally, but that is a separate product path.

The automated coaching smoke test watches application API requests and asserts that coaching makes none. It proves a default-off attempt never constructs `MediaRecorder` or creates an artifact, upgrades a synthetic v1 database to both v2 stores, and exercises the opted-in path: the summary contains bounded derived patterns but no recording/captured transcript, the artifact store contains a non-empty encoded `Blob` and transcript, a late recognition error preserves captured text and its partial-warning metadata, the actual recording/transcript downloads contain data, JSON export excludes both session artifacts, and confirmed deletion clears both stores. Separate flows cover cancellation and stalled input. That is useful evidence about the implemented application, not a complete packet-level audit and not proof about every browser extension, operating-system service, or future browser implementation.

## Coaching storage

`/progress` uses version 2 of the IndexedDB database `nonstoptalk-coaching`. Its `session-summaries` store contains:

- A random record ID and creation time
- Scenario, selected goal, and target duration
- Aggregate duration, speech/pause, level consistency, clipping, and confidence measurements
- Optional transcript counts, rates, and bounded filler/repeated-word patterns
- The rule-selected strength/focus and deterministically assembled drill text
- Artifact-presence metadata: whether audio/transcript exists, recording size, MIME type, and whether retained transcript text may be partial

It does not contain:

- Raw microphone samples
- Per-frame RMS or peak messages
- Audio blobs or captured transcript text
- The in-memory local-retrieval score, matched terms, or source metadata
- Names, email addresses, room identities, or account identifiers

The separate `session-artifacts` store is empty unless full-session retention was selected and at least one artifact was captured. Each record can contain the session ID/time, audio `Blob`, MIME type, captured transcript text, and `transcriptMayBePartial`. `/progress` reads an artifact only for an individual download and uses summary metadata to show any partial-text warning. **Export JSON** reads only `session-summaries`: it includes derived patterns and artifact-presence metadata, but excludes the recording and captured transcript text. **Delete local history** clears both stores after confirmation. A downloaded recording/transcript becomes an ordinary file outside browser storage and is not removed by the in-app delete action.

IndexedDB is scoped to a site origin (scheme, host, and port) within a browser profile. Records are best-effort browser storage: site-data deletion, private browsing behavior, or storage pressure may remove them. Conversely, the prototype has no automatic artifact expiration, so retained data may remain until the user deletes local history or site data. A custom domain, `workers.dev`, `127.0.0.1:8787`, and another local port each have separate history. There is no account, app-level encryption, cloud backup, cross-device synchronization, server analytics, or server retention timer.

Private/local storage does not mean risk-free storage. Anyone with access to the same unlocked browser profile may be able to view Progress or download retained recordings/transcripts; exported/downloaded files may be accessible elsewhere on the device. A shared-device demonstration should keep full retention off unless needed and delete browser history plus any downloaded files afterward.

## Local Go game consent

Enabling the AI judge in local room settings only makes it available. Before each turn, that speaker must choose one of:

- Use supported on-device transcription for this turn.
- Play without transcription or an AI bonus.

The choice is per turn and is not silently carried into later turns. Starting the manual timer selects classic play and sends no transcript.

The Go game deliberately fails closed. Transcription starts only when all of the following are true:

1. The host enabled the AI judge.
2. The current speaker explicitly chose local transcription.
3. The browser exposes `SpeechRecognition` or its prefixed equivalent.
4. The recognition object exposes `processLocally` and retains the value `true`.
5. The exact live audio track selected for voice-activity detection can be supplied to recognition.

If a check fails, the game continues with classic scoring. Strict local-recognition support is unavailable in many current browser/language combinations, so this remains an enhancement rather than a requirement.

## Local Go AI-judge flow

```text
selected microphone
  → browser on-device SpeechRecognition
  → text transcript (maximum 8 KiB)
  → trusted NonStopTalk Go server
  → offline heuristic OR Anthropic
  → relevance, confidence, short feedback
  → bonus of up to 20 points
```

The game transcript is held only long enough to grade the turn. It is not a field on the game session, is not shown in game history, and is not written to the JSON room snapshot.

The Go server sends Anthropic the assigned topic and transcript only when `ANTHROPIC_API_KEY` is configured. Without the key, a keyword-overlap heuristic produces a clearly labeled low-confidence result. Grading is asynchronous; any failure preserves classic scoring.

Theme generation sends Anthropic only the host's theme when a key is configured. Without a key, fixed server templates expand the theme. Resulting topics still become ordinary room state.

## Other application storage

- No account is required for the game or coaching prototype.
- Multiplayer browser identity uses an HTTP-only room token cookie.
- The local Go game keeps custom topic drafts, saved presets, microphone choice, and sound preference in local storage.
- The local web server stores room/session snapshots in `data/rooms.json` by default. They include rosters, settings, topics, scores, turns, and room history, but not transcripts or audio. Set `NONSTOPTALK_DATA_FILE=off` for memory-only rooms.
- The Cloudflare edition stores multiplayer game state in a private SQLite-backed Durable Object for up to 30 idle days. Coaching summaries and full artifacts never enter that object.

The operator of a self-hosted Go instance controls its server and Anthropic credentials. Players should use an instance they trust.

## Transport and lifecycle

Remote microphone use requires HTTPS; `localhost` and loopback development are treated as secure contexts by modern browsers. `AudioWorklet` module access also requires a secure context in supporting browsers. See MDN's [`AudioWorkletNode` documentation](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode).

Leaving `/practice`, navigating to another NonStopTalk route, canceling calibration, finishing an attempt, or closing the page stops recognition, closes worklet messaging, stops microphone tracks, closes the audio context, and stops an active recorder. Cancellation discards unsaved recorder chunks. Delayed permission and worklet completions are token/route checked so they cannot silently start a canceled attempt. Lifecycle cleanup reduces accidental continued capture; the browser's permission UI remains the final source of truth.

## Fairness and responsible use

The coaching prototype reports observable acoustic or transcript-derived behaviors. It must not infer confidence, anxiety, emotion, honesty, personality, age, health, identity, or professional worth from a voice.

It is not speech therapy, a medical device, or a diagnostic assessment. ASHA's [Accent Modification guidance](https://www.asha.org/Practice-Portal/Professional-Issues/Accent-Modification/) states that accents are natural language variations rather than communication disorders. NonStopTalk should not penalize accent or dialect and should compare a person primarily with their own prior attempts.

Current limitations create fairness risks:

- Speech recognition errors can change word, filler, and pace counts.
- Background noise can look like voice and make pauses appear shorter.
- A quiet microphone, automatic gain, compression, or a distant speaker can make voice look like silence.
- Fixed timing rules may not fit a person's language, disability, assistive device, speaking style, or task.
- Browser support for strict local recognition is not evenly distributed across languages and devices.
- A small lexical coaching-card library can retrieve an irrelevant or culturally narrow suggestion even when its measurements are correct.

The prototype therefore shows availability and signal confidence, keeps transcript metrics optional, avoids a universal quality score, and labels thresholds as engineering defaults. A consented pilot must measure false tips, distraction, device/transcription availability, privacy behavior, and subgroup fairness before broad effectiveness claims. Liang et al.'s [automated presentation-coaching survey](https://aclanthology.org/2026.bea-1.4/) likewise identifies low-latency diagnostics, limited annotated corpora, and accent-fair feedback as open challenges.

## Future, not implemented

- Automatic baseline-to-unassisted-retry pairing and goal-specific comparison
- Validated learning-outcome or fairness targets
- Accounts, cross-device progress, educator assignments, or shared coaching reports
- Per-attempt artifact deletion, automatic local expiration, storage-quota controls, app-level encryption, or server-side coaching analytics
- Semantic analysis of structure, relevance, concision, examples, or answer completeness
- Production semantic/LLM RAG, local-model, self-hosted, bring-your-own-key, or paid-provider coaching adapters
- Clinical assessment or treatment features

Any future audio/transcript upload, cloud synchronization, human sharing, or external-model feature requires a separate explicit consent and retention design. It must not silently inherit permission from microphone analysis, transcript analysis, or local artifact retention.
