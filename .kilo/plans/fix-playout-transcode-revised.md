# Fix: PlayoutTranscode — Runtime Crash + Code Cleanup + SOTA Readiness + FFmpeg Full Build

## Overview

1. Fix tokio 1.52.3 runtime panic in headless `run` mode
2. Clean up duplicated code (extract shared processor module)
3. Verify PlayOut UID/GUID identity system
4. Switch to FFmpeg **full GPL build** (not essentials), add manual download button in GUI, never auto-download

---

## Step 1: Fix Runtime Panic in `run_headless`

**File:** `src/main.rs`

The bug: `Runtime::new().block_on()` on the main thread panics in tokio 1.52.3 because spawned tasks (watcher, file processor) prevent clean blocking-pool shutdown.

The fix — replicate the GUI's working pattern: spawn the service on a **dedicated OS thread** (just like `gui.rs` does):

```rust
fn run_headless(config_path_override: Option<String>) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            tokio::select! {
                result = run_service_inner(config_path_override) => {
                    if let Err(e) = result {
                        eprintln!("Service error: {}", e);
                        std::process::exit(1);
                    }
                }
                _ = tokio::signal::ctrl_c() => {
                    println!("Shutting down...");
                }
            }
        });
    }).join().ok();

    std::process::exit(0);
}
```

This ensures the runtime drops on its own thread, not inside the main thread's blocking context.

Also remove the broken `process_file_sync` that was duplicated in `main.rs` (see Step 2).

---

## Step 2: Deduplicate `process_file_sync` into `processor.rs`

**New file:** `src/processor.rs`

Both `main.rs` and `gui.rs` have near-identical `process_file_sync` functions (~96 lines and ~86 lines). Extract into a shared module:

```rust
// src/processor.rs
use crate::{bootstrap, config, encoder, identity, jobs, probe, profiles};
use std::path::Path;

pub fn process_file_sync(
    queue: &jobs::JobQueue,
    tools: &bootstrap::ToolPaths,
    target_root: &Path,
    input_path: &Path,
    config: &config::AppConfig,
) {
    // ... unified probe → profile → encode → sidecar → UUID logic ...
}
```

**Files to update:**
- `src/gui.rs` — replace inline `process_file_sync` with `crate::processor::process_file_sync`
- `src/main.rs` — delete the duplicate, use `crate::processor::process_file_sync`

This eliminates ~180 lines of duplication and ensures both paths (CLI and GUI) use identical UUID sidecar format, broadcast events, and naming.

---

## Step 3: Restore `run_service_inner` Worker Pattern

**File:** `src/main.rs`

Use `spawn_blocking` for encoding (works now that runtime is on a dedicated thread):

```rust
tokio::spawn(async move {
    while let Some(input_path) = file_rx.recv().await {
        let permit = sem.acquire_owned().await;
        let config = cfg_for_workers.lock().clone();
        let tools = tools_clone.clone();
        let queue = jq.clone();
        let target = target_root.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            processor::process_file_sync(&queue, &tools, &target, &input_path, &config);
        });
    }
});
```

---

## Step 4: Switch to FFmpeg FULL GPL Build + Manual Download Only

**File:** `src/bootstrap.rs`

### 4.1 Change download URL from Essentials → Full GPL

Current (essentials, ~40MB, missing some codecs):
```
https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
```

Change to (full GPL build, ~130MB, all broadcast codecs + hardware accel):
```
https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.zip
```

The full build includes ffmpeg, ffprobe, and all broadcast-critical filters (deinterlacing, scaling, color correction, loudness normalization) plus hardware acceleration codecs (NVENC, AMF, QSV). This matches what FFAStrans ships.

### 4.2 Remove Auto-Download from `ensure_toolchain()`

Current behavior (auto-downloads):
```rust
pub fn ensure_toolchain() -> Result<ToolPaths, String> {
    let (tools, status) = audit_toolchain();
    if status.ffmpeg_found && status.ffprobe_found {
        return Ok(tools);
    }
    tracing::info!("FFmpeg not found locally; attempting auto-download...");
    download_ffmpeg()
}
```

**New behavior** (audit only, return error if missing):
```rust
pub fn ensure_toolchain() -> Result<ToolPaths, String> {
    let (tools, status) = audit_toolchain();
    if !status.ffmpeg_found || !status.ffprobe_found {
        return Err(format!(
            "FFmpeg/FFprobe not found. Use the 'Download FFmpeg' button in the GUI or run 'PlayoutTranscode setup' to install."
        ));
    }
    Ok(tools)
}
```

Keep `download_ffmpeg()` as a public function so the GUI button can call it.

The `--check-update` command continues to work unchanged (it only audits, doesn't download).

### 4.3 Add "Download FFmpeg" Button to GUI

**File:** `src/gui.rs`

In the top-bar, right next to the FFmpeg status indicator:

When FFmpeg is NOT found:
- Show "FFmpeg Missing" in red + "Download FFmpeg" button
- Button calls `bootstrap::download_ffmpeg()` (blocking — run in `std::thread::spawn` to avoid freezing GUI)
- On success: re-run `audit_toolchain()`, update status, log success
- On failure: log error message

When FFmpeg IS found:
- Show "FFmpeg {version}" in green (existing behavior)
- No download button (or show as disabled)

**New struct field in GuiApp:**
```rust
toolchain_ready: bool,     // cached result of audit_toolchain
ffmpeg_version_cache: Option<String>,
```

**New method:**
```rust
fn download_toolchain(&mut self) {
    let log_lines = ...;
    std::thread::spawn(move || {
        match bootstrap::download_ffmpeg() {
            Ok(_) => { /* update GUI state via channel */ }
            Err(e) => { /* show error */ }
        }
    });
}
```

Since `download_ffmpeg` is blocking (HTTP download + zip extract), it must run on a background thread. Use `std::thread::spawn` + a `tokio::sync::oneshot` or shared `Arc<Mutex<bool>>` to signal completion back to the GUI.

### 4.4 Keep Existing Detection

The existing `audit_toolchain()` function that checks for ffmpeg/ffprobe in `bin/` and on `PATH` stays exactly as-is. The `status` and `check-update` CLI commands continue to work unchanged.

---

## Step 5: Verify UID/GUID Identity System

**Files:** `src/identity.rs`, `src/main.rs`, `src/gui.rs`

The system already does this correctly:
1. `identity::generate_uuid()` → UUIDv4
2. `encoder::transcode_file()` embeds `playoutvue_id:{uuid}` in FFmpeg metadata comment
3. `identity::write_sidecar()` produces `{output}.uuid.json` with full source/output metadata

Both `main.rs` and `gui.rs` call `identity::write_sidecar()` on success (verified). The UUID is stored in `JobRecord.uuid` and broadcast via SSE for the web UI.

**No code changes needed** — the identity system is intact. The processor.rs extraction ensures consistency.

---

## Step 6: Build & Test Verification

```bash
cd D:\PlayoutTranscode && cargo build --release
```

**Test checklist:**
1. `./PlayoutTranscode.exe status` — shows toolchain status (works without download)
2. `./PlayoutTranscode.exe check-update` — shows version (works without download)
3. `./PlayoutTranscode.exe wizard` — walks through first-time setup
4. `./PlayoutTranscode.exe run` — starts service without panic ✓ (panics are fixed)
5. `./PlayoutTranscode.exe run` — prints clear error + exits code 1 if no config or no FFmpeg ✓
6. GUI — FFmpeg status indicator shows green/red
7. GUI — "Download FFmpeg" button appears when missing, triggers download, updates status
8. GUI — Start/Stop service works
9. Web monitor at `http://127.0.0.1:4353` shows job stats, SSE events, watchfolder info
10. Transcode a file → verify `{output}__pbtx.mp4` and `{output}__pbtx.uuid.json` are created with embedded UUID

---

## Files Affected

| File | Action | Description |
|------|--------|-------------|
| `src/main.rs` | Rewrite | Fix runtime (dedicated thread), remove duplicate process_file_sync, restore spawn_blocking worker |
| `src/processor.rs` | **New** | Shared encoding logic, deduplicates ~180 lines from main.rs + gui.rs |
| `src/gui.rs` | Edit | Import processor.rs, add "Download FFmpeg" button + download logic |
| `src/bootstrap.rs` | Edit | Change URL to full GPL build, make `ensure_toolchain()` audit-only (no auto-download), expose `download_ffmpeg()` as pub |
| `src/watcher.rs` | Keep as-is | File-lock, multi-cycle settle, notify — already working |
| `src/config.rs` | Keep as-is | `stable_polls_min`, `retry_policy` — already working |
| `src/server.rs` | Keep as-is | Watchfolder endpoint — already working |

## NOT Changed

| File | Reason |
|------|--------|
| `src/encoder.rs` | Unchanged, working |
| `src/identity.rs` | Unchanged, working (UID system intact) |
| `src/jobs.rs` | Unchanged, working |
| `src/logging.rs` | Unchanged, working |
| `src/probe.rs` | Unchanged, working |
| `src/profiles.rs` | Unchanged, working |
| `src/web/index.html` | Unchanged (SSE + API driven, automatically picks up new endpoints) |
| `Cargo.toml` | Unchanged, all deps already present |

---

## Implementation Order

1. **`src/processor.rs`** — create shared encoding module
2. **`src/gui.rs`** — remove inline `process_file_sync`, import processor, add download button + logic
3. **`src/bootstrap.rs`** — change URL to full GPL, remove auto-download, expose `download_ffmpeg`
4. **`src/main.rs`** — fix runtime, remove duplicate, import processor, add `mod processor;`
5. `cargo build --release` — verify compilation
6. Test all CLI commands + GUI + web monitor
