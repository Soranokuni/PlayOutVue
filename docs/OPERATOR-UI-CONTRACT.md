# OPERATOR UI CONTRACT

This document defines the strict, non-negotiable architectural boundaries and behavioral rules for the **PlayOutVue Operator UI**.

---

## 1. Core Safety Rule & Playback Boundary

> **This UI recovery series may select, edit, copy, move, append, and inspect rundown items—but it must not initiate playback.**

- **Playback Integrity**: The UI layer MUST NEVER modify CasparCG AMCP command formatting, OSC feedback parsing, playback timing calculation, or playout service state machines (`src/services/playout.ts`, `src/services/caspar.ts`, `src/lib/playbackCoordinator.ts`).
- **Hard Rule on Index-Based Playback**:
  ```text
  No UI command may call playFromIndex, playItemAt, advanceNext, or any index-based playback method.
  ```
- **Prohibition on `rundown.takeSelected`**:
  ```text
  Do not register rundown.takeSelected in this UI recovery series.
  Do not add Enter/Space Take handling.
  Do not display Take in the command palette (neither enabled nor disabled).
  Keyboard Take will be implemented later in a separate UUID-safe playback integration PR.
  ```

---

## 2. Keyboard Routing & Scope Priority

A single global capture listener attached to `window` in `src/composables/useOperatorShortcuts.ts` is mounted ONLY ONCE from the root application lifecycle (`App.vue`), removing all component-level calls.

### Scope Priority Precedence
1. **Modal** (`[data-command-scope="modal"]`) — Traps focus within modal dialogs.
2. **Command Palette** (`[data-command-scope="command-palette"]`) — Hotkey `Ctrl+K`. Uses local input key handler for navigation within palette while active, calling `preventDefault()` and `stopPropagation()` on key events (arrows, Enter, Escape, Tab). Restores focus to previous active element on close.
3. **Context Menu** (`[data-command-scope="context-menu"]`) — `Escape` closes menu.
4. **Text Input / Editable Control** — Normal typing, cursor movement, and native input clipboard operations (`Ctrl+C`/`V`/`X`/`Z`) are preserved. `Space` or `Enter` NEVER triggers Take or rundown movement.
5. **Trimmer** (`[data-command-scope="trimmer"]`) — J/K/L shuttle, frame stepping, in/out setting, nudging when trimmer panel owns focus.
6. **Rundown** (`[data-command-scope="rundown"]`) — Arrow Up/Down navigation, Home/End, PageUp/PageDown (viewport-calculated), Shift range extension, Escape cascade.
7. **Library** (`[data-command-scope="library"]`) — Asset search, filter, and explicit library command context actions.
8. **Global** — Safe fallback shortcuts.

---

## 3. Focus, Selection & Indicator States

| State | Definition & Visual Treatment |
|---|---|
| **Selected** | Items explicitly marked for operator action in store (`selectedItemIds`). High-contrast highlight background. |
| **Focused** | Active DOM element receiving keyboard focus (`document.activeElement`). Focus outline indicator. |
| **Hovered** | Pointer hovering over a UI element (`:hover`). Subtle background tint. |
| **On-Air** | The item currently playing out live on broadcast output. Solid Red indicator tag (`#e63946`), non-pulsing in reduced motion. Cannot be deleted while playing. |
| **Armed / Next Up** | The item queued to play next when current playing item finishes. Cyan indicator tag (`#33becc`). |
| **Offline** | Inactive or offline playlist items. Slate Gray tag (`#64748b`). |
| **Unsaved Trim** | Items with uncommitted draft trim modifications. Purple indicator tag (`#a855f7`). |
| **Ready** | Asset fully ingested and verified playable by PlayoutTranscode contract. Emerald Green tag (`#22c55e`). |
| **Processing** | Ingestion/transcode in progress. Amber Yellow tag (`#f59e0b`). |
| **Error** | Ingestion or transcode failed validation. Rose Red tag (`#f43f5e`). |

Status indicators must be rendered using `StatusIndicator.vue` integrated into `RundownRow.vue`, `MediaLibrary.vue`, and `IngestorStatusLight.vue`.

---

## 4. Selection Behavior & Data Structure

- **Storage**: `selectedItemIds: string[]` (Array in Pinia store for JSON serialization safety). Sets are used locally for $O(1)$ lookup inside components.
- **Normal Click**: Replaces selection with target item ID.
- **Ctrl / Cmd + Click**: Toggles single item inclusion in selection.
- **Shift + Click**: Selects contiguous range from anchor item to target item.
- **Arrow Navigation**: Moves primary selected item ID synchronously.
- **Shift + Arrow Navigation**: Extends selection range from initial anchor.
- **Item Reordering**: Preserves selected item IDs through move operations.

---

## 5. Playlist Ordering & Drag/Drop Semantics

- **Sole Source of Truth**: The Pinia rundown store (`src/stores/rundown.ts`) owns array order. SortableJS `onEnd` events MUST NOT directly mutate the array before the Pinia store action runs.
- **No-Op Undo Protection**:
  ```text
  Do not activate undo history for failed, invalid, no-op, or missing-target drag operations.
  ```
  The store calculates the move result first. `saveUndoSnapshot()` is called ONLY if `result.changed === true`.
- **Insertion Target Specification**:
  ```ts
  type InsertionTarget =
    | { kind: 'before'; targetItemId: string }
    | { kind: 'after'; targetItemId: string }
    | { kind: 'append' };
  ```
- **Move Operation Result**:
  ```ts
  type MoveResult = {
    changed: boolean;
    movedItemIds: string[];
    target: InsertionTarget;
  };
  ```
- **Geometry Resolution**: Pointer Y position relative to target row midpoint determines `before` vs `after`. Hovering over end drop zone or lower list area resolves to `{ kind: 'append' }`.
- **UUID Preservation**: Reordering filters out moving item IDs and inserts them into the destination target while preserving their original relative order.

---

## 6. Undo / Redo Scope

- **Scope**: Local rundown structural edits ONLY (reordering, item insertion, sub-clip trimming, item deletion).
- **Exclusions**: MUST NEVER affect or undo On-Air playback status, active playing item indices, or backend server state.
- **Stack Limit**: Maximum 100 bounded snapshots per session.

---

## 7. Command Registry Architecture

- **Stateless Definitions**: `CommandDefinition` objects do not store Vue component closures or reactive refs.
- **Dynamic Context**: `CommandContext` is generated dynamically at execution time with fresh store refs, focus scope classification, selection snapshot, active modal/trimmer state, and library command context.
- **Real Library Context**:
  ```ts
  type LibraryCommandContext = {
    selectedAssetIds: string[];
    appendSelectedToPlaylist(): Promise<{ insertedIds: string[]; skippedIds: string[]; errors: string[] }>;
    insertSelectedAfter(itemId: string): Promise<{ insertedIds: string[]; skippedIds: string[]; errors: string[] }>;
  };
  ```
- **Command Categories**:
  - **Safe Navigation**: `selectPrevious`, `selectNext`, `selectFirst`, `selectLast`, `clearSelection`.
  - **Structural**: `copySelected`, `pasteAfterSelected`, `duplicateSelected`, `deleteSelected`.
  - **Playback-Impacting**: NOT REGISTERED (deferred to separate UUID-safe playback PR).
