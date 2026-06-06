# AI and Privacy

## Position

AI should enhance the game, not define it. Classic mode must work fully without AI, accounts, cloud processing, or audio upload.

## AI Use Cases

### Transcription

Convert a player's turn audio into text.

Used for:

- Relevance grading
- Post-turn summary
- Repetition detection later

### Topic Relevance Grading

Compare the transcript to the assigned topic and return:

- Relevance score
- Short explanation
- Possible repetition penalty
- Confidence level

### Topic Generation

Generate topic packs from a theme supplied by the host.

Examples:

- "Family-friendly road trip topics"
- "Debate topics for software engineers"
- "Absurd topics for a birthday party"

## Consent Rules

Before AI mode records or processes audio, the app must explain:

- That audio may be recorded during turns
- Whether audio, transcripts, or both are sent to a provider
- Whether anything is stored
- How the host can disable AI mode

The game should never silently upload microphone audio.

## Data Handling

Recommended default:

- Classic mode: no server upload
- AI mode: process only the current turn
- Store transcript only for the current game unless the user explicitly saves it
- Do not use transcripts for topic packs or analytics without explicit consent

## AI Scoring Rules

AI scores should be modifiers, not absolute truth.

Recommended formula:

```text
final_score = classic_score + ai_bonus
```

Where:

```text
ai_bonus = round(ai_relevance_score * max_ai_bonus)
```

Suggested max AI bonus: 20 points.

This keeps the core speaking challenge more important than the AI judge.

## UX Requirements

AI feedback must be short and explainable.

Good:

```text
Mostly on topic. You gave several examples about the prompt, but repeated the same point near the end.
```

Bad:

```text
Score: 71.2
```

The host must be able to override AI results.

## Risks

- Transcription errors may punish accents, speech differences, or noisy rooms.
- Relevance grading may feel subjective.
- AI calls add latency and cost.
- Privacy expectations are higher when microphones are involved.

## Mitigations

- Keep AI optional.
- Show clear consent.
- Prefer short-lived processing.
- Show explanations.
- Let the host override.
- Never block Classic mode on AI availability.

