# Design

## Intent

Don't Stop Talking is a product UI for a live group game. The interface should feel immediate, legible, and pressure-filled without becoming visually chaotic. During turns, the screen should behave like a game table centerpiece: topic, timer, voice status, and score are visible from a few feet away.

Physical scene: a group is gathered around a laptop or TV in a living room or classroom, with mixed lighting, background noise, and players glancing at the screen while speaking.

## Visual Direction

Use a restrained product interface with a confident game accent. The product should not look like a corporate dashboard. Use strong contrast, large turn-state elements, and compact setup screens.

Preferred qualities:

- Focused
- Fast
- Social
- Slightly tense
- Easy to scan at distance

Avoid:

- Neon-on-black arcade styling
- Generic purple-blue gradients
- Beige social app warmth
- Heavy card grids
- Decorative illustrations that do not support play

## Color System

Use OKLCH tokens in implementation.

Suggested starter palette:

```css
:root {
  --color-bg: oklch(0.965 0.008 82);
  --color-surface: oklch(0.985 0.006 82);
  --color-panel: oklch(0.925 0.012 82);
  --color-text: oklch(0.205 0.018 72);
  --color-muted: oklch(0.47 0.018 72);
  --color-border: oklch(0.82 0.014 82);

  --color-accent: oklch(0.64 0.18 33);
  --color-accent-strong: oklch(0.54 0.2 33);
  --color-success: oklch(0.58 0.14 150);
  --color-warning: oklch(0.72 0.15 78);
  --color-danger: oklch(0.58 0.18 24);
  --color-info: oklch(0.56 0.12 230);
}
```

The accent should mark primary actions, active turns, and timer pressure. It should not be used as decoration everywhere.

## Typography

Use a system UI font stack or Inter if the project later adds a font package.

```css
font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Text scale should stay fixed by component role rather than scaling with viewport width.

- Turn topic: large and readable from distance
- Timer: largest element during active play
- Setup labels: compact and clear
- Scoreboard numbers: tabular lining numbers

## Layout

The game needs three major interface shapes:

1. Setup screens: efficient forms and lists for players, settings, and topics.
2. Turn screen: one focused play surface with topic, timer, voice state, and host controls.
3. Scoreboard screens: standings, round results, and winner state.

Use cards only for repeated list items, player rows, topic packs, and small panels. Do not put cards inside cards. The turn screen should not feel like a form inside a card.

## Components

Core components:

- Player list row
- Topic pack selector
- Custom topic editor
- Game settings panel
- Turn timer
- Voice activity meter
- Silence countdown
- Host control bar
- Scoreboard table
- Winner summary
- Permission and device status banners

Every interactive component needs default, hover, focus, active, disabled, and loading states.

## Motion

Motion should communicate state:

- Countdown start
- Timer pressure
- Speech detected
- Silence warning
- Turn ended
- Score applied

Keep transitions around 150 to 250 ms. Support reduced motion.

