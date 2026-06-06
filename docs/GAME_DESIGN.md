# Game Design

## Summary

Don't Stop Talking is a speaking endurance party game. Players receive topics and must speak continuously for a configured amount of time. Pausing too long ends the turn.

## Core Rules

1. Each game has two or more players.
2. Each game has one or more rounds.
3. On a turn, the active player receives a topic.
4. The player must speak until the turn timer reaches zero.
5. If silence lasts longer than the configured timeout, the turn ends.
6. The player receives points based on turn performance.
7. After all scheduled turns are complete, the highest score wins.

## Default Settings

| Setting | Default | Notes |
| --- | ---: | --- |
| Speaking duration | 60 seconds | Configurable |
| Silence timeout | 2 seconds | Configurable |
| Rounds | 1 | Configurable |
| Topic repeats | Off | Avoid repeated prompts in one game |
| Scoring mode | Classic | Seconds plus completion bonus |

## Scoring

Classic scoring:

```text
score = seconds_spoken + completion_bonus
```

Completion bonus:

```text
25 points if the player survives the full timer
```

Example:

- Player speaks for 41 seconds: 41 points
- Player completes 60 seconds: 85 points

Optional modifiers for later:

- Topic difficulty multiplier
- AI relevance score
- Crowd vote bonus
- No-filler bonus
- Repetition penalty

## Turn States

| State | Description |
| --- | --- |
| Ready | Player and topic are shown before the turn starts |
| Countdown | Short countdown before recording starts |
| Speaking | Timer is running and voice activity is detected |
| Silence Warning | No speech detected, silence timeout is counting down |
| Completed | Player survived the full duration |
| Eliminated | Player paused too long |
| Scored | Turn result has been applied |

## Game Modes

### Classic

The default mode. Players are scored by speaking duration and completion bonus.

### Lightning

Short turns from 15 to 30 seconds. Best for quick groups or warmups.

### Strict

Shorter silence timeout and no completion grace period.

### Custom Topics

The host writes, pastes, imports, or saves a custom topic list.

### Theme Packs

Preset topic packs grouped by tone or subject.

Example packs:

- Everyday opinions
- Movies and TV
- Food arguments
- School-friendly
- Work-safe
- Absurd prompts
- Debate starters
- Personal stories

### Party Vote

Other players can vote on whether the speaker stayed on topic or repeated themselves too much.

### AI Judge

The app transcribes the turn and grades topic relevance. AI grading should be optional and explainable.

## Host Controls

The host must be able to:

- Start a turn
- Pause a turn
- End a turn manually
- Override silence detection
- Award or remove points
- Skip a topic
- Redraw a topic
- Skip a player
- Restart the current turn

Manual controls are required because microphones and room noise are unreliable.

