# NonStopTalk presentation cheat sheet

Keep this page open beside the demo. Use [Learn NonStopTalk in 45 minutes](LEARN_IN_45_MINUTES.md) to understand the material and the [full presentation guide](COACHING_PRESENTATION_GUIDE.md) for longer answers.

## 30-second pitch

> NonStopTalk turns private speaking rehearsal into a deliberate-practice loop: speak, see a small number of explainable signals, get one useful next action, and try again. Practice provides private browser-side coaching, Play keeps the original multiplayer game, and Progress shows local Practice history. The prototype uses transparent signal processing and a small local retrieval layer, not a paid speech service or an LLM.

## Three tabs

| Tab | Say this |
| --- | --- |
| **Practice** `/practice` | “This is the coaching mode: calibrate, speak, review evidence, and retry.” |
| **Play** `/` | “This is the social speaking game. Online rooms use a Worker and one Durable Object per room.” |
| **Progress** `/progress` | “This is origin-local Practice history, not a leaderboard or universal speech score.” |

Memory aid: **Practice coaches. Play motivates. Progress makes practice visible.**

## One-picture architecture

```text
Practice: mic → AudioWorklet → measurements → local card → advice → IndexedDB
Progress:                                                     ↑ reads IndexedDB

Play: browser → /api/rooms/... Worker → ROOMS binding → SQLite Durable Object
                                      ↕ hibernatable WebSockets

Cloudflare serves the SPA files. Coaching data does not enter /api or a Durable Object.
```

## Five-minute story

| Time | Point |
| --- | --- |
| 0:00–0:35 | **Problem:** solo rehearsal lacks fast, actionable feedback |
| 0:35–1:15 | **Constraints:** privacy, consent, device variability, distraction, fairness, explainability, and zero-cost demo |
| 1:15–2:25 | **Demo:** one goal → calibration → short attempt → Strength / Focus / Drill |
| 2:25–3:30 | **Design:** browser signal pipeline, optional local words, deterministic local RAG, separate storage choices |
| 3:30–4:20 | **Measurement:** baseline → review → comparable unassisted retry; goal-specific change and guardrails |
| 4:20–5:00 | **Boundary:** engineering prototype, not validated outcome/therapy; next step is a consented pilot |

## Stable demo sequence

Install or select Node 24 first—the timed learning guide covers both the official installer and a version-manager example—then start the coaching-capable edition:

```sh
node --version # must print v24...
npm ci
npm run dev -- --local --ip 127.0.0.1 --port 8787
```

If port 8787 is occupied, stop that process or omit `--port 8787` and use the exact URL Wrangler prints.

Then:

1. Open `/` and name the three tabs.
2. Open `/practice`; choose Presentation opening, Purposeful pauses, 30 seconds.
3. Leave both optional boxes off for the primary demo.
4. Calibrate: about two seconds quiet, then two seconds normal speech.
5. Speak, pause for about one second, and speak again. Voice must occur on both sides for an interior pause.
6. On Review, show Strength, Focus next, Drill, evidence, timeline, and Local RAG grounding label.
7. Open `/progress` and show the compact local summary.
8. Demonstrate transcription or artifact retention only in a browser where you already tested it.

The Go command at port 8080 runs a separate game edition; it does not contain Practice or Progress.

## RAG answer

> Yes, in a deliberately small local form. Goal and aggregate evidence lexically rank six bundled product-authored cards and keep up to two results. A supported top card normally contributes its unchanged drill; an evidence-safety rule substitutes a measurement-backed drill when needed and labels the card context only. Deterministic assembly appends one fixed comparison sentence. There is no LLM, free-form prose, embeddings, vector database, remote corpus, or network call. The precise name is **retrieval-augmented deterministic generation**.

What is retrieved? **A coaching card.** What is generated? **A bounded assembly of prewritten parts.** What guards it? **Measured-evidence safety rules and visible grounding status.**

## Storage and privacy answer

| Choice | Result |
| --- | --- |
| Default attempt | Compact allowlisted measurement/advice summary in this origin's IndexedDB |
| Transcript analysis checked | Strict on-device recognition may add pace/counts and bounded derived word patterns; no remote fallback |
| Full-session retention checked | Separate store may keep a browser-encoded attempt recording and available captured transcript; calibration is excluded |
| JSON export | Summaries only; no recording or captured transcript |
| Delete local history | Clears both app stores for this origin; cannot delete already downloaded files |

Both optional boxes start off on a fresh page and do different jobs. **Try again** preserves the visible selections so the user can review or uncheck them. There is no coaching upload, automatic artifact expiry, account, cloud backup, or cross-device sync. IndexedDB is best-effort: clearing site data, private-browsing behavior, or storage pressure can remove records. A transcript that fails to finalize after captured text arrives can be kept with a visible **possibly partial** warning.

## Durable Object answer

> Durable Objects coordinate multiplayer Play rooms only. The player opens `/room/ABC123`; the browser uses `/api/rooms/ABC123/{state|join|action|socket}`. The Worker validates the request, selects one SQLite-backed object by room code through the internal `ROOMS` binding, and forwards the operation. The Durable Object has no separate public URL. Practice and Progress do not create or call one.

Deployment description: **Worker with Static Assets plus a SQLite Durable Object**, not Pages-only and not a Container.

## Deploy quick reference

```sh
node --version # must print v24...
npm ci
npm run typecheck:cloudflare
npm run test:cloudflare
npm run test:coach
npm run check:cloudflare
npx wrangler login
npm run deploy
```

For a repository-connected build, create a **Worker** project, use repository root `/`, select Node 24, leave the output directory unset, use `npm run typecheck:cloudflare && npm run test:cloudflare && npm run test:coach` as the build command, and use `npm run deploy` as the deploy command.

## Safe claims

| Safe to say | Do not claim |
| --- | --- |
| Device-relative RMS/peak and timing evidence | Calibrated dB/SPL or universal loudness |
| Voice/quiet estimation with explicit unknown time | Word understanding from the worklet |
| Signal or measurement confidence | The speaker is confident |
| Local lexical retrieval and deterministic templates | LLM-generated or vector-searched advice |
| Browser-encoded recording after opt-in | Raw PCM retention |
| Engineering behavior covered by deterministic and browser tests | Proven real-device accuracy, learning, fairness, accessibility, security, or privacy certification |
| Descriptive local attempt history | Progress already proves improvement |
| General rehearsal tool | Speech therapy, diagnosis, or replacement for a professional |

Never say the app infers confidence, emotion, honesty, personality, health, identity, professionalism, or accent quality.

## Rapid Q&A

**Is this AI?**

There is no generative model. Be concrete: transparent signal rules, local lexical retrieval, deterministic template assembly, and optional strict on-device browser recognition.

**How does it know I am speaking?**

It estimates voice activity from RMS thresholds calibrated to the current room and microphone. Noise can fool it; it does not understand the words unless optional recognition is available and enabled.

**Does my voice go to Cloudflare?**

No coaching audio, transcript, summary, or recording does. Cloudflare serves files and coordinates Play rooms.

**Can I keep the recording and transcript?**

The separate unchecked retention choice records the active attempt. It keeps a captured transcript only when the experimental transcript-analysis option was also enabled, strict local recognition returned text, and retention was selected. Available artifacts remain in origin-local IndexedDB and download individually. The recording is browser-encoded, not raw PCM.

**Why AudioWorklet?**

It processes regular sample blocks with browser audio rendering and sends compact frames to the page. `AnalyserNode` is the compatibility fallback.

**Why not use a cloud model?**

That adds cost, latency, provider and consent boundaries, nondeterminism, source governance, prompt-injection risk, and a much larger evaluation burden.

**How do you know it helps?**

We do not claim that yet. The next pilot should measure completed baseline/review/unassisted-retry loops, paired goal-specific change, false tips, distraction, availability, privacy, grounding, device effects, and fairness. The app sends no product analytics today; a pilot needs consented summary exports and participant/facilitator ratings or a separately consented study logger.

**Why did the original Cloudflare deploy fail?**

Wrangler had no declared Worker entry point or static asset directory. `wrangler.jsonc` now names `cloudflare/worker.ts`, `cloudflare/public`, the SPA fallback, and the Durable Object binding/migration, making this a Worker-with-Assets deployment.

**Is it free?**

The design requires no paid speech, AI, embedding, vector, database, or Container service and is configured for current Workers Free allocations. Do not promise unlimited or permanent pricing.

**Why keep Play?**

Play creates social repetition and motivation; Practice creates deliberate personal feedback. Their scoring meanings remain separate.

## Demo fallback order

1. Keep local Wrangler running even if the deployed site is the primary demo.
2. Pre-create one non-sensitive summary on both the deployed origin and local origin; they do not synchronize.
3. Keep `/progress` open in a backup tab.
4. If strict local transcription is unavailable, demonstrate audio-only coaching and explain fail-closed behavior.
5. If `AudioWorklet` is unavailable, point out the automatic Analyser compatibility mode.
6. If `MediaRecorder` is unavailable, full-session retention is disabled; compact summaries and coaching still work.
7. If IndexedDB is unavailable, Review may still render, but saving and Progress history will not; use the prepared result in the tested browser profile.
8. Practice requires microphone input. Play's manual timer is not a coaching fallback; if microphone or calibration fails, narrate the pipeline from the prepared Progress result.
9. Do not invent a remote transcription fallback.

## Closing line

> This prototype proves that private, explainable coaching can coexist with the original social game and deploy on the free web stack. It does not yet prove learning outcomes or equal performance across devices and users. The next step is a small consented pilot and comparable baseline-to-retry measurement.
