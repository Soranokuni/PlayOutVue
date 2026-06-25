# PlayoutTranscode — Production Polish & PlayOut Integration Plan

## Project Roots

| Project | Path | Description |
|---------|------|-------------|
| **PlayoutTranscode** | `D:\PlayoutTranscode\` | Rust transcoding service + Vue SPA web UI |
| **PlayOut** | `D:\PlayOut\` | Vue + Tauri broadcast playout controller |

All file paths below are relative to these roots — e.g. `probe.rs` means `D:\PlayoutTranscode\src\probe.rs` for transcoder work, and `stores/settings.ts` means `D:\PlayOut\src\stores\settings.ts` for PlayOut work.

---

## Verified: Profile Auto-Detection

The profile chooser in `probe.rs:41-50` is correct:
- `height > 900` (HD) + interlaced field_order → **ProfileB** (1920×1080i, interlaced encode)
- `height > 900` (HD) + progressive → **ProfileA** (1920×1080p25)
- `height ≤ 900` → **ProfileC** (720×576, anamorphic 16:9, SD PAL, SAR 64:45)

No changes needed here.

---

## Phase 1: Code Cleanup & Performance — `D:\PlayoutTranscode\`

### 1.1 Remove dead code

All paths under `D:\PlayoutTranscode\src\`:

| File | Dead item | Action |
|------|-----------|--------|
| `bootstrap.rs` | `run_update()`, `verify_tool_image()` | Remove |
| `encoder.rs` | `EncodeProgress.time` field (never read) | Remove |
| `identity.rs` | `ffmpeg_metadata_arg()` (duplicate logic from encoder.rs) | Remove |
| `identity.rs` | `read_sidecar()`, `extract_uuid_from_sidecar()` | Keep (needed by PlayOut integration) |
| `jobs.rs` | `JobQueue::get()`, `JobQueue::active_count()` | Remove |
| `probe.rs` | `ProbeData::duration_ms()` | Remove |
| `probe.rs` | `StreamInfo.tags`, `FormatInfo.tags` fields | Remove |
| `profiles.rs` | `EncodingProfile.description`, `EncodingProfile::all()` | Remove |
| `server.rs` | `ServerState.config_path` field | Remove |

### 1.2 Encoder performance
- Move regex compilation (`time_re`, `frame_re`, `fps_re`, `bitrate_re`, `speed_re`) into `LazyLock` statics in `D:\PlayoutTranscode\src\encoder.rs` — they're recompiled every encode call currently

---

## Phase 2: Subfolder Output Structure — `D:\PlayoutTranscode\`

### 2.1 Config changes — `D:\PlayoutTranscode\src\config.rs`
Add to `PathsConfig`:
```rust
pub struct PathsConfig {
    pub watch_folder: String,
    pub target_folder: String,      // videos go to {target_folder}/videos/
    // sidecar JSONs go to {target_folder}/sidecars/
}
```

### 2.2 Processor changes — `D:\PlayoutTranscode\src\processor.rs`
- Change `output_path` from `target_root.join(&output_filename)` to `target_root.join("videos").join(&output_filename)`
- Create `D:\PlayoutTranscode\src\sidecar_dir` = `target_root.join("sidecars")` 
- Write sidecar JSON to `sidecar_dir` instead of next to output video
- Pass `sidecar_dir` to `write_sidecar()`

### 2.3 Identity changes — `D:\PlayoutTranscode\src\identity.rs`
- Add `sidecar_dir: &Path` parameter to `write_sidecar()`
- Write JSON to `{sidecar_dir}/{filename}.uuid.json`
- Keep the filename stem same as the output video

### 2.4 Vue UI — `D:\PlayoutTranscode\web-ui\src\App.vue`
- Show both sub-paths in the Dashboard Paths card: `{target}/videos/` and `{target}/sidecars/`

---

## Phase 3: CPU Limiter — `D:\PlayoutTranscode\`

### 3.1 Config — `D:\PlayoutTranscode\src\config.rs`
`ffmpeg_threads` field already exists in `EncodingConfig` (default 0 = auto). No schema change needed.

### 3.2 Encoder — `D:\PlayoutTranscode\src\profiles.rs`
`ffmpeg_threads` is already applied as `-threads` arg in `profiles.rs:157-161`. No changes needed — it already works.

### 3.3 Vue UI — `D:\PlayoutTranscode\web-ui\src\App.vue`
- Add "CPU threads" input in Configuration tab under Encoding section
- Number input, 0 = auto (all cores), 1-N = fixed thread count
- Reads/writes to `/api/config` → `encoding.ffmpeg_threads`

---

## Phase 4: PlayOut ↔ PlayoutTranscode Integration — `D:\PlayOut\`

### 4.1 PlayOut settings — `D:\PlayOut\src\stores\settings.ts`
Add two new settings:
```typescript
transcodeVideoPath: 'C:/Transcode/Videos',    // where PlayoutTranscode outputs videos
transcodeSidecarPath: 'C:/Transcode/Sidecars', // where PlayoutTranscode writes .uuid.json
```

### 4.2 PlayOut SettingsModal — `D:\PlayOut\src\components\SettingsModal.vue`
Add a new "Transcoding" section with:
- "Transcoded Videos Folder" — text input + browse button
- "Sidecar Metadata Folder" — text input + browse button
- Persisted via Pinia + Tauri file dialog for browse

### 4.3 PlayOut MediaLibrary — `D:\PlayOut\src\components\MediaLibrary.vue`
When scanning media:
- If a file exists in the transcode video folder AND has a matching `.uuid.json` in the sidecar folder → auto-hydrate metadata:
  - `playoutvueId` from sidecar JSON
  - `width`, `height`, `fps`, `duration` from output_media
  - Display transcode info in MediaInspector
  - `original_source.path` for reference
- Add a "Transcoded" badge/border to media nodes that have sidecar metadata

### 4.4 PlayOut MediaInspector — `D:\PlayOut\src\components\MediaInspector.vue`
- If `playoutvueId` is present, show a "Transcoded by PlayoutTranscode" section with:
  - UUID, profile used, original source path, transcode timestamp

---

## Phase 5: WiX MSI Installer — `D:\PlayoutTranscode\`

### 5.1 Directory structure for installer
```
D:\PlayoutTranscode\dist\installer\
├── PlayoutTranscode.exe
├── web-ui/
│   └── dist/                    # Vue SPA build
├── Requirements/
│   └── ffmpeg/
│       └── bin/
│           ├── ffmpeg.exe
│           ├── ffprobe.exe
│           └── ffplay.exe
├── install.ps1                  # Post-install helper
└── config.toml.example
```

### 5.2 Create build script — `D:\PlayoutTranscode\scripts\build-installer.ps1`
- Download FFmpeg release essentials ZIP from gyan.dev
- Extract to `Requirements\ffmpeg\`
- Build Rust release binary (`cargo build --release`)
- Build Vue SPA (`cd web-ui && npm run build`)
- Copy everything to `dist\installer\`
- Run WiX candle + light to produce MSI

### 5.3 WiX toolset — `D:\PlayoutTranscode\installer\PlayoutTranscode.wxs`
- Product GUID, upgrade code
- Install to `%ProgramFiles%\PlayoutTranscode\`
- Desktop shortcut
- Register as Windows Service (optional, via post-install script)
- Include `web-ui/dist`, `Requirements/ffmpeg`, `PlayoutTranscode.exe`
- Target `x64` architecture (`Package Platform="x64"`)
- Start Menu shortcut

### 5.4 NSIS alternative — `D:\PlayoutTranscode\installer\PlayoutTranscode.nsi`
Simpler alternative for portable deployment:
- ZIP self-extractor with install script
- Register service, create shortcuts
- Detect existing FFmpeg

### 5.5 Bootstrap FFmpeg on first run
- Exe looks for `{exe_dir}/Requirements/ffmpeg/bin/ffmpeg.exe`
- If not found, offers download via web UI
- Fallback: environment PATH

---

## Phase 6: Security Hardening — `D:\PlayoutTranscode\`

### 6.1 Change state-changing API endpoints to POST — `D:\PlayoutTranscode\src\server.rs`
Currently using GET for state-changing operations. Change to POST:
- `POST /api/service/start`
- `POST /api/service/stop`
- `POST /api/download/start`
- `POST /api/service/install`
- `POST /api/service/uninstall`

### 6.2 Vue frontend — `D:\PlayoutTranscode\web-ui\src\App.vue`
Update all state-changing `fetch()` calls to use `{ method: 'POST' }`.

### 6.3 Input path sanitization — `D:\PlayoutTranscode\src\processor.rs`
- Validate that `input_path` is within `watch_folder`
- Reject paths that escape the watch root (path traversal guard)

---

## Files Modified Summary

### `D:\PlayoutTranscode\` (Transcoder)
| File | Change |
|------|--------|
| `src\bootstrap.rs` | Remove `run_update()`, `verify_tool_image()` |
| `src\encoder.rs` | LazyLock regex, remove `.time` field |
| `src\identity.rs` | Remove `ffmpeg_metadata_arg`, add `sidecar_dir` param to `write_sidecar()` |
| `src\jobs.rs` | Remove `get()`, `active_count()` |
| `src\probe.rs` | Remove `duration_ms()`, `StreamInfo.tags`, `FormatInfo.tags` |
| `src\profiles.rs` | Remove `description`, `all()` |
| `src\server.rs` | Remove `config_path` from `ServerState`, change GET→POST endpoints |
| `src\config.rs` | (No schema changes — subfolder structure is implicit) |
| `src\processor.rs` | Subfolder output (`videos/` + `sidecars/`), path sanitization |
| `web-ui\src\App.vue` | POST calls, CPU threads UI, paths display |
| `scripts\build-installer.ps1` | **NEW** — installer build script |
| `installer\PlayoutTranscode.wxs` | **NEW** — WiX MSI config |
| `installer\PlayoutTranscode.nsi` | **NEW** — NSIS config |

### `D:\PlayOut\` (Playout Controller)
| File | Change |
|------|--------|
| `src\stores\settings.ts` | Add `transcodeVideoPath`, `transcodeSidecarPath` fields |
| `src\components\SettingsModal.vue` | Add "Transcoding" section with path inputs + browse buttons |
| `src\components\MediaLibrary.vue` | Sidecar-aware media scanning — auto-hydrate metadata from `.uuid.json` |
| `src\components\MediaInspector.vue` | Display transcode metadata when `playoutvueId` is present |

---

## Estimated Impact
- ~200 lines removed (dead code across both projects)
- ~150 lines added (cleanup + subfolders + CPU limiter UI)
- ~120 lines in Vue web UI (`D:\PlayoutTranscode\web-ui\`)
- ~80 lines in PlayOut (`D:\PlayOut\src\`)
- Installer: ~200 lines (`D:\PlayoutTranscode\installer\` + `scripts\`)
