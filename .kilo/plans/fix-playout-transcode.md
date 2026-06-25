# Fix: PlayoutTranscode — GUI Modernization + Watchfolder Robustness + FFmpeg Choice

## Overview

Fix the standalone `playout-ingestd` binary (PlayoutTranscode) with three pillars:
1. **Beautiful modern GUI** — replace the retro `IngestShell.vue` with a polished broadcast-grade UI
2. **FFmpeg full vs essentials** — keep the full GPL build for broadcast robustness
3. **Watchfolder as robust as FFAStrans** — file-lock detection, growing-file tracking, multi-cycle settle, persistent job DB

---

## Pillar 0 — FFmpeg Decision: Keep Full GPL Build

**Recommendation:** Keep the current full GPL build from BtbN (`ffmpeg-master-latest-win64-gpl.zip`), NOT downgrade to essentials.

**Rationale:**
- Full build includes all broadcast-critical filters (deinterlacing, scaling, color correction, loudness normalization)
- Hardware acceleration codecs (NVENC, AMF, QSV) come in full builds
- Current download is functional; changing introduces risk with minimal benefit
- The size difference (~130MB vs ~40MB) is negligible for a broadcast workstation
- FFAStrans itself ships with full FFmpeg builds

**Action:** No change to `scripts/download-ffmpeg.ps1`. The BtbN source is correct.

---

## Pillar 1 — Watchfolder Robustness (FFAStrans-grade)

**File:** `src-tauri/src/bin/playout_ingestd.rs`

### 1.1 Add Exclusive File-Lock Detection

The current watchfolder only checks `(modified_epoch, size)` identity across two consecutive polls. FFAStrans additionally tries to open files exclusively to detect if they're still being written.

**Implementation:**
```rust
// Windows: try CreateFileW with no sharing flags
#[cfg(target_os = "windows")]
fn is_file_available_for_reading(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::File::options()
        .read(true)
        .share_mode(0) // deny all sharing
        .open(path)
        .is_ok()
}
```

Performed after `settle_secs` pass, before enqueuing.

### 1.2 Multi-Cycle Settle Verification

Current logic: file must be seen unchanged across TWO polls only.

**Fix — Three-phase settle:**
1. **First sight** — Record file identity (size, mtime, first_seen_at)
2. **Stability check** — Over `settle_secs` seconds, verify size hasn't changed across multiple polls (not just one)
3. **Lock test** — After stability confirmed, try exclusive open
4. **Queue** — Only then enqueue

Track state per candidate file:
```rust
struct WatchCandidate {
    path: PathBuf,
    first_seen_at: u64,       // epoch_secs when first detected
    last_size: u64,
    last_modified: u64,
    stable_polls: u32,        // consecutive unchanged polls
    locked_checked: bool,
}
```

Default: require 2+ stable polls (configurable as `stable_polls_min`).

### 1.3 Growing File Detection

Track file size trend. If a file grows, reset its stable counter. Only consider a file settled when its size is identical for `stable_polls_min` consecutive polls.

```rust
if current_size > candidate.last_size {
    candidate.stable_polls = 0; // still growing
    candidate.last_size = current_size;
    continue;
}
```

### 1.4 Persistent Job Database (SQLite)

Currently jobs are in-memory only (`HashMap<String, IngestJobStatus>`). If the service restarts, no record of previously processed files exists.

**Add SQLite job DB** (lightweight, same rusqlite as already in Cargo.toml):
```sql
CREATE TABLE ingest_jobs (
    id TEXT PRIMARY KEY,
    input_path TEXT NOT NULL,
    input_size INTEGER,
    input_modified_secs INTEGER,
    output_path TEXT,
    state TEXT NOT NULL,       -- 'queued'|'processing'|'completed'|'failed'
    media_state TEXT,
    error TEXT,
    created_at TEXT,
    finished_at TEXT
);
```

On startup:
1. Load previous jobs from DB
2. Skip re-processing files that have a COMPLETED job with matching (path, size, mtime)
3. Re-queue FAILED jobs if retry policy allows

### 1.5 Retry Policy for Failed Jobs

```rust
enum RetryPolicy {
    Never,
    Once,
    Always,
}
```
Configurable per CLI/API. Default: retry once after 60s.

### 1.6 Filesystem Notifications (Bonus)

Add optional `notify` crate integration for instant detection:
- Use `notify::recommended_watcher` on the watch folder
- On `Create(CreateKind::File)` or `Modify(ModifyKind::Data)` → trigger immediate scan of that file
- Keep poll-based backup for directories and edge cases
- Fall back to pure polling if notify fails

---

## Pillar 2 — Beautiful Modern GUI

**File:** `src/components/IngestShell.vue`

### 2.1 Design Language

Match PlayOut's existing glass-panel broadcast aesthetic:
- Dark theme with subtle radial gradients
- Glassmorphism panels with backdrop blur
- Cyan (`#33becc`) as primary accent, red (`#e63946`) for danger/stop
- Inter font family
- Subtle animations and transitions

### 2.2 New Layout — Dashboard Tabs

Replace the current 3-column grid with a tabbed dashboard:

```
+--------------------------------------------------+
| [PlayoutTranscode]          [Start] [Stop] [Back] |
+--------------------------------------------------+
| [Dashboard]  [Watch]  [Jobs]  [Config]  [Logs]   |
+--------------------------------------------------+
|                                                    |
|   Dashboard View:                                  |
|   +----------+ +----------+ +----------+           |
|   | SERVICE   | | WATCHFOLD | | JOBS     |          |
|   | Running ● | | 3 pending | | 2 active |          |
|   | Port 8088 | | 42 proc'd | | 38 done  |          |
|   +----------+ +----------+ +----------+           |
|                                                    |
|   Active Jobs                                      |
|   ┌──────────────────────────────────────┐         |
|   │ file_001.mov  ████████████░ 87% 1.2x │         |
|   │ file_002.mxf  ██████░░░░░░░ 42% 0.8x │         |
|   └──────────────────────────────────────┘         |
|                                                    |
+--------------------------------------------------+
```

### 2.3 Components

**Service Status Card:**
- Pulse animation on "Running" indicator
- PID, port, uptime
- Quick stop/restart

**Watchfolder Status Card:**
- Live file count in watch folder
- Files waiting settle
- Files queued
- Total processed today

**Job Queue Table:**
- Active jobs with animated progress bars (SSE-driven)
- Color-coded: Blue=queued, Cyan=probing, Orange=encoding, Green=done, Red=failed
- Speed indicator (e.g. "1.7x realtime")
- Output path
- Duration

**Completed Jobs Log:**
- Scrollable list of recent completions
- Timestamps
- Success/failure badges

### 2.4 Real-time SSE Integration

Add an SSE endpoint to the Rust backend:

**Backend (`playout_ingestd.rs`):**
```rust
// GET /api/events -> SSE stream
async fn sse_events(State(state): State<ApiState>) -> Sse<impl Stream<Item = Result<Event, ...>>> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    // Store tx in state.broadcasters
    // On every job status change, broadcast to all listeners
    Sse::new(rx_stream(rx)).keep_alive(...)
}
```

**Frontend:**
Replace the 1200ms polling loop with a single `EventSource` connection:
```ts
const events = new EventSource(`${apiBaseUrl}/api/events`);
events.onmessage = (e) => {
    const update = JSON.parse(e.data);
    // Update specific job in reactive state, no full polling
};
```

### 2.5 CSS Transitions & Polish

- `transition: all 0.2s ease` on interactive elements
- Animated progress bars with gradient fills
- Hover states with subtle glow
- Pulse animation on processing indicators
- Slide transitions for tab switching
- Backdrop blur on all panels

### 2.6 Settings Organization

Group settings into logical sections:
- **Paths** — Destination, Watch folder
- **Performance** — Resource preset, FFmpeg threads, concurrent jobs
- **Watch Policy** — Poll/Stable seconds, extension filters, duplicate policy
- **Advanced** — Port, auto-trim

Each group collapsed by default with a chevron toggle.

---

## Pillar 3 — Backend SSE & API Enhancements

### 3.1 SSE Endpoint

**New route:** `GET /api/events`

Broadcasts:
- `job_queued` — when a file is enqueued
- `job_progress` — stage/progress updates during processing
- `job_completed` — final result with outcome
- `job_failed` — error details
- `watch_status` — periodic watchfolder snapshot (every poll_secs)

### 3.2 Bulk Status Endpoint

**New route:** `GET /api/jobs`  
Returns all job statuses (active + recent completed/failed), removing the need for per-job polling.

### 3.3 Watchfolder Snapshot Endpoint

**New route:** `GET /api/watchfolder`  
Returns current watch folder file count, pending settle count, queued count.

---

## Implementation Order

1. **Pillar 1 (Watchfolder)** — Core reliability first
   - 1.1: Exclusive file lock test
   - 1.2-1.3: Multi-cycle settle + growing file detection
   - 1.4: SQLite job tracking
   - 1.5: Retry policy
   - 1.6: Filesystem notifications (optional, do last)

2. **Pillar 3 (Backend API)** — API enhancements for the frontend
   - 3.1: SSE endpoint
   - 3.2-3.3: Bulk status + watchfolder snapshot

3. **Pillar 2 (GUI)** — UI overhaul after APIs are ready
   - 2.1-2.5: Complete frontend rewrite
   - Must use new SSE for real-time updates

---

## Files Affected

| File | Changes |
|------|---------|
| `src-tauri/src/bin/playout_ingestd.rs` | Watchfolder rewrite, SSE endpoint, job DB, new API routes |
| `src-tauri/Cargo.toml` | Add `notify` crate, add `rusqlite` features if needed |
| `src/components/IngestShell.vue` | Full UI rewrite — tabs, SSE, animations, modern design |
| `src/assets/main.css` | Possibly add new CSS utility classes for dashboard cards |
| `scripts/download-ffmpeg.ps1` | No change (keep full GPL build) |

## NOT Affected (no changes needed)

| File | Reason |
|------|--------|
| `src-tauri/src/ingest_service.rs` | Tauri command layer is fine as-is |
| `src-tauri/src/lib.rs` | No new commands needed for the standalone binary |
| `src/App.vue` | Already routes to IngestShell correctly |
