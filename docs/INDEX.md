# NonStopTalk documentation

This is the documentation front door. The repository contains detailed reference material, but you do not need to read all of it to understand or present the project.

## Start here

If you have about 45 minutes:

1. Follow [Learn NonStopTalk in 45 minutes](LEARN_IN_45_MINUTES.md).
2. Keep the [Presentation cheat sheet](PRESENTATION_CHEAT_SHEET.md) open while rehearsing.
3. Use the [Coaching presentation guide](COACHING_PRESENTATION_GUIDE.md) for the full five-minute talk, demo fallbacks, and deeper audience questions.

At the end, you should be able to explain:

- why **Practice** is the coaching mode, **Play** is the multiplayer game, and **Progress** is browser-local coaching history;
- how microphone samples become measurements and one next action;
- why the project calls its small retrieval layer **retrieval-augmented deterministic generation**;
- what stays in the browser, what is optional, and what reaches Cloudflare;
- why Durable Objects coordinate Play rooms but do not store coaching data; and
- which results are implemented engineering checks versus future product-validation work.

## The product in one diagram

```text
Practice /practice                                      Progress /progress
browser coaching                                       browser history
Web Audio + optional                                          │
on-device transcript analysis                                 │ reads
          │ writes                                             ▼
          └──────────────────> IndexedDB v2 <──────────────────┘
                               ├─ session-summaries
                               └─ session-artifacts (opt-in)

Play / + /room/ABC123
social multiplayer ── /api + WebSocket ──> Worker ──> room Durable Object

Cloudflare serves the online files for all three surfaces.
Only Play room traffic enters the Worker API and Durable Objects.
```

The shortest memory aid is: **Practice coaches. Play motivates. Progress makes practice visible.** Game points are not coaching scores.

## Find the right document

| If you need to… | Read this | Why |
| --- | --- | --- |
| Learn the project quickly | [Learn NonStopTalk in 45 minutes](LEARN_IN_45_MINUTES.md) | Timed path, checkpoints, code trace, and precise vocabulary |
| Present it | [Presentation cheat sheet](PRESENTATION_CHEAT_SHEET.md) | Pitch, demo sequence, architecture, safe claims, and rapid Q&A |
| Build the full narrative | [Coaching presentation guide](COACHING_PRESENTATION_GUIDE.md) | Problem → Constraints → Design → Measurement, five-minute script, and fallbacks |
| Understand the coaching implementation | [Speech coaching prototype](SPEECH_COACHING_PROTOTYPE.md) | Canonical signal-processing, RAG, storage-schema, file-tour, and limitation reference |
| Understand both runtime editions | [Technical architecture](TECHNICAL_ARCHITECTURE.md) | Go application, Cloudflare SPA, Worker, Durable Objects, and browser boundaries |
| Explain privacy and retention | [AI and privacy](AI_AND_PRIVACY.md) | Consent choices, exact data flows, storage, deletion, and responsible-use limits |
| Deploy or diagnose Cloudflare | [Cloudflare deployment](CLOUDFLARE_DEPLOYMENT.md) | Node requirements, Workers Builds settings, routes, costs, and the original build-error fix |
| Check whether a feature exists | [Requirements and implementation status](REQUIREMENTS.md) | Implemented behavior, acceptance baseline, and explicit backlog |
| Discuss what comes next | [Roadmap](ROADMAP.md) | Implemented prototype, hardening work, and future product lanes |
| Explain Play rules | [Game design](GAME_DESIGN.md) | Room roles, turn flow, scoring, topics, and local/online differences |
| Explain the product thesis | [Product](../PRODUCT.md) | Users, jobs, product purpose, success, and safety principles |
| Explain the visual direction | [Design](../DESIGN.md) | Practice/Play/Progress hierarchy, visual system, copy, and accessibility intent |
| Run the Go desktop-style launcher | [Desktop application](DESKTOP_APPLICATION.md) | Scope and limitations of the browser-launching Go executable |

## Canonical ownership

Use this table when two documents discuss the same topic. Code and tests are the final implementation truth; these are the primary human-readable owners.

| Topic | Primary document |
| --- | --- |
| Current feature status | [Requirements and implementation status](REQUIREMENTS.md) |
| Future product work | [Roadmap](ROADMAP.md) |
| Coaching mechanics, formulas, thresholds, and code tour | [Speech coaching prototype](SPEECH_COACHING_PROTOTYPE.md) |
| Whole-system and runtime boundaries | [Technical architecture](TECHNICAL_ARCHITECTURE.md) |
| Consent, storage, retention, and AI-provider boundaries | [AI and privacy](AI_AND_PRIVACY.md) |
| Cloudflare setup, routes, free-plan design, and troubleshooting | [Cloudflare deployment](CLOUDFLARE_DEPLOYMENT.md) |
| Presentation narrative, demo, measurement, and Q&A | [Coaching presentation guide](COACHING_PRESENTATION_GUIDE.md) |
| Multiplayer rules and scoring | [Game design](GAME_DESIGN.md) |
| Product and interface intent | [Product](../PRODUCT.md) and [Design](../DESIGN.md) |

## Historical reference

- [Historical web version plan](WEB_VERSION_PLAN.md) describes the earlier Go/HTMX direction. It is useful context, not the architecture plan for the newer Cloudflare SPA.

## Vocabulary that prevents common mistakes

| Avoid saying | Say instead |
| --- | --- |
| “The coaching tab” without naming it | “Practice is the coaching mode.” |
| “Cloudflare stores the coaching session” | “The current browser origin stores coaching summaries and opted-in artifacts in IndexedDB.” |
| “The Durable Object URL” | “The public Worker API routes Play room traffic through an internal Durable Object binding.” |
| “Raw audio is retained” | “The optional artifact is a browser-encoded `MediaRecorder` recording; raw sample frames are reduced and not retained.” |
| “LLM RAG” or “vector search” | “Local lexical retrieval plus deterministic template assembly, with no LLM, embeddings, vector database, or network call.” |
| “Speaker confidence score” | “Signal or measurement confidence; the app does not infer a person's confidence.” |
| “Progress proves improvement” | “Progress shows standalone local attempts; comparable baseline-to-retry validation is future work.” |
| “The local app” | Specify either “the Wrangler Cloudflare edition” or “the separate Go edition.” |

## Maintaining these docs

When behavior changes:

1. Update the owning canonical document from the table above.
2. Update [Requirements and implementation status](REQUIREMENTS.md) when implementation or status changes.
3. Move future language in or out of [Roadmap](ROADMAP.md) as implementation status changes.
4. Update the learning guide and cheat sheet only when the core explanation changes.
5. Re-run link, test, typecheck, smoke, and Wrangler dry-run checks before publishing claims.
