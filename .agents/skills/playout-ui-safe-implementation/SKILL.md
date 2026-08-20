---
name: playout-ui-safe-implementation
description: Operational workflow, design tokens, and safety checklists for UI modifications in PlayOutVue while enforcing playback isolation, UI scaling, and contract boundaries.
---

# Safe UI Implementation Workflow & Checklist

Use this skill whenever making UI modifications to PlayOutVue. All architectural rules in [`docs/OPERATOR-UI-CONTRACT.md`](file:///d:/PlayOut/docs/OPERATOR-UI-CONTRACT.md) are strictly enforced.

---

## 1. Inspect Phase (Before Editing)

- **Inspect Context & Callers**: Read target components, composables, stores, and styles to understand current data flow and DOM structure.
- **Define Slice Boundary**:
  - Explicit goal and PR slice number (PR1 to PR7, or designated maintenance slice).
  - Items in scope vs out of scope.
  - Allowed files to change.
  - **Protected Files (MUST REMAIN UNTOUCHED)**:
    ```text
    src/services/playout.ts
    src/services/caspar.ts
    src/lib/playbackCoordinator.ts
    src/lib/playoutDispatch.ts
    src/lib/playoutFailurePolicy.ts
    src-tauri/src/amcp.rs
    src-tauri/src/caspar.rs
    ```
- **Verify Playback Isolation**: Confirm no UI command or action invokes `playFromIndex`, `playItemAt`, `advanceNext`, `dispatchPlay`, `dispatchLoadbg`, or `rundown.takeSelected`.

---

## 2. Design System, Theming & UI Scaling Rules

- **Semantic Theme Tokens**:
  - Never use hardcoded background/text hex colors (e.g. `#ffffff`, `#000000`, `rgba(255,255,255,...)`) in component styles.
  - All surfaces, typography, and borders must reference semantic CSS custom properties:
    `var(--color-bg-base)`, `var(--color-surface-panel)`, `var(--color-surface-elevated)`, `var(--color-text-primary)`, `var(--color-text-secondary)`, `var(--color-text-muted)`, `var(--color-border-subtle)`.
  - Maintain WCAG AAA contrast for all critical broadcast telemetry and text.
- **Dynamic UI Scaling**:
  - Components must respond to the `html[data-ui-scale="standard|comfortable|large"]` engine.
  - Utilize scaling tokens: `--row-h-rundown`, `--row-h-library`, `--btn-h-compact`, `--btn-h-standard`, `--font-size-base`, `--timecode-font-size`.
- **Zero-Jitter Numerals**:
  - Duration, countdown, timecode, and frame counter readouts must enforce `font-variant-numeric: tabular-nums` or use monospaced typography stacks.

---

## 3. Implementation & Keyboard Safety Rules

- **Singleton Keyboard Listener**:
  - Global capture-phase `keydown` listener mounted ONCE in `App.vue`.
  - Enforce listener idempotence (`shortcutsMounted` flag).
- **DOM Focus Scope**:
  - Use `data-command-scope` attributes on DOM containers (`rundown`, `library`, `trimmer`, `command-palette`, `modal`).
  - Classify active scope using `document.activeElement`.
- **Native Text Input Bypass**:
  - Retain native typing, cursor navigation, copy/paste (`Ctrl+C/V/X`), and undo/redo (`Ctrl+Z/Y`) inside `INPUT`, `TEXTAREA`, `SELECT`, and contenteditable elements.
- **UUID Identity**:
  - Item selection, focus, and mutations MUST be UUID-based. Never use array index as item identity.
- **Deterministic Drag & Reorder**:
  - Calculate proposed moves first (`calculateMove`).
  - Call `saveUndoSnapshot()` ONLY if `result.changed === true`.
  - Treat missing, stale, deleted, or moving-item drag targets as no-op (`changed: false, reason: 'invalid-target'`). Never fallback to append.
- **Rational FPS & Contract Boundary**:
  - Keep rational FPS (`fps_num / fps_den`) and absolute millisecond trims (`trim_in_ms`, `trim_out_ms`, `duration_ms`). Never use floating-point approximations for frame calculations.

---

## 4. Testing & Isolation Requirements

- **Real DOM Keyboard Testing**:
  - Test keyboard routing in `happy-dom` / `jsdom` using real DOM elements with `data-command-scope`, real `.focus()`, and `window.dispatchEvent(new KeyboardEvent('keydown', ...))`.
  - Assert `event.defaultPrevented === true` and verify focus scope bypasses.
- **Tauri IPC & Component Mocking**:
  - Mock Tauri IPC calls (`list_ingestor_assets`, `get_probe_status`) when mounting components in tests.
  - Stub `<Teleport>` when mounting modals in unit tests.
- **Annotate Test Helpers**:
  - Mark any exported test reset helpers with:
    ```ts
    /** @internal Test-only reset helper. Never call from production application code. */
    ```

---

## 5. Verification Gate & Stop Protocol

Always execute all verification checks before declaring completion:

```bash
npm test -- --run
npm run type-check
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```
*(Run `cargo test --test contract_boundary` in `PlayoutTranscode` if asset, trim, or contract fields are modified).*

**Reporting & Gate**:
Report changed files, confirm protected files remained untouched, report test suite and build status, and **STOP**. Do not expand scope or jump to subsequent slices without explicit approval.
