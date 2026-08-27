# PlayOut (PlayOutVue)

[![Author](https://img.shields.io/badge/author-Soranokuni-blue.svg)](https://github.com/Soranokuni)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24c8db?logo=tauri&logoColor=white)](https://tauri.app/)
[![Vue 3](https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Rust](https://img.shields.io/badge/Rust-1.77%2B-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![CasparCG](https://img.shields.io/badge/CasparCG-2.3%2B-orange.svg)](https://casparcg.com/)
[![Blackmagic](https://img.shields.io/badge/Blackmagic-DeckLink-black.svg)](https://www.blackmagicdesign.com/)

**PlayOut** (PlayOutVue) is a Windows-first, broadcast-grade Master Control Room (MCR) playout automation controller developed by **[Soranokuni](https://github.com/Soranokuni)**. Engineered using **Vue 3, Vite, Tauri v2, and Rust**, PlayOut delivers deterministic, frame-accurate playout automation, non-destructive trimming, downstream keyer (DSK) graphics, Greek NCRTV compliance automation, and real-time CasparCG playback synchronization.

PlayOut operates in synergy with **[PlayoutTranscode](https://github.com/Soranokuni/PlayoutTranscode)** (its companion media ingestion engine) to ingest, validate, and broadcast frame-accurate progressive and interlaced mezzanine assets.

---

## System Architecture & Control Flow

The architecture decouples UI rendering from playout execution. Playout commands execute over AMCP to CasparCG, while real-time frame progress is tracked via an asynchronous UDP OSC feedback listener.

```mermaid
flowchart TB
    classDef ui fill:#1e293b,stroke:#3b82f6,stroke-width:2px,color:#f8fafc;
    classDef store fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#f8fafc;
    classDef tauri fill:#78350f,stroke:#f59e0b,stroke-width:2px,color:#f8fafc;
    classDef caspar fill:#311042,stroke:#a855f7,stroke-width:2px,color:#f8fafc;
    classDef transcode fill:#1e3a8a,stroke:#60a5fa,stroke-width:2px,color:#f8fafc;

    subgraph INGEST_ENGINE ["Upstream Ingestion Layer"]
        PT["PlayoutTranscode Service<br/>Port: 4353"]:::transcode
    end

    subgraph DESKTOP_UI ["PlayOutVue — Desktop Master Control (Vue 3 / TypeScript)"]
        direction TB
        AppView["MCR Workspace<br/>App.vue"]:::ui
        
        subgraph PANELS ["UI Panels & Views"]
            RL["RundownList.vue<br/>Playlist & Live Grid"]:::ui
            ML["MediaLibrary.vue<br/>Nested Virtual Folders"]:::ui
            MI["MediaInspector.vue<br/>Trim & Compliance Modal"]:::ui
            RB["RecycleBinModal.vue<br/>Soft-Delete & Safe Purge"]:::ui
            DW["DeckLinkWizard.vue<br/>SDI/HDMI Live Rebroadcast"]:::ui
        end

        subgraph STATE_LAYER ["Pinia State Management"]
            RundownStore[("Rundown Store<br/>Undo/Redo & Active Row")]:::store
            LibraryStore[("Media Library Store<br/>Tree Hierarchy & Filter")]:::store
            SettingsStore[("Settings Store<br/>Theme, QC & DSK Config")]:::store
            IngestStore[("Ingestor Status Store<br/>SSE Live Queue")]:::store
        end

        subgraph DISPATCH_ENGINE ["Playout Execution Core"]
            Coordinator["playbackCoordinator.ts<br/>Stale-Token Guard"]:::ui
            DispatchService["caspar.ts & playoutDispatch.ts<br/>Frame Trim Arithmetic"]:::ui
            EndGuard["endGuard.ts<br/>Gap Auto-Detector"]:::ui
        end
    end

    subgraph TAURI_BACKEND ["Tauri v2 Rust Core (src-tauri)"]
        direction TB
        IPC["Tauri IPC Router (lib.rs)"]:::tauri
        AMCPBridge["amcp.rs<br/>TCP 5250 Socket Pool"]:::tauri
        OSCListener["caspar.rs<br/>UDP 6250 OSC Tracker"]:::tauri
        MediaServer["media_server.rs<br/>Local HTTP Preview Server"]:::tauri
        LocalDB[("media_assets.db<br/>SQLite Local Cache")]:::tauri
        LocalScanner["scanner.rs & trimmer.rs<br/>Fallback Probe & FFmpeg Cut"]:::tauri
    end

    subgraph PLAYOUT_BACKEND ["CasparCG Broadcast Server"]
        CasparServer["CasparCG Server 2.3+<br/>AMCP Port: 5250 | OSC: 6250"]:::caspar
        DeckLinkOut["Blackmagic DeckLink<br/>SDI / HDMI Video Out"]:::caspar
    end

    %% Wiring
    PT -- "REST /api/assets & SSE /api/events" --> IngestStore
    PT -- "JSON Metadata Sidecar" --> LibraryStore

    AppView --> PANELS
    PANELS <--> STATE_LAYER
    
    RundownStore --> Coordinator --> DispatchService
    DispatchService -- "invoke('caspar_play_item')" --> IPC
    
    IPC --> AMCPBridge
    AMCPBridge -- "AMCP: PLAY, LOADBG, MIXER, CG" --> CasparServer
    CasparServer -- "UDP OSC Packets" --> OSCListener
    OSCListener -- "Tauri Event: osc-update" --> Coordinator
    
    IPC --> MediaServer
    MediaServer -- "HTTP Stream & Proxies" --> MI
    
    CasparServer --> DeckLinkOut
```

---

## CasparCG MCR Layer Stack

PlayOut enforces a strict, collision-free **8-layer channel registry** (`caspar_layers.rs` and `CASPAR_LAYERS` in TypeScript). Each producer type has documented lifecycles, mixer permissions, and automatic take/clear rules.

```mermaid
graph BT
    classDef base fill:#1e293b,stroke:#475569,stroke-width:1px,color:#fff;
    classDef video fill:#1e3a8a,stroke:#3b82f6,stroke-width:2px,color:#fff;
    classDef live fill:#065f46,stroke:#10b981,stroke-width:2px,color:#fff;
    classDef brand fill:#831843,stroke:#ec4899,stroke-width:2px,color:#fff;
    classDef cg fill:#701a75,stroke:#d946ef,stroke-width:2px,color:#fff;

    L10["Layer 10: Program Video (FFmpeg/Mezzanine Decoder)"]:::video
    L20["Layer 20: Live Ingest (DeckLink Live Rebroadcast)"]:::live
    L30["Layer 30: Station Logo (Persistent Brand Watermark)"]:::brand
    L31["Layer 31: Age Rating Badge (Greek NCRTV: K, 8, 12, 16, 18)"]:::brand
    L32["Layer 32: Explanation Banner (Timed HTML5/Flash CG Overlay)"]:::cg
    L33["Layer 33: On-Demand Crawl (Live Breaking News / Ticker)"]:::cg
    L34["Layer 34: Product Placement Badge (TP Overlay)"]:::brand
    L35["Layer 35: Station ID (Reserved for Station Stingers)"]:::base

    L10 --> L20 --> L30 --> L31 --> L32 --> L33 --> L34 --> L35
```

### Layer Specification Table

| Layer | Name | Producer Type | Lifecycle & Behavior | Supports `MIXER` |
|---|---|---|---|:---:|
| **10** | **Program Video** | FFmpeg Decoder | Item-level (`PLAY`, `LOADBG`, `CLEAR`). Cleared on manual live take. | ❌ (Raw) |
| **20** | **Live Input** | DeckLink Producer | Live item take (`PLAY 1-20 DECKLINK DEVICE 1`). Suppresses Layer 10. | ❌ (Raw) |
| **30** | **Station Logo** | Image (`PNG`/`SVG`) | Channel watermark; always-on; survives rundown item advances. | ✅ |
| **31** | **Age Rating** | Image (`PNG`) | Item-level; positioned per station profile (e.g. top-left / top-right). | ✅ |
| **32** | **Explanation** | CG Template | Timed advisory banner displayed during the first N seconds of a clip. | ❌ (Self-pos) |
| **33** | **Crawl Ticker** | CG Template | User-toggled breaking news ticker with live text/speed `CG UPDATE`. | ❌ (Self-pos) |
| **34** | **TP Badge** | Image (`PNG`) | Product Placement indicator; toggled per rundown item. | ✅ |
| **35** | **Station ID** | Reserved | Dedicated layer for animated channel identifiers. | ✅ |

> [!NOTE]
> **Mixer vs CG Template Rule**: `MIXER FILL` and `MIXER OPACITY` commands are strictly forbidden on CG template layers (Layers 32 and 33) to prevent squashing self-positioned HTML/Flash templates.

---

## Core Capabilities

### 1. Master Control Playout & Auto-Advance
- **Deterministic Frame Trim Arithmetic**: Accurately computes frame in/out points using broadcast rationals (e.g., `25/1` PAL, `30000/1001` NTSC) preventing A/V sync drift.
- **Stale-Token Playback Protection**: Dispatches commands with monotonic token tracking to ensure slow AMCP socket responses never override an operator's manual Take.
- **Continuous Auto-Advance & Gap Guard**: Automatically transitions between rundown items via OSC frame milestones and arms visual gap warnings for missing media.
- **Undo / Redo Serialization**: Full snapshot history for rundown editing, reordering, duplicate, and delete operations.

### 2. Greek NCRTV Compliance & Graphics Engine
- **NCRTV Rating System**: Native support for statutory age categories:
  - `K` (Suitable for all)
  - `8` (Suitable for ages 8+)
  - `12` (Suitable for ages 12+)
  - `16` (Suitable for ages 16+)
  - `18` (Prohibited for minors)
  - `TP` (Product Placement warning)
- **Automated Advisory Timelines**: Displays regulatory explanation banners during the required start-of-program window before auto-fading.
- **Live Crawl Ticker**: Real-time ticker with adjustable speed, instant text updates, and emergency override capabilities.

### 3. Media Library & Virtual Tree Management
- **Nested Virtual Folders**: Organize thousands of assets into arbitrary-depth directory trees without moving physical files on disk.
- **Folders-on-Top Sorting & Tree Guides**: Clean visual hierarchy with subtle guide lines and quick folder-picker dialogs.
- **Batch Actions & Multi-Select**: Select multiple media files with `Shift` or `Ctrl`, and append them consecutively into the rundown via `F8` or `Shift+F8`.

### 4. Recycle Bin & Reference-Protected Purge
- **Soft-Delete Lifecycle**: Deleted media moves to a protected Recycle Bin stage.
- **Reference-Check Protection**: Prevents purging files currently queued in any active or scheduled rundown.
- **Pulsing Safety Alert**: Visual confirmation barrier with auto-purge timers to prevent accidental physical data loss.

### 5. Local Media Server & Streaming Preview
- Built-in Rust HTTP server (`media_server.rs`) streams media directly into the browser/Vue UI.
- Automatically generates on-the-fly FFmpeg proxy video for mezzanine codecs not natively decodable by Chromium/WebKit.

---

## Keyboard Shortcuts & Operator Controls

| Shortcut | Action | Scope |
|---|---|---|
| <kbd>Enter</kbd> / <kbd>Space</kbd> | **Take / Play** selected rundown row immediately | Rundown |
| <kbd>F8</kbd> | **Append** selected library item(s) after the active playing row | Media Library |
| <kbd>Shift</kbd> + <kbd>F8</kbd> | **Prepend / Insert** selected item(s) directly before the active row | Media Library |
| <kbd>Ctrl</kbd> + <kbd>↑</kbd> | Move selected rundown item(s) **Up** | Rundown |
| <kbd>Ctrl</kbd> + <kbd>↓</kbd> | Move selected rundown item(s) **Down** | Rundown |
| <kbd>Shift</kbd> + <kbd>↓</kbd> | **Duplicate** selected rundown row | Rundown |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | **Remove** item from rundown / Move library asset to Recycle Bin | Global |
| <kbd>Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Ctrl</kbd> + <kbd>Y</kbd> | **Undo** / **Redo** last rundown modification | Rundown |
| <kbd>Ctrl</kbd> + <kbd>K</kbd> | Open **Quick Command Palette** | Global |

---

## Directory Structure

```text
PlayOut/
├── src/                          # Vue 3 Frontend
│   ├── assets/                   # CSS styles, SVGs, and HTML5 CG templates
│   ├── components/               # UI Components (RundownList, MediaLibrary, Inspector, etc.)
│   ├── composables/              # Reusable state & keyboard routing hooks
│   ├── lib/                      # Pure business logic (frameMath, compliance, dispatch)
│   ├── services/                 # Hardware & Playout services (caspar.ts, obs.ts)
│   ├── stores/                   # Pinia Stores (rundown, mediaLibrary, settings, ingest)
│   └── utils/                    # Timecode formatters, API clients
├── src-tauri/                    # Tauri v2 Desktop Core (Rust)
│   ├── src/
│   │   ├── amcp.rs               # CasparCG TCP AMCP Command Protocol
│   │   ├── caspar.rs             # OSC Feedback UDP Server & State Tracking
│   │   ├── caspar_layers.rs      # Single-Source-of-Truth Layer Registry
│   │   ├── media_server.rs       # Local HTTP Streaming & Proxy Generator
│   │   ├── ingestor_api.rs       # PlayoutTranscode REST/SSE Client Bridge
│   │   ├── scanner.rs            # Filesystem Scanner & Fallback Metadata Probe
│   │   └── trimmer.rs            # FFmpeg Extraction & Lossless Trimmer
│   └── tauri.conf.json           # Application manifest, windows, security CSP
└── docs/                         # Operational contracts and test specifications
```

---

## Development & Build Setup

### Prerequisites
1. **Node.js**: `^20.19.0 || >=22.12.0`
2. **Rust**: `1.77.2+` with `rustup`
3. **Microsoft C++ Build Tools**: Visual Studio 2022 C++ x64/x86 build tools
4. **CasparCG Server**: Version 2.3+ (installed locally or reachable over the local network)
5. **PlayoutTranscode**: Ingest service running on port `4353`

### 1. Install Dependencies
```powershell
npm install
```

### 2. Run in Development Mode
Launch the complete desktop application with hot-reloading:
```powershell
npm run tauri dev
```

Run frontend in browser-only mode:
```powershell
npm run dev
```

### 3. Run Automated Tests
```powershell
npm run test
```

### 4. Build Production Installer
```powershell
npm run tauri build
```
The installer executable (`.msi` / `.exe`) will be generated in `src-tauri/target/release/bundle/`.

---

## Author & Project Information

- **Author**: **[Soranokuni](https://github.com/Soranokuni)** (Alex Fountas)
- **Email**: [shadowsora13@hotmail.gr](mailto:shadowsora13@hotmail.gr)
- **Repository**: [https://github.com/Soranokuni/PlayOutVue](https://github.com/Soranokuni/PlayOutVue)

---

## License

This project is licensed under the **MIT License**.
