# Product

## Register

product

## Direction

NonStopTalk is expanding from a speaking-endurance party game into a broader voice and speech-practice product. The original multiplayer game remains a first-class mode; the new coaching path adds private, deliberate practice rather than replacing social play.

```text
NonStopTalk
├── Practice — rehearse, inspect evidence, and choose one improvement
├── Play     — the original local and online speaking game
└── Progress — review origin-local browser summaries over time
```

The product thesis is:

> Practice speaking under pressure, get one useful signal, and try again.

## Users and jobs

The initial coaching audience is students and early-career professionals rehearsing interview answers, presentation openings, and impromptu responses. Their job is not to earn a universal voice grade. It is to notice one behavior, receive a concrete next action, and make a better unassisted attempt.

The game remains for friends, families, classrooms, streamers, and party hosts who want a quick social challenge in the same room or online. The host manages setup and judgment calls; players need to see the current speaker, topic, timer, voice state, and score.

Potential later audiences include educators, human coaches, and teams running facilitated practice. Accounts, assignments, shared reports, and teacher dashboards are not part of the current prototype.

## Product purpose

Practice should create a deliberate-practice loop:

```text
choose one goal
  → make an uncoached attempt
  → inspect explainable evidence
  → receive one highest-value next action
  → retry without live help
  → compare with the baseline
```

The current prototype implements this explicit relationship. Its recommended format records a review-only baseline, lets the user inspect evidence/advice, locks scenario, goal, and target duration for an unassisted review-only retry, and shows raw goal-specific paired measurements with signal guardrails and caveats. The alternative single coached attempt keeps sparse live cues and remains independent. Progress groups only records linked by explicit IDs; it never invents a pair from recency. Consented transcript analysis retains derived filler/repetition patterns in the summary but discards captured transcript text by default. A separate, unchecked choice can retain the attempt recording and available captured transcript locally for individual download or later per-attempt deletion; a two-second finalization timeout or late recognition error preserves existing text but marks it as possibly partial in Review and Progress. Summary export omits those artifacts, while deleting them preserves the compact attempt and paired comparison. Its small local RAG pattern ranks curated in-app coaching cards; the top card normally supplies the intact base drill, but an evidence-safety rule uses the measured priority's drill when the retrieved card lacks support. The review distinguishes a card used for the drill from context-only retrieval. Measurement accuracy and learning outcomes remain work in progress.

Play creates a lightweight speaking challenge: keep talking about a topic without exceeding the silence limit. It makes rules visible, handles timing and scoring, and reduces host bookkeeping.

These modes must keep different success models. A pause can be a failure condition in the game while being an intentional delivery technique in coaching. Game points must never be presented as a speech-development score.

## Product success

The primary coaching outcomes for a future consented pilot are:

1. People complete a deliberate-practice loop: baseline, evidence/advice review, and unassisted retry.
2. The unassisted retry improves the one goal the person selected, measured as a paired goal-specific change rather than one opaque score.

Drivers and guardrails include usable microphone sessions, strict local-transcription availability, false-tip rate, reported distraction, local-retrieval grounding quality, privacy network violations, and subgroup fairness. There is not enough pilot evidence to claim baselines or numeric targets yet. See [Coaching Presentation Guide](docs/COACHING_PRESENTATION_GUIDE.md#4-measurement).

For the game, success still means a group can start quickly, complete a local or online session from on-screen guidance, and understand why each player earned their score. Formal time-to-start testing has not yet been run.

## Brand personality

The shared personality is focused, direct, energetic, and humane.

- Practice should feel like a calm rehearsal room: evidence-forward, encouraging, and never clinical or judgmental.
- Play should feel tense, social, and sharp without becoming chaotic or childish.
- Progress should emphasize change against the user's own attempts, not comparison with a population.

Copy should be short while someone is speaking. Detailed explanations belong in setup and review, where each recommendation can name its evidence, limitation, and next action.

## Anti-references

NonStopTalk should not feel like:

- A dense SaaS analytics dashboard
- A generic “AI score” with no inspectable evidence
- A medical speech assessment or automated diagnosis
- A system that equates an accent, dialect, vocal pitch, or loudness with professionalism
- A dark neon streamer overlay or an overly cute party-game clone
- A live coach that interrupts with several warnings at once

## Design principles

1. The current speaking task is always the center of attention.
2. Show one live coaching cue at a time; move deeper analysis to the review.
3. Connect every recommendation to an observable measurement and a concrete retry.
4. Show whether a product-authored curated card supplied the retry drill or was retrieved only as context; require expert/source review before calling a future curriculum authoritative.
5. State uncertainty and unavailable signals instead of manufacturing a score.
6. Keep attempt-recording and captured-transcript retention off by default, explain that derived word patterns remain in the compact summary when transcript analysis is enabled, warn when retained text may be partial, and separate every additional consent boundary.
7. Treat accents and dialects as language variation, not defects.
8. Preserve complete, explainable game scoring independently from coaching progress.
9. Keep local play complete while the online and coaching editions evolve.

## Safety, accessibility, and inclusion

NonStopTalk is a general communication-practice product, not speech therapy and not a medical device. It must not infer confidence, anxiety, emotion, honesty, personality, age, identity, or health from a person's voice.

Users should be compared primarily with their own baselines. Any fairness study must use voluntarily supplied, appropriately protected group information; group identity must not be inferred from audio. ASHA's [accent guidance](https://www.asha.org/Practice-Portal/Professional-Issues/Accent-Modification/) describes accents as natural language variations rather than communication disorders.

The interface should target WCAG 2.1 AA for contrast, focus, keyboard navigation, and readable text; support reduced motion; communicate microphone and transcription availability in text; and preserve non-microphone fallbacks for the game. Formal conformance and broad assistive-technology testing remain backlog.
