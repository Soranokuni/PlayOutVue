# AGENTS.md — PlayOutVue

## Core Architectural Invariants

### 1. Playout & Transition Pipeline (CasparCG AMCP + OSC)
- **Zero-Latency Hardware Transitions**: Playout uses CasparCG's native background buffer via `LOADBG <channel>-<layer> <path> [SEEK <in>] [LENGTH <len>] AUTO`. When the on-air clip reaches EOF, CasparCG's hardware mixer cuts gaplessly to the preloaded clip.
- **Single Advance Decision Ownership**:
  - Rust backend (`src-tauri/src/caspar.rs`) receives OSC UDP messages from CasparCG (`/channel/1/stage/layer/10/file/time` and `/file/path`).
  - Rust computes position against `trim_in_ms`, checks the monotonic timing gate (`auto_advance_not_before_ms`), and emits a single, authoritative `caspar://advance` event.
  - Rust emits throttled `caspar://playback-tick` events to drive UI timers.
  - The frontend `caspar://advance` event listener in `src/services/caspar.ts` must dispatch directly to `advanceNext(true, uuid)`.

### 2. Guarding Against Premature Advances & Skips
- **Monotonic Timing Gate Invariant**:
  - No clip may trigger an `osc-position` or `osc-path-switch` advance before its monotonic duration gate has elapsed (`now_monotonic >= auto_advance_not_before_ms`).
  - In `src-tauri/src/caspar.rs`, `handle_path_osc` MUST check `s.path_confirmed && now_mono >= s.auto_advance_not_before_ms` before firing `osc-path-switch`.
- **Synchronous Key Claiming Invariant**:
  - Whenever a manual `take()` or `playItemAt()` is called, `currentKey` MUST be set synchronously before any async await calls.
  - The `caspar://advance` listener MUST enforce `currentKey && uuid && uuid === currentKey`. Any in-flight advance event from a previously playing clip carrying a different UUID must be dropped immediately.
- **Never Interfere with Native Hardware Preloads**:
  - Once `LOADBG ... AUTO` is issued, DO NOT issue artificial verification timers (e.g. `confirmAndRepairForeground` or polling `INFO 1-10`) that re-issue `PLAY` commands. Re-issuing `PLAY` while a clip is playing will restart it and destroy the preloaded background video buffer.

### 3. Rundown On-Air State & Compliance Graphics Synchronization
- On every advance (`playItemAt`, `take`, or `advanceToNext`):
  - `onAdvanceCallback?.(key)` MUST be called to update `store.setOnAirPlayingItemById(uuid)` and highlight the active playing row in `RundownList.vue`.
  - `await casparPlayoutService.applyComplianceForItem?.(item)` MUST be called to update Greek compliance graphics on Layer 32.
  - `preloadNextItemAt(nextIndex + 1)` MUST be called to arm the subsequent clip via `LOADBG ... AUTO`.

### 4. Greek Compliance Graphics (NCRTV / ESR Pipeline)
- **Layer**: Layer 32 (`CG 1-32 ADD 1 "playout/advisory" 1 "{...}"`).
- **Template**: `public/templates/playout/advisory.html` & `src/assets/templates/playout/advisory.html`.
- **Badge Behavior**: Corner rating badge (`K`, `8`, `12`, `16`, `18`) remains on-screen continuously during playback.
- **Explanation Box**: Slides out with the advisory text and high-contrast SVG warning glyphs (violence, substances, sex, language, shield combo), remains visible for 30 seconds, and then smoothly animates out.
- **Deterministic Refresh**: Always clear layer 32 before adding the new template payload (`CLEAR 1-32` followed by `CG 1-32 ADD 1 ...`).

## Development & Verification Checklist

Before committing any changes to the playout engine:
1. `npm run type-check` (Must pass with 0 errors)
2. `npm test -- --run` (Must pass all test suites)
3. `cargo check --manifest-path src-tauri/Cargo.toml` (Must compile cleanly)
4. `cargo test --test contract_boundary` in `d:\PlayoutTranscode` (Must verify cross-repo contract integrity)
