---
name: broadcast-rules
description: Critical broadcast automation invariants, protected playback boundaries, rational frame arithmetic, Greek compliance graphics, and operator UI safety rules. Review before modifying rundown state, timecodes, operator interfaces, or IPC channels.
---

# Broadcast Playout & Operator Safety Rules (`broadcast-rules`)

This skill codifies the immutable broadcast engineering invariants, protected engine boundaries, and operator safety rules for PlayOutVue. All developers and agents must adhere strictly to these rules.

---

## 1. Protected Core (Strict Read-Only for Routine Work)

The playback orchestration, dispatch pipeline, and Rust AMCP/OSC transport files are protected core subsystems:

```text
src/services/playout.ts            # Playout service abstraction & advance listener dispatch
src/services/caspar.ts             # CasparCG AMCP command client & OSC event handling
src/lib/playbackCoordinator.ts     # Pure reducer: dual-ID fencing, generation bumping, UUID authority
src/lib/playoutDispatch.ts         # AMCP command formation & hardware preload dispatch
src/lib/playoutFailurePolicy.ts    # Retry, recovery, and fallback state machine
src-tauri/src/amcp.rs              # Rust TCP AMCP framed response parser (200/201/202)
src-tauri/src/caspar.rs            # Rust OSC UDP listener, watchdog, timing gate & advance emitter
```

### Protection Protocol:
- **Strict Read-Only**: UI, styling, and general feature tasks must **NEVER** edit these files.
- **Approval & Test Barrier**: Any intentional playback modification requires explicit approval and must pass unit tests in `src/lib/__tests__/playbackCoordinator.test.ts`, `src/services/__tests__/casparProcess.test.ts`, and `src-tauri/Cargo.toml`.

---

## 2. Playback Engine Isolation & Hardware Pipeline

### PlaybackCoordinator Authority (No Direct AMCP Calls):
- UI components, dialogs, command palettes, and Pinia stores must **NEVER bypass `PlaybackCoordinator`** to trigger AMCP commands (`dispatchPlay`, `dispatchLoadbg`, `playFromIndex`, or `takeSelected`).
- **Take Initiation Flow**:
  1. All takes invoke `PlaybackCoordinator.initiateTake(request, items)`.
  2. Resolves target strictly by immutable UUID.
  3. Increments monotonic `playGeneration` and mints a unique `takeId`.
  4. Cancels prior in-flight tasks via `AbortController`.
  5. Transitions mode to `'taking'`.
- **Take Confirmation & Auto-Advance**:
  1. On AMCP confirmation, `confirmTake()` mints `playbackInstanceId`, sets `mode = 'playing'`, and pre-calculates the next eligible UUID.
  2. `evaluateAutoAdvance()` verifies the `(generation, playbackInstanceId, itemId)` triple match before permitting an auto-advance. Stale or mismatched events are dropped.

### Zero-Latency Hardware Transitions (`LOADBG ... AUTO`):
- Playout uses CasparCG's native background buffer:
  ```text
  LOADBG <channel>-<layer> <path> [SEEK <in>] [LENGTH <len>] AUTO
  ```
- When the on-air clip reaches EOF, CasparCG's hardware mixer cuts gaplessly to the preloaded clip.
- **Never Interfere with Hardware Preloads**: Once `LOADBG ... AUTO` is issued, do NOT issue artificial polling or verification timers (e.g., `confirmAndRepairForeground` or polling `INFO 1-10`) that re-issue `PLAY`. Re-issuing `PLAY` while a clip is playing will restart it and destroy the preloaded background video buffer.

### Rust Backend Single Advance Decision Ownership:
- `src-tauri/src/caspar.rs` receives OSC UDP packets (`/channel/1/stage/layer/10/file/time` and `/file/path`).
- Enforces the monotonic timing gate: `now_monotonic >= auto_advance_not_before_ms` to prevent premature advance on short subclips or same-file transitions.
- Emits a single authoritative `caspar://advance` event.
- Built-in watchdog (`spawn_playback_watchdog`) monitors OSC stalls and emits `caspar://stalled` to prevent rundown freezes.

---

## 3. Data Identity & Rational Frame Boundaries

### UUID Identity Invariant:
- All rundown items and library assets must use **immutable UUIDs** (`id` / `playoutvueId`) for selection, targeting, and mutation.
- **NEVER key or mutate by array index**. Array indexes are transient render/navigation offsets only.

### Pure Rational FPS:
- Frame rates must remain exact rational integers:
  - `fps_num`: Rational numerator (e.g., `25`, `30000`, `50`)
  - `fps_den`: Rational denominator (e.g., `1`, `1001`, `1`)
- **Strict Ban on Floating-Point FPS Math**: Do NOT calculate frame points using `Math.round(seconds * 29.97)`. Use exact rational arithmetic via `src/lib/timecode.ts`.

### Integer Millisecond Trim Arithmetic:
- `trim_in_ms`, `trim_out_ms`, and `duration_ms` must be exact non-negative integer milliseconds from the file start:
  - `trim_in_ms >= 0`
  - `trim_out_ms > trim_in_ms && trim_out_ms <= duration_ms`
- Frame conversions use:
  ```ts
  Math.floor((ms * fps_num) / (1000 * fps_den))
  ```

---

## 4. Greek Compliance Graphics Pipeline (NCRTV / ESR)

- **Dedicated Layer**: Layer 32 (`CG 1-32 ADD 1 "playout/advisory" 1 "{...}"`).
- **Deterministic Refresh**: Always clear layer 32 before adding a new template payload (`CLEAR 1-32` followed by `CG 1-32 ADD 1 ...`).
- **Badge vs Explanation**:
  - **Corner Rating Badge** (`K`, `8`, `12`, `16`, `18`): Stays on-screen permanently during playback.
  - **Explanation Box**: Slides out with advisory text and high-contrast SVG warning glyphs, displays for **30 seconds**, and smoothly animates out.

---

## 5. UI Ergonomics & Design Tokens

- **Semantic Tokens Only**: Ban hardcoded hex/rgb colors (`#fff`, `#000`, `rgba(...)`). Use CSS custom properties:
  `var(--color-bg-base)`, `var(--color-surface-panel)`, `var(--color-surface-elevated)`, `var(--color-text-primary)`, `var(--color-text-secondary)`, `var(--color-text-muted)`, `var(--color-border-subtle)`.
- **Zero-Jitter Readouts**: Enforce `font-variant-numeric: tabular-nums` or monospaced font stacks on all timecodes, clocks, durations, and countdowns.
- **Dynamic UI Scaling**: Honor `html[data-ui-scale="standard|comfortable|large"]` tokens (`--row-h-rundown`, `--btn-h-standard`, `--font-size-base`).

---

## 6. Keyboard Architecture & Focus Scoping

- **Singleton Listener**: Single capture-phase `keydown` listener mounted once in `App.vue` with `shortcutsMounted` idempotence flag.
- **Scope Hierarchy**:
  ```text
  modal > command-palette > context-menu > text-input > trimmer > rundown > library > global
  ```
- **Native Input Bypass**: Retain native typing, cursor navigation, copy/paste, and undo inside `INPUT`, `TEXTAREA`, `SELECT`. Hotkeys must automatically bypass when focus is inside native text controls.
- **Take Prohibition**: `Enter` and `Space` must **NEVER** trigger Take.

---

## 7. Playlist Mutation & Drag-and-Drop Safety

- **Pinia State Authority**: Pinia owns rundown order; SortableJS is purely transient visual pointer feedback.
- **Deterministic Move Calculation**:
  - Semantic targets: `{ kind: 'before'; targetItemId: string } | { kind: 'after'; targetItemId: string } | { kind: 'append' }`.
  - Invalid drag targets return no-op (`changed: false, reason: 'invalid-target'`). Never fallback silently to append.
- **Atomic Undo**: Call `saveUndoSnapshot()` strictly once, and only when `result.changed === true`.

---

## 8. Operator Dialog Safety & Confirmation Invariants

- **Ban on Browser `confirm()` / `alert()`**: Standard JavaScript `window.confirm()` and `alert()` in Tauri's Webview2 runtime on Windows do NOT reliably halt IPC event dispatch or asynchronous microtasks. Destructive, hardware-interrupting, or irreversible actions must NEVER use browser-native dialogs.
- **Tauri Dialog API Requirement**: Always use `@tauri-apps/plugin-dialog` (`ask`, `message`):
  ```ts
  import { ask, message } from '@tauri-apps/plugin-dialog';

  const confirmed = await ask('Are you sure you want to stop the CasparCG server?', {
    title: 'Stop CasparCG Server',
    kind: 'warning'
  });
  if (!confirmed) return;
  ```
- **Strict Guard Placement**: The action logic must strictly reside after `if (!confirmed) return;`.

---

## 9. CasparCG Configuration Resolution & Schema Fidelity

- **Dynamic Path Derivation**:
  - Never hardcode static paths like `C:/CASPARCG/CASPARCG.CONFIG` or `C:/CasparCG/Media` as unconditional defaults.
  - Always derive CasparCG config, media, log, and template paths dynamically from the active runtime settings (`casparcg_executable_path`) or detected server directory.
- **Kebab-Case XML Schema Parity**:
  - CasparCG configuration files use standard XML kebab-case tags (`<media-path>`, `<log-path>`, `<video-mode>`, `<decklink>`, `<system-audio>`, `<key-device>`, `<embedded-audio>`).
  - Rust serde models must declare `#[serde(alias = "...")]` to accept kebab-case, snake_case, and camelCase.
  - Frontend mapping functions must check kebab-case keys first before falling back to camelCase or defaults to ensure wizard-configured paths are accurately hydrated.
- **Modal Lifecycle Initialization**:
  - When configurators or modal dialogs are conditionally mounted via `v-if`, any watcher on `props.isOpen` must specify `{ immediate: true }` so initialization runs reliably upon mount.

---

## 10. Actionable Pre-Implementation & Verification Checklist

Before touching any code in PlayOutVue, verify:

- [ ] **Protected Boundaries**: Are any of the 7 protected core files in my modification plan? (If yes, obtain explicit user confirmation first).
- [ ] **Playback Routing**: Does any UI element or store action invoke `dispatchPlay`, `dispatchLoadbg`, or `playFromIndex`? (Must route exclusively through `PlaybackCoordinator`).
- [ ] **Identity & Frame Math**: Are all item lookups by UUID? Are all FPS calculations rational integers (`fps_num / fps_den`)? Are all trims integer ms?
- [ ] **Design Tokens**: Are all new styles free of hardcoded hex colors? Are all numbers formatted with `tabular-nums`?
- [ ] **Dialog Safety**: Do all operator confirmation prompts use `@tauri-apps/plugin-dialog` (`await ask(...)`) instead of browser `confirm()`?
- [ ] **Caspar Config & Paths**: Are all Caspar paths derived dynamically from runtime settings rather than hardcoded `C:/CasparCG` strings?
- [ ] **Verification Gate**: Does the change pass the complete `.agents/skills/verify-build` suite (`npm test -- --run`, `npm run type-check`, `npm run build`, `cargo check`, `cargo test`)?

