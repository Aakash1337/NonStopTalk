# Learn NonStopTalk in 45 minutes

This guide is the shortest path from “I have not touched this project in a while” to a technically honest explanation and a reliable demo.

At minute 45, you should be able to:

- explain Practice, Play, and Progress without mixing their jobs or storage;
- redraw the coaching and Cloudflare request paths;
- trace a microphone sample through analysis, advice, and persistence;
- explain exactly what the small RAG component does;
- describe the three independent optional data choices and their privacy consequences;
- state what Durable Objects do and what their public route looks like; and
- separate implemented behavior from future validation claims.

## Before starting the clock

Environment installation is not part of the 45-minute learning clock. Do this earlier; if 45 minutes is a hard total, use an already-running local or deployed build.

The coaching-capable local edition supports Node.js 22 or newer. CI uses Node 24, so selecting 24 is the easiest way to match automated checks. Check the active version first. If it prints `v20...`, install Node 24 from the [official Node.js download](https://nodejs.org/en/download), reopen the terminal, and check again. If `nvm` is already installed, this is the equivalent:

```sh
nvm install 24
nvm use 24
```

Then verify the active runtime and install dependencies:

```sh
node --version
npm ci
```

The version check should print `v22...` or newer; `v24...` matches CI. Do not continue with Node 20. Start a stable local presentation server:

```sh
npm run db:migrate:local
npm run dev -- --local --ip 127.0.0.1 --port 8787
```

Open these routes in the same browser profile:

```text
http://127.0.0.1:8787/
http://127.0.0.1:8787/practice
http://127.0.0.1:8787/progress
```

If port 8787 is occupied, stop the process using it or rerun `npm run dev -- --local --ip 127.0.0.1` without `--port`; then use the exact URL Wrangler prints. Scheme, host, and port define a browser origin, so changing from `127.0.0.1` to `localhost` or changing ports gives Progress a different IndexedDB history.

Do not use `go run ./cmd/web` for this demo. That starts the separate Go game at port 8080, which does not currently contain Practice or Progress.

## Your 45-minute route

| Time | Learn | Outcome |
| --- | --- | --- |
| 00:00–03:00 | Product map | Name each tab and its job |
| 03:00–08:00 | One real Practice attempt | Connect the UI to the product loop |
| 08:00–15:00 | Product narrative | Explain Problem → Constraints → Design → Measurement |
| 15:00–25:00 | Coaching pipeline | Trace Capture → Reduce → Calibrate → Classify → Measure → Retrieve → Assemble → Store |
| 25:00–30:00 | Small local RAG | Explain what is retrieved, generated, guarded, and absent |
| 30:00–36:00 | Runtime, routes, and data | Separate browser, Worker, Durable Object, and IndexedDB responsibilities |
| 36:00–40:00 | Measurement and limitations | Say what works without overselling what it proves |
| 40:00–45:00 | Full rehearsal | Deliver the five-minute presentation without stopping |

## 00:00–03:00 — Build the product map

Memorize this sentence:

> **Practice coaches. Play motivates through social repetition. Progress makes personal practice visible.**

| Surface | Route | User job | Technical boundary |
| --- | --- | --- | --- |
| **Practice** | `/practice` | Rehearse one speaking goal and get evidence plus one next action | Browser Web Audio, optional strict on-device transcript analysis, local retrieval, local IndexedDB |
| **Play** | `/` and `/room/ABC234` | Play the original speaking game alone or with remote players | Online room actions use the Worker API, WebSockets, and one Durable Object per room |
| **Progress** | `/progress` | Review Practice attempts and control local/optional cloud summary data | Always reads current-origin IndexedDB; optional D1 backup is anonymous, not an account |

Two distinctions matter:

- **Practice is the coaching mode.** Play is not hidden coaching; it has game rules and points.
- Game silence and coaching pauses mean different things. Long silence can end a Play turn, while an intentional interior pause can be useful evidence in Practice.

Checkpoint: Which tab uses Durable Objects? **Play only.** Which tab contains coaching? **Practice.**

## 03:00–08:00 — Run the core loop once

Open `/practice` and make the safest primary demo:

1. Choose **Presentation opening**, **Purposeful pauses**, and **30 seconds**.
2. Keep the recommended **Baseline + unassisted retry** format and leave every optional data choice unchecked.
3. Grant microphone permission.
4. Stay quiet for about two seconds, then speak normally for about two seconds.
5. Speak one complete phrase, pause for roughly one second, then speak another phrase.
6. Finish the baseline and inspect **Strength**, **Focus next**, **Drill**, measured evidence, the timeline, and the Local RAG source label.
7. Choose **Prepare unassisted retry**. Confirm that scenario, goal, and duration are locked, then calibrate and repeat without any live meter, statistics, or coaching cue.
8. Inspect the raw goal-specific baseline → retry comparison and its limited-evidence reasons/caveats, then open `/progress` and locate the grouped loop.

The user loop is:

```text
choose one goal → calibrate → speak → review one priority → retry → compare
```

The current prototype implements that explicit relationship and comparison. It also keeps a separate **Single coached attempt** format with sparse live cues. Do not claim that a displayed numerical change proves improvement: the pair is descriptive engineering evidence, and a pilot is still required for accuracy, usefulness, fairness, and learning outcomes.

Checkpoint: Point to one measured fact and explain why it supports the recommended next action. If you cannot connect them, inspect the evidence and source label again.

## 08:00–15:00 — Learn the product narrative

Use this structure whenever you explain why the system looks the way it does.

### Problem

People benefit from rehearsal, but while speaking they cannot reliably observe their own pace, pauses, filler words, or input problems. Listening back is slow, and an opaque “72% confident” score is neither trustworthy nor actionable.

The product is not trying to replace a human coach. It is trying to make repetitions between human feedback sessions more focused.

### Constraints

| Constraint | Design consequence |
| --- | --- |
| Voice can be sensitive | Keep coaching analysis and storage in the browser by default; make full-artifact retention a separate choice |
| Microphones and rooms vary | Calibrate each attempt and expose missing/uncertain evidence rather than inventing it |
| Browser speech support varies | Require strict on-device recognition and fail closed to audio-only coaching |
| Live feedback can distract or compromise an unassisted comparison | Hide all live measurements/cues in baseline/retry attempts; delay and throttle one short cue only in the separate single coached format |
| Advice must be explainable | Connect aggregate evidence to a product-authored drill and display provenance |
| Accent and dialect are not defects | Avoid universal quality scores and do not infer emotion, honesty, identity, health, or professionalism |
| The prototype must cost nothing to demonstrate | Use browser APIs, bundled cards, deterministic logic, Workers Static Assets, and Durable Objects for multiplayer only |
| The project is still being validated | Make limitations and next measurements part of the product story |

### Design

The design follows directly from those constraints:

- reduce microphone samples to objective, device-relative measurements in the browser;
- optionally add word-derived metrics only with strict local recognition and consent;
- retrieve a small product-authored coaching card locally;
- use review-only paired attempts by default and sparse deterministic live advice only in the standalone mode rather than an opaque model score;
- keep summaries and optional artifacts in separate browser stores; and
- keep multiplayer room coordination separate in the Cloudflare Worker and Durable Objects.

### Measurement

The implemented primary interaction is **completed baseline → review → comparable unassisted retry**. A future consented pilot should measure completion and the distribution of raw paired change on the one chosen goal, not treat the UI delta as one universal grade or a proven improvement.

Guardrails include false tips, distraction, valid-input coverage, strict-local-transcription availability, privacy network violations, retention-boundary violations, grounding quality, device effects, accessibility, and subgroup fairness.

Checkpoint: Explain one constraint and the design choice it caused. Avoid listing features without explaining why they exist.

For the polished version, read [The narrative](COACHING_PRESENTATION_GUIDE.md#the-narrative).

## 15:00–25:00 — Trace the coaching pipeline

Redraw this from memory:

```text
Capture → Reduce → Calibrate → Classify → Measure →
Retrieve → Assemble → Store
```

### The eight stages

| Stage | What happens | Where to find it |
| --- | --- | --- |
| **1. Capture** | `getUserMedia` obtains one microphone stream after permission. Echo cancellation and noise suppression are requested; automatic gain control is disabled. | `beginCoachingSession` in `cloudflare/public/app.js` |
| **2. Reduce** | An `AudioWorklet` mixes channels and reduces sample blocks to RMS and peak frames about ten times per second. `AnalyserNode` provides a compatibility fallback. | `cloudflare/public/coach-audio-worklet.js` and `attachCoachingMeter` in `app.js` |
| **3. Calibrate** | About two seconds of quiet and two seconds of normal speech create a session-specific threshold. | `deriveCalibration` in `cloudflare/public/coach-engine.js` |
| **4. Classify** | Hysteresis classifies observed intervals as voice or quiet without flickering near one threshold. Missing callback time becomes **unknown**, not silence. | `CoachingAnalyzer` in `coach-engine.js` |
| **5. Measure** | The engine aggregates observed time, coverage, speaking ratio, interior pauses, continuity, relative level, clipping, and optional transcript counts. | `CoachingAnalyzer.snapshot()` and `analyzeTranscript` in `coach-engine.js` |
| **6. Retrieve** | The selected goal plus aggregate evidence becomes a lexical query that ranks six bundled coaching cards, keeps up to two results, and presents the top result as the primary context. | `retrieveCoachingGuidance` in `coach-engine.js` |
| **7. Assemble** | Transparent rules choose Strength and Focus. A supported card normally contributes its unchanged drill; a safety rule can substitute a measurement-backed drill. One fixed comparison sentence is appended. | `buildAdvice` in `coach-engine.js` |
| **8. Store + relate** | A compact summary is saved to IndexedDB with explicit standalone or baseline/retry metadata. Separate choices may retain local artifacts or back up the narrower summary allowlist to D1. Progress validates relationships before grouping/comparison. | `coach-storage.js`, `coach-loop.js`, and the opt-in client in `cloud-progress.js` |

### Terms you need to explain

- **RMS:** an energy-like average amplitude for a sample block. It is device-relative, not calibrated sound-pressure level or a universal decibel reading.
- **Peak:** the maximum absolute sample value in a block; useful for clipping evidence.
- **Hysteresis:** separate enter/exit thresholds that prevent rapid voice/quiet switching near one boundary.
- **Unknown time:** elapsed attempt time without trustworthy analysis callbacks. It is not relabeled as silence, speech, or clipping.
- **Measured pause:** an interior quiet segment of at least 400 ms with measured voice on both sides. Trailing quiet is not counted as a completed pause.
- **Signal coverage/confidence:** confidence in the available measurement, never a judgment of the speaker's personal confidence.
- **AudioWorklet:** browser audio-rendering-thread processing that provides regular sample blocks and sends compact measurements to the page.
- **IndexedDB:** origin-scoped browser storage for structured summaries and `Blob` artifacts.

### Feedback mode and review are different

| During a review-only baseline/retry | During a single coached attempt | After either attempt |
| --- | --- | --- |
| Prompt, goal, timer, and microphone-connected state only | Acoustic evidence only; no cue in the first five seconds | Acoustic plus optional transcript-derived evidence |
| No live meter, statistics, or coaching-tip surface | One cue shown for five seconds, with at least ten seconds between displayed cues | Strength, one highest-value focus, one drill, evidence, and card provenance |
| Measurements withheld until review | Sparse live evidence is not used to create a pair | Captured text cleared unless separate retention was selected; a linked retry also receives the goal-specific pair comparison |

This separation reduces cognitive load and prevents late transcript results from changing live behavior invisibly.

Checkpoint: Explain why unknown is not silence, why trailing quiet is not an interior pause, and why the worklet does not “understand speech.” For formulas and exact thresholds, use [Speech coaching prototype](SPEECH_COACHING_PROTOTYPE.md#audio-signal-processing).

## 25:00–30:00 — Explain the small local RAG precisely

The honest short answer is:

> Yes. NonStopTalk uses a small local **retrieval-augmented deterministic generation** pipeline: goal and aggregate evidence rank six bundled product-authored cards and retain up to two results; a supported top card normally supplies its unchanged drill; deterministic rules append a fixed comparison sentence; and an evidence-safety rule can keep unsupported card advice out of the result.

### What each word means here

| Part | NonStopTalk implementation |
| --- | --- |
| **Retrieval** | Weighted lexical matching over six cards bundled in `coach-engine.js` |
| **Augmentation** | When supported, the top card's drill shapes the advice and its title, excerpt, and source provide visible provenance. Otherwise those card fields are context only and the measured priority supplies the drill. |
| **Generation** | Bounded deterministic assembly of prewritten parts, not free-form model prose |
| **Grounding guard** | If the card's advice is not supported by measured evidence, use the measured priority's drill and label the card **retrieved context**, not **used guidance** |

The same goal and report produce the same result. There is no LLM, embedding model, vector database, remote corpus, model prompt, provider API, or network request.

Why call it RAG at all? It still separates a knowledge corpus from a query, retrieves relevant context at runtime, and uses that context to construct a response. The word **deterministic** is essential because this is not the neural LLM architecture people usually assume when they hear RAG.

Why choose this design now?

- private: the query and evidence remain in the browser;
- free: no model, speech, embedding, or vector service;
- fast: no network round trip;
- auditable: every possible card and template can be inspected;
- testable: evidence-safety behavior is deterministic; and
- presentation-safe: the source label shows whether retrieval actually shaped the drill.

Checkpoint: Answer three questions: What is retrieved? What is generated? What prevents unsupported advice? The deeper ranking and grounding walkthrough is in [Small local RAG, deterministic tips, and advice](SPEECH_COACHING_PROTOTYPE.md#small-local-rag-deterministic-tips-and-advice).

## 30:00–36:00 — Separate runtime, routes, and data

### Online request paths

```text
GET /practice or /progress
    → Workers Static Assets returns the SPA
    → coaching and IndexedDB work remain in the browser
    → default/off: no coaching-data API request
    → explicit compact backup only: /api/v1/progress/sessions → D1

GET /room/ABC234
    → Workers Static Assets returns the same SPA
    → browser calls /api/rooms/ABC234/...
    → Worker validates and maps the room code through binding ROOMS
    → one SQLite-backed Durable Object serializes and persists that room
    → hibernatable WebSockets carry live public state
```

The public API is:

```text
POST /api/rooms
GET  /api/rooms/:code/state
POST /api/rooms/:code/join
POST /api/rooms/:code/action
WS   /api/rooms/:code/socket

GET/HEAD /api/v1/platform/status
GET    /api/v1/progress/sessions
POST   /api/v1/progress/sessions       explicit compact backup only
DELETE /api/v1/progress/sessions
GET    /api/v1/progress/export
GET    /api/v1/admin/analytics         protected bearer token
```

The status route checks D1 readiness and reports only non-secret configured or degraded capability state. The analytics route reads best-effort operational rollups, not an audit or billing ledger.

There is **no public Durable Object route**. The Worker selects an object with the normalized room code and forwards internally through the `ROOMS` binding. The implementation constructs an internal `https://room.internal/{state|join|action|socket}` request, but that is not a player-facing URL. The player-facing page remains `/room/ABC234`.

`wrangler.jsonc` connects the system:

- Worker entry: `cloudflare/worker.ts`
- static directory: `cloudflare/public`
- SPA fallback for page routes
- Worker-first behavior only for `/api/*`
- `ROOMS` binding to `RoomDurableObject`
- SQLite Durable Object migration `v1`
- `PLATFORM_DB` binding and append-only D1 migrations
- `PRODUCT_ANALYTICS` best-effort Analytics Engine binding

This is a **Worker with Static Assets**, not a Pages-only project and not a Container.

### Storage and consent ladder

| Data | Default? | Location | Network/export/delete behavior |
| --- | --- | --- | --- |
| Aggregate measurements and advice | Saved after a completed attempt when IndexedDB is available | `session-summaries` in origin-local IndexedDB | Default/off makes no coaching-data API call; included in summary JSON |
| Derived pace/filler/repetition evidence | Only after transcript-analysis consent and strict-local support | Bounded fields in the compact summary | No remote fallback; derived words can still be sensitive |
| Captured transcript text | No | `session-artifacts` only when transcript analysis captured text **and** full-session retention was selected | Excluded from JSON; individual download; may be flagged possibly partial |
| Attempt recording | No | Browser-encoded `MediaRecorder` `Blob` in `session-artifacts` after separate retention opt-in | Calibration excluded; no upload; excluded from JSON; individual download or artifact-only deletion |
| Compact cloud summary | No | Central D1, keyed to a hashed anonymous browser identity | Separate explicit choice; allowlisted metrics/advice and bounded derived patterns only; one device-level day-bucketed 30–31-day inactivity lease; new saves stop once 250 exist |
| Multiplayer room state | Only for Play rooms | Private SQLite storage in the room Durable Object | Worker/DO traffic; expires after 30 days without a state change |

Full-session retention and compact cloud backup are independent and start off. A standalone **Try again** and direct baseline retry preserve visible selections so the user can review or uncheck them; a retry resumed from Progress starts every optional data choice unchecked. Progress can delete one attempt's artifacts while preserving its compact summary and pair. Untouched v2 origins have no app-scheduled artifact expiry; profiles with newer lifecycle records keep their 30-day expiry during rollback. One UTC-day-bucketed device lease controls all of an anonymous browser's summaries, lasts at least 30 and less than 31 days after cloud use, and avoids per-summary renewal writes. The cloud cookie is not an account or recovery credential, so there is no cross-device Progress. IndexedDB remains best-effort, and deleting browser data cannot remove files already downloaded.

### Two editions that can both run locally

| Command | Runtime | Coaching? |
| --- | --- | --- |
| `npm run dev` | Native Cloudflare SPA + local Worker/Durable Object runtime | Yes, at `/practice` and `/progress` |
| `go run ./cmd/web` | Separate Go/HTMX game at port 8080 | No; it is the richer local game edition |

Checkpoint: Trace one Practice attempt and one Play action. Name exactly where each datum crosses a network and where it is stored. Read [Technical architecture](TECHNICAL_ARCHITECTURE.md) and [AI and privacy](AI_AND_PRIVACY.md) if any boundary remains unclear.

## 36:00–40:00 — State measurement and limitations honestly

### Implemented now

- session-specific calibration and device-relative acoustic measurements;
- sparse live acoustic cues and deterministic post-attempt advice;
- six-card local lexical retrieval with grounding status;
- optional strict on-device transcript-derived metrics;
- local-first summaries, explicit loop grouping/comparison, export, artifact-only and all-local-store deletion, opted-in artifact downloads, and optional compact D1 backup;
- Worker-with-Assets deployment and Durable Object multiplayer rooms;
- 34 deterministic coaching/loop tests plus two IndexedDB storage-contract tests, coaching/platform browser smoke, Worker tests, typechecking, Go checks, and Wrangler dry-run validation.

### Not proven or not implemented

- no validated learning outcome or evidence that the implemented paired delta means improvement;
- no universal speaker-quality, confidence, emotion, honesty, accent, health, or professionalism score;
- no guarantee across microphones, rooms, browsers, languages, accents, or disabilities;
- no account, cross-device authentication/sync, curriculum, or production external semantic/LLM coaching;
- no Queue-backed provider processing or R2 media storage;
- no formal accessibility, security, privacy, clinical, or fairness certification; and
- no claim that this replaces a speech-language professional or human coach.

Tests show that the implementation follows its defined rules and privacy boundaries under tested conditions. They do not prove real-device measurement accuracy, usefulness, fairness, or learning outcomes.

The proposed pilot's primary outcome is the distribution of paired, goal-specific change between a baseline and its comparable unassisted retry. Do not choose a numeric success target or label a direction as improvement until a pilot establishes measurement quality, repeatability, context, and a baseline distribution.

The in-progress platform attempts only coarse room/summary-save/delete/consent aggregates for operations and funnel health. D1 rollups and Analytics Engine writes are both best-effort and can miss events. They do not copy coaching measurements into telemetry or measure learning outcomes. A pilot would still need explicit consent and a separate study design with paired outcomes and participant/facilitator ratings.

Checkpoint: Say one implemented claim and one limitation in the same answer. Example: “The prototype deterministically reports device-relative timing evidence; it has not yet validated that its thresholds work equally well across devices or users.”

## 40:00–45:00 — Rehearse the full presentation

Open the [Presentation cheat sheet](PRESENTATION_CHEAT_SHEET.md), set a five-minute timer, and deliver its **Problem → Constraints → Demo → Design → Measurement → Boundary** story without stopping. Use the real app if it is ready; otherwise use the prepared Progress result.

During the rehearsal, make sure you say all of these:

- Practice is coaching; Play is the game; Progress is local-first Practice history.
- Coaching goes from microphone reduction to measurement, local retrieval, deterministic advice, and IndexedDB.
- The RAG component has no LLM, embeddings, vector database, or network call.
- Transcript analysis, local artifact retention, and compact cloud backup are independent; coaching data never enters room Durable Objects.
- The prototype proves an engineering loop, not learning outcomes or a universal measure of speaking quality.

If you finish early, answer the five questions below. If you run long, shorten the mechanics before removing the limitation and next-step statement.

## After the clock — self-check

1. Which tab is coaching?
2. Are we using RAG, and is there an LLM?
3. Does coaching audio go to Cloudflare?
4. What is the Durable Object's route?
5. How do we plan to measure whether coaching helps, and how would a pilot collect that data?

If any answer feels weak, reread only that section.

### Precise language to keep

| Imprecise | Precise |
| --- | --- |
| AI-generated advice | Deterministic rules and a retrieved product-authored drill |
| LLM RAG or vector search | Local lexical RAG with deterministic template assembly |
| Raw audio recording | Browser-encoded `MediaRecorder` recording; raw frames are not retained |
| Speech understanding | Voice-activity estimation; only optional local recognition handles words |
| Confidence score | Signal or measurement confidence, never speaker confidence |
| Loudness in dB | Device-relative RMS and peak amplitude |
| Silence means a pause | Interior measured quiet with voice on both sides; unknown is not silence |
| Cloudflare stores the full coaching session | IndexedDB stores local summaries and all artifacts; explicit backup may send only the compact summary to D1 |
| Durable Object endpoint | Public Worker API routed through an internal Durable Object binding |
| Pages deployment | Worker with Static Assets and a Durable Object |
| Progress proves improvement | Progress shows explicitly linked raw baseline/retry measurements, descriptive deltas, and signal limitations; improvement and learning remain unvalidated |
| Validated, accurate, or fair | Work-in-progress engineering defaults that still require formal validation |
