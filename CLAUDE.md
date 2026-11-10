# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A tray/menu-bar Electron app that exposes OS audio volume control over a WebSocket server (default port 2501). It covers master volume and per-application volume. Its main client is Bitfocus Companion (`bitfocus/companion-module-uts-remotevolume`). The WebSocket protocol is documented in `readme.md`.

## Commands

```bash
npm install          # @capaj/naudiodon is an optional native dep; it may fail to build (e.g. on Windows) and that's fine
npm start            # prestart compiles the Windows helper if needed, then runs electron .
npm test             # node --test: finds test/*.test.js; no Electron or audio hardware needed
node --test test/server.test.js                  # a single test file
node --test --test-name-pattern="isMuted"        # a single test by name
npm run build        # electron-builder -> dist/ (portable zip on Windows, no installer; dmg on macOS; deb on Linux)
npm run build:helper # force-rebuild impl/windows/RemoteVolumeHelper.exe
```

- Formatting follows `.prettierrc`: tabs, no semicolons, single quotes, 120-column lines. `renderer.js` predates this style.
- Logs are written by electron-log to `<userData>/logs/main.log`.

## Companion compatibility (don't break this)

The Companion module sends only `setVolume`, `increaseVolume`, `decreaseVolume`, `mute`, `unmute`, `toggleMute` and `getState`. It treats **any** incoming message with a top-level `volume`, `muted` or `outputDevice` key as master state.
- Only master-state messages may carry those keys at the top level.
- Per-app data must stay under `apps`, and errors under `{action, response: {error}}`.
- The existing action names, value ranges and error strings are part of the contract.

`test/server.test.js` checks this.

## Architecture

The whole app is ES modules. The exception is `renderer.js`, which is the CommonJS **preload** script, not a renderer.

- **`main.js`**: Electron wiring only:
  - Takes a single-instance lock; a second launch shows the settings window.
  - Sets up the tray and the hide-on-close window.
  - Loads config through `normalizeConfig` (`config.js`).
  - Handles autostart. When launched at login (`--hidden`), the app stays in the tray.
  - Handles IPC. `save-config` restarts the WebSocket server only when the port changed. Results go back on `config-saved` as `{ok, message}`; for example, "port in use" is shown in the window.
- **`server.js`**: the WebSocket protocol, kept free of Electron so tests can drive it with a fake controller.
  - Actions live in an `actions` map. Each entry has `run` plus an `after` refresh (`refreshMaster` or `refreshApps`).
  - That refresh pushes the resulting state to **all** clients right after an action. Without it, Companion only saw its own changes when polling was on.
  - `last` holds what clients were last told, so refreshes and polls only broadcast fields that changed.
  - Polling is a chained `setTimeout`, so ticks never overlap.
- **`volumeController.js`**: the platform facade.
  - Picks a backend in `impl/` by `os.type()`, clamps values, and implements toggle and increase/decrease on top of each backend.
  - Per-app functions take a target `{app}` or `{pid}`. They group backend sessions into apps with `apps.js` (by normalized process name), then apply changes to every session of the app.
  - `AppNotFoundError` and `NotSupportedError` are client errors: they're returned to the client but not logged as failures.
- **Backend interface (`impl/`)**:
  - Every backend provides `getState()` → `{volume, muted, outputDevice?}`, `setVolume` and `setMuted`.
  - Backends with `supportsSessions: true` also provide `listSessions()` → `[{id, pid, name, title, volume, muted, active}]`, `setSessionVolume(id, v)` and `setSessionMuted(id, m)`.
  - Without `outputDevice`, the controller falls back to `getAudioDevice()` and then to naudiodon.
- **`impl/windows/`**:
  - `RemoteVolumeHelper.cs` is a long-lived Core Audio helper driven over stdin/stdout, one JSON line per command. Its protocol is listed in its header comment.
  - It's compiled by `scripts/build-win-helper.js` with the .NET Framework `csc.exe` that ships with Windows, so it must stay **C# 5**: no string interpolation and no `?.`.
  - The exe is git-ignored and rebuilt by `prestart`/`prebuild`. It's unpacked from asar (`build.asarUnpack`) because it's spawned.
  - Session ids are pids. Pid 0 is "System Sounds".
  - If the exe is missing, `index.js` falls back to the legacy `adjust_get_current_system_volume_vista_plus.exe`, which gives master volume only and no per-app support.
- **`impl/linux.js`**: master volume via `amixer`. Per-app volume and the device name come from `pactl`, using `-f json` and falling back to text parsing for pactl older than 16. Session ids are sink-input indexes.
- **`impl/darwin.js`**: `osascript`. macOS has no per-app volume API (`supportsSessions: false`).

## CI / release

`.github/workflows/build.yml` builds on Windows, macOS and Ubuntu (Node 22) for every push to every branch. On `main`, it also creates a GitHub release tagged `v<package.json version>-<short sha>`. macOS signing and notarization use repository secrets plus `scripts/notarize.js` (the `afterSign` hook, `@electron/notarize`). The original repo is `upstream` (ultimategmbh/remote-volume), and `origin` is the fork.
