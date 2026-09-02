# Design

## Intent

NonStopTalk now has three interface jobs:

- **Practice** creates a calm, focused space for one person to rehearse and understand evidence.
- **Play** remains a legible, pressure-filled group game that can be read from several feet away.
- **Progress** helps a person compare their own attempts without turning speech into a universal grade.

All three should feel like the same product: high contrast, decisive typography, compact controls, and an acid-lime signal color on a graphite field. The current native Cloudflare SPA is the canonical visual direction; Wrangler normally serves it at `127.0.0.1:8787` during development but may select another port.

## Visual direction

Preferred qualities:

- Focused and editorial
- Dark graphite, not neon arcade black
- Energetic but controlled
- Technical enough to make evidence credible
- Human enough that advice does not feel clinical
- Easy to scan on a phone, laptop, or shared display

Avoid:

- Generic purple-blue gradients
- Dense analytics grids during an attempt
- Cards nested inside cards
- Decorative charts without a decision attached
- Red-as-shame scoring for normal speech variation
- Ambient motion that competes with speaking
- A single oversized “AI score”

## Current color system

The Cloudflare SPA implements these core tokens:

```css
:root {
  --ink: #f5f2e9;
  --muted: #aaa99e;
  --surface: #191a17;
  --surface-2: #22231f;
  --line: #35362f;
  --acid: #d5ff4f;
  --acid-ink: #151a07;
  --danger: #ff826e;
  --blue: #7ec8ff;
}
```

The page background begins at `#10110f` with a restrained olive radial glow. Acid lime marks the primary action, active state, speech signal, and useful positive evidence. It must not become a decorative border around every panel. Warm off-white text prevents the interface from feeling like a developer console.

`--danger` is reserved for destructive actions, failures, and genuine hardware problems. It should not label an ordinary pause, filler word, accent, or slower pace as a personal failure.

## Typography

Use the current system-first stack:

```css
font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Large, tightly tracked headlines provide the visual identity. Monospaced/tabular numerals support timers and room codes. Component roles determine scale:

- Practice prompt: large enough to hold attention without looking like a form label
- Live metric: readable at a glance, with its unit always visible
- Current tip: one short sentence, visually secondary to the speaking task
- Turn topic and timer: readable from across a room
- Review evidence: normal reading size with plain-language definitions
- Progress comparison: paired values and direction, never unexplained decoration

## Information hierarchy

### Practice

The speaker should see, in order:

1. The prompt and chosen goal
2. The practice-format choice, local-processing disclosure, and three independent optional choices before the attempt: transcript analysis, full-session artifact retention, and compact cloud backup
3. The current attempt state and remaining time
4. No live measurement/cue surface in the review-only baseline/retry format; one live cue at most in the single coached format
5. A clear stop action

Do not show the full post-session dashboard while the person is speaking. Analysis belongs in review, where each recommendation follows this shape:

```text
observation → evidence → curated drill source → limitation → next action
```

### Play

The active topic, timer, voice status, and score remain the centerpiece. Host controls are powerful but quiet. Setup forms can be compact; the live turn cannot feel like a form inside a card.

### Progress

Lead with explicit practice loops, completed-loop/awaiting-retry state, and goal-specific paired evidence. Keep legacy, standalone, malformed, duplicate, and orphan records visible without pairing them by recency. Compare the user with their own baseline, but do not label a raw direction as improvement, rank people, infer demographic traits, or collapse pause, pace, filler, and input-level measurements into an opaque universal quality score. When an attempt has opted-in artifacts, expose separate recording/transcript download and artifact-only deletion actions beside that attempt; JSON export must remain visibly distinct because it contains summaries and derived word patterns, not the full artifacts. After practice history, show a compact point-in-time artifact panel with exact logical use, the 128 MiB app limit, and absolute retention deadlines. Call it an app limit rather than browser space, disclose that browser quota is separate, and keep per-attempt policy metadata beside the corresponding download/delete controls. The full-history delete action must say that it clears all local coaching stores for this site.

## Core components

Shared:

- Primary navigation for Practice, Play/Home, and Progress
- Permission, privacy, compatibility, and error notices
- Buttons with default, hover, focus, active, disabled, and loading states
- Screen-reader announcements for meaningful state changes, not every timer tick

Practice and Progress:

- Scenario and focus-goal selector
- Prompt surface
- Microphone readiness/privacy disclosure
- Recommended review-only baseline/retry and alternative single-coached-attempt format controls
- Separate, unchecked controls for optional on-device transcript analysis, optional attempt-recording/captured-transcript retention, and optional compact cloud backup
- Live level indicator and single-tip coaching surface only for the single coached format; review-only attempts expose the prompt, timer, microphone-connected state, and no live measurements/cues
- Evidence row with value, unit, and explanation
- Compact grounding label that says whether the retrieved coaching card supplied the retry drill or was context only because an evidence-safety rule supplied it
- Actionable review card
- Device-local attempt history and empty state
- Per-attempt download and artifact-only deletion controls when retained artifacts exist, a point-in-time exact logical-usage/retention panel, plus one confirmed action that clears summaries and artifacts; possibly partial transcripts carry a visible warning

Play:

- Player row, topic selector/editor, settings panel
- Turn timer, voice meter, silence state, and host controls
- Scoreboard, score explanation, winner, and history

## Coaching language

Copy should describe what the system observed, not what it imagines about a person.

Prefer:

- “Your longest measured pause was 2.8 seconds.”
- “Try finishing the thought, then pause once before the next point.”
- “Pace is unavailable because strict on-device transcription is not supported here.”

Avoid:

- “You sounded nervous.”
- “Your voice lacks confidence.”
- “Your accent reduced your score.”
- “AI says you are 82% professional.”

## Motion and live feedback

Motion communicates state: microphone ready, speech detected, clipping, a sustained coaching condition, turn completion, and saved review. Keep normal transitions around 150–250 ms and honor `prefers-reduced-motion`.

Live feedback must be sparse:

- One visible cue at a time
- A sustained condition before a cue appears
- A cooldown before another cue
- Automatic recovery when the condition clears
- No rapid flashing or timer announcements to assistive technology

Exact prototype timing and thresholds are documented in [Speech Coaching Prototype](docs/SPEECH_COACHING_PROTOTYPE.md). They are engineering defaults awaiting user and fairness validation, not universal truths about good speech.

## Accessibility and input resilience

- Maintain visible keyboard focus and native semantic controls.
- Do not use color as the only state signal.
- Give charts or meter-like visuals a text equivalent.
- Explain why microphone permission is requested before requesting it.
- Keep transcript analysis and full-artifact retention visibly optional and do not imply that one grants the other.
- State that transcript analysis keeps derived filler/repetition patterns in the summary, while full audio/transcript retention is a separate off-by-default choice.
- Preserve a usable analysis when transcription is unavailable.
- Stop microphone tracks and audio work when leaving Practice.
- Move keyboard focus to the new route heading after client-side navigation.
- Test reduced motion, zoom, narrow layouts, keyboard-only operation, and common screen readers before claiming conformance.
