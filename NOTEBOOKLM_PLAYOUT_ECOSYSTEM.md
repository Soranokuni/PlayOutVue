# Broadcast Playout & Transcode Ecosystem: Comprehensive Architecture & Research Manual

> **Document Classification**: System Architecture, Technical Reference & Research Corpus  
> **Target Audience & Use Case**: Google NotebookLM Semantic Indexing, Deep Broadcast Engineering Research, Codebase Analysis, Automated Playout Architecture  
> **Author & Architect**: **[Soranokuni](https://github.com/Soranokuni)** (Alex Fountas — `shadowsora13@hotmail.gr`)  
> **Repositories**:  
> - Upstream Ingest & Transcode Service: [https://github.com/Soranokuni/PlayoutTranscode](https://github.com/Soranokuni/PlayoutTranscode)  
> - Downstream Master Control Client: [https://github.com/Soranokuni/PlayOutVue](https://github.com/Soranokuni/PlayOutVue)  
> **License**: MIT License  

---

## 1. Executive Summary & Design Philosophy

The **Soranokuni Broadcast Suite** is an integrated, dual-tier television playout and media preparation platform designed for mission-critical Master Control Room (MCR) environments. Built for Windows-first broadcast workflows, the system is split cleanly into two decoupled, highly specialized software tiers:

1. **`PlayoutTranscode` (Upstream Ingest Daemon)**: A background Windows service engineered in Rust (using Axum, Tokio, and FFmpeg/FFprobe) that continuously watches media drop zones, settles active file copies, extracts metadata, snaps frame rates to exact broadcast rationals, deduplicates via SHA-256 fingerprinting, normalizes incoming assets into broadcast-compliant mezzanine video (Profiles A/B/C), generates atomic JSON sidecars, and serves catalog and job status through REST and Server-Sent Events (SSE).
2. **`PlayOutVue` (Downstream MCR Playout Controller)**: A desktop master control automation application engineered in Vue 3, TypeScript, Tauri v2, and Rust. It provides operators with rundown editing, non-destructive trimming, virtual multi-tier folder management, soft-delete recycle bin protection, live crawl tickers, Greek NCRTV broadcast graphics compliance, Blackmagic DeckLink live input routing, and deterministic, frame-accurate playout automation controlling **CasparCG Server 2.3+** via TCP AMCP and UDP OSC.

```
+-----------------------------------------------------------------------------------------+
|                                    BROADCAST ECOSYSTEM                                  |
+-----------------------------------------------------------------------------------------+
|                                                                                         |
|   +-----------------------+                         +-------------------------------+   |
|   |   Ingest Dropzones    |                         |    Downstream Transmission    |   |
|   |  (Watch Folders/SMB)  |                         | (CasparCG Server 2.3+ SDI/IP) |   |
|   +-----------+-----------+                         +---------------+---------------+   |
|               |                                                     ^                   |
|               v                                                     | AMCP (TCP: 5250)  |
|   +-----------------------+     REST / SSE (:4353)  +---------------+---------------+   |
|   |   PlayoutTranscode    | ----------------------> |           PlayOutVue          |   |
|   | (Rust Ingest Daemon)  | <---------------------- |   (Vue 3 / Tauri Desktop MCR) |   |
|   +-----------+-----------+    Metadata Mutations   +---------------+---------------+   |
|               |                                                     |                   |
|               v                                                     v OSC (UDP: 6250)   |
|   +-----------------------+                         +-------------------------------+   |
|   | Mezzanine & Sidecars  |                         |    OSC Real-Time Feedback     |   |
|   | (Standardized Media)  |                         |  (Frame Tracker / AutoAdvance)|   |
|   +-----------------------+                         +-------------------------------+   |
+-----------------------------------------------------------------------------------------+
```

### Core Engineering Invariants
- **Deterministic Frame Arithmetic**: Floating-point approximations for frame rates (e.g. `29.97` or `23.976`) are strictly banned from playout calculations. All time, duration, and frame trims are computed using exact rational fractions (`fps_num / fps_den`) to eliminate cumulative A/V sync drift.
- **Contract Boundary Honesty**: No media item in `PlayoutTranscode` may be marked as `ready` in the database unless its mezzanine output path is final, duration is exact, rational FPS is verified, closed GOP and faststart `moov` headers are validated, and the atomic `.uuid.json` sidecar exists.
- **Playout Isolation**: The user interface in `PlayOutVue` runs decoupled from the playback execution loop. Playout commands, AMCP socket dispatches, and OSC feedback loops execute in dedicated asynchronous layers protected by monotonic playback intent tokens to prevent UI latency from affecting broadcast transmission.
- **Zero Partial-Read Hazards**: File copy operations on watch folders are guarded by multi-pass settling debounce logic. Transcode encoding writes to temporary files (`.tmp_{uuid}_{filename}`) on the target disk and executes atomic filesystem renames upon validation.

---

## 2. End-to-End System Topography & Network Topology

```
+---------------------------------------------------------------------------------------------------+
| NETWORK TOPOGRAPHY & PORT BINDINGS                                                                |
+---------------------------------------------------------------------------------------------------+
|  Port / Protocol   | Direction              | Purpose                                             |
+--------------------+------------------------+-----------------------------------------------------+
|  TCP 4353 (HTTP)   | PlayOutVue -> Transcode| REST API (Asset queries, trim/rating mutations, DB) |
|  TCP 4353 (SSE)    | Transcode -> PlayOutVue| Real-time job state stream & progress broadcasting  |
|  TCP 5250 (AMCP)   | PlayOutVue -> CasparCG | Advanced Media Control Protocol (PLAY, LOADBG, CG)  |
|  UDP 6250 (OSC)    | CasparCG -> PlayOutVue | Open Sound Control frame-by-frame progress updates  |
|  TCP Dynamic/Loop  | PlayOutVue Webview ->  | Tauri Local HTTP Media Server for video preview     |
|                    | Rust Media Server      | and on-the-fly FFmpeg proxy streaming               |
+--------------------+------------------------+-----------------------------------------------------+
```

### Communication Protocols & Socket Lifecycles
1. **AMCP Protocol (TCP 5250)**:
   - Managed by `src-tauri/src/amcp.rs` in `PlayOutVue`.
   - Maintains an asynchronous TCP socket pool with automatic reconnect logic (exponential backoff: base 750ms, max 15,000ms).
   - Playout commands (`PLAY`, `LOADBG`, `CLEAR`, `MIXER`, `CG`) are dispatched with CRLF line terminators and verified against CasparCG return codes (e.g. `202 PLAY OK`, `200 LOADBG OK`, `404 ERROR`).
2. **OSC Feedback Protocol (UDP 6250)**:
   - Managed by `src-tauri/src/caspar.rs` in `PlayOutVue`.
   - Listens on UDP port 6250 for OSC message paths `/channel/1/stage/layer/10/file/frame` and `/channel/1/stage/layer/10/file/time`.
   - Decodes OSC packets using `rosc`, extracting current frame index, total frames, and playback rate.
   - Emits internal Tauri event `osc-update` to the Vue frontend at 25/50 Hz to drive rundown elapsed timers, progress bars, and the auto-advance sequence.
3. **Ingest REST & SSE API (HTTP 4353)**:
   - Managed by `src/server.rs` in `PlayoutTranscode` via Axum 0.8.
   - Exposes JSON endpoints for asset metadata hydration, subclip creation, non-destructive trimming, Greek compliance ratings, and Recycle Bin management.
   - Provides `/api/events` using `tokio::sync::broadcast` to stream real-time JSON job events (`Pending`, `Processing`, `Completed`, `Failed`).

---

## 3. Upstream Media Ingestion: PlayoutTranscode Architecture

```
+-------------------------------------------------------------------------------------------------------+
| PLAYOUTTRANSCODE PIPELINE FLOW                                                                        |
+-------------------------------------------------------------------------------------------------------+
|  [Watch Folder]                                                                                       |
|        |                                                                                              |
|        v                                                                                              |
|  [watcher.rs] ---------- (Filesystem Debounce: Size & MTime Stability Check)                         |
|        |                                                                                              |
|        v                                                                                              |
|  [jobs.rs] ------------- (In-Memory FIFO Job Queue & Priority Schedulers)                             |
|        |                                                                                              |
|        v                                                                                              |
|  [processor.rs] -------- (Pipeline Coordinator)                                                       |
|        |                                                                                              |
|        +---> [bootstrap.rs] --- Locate FFmpeg/FFprobe binaries                                        |
|        +---> [probe.rs] ------- Probe duration, audio channels, snap rational FPS                     |
|        +---> [fingerprint.rs] - Compute SHA-256 content hash (Deduplication)                          |
|        +---> [encoder.rs] ----- Transcode to Profile A/B/C -> write to .tmp_{uuid}_{name}             |
|        +---> [processor.rs] --- Validation Pass: GOP closed? faststart? 48kHz audio?                 |
|        +---> [std::fs::rename]- Atomic rename .tmp to final mezzanine path                            |
|        +---> [identity.rs] ---- Atomic write .uuid.json sidecar metadata                              |
|        +---> [db.rs] ---------- db::mark_ready -> SQLite media_assets.db                             |
|        +---> [server.rs] ------ SSE Event Broadcast: "Job Completed"                                  |
+-------------------------------------------------------------------------------------------------------+
```

### 3.1 Filesystem Settling & Debounce (`watcher.rs`)
To prevent corrupt ingestion when large multi-gigabyte broadcast files are copied across network shares (SMB/NFS) or local disks:
1. `notify` crate receives `Create` and `Modify` filesystem events.
2. The file enters a settling table with a debounce threshold (default 5.0 seconds).
3. The watcher polls file size and modification timestamps across consecutive intervals. Only when file length remains identical across two successive checks is the file promoted to the active job queue.

### 3.2 Rational Frame Rate Snapping (`probe.rs`)
Broadcast cameras and non-linear editors (NLEs) output varying container timebases. `probe.rs` runs `ffprobe` in JSON format, parses the stream rational `r_frame_rate` (e.g. `30000/1001` or `25/1`), and snaps it to the closest broadcast standard:

$$\Delta = \left| \frac{\text{num}}{\text{den}} - \text{standard} \right|$$

Standard broadcast rational snapping targets:
- **PAL**: $25 / 1$ (25.0 fps)
- **PAL High-Rate**: $50 / 1$ (50.0 fps)
- **NTSC Standard**: $30000 / 1001 \approx 29.97002997\dots$ fps
- **NTSC Film**: $24000 / 1001 \approx 23.97602397\dots$ fps
- **NTSC High-Rate**: $60000 / 1001 \approx 59.94005994\dots$ fps
- **True Film**: $24 / 1$ (24.0 fps)
- **Standard Progressive**: $30 / 1$, $60 / 1$

If an incoming file has an unstable or variable frame rate (VFR), the transcoder enforces constant frame rate (CFR) resampling during transcoding to match the snapped rational.

### 3.3 Encoding Profiles & FFmpeg Parameter Specification (`profiles.rs`)

PlayoutTranscode implements three standard broadcast profiles:

#### Profile A: 1080p Progressive (HD Broadcast Master)
- **Target**: 1920x1080 Progressive CFR
- **Color Matrix**: BT.709 (`-colorspace bt709 -color_primaries bt709 -color_trc bt709`)
- **Pixel Format**: `yuv420p`
- **Video Codec**: `libx264` (CRF 18–21, Preset `fast` or `medium`)
- **GOP Structure**: Closed GOP, fixed 2.0s keyframe cadence (`-g 50` for 25fps / `-g 60` for 29.97fps, `-flags +cgop -sc_threshold 0`)
- **Faststart**: `-movflags +faststart` (places `moov` atom at the file beginning for instantaneous decoder seek)
- **Audio Codec**: AAC / PCM at **48,000 Hz** stereo, 320 kbps (`-c:a aac -ar 48000 -b:a 320k -ac 2`)

#### Profile B: 1080i Interlaced (HD Broadcast Transmission)
- **Target**: 1920x1080 Interlaced Top-Field First (TFF)
- **Color Matrix**: BT.709
- **FFmpeg Interlacing Flags**: `-flags +ilme+ildct -top 1` (Enables macroblock interlaced motion estimation and DCT)
- **GOP & Audio**: Same 2.0s closed GOP and 48 kHz stereo normalization as Profile A.

#### Profile C: SD 4:3 Legacy Pillarbox Upconversion
- **Target**: 1920x1080 Pillarbox Progressive (SMPTE 170M / BT.601 color upscaled to BT.709)
- **Video Filter**: `-vf "scale=1440:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black"`
- **GOP & Audio**: Standardized 2.0s closed GOP, 48 kHz stereo.

### 3.4 Process Priority & Concurrency Throttling (`service_handle.rs`)
To prevent FFmpeg encoding spikes from saturating the CPU and starving the real-time CasparCG playout pipeline on shared hardware:
- Worker concurrency is strictly bounded by `max_concurrency` (default: 2 simultaneous transcode tasks).
- Spawned FFmpeg child processes on Windows are explicitly set to `BELOW_NORMAL_PRIORITY_CLASS` via Windows Win32 API (`SetPriorityClass`).

---

## 4. Contract Boundary, Data Serialization & Schemas

### 4.1 Upstream Asset API Response Contract (`AssetResponse`)
Every `GET /api/assets` or `GET /api/assets/{uuid}` returns a JSON payload adhering to this schema:

```json
{
  "uuid": "4c6d328b-e854-46f2-b7a4-f4b6a9c8f0e1",
  "playoutvue_id": "4c6d328b-e854-46f2-b7a4-f4b6a9c8f0e1",
  "name": "Commercial_Break_Spot_A.mp4",
  "current_path": "D:/Media/Mezzanine/Commercial_Break_Spot_A.mp4",
  "source_path": "D:/Media/Ingest/Commercial_Break_Spot_A.mov",
  "content_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "profile": "ProfileA",
  "duration_ms": 30000,
  "trim_in_ms": 0,
  "trim_out_ms": 30000,
  "fps_num": 25,
  "fps_den": 1,
  "fps": 25.0,
  "total_frames": 750,
  "gop_frames": 50,
  "keyframe_safe_start_ms": 0,
  "mezzanine_ok": true,
  "rating": "K",
  "tp": false,
  "folder_id": "commercials_2026",
  "is_trashed": false,
  "trashed_at": null,
  "created_at": "2026-08-27T10:00:00Z",
  "warnings": [],
  "keyframe_offsets": [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000, 24000, 26000, 28000]
}
```

### 4.2 PlayOutVue Hydration & Frame Trim Calculation (`frameMath.ts`)
When `PlayOutVue` hydrates an asset into a rundown item, it computes exact frame offsets for CasparCG AMCP dispatch:

$$\text{in\_frame} = \left\lfloor \frac{\text{trim\_in\_ms} \times \text{fps\_num}}{1000 \times \text{fps\_den}} \right\rfloor$$

$$\text{out\_frame} = \left\lceil \frac{\text{trim\_out\_ms} \times \text{fps\_num}}{1000 \times \text{fps\_den}} \right\rceil$$

$$\text{duration\_frames} = \text{out\_frame} - \text{in\_frame}$$

$$\text{duration\_ms} = \text{round}\left( \frac{\text{duration\_frames} \times 1000 \times \text{fps\_den}}{\text{fps\_num}} \right)$$

This mathematical formulation ensures that `duration_ms` in the rundown always reflects the integer frame count delivered by the CasparCG hardware output channel.

---

## 5. PlayOutVue Playout Engine & CasparCG Automation

```
+---------------------------------------------------------------------------------------------------+
| CASPARCG DISPATCH & FEEDBACK STATE MACHINE                                                        |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|   [Operator Take / AutoAdvance]                                                                   |
|                |                                                                                  |
|                v                                                                                  |
|   [PlaybackCoordinator.ts] ---- (Increment Monotonic Play Token)                                  |
|                |                                                                                  |
|                v                                                                                  |
|   [caspar.ts / dispatchPlayWithRetry]                                                             |
|                |                                                                                  |
|                +---> 1. Evaluate Item (Check file exists, mezzanine_ok=true, trim valid)          |
|                +---> 2. Build AMCP: "PLAY 1-10 \"path\" SEEK in_frame LENGTH dur_frames"          |
|                +---> 3. Build AMCP: "LOADBG 1-10 \"next_path\" AUTO SEEK next_in LENGTH next_dur" |
|                +---> 4. Clear/Configure Compliance Layers (31: Rating, 32: Banner, 34: TP)       |
|                |                                                                                  |
|                v                                                                                  |
|   [CasparCG Server (Port 5250)]                                                                   |
|                |                                                                                  |
|                v (Real-Time Playback over SDI/NDI)                                                |
|   [UDP OSC Feedback (Port 6250)]                                                                  |
|                |                                                                                  |
|                v                                                                                  |
|   [caspar.rs OSC Listener] ---> Tauri IPC Event: "osc-update"                                     |
|                |                                                                                  |
|                v                                                                                  |
|   [Vue Frontend Progress Bar & Timecode Display]                                                  |
|                |                                                                                  |
|                +---> At Remaining Time <= 0 ms: Trigger AutoAdvance -> Next Rundown Row          |
+---------------------------------------------------------------------------------------------------+
```

### 5.1 Stale-Token Monotonic Dispatch Protection
A known hazard in broadcast automation is socket latency: if an operator presses **Take** on Item 5 while a background retry or auto-load for Item 4 is in flight, a delayed AMCP response might switch the channel back to Item 4.

PlayOutVue solves this via a **Monotonic Play Token**:
- Every call to `take()`, `play()`, or manual row selection generates a strictly increasing `playToken` integer.
- The asynchronous `dispatchPlayWithRetry` worker checks `token !== playToken` before and after network operations.
- If the token was superseded, the operation aborts silently without sending stale AMCP commands to CasparCG.

### 5.2 AMCP Playout Command Sequence
When transitioning between items on Channel 1:
1. **Primary Video Take**:
   ```text
   PLAY 1-10 "D:/Media/Mezzanine/Feature_Film.mp4" SEEK 125 LENGTH 15000
   ```
2. **Background Preload (Next Item)**:
   ```text
   LOADBG 1-10 "D:/Media/Mezzanine/Commercial_Spot.mp4" AUTO SEEK 0 LENGTH 750
   ```
3. **Live DeckLink Take (When switching to live studio)**:
   ```text
   CLEAR 1-10
   PLAY 1-20 DECKLINK DEVICE 1
   ```

---

## 6. CasparCG MCR Layer Stack & Graphics Automation

PlayOutVue controls an 8-layer composite channel stack on CasparCG Program Channel 1.

```
+---------------------------------------------------------------------------------------------------+
| PROGRAM CHANNEL 1 COMPOSITING STACK (Top to Bottom)                                               |
+---------------------------------------------------------------------------------------------------+
| Layer 35: Station ID Stingers (Reserved animated station ID)                                      |
| Layer 34: TP Badge (Product Placement Image Overlay)                                              |
| Layer 33: On-Demand Crawl Ticker (HTML5 Breaking News Banner - CG Template)                       |
| Layer 32: Timed Explanation Banner (HTML5 Advisory CG Template - Auto-fades after N seconds)      |
| Layer 31: Greek NCRTV Age Rating Badge (K, 8, 12, 16, 18 Image Overlay)                            |
| Layer 30: Station Logo (Always-On Channel Watermark - Survives Item Advances)                     |
| Layer 20: DeckLink Live Input (SDI / HDMI Video Ingest)                                           |
| Layer 10: Primary Program Video (Mezzanine File FFmpeg Decoder)                                   |
+---------------------------------------------------------------------------------------------------+
```

### 6.1 Layer Registry & Lifecycle Specifications

| Layer | Producer Kind | AMCP Command Type | Playout Lifecycle |
|---|---|---|---|
| **10 (Video)** | FFmpeg Producer | `PLAY 1-10 ...` | Cleared per item or superseded by next media. |
| **20 (Live)** | DeckLink Producer | `PLAY 1-20 DECKLINK ...` | Active during live rundown rows; suppresses Layer 10. |
| **30 (Logo)** | Image Producer | `PLAY 1-30 "logo.png"` | Channel branding; persists across rundown row transitions. |
| **31 (Rating)** | Image Producer | `PLAY 1-31 "rating_12.png"` | Item-level; cleared upon item completion. |
| **32 (Advisory)** | HTML5 CG Template | `CG 1-32 ADD 1 "advisory" 1 ...` | Timed template; triggered at start, auto-stops after N ms. |
| **33 (Crawl)** | HTML5 CG Template | `CG 1-33 ADD/UPDATE ...` | Operator-controlled live news crawl with real-time text updates. |
| **34 (TP)** | Image Producer | `PLAY 1-34 "tp.png"` | Product Placement warning; toggled per rundown item. |
| **35 (Station ID)**| Image / Video | `PLAY 1-35 ...` | Reserved for station ID bumpers. |

### 6.2 Greek NCRTV Broadcast Compliance Engine (`greekCompliance.ts`)
Greek National Council for Radio and Television (NCRTV / ΕΣΡ) regulations mandate strict age rating icons and advisory text at the start of television programs:

1. **Age Rating Brackets**:
   - `K` (Κατάλληλο για όλους / Suitable for all)
   - `8` (Κατάλληλο για άνω των 8 ετών / Suitable for 8+)
   - `12` (Κατάλληλο για άνω των 12 ετών / Suitable for 12+)
   - `16` (Κατάλληλο για άνω των 16 ετών / Suitable for 16+)
   - `18` (Ακατάλληλο για ανηλίκους / Prohibited for minors)
   - `TP` (Τοποθέτηση Προϊόντος / Product Placement)
2. **Advisory Template Overlay**:
   - An animated HTML5 banner (`public/templates/playout/advisory.html`) displays the statutory Greek descriptive category (e.g. *«ΒΙΑ»* - Violence, *«ΣΕΞ»* - Sexual Content, *«ΧΡΗΣΗ ΟΥΣΙΩΝ»* - Substance Use).
   - Display duration is operator-configurable (default: 8000 ms), after which PlayOutVue sends `CG 1-32 STOP 1` to cleanly animate the banner off-screen while the age icon (Layer 31) remains visible throughout the program.

---

## 7. Media Hierarchy, Virtual Trees & Recycle Bin Architecture

```
+---------------------------------------------------------------------------------------------------+
| VIRTUAL FOLDER TREE & RECYCLE BIN LIFECYCLE                                                       |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|   [Active Media Catalog]                                                                          |
|        |                                                                                          |
|        +---> Virtual Folders (Arbitrary Depth: Root / Shows / News / 2026)                        |
|        +---> Folder Colors (Visual Tagging: Blue, Green, Yellow, Red, Purple)                     |
|        +---> Folders-on-Top Sorting Heuristics                                                    |
|        |                                                                                          |
|        | (User Deletes Item / Folder)                                                             |
|        v                                                                                          |
|   [Recycle Bin (Soft-Delete Stage)]                                                               |
|        |                                                                                          |
|        +---> Database: is_trashed = 1, trashed_at = TIMESTAMP                                     |
|        +---> Physical Files remain intact in Mezzanine directory                                  |
|        |                                                                                          |
|        +-------------------------+-------------------------+                                      |
|        | (Restore)                                         | (Purge Requested)                    |
|        v                                                   v                                      |
|   [Restore to Catalog]                             [Reference Check Guard]                        |
|   (is_trashed = 0)                                         |                                      |
|                                            +---------------+---------------+                      |
|                                            |                               |                      |
|                                   [Asset in Active Rundown?]     [Asset Unused?]                  |
|                                            |                               |                      |
|                                            v                               v                      |
|                                    [BLOCK PURGE]               [Pulsing Alert Dialog]             |
|                                    (Error: Active Reference)               |                      |
|                                                                            v                      |
|                                                                [Physical File Unlink]             |
|                                                                (Mezzanine + Sidecar Purged)       |
+---------------------------------------------------------------------------------------------------+
```

### 7.1 Virtual Folder Hierarchy
- PlayOutVue implements arbitrary-depth nested virtual folders (`virtualFolderTree.ts`).
- Assets can be assigned to `folder_id` trees without moving the underlying media files on disk. This prevents breaking file paths referenced in external rundowns or archives.
- The UI enforces **folders-on-top sorting**, tree indentation guide lines, folder color coding, and quick drag-to-folder relocation.

### 7.2 Recycle Bin & Reference-Protected Purge
- **Soft-Delete**: Trashing an asset sets `is_trashed = 1` and records `trashed_at`. The item is hidden from the library grid but remains on disk.
- **Reference Check**: When a permanent purge (`DELETE /api/assets/{uuid}/purge`) is requested, the system queries active rundowns. If the asset is currently cued or scheduled, the deletion is rejected with HTTP 409 Conflict to protect on-air transmission.
- **Visual Safety Barrier**: The Recycle Bin modal provides a pulsing red confirmation bar before physical disk unlinking.

---

## 8. Embedded Local Streaming Preview (`media_server.rs`)

Modern web engines (Chromium/WebKit in Tauri) cannot decode certain broadcast mezzanine codecs (e.g. 10-bit ProRes, high-bitrate MPEG-2, DNxHD) directly inside HTML5 `<video>` tags.

PlayOutVue solves this via an embedded Rust HTTP media server:
1. `media_server.rs` binds to a dynamic local loopback address (`http://127.0.0.1:<random-port>`).
2. Supports standard HTTP `Range` requests (`bytes=start-end`) for instant scrub and timeline seek.
3. If an asset format is not natively decodable by the webview, `media_server.rs` invokes an on-the-fly FFmpeg proxy pipeline that transcodes the video segment to web-compatible H.264/AAC in real time.

---

## 9. Failure Modes, Edge Cases & Recovery Taxonomy

```
+---------------------------------------------------------------------------------------------------+
| FAILURE RECOVERY MATRIX                                                                           |
+---------------------------------------------------------------------------------------------------+
| Failure Scenario            | Detection Mechanism         | System Recovery Action                |
+-----------------------------+-----------------------------+---------------------------------------+
| CasparCG Socket Flap        | TCP disconnect / error      | Exponential backoff reconnect;        |
|                             |                             | retains current playout intent state. |
+-----------------------------+-----------------------------+---------------------------------------+
| Missing / Corrupt File      | Pre-dispatch file probe     | classifyPlayoutFailure flags error;   |
|                             |                             | stops rundown without silent skip.    |
+-----------------------------+-----------------------------+---------------------------------------+
| Non-Standard FPS Media      | PlayoutTranscode ffprobe    | Snaps to broadcast rational (probe.rs)|
|                             |                             | and transcodes with CFR.              |
+-----------------------------+-----------------------------+---------------------------------------+
| Rapid Operator Double-Take  | PlaybackCoordinator tokens  | Stale token drops obsolete dispatch;  |
|                             |                             | executes only latest operator Take.   |
+-----------------------------+-----------------------------+---------------------------------------+
| Live Input Signal Loss      | DeckLink input probe        | Fallback to emergency slate or next   |
|                             |                             | scheduled rundown video asset.        |
+-----------------------------+-----------------------------+---------------------------------------+
| Ingest Power Failure        | SQLite WAL mode             | Auto-recovers database on restart;    |
|                             |                             | cleans orphaned .tmp staging files.   |
+-----------------------------+-----------------------------+---------------------------------------+
```

---

## 10. Automated Testing & Verification Infrastructure

### 10.1 PlayoutTranscode Contract Boundary Test (`tests/contract_boundary.rs`)
Validates that every asset published by PlayoutTranscode satisfies the exact requirements expected by the PlayOutVue rundown hydrator:
- Asserts `uuid == playoutvue_id`
- Asserts `mezzanine_ok == true`
- Asserts `fps_num > 0` and `fps_den > 0`
- Asserts `duration_ms == trim_out_ms` on initial publish
- Asserts that `compute_frame_trim` yields identical integer frame counts.

### 10.2 PlayOutVue Unit & Integration Suite
- **`fakeCasparTransport.ts`**: Mock AMCP server for testing playout transitions without requiring physical CasparCG hardware.
- **`RatingBadgeOwnership.test.ts`**: Verifies Greek NCRTV badge placement and layer lifecycle.
- **`RundownStructuralEditing.test.ts`**: Tests undo/redo history, row duplication, gap insertion, and multi-row selection.
- **`VirtualSubclip.test.ts`**: Verifies non-destructive subclip boundary math.

---

## 11. System Glossary & Reference

- **AMCP**: Advanced Media Control Protocol (TCP control protocol for CasparCG Server).
- **CFR**: Constant Frame Rate (mandatory for broadcast transmission).
- **Closed GOP**: Group of Pictures where P and B frames only reference frames within the same GOP (enables instant frame-accurate seek).
- **DSK**: Downstream Keyer (compositing overlay graphics on top of primary video).
- **Faststart**: MP4 container optimization placing the `moov` index atom at the file start.
- **MCR**: Master Control Room (the broadcast transmission operations center).
- **Mezzanine**: High-quality normalized video format used as the intermediary storage and playout file.
- **NCRTV (ΕΣΡ)**: National Council for Radio and Television (Greece broadcast regulator).
- **OSC**: Open Sound Control (UDP messaging protocol used by CasparCG for telemetry).
- **Rundown**: Chronological playlist of video, live, and commercial events for transmission.
- **Sidecar**: Accompanying `.uuid.json` metadata file stored alongside media files on disk.
- **TP**: *Τοποθέτηση Προϊόντος* (Product Placement broadcast indicator).
- **WAL**: Write-Ahead Logging (SQLite journaling mode providing crash resilience and multi-reader concurrency).

---

## Author & Project Credits

- **Creator & Lead Architect**: **[Soranokuni](https://github.com/Soranokuni)** (Alex Fountas)
- **Direct Inquiries**: [shadowsora13@hotmail.gr](mailto:shadowsora13@hotmail.gr)
- **Source Code Repositories**:
  - Playout Controller: [https://github.com/Soranokuni/PlayOutVue](https://github.com/Soranokuni/PlayOutVue)
  - Ingest & Transcode Service: [https://github.com/Soranokuni/PlayoutTranscode](https://github.com/Soranokuni/PlayoutTranscode)
- **Copyright**: &copy; 2026 Soranokuni. Released under the MIT License.
