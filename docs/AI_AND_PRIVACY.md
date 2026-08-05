# AI and Privacy

This document describes the current NonStopTalk implementation. AI is an optional scoring modifier and topic-writing aid in the local Go edition; the complete game loop works without an AI provider. The free Cloudflare edition is classic-only.

## At a glance

| Situation | Microphone audio | Transcript | External AI |
| --- | --- | --- | --- |
| Classic play with microphone detection | Read locally by Web Audio | None | None |
| Manual timer | Not required | None | None |
| Cloudflare online edition | Read locally by Web Audio when microphone timing is chosen | None | None |
| AI judge enabled, speaker chooses classic/manual | Not uploaded | None | None |
| AI judge enabled, speaker consents, no Anthropic key | Read locally; not uploaded | Sent to the NonStopTalk server and graded by its offline heuristic | None |
| AI judge enabled, speaker consents, Anthropic key configured | Read locally; not uploaded | Sent to the NonStopTalk server, then topic + transcript are sent to Anthropic | Anthropic grading |
| Theme generation without an Anthropic key | Not involved | Not involved | None; server templates generate the pack |
| Theme generation with an Anthropic key | Not involved | Not involved | The theme text is sent to Anthropic |

NonStopTalk does not record, upload, or persist microphone audio.

## Per-speaker consent

Enabling the AI judge in room settings only makes it available. Before each turn, that speaker must choose one of:

- Use supported on-device transcription for this turn.
- Play without transcription or an AI bonus.

The choice is per turn and is not silently carried into later turns. Starting the manual timer selects classic play and sends no transcript.

## On-device transcription requirement

NonStopTalk deliberately fails closed. Browser transcription starts only when all of the following are true:

1. The host enabled the AI judge.
2. The current speaker explicitly chose local transcription.
3. The browser exposes `SpeechRecognition` (or its prefixed equivalent).
4. The recognition object exposes `processLocally` and retains the value `true`.
5. The exact live audio track selected for voice-activity detection can be supplied to recognition.

If a check fails or recognition cannot start, the UI explains that the turn is continuing without a transcript or AI bonus. Classic and manual play remain available.

This strict requirement means AI transcription is unavailable in many current browser versions. A browser's implementation is responsible for honoring `processLocally`; NonStopTalk does not fall back to browser-managed remote recognition.

## Current data flow

### Classic or manual turn

```text
selected microphone -> browser Web Audio analysis -> timer/silence result -> NonStopTalk server
```

The result contains timing and completion state, not audio or a transcript.

### Consented AI-judge turn

```text
selected microphone
  -> browser on-device SpeechRecognition
  -> text transcript (maximum 8 KiB)
  -> NonStopTalk server
  -> offline heuristic OR Anthropic
  -> relevance, confidence, short feedback
  -> bonus of up to 20 points
```

The transcript is held only long enough to grade the turn. It is not a field on the game session, is not shown in game history, and is not written to the JSON room snapshot.

The server sends Anthropic the assigned topic and transcript only when `ANTHROPIC_API_KEY` is configured. Without the key, the server's keyword-overlap heuristic produces a clearly labeled low-confidence result.

Grading runs asynchronously with a timeout. Classic points are committed first. If grading fails, has no transcript, exceeds limits, is interrupted by a process restart, or cannot safely match its original turn, the game keeps the classic score and reports that no AI bonus was applied.

## Topic generation

The host can enter a theme to generate ten editable prompts.

- With `ANTHROPIC_API_KEY`, only the theme text is sent to Anthropic.
- Without the key, the server expands the theme through a fixed set of local templates.

Room setup and any resulting topic list still travel through the NonStopTalk server like other game state. The privacy statement above is specifically about which text reaches the external provider.

## Storage

- No accounts are required.
- Browser identity uses an HTTP-only room token cookie.
- Custom topic drafts, saved presets, microphone choice, and sound preference are stored in that browser's local storage.
- The local web server stores room/session snapshots in `data/rooms.json` by default. These include rosters, settings, topics, scores, turns, and room history, but not transcripts or audio.
- Set `NONSTOPTALK_DATA_FILE=off` to keep rooms in memory only.
- The Cloudflare edition stores classic-game room state in a private SQLite-backed Durable Object for up to 30 idle days. It has no transcript or AI-provider path.

The operator of a self-hosted Go instance controls its server and any Anthropic credentials. Players should use an instance they trust.

## Transport and browser permissions

Remote microphone use requires HTTPS. Cloudflare provides HTTPS at the public edge; `localhost` is treated as a secure context for local development. Browser microphone permission can be denied at any time, in which case the manual timer remains available.

NonStopTalk does not request microphone access from spectators. A remote speaker runs detection on their own device; a pass-and-play speaker runs it on the host device.

## Scoring and fairness

AI relevance is a modifier:

```text
final score = classic score + round(relevance × 20)
```

Feedback includes a confidence label and is instructed to account for transcription artifacts and repetition. The host can adjust scores because recognition errors, accents, noisy rooms, and subjective relevance judgments can still produce unfair results.

## Future, not implemented

Post-turn AI summaries are backlog. NonStopTalk does not currently retain transcripts for summaries, analytics, profiles, or model training.
