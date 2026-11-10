# Remote Volume

This small Electron application enables you to control the OS audio volume over a WebSocket connection.

## Features

- Get, set, increase or decrease the audio volume
- Get, mute, unmute or toggle the mute state of the audio volume
- Get the current audio output device
- Per-application volume: list apps that are playing audio, and set, increase, decrease, mute, unmute or toggle each one (Windows and Linux)

Whenever a client changes the volume or mute state, the new values are sent to all connected WebSocket clients straight away.

The application can also poll the system audio values (volume, mute state, output device and per-app volumes) to pick up changes made outside the app, e.g. with the keyboard or the OS mixer. Polling can be enabled or disabled in the configuration window, where you can also set the polling interval.
As soon as something changes, the updated values will be sent out to all connected WebSocket clients.

## Supported OS

- Windows Vista or later
- OSX on Arm & x64
- Linux\*

\*No autostart possible by the software setting - needs to be solved manually!

Per-application volume works on Windows (the same apps as the Windows Volume Mixer) and on Linux with PulseAudio or PipeWire (`pactl` must be installed). macOS has no system API for per-application volume, so those actions return an error there.

## Installation

Navigate to the [latest release](https://github.com/leonreucher/remote-volume/releases/latest) and download the corresponding file for your OS. Mac OS users will find a .dmg volume, containing the application. Windows users will find a .exe file which contains an installer.
Linux users will find a .deb file for installation.

## Setup

After installing the application, it will run as a menu bar application. By clicking on the menu bar item, you can either close the application or open the configuration screen.

Inside the configuration screen, you can

- select the port, on which clients can connect to the WebSocket server.
- enable or disable the polling feature and set a polling interval.
- select, wether the application should auto start together with the system.

![Setting Window](/docs/images/setting_window.png)

## Usage

When using [Bitfocus Companion](https://bitfocus.io/companion) you don't need the following information - this is only for people, who would like to integrate the application in another project.

### 1. Set Volume

- **Action**: `setVolume`
- **Description**: Sets the system volume to a specified level.
- **Value Range**: 0 - 100
- **Payload**:

  ```json
  {
    "action": "setVolume",
    "value": <number>
  }
  ```

### 2. Get State

- **Action**: `getState`
- **Description**: Returns all current audio information
- **Payload**:
  ```json
  {
  	"action": "getState"
  }
  ```

### 3. Increase Volume

- **Action**: `increaseVolume`
- **Description**: Increases the system volume by a specified increment.
- **Value Range**: 1 - 99
- **Payload**:
  ```json
  {
  	"action": "increaseVolume",
    "value": <number>
  }
  ```

### 4. Decrease Volume

- **Action**: `decreaseVolume`
- **Description**: Decreases the system volume by a specified decrement.
- **Value Range**: 1 - 99
- **Payload**:
  ```json
  {
  	"action": "decreaseVolume",
    "value": <number>
  }
  ```

### 5. Mute

- **Action**: `mute`
- **Description**: Mutes the system audio.
- **Payload**:
  ```json
  {
  	"action": "mute"
  }
  ```

### 6. Unmute

- **Action**: `unmute`
- **Description**: Unmutes the system audio.
- **Payload**:
  ```json
  {
  	"action": "unmute"
  }
  ```

### 7. Toggle Mute

- **Action**: `toggleMute`
- **Description**: Toggles the mute state of the system audio.
- **Payload**:
  ```json
  {
  	"action": "toggleMute"
  }
  ```

### 8. Is Muted

- **Action**: `isMuted`
- **Description**: Checks if the system audio is currently muted.
- **Payload**:
  ```json
  {
  	"action": "isMuted"
  }
  ```
- **Response**: `{ "muted": <boolean> }`

### Messages sent by the application

- On connect, and in reply to `getState`: `{ "volume": <0-100>, "muted": <boolean>, "outputDevice": "<name>" }`
- After a change (from a client action or from polling): only the fields that changed, e.g. `{ "volume": 35 }`
- Errors: `{ "action": "<action>", "response": { "error": "<message>" } }`

## Per-application volume

Apps are identified by their process name (case-insensitive, with or without `.exe`, e.g. `"spotify"`), or by their display title (e.g. `"Google Chrome"`). Instead of `app` you can pass `pid` with the id of any of the app's processes. An app with several audio streams (e.g. a browser) is controlled as one.

App information is always sent under an `apps` key, never as top-level `volume`/`muted` fields, so clients that only understand the master volume (such as the Bitfocus Companion module) are not affected.

### List apps

- **Action**: `getApps`
- **Payload**:
  ```json
  { "action": "getApps" }
  ```
- **Response**:
  ```json
  {
  	"apps": [
  		{ "name": "Spotify", "title": "Spotify", "pids": [1234], "volume": 80, "muted": false, "active": true }
  	]
  }
  ```
  `volume` is the app's own level (0–100, relative to the master volume). `active` is true while the app is actually playing. The list is also sent on connect and whenever it changes after an app action or a poll.

### Set, increase or decrease an app's volume

- **Actions**: `setAppVolume` (value 0 - 100), `increaseAppVolume` / `decreaseAppVolume` (value 1 - 99)
- **Payload**:
  ```json
  { "action": "setAppVolume", "app": "spotify", "value": 50 }
  ```

### Mute, unmute or toggle an app

- **Actions**: `muteApp`, `unmuteApp`, `toggleAppMute`
- **Payload**:
  ```json
  { "action": "toggleAppMute", "app": "chrome" }
  ```

If no running app matches, the reply is an error such as `{ "action": "muteApp", "response": { "error": "No app with an audio session matches \"chrome\"" } }`.

## Development

```bash
npm install
npm start      # on Windows this first compiles impl/windows/RemoteVolumeHelper.exe
npm test
npm run build
```

## Credits

The main part for controlling the system volume is based on the following project:
https://github.com/LinusU/node-loudness.

This application can be controlled by [Bitfocus Companion](https://bitfocus.io/companion)

![Companion Badge](./docs/images/companion_badge.png)
