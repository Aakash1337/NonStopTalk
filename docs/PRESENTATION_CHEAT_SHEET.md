# NonStopTalk presentation cheat sheet

Keep this page open beside the demo. Use [Learn NonStopTalk in 45 minutes](LEARN_IN_45_MINUTES.md) to understand the material and the [full presentation guide](COACHING_PRESENTATION_GUIDE.md) for longer answers.

## 30-second pitch

> NonStopTalk turns private speaking rehearsal into a deliberate-practice loop: complete a review-only baseline, inspect explainable evidence and one next action, then make a linked unassisted retry and inspect raw goal-specific change. Practice provides private browser-side coaching, Play keeps the original multiplayer game, and Progress is local-first with optional compact-summary backup. The prototype uses transparent signal processing and a small local retrieval layer, not a paid speech service or an LLM. It does not claim the retry improved.

## Three tabs

| Tab | Say this |
| --- | --- |
| **Practice** `/practice` | “This is the coaching mode: calibrate, speak, review evidence, and retry.” |
| **Play** `/` | “This is the social speaking game. Online rooms use a Worker and one Durable Object per room.” |
| **Progress** `/progress` | “This groups only explicitly linked practice loops and shows descriptive selected-goal evidence with an optional compact-summary backup—not a leaderboard, universal score, or proof of improvement.” |

Memory aid: **Practice coaches. Play motivates. Progress makes practice visible.**

## One-picture architecture

```text
Practice: mic → AudioWorklet → measurements → local card → advice → IndexedDB
Progress:                                                     ↑ reads IndexedDB
                       explicit compact-summary backup → Worker API → D1

Play: browser → /api/rooms/... Worker → ROOMS binding → SQLite Durable Object
                                      ↕ hibernatable WebSockets
                                      └→ bounded milestone outbox → receipt-gated D1

Default/off coaching makes no coaching-data API call. The optional backup sends only an
allowlisted summary to D1. Audio, recordings, and captured transcripts stay local, and
coaching data never enters a room Durable Object.
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

Use Node 22 or newer; Node 24 matches CI and is the preferred demo choice. The timed learning guide covers both the official installer and a version-manager example. Then start the coaching-capable edition:

```sh
node --version # v22+; v24 matches CI
npm ci
npm run db:migrate:local
npm run dev -- --local --ip 127.0.0.1 --port 8787
```

If port 8787 is occupied, stop that process or omit `--port 8787` and use the exact URL Wrangler prints.

Then:

1. Open `/` and name the three tabs.
2. Open `/practice`; choose Presentation opening, Purposeful pauses, 30 seconds.
3. Keep the recommended baseline/retry format and leave all optional data choices off for the primary demo.
4. Calibrate: about two seconds quiet, then two seconds normal speech.
5. Speak, pause for about one second, and speak again. Voice must occur on both sides for an interior pause.
6. Point out that the review-only baseline showed no live meter, statistics, or coaching cues. On Review, show Strength, Focus next, Drill, evidence, timeline, and Local RAG grounding label.
7. Show **Prepare unassisted retry** and the locked scenario/goal/duration. Complete it only if time permits; otherwise prepare a non-sensitive completed pair on this exact origin before presenting.
8. Open `/progress`; show the grouped/resumable loop or completed raw goal-specific comparison, including its limited-evidence reasons and caveats.
9. Demonstrate transcription or artifact retention only in a browser where you already tested it.

The Go command at port 8080 runs a separate game edition; it does not contain Practice or Progress.

## RAG answer

> Yes, in a deliberately small local form. Goal and aggregate evidence lexically rank six bundled product-authored cards and keep up to two results. A supported top card normally contributes its unchanged drill; an evidence-safety rule substitutes a measurement-backed drill when needed and labels the card context only. Deterministic assembly appends one fixed comparison sentence. There is no LLM, free-form prose, embeddings, vector database, remote corpus, or network call. The precise name is **retrieval-augmented deterministic generation**.

What is retrieved? **A coaching card.** What is generated? **A bounded assembly of prewritten parts.** What guards it? **Measured-evidence safety rules and visible grounding status.**

## Storage and privacy answer

| Choice | Result |
| --- | --- |
| Default attempt | Compact allowlisted measurement/advice summary in this origin's IndexedDB |
| Transcript analysis checked | Strict on-device recognition may add pace/counts and bounded derived word patterns; no remote fallback |
| Full-session retention checked | Separate store may keep a browser-encoded attempt recording and available captured transcript; calibration is excluded; a required content-free ledger gives the artifact exactly 30 days |
| Compact cloud backup checked | Sends only allowlisted measurements/advice and bounded derived word-pattern fields to D1 under an anonymous browser identity |
| JSON export | Summaries only; no recording or captured transcript |
| Delete saved artifacts | Removes one attempt's local recording/transcript and resets artifact metadata; preserves its compact summary and paired comparison |
| Delete history | Clears all local coaching stores and, when cloud backup is enabled/reachable, this browser identity's compact D1 summaries; cannot delete downloaded files |

The optional choices start off and do different jobs. A standalone **Try again** and a direct baseline retry preserve visible selections so the user can review or uncheck them; a retry resumed from Progress starts all optional data choices unchecked. Cloud backup is not an account: access is tied to this anonymous browser identity. One UTC-day-bucketed device lease controls all its summaries and lasts at least 30 and less than 31 days after cloud use. New cloud saves stop when 250 summaries already exist; migration does not forcibly delete valid unexpired cloud rows. There is no cross-device authentication or sync. Locally, IndexedDB v3 gives new artifacts exactly 30 days from save and v1/v2 artifacts exactly 30 days from upgrade. Its 128 MiB logical cap never evicts valid unexpired artifacts: an app-limit or browser-quota failure keeps the summary only. Progress shows exact point-in-time logical use and absolute retention deadlines, not the browser's separate quota. Incompatible or inconsistent artifact state fails closed, while Release A remains a safe code rollback for an already-upgraded database. Browser storage is best-effort and can disappear sooner; expiry cleanup runs on a later access. A transcript that fails to finalize after captured text arrives can be retained locally with a visible **possibly partial** warning.

## Durable Object answer

> Durable Objects coordinate multiplayer Play rooms only. The player opens `/room/ABC234`; the browser uses `/api/rooms/ABC234/{state|join|action|socket}`. The Worker validates the request, selects one SQLite-backed object by room code through the internal `ROOMS` binding, and forwards the operation. The Durable Object has no separate public URL. Practice and Progress do not create or call one.

The committed production and staging policy selects the same exact room-milestone lane: the room mutation and bounded local event group share one SQLite transaction and existing alarm, then each delivered milestone gets one 90-day D1 receipt so replay cannot repeat its eligible room fact or daily rollup. Both environments completed their separate attended exact-mode proofs on 2026-09-02. Progress/consent D1 counters and all Analytics Engine writes remain best-effort.

Deployment description: **Worker with Static Assets plus a SQLite Durable Object**, not Pages-only and not a Container.

## Deploy quick reference

```sh
node --version # v22+; v24 matches CI
npm ci
npm run typecheck:cloudflare
npm run test:cloudflare
npm run test:coach
npm run test:cloud-progress
npm run test:microphone-selection
npm run test:sound-cues
npm run check:cloudflare
npm run smoke:platform
npm run smoke:coach-storage
npx wrangler login
npm run db:create
# copy the returned database UUID into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put ANALYTICS_ADMIN_TOKEN
npx wrangler secret put ROOM_FACT_HASH_KEY
npm run deploy
```

For a repository-connected build, create a **Worker** project, use repository root `/`, select Node 22 or newer (24 matches CI), leave the output directory unset, and run the Cloudflare, coach, and cloud-progress tests in the build command. Provision D1, apply its migrations, and configure both secrets once per environment before using `npm run deploy`.

The production outbox-activation canary already completed on 2026-09-02. Do not rerun that mutating proof for routine releases. Use the read-only `npm run smoke:production` probe and the `Production health` workflow; the production runbook owns the separately reviewed procedure for a future high-risk delivery-policy change.

## Safe claims

| Safe to say | Do not claim |
| --- | --- |
| Device-relative RMS/peak and timing evidence | Calibrated dB/SPL or universal loudness |
| Voice/quiet estimation with explicit unknown time | Word understanding from the worklet |
| Signal or measurement confidence | The speaker is confident |
| Local lexical retrieval and deterministic templates | LLM-generated or vector-searched advice |
| Browser-encoded recording after opt-in | Raw PCM retention |
| Engineering behavior covered by deterministic and browser tests | Proven real-device accuracy, learning, fairness, accessibility, security, or privacy certification |
| Explicitly linked raw baseline/retry values, descriptive deltas, signal limitations, and caveats | Progress proves improvement, a learning outcome, or a universally better direction |
| General rehearsal tool | Speech therapy, diagnosis, or replacement for a professional |

Never say the app infers confidence, emotion, honesty, personality, health, identity, professionalism, or accent quality.

## Rapid Q&A

**Is this AI?**

There is no generative model. Be concrete: transparent signal rules, local lexical retrieval, deterministic template assembly, and optional strict on-device browser recognition.

**How does it know I am speaking?**

It estimates voice activity from RMS thresholds calibrated to the current room and microphone. Noise can fool it; it does not understand the words unless optional recognition is available and enabled.

**Does my voice go to Cloudflare?**

No coaching audio, recording, or captured transcript does. Cloud backup is off by default; if selected, only the compact allowlisted summary goes to the NonStopTalk Worker/D1 platform.

**Can I keep the recording and transcript?**

The separate unchecked retention choice records the active attempt. It keeps a captured transcript only when the experimental transcript-analysis option was also enabled, strict local recognition returned text, and retention was selected. Available artifacts remain in origin-local IndexedDB and download individually. IndexedDB v3 gives each new artifact exactly 30 days and tracks only policy metadata in its lifecycle ledger; the browser may remove best-effort storage earlier. Progress can delete one attempt's artifacts while preserving its compact summary and pair; downloaded files remain outside application control. The recording is browser-encoded, not raw PCM.

**Why AudioWorklet?**

It processes regular sample blocks with browser audio rendering and sends compact frames to the page. `AnalyserNode` is the compatibility fallback.

**Why not use a cloud model?**

That adds cost, latency, provider and consent boundaries, nondeterminism, source governance, prompt-injection risk, and a much larger evaluation burden.

**How do you know it helps?**

We do not claim that yet. Pairing and descriptive comparison are implemented; their accuracy, repeatability, usefulness, fairness, and learning effect are not validated. The next pilot should measure completed loops, paired goal-specific distributions, false tips, distraction, availability, privacy, grounding, device effects, and fairness. Receipt-gated room-milestone D1 counters and best-effort summary-save/delete/consent counters do not measure learning outcomes; a pilot still needs a separate consented study design.

**Why did the original Cloudflare deploy fail?**

Wrangler had no declared Worker entry point or static asset directory. `wrangler.jsonc` now names `cloudflare/worker.ts`, `cloudflare/public`, the SPA fallback, and the Durable Object binding/migration, making this a Worker-with-Assets deployment.

**Is it free?**

The design uses free/low-cost Cloudflare primitives and requires no paid speech, AI, embedding, vector, Queue, R2, or Container service. Exact room-milestone delivery reuses bounded Durable Object SQLite plus its existing alarm and adds one 90-day D1 receipt per delivered milestone; it adds no service, binding, secret, migration, model, paid product, or fixed monthly cost. Accounts, external coaching AI, Queues, and R2 are future choices. Do not promise unlimited or permanent pricing.

**Why keep Play?**

Play creates social repetition and motivation; Practice creates deliberate personal feedback. Their scoring meanings remain separate.

## Demo fallback order

1. Keep local Wrangler running even if the deployed site is the primary demo.
2. Pre-create one non-sensitive local summary on each demo origin; anonymous cloud backup is browser/origin-bound and is not cross-device sync.
3. Keep `/progress` open in a backup tab.
4. If strict local transcription is unavailable, demonstrate audio-only coaching and explain fail-closed behavior.
5. If `AudioWorklet` is unavailable, point out the automatic Analyser compatibility mode.
6. If `MediaRecorder` is unavailable, full-session retention is disabled; compact summaries and coaching still work.
7. If IndexedDB is unavailable, Review may still render, but saving and Progress history will not; use the prepared result in the tested browser profile.
8. Practice requires microphone input. Play's manual timer is not a coaching fallback; if microphone or calibration fails, narrate the pipeline from the prepared Progress result.
9. Do not invent a remote transcription fallback.

## Closing line

> This prototype proves that private, explainable coaching and an explicit baseline-to-retry measurement loop can coexist with the original social game and deploy on the free web stack. It does not prove learning outcomes or equal performance across devices and users. The next step is a small consented pilot to validate repeatability and interpretation.
