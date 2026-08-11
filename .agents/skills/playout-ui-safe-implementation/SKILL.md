---
name: playout-ui-safe-implementation
description: Operational workflow and checklist for safe, incremental UI changes in PlayOutVue while enforcing playback isolation and contract rules.
---

# Safe UI Implementation Workflow & Checklist

Use this skill whenever making UI modifications to PlayOutVue. All rules in [`docs/OPERATOR-UI-CONTRACT.md`](file:///d:/PlayOut/docs/OPERATOR-UI-CONTRACT.md) are strictly enforced.

## 1. Before Editing (Inspect Phase)
- **Inspect Files**: Read existing components, composables, and stores to understand current behavior.
- **Define Slice Boundary**: State explicitly:
  - Goal & PR slice number (PR1 to PR7)
  - Items in scope vs out of scope
  - Files allowed to change
  - Protected files (`playout.ts`, `caspar.ts`, `playbackCoordinator.ts`, `playoutDispatch.ts`, `playoutFailurePolicy.ts`, `amcp.rs`, `caspar.rs`)
- **Check Playback Rules**: Verify that no UI command calls `playFromIndex`, `playItemAt`, `advanceNext`, `dispatchPlay`, or `rundown.takeSelected`.

## 2. During Implementation
- **Mount Listener Once**: Global capture-phase `keydown` listener mounted ONCE in `App.vue`. Enforce listener idempotence (`shortcutsMounted`).
- **DOM Focus Scope**: Use `data-command-scope` attributes on DOM containers. Classify scope using `document.activeElement`.
- **Text Input Bypass**: Retain native typing, cursor movement, copy/paste, and undo/redo inside `INPUT`, `TEXTAREA`, `SELECT`, and contenteditable elements.
- **UUID Identity**: Item selection and mutations MUST be UUID-based. Never use list index as item identity.
- **No-Op Undo Guard**: Calculate proposed moves first (`calculateMove`). Call `saveUndoSnapshot()` ONLY if `result.changed === true`.
- **Invalid Drag Target Guard**: Never treat a missing, stale, deleted, or moving-item drag target as append. Invalid targets must produce a no-op result (`changed: false`) and a diagnostic reason (`reason: 'invalid-target'`).
- **Structural Mutation Gate**: Ensure destructive or structural mutations verify current playlist revision, preserve on-air protections, and prompt for operator confirmation when necessary.

## 3. Testing Requirements
- **Real DOM Tests**: Use `happy-dom` / `jsdom` with real `window.dispatchEvent(new KeyboardEvent('keydown', ...))`. Assert `event.defaultPrevented === true` and verify focus scope bypasses.
- **Mark Test-Only Helpers**: Annotate any test reset helper with `/** @internal Test-only reset helper. Never call from production application code. */`.

## 4. Verification & Stop Gate
Run all verification commands before reporting:
```bash
npm test -- --run
npm run type-check
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```
*(Run `cargo test --test contract_boundary` if asset, trim, or contract fields are touched).*

Report changed files, protected files verified unchanged, test results, type-check status, build output, and **STOP**. Do not expand scope or proceed to the next PR slice automatically.
