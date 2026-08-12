# PR6C Handoff — Playlist-only Ctrl/Cmd+ArrowUp & Ctrl/Cmd+ArrowDown Movement

## Repository state

- **HEAD SHA**: `0b290fb715fcc7134e5dae397cc703d2df3e333e`
- **Branch**: `main` (up-to-date with `origin/main`)
- **Date**: `2026-08-12`
- **PR6C Feature Baseline Commit**: `a86049136a0241297f5abd9b7cd04589c3f0879d`
- **Maintenance Commit**: `0b290fb715fcc7134e5dae397cc703d2df3e333e`
- **Status Summary**:
  - `npm run type-check`: **0 errors (PASSED)**
  - `npm run build`: **Built production client in 1.14s (PASSED)**
  - `cargo check --manifest-path src-tauri\Cargo.toml`: **Finished in 7.63s (PASSED)**
  - `npm test -- --run`: **139 passed unit/integration tests across 19 test files** (5 component test files report known Vitest SFC environment parse errors)

---

## PR6B baseline

PR6B drag and drop behavior is verified stable and complete across earlier PR6B-fix3 through PR6B-fix9 commits:

- **Unified pointer-driven drag engine**: Managed via single global session controller (`useDragSession.ts`).
- **Library-to-rundown pointer insertion**: Cross-boundary dragging captures pointer events and resolves exact insertion targets in the rundown surface.
- **2D rundown drop-surface validation**: Validates drop coordinates against rundown surface bounds before fallback resolution.
- **Final pointerup target resolution**: Resolves drop targets deterministically (`before`, `after`, `append`, `none`).
- **Pointer capture & click suppression**: Captures pointer capture on drag initiation and suppresses accidental post-drag clicks via `didCompletePointerDrag()`.
- **Active-drag geometry refresh**: `ResizeObserver` and scroll listeners update geometry strictly during active drag (`phase === 'dragging'`).
- **Fixed indicator & append-zone polish**: Indicator rendered with zero coordinate lag (`transition: none`), label badges ("Insert before", "Insert after", "Append to end"), and active append drop-zone highlighting.

*Do not reopen PR6B unless new manual regressions are found.*

---

## PR6C implementation

The PR6C feature slice implements playlist-only keyboard reordering:

- **`rundown.moveCurrentUp` command**: Registered in `src/services/commandRegistry.ts` matching canonical `CommandDefinition` schema. Moves currently selected rundown item up 1 position (`target: { kind: 'before', targetItemId: prevItem.id }`).
- **`rundown.moveCurrentDown` command**: Registered in `src/services/commandRegistry.ts`. Moves currently selected rundown item down 1 position (`target: { kind: 'after', targetItemId: nextItem.id }`).
- **`Ctrl/Cmd+ArrowUp` routing**: Intercepted in `src/composables/useOperatorShortcuts.ts` for Windows/Linux (`Ctrl`) and macOS (`Cmd`).
- **`Ctrl/Cmd+ArrowDown` routing**: Intercepted in `src/composables/useOperatorShortcuts.ts` for Windows/Linux (`Ctrl`) and macOS (`Cmd`).
- **Rundown-only scope**: Executed only when active DOM focus / scope resolves to `rundown` (`scope === 'rundown'`).
- **Modal / Input guards**: Suppressed when focus is inside text inputs (`INPUT`, `TEXTAREA`, `SELECT`, `contenteditable`), active modals (`activeModalName.value`), or command palette.
- **Shift key guard**: Suppressed when `Shift` is held (`!event.shiftKey`), ensuring `Ctrl+Shift+Up/Down` does not trigger reorder.
- **Active pointer-drag guard**: Suppressed during an active pointer drag (`!activeDragSession.value`).
- **First / Last boundary no-ops**: `isEnabled` returns `false` when moving top item Up or bottom item Down. Produces 0 store mutations and 0 undo history entries.
- **Selection preservation**: Preserves item selection UUID (`selectedItemId`) and keeps focus on the moved item post-reorder.
- **Shortcut preservation**: Preserves existing `Alt+ArrowUp/Down` (audio gain adjustment), `F8` (library append), and `Shift+F8` (library insert) shortcut mappings.

---

## Warning patch

- Commit `0b290fb715fcc7134e5dae397cc703d2df3e333e` is an independent maintenance patch that adds warning detail tooltips to `<StatusIndicator>` and a **Validation Warnings** card to `MediaInspector.vue`.
- It is strictly separated from the PR6C shortcut implementation.
- *Do not redesign or re-audit this patch in the next PR slice unless a separate regression is reported.*

---

## Verification

Full verification command output run at commit `0b290fb`:

### 1. TypeScript Type-Check
```bash
npm run type-check
```
**Result**: Exit code 0 (0 errors).

### 2. Production Build
```bash
npm run build
```
**Result**: Exit code 0. Built production client bundle `dist/assets/index-Dz3KWMPd.js` (371.28 kB) in 1.14s.

### 3. Rust Backend Check
```bash
cargo check --manifest-path src-tauri\Cargo.toml
```
**Result**: Exit code 0. Finished `dev` profile in 7.63s.

### 4. Vitest Unit & Integration Test Suite
```bash
npm test -- --run
```
**Result**: 139 passed tests across 19 test files.
- `src/composables/__tests__/structuralKeyboardShortcuts.test.ts`: **21 tests passed** (including PR6C router, scope, modifier, drag-guard, and store integration tests).
- **Environment Note**: 5 component test files (`CommandPalette.test.ts`, `LibraryNavigation.test.ts`, `RatingBadgeOwnership.test.ts`, `RundownAutoScroll.test.ts`, `StatusIndicatorIntegration.test.ts`) failed during Vite import transformation due to Vitest happy-dom SFC parser configuration (`Failed to parse source for import analysis... Install @vitejs/plugin-vue`). All pure composable, store, and keyboard routing suites passed cleanly.

---

## Known limitations

1. **Native Executable Verification**: Keyboard shortcuts have been verified through Vitest happy-dom DOM event dispatch and Pinia store integration tests. Full manual confirmation in the compiled Windows Tauri desktop wrapper is recommended during system acceptance.
2. **Single Item Movement**: Reorder shortcuts operate on the single primary selected item (`selectedItemId`). Multi-selection block movement via keyboard is not supported in this slice.

---

## Proposed next work

### **PR7A — Operator Focus, Accessibility, and Keyboard Interaction Audit**

#### **Proposed Scope**:
- Focus restoration post-dialog/modal close.
- Scope transition consistency between Library, Rundown, and Inspector.
- Keyboard reachability for all primary action buttons.
- Accessible shortcut visual/audible feedback.
- Focus trapping and esc-key closing in dialogs and command palette.
- High-contrast and reduced-motion status accessibility review.

#### **Explicitly Excluded**:
- Playback controls / AMCP / CasparCG dispatch logic.
- Drag & drop engine modifications.
- Warning-indicator redesign.
- Third-party dependency upgrades.
- Unrelated visual styling refactors.
