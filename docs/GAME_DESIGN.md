# Game Design

## Current game

NonStopTalk is a speaking-endurance party game. A player receives a surprise topic and tries to keep speaking until the turn timer expires. Pausing for longer than the configured silence limit ends a microphone-driven turn.

The current build supports both pass-and-play on one device and rooms where players speak from their own browsers.

## Rules

1. A room needs at least two players and one topic.
2. The host chooses the speaking duration, silence limit, rounds, topic source, and whether the optional AI judge is available.
3. Each player receives one turn per round in roster order.
4. A shuffled deck selects topics. Every topic is used once before the deck reshuffles; with more than one topic, the first draw of a new cycle cannot equal the previous draw.
5. The speaker uses microphone detection or the manual timer. The host can also end a turn or mark it complete.
6. A microphone-driven turn completes at the full duration or is eliminated when the silence limit is reached. Completing the timer wins if completion and silence cross their thresholds in the same update.
7. Scores accumulate across all rounds.
8. After the scheduled turns, the highest displayed score wins. The host can correct the scoreboard when detection or judging was unfair.

## Settings

| Setting | Default | Current range |
| --- | ---: | ---: |
| Speaking duration | 60 seconds | 10–300 seconds |
| Silence limit | 2 seconds | 1–10 seconds |
| Rounds | 1 | 1–10 |
| Topic source | Everyday Sparks | Five built-in packs or a custom list |
| AI judge | Off | Optional per room and per speaker turn |

The active topic can be redrawn before speaking begins. A redraw consumes the next item in the shuffled deck.

## Scoring

Classic score:

```text
classic score = seconds spoken + completion bonus
completion bonus = 25 points after surviving the full duration
```

Examples:

- 41 seconds without completing a 60-second turn: 41 points
- 60 seconds and completion: 85 points

When the AI judge is enabled and that speaker consents to supported on-device transcription:

```text
AI bonus = round(relevance × 20)
final turn score = classic score + AI bonus
```

The judge returns short feedback and a confidence label. No transcript, a judge error, or an interrupted result leaves classic scoring unchanged. Host score controls adjust a player's total by ±5 points.

Party-vote, topic-difficulty, no-filler, and standalone repetition modifiers are not implemented.

## Current turn states

| State | Behavior |
| --- | --- |
| Ready | Player and topic are visible; the speaker can choose microphone or manual timing. |
| AI choice | When enabled, the speaker chooses local transcription or classic play for this turn. |
| Speaking | Timer and local voice meter run; the server maintains its own clock. |
| Silence warning | Remaining silence time and a warning cue are shown. |
| Completed | The speaker reached the full duration and receives the completion bonus. |
| Eliminated | The silence threshold ended the turn without the completion bonus. |
| Scored | Breakdown, judge status when relevant, standings, and host corrections are shown. |
| Winner | Final standings and one displayed winner are shown. |

The AI choice and judge status are specific to the local/self-hosted Go edition; the free Cloudflare edition uses classic scoring.

There is no pre-turn countdown, pause state, or restart-current-turn action yet.

## Local and online roles

- The host controls room setup, starts the game, can run pass-and-play seats, adjusts scores, resets for another game, and can transfer hosting to a remote player.
- A remote player's browser is bound to their seat and runs that player's turn. Other clients receive room changes through SSE in the Go edition or hibernatable WebSockets on Cloudflare.
- The server clock caps remote time claims and allows a small completion grace for browser/server timing skew.
- The same browser token restores a player's seat after a reconnect while the room still exists.
- A seated player can claim hosting after the current host has been absent for 30 seconds.

This is lightweight coordination for a social game, not adversarial anti-cheat.

## Topics and replay

The current packs are Everyday Sparks, Story Time, Absurd Arguments, Fast Debate, and Instant Expert. Hosts can paste or edit a custom list in either edition. The Go edition additionally lets hosts:

- Import/export custom topics as plain text.
- Generate ten prompts from a theme through server templates or Anthropic.
- Save settings plus custom topics as a browser-local preset.

Each room retains summaries of its last 20 finished games. Summaries contain standings and turn count, not transcripts.

## Manual controls currently available

- Start the game and the next turn
- Start microphone detection or manual timing
- Redraw the active topic
- End the active turn
- Mark a turn complete
- Adjust player totals
- Reset/play again
- Transfer or reclaim host control

## Explicit future backlog

- Party voting
- Named Lightning and Strict modes
- Pause, skip-player, and restart-current-turn controls
- Profiles and family/content filters
- Post-turn summaries

These are design directions, not claims about the current build.
