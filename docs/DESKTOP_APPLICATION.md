# Desktop Application

## Current Desktop Target

The desktop version starts a local Go server on `127.0.0.1` and opens the game in the user's default browser. This gives the app desktop-style launch behavior while keeping the Go + HTMX architecture intact.

This approach is intentional for the first implementation:

- It works with the Web Audio API on `localhost`.
- It avoids native wrapper complexity before the game loop is proven.
- It shares the same handlers, templates, CSS, and JavaScript as the web version.
- It keeps future packaging options open.

## Run

```text
go run ./cmd/desktop
```

The launcher chooses an available local port and opens the app automatically.

## Build

```text
go build -o bin/dont-stop-talking-desktop.exe ./cmd/desktop
```

## Native Wrapper Later

Once the local game loop is stable, the desktop target can move to a native WebView wrapper such as Wails or webview. The application should still keep the Go game engine and server-rendered UI boundaries.

Suggested later options:

- Wails for a polished installable desktop app
- WebView wrapper for a smaller native shell
- Tauri only if the project later accepts a Rust build dependency

## Desktop MVP Scope

- Launch local app
- Add players
- Configure settings
- Choose preset or custom topics
- Play local turns
- Use microphone silence detection
- Score turns
- Show final winner

