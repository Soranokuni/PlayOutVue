# AGENTS.md — PlayOutVue

## Active Skills & Workflow

Coordinate all implementations through `.agents/skills/`:
- **`broadcast-rules`**: Review before modifying rundown state, timecodes, operator interfaces, compliance graphics, or IPC channels.
- **`verify-build`**: Dual-stack compilation, type-check, and test suite. Must pass with zero errors across both frontend and backend before completing a task.

---

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
  - In `src-tauri/src/caspar.rs`, `handle_playback_path_osc` MUST check `s.path_confirmed && now_mono >= s.auto_advance_not_before_ms` before firing `osc-path-switch`.
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

### 5. Operator Dialog Safety & CasparCG Configuration Invariants
- **Native Dialogs for Destructive Actions**: Never use browser-native `confirm()` or `alert()`. All destructive, server-control (Stop, Restart), or database purge actions must use `@tauri-apps/plugin-dialog` (`await ask(...)` / `await message(...)`) and strictly guard execution (`if (!confirmed) return;`).
- **Dynamic Config Pathing & XML Kebab-Case Parity**: Never default CasparCG config paths to static `C:/CasparCG/casparcg.config` or `C:/CasparCG/Media`. Always derive paths dynamically from `RuntimeSettingsState.casparcg_executable_path`. All parsers and Rust serde models must support CasparCG's native kebab-case XML tags (`media-path`, `video-mode`, `decklink`, `embedded-audio`) alongside camelCase/snake_case to preserve wizard settings.

---

## Development & Verification Checklist

Before declaring any task complete or staging git commits, execute the full `.agents/skills/verify-build` pipeline:
1. `npm test -- --run` (Must pass all 270+ frontend unit and integration tests; `npm run lint` must report 0 errors)
2. `npm run type-check` (Must pass with 0 TypeScript errors via `vue-tsc --build`); `npm run lint` (ESLint, 0 errors)
3. `npm run build` (Must produce clean production client bundle in `dist/`)
4. `cargo check --manifest-path src-tauri/Cargo.toml` (Must compile cleanly with 0 errors)
5. `cargo test --manifest-path src-tauri/Cargo.toml` (Must pass all 120+ backend unit and integration tests; `cargo clippy --all-targets -- -D warnings` must also be clean)
6. `cargo test --manifest-path ../PlayoutTranscode/Cargo.toml --test contract_boundary` (Must verify cross-repo contract integrity whenever touching asset, trim, or metadata schemas)

---

## Git Hygiene & Task Completion

- **Zero-Tolerance Commit Gate**: Never commit or declare a task complete while `verify-build` has failing tests, build issues, or type errors.
- **Atomic Staging**: Stage only modified files within explicit task scope. Never stage temporary debug artifacts, crash dumps, or local log files.
- **Conventional Commits**: Format commit messages strictly with Conventional Commits syntax:
  - `feat(...)`: New user-facing or broadcast capabilities.
  - `fix(...)`: Bug fixes or timing gate corrections.
  - `refactor(...)`: Code adjustments that do not alter public behavior.
  - `test(...)`: Adding or updating test suites.
  - `chore(...)`: Maintenance, dependencies, or agent skill updates.
- **Origin Push**: Push to origin tracking branch upon task sign-off.
