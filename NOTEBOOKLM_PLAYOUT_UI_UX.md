# Broadcast Playout & Transcode Suite: Comprehensive UI/UX Architecture & Operator Manual

> **Document Classification**: Master Control Room (MCR) UI/UX Design System, Frontend Architecture, Component Specifications & Operator Ergonomics  
> **Target Audience & Use Case**: Google NotebookLM Deep Indexing, Frontend Engineering Analysis, HCI Research for Broadcast Automation, UX Architecture  
> **Author & Lead Architect**: **[Soranokuni](https://github.com/Soranokuni)** (Alex Fountas — `shadowsora13@hotmail.gr`)  
> **Target Applications**:  
> - **PlayOutVue**: Desktop Master Control Playout Client (Vue 3 / TypeScript / Tauri v2 / Tailwind / CSS Custom Properties)  
> - **PlayoutTranscode Web-UI**: Ingest Daemon Real-Time Monitoring & Database Explorer (Vue 3 / Vite / SSE / Embedded Axum)  
> **License**: MIT License  

---

## 1. Executive UX Philosophy & Mission-Critical Ergonomics

Television Master Control Room (MCR) environments present extreme human-computer interaction (HCI) demands. Playout operators manage multiple high-priority transmission feeds simultaneously under tight deadlines and dim ambient lighting conditions.

```
+---------------------------------------------------------------------------------------------------+
| CORE HCI PRINCIPLES FOR BROADCAST AUTOMATION                                                      |
+---------------------------------------------------------------------------------------------------+
| 1. High-Contrast Low-Fatigue Dark Aesthetics (WCAG AAA compliant dark themes)                    |
| 2. Deterministic Keyboard-First Navigation (Singleton capture-phase routing, zero focus traps)   |
| 3. Zero-Jitter Monospaced Telemetry (Tabular numerals on all clocks, countdowns, frame counters) |
| 4. Strict Separation of Playout Execution from UI Thread Rendering                               |
| 5. Multi-Tier Visual Confirmation Barriers for Destructive Operations (Purge, Clear, Live Take)   |
| 6. Dynamic Visual Hierarchy (Folders-on-top, active-item pulsing, colorblind-safe glyph cues)    |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. Design System, Design Tokens & Scaling Architecture

The user interface avoids hardcoded hex values, relying instead on a centralized **Semantic CSS Custom Property Architecture** defined in `src/assets/base.css` and `src/assets/main.css`.

### 2.1 Semantic Token Taxonomy

```
+---------------------------------------------------------------------------------------------------+
| SEMANTIC CSS CUSTOM PROPERTIES                                                                    |
+---------------------------------------------------------------------------------------------------+
| Token Name                 | Purpose & Application                                                |
+----------------------------+----------------------------------------------------------------------+
| `--color-bg-base`          | Global application background (ultra-deep slate: #0f172a / #090d16)  |
| `--color-surface-panel`    | Primary panel container surfaces (Rundown, Media Library, Inspector) |
| `--color-surface-elevated` | Floating surfaces (Modals, Context Menus, Tooltips, Command Palette) |
| `--color-text-primary`     | High-contrast primary labels, titles, and timecode readouts          |
| `--color-text-secondary`   | Metadata fields, file paths, rational FPS, codec descriptions        |
| `--color-text-muted`       | Inactive headers, disabled controls, column guidelines               |
| `--color-border-subtle`    | Low-contrast grid dividing lines and tree guide lines                |
| `--color-border-focus`     | High-visibility focus rings and active row bounding outlines         |
| `--color-status-playing`   | On-air active transmission color (Electric Green: #10b981)           |
| `--color-status-cued`      | Next-up cued item indicator (Vibrant Blue: #3b82f6)                  |
| `--color-status-error`     | Playout failure, missing media, corrupt file (Crimson: #ef4444)      |
| `--color-status-warning`   | Rundown timing gap, QC advisory, settle warning (Amber: #f59e0b)     |
+----------------------------+----------------------------------------------------------------------+
```

### 2.2 Dynamic 3-Tier UI Scaling Engine (`data-ui-scale`)
To accommodate diverse display form factors (from 14-inch laptops to 32-inch 4K multi-monitor wall mounts), the root HTML element dynamically updates its `data-ui-scale` attribute:

```css
html[data-ui-scale="standard"] {
  --row-h-rundown: 40px;
  --row-h-library: 36px;
  --btn-h-compact: 28px;
  --btn-h-standard: 34px;
  --font-size-base: 13px;
  --timecode-font-size: 14px;
}

html[data-ui-scale="comfortable"] {
  --row-h-rundown: 48px;
  --row-h-library: 42px;
  --btn-h-compact: 32px;
  --btn-h-standard: 38px;
  --font-size-base: 14px;
  --timecode-font-size: 16px;
}

html[data-ui-scale="large"] {
  --row-h-rundown: 56px;
  --row-h-library: 50px;
  --btn-h-compact: 38px;
  --btn-h-standard: 46px;
  --font-size-base: 16px;
  --timecode-font-size: 19px;
}
```

### 2.3 Zero-Jitter Monospaced Typography
To eliminate visual layout shifting during sub-second playback updates (25/50 Hz OSC telemetry ticks):
- All clocks, countdown timers, remaining-time labels, duration badges, and SMPTE timecodes enforce:
  ```css
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.05em;
  ```

---

## 3. PlayOutVue: Comprehensive Desktop Layout Architecture

```
+---------------------------------------------------------------------------------------------------+
| PLAYOUTVUE DESKTOP MASTER CONTROL LAYOUT (App.vue)                                               |
+---------------------------------------------------------------------------------------------------+
| [TOP BAR] Master Telemetry, On-Air State, Server IP, Ingest Status, DeckLink, Theme, Scale, Clock|
+-------------------------------------------------+-------------------------------------------------+
| LEFT PANE: RUNDOWN & TRANSMISSION GRID (60%)    | RIGHT PANE: WORKSPACE & ASSET PANELS (40%)      |
| +---------------------------------------------+ | +---------------------------------------------+ |
| | [RundownControls.vue]                       | | | [TAB BAR] Library | Inspector | Compliance   | |
| | [Take / Play] [Pause] [Stop] [Next] [Loop]  | | +---------------------------------------------+ |
| | [AutoAdvance: ON] [Rundown Lock: LOCKED]   | | | [MediaLibrary.vue]                          | |
| +---------------------------------------------+ | | - Breadcrumb Navigation (Root / Shows / 2026)| |
| | [RundownList.vue]                           | | | - Virtual Folder Tree & Color Categories    | |
| | # | St | Title       | In-Out | Dur | Air   | | | - Search Filter [ Videos | Audio | Live ]   | |
| | 1 | 🟢 | Show_Intro  | 00:00  | 00:30| 12:00 | | | - Media Rows with Mezzanine Probe Lights    | |
| | 2 | 🔵 | Feature_Film| 01:25  | 45:00| 12:00 | | +---------------------------------------------+ |
| | 3 | ⚪ | Commercial_1| 00:00  | 00:30| 12:45 | | | [MediaInspector.vue & TrimPanel.vue]        | |
| | 4 | ⚠️ | [GAP: 00:05]| -----  | 00:05| 12:46 | | | - Embedded Video Scrub & Timecode Bar       | |
| | 5 | ⚪ | News_Live_In| LIVE   | 30:00| 12:46 | | | - Non-destructive Trim In [ / Out ] Markers | |
| +---------------------------------------------+ | | - Greek NCRTV Badges (K, 8, 12, 16, 18, TP)| |
| | [BOTTOM STATS] Total: 01:15:35 | Elapsed... | | | - Create Virtual Subclip Button             | |
| +---------------------------------------------+ | +---------------------------------------------+ |
+-------------------------------------------------+-------------------------------------------------+
| [MODALS / OVERLAYS] RecycleBinModal | SettingsModal | DeckLinkWizard | CommandPaletteModal (<C-k>) |
+---------------------------------------------------------------------------------------------------+
```

---

## 4. Component Deep Dive & Interactive UX Behaviors

### 4.1 Rundown & Playlist Management (`RundownList.vue` & `RundownRow.vue`)
The rundown is the central transmission grid. Every row represents an atomic playback event:

#### Visual Columns & Indicators:
1. **Row Index**: 1-based sequential position.
2. **Transmission Status Glyphs**:
   - 🟢 **Playing (Active)**: Bright green background highlight with animated pulse indicator.
   - 🔵 **Cued (Next Up)**: Blue border outline indicating CasparCG `LOADBG` preload.
   - ⚪ **Ready (Scheduled)**: Standard state ready for automatic or manual take.
   - 🟡 **Gap / Advisory**: Warning banner for scheduled broadcast gaps between programs.
   - 🔴 **Error / Missing Media**: Crimson highlight if mezzanine file is missing or unverified.
   - ⏸️ **Manual Stop**: Playout will pause after this item rather than auto-advancing.
   - ⏭️ **Skipped**: Grayed out item bypassed during execution.
3. **Clip Metadata**: Display title, file extension, source codec, and rational frame rate (`fps_num/fps_den`).
4. **Trim Markers & Duration**: Monospaced display of `trim_in_ms`, `trim_out_ms`, and computed frame duration.
5. **Greek NCRTV Compliance Badges**: Color-coded statutory age icon (`K`, `8`, `12`, `16`, `18`) and `TP` badge.
6. **Air Time (ETA)**: Projected real-time clock calculated dynamically from the cumulative durations of preceding items.

#### Interactive Behaviors:
- **Locked Rundown Guard**: A master lock toggle prevents accidental drag-and-drop, row deletion, or playlist modification while on air.
- **Drag-and-Drop Reordering (`useDragSession.ts`)**: Uses SortableJS with real-time insertion line indicators. Calculates proposed moves deterministically (`calculateMove`) and saves an undo snapshot only upon state divergence.
- **Undo / Redo Serialization**: Snapshot-based history stack supporting unlimited <kbd>Ctrl</kbd>+<kbd>Z</kbd> and <kbd>Ctrl</kbd>+<kbd>Y</kbd> operations.

---

### 4.2 Media Library & Virtual Tree Hierarchy (`MediaLibrary.vue`)

The Media Library provides a frictionless asset browser that shields operators from disk path complexities.

```
+---------------------------------------------------------------------------------------------------+
| VIRTUAL FOLDER TREE & MEDIA ASSET CARD                                                            |
+---------------------------------------------------------------------------------------------------+
|  [Root] > [Commercials] > [Automotive]                                 [ Search: "Summer"      ]  |
|  +----------------------------------------------------------------------------------------------+ |
|  | 📁 [..] Parent Directory                                                                     | |
|  | 📁 2026_Campaigns (Folder - Blue Tag)                                    4 Items             | |
|  | 📁 Archived_Spots (Folder - Muted Gray)                                  12 Items            | |
|  +----------------------------------------------------------------------------------------------+ |
|  | 🎬 Summer_Drive_1080p.mp4  [Mezzanine: OK] [25/1] [EBU R128 -23LUFS] [Rating: 12]  00:30:00  | |
|  | 🎬 Beach_Promo_Spot.mp4    [Mezzanine: OK] [25/1] [EBU R128 -23LUFS] [Rating: K]   00:15:00  | |
|  | 🎬 Night_Drive_VFR.mov     [Transcode: Pending / 65%]                             --:--:--  | |
|  +----------------------------------------------------------------------------------------------+ |
```

#### Key UX Features:
1. **Folders-on-Top Sorting**: Directory nodes are pinned to the top of the grid with subtle tree guide lines.
2. **Virtual Folder Nesting**: Assets can be nested into unlimited virtual subfolders (`virtualFolderTree.ts`) without moving files physically on the filesystem.
3. **Folder Color Categorization**: Operators can assign 5 distinct color tags (Blue, Green, Yellow, Red, Purple) to virtual folders for instant visual recognition.
4. **Batch Selection & Insertion**:
   - <kbd>Shift</kbd> + Click / <kbd>Ctrl</kbd> + Click multi-selection.
   - Pressing <kbd>F8</kbd> appends all selected clips sequentially after the currently active rundown row.
   - Pressing <kbd>Shift</kbd> + <kbd>F8</kbd> prepends clips directly ahead of the active row.
5. **Instant Drag-to-Rundown**: Dragging single or multi-selected items into the rundown reveals a glowing drop target indicating exact frame placement.

---

### 4.3 Media Inspector, Waveform Scrub & Non-Destructive Trimming (`MediaInspector.vue` & `TrimPanel.vue`)

The Inspector provides clip inspection, compliance tagging, and frame-accurate non-destructive trimming.

```
+---------------------------------------------------------------------------------------------------+
| MEDIA INSPECTOR & TRIM STUDIO                                                                     |
+---------------------------------------------------------------------------------------------------+
| +-----------------------------------------------------------------------------------------------+ |
| |                                 EMBEDDED VIDEO PREVIEW                                        | |
| |                              (Rust HTTP Streaming Server)                                     | |
| +-----------------------------------------------------------------------------------------------+ |
|   [ |< ] [ -1s ] [ -1f ] [ PLAY / PAUSE ] [ +1f ] [ +1s ] [ >| ]         Timecode: 00:01:14:12    |
| +-----------------------------------------------------------------------------------------------+ |
| | [=============|======================[ TIMELINE ]======================|====================] | |
| |               ^ TRIM IN (00:00:05:00)                                  ^ TRIM OUT (00:01:25:00) | |
| +-----------------------------------------------------------------------------------------------+ |
|   In Point: [ 00:00:05:00 ] (Set '[')   Out Point: [ 00:01:25:00 ] (Set ']')   Duration: 01:20:00 |
|                                                                                                   |
|   GREEK NCRTV COMPLIANCE SETTINGS:                                                                |
|   Age Rating: ( ) K   ( ) 8   (•) 12   ( ) 16   ( ) 18        Product Placement: [x] TP Flag      |
|   Advisory Content: [x] ΒΙΑ (Violence)   [ ] ΣΕΞ (Sex)   [ ] ΟΥΣΙΕΣ (Drugs)                       |
|   Advisory Banner Duration: [====|=========] 8.0 Seconds                                          |
|                                                                                                   |
|   [ CREATE VIRTUAL SUBCLIP ]                         [ SAVE TRIMS TO INGESTOR ]                   |
+---------------------------------------------------------------------------------------------------+
```

#### Trimming & Subclip Engine:
- **Frame-Accurate In/Out Markers**: Operators set in-points (<kbd>[</kbd>) and out-points (<kbd>]</kbd> with single-frame stepping buttons (<kbd>←</kbd> / <kbd>→</kbd>).
- **Non-Destructive Persistence**: Trim points update `trim_in_ms` and `trim_out_ms` in the database without modifying the underlying mezzanine file.
- **Virtual Subclips (`virtualSubclipService.ts`)**: Creates a child asset pointing to the same physical video file with custom trim boundaries, inheriting parent `mezzanine_ok` validation.

---

### 4.4 Greek NCRTV Compliance & Downstream Keyer (DSK) Studio (`ComplianceModule.vue`)

A specialized broadcast graphics control center enforcing statutory Greek National Council for Radio and Television (NCRTV / ΕΣΡ) broadcast mandates:

1. **Rating Badges (Layer 31)**:
   - Live preview of high-contrast PNG rating icons (`K.png`, `8.png`, `12.png`, `16.png`, `18.png`).
   - Automatically cued and taken when rundown media changes.
2. **Timed Advisory Banners (Layer 32)**:
   - Real-time HTML5 animated advisory banner (`advisory.html`) showing Greek descriptive classifications (*«ΚΑΤΑΛΛΗΛΟ ΓΙΑ ΑΝΩ ΤΩΝ 12 ΕΤΩΝ - ΕΠΙΘΥΜΗΤΗ Η ΓΟΝΙΚΗ ΣΥΝΑΙΝΕΣΗ»*).
   - Display countdown slider controlling automated off-screen fade after N seconds (default: 8s).
3. **Live Breaking News Crawl Ticker (Layer 33)**:
   - On-demand HTML5 ticker banner (`crawl.html`) with real-time text editing and dynamic `CG UPDATE` dispatch.
   - Variable speed slider (Slow, Medium, Urgent Breaking News).
4. **Channel Logo Watermark (Layer 30)**:
   - Master station logo toggle; persists across rundown transitions.

---

### 4.5 Recycle Bin & Reference-Protected Safe Purge (`RecycleBinModal.vue`)

Protects broadcast operations against accidental physical file deletion.

```
+---------------------------------------------------------------------------------------------------+
| RECYCLE BIN MODAL & SAFE PURGE GUARD                                                              |
+---------------------------------------------------------------------------------------------------+
|  [ Trashed Assets: 3 Items | Total Reclaimable Disk Space: 4.2 GB ]                               |
|  +----------------------------------------------------------------------------------------------+ |
|  | [x] Feature_Film_Old_Cut.mp4      Trashed: 2 hours ago by Operator      Size: 3.8 GB  [RESTORE]| |
|  | [ ] Promo_Summer_2025.mp4         Trashed: 1 day ago                    Size: 400 MB  [RESTORE]| |
|  +----------------------------------------------------------------------------------------------+ |
|                                                                                                   |
|  ⚠️ PULSING SAFETY BARRIER: Physical file deletion cannot be undone.                              |
|  [=========================== PERMANENTLY PURGE SELECTED (2) ===================================] |
|  (Protected by Active Rundown Reference Check: Blocks purge if asset is cued or scheduled)        |
+---------------------------------------------------------------------------------------------------+
```

- **Soft-Delete Stage**: Trashed assets are marked `is_trashed = 1` and hidden from the library grid while physical files remain safe on disk.
- **Reference-Check Guard**: If an operator attempts to purge a file referenced by an active or scheduled rundown, the operation is blocked with a descriptive warning.
- **Pulsing Confirmation Alert**: The permanent purge button pulses with a warning outline requiring explicit operator confirmation.

---

### 4.6 Blackmagic DeckLink Live Rebroadcast Wizard (`DeckLinkWizard.vue`)

Facilitates live studio and external SDI/HDMI feed integration:
- **Card Discovery**: Probes installed Blackmagic DeckLink hardware (e.g. DeckLink Duo 2, Quad 2, Mini Recorder).
- **Signal Format Locking**: Sets video mode (1080p25, 1080i50, 1080p29.97, 720p50) and audio channel pair routing.
- **Live Rundown Take**: Injects a live input event onto CasparCG Layer 20, cleanly blanking video Layer 10 while maintaining branding graphics (Layer 30) and compliance overlays.

---

## 5. Keyboard Architecture & Focus Routing Engine

PlayOutVue implements a **Singleton Global Capture-Phase Keyboard Router** (`useOperatorShortcuts.ts`) mounted exclusively once in `App.vue`.

```
+---------------------------------------------------------------------------------------------------+
| KEYBOARD SCOPE PRIORITY HIERARCHY (Top to Bottom)                                                 |
+---------------------------------------------------------------------------------------------------+
| 1. [MODAL] (Recycle Bin, DeckLink Wizard, Settings Modal) -> Traps Escape / Enter                 |
| 2. [COMMAND PALETTE] (<Ctrl+K>) -> Fuzzy action navigation                                        |
| 3. [CONTEXT MENU] -> Dropdown navigation                                                          |
| 4. [TEXT INPUT] (<input>, <textarea>, [contenteditable]) -> Native typing & editing bypass        |
| 5. [TRIMMER] (MediaInspector) -> In/Out point setters ('[', ']'), Frame step (Left/Right)         |
| 6. [RUNDOWN] (RundownList) -> Row selection, Take (Enter/Space), Reorder (<Ctrl+Up/Down>)         |
| 7. [LIBRARY] (MediaLibrary) -> Append (F8), Prepend (Shift+F8), Delete (Trash)                    |
| 8. [GLOBAL] -> Palette (<Ctrl+K>), Undo (<Ctrl+Z>), Redo (<Ctrl+Y>), Toggle Theme                 |
+---------------------------------------------------------------------------------------------------+
```

### Keyboard Shortcuts Reference Matrix

| Shortcut | Scope Priority | Target Subsystem | Action Executed |
|---|---|---|---|
| <kbd>Enter</kbd> / <kbd>Space</kbd> | `rundown` | Playout Engine | **Take / Play** currently selected rundown row |
| <kbd>F8</kbd> | `library` | Media Library | **Append** selected library clips after active row |
| <kbd>Shift</kbd> + <kbd>F8</kbd> | `library` | Media Library | **Prepend** selected clips before active row |
| <kbd>Ctrl</kbd> + <kbd>↑</kbd> | `rundown` | Rundown Grid | Move selected row(s) **Up** |
| <kbd>Ctrl</kbd> + <kbd>↓</kbd> | `rundown` | Rundown Grid | Move selected row(s) **Down** |
| <kbd>Shift</kbd> + <kbd>↓</kbd> | `rundown` | Rundown Grid | **Duplicate** selected rundown row |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | `rundown` / `library` | Global | Remove from rundown / Move library asset to Trash |
| <kbd>[</kbd> | `trimmer` | Media Inspector | Set **Trim In** point to current playhead |
| <kbd>]</kbd> | `trimmer` | Media Inspector | Set **Trim Out** point to current playhead |
| <kbd>←</kbd> / <kbd>→</kbd> | `trimmer` | Media Inspector | Step playhead **-1 frame** / **+1 frame** |
| <kbd>Shift</kbd> + <kbd>←</kbd> / <kbd>→</kbd> | `trimmer` | Media Inspector | Step playhead **-1 second** / **+1 second** |
| <kbd>Ctrl</kbd> + <kbd>Z</kbd> | `global` | Rundown Store | **Undo** last playlist mutation |
| <kbd>Ctrl</kbd> + <kbd>Y</kbd> | `global` | Rundown Store | **Redo** last undone mutation |
| <kbd>Ctrl</kbd> + <kbd>K</kbd> | `global` | Command Palette | Open quick search command palette |
| <kbd>Escape</kbd> | `modal` / `global` | Overlay Manager | Close active modal, palette, or inspector |

---

## 6. PlayoutTranscode: Web-UI & Database Explorer Architecture

The upstream `PlayoutTranscode` service includes a built-in Vue 3 monitoring dashboard served directly by the Axum HTTP daemon on port `4353` (`src/server.rs` and `web-ui/`).

```
+---------------------------------------------------------------------------------------------------+
| PLAYOUTTRANSCODE WEB DASHBOARD & DATABASE EXPLORER (:4353)                                        |
+---------------------------------------------------------------------------------------------------+
| [TOP BAR] PlayoutTranscode Service | Uptime: 4d 12h | CPU: 14% | FFmpeg: OK | Watch: D:/Media/Ingest|
+---------------------------------------------------------------------------------------------------+
| ACTIVE INGEST & TRANSCODE QUEUE (SSE Real-Time Feed)                                              |
| +-----------------------------------------------------------------------------------------------+ |
| | Commercial_Spot_B.mov  [Profile A - 1080p]  [================== 68% =================>] 2.4x | |
| | Speed: 60.2 fps | ETA: 8s | Audio: EBU R128 (-23.1 LUFS) | Staging: .tmp_4c6d328b_spot.mp4    | |
| +-----------------------------------------------------------------------------------------------+ |
|                                                                                                   |
| RECENT JOBS & FAILURE LOGS                                                                        |
| +-----------------------------------------------------------------------------------------------+ |
| | ✅ Movie_Trailer_PAL.mp4     Completed in 42s    1080p25 CFR (Closed GOP: 50f) [REGEN SIDECAR]| |
| | ❌ Corrupt_Archive_SD.avi     Failed (Moov atom missing)                [ VIEW LOG ] [ RETRY ]| |
| +-----------------------------------------------------------------------------------------------+ |
|                                                                                                   |
| [EMBEDDED SQLITE DATABASE VIEWER (/api/db/overview)]                                              |
| - Table `assets`: 1,420 rows | Table `jobs`: 3,890 rows | Table `folders`: 18 rows                |
| - Schema inspector & direct SQL query diagnostic console                                          |
+---------------------------------------------------------------------------------------------------+
```

### Key Capabilities of the Web Dashboard:
1. **Real-Time SSE Event Stream (`useEventStream.ts`)**: Connects to `/api/events` and dynamically updates job progress bars, transcode FPS rates, and completion toasts without polling.
2. **One-Click Error Triage**: Failed jobs expose expandable FFmpeg stderr logs and an instant `[ RETRY ]` action button (`POST /api/jobs/{id}/retry`).
3. **Database Explorer (`DbViewer.vue`)**: Full read-only browser for the underlying SQLite `media_assets.db`, allowing engineers to inspect raw rows, JSON sidecar sync states, and folder hierarchies directly from a web browser.

---

## 7. State Management & Data Flow Architecture

PlayOutVue uses **Pinia** stores with strict domain boundaries:

```
+---------------------------------------------------------------------------------------------------+
| PINIA STATE LAYER TOPOLOGY                                                                        |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|   +-----------------------+     +-----------------------+     +-----------------------+           |
|   |     rundown.ts        |     |    mediaLibrary.ts    |     |      settings.ts      |           |
|   +-----------------------+     +-----------------------+     +-----------------------+           |
|   | - items: RundownItem[]|     | - assets: Asset[]     |     | - casparHost / ports  |           |
|   | - activeIndex: number |     | - folders: Folder[]   |     | - uiScale: 'standard' |           |
|   | - selectedIds: Set    |     | - folderColors: Map   |     | - theme: 'dark-mcr'   |           |
|   | - isLocked: boolean   |     | - currentFolderId     |     | - qcSensitivity       |           |
|   | - history: Snapshot[] |     | - searchFilter        |     | - autoAdvanceDelay    |           |
|   +-----------------------+     +-----------------------+     +-----------------------+           |
|               |                             |                             |                       |
|               v                             v                             v                       |
|   +-----------------------------------------------------------------------------------+           |
|   |                             LOCAL STORAGE & PERSISTENCE                           |           |
|   |   (pinia-plugin-persistedstate: Saves playlists, settings, and UI themes across)  |           |
|   +-----------------------------------------------------------------------------------+           |
+---------------------------------------------------------------------------------------------------+
```

---

## 8. Summary & Architectural Credits

- **Application Suite Architect**: **[Soranokuni](https://github.com/Soranokuni)** (Alex Fountas)
- **Email Contact**: [shadowsora13@hotmail.gr](mailto:shadowsora13@hotmail.gr)
- **Repositories**:
  - [https://github.com/Soranokuni/PlayOutVue](https://github.com/Soranokuni/PlayOutVue)
  - [https://github.com/Soranokuni/PlayoutTranscode](https://github.com/Soranokuni/PlayoutTranscode)
- **License**: MIT License
