# AI and privacy

This document describes the current NonStopTalk implementation and the explicitly marked in-progress platform slice. There are four distinct paths with different boundaries:

1. The local and online multiplayer game, which can run with classic scoring and no transcript.
2. The optional, disabled-by-default theme-to-topics providers in the Cloudflare game edition.
3. The optional AI judge and topic generator in the local Go game edition.
4. The speech-coaching prototype in the native Cloudflare SPA, which performs analysis and curated coaching-card retrieval in the browser, with an off-by-default API for compact-summary backup and no external coaching/AI service.

NonStopTalk does not upload microphone audio in any of these paths. In coaching only, a separate unchecked option can record the active attempt and retain it locally in this site's browser storage. That recording and any captured transcript are never sent to the Worker or another service. A different explicit choice may send only an allowlisted compact measurement/advice summary to NonStopTalk's D1 database.

## At a glance

| Situation | Microphone audio | Transcript | External AI |
| --- | --- | --- | --- |
| Coaching, default acoustic path | Reduced to measurements in the browser; no recording retained | None | None |
| Coaching with transcript analysis only | Reduced in the browser; no recording retained | Mandatory-on-device captured text is discarded after analysis; bounded derived counts and filler/repetition patterns remain in the summary | None |
| Coaching with separate full-session retention | When recording succeeds, the browser-encoded attempt is stored locally as a `Blob`; never uploaded | Captured text is also stored locally only if transcript analysis was enabled and produced text | None |
| Coaching with compact cloud backup | Never uploaded | Captured text is never uploaded; consented bounded derived counts/pattern labels may be included in the allowlisted summary | None; the summary goes only to the NonStopTalk Worker/D1 platform |
| Classic game with microphone detection | Read locally by Web Audio | None | None |
| Manual game timer | Not required | None | None |
| Cloudflare topic draft, offline/default | Not involved | Not involved | None; deterministic templates expand the host's theme |
| Cloudflare routine topic draft, direct GLM-4.7 selected and host consents for this attempt | Not involved | Not involved | The normalized theme (at most 200 characters) is the only host or room content sent directly to Z.AI |
| Cloudflare routine topic draft, Workers AI GLM-5.3 selected and host consents for this attempt | Not involved | Not involved | The normalized theme (at most 200 characters) is the only host or room content sent through Cloudflare's `AI` binding to `@cf/zai-org/glm-5.3-flash` |
| Cloudflare escalated topic draft, host explicitly selects it and consents for this attempt | Not involved | Not involved | The normalized theme (at most 200 characters) is the only host or room content sent to Google's Gemini API for Gemma 4 31B when the operator enabled it |
| Local Go AI judge enabled, speaker chooses classic/manual | Not uploaded | None | None |
| Local Go AI judge, speaker consents, offline/unavailable provider selection | Read locally; not uploaded | Sent to the trusted Go server and graded by its offline heuristic | None |
| Local Go AI judge, speaker consents, Anthropic selected and keyed | Read locally; not uploaded | Sent to the Go server, then topic + transcript are sent to Anthropic | Anthropic grading |
| Local Go AI judge, speaker consents, GLM selected and keyed | Read locally; not uploaded | Sent to the Go server, then topic + transcript are sent to Z.AI | GLM-4.7-Flash grading |
| Local Go theme generation with the offline/unavailable provider | Not involved | Not involved | None; server templates generate the pack |
| Local Go theme generation with an external provider selected and keyed | Not involved | Not involved | The host's theme is the only user content sent to Anthropic or Z.AI |

## Cloudflare theme-to-topics consent and boundary

The online room host can request an editable topic draft during setup. External processing is disabled by default: `TOPIC_ROUTINE_PROVIDER=offline` keeps the routine path deterministic, and `TOPIC_ESCALATION_PROVIDER=off` makes escalation unavailable. An operator can select direct Z.AI GLM-4.7-Flash with `TOPIC_ROUTINE_PROVIDER=glm` and the `ZAI_API_KEY` Wrangler secret, or select Workers AI GLM-5.3-Flash with `TOPIC_ROUTINE_PROVIDER=glm53` and the configured `AI` binding. The latter uses public model name `glm-5.3-flash`, binding ID `@cf/zai-org/glm-5.3-flash`, and no vendor API-key secret, but this build's plain `AI.run()` path requires Workers Paid. Prepaid AI Gateway credits would require a gateway ID and Unified billing, which are not implemented. The operator can independently make Gemma 4 31B available with `TOPIC_ESCALATION_PROVIDER=gemma31` and the `GEMINI_API_KEY` secret.

Configuration does not grant consent. For each generation attempt, the host chooses routine or escalated generation and must separately check the one-request external-processing control. Escalation additionally requires the host to select the escalated tier; it is never chosen automatically because the routine provider failed. If a configured external tier is requested without consent, the Worker rejects it before reserving budget or contacting the provider. A disabled tier, missing provider key, invalid selector, unavailable/exhausted daily budget, or provider call/output failure returns deterministic topics instead. The public platform status marks an invalid selector or selected provider without its key as degraded without exposing the key or arbitrary selector value.

The normalized theme, capped at 200 characters, is the only host or room content in the external request. Fixed provider instructions and model settings are also present, but microphone audio, recordings, captured transcript text, player and room names, the room code/member token, coaching summaries, game history, and NonStopTalk request IDs are excluded. Provider-produced topics become an editable draft and are installed through an ordinary host-authorized custom-topic action. Z.AI, Cloudflare Workers AI, or Google processes the theme under that provider's own service terms.

As checked August 31, 2026, [Cloudflare's Workers AI data-use policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/) says Cloudflare does not use customer content to train models or improve services without explicit consent and stores content only when the customer separately uses a storage product. This is a provider-policy statement, not a technical guarantee by NonStopTalk, and terms can change.

Gemma escalation has a notable privacy tradeoff. As checked August 31, 2026, [Google's Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing#gemma-4) lists Gemma 4 input, output, and caching as free of charge, a paid tier as unavailable, and free-tier content as used to improve Google's products. Provider terms can change. NonStopTalk therefore keeps Gemma operator-disabled by default, requires the host to select escalation and consent for that attempt, and sends no host or room content beyond the normalized theme.

```text
host enters theme (maximum 200 characters)
  + chooses routine or escalated tier
  + explicitly consents for this generation attempt
      → Worker verifies host/setup authorization and daily D1 budget
      → deterministic generator, direct GLM-4.7-Flash,
        Workers AI GLM-5.3-Flash, or explicitly selected Gemma 4 31B
      → bounded validated editable topic draft
```

D1 stores aggregate UTC-day provider usage needed to enforce `MODEL_DAILY_CALL_LIMIT`, which defaults to 100 external attempts per day. Its rows aggregate reservations/completions, successes/failures, provider/model, input/output/total/cached-input/reasoning token totals, and total latency. They do not store the theme, generated topics, names, room codes, room/member/authentication tokens, audio, or transcripts. The secret-protected `/api/v1/admin/model-usage` readout exposes those aggregate operational fields, not model prompts or responses. A timeout or other failure without provider usage still counts the reservation/call, but its token fields remain zero and can undercount work the vendor ultimately bills. This first slice makes at most one external call per host action. It does not retry a provider and does not use a Queue; deterministic generation is the immediate fallback after an authorized, consented provider attempt fails.

## Coaching consent and boundary

Opening `/practice` does not start the microphone. The setup explains that analysis is on-device, and the browser asks for microphone permission only after the user starts calibration. Permission remains controlled by the browser and can be revoked.

The recommended baseline/retry format also limits feedback as a privacy- and measurement-preserving product rule: both attempts are `review-only`. While speaking, the page shows the prompt, goal, timer, and microphone-connected state but does not mount the live meter, live statistics, or coaching-tip surface. The alternative single coached format uses sparse live cues and is stored as a standalone attempt. This distinction is local application state; it does not introduce another network or model boundary.

The user can opt into experimental transcript analysis. That checkbox is enabled only when the browser exposes a `SpeechRecognition` object with the mandatory-local-processing property. NonStopTalk then:

1. Creates recognition for the current microphone track.
2. Sets `processLocally = true` before starting.
3. Uses transcript text for word count, words-per-minute, filler-pattern, and immediate repeated-word estimates.
4. Writes bounded derived counts and pattern labels to the compact local summary.
5. Clears the captured transcript after building the review unless the user also selected full-session retention.
6. Never falls back to browser-managed remote recognition.

If recognition is absent, cannot be initialized, rejects the track, or captures no text, the acoustic attempt continues without transcript metrics. At finish, NonStopTalk asks recognition to stop and allows up to two seconds for final results. If an error or timeout occurs after `onresult` has delivered text, NonStopTalk preserves and analyzes that text but never calls it complete; Review warns that it may be partial. When the separate full-session option retains the text, both the artifact and summary artifact metadata set `transcriptMayBePartial`, so Progress warns too. Recognition error events and their payloads are never retained. The browser owns its implementation of the experimental Web Speech API; NonStopTalk relies on the browser to honor mandatory local processing.

Full-session retention is an independent checkbox and starts unchecked on a fresh page load. It is enabled only when `MediaRecorder` exists. If selected, recording begins after calibration when the attempt starts. On completion, the application saves the encoded attempt recording when recording succeeds and any captured transcript that is available to a separate local artifact store. A transcript-only artifact can still be saved if recording fails after transcript analysis returned text. Selecting recording retention does not silently enable transcription; selecting transcript analysis does not silently retain captured transcript text. **Try again** preserves the visible setup selections so the user can review or uncheck them before the next attempt. Canceling or navigating away before completion stops the recorder and discards its unsaved chunks.

Compact cloud backup is a third, independent choice and also starts off. Selecting it for an attempt sends only a strictly allowlisted summary: scenario/goal/time, aggregate measurements, deterministic advice, any bounded derived word-pattern fields already permitted in the summary, and the explicit practice relationship (`practiceLoopId`, `baselineAttemptId`, `attemptRole`, and `feedbackMode`) when present. These opaque relationship fields contain no media or captured words. It excludes raw samples, measurement frames, segments, recordings, captured transcript text, artifact metadata, names, room identity, and account data. The API ties the backup to the existing high-entropy HTTP-only browser token and stores only its SHA-256 digest in D1. This is not an account or a recovery credential: clearing the cookie can make the records unreachable, there is no cross-device access, and one device-level inactivity lease controls all of this browser's cloud summaries. The lease is bucketed to a UTC day, lasts at least 30 and less than 31 days after cloud use, and does not require each summary to be rewritten on ordinary reads. New saves are rejected once 250 summaries exist; valid unexpired legacy rows are preserved rather than forcibly deleted.

This is intentionally stricter than detecting a generic `SpeechRecognition` API, whose default processing location may be chosen by the browser. MDN documents the [`processLocally` contract and on-device language-pack behavior](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API#on-device_speech_recognition). Availability is browser-, version-, language-, and device-dependent.

## Coaching data flow

### Audio-only attempt

```text
microphone MediaStream
  → AudioContext
  → AudioWorklet (preferred) or AnalyserNode compatibility path
  → short-lived RMS + peak frames
  → browser coaching analyzer
  → review-only paired attempt or sparse live cue in single-coached mode
  → post-attempt metrics/advice
  → compact summary in this site's IndexedDB in the current browser profile
  → optional allowlisted-summary backup to Worker API → D1
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

The summary stores word count, words per minute, filler and repetition counts/rates, plus bounded filler-phrase and immediately repeated-word labels with counts. This is derived lexical content and may still be sensitive—for example, an immediately repeated name could appear. Each pattern array is limited to 50 entries and each label to 64 characters. These bounded summary fields may be backed up only after the separate cloud choice. Captured transcript text is not displayed in Progress, included in JSON export, or uploaded. It enters the separate artifact store only after full-session-retention consent.

### Separately retained session artifacts

```text
same live microphone MediaStream
  → MediaRecorder starts after calibration
  → encoded audio chunks in page memory
  → audio Blob at completion ───────────────┐
optional captured transcript ───────────────┴─ retained artifact
                                             ├─ session-artifacts (content)
                                             └─ artifact-lifecycle (content-free policy)
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

The coaching pages, curated coaching cards, and JavaScript are delivered as Workers Static Assets. Coaching analysis, local retrieval, and the default/off storage path call no coaching-data API, Durable Object, Go server, Anthropic endpoint, topic-model endpoint, vector database, or speech service. When compact cloud backup is explicitly selected, the browser calls `/api/v1/progress/sessions` to create/list/delete allowlisted summaries in D1. It still never sends audio, a recording, or captured transcript text, and coaching never uses a room Durable Object. The separate host-only theme generator does not inherit any coaching consent or receive coaching data.

`smoke:coach` watches the default/off flow and asserts that it makes no coaching-data API request. It also proves local default-off and artifact-retention UI behavior, and uses Chromium's origin quota override to exercise a real browser `QuotaExceededError` followed by a truthful summary-only save. The dedicated `smoke:coach-storage` check instead serves hash-pinned Release-A and current storage modules on one origin and exercises v3 migration, exact retention and logical-cap edges, no eviction, corruption, two-tab concurrency, and rollback/restoration boundaries. Separate cloud-progress tests check the upload allowlist and opt-in API client; platform tests cover server-side validation, ownership, expiry, and analytics boundaries. That is useful evidence about the implemented application, not a complete packet-level audit and not proof about every browser extension, operating-system service, or future browser implementation.

## Coaching storage

`/progress` uses version 3 of the IndexedDB database `nonstoptalk-coaching`. Its `session-summaries` store contains:

- A random record ID and creation time
- Scenario, selected goal, and target duration
- Explicit opaque practice-loop/baseline IDs, attempt role, and feedback mode for new records; legacy records may omit them
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

The separate `session-artifacts` store is empty unless full-session retention was selected and at least one artifact was captured. Each record can contain the session ID/time, audio `Blob`, MIME type, captured transcript text, and `transcriptMayBePartial`. The required `artifact-lifecycle` store is a content-free policy ledger: it keeps the matching ID, retention/expiry times, logical byte count, lifecycle schema version, and a migration-grace flag, but no recording, MIME type, transcript text, or derived word pattern. Logical size is the audio `Blob` size plus the transcript's exact UTF-8 byte length. `/progress` reads an artifact only for an individual download and uses summary metadata to show any partial-text warning. **Export JSON** reads only `session-summaries`: it includes relationship metadata, derived patterns, and artifact-presence metadata, but excludes the recording and captured transcript text. **Delete saved artifacts** removes one attempt's artifact and lifecycle row and resets that summary's artifact metadata in one transaction while preserving the compact attempt and pair. **Delete local history** clears every local coaching store after confirmation. A downloaded recording/transcript becomes an ordinary file outside browser storage and is not removed by either in-app delete action.

Every newly retained artifact expires exactly 30 days (2,592,000,000 ms) after its save time. A v1/v2 artifact migrated to v3 receives exactly 30 days from the single upgrade time; a valid earlier lifecycle deadline is never extended. Expired artifacts are removed on a later storage access, with their lifecycle rows and summary artifact-presence flags cleared while the compact summary remains. New artifacts share a 128 MiB logical cap. The app does not evict valid, unexpired artifacts to make room, and a structurally valid migrated artifact is preserved for its one-time 30-day grace even when it is individually or collectively over the cap. A new artifact that would exceed the cap becomes a clearly reported summary-only save. If the browser itself raises `QuotaExceededError`, the combined artifact transaction aborts and the app retries as summary-only, so no artifact-presence claim survives without its content.

IndexedDB is scoped to a site origin (scheme, host, and port) within a browser profile. It is best-effort browser storage, not a server database or durable backup: site-data deletion, private browsing behavior, storage pressure, browser policy, or an unavailable/corrupt database may remove data or prevent saving before the app's 30-day deadline. The app does not run while closed, so expiry cleanup occurs opportunistically on a later storage operation rather than at an exact wall-clock instant. Structurally incompatible stores/key paths fail closed instead of being silently reinterpreted; malformed, orphaned, mismatched, or expired artifact state is not returned and is reconciled by deleting the artifact/ledger row and clearing only the summary's artifact-presence fields. The deployed Release-A compatibility floor can reopen an already-upgraded v3 or compatible newer database after `VersionError`, honor its lifecycle policy, and close for later upgrades; IndexedDB itself is never downgraded, and artifacts already expired or deleted are not restored by rollback. A custom domain, `workers.dev`, `127.0.0.1:8787`, and another local port each have separate local history.

The in-progress cloud store is separate. It keeps only explicitly backed-up compact summaries and versioned consent records in D1, keyed by a hashed anonymous browser identity. Cloud use refreshes one UTC-day-bucketed device lease; scheduled cleanup removes expired anonymous detail in bounded batches and leaves any remaining backlog for a later cron run. One global schema-v5 heartbeat records only successful scheduled/completed times and a backlog bit; public status reduces that state to `ready`, `stale`, or `backlog` and exposes no timestamps, deletion counts, or user data. Schema v6 also defines a room-milestone receipt table limited to opaque lowercase 256-bit event IDs/payload hashes and canonical UTC receipt/application/exact-90-day-expiry timestamps. A strict internal receiver can write it when explicitly invoked, and bounded cleanup removes expired receipts only when the database marker is 6. Marker-5 cleanup never prepares receipt-table SQL.

Release A contains the rollback-compatible local consumer, and Release B adds the normal-room producer behind exact lowercase `ROOM_MILESTONE_DELIVERY_MODE=outbox`. In exact mode, a room mutation atomically stores its canonical aggregate-only event group in the room's private Durable Object SQLite database; the consumer drains the FIFO head one event per alarm through persisted bounded retry and privacy-minimal dead-letter state. The canonical queued payload excludes the raw room code, names, topics, member/authentication tokens, IP data, audio, transcripts, and coaching content; terminal dead letters retain only bounded reason/milestone/attempt/timing metadata, not the event ID or payload. Production remains configured `best-effort`, so ordinary production rooms create no outbox tables, queued events, or receipts. Staging intentionally uses exact `outbox`, is healthy with `durable-outbox` delivery, and passed the 2026-09-02 aggregate-only rollback/drain/restoration proof. Exact operation requires a cryptographically random room-fact key; if that key is missing after activation, the receiver still commits a receipt and eligible aggregate rollup but skips the room fact, and restoring the key cannot backfill that fact from a duplicate replay. The Progress delete control clears local stores and, when cloud backup is enabled and reachable, the current anonymous browser's D1 summaries. There is still no account, recovery flow, app-level encryption, or cross-device synchronization.

Product analytics are coarse aggregates, not a copy of coaching progress. Server-authoritative room milestones and accepted summary-save/delete/consent transitions attempt small daily D1 increments and Analytics Engine writes. Production room milestones and progress/consent events in both environments remain best-effort through `waitUntil`, so those events can be missed. Staging exact outbox applies only to room milestones: it atomically stores a canonical aggregate-only event with the room mutation, receipt-gates its eligible D1 effects, and makes an exact replay idempotent. Analytics Engine remains best-effort in both environments and gets at most one post-commit write opportunity for a newly applied receipt; a failure or interruption can lose that point, and replay does not retry it. Status therefore reports `durable-outbox` only for the room-milestone lane when exact mode, schema 6, and the secure room-fact key are ready; an unready exact configuration is `degraded-outbox`. Aggregate event values may include turn/session duration or completed-turn counts. Separate aggregate D1 model-usage rows enforce the external-topic daily budget; they contain no theme or generated topic text. Analytics and usage counters exclude names, IP addresses, user agents, raw browser tokens, room-member tokens, audio, captured transcripts, word patterns, advice, and delivery-quality measurements such as speaking ratio. The protected admin API queries D1 rollups, but those rows remain operational rather than audit or billing truth.

Cloudflare Web Analytics is distinct from both application-controlled sinks above. If an operator enables automatic setup on the proxied domain, Cloudflare injects an SRI-protected beacon loaded from `https://static.cloudflareinsights.com/beacon.min.js`; its browser RUM/performance reports use the same-origin `/cdn-cgi/rum` endpoint. NonStopTalk application code never sends coaching audio, captured transcript text, or compact-summary payloads to this beacon. Cloudflare's documentation says Web Analytics is free, does not collect or use visitors' personal data, and does not track an individual across customers' sites. Those are Cloudflare provider-policy statements, not guarantees enforced or independently audited by NonStopTalk, and operators should recheck the policy before enabling the service.

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
  → offline heuristic OR selected Anthropic/Z.AI provider
  → relevance, confidence, short feedback
  → bonus of up to 20 points
```

The game transcript is held only long enough to grade the turn. It is not a field on the game session, is not shown in game history, and is not written to the JSON room snapshot.

`NONSTOPTALK_AI_PROVIDER` selects `offline`, `anthropic`, or `glm` for both local-Go judging and theme generation. Explicit `offline` wins even when API keys exist. With the selector unset, a configured `ANTHROPIC_API_KEY` preserves the legacy Anthropic behavior; otherwise the server stays offline, and a `ZAI_API_KEY` alone does not silently opt in. Explicit `anthropic` requires `ANTHROPIC_API_KEY`; explicit `glm` requires `ZAI_API_KEY` and uses GLM-4.7-Flash. Invalid selectors and explicit selections without their key emit an operator warning and fail closed to the offline heuristic. The local Go selector does not use Cloudflare's `glm53` option.

When the speaker has consented to transcript-assisted judging, the selected external provider receives the assigned topic and the size-capped transcript as user data; audio and room metadata are excluded. Grading is asynchronous, and any provider failure preserves classic scoring. Local theme generation is a separate host action: with an external provider selected, the theme is its only user content; with the offline provider, fixed server templates expand the theme. Runtime failure during external theme generation returns an error so the host can retry or write topics manually; it does not switch providers.

## Other application storage

- No account is required for the game or coaching prototype.
- Multiplayer browser identity uses an HTTP-only room token cookie.
- The local Go game keeps custom topic drafts, saved presets, microphone choice, and sound preference in local storage.
- The local web server stores room/session snapshots in `data/rooms.json` by default. They include rosters, settings, topics, scores, turns, and room history, but not transcripts or audio. Set `NONSTOPTALK_DATA_FILE=off` for memory-only rooms.
- The Cloudflare edition stores multiplayer game state in a private SQLite-backed Durable Object for up to 30 idle days. Coaching summaries and full artifacts never enter that object.
- The central D1 platform store holds only the allowlisted records described above: anonymous device ownership/expiry, consented compact summaries, consent records, 90-day HMAC-pseudonymous room facts, daily analytics aggregates, aggregate daily model-usage budget counters, and schema-v6 milestone receipts. Production's current best-effort room traffic creates no receipts; staging exact mode inserts one expiring receipt per delivered milestone, and scheduled schema-6 cleanup removes expired rows. Receipt fields cannot contain room codes, names, topics, member/authentication tokens, IP data, audio, transcripts, or coaching content. Themes, generated topic text, raw room codes, and the HMAC key are not stored in D1.

The Cloudflare operator controls which routine option is enabled, whether Gemma escalation is available, the Z.AI/Gemini credentials, and access to the Workers AI binding. The operator of a self-hosted Go instance separately controls `NONSTOPTALK_AI_PROVIDER` and its Anthropic or Z.AI credential. Players should use an instance they trust.

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
- An external topic model can produce inaccurate, repetitive, culturally narrow, or inappropriate prompts; bounded validation and host editing reduce but do not eliminate that risk.

The prototype therefore shows availability and signal confidence, keeps transcript metrics optional, avoids a universal quality score, and labels thresholds as engineering defaults. A consented pilot must measure false tips, distraction, device/transcription availability, privacy behavior, and subgroup fairness before broad effectiveness claims. Liang et al.'s [automated presentation-coaching survey](https://aclanthology.org/2026.bea-1.4/) likewise identifies low-latency diagnostics, limited annotated corpora, and accent-fair feedback as open challenges.

## Future, not implemented

- Validated learning-outcome or universal-improvement interpretation for the implemented explicit baseline-to-unassisted-retry comparisons
- Validated learning-outcome or fairness targets
- Accounts, cross-device authentication/progress, educator assignments, or shared coaching reports
- A storage-usage dashboard, browser-persistence request, configurable retention window, or app-level encryption; exact 30-day artifact expiry, the 128 MiB logical cap, summary-only fallbacks, and per-attempt deletion are implemented
- Semantic analysis of structure, relevance, concision, examples, or answer completeness
- Production semantic/LLM RAG, local-model, self-hosted, bring-your-own-key, or paid-provider coaching adapters
- Queue-backed provider work or R2 storage for coaching media
- Clinical assessment or treatment features

Any future audio/transcript upload, account-based synchronization, human sharing, or external-model feature requires a separate explicit consent and retention design. It must not silently inherit permission from microphone analysis, transcript analysis, local artifact retention, or compact-summary backup.
