# OPERATOR-UI-CONTRACT.md — Operator UI Architecture, Safe Execution & Verification

This document specifies the stable architectural rules, protected boundaries, safety invariants, and implementation standards for the PlayOutVue operator interface.

---

## 1. Project Mission

PlayOutVue is a broadcast playout application. UI changes must prioritize:

1. Operator safety.
2. Predictable keyboard and focus behavior.
3. Stable playback isolation.
4. Deterministic playlist editing.
5. Verifiable performance.
6. Small, reviewable changes.

All UI work must optimize for **safe, incremental delivery**, not maximum code volume.

---

## 2. Protected Boundaries

The following files and subsystems are protected during UI-only work:

```text
src/services/playout.ts
src/services/caspar.ts
src/lib/playbackCoordinator.ts
src/lib/playoutDispatch.ts
src/lib/playoutFailurePolicy.ts
src-tauri/src/amcp.rs
src-tauri/src/caspar.rs
```

A UI task must not modify these files unless the user explicitly requests a playback-related change.

Before editing, any agent or developer must:
1. Inspect the relevant current files.
2. Identify callers and data flow.
3. Search for duplicate or legacy implementations.
4. List protected files.
5. State the smallest safe change boundary.

If the requested work crosses a protected boundary, stop and ask for confirmation.

---

## 3. Playback Safety Rules

The UI command layer must **never**:
- Call `playFromIndex`
- Call `playItemAt`
- Call `advanceNext`
- Call `dispatchPlay` directly
- Call `dispatchLoadbg` directly
- Construct raw AMCP commands
- Register or execute `rundown.takeSelected`
- Bind `Enter` or `Space` to Take
- Initiate playback from the command palette

Indexes may be used only as temporary render/navigation offsets. They must never be used as playlist identity or as a command target.

### Scope of Prohibition
This prohibition applies to the UI recovery series **PR0–PR7**.
Keyboard Take may be implemented only in a separate, explicitly approved **UUID-safe playback integration PR** after the API (`takeByItemId(itemId: string)`) and tests are available.

The current UI recovery series may:
`select`, `inspect`, `copy`, `paste`, `duplicate`, `delete`, `move`, `append`, `edit`.
It must not initiate playback.

---

## 4. Structural Mutation Approval Gate

Any command or feature that mutates playlist structure (such as F8 append, drag/drop move, paste, delete, or bulk insertion) must:
- Produce a deterministic diff.
- Verify the current playlist revision.
- Preserve on-air protections.
- Be undoable where applicable.
- Require explicit operator confirmation when the action is destructive, affects locked items, or changes a scheduled playlist.

---

## 5. Keyboard Architecture

There must be **exactly one global keyboard listener**:
```text
window → capture-phase keydown listener
```
It must be mounted once from the root application lifecycle (`App.vue`).

Component-level calls to `useOperatorShortcuts()` are prohibited.

The shortcut composable must:
- Prevent duplicate listener registration (using an internal `shortcutsMounted` flag).
- Remove the listener on unmount.
- Preserve native input behavior.
- Route commands according to active focus scope.
- Never execute a command twice for one key event.

### Required Scope Priority Hierarchy
1. `modal`
2. `command-palette`
3. `context-menu`
4. `text-input` / editable control
5. `trimmer`
6. `rundown`
7. `library`
8. `global`

Focus scope must be evaluated directly from the DOM:
```html
data-command-scope="rundown"
data-command-scope="library"
data-command-scope="trimmer"
data-command-scope="command-palette"
data-command-scope="modal"
```

Reactive scope state may be used only as a fallback. It must not override an actual DOM focus scope.

---

## 6. Keyboard Behavior & Native Input Protection

Text inputs, textareas, selects, and contenteditable elements retain:
- Character input
- Cursor navigation
- Native copy/paste (`Ctrl+C`, `Ctrl+V`, `Ctrl+X`)
- Native undo/redo (`Ctrl+Z`, `Ctrl+Y`)
- Native `Enter` and `Space` behavior

During the UI recovery series (PR0–PR7):
- **Arrow Up / Down**: Navigate the focused rundown selection only.
- **Home / End**: Select first / last item in focused rundown.
- **PageUp / PageDown**: Move selection by a viewport-calculated page.
- **Shift + Arrow**: Extend range selection from anchor.
- **Escape**: Close the highest-priority transient UI, then clear selection if appropriate.
- **Enter / Space**: Must NOT initiate Take.

---

## 7. Selection Model

Playlist identity is always the item **UUID**.

The store maintains:
```ts
selectedItemId: string | null;
selectedItemIds: string[];
selectionAnchorId: string | null;
```

Selection rules:
- Normal click replaces selection.
- Ctrl/Cmd-click toggles selection of a single item.
- Shift-click selects a range from `selectionAnchorId`.
- Shift + Arrow extends the range.
- Reordering preserves selected UUIDs.
- Selection changes must not modify playback state.
- `Set<string>` may be used locally for lookup but must not be persisted directly.

---

## 8. Drag & Drop Architecture

Pinia owns the final rundown order.

SortableJS may provide drag feedback, pointer position, and source/target info, but must **never** directly become the final source of truth.

Use semantic insertion targets:
```ts
type InsertionTarget =
  | { kind: 'before'; targetItemId: string }
  | { kind: 'after'; targetItemId: string }
  | { kind: 'append' };
```

Before committing a move:
1. Resolve moving item UUIDs.
2. Validate the target playlist.
3. Remove moving items conceptually.
4. Resolve the target against the filtered list.
5. Calculate the proposed result.
6. If `result.changed === false`, return without creating an undo history entry.
7. Save one undo snapshot (`saveUndoSnapshot()`).
8. Commit one store mutation.
9. Restore selection by UUID.

The drop zone on or below the final row must resolve to `{ kind: 'append' }`.
Moving multiple rows must preserve their original relative order.

---

## 9. Command Registry

Command definitions must be stateless. They must not retain Vue component closures, stale refs, stale selected IDs, or stale modal state.

Every command receives a fresh runtime context:
```ts
type CommandContext = {
  scope: ShortcutScope;
  selection: SelectionSnapshot;
  rundown: RundownCommandContext;
  library: LibraryCommandContext;
  trimmer: TrimmerCommandContext | null;
  activeModal: string | null;
};
```

Each command must define:
`id`, `label`, `scope`, `isVisible`, `isEnabled`, `disabledReason`, `execute`.

Commands that are not implemented must not be registered merely as placeholders unless the current task explicitly requires disabled-command display. `rundown.takeSelected` must not be registered during PR0–PR7.

---

## 10. Testing Standards

Pure store unit tests are not sufficient for keyboard behavior.

Keyboard routing tests must use:
- `happy-dom` or `jsdom` environment
- Real DOM elements with `data-command-scope`
- Real `.focus()` calls
- Real `KeyboardEvent` instances
- `window.dispatchEvent(event)`
- Assertions for `event.defaultPrevented`
- Scope bypass assertions

Minimum keyboard integration test requirements:
1. Focused rundown receives `ArrowDown` → selection changes exactly once.
2. `event.defaultPrevented === true`.
3. Focused input does not change rundown selection.
4. Focused modal does not change rundown selection.
5. Second listener mount does not register duplicate listener.
6. Unmount removes the listener.

Test-only reset helpers exported from production modules must be annotated with:
```ts
/** @internal Test-only reset helper. Never call from production application code. */
```

---

## 11. Scope Limits by PR Slice

- **PR 1**: Keyboard navigation only. (No Take, F8, drag/drop, palette, trimmer, undo/redo, or visual redesign).
- **PR 2**: Deterministic drag/drop only.
- **PR 3**: Safe command registry, structural editing, and library commands.
- **PR 4**: Command palette and focus trapping.
- **PR 5**: Trimmer controller and precision UI.
- **PR 6**: Status indicators, opaque menus, accessibility, reduced motion.
- **PR 7**: Browser performance profiling and conditional virtualization.
