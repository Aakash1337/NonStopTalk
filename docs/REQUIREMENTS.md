# Requirements

## Functional Requirements

### Web App

- The first version must run as a browser-based web app.
- The preferred implementation should use Go and HTMX where practical.
- The app must work locally on one device for pass-and-play multiplayer.
- The app must not require account creation for local Classic mode.
- The app may use small browser JavaScript modules for capabilities HTMX cannot provide, especially microphone access and precise timing.

### Local Multiplayer

- The app must support at least two local players.
- The host must be able to add, rename, remove, and reorder players.
- The app must track scores across all rounds.
- The app must show a final winner.

### Game Setup

- The host must be able to choose a topic source.
- The host must be able to configure speaking duration.
- The host must be able to configure silence timeout.
- The host must be able to configure number of rounds.
- The app must show sensible defaults so setup is fast.

### Topics

- The app must include preset topic packs.
- The app must support custom topic lists.
- The app should avoid topic repeats in the same game when possible.
- The app should support skipping or redrawing a topic before a turn starts.

### Turn Play

- The app must show the active player.
- The app must show the active topic.
- The app must show the remaining time.
- The app must detect speech and silence through the microphone.
- The app must end the turn when the silence timeout is exceeded.
- The app must allow host override when detection is wrong.

### Scoring

- The app must calculate and display each turn score.
- The app must show why points were awarded.
- The app must support manual score adjustment by the host.

### AI Mode

- AI mode must be optional.
- The app must get user consent before recording or sending audio for transcription.
- The app must show AI grading feedback in plain language.
- The host must be able to override AI scores.

## Non-functional Requirements

### Usability

- A local game should be startable in under two minutes.
- The turn screen should be readable from several feet away.
- Host controls should be available without cluttering the player-facing view.

### Accessibility

- The app should target WCAG 2.1 AA.
- The app must have visible focus states.
- The app should support keyboard navigation.
- The app should support reduced motion.
- Voice state must not rely only on color.

### Reliability

- The app must handle microphone permission denial.
- The app must handle missing microphone devices.
- The app must handle noisy environments with manual override controls.
- The app should not lose active game state on accidental navigation when possible.

### Privacy

- Local Classic mode should not require account creation.
- Local Classic mode should not send audio to a server.
- AI mode must clearly explain what audio or transcript data is processed.

## MVP Acceptance Criteria

The MVP is complete when:

1. A host can create a local game with at least two players.
2. Players can complete a full round.
3. Turns end by timer completion or silence timeout.
4. Scores are calculated and visible.
5. A final winner is shown.
6. The host can manually override a bad detection event.
