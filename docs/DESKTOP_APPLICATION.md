# Desktop Application

## Current desktop target

NonStopTalk currently provides a browser-launcher executable rather than a native window. It:

1. Starts the same Go server used by the web command on an available `127.0.0.1` port.
2. Opens that address in the default browser.
3. Keeps running until the launcher process is stopped.

This shares the game engine, HTTP handlers, embedded templates, official HTMX 2.0.10 asset, CSS, and vanilla JavaScript with `cmd/web`. The native Cloudflare edition is a separate runtime. `localhost` also provides a browser secure context for microphone permission.

The desktop launcher keeps room state in memory. The `NONSTOPTALK_DATA_FILE` setting applies to `cmd/web`; `cmd/desktop` does not currently enable JSON autosave.

## Run

```sh
go run ./cmd/desktop
```

If the browser cannot be opened automatically, the launcher logs the local address to open manually.

## Build

Templates and browser assets are embedded, so the resulting executable can be launched outside the repository:

```sh
go build -o nonstoptalk-desktop ./cmd/desktop
```

On Windows, an explicit executable name can be used:

```powershell
go build -o nonstoptalk-desktop.exe ./cmd/desktop
```

## Available features

The launcher exposes the same current feature set as the local web server:

- Pass-and-play rooms using one or more browser windows on the same computer
- Player, settings, topic, turn, scoring, and history screens
- Microphone selection, local voice-activity detection, and manual timing
- Optional on-device transcription with offline or Anthropic-backed judging
- Saved browser presets and custom-topic import/export

The launcher binds only to `127.0.0.1`, so its automatically opened address is local to that computer. Use `cmd/web` or the documented online deployment for players on other devices.

## Native wrapper backlog

A packaged native WebView application is not implemented. A future wrapper could use Wails, a small WebView shell, or another platform-specific approach while preserving the Go game engine and shared web UI. Installer creation, code signing, automatic updates, and native profiles are also outside the current scope.
