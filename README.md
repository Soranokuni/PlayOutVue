# PlayOut

PlayOut is a Windows-first desktop playout controller built with Vue 3, Vite, Tauri, and Rust. It is designed for small broadcast, channel branding, and operator-driven transmission workflows where a single application needs to manage media preparation, rundown control, previewing, trimming, live cut-ins, compliance overlays, and output control.

The application can drive two different playout backends:

- OBS Studio through OBS WebSocket v5.
- CasparCG through AMCP and OSC feedback.

It is not just a playlist player. PlayOut combines a media browser, a rundown editor, backend-specific playout control, compliance tagging, trimming utilities, and a persistent operator UI in one desktop app.

## What The App Does

PlayOut is built around the daily operator workflow:

- Browse a local media root and build a structured media library.
- Scan and cache technical metadata such as duration, codec, frame rate, aspect ratio, and field order.
- Create and manage multiple playlists or rundowns.
- Keep an active editing playlist separate from the on-air playlist.
- Insert media at arbitrary positions with drag and drop.
- Add gap markers and hard-start planning points without polluting the actual playout queue.
- Preview assets before transmission.
- Trim clips non-destructively for rundown use or destructively export trimmed copies.
- Trigger playout from OBS or CasparCG with timing feedback.
- Cut to live inputs instantly.
- Apply branding and compliance overlays.
- Control streaming or hardware outputs where the selected backend supports them.

The current app shell exposes three operational areas:

- Library: media discovery, search, technical metadata, trim entry point, diagnostics.
- Rundown: playlist tabs, item ordering, timing, selection, live/gap rows, execution controls.
- Right panel: program preview and media inspector.

## Backend Modes

### OBS Mode

OBS mode is the most feature-complete backend in the current codebase.

It supports:

- Program preview snapshots.
- OBS scene and media input control.
- Live cuts using a configured OBS input source.
- Streaming start and stop.
- Hardware output toggling for DeckLink or other OBS outputs.
- Compliance browser and image overlays.
- A two-deck playout model using managed OBS media sources.

The app expects OBS WebSocket v5 to be available, typically on `ws://127.0.0.1:4455`.

### CasparCG Mode

CasparCG mode is intended for channel playout environments where CasparCG handles program output and timing.

It supports:

- AMCP command-based playout.
- OSC timing feedback.
- Cue, play, pause, clear, and live route control.
- Branding and compliance overlays as Caspar layers.
- DeckLink add/remove control through Caspar commands.

Important differences from OBS mode:

- No program snapshot preview panel.
- No built-in streaming control from the app.
- Live routing depends on your Caspar route/source naming.
- OSC must be configured correctly in `casparcg.config` for timing feedback.

## Core Features

### Media Library

The library scans a configured media root and builds a tree view of folders and playable media. Metadata is cached in SQLite to avoid repeated `ffprobe` work on unchanged files.

The scanner currently tracks:

- Duration.
- Resolution.
- Codec.
- Frame rate.
- Display aspect ratio.
- Field order.

The library also supports:

- Search.
- Context-menu append and insert.
- Default compliance rating assignment.
- Library-level spot/telemarketing tags.
- Background metadata warm-up.
- Debug logging and export when debug mode is enabled.

### Rundown And Playlist Management

Rundowns are first-class state in the application. The store supports multiple persisted playlists, one active editing playlist, and a separate on-air playlist.

Operator-friendly capabilities include:

- Multiple playlist tabs.
- Persistent selection.
- Drag reorder.
- Keyboard navigation.
- Duplicate, delete, insert-after-selected.
- Gap markers with scheduled day/time semantics.
- Start playback from the currently selected visible row.
- Automatic filtering of non-playable gap rows from the actual playout payload.

### Trimming

The trim panel provides both preview and cut workflows:

- Source preview through the embedded Tauri media server.
- Automatic fallback to an ffmpeg-generated proxy preview when the source file is not browser-decodable.
- IN and OUT point marking.
- Timecode entry and timeline scrubbing.
- Save-to-playlist non-destructive trims.
- Stream-copy trims for fast exports.
- Smart trims for more accurate cuts where possible.

### Compliance And Branding

The application supports compliance workflows aimed at broadcast operation:

- Rating assignment per rundown item.
- Descriptor text support.
- Tagging items as spot or telemarketing.
- Rating/logo asset loading from a configurable logos folder.
- Watermark enable/disable, position, opacity, and scale.

In OBS mode, compliance can be rendered through OBS-managed sources. In Caspar mode, branding and rating assets are loaded on dedicated Caspar layers.

## Architecture

The repository is split into a web frontend and a Rust desktop backend.

### Frontend

Frontend stack:

- Vue 3.
- Vite.
- TypeScript.
- Pinia.
- VueUse.

Key frontend responsibilities:

- Operator UI.
- Persisted settings and rundown state.
- Backend selection between OBS and CasparCG.
- WebSocket control for OBS.
- Tauri command invocation for filesystem, scanning, trimming, and configuration.

### Backend

Backend stack:

- Tauri v2.
- Rust.
- Tokio.
- rusqlite with an r2d2 connection pool.
- quick-xml for CasparCG config handling.

Key backend responsibilities:

- Media metadata scanning and caching.
- Local HTTP media serving for embedded preview playback.
- ffmpeg-powered trimming and proxy preview generation.
- Filesystem browsing and asset resolution.
- CasparCG AMCP and OSC bridge commands.
- Runtime settings synchronization from the UI.

### Important Runtime Pieces

- The Tauri media server streams local files to the embedded video element via localhost URLs.
- The scanner caches media metadata in SQLite and revalidates against file size and modification time.
- CasparCG timing uses OSC and INFO-based duration fallback logic rather than trusting only static metadata.
- FFmpeg and FFprobe paths can be overridden in Settings, otherwise the app looks for them next to the installation under `Requirements/ffmpeg/bin`.

## Repository Layout

High-level structure:

```text
src/            Vue UI, components, stores, playout services
src-tauri/      Rust backend, Tauri config, commands, scanning, trimming
logos/          Branding and ratings assets
Requirements/   Local ffmpeg bundle and related runtime dependencies
OBS STUDIO/     OBS runtime assets used in local deployment workflows
```

Important files:

- `package.json`: frontend scripts and Node requirements.
- `src-tauri/Cargo.toml`: Rust dependencies and release profile.
- `src-tauri/tauri.conf.json`: app packaging and Tauri build wiring.
- `src/stores/settings.ts`: persisted runtime settings.
- `src/stores/rundown.ts`: playlist/rundown state model.
- `src/services/obs.ts`: OBS playout backend.
- `src/services/caspar.ts`: CasparCG playout backend.

## System Requirements

This project is currently aimed at Windows environments.

Recommended baseline:

- Windows 10 or Windows 11.
- Node.js `^20.19.0 || >=22.12.0`.
- Rust toolchain compatible with `rust-version = 1.77.2` or newer.
- Microsoft Visual C++ build tools for Rust/Tauri native compilation.
- WebView2 runtime installed.

Depending on how you use the app, you may also need:

- OBS Studio with WebSocket v5 enabled.
- CasparCG configured locally on AMCP port `5250`.
- FFmpeg and FFprobe binaries.
- DeckLink drivers and configured hardware outputs.

## Runtime Configuration

Settings are persisted through Pinia and include both frontend and backend runtime values.

Key configuration fields:

- Active playout engine.
- OBS WebSocket URL and password.
- Local media root.
- FFmpeg bin directory override.
- Compliance URL for OBS browser-source workflows.
- Logos and ratings asset folder.
- DeckLink output selection.
- Live input source name or Caspar live route.
- CasparCG config path.
- Caspar OSC feedback port.
- Playout profile, transition frames, and preroll frames.
- Watermark path, enable state, position, opacity, and scale.

Expected asset names in the logos folder:

- `logo.png`
- `K.png`
- `8.png`
- `12.png`
- `16.png`
- `18.png`

## Development Setup

### 1. Install Dependencies

```powershell
npm install
```

### 2. Start The App In Development

For the full desktop app:

```powershell
npm run tauri dev
```

This runs the Vite dev server and launches the Tauri shell.

If you only want the web UI during frontend work:

```powershell
npm run dev
```

### 3. Configure The Backend In The App

On first run, open Settings and configure at least:

- Playout engine.
- Media root.
- OBS connection or Caspar parameters.
- FFmpeg bin directory if you are not using the bundled `Requirements/ffmpeg/bin` path.

## Build And Validation

### Frontend Validation

```powershell
npm run type-check
npm run build
```

### Backend Validation

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

### Production Desktop Build

```powershell
npm run tauri build
```

Tauri uses:

- `npm run build` as `beforeBuildCommand`.
- `../dist` as the frontend bundle directory.

The packaged application metadata currently uses:

- Product name: `PlayOut`
- Identifier: `com.playout.client`
- Version: `2.0.1`

## Versioning Notes

The application version is intentionally shared across multiple files. When cutting a release, keep these in sync:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- the root package entry in `src-tauri/Cargo.lock`

## Typical Operator Workflow

1. Launch the app and connect to OBS or CasparCG.
2. Configure or verify the media root and branding assets.
3. Let the library scan or warm the cache.
4. Build or select a playlist tab.
5. Drag media into the rundown and arrange order.
6. Add ratings, descriptors, tags, or gap markers as needed.
7. Open the trim panel for clips that need tighter in/out handling.
8. Start playout from the selected row.
9. Use `LIVE NOW` for urgent cut-ins.
10. Stop playout or switch playlists as required.

## Keyboard Shortcuts

The UI already exposes several operator shortcuts:

- `Enter` or `Space`: play from the selected rundown row.
- `Delete` or `Backspace`: delete the selected row when allowed.
- `Ctrl + Arrow Up` or `Ctrl + Arrow Down`: move rundown rows.
- `Shift + Arrow Down`: duplicate the selected row.
- `F8` in the library: append the selected library item after the selected rundown row.

The trim panel also supports transport-style editing shortcuts such as space to play/pause, bracket keys for IN/OUT, and arrow/page navigation for frame or larger nudges.

## Debugging And Diagnostics

When debug mode is enabled in Settings, the library exposes tools for:

- Starting a background media probe.
- Inspecting probe progress.
- Reviewing backend diagnostic entries.
- Exporting diagnostics to a text file.
- Clearing debug logs.

This is useful when validating ffprobe resolution, duration cache behavior, or backend configuration issues.

## Known Operational Assumptions

- The app is currently structured around Windows filesystem paths and Windows deployment habits.
- OBS mode expects specific managed source names such as `SOTA_Player_A` and `SOTA_Player_B` for its internal two-deck workflow.
- CasparCG mode assumes localhost AMCP and a correctly configured OSC predefined-client.
- Embedded trim preview depends on the local Tauri media server remaining alive during the full session.

## Tech Stack Summary

- Vue 3 + TypeScript frontend.
- Pinia persisted application state.
- Tauri v2 desktop shell.
- Rust backend commands.
- SQLite metadata cache.
- OBS WebSocket integration.
- CasparCG AMCP and OSC integration.
- FFmpeg/FFprobe-powered media utilities.

## License

No license has been declared yet in this repository.

If you plan to distribute this project outside an internal environment, define the license and any redistribution terms for bundled third-party runtime components before publishing.
