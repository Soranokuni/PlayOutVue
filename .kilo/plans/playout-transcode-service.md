# PlayoutTranscode - FFAStrans-Style Media Transcoding Service

## Overview

Build a standalone Rust `.exe` (`PlayoutTranscode`) — an intelligent broadcast transcoding daemon that watches folders, normalizes incoming video to strict PAL 25fps specs, stamps UUID identity into files and sidecars, and serves a web-based monitoring UI. Then retrofit the existing PlayOut application to consume those UUID sidecar files for seamless interop.

---

## Phase 1 — New Project: `D:\PlayoutTranscode\`

### 1.1 Project Scaffold

```
D:\PlayoutTranscode\
  Cargo.toml              # binary crate, edition 2021, no Tauri dependency
  src\
    main.rs               # entry point, CLI parsing (clap), dev mode flag
    bootstrap.rs          # FFmpeg toolchain audit + auto-download from gyandev
    config.rs             # TOML config load/save, wizard, defaults
    profiles.rs           # encoding profile definitions + parameter structs
    encoder.rs            # FFmpeg spawn + progress parser + transcoding logic
    watcher.rs            # notify + file-lock settle audit
    identity.rs           # UUIDv4 generation, metadata injection, sidecar write
    probe.rs              # ffprobe classification (Profile A/B/C routing)
    server.rs             # axum HTTP server + SSE + embedded SPA
    jobs.rs               # job queue (active/pending/completed/failed)
    logging.rs            # structured logging (tracing subscriber)
  config.toml             # auto-generated on first run
  bin\                    # FFmpeg download destination
```

### 1.2 Dependencies (`Cargo.toml`)

```toml
[package]
name = "playout-transcode"
version = "1.0.0"
edition = "2021"

[dependencies]
clap = { version = "4.5", features = ["derive"] }
tokio = { version = "1", features = ["full"] }
axum = { version = "0.8", features = ["ws"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"
uuid = { version = "1", features = ["v4"] }
notify = { version = "7", features = ["macos_kqueue"] }
walkdir = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
tower-http = { version = "0.6", features = ["fs", "cors"] }
chrono = "0.4"
reqwest = { version = "0.12", features = ["rustls-tls", "stream"] }
zip = "2"
flate2 = "1"
sha2 = "0.10"
regex = "1"
anyhow = "1"
parking_lot = "0.12"
windows-service = "0.7"       # Windows Service integration

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_System_Threading", "Win32_System_IO", "Win32_Storage_FileSystem"] }

[profile.release]
panic = "abort"
codegen-units = 1
lto = true
opt-level = "s"
strip = true
```

### 1.3 CLI Interface

```
PlayoutTranscode.exe <COMMAND>

Commands:
  install       Install & register as Windows Service (auto-start on boot)
  uninstall     Deregister Windows Service
  run           Run in foreground (dev/debug mode)
  wizard        Run interactive configuration wizard

Options (run):
  --config <PATH>         Config file path [default: ./config.toml]
  --watch <DIR>           Watch folder override
  --dest  <DIR>           Destination folder override
  --port  <PORT>          Web monitor port [default: 4353]
```

### 1.4 Configuration File (`config.toml`)

```toml
[paths]
watch_folder = "C:\\Media\\Watch"
target_folder = "C:\\Media\\Output"

[server]
web_port = 4353
bind_address = "127.0.0.1"

[encoding]
preset = "medium"                 # ultrafast|veryfast|faster|fast|medium|slow|slower|veryslow
ffmpeg_threads = 0                # 0 = auto-detect
audio_codec = "aac"               # aac|pcm_s16le
audio_bitrate = "320k"            # for AAC only
tune = "film"                     # film|grain|animation|none

[profile_a]
enabled = true
crf = 24
maxrate = "15M"
bufsize = "16M"

[profile_b]
enabled = true
crf = 23
maxrate = "15M"
bufsize = "16M"

[profile_c]
enabled = true
crf = 20
maxrate = "5M"
bufsize = "6M"

[ingestion]
settle_secs = 5                   # file size stabilisation wait
poll_secs = 10                    # watch folder scan interval
max_concurrency = 2               # parallel encode jobs
clean_source_after_success = false
include_extensions = []           # empty = all supported
exclude_extensions = []

[logging]
level = "info"                    # trace|debug|info|warn|error
log_file = "transcode.log"
```

### 1.5 FFmpeg Bootstrapping (`bootstrap.rs`)

**Scan order on startup:**
1. `<exe_dir>/bin/ffmpeg.exe` and `ffprobe.exe`
2. System `PATH`
3. If missing → download from `ffmpeg.org` (gyandev Windows static builds)

**Download logic:**
- Detect OS architecture (`x86_64` / `aarch64`)
- Fetch from `https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip`
- Extract to `<exe_dir>/bin/`
- Verify by running `ffmpeg -version`

**Update check:**
- Optional command: `PlayoutTranscode check-update`
- Shows current vs latest version
- Displays prominent warning: *"Warning: Upgrading a verified, stable broadcast toolchain is NOT recommended for production environments unless security patches are strictly required."*
- Requires explicit confirmation before downloading

### 1.6 Encoding Profiles (Audited & Corrected)

All profiles share a common base:
- Force PAL 25fps: `-r 25`
- Preset from config: `-preset {preset}`
- Tune from config: `-tune {tune}`
- Audio: `-c:a {audio_codec} -ar 48000 -ac 2 [-b:a {bitrate}]`
- Container: `-movflags +faststart`
- GOP: `-g 50 -keyint_min 50 -sc_threshold 0 -flags +cgop -x264-params open-gop=0`
  - 2-second GOP at 25fps, strictly closed, no scene-cut I-frames

**Profile A — Progressive HD Source (1920x1080p):**
```
-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
-colorspace bt709 -color_trc bt709 -color_primaries bt709
-profile:v main -level:v 4.1
-crf 24 -maxrate 15M -bufsize 16M
```

**Profile B — Interlaced HD Source (1920x1080i TFF):**
```
-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
-flags +ilme+ildct -top 1 -field_order tt
-colorspace bt709 -color_trc bt709 -color_primaries bt709
-profile:v main -level:v 4.1
-crf 23 -maxrate 15M -bufsize 16M
```

**Profile C — Legacy SD PAL 720x576 (anamorphic 16:9):**
```
-vf "scale=720:576:force_original_aspect_ratio=decrease,pad=720:576:(ow-iw)/2:(oh-ih)/2,setsar=64:45,format=yuv420p"
-colorspace bt601 -color_trc bt601 -color_primaries bt601
-profile:v main -level:v 3.0
-crf 20 -maxrate 5M -bufsize 6M
```

**Classification logic:**
- `ffprobe` → get width, height, field_order, r_frame_rate
- Route to profile based on height (>900 → HD, ≤900 → SD) and field_order (progressive vs interlaced)
- Unknown/non-standard → Profile A (safest default) with log warning

### 1.7 UUID Identity System (`identity.rs`)

For every successfully transcoded file:

1. Generate `Uuid::new_v4()` via the `uuid` crate
2. Inject into output MP4 via FFmpeg arg: `-metadata comment="playoutvue_id:{UUID}"`
3. Write sidecar file: `{output_filename}.uuid.json`
   ```json
   {
     "playoutvue_id": "550e8400-e29b-41d4-a716-446655440000",
     "filename": "clip_001.mp4",
     "filepath": "C:\\Media\\Output\\clip_001.mp4",
     "transcoded_at": "2026-06-08T19:33:12Z",
     "profile_used": "ProfileA",
     "original_source": {
       "path": "C:\\Media\\Watch\\clip_001_source.mxf",
       "codec": "dnxhd",
       "duration_secs": 42.5,
       "frame_count": 1063,
       "width": 1920,
       "height": 1080,
       "fps": 25.0,
       "field_order": "progressive"
     },
     "output_media": {
       "duration_secs": 42.5,
       "frame_count": 1063,
       "width": 1920,
       "height": 1080,
       "codec": "h264",
       "audio_codec": "aac",
       "fps_num": 25,
       "fps_den": 1
     }
   }
   ```

### 1.8 Directory Watcher + File Locking (`watcher.rs`)

- Use `notify` crate with `FsEventWatcher` (Recursive mode on watch folder)
- On `Create`/`Modify` events:
  1. Record file path + size + mtime
  2. Wait `settle_secs` (default 5s)
  3. Re-check file size — must be identical (file write complete)
  4. Try exclusive file open (Windows: `CreateFileW` with `FILE_SHARE_READ` deny, or Rust `File::open` + try lock)
  5. If locked → skip, retry next poll
  6. If stable + lockable → enqueue for processing
- Poll-based fallback every `poll_secs` to catch edge cases where `notify` misses events

### 1.9 Job Queue (`jobs.rs`)

```rust
enum JobState { Pending, Processing, Completed, Failed }
struct Job {
    id: String,             // UUID
    input_path: String,
    output_path: String,
    profile: String,        // "ProfileA" | "ProfileB" | "ProfileC"
    state: JobState,
    progress: f32,          // 0.0 - 100.0
    current_stage: String,  // "Probing" / "Encoding 45% (frame 1062/2380)" / "Finalizing"
    duration_secs: f64,
    error: Option<String>,
    created_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}
```

- `max_concurrency` semaphore limits parallel FFmpeg instances
- Jobs stored in `Arc<RwLock<Vec<Job>>>`
- Pending queue, active jobs, completed jobs, failed jobs

### 1.10 FFmpeg Progress Parser (`encoder.rs`)

Parse FFmpeg stderr during encoding to extract real-time progress:
```
frame= 1062 fps=48 q=28.0 size=   24576kB time=00:00:42.48 bitrate=4738.2kbits/s speed=1.92x
```
- Regex: `frame=\s*(\d+)` + `time=(\d+:\d+:\d+\.\d+)`
- Calculate progress % from known duration (from probe) vs current time
- Stream updates via SSE to web UI

### 1.11 Web Monitor (`server.rs`)

- Axum-based HTTP server on `http://127.0.0.1:4353`
- **Routes:**
  - `GET /` — Serves single-page HTML app (embedded via `include_str!` or static file)
  - `GET /api/jobs` — JSON array of all jobs (active, pending, completed, failed)
  - `GET /api/jobs/:id` — Single job detail
  - `GET /api/config` — Current config values
  - `PUT /api/config` — Update config (restart required for some changes)
  - `GET /api/health` — Service health + FFmpeg version info
  - `GET /api/ffmpeg/version` — FFmpeg version check
  - `POST /api/ffmpeg/update` — Trigger FFmpeg update
  - `POST /api/rescan` — Force re-scan watch folder
  - `GET /api/events` — SSE stream of real-time job updates

- **Web UI (embedded SPA):**
  - Queue matrix: Pending / Active / Completed / Failed sections
  - Active jobs with live progress bars
  - Log console with scrolling output
  - Config section for tweaking CRF, preset, audio settings
  - FFmpeg toolchain status indicator

### 1.12 Windows Service Integration

- `PlayoutTranscode install` — registers service via Windows SCM with auto-start
- `PlayoutTranscode uninstall` — deregisters service
- Service binary path: full path to `PlayoutTranscode.exe run`
- Service starts on system boot automatically
- Graceful shutdown: catch Ctrl+C / service stop, finish active jobs, clean up

---

## Phase 2 — UUID Sidecar Integration into PlayOut

### 2.1 Sidecar Consumer in PlayOut's Scanner

**File:** `D:\PlayOut\src-tauri\src\scanner.rs`

When `load_cached_or_probe` runs:
1. After probing a file, check if a `.uuid.json` sidecar exists alongside it
   - Look for `{original_filename}.uuid.json` or `{filename_without_ext}.uuid.json`
2. If sidecar found:
   - Parse the JSON → extract `playoutvue_id`
   - Use as the authoritative `playoutvue_id` for the entry
   - Optionally extract `transcoded_at`, `output_media` metadata
3. Also check the destination folder's uuid.json files when probing the target folder

### 2.2 Schema Alignment

**New field in `CachedMediaEntry`:**
```rust
pub playoutvue_id: String,   // already exists!
pub transcoded_at: String,   // NEW: ISO 8601 timestamp from sidecar
pub source_codec: String,    // NEW: original codec before transcode
```

**Sidecar JSON schema** (same as produced by PlayoutTranscode):
```json
{
  "playoutvue_id": "uuid-v4",
  "filename": "clip_001.mp4",
  "filepath": "C:\\Media\\Output\\clip_001.mp4",
  "transcoded_at": "ISO 8601",
  "profile_used": "ProfileA",
  "original_source": { ... },
  "output_media": { ... }
}
```

### 2.3 Changes to `media_index.rs`

The JSON media index already stores `stable_media_id`. When a sidecar UUID is available, it becomes the authoritative `stable_media_id`:
- `upsert_entry` — if sidecar UUID available, use it over fingerprint-derived ID
- `hydrate_entry_from_index` — already works with the stored stable ID
- `enrich_entry_from_index_by_alias` — already works

### 2.4 Changes to `db.rs`

Add migration for new columns:
```sql
ALTER TABLE media_cache ADD COLUMN transcoded_at TEXT DEFAULT '';
ALTER TABLE media_cache ADD COLUMN source_codec TEXT DEFAULT '';
```

---

## Phase 3 — Build & Validation

### 3.1 Build Process

```
# PlayoutTranscode
cd D:\PlayoutTranscode
cargo build --release
# Output: target\release\playout-transcode.exe

# PlayOut (regenerate Tauri bindings if needed)
cd D:\PlayOut\src-tauri
cargo build --release
```

### 3.2 Integration Test Flow

1. Start PlayoutTranscode: `playout-transcode.exe run --watch Media\Watch --dest Media\Output`
2. Drop a test MXF/DNxHD file into `Media\Watch`
3. Verify it transcodes to `Media\Output\clip_001.mp4`
4. Verify `Media\Output\clip_001.uuid.json` exists with valid UUID
5. Verify MP4 metadata contains `playoutvue_id` in comment tag
6. Open PlayOut, point media library at `Media\Output`
7. Verify the file appears with correct duration, codec, and stable `playoutvue_id`
8. Verify trimming works on the transcoded file (stream-copy at GOP boundaries)
9. Verify playout to CasparCG DeckLink works

---

## Files Modified Summary

### New project (D:\PlayoutTranscode):
- `Cargo.toml`, all `src/*.rs` files

### PlayOut modifications:
- `src-tauri/src/scanner.rs` — sidecar detection + UUID extraction
- `src-tauri/src/db.rs` — new columns migration
- `src-tauri/src/media_index.rs` — minor: prefer sidecar UUID

### Total: ~15 new files, ~3 modified files
