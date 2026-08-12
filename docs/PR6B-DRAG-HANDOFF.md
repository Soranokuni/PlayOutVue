# PR6B Drag and Drop Handoff

## Repository state
- **Exact HEAD SHA**: `6c71fd95d56598e59beaa1b3858345aa1bb6fcf6`
- **Branch**: `main`
- **Current Date**: 2026-08-12
- **Latest Relevant Commits**:
  - `6c71fd9`: `fix(ui): PR 6B-fix3 - single canonical ActiveDropTarget, rAF dragover coalescing, and midpoint hysteresis deadband`
  - `3d3a021`: `fix(ui): PR 6B-fix2 - remove layout-shifting translateY transforms, set explicit DragSource, and enforce 1-to-1 drop target parity`
  - `89b7fad`: `fix(ui): PR 6B-fix - single drag ownership, stable DOM item-ID mapping, Shift+F8 focus safety, and library sidebar min-width clamp`
  - `09a8422`: `feat(ui): PR 6B - reorder drag UX stabilization, single viewport coordinate system, and pure reorder helper`
  - `9453351`: `feat(ui): PR 6A - status indicator state contract, priority resolver, and surface integration`
- **Test Status**: 115 tests passed across 18 test files, but the overall test command is not fully clean because 5 test files reported Vite/Vue SFC happy-dom environment import errors.

## Completed work
- **PR6A Status-Indicator Integration**:
  - *Implemented*: Priority resolver (`resolveRundownStatusTone`), 9 visual tones, surface mounting integration.
  - *Automated tests*: Passed (`StatusIndicatorIntegration.test.ts`).
  - *Manual verification*: Verified (single badge per row surface).
- **PR6B Reorder Helper**:
  - *Implemented*: `calculatePointerDropTarget`, `toInsertionTarget`, single viewport `clientY` coordinate system.
  - *Automated tests*: Passed (`reorderHelper.test.ts`).
  - *Manual verification*: Partial; later manual testing still reproduces inaccurate or unstable drag behavior.
- **PR6B-fix Stable DOM Item IDs**:
  - *Implemented*: `buildRowRectsFromDOM` queries `data-item-id="${item.id}"` attributes from rendered row elements.
  - *Automated tests*: Passed (`reorderHelper.test.ts`).
  - *Manual verification*: Partial; later manual testing still reproduces inaccurate or unstable drag behavior.
- **PR6B-fix2 Removal of Layout-Shifting Row Transforms**:
  - *Implemented*: Removed `transform: translateY(12px)` and `transform: translateY(-12px)` from `.rw-row.drop-target-before` and `.rw-row.drop-target-after` in `RundownRow.vue`.
  - *Automated tests*: Passed (`RundownDragDrop.test.ts`).
  - *Manual verification*: Partial; later manual testing still reproduces inaccurate or unstable drag behavior.
- **Explicit Library/Rundown DragSource**:
  - *Implemented*: Added `DragSource = 'library' | 'rundown' | 'external'` to `DragPayload` in `useDragState.ts` and set `source: 'library'` in `MediaLibrary.vue`.
  - *Automated tests*: Passed (`RundownDragDrop.test.ts`).
  - *Manual verification*: Partial; later manual testing still reproduces inaccurate or unstable drag behavior.
- **Row/Container Drop-Target Parity**:
  - *Implemented*: Both row `@drop` and container `@drop` call `resolveDropTarget(event)`, and `onRowDrop` calls `event.stopPropagation()`.
  - *Automated tests*: Passed (`RundownDragDrop.test.ts`).
  - *Manual verification*: Partial; later manual testing still reproduces inaccurate or unstable drag behavior.
- **PR6B-fix3 Canonical ActiveDropTarget**:
  - *Implemented*: `activeDropTarget = ref<ActiveDropTarget>({ kind: 'none' })` and computed `indicatorTarget` derived directly from canonical state.
  - *Automated tests*: Passed (`reorderHelper.test.ts`).
  - *Manual verification*: Partial; later manual testing still reproduces inaccurate or unstable drag behavior.
- **requestAnimationFrame Dragover Coalescing**:
  - *Implemented*: `scheduleDropTargetUpdate` throttles `dragover` updates to display frame rate using `requestAnimationFrame` with `sameDropTarget` state guards.
  - *Automated tests*: Passed (`reorderHelper.test.ts`).
  - *Manual verification*: Partial; later manual testing still reproduces inaccurate or unstable drag behavior.
- **Midpoint Hysteresis**:
  - *Implemented*: 3px hysteresis deadband in `calculatePointerDropTarget` when pointer rests near target row midpoint.
  - *Automated tests*: Passed (`reorderHelper.test.ts`).
  - *Manual verification*: Partial; later manual testing still reproduces inaccurate or unstable drag behavior.

## Current known failure
PR6B-fix3 is **not accepted as complete**. Manual testing still reports unreliable drag behavior. The drag indicator and reorder behavior still have a known manual failure where the indicator can become inaccurate or unstable, and the implementation may still contain competing SortableJS and native drag behavior.

The next agent must begin from commit `6c71fd95d56598e59beaa1b3858345aa1bb6fcf6` and implement **PR6B-fix4** only:
> **PR6B-fix4 — Replace competing drag ownership with one deterministic native drag system.**

## PR6B-fix4 requirements
The next agent must investigate and implement:
- Remove SortableJS completely from the rundown reorder path.
- Use native HTML5 drag events as the sole reorder owner.
- Create a stable drag session model.
- Capture row geometry at `dragstart`.
- Use stable row IDs (`data-item-id`).
- Calculate visual indicator and final drop commit from the exact same semantic target.
- Update geometry snapshot only for scroll/list/resize layout changes.
- Avoid reading unstable live geometry on every single `dragover` event.
- Preserve library-to-rundown asset insertion.
- Preserve multi-item rundown group reordering.
- Preserve item selection and focus ownership.
- Commit exactly once per browser drop event.
- Clear drag state on drop, cancellation, `dragleave`, `dragend`, and component unmount.

## Protected files
The following playback boundary files MUST remain completely untouched:
- `src/services/playout.ts`
- `src/services/caspar.ts`
- `src/lib/playbackCoordinator.ts`
- `src/lib/playoutDispatch.ts`
- `src/lib/playoutFailurePolicy.ts`
- `src-tauri/src/amcp.rs`
- `src-tauri/src/caspar.rs`
- `src/lib/trimCommands.ts`

## Required verification
- `npm test -- --run` / `npx vitest run`: 115 tests passed across 18 test files, but the overall test command is not fully clean because 5 test files reported Vite/Vue SFC happy-dom environment import errors.
- `npm run type-check`: Passed cleanly (0 errors, `vue-tsc --build`).
- `npm run build`: Passed cleanly (Production bundle built: `dist/assets/index-DV_2ahrI.js`).
- `cargo check --manifest-path src-tauri\Cargo.toml`: Passed cleanly (Finished in 0.38s).

## Handoff rules
- Do not implement PR6B-fix4 in this handoff task.
- Do not start PR6C.
- Do not change source files.
- Keep the handoff factual and repository-based.
