# Virtual File Explorer & Rundown Performance Overhaul Plan

## Decisions Settled

| Decision | Choice | Rationale |
|---|---|---|
| Media Library architecture | Drill-down navigator with breadcrumbs | Fully virtualizable; operators navigate like a file browser |
| Data source | Unified: Ingestor API + local scanner fallback | Seamless handling of managed + legacy assets |
| Move/rename scope | Ingestor API only | No filesystem mutation risk for local legacy files |
| SortableJS | Removed from rundown; keyboard reorder kept | Incompatible with virtual scrolling |
| Virtual scroller | `useVirtualList` from `@vueuse/core` | Already a dependency (v14.2.1); lightweight |
| Row height | 40px fixed | Matches existing `contain-intrinsic-size` and `min-height` |
| `display_name` / `virtual_folder` fallback | Local scanner maps filename → display_name, relative path → virtual_folder | Unified tree handles both source types |

## Task List

### 1. Rust: Add `display_name` and `virtual_folder` to data types

**File: `src-tauri/src/ingestor_api.rs`**
- Add `display_name: Option<String>` and `virtual_folder: Option<String>` to `AssetResponse`
- Add `display_name` and `virtual_folder` to the `BatchAssetResponse` struct (same fields + uuid)

**File: `src-tauri/src/scanner.rs`**
- Add `display_name: String` and `virtual_folder: String` to `DiscoveredMedia`
- For local files: set `display_name` = filename (stem or full), `virtual_folder` = relative path from root to parent directory
- For local folders: set `display_name` = folder name, `virtual_folder` = parent's virtual folder path

### 2. Rust: Add batch asset resolution command

**File: `src-tauri/src/ingestor_api.rs`** — New function `resolve_ingestor_assets_batch`

```rust
#[tauri::command]
pub async fn resolve_ingestor_assets_batch<R: Runtime>(
    uuids: Vec<String>,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
) -> Result<HashMap<String, AssetResponse>, String>
```

- POST to `{base_url}/api/assets/batch` with JSON body `["uuid1", "uuid2", ...]`
- Expect response `{ "uuid": { ...asset fields... }, ... }`
- Chunk-side batching: if >100 UUIDs, the frontend splits into batches of 100; the Rust command handles a single batch
- Timeout: 10 seconds (longer than single-request 5s since payload is larger)

**File: `src-tauri/src/lib.rs`**
- Register the new command in `invoke_handler!`

### 3. Rust: Add move/rename commands for Ingestor API

**File: `src-tauri/src/ingestor_api.rs`** — Two new commands:

```rust
#[tauri::command]
pub async fn move_ingestor_asset(
    uuid: String,
    virtual_folder: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
) -> Result<(), String>
// PUT {base_url}/api/assets/{uuid}/move
// Body: { "virtualFolder": "new/path" }

#[tauri::command]
pub async fn rename_ingestor_asset(
    uuid: String,
    display_name: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
) -> Result<(), String>
// PUT {base_url}/api/assets/{uuid}/rename
// Body: { "displayName": "New Name" }
```

**File: `src-tauri/src/lib.rs`**
- Register both in `invoke_handler!`

### 4. Store: Migrate `playlists` from `ref` to `shallowRef`

**File: `src/stores/rundown.ts`**

The single most impactful performance change. Currently `ref<RundownPlaylist[]>` creates a **deep reactive proxy** on every property of every item. For 2000 items with ~30 properties each, that's 60,000 reactive proxies.

```
// Before:
const playlists = ref<RundownPlaylist[]>([initialPlaylist]);

// After:
import { shallowRef, triggerRef } from 'vue';
const playlists = shallowRef<RundownPlaylist[]>([initialPlaylist]);
```

Key mutation points that need `triggerRef()` after mutating:
- `addItem` / `insertItemAt` / `addGapMarker` / `addLiveItem` → after `.push()` or `.splice()`
- `removeItem` → after `.splice()`
- `updateItem` → after replacing `playlist.items[index]`
- `clearRundown` → after setting `.items = []`
- `duplicateItem` → after `.splice()`
- `reorderItems` → after `.splice()` calls
- `relinkItemsByStableId` → after all mutations
- `deserializeRundown` → after setting `.items`
- `createPlaylist` → after `.push()`
- `closePlaylist` → after `.splice()`

`computed()` properties reading from `playlists.value` will NOT auto-track changes to nested properties after this change. Items won't reactively update when individual properties change — we must call `triggerRef()` on the playlist after every array mutation, and the `RundownList` component will re-render rows via the virtual scroller. Since items themselves become plain objects, the `v-memo` behavior won't need deep tracking.

### 5. Rundown: Batch asset resolution after deserialize

**File: `src/stores/rundown.ts`** — Modify `deserializeRundown`

After hydrating all items, collect items that have `playoutvueId` but are missing asset data:

```ts
const BATCH_SIZE = 100;
const unresolvedItems = hydrated
  .filter(item => item.playoutvueId && item.type !== 'gap' && item.ingestorStatus === 'idle')
  .map(item => ({ id: item.id, uuid: item.playoutvueId! }));

const uuidToItemId = new Map(unresolvedItems.map(i => [i.uuid, i.id]));
const uuids = Array.from(uuidToItemId.keys());

for (let i = 0; i < uuids.length; i += BATCH_SIZE) {
  const batch = uuids.slice(i, i + BATCH_SIZE);
  try {
    const map = await invoke<Record<string, AssetResponse>>('resolve_ingestor_assets_batch', { 
      uuids: batch, apiBaseUrlOverride: null 
    });
    // Apply results back to items
    for (const [uuid, asset] of Object.entries(map)) {
      const itemId = uuidToItemId.get(uuid);
      if (itemId) applyAssetToItem(itemId, asset);
    }
  } catch (e) {
    console.warn(`[Ingestor] Batch resolution failed for chunk ${i}-${i+batch.length}`, e);
  }
}
triggerRef(playlists);
```

Helper `applyAssetToItem(itemId, asset)` updates the item in-place (like existing `resolveAssetFromApi` but using the pre-resolved asset).

### 6. Virtual Scrolling: RundownList.vue

**File: `src/components/RundownList.vue`**

Replace the `v-for` loop with `useVirtualList`:

```ts
import { useVirtualList } from '@vueuse/core';

const ROW_HEIGHT = 40;
const rundownListRef = ref<HTMLElement | null>(null);

const virtualConfig = useVirtualList(
  computed(() => store.activeItems),
  { itemHeight: ROW_HEIGHT, overscan: 8 },
  { 
    containerRef: rundownListRef 
  }
);
```

- `rundownListRef` is already the `.rw-list` element — reuse it
- Template changes:
  ```html
  <div class="rw-list custom-scroll" ref="rundownListRef" ...>
    <div v-bind="virtualConfig.containerProps" ...>
      <div v-bind="virtualConfig.wrapperProps" style="position:relative;">
        <div
          v-for="{ data: item, index } in virtualConfig.list"
          :key="item.id"
          class="rw-row"
          :style="{ ...virtualConfig.sheetStyle(index) }"
          ...
        >
          <!-- existing row content, unchanged -->
        </div>
      </div>
    </div>
  </div>
  ```

- Remove SortableJS:
  - Delete `import Sortable from 'sortablejs'`
  - Remove `sortableInstance` variable, `Sortable.create()` in `onMounted`, and `sortableInstance?.destroy()` in `onUnmounted`
  - Remove `sortableInstance` reference
  - Keep `Ctrl+ArrowUp/Down` keyboard reorder (already works)

- **Context menu behavior**: `contextMenu.index` now refers to the actual array index (`index` from `virtualConfig.list`), which is correct since `useVirtualList` provides the real index.

- **"Playing" row auto-scroll**: Replace `scrollIntoView` with `virtualConfig.scrollTo(playingIndex)` when the playing index changes.

- **Drop target visual**: Keep existing drop target CSS but the `dropTargetIndex` refers to the real array index. `useVirtualList`'s `virtualConfig.list` provides `{ data, index }` where `index` is the real array index.

- **Schedule times computed**: Keep unchanged — it reads from `store.activeItems` via index, which works fine.

- **Selection `ensureSelectedRowVisible`**: Replace with `await nextTick(); virtualConfig.scrollTo(targetIndex)`.

### 7. Drill-Down Media Library

**New component architecture:**

**File: `src/stores/mediaLibrary.ts`** — New Pinia store (not persisted)

```ts
interface MediaNode {
  name: string;       // display_name (or filename for local)
  path: string;       // full path
  type: 'file' | 'folder';
  mediaType?: 'video' | 'live' | 'graphic';
  playoutvueId?: string;
  // ... existing fields
  virtualFolder: string; // e.g. "ads/prime-time" or ""
  displayName: string;   // human-readable name
  isManaged: boolean;    // true = from Ingestor API, false = local fallback
}
```

The store holds:
- `allNodes: shallowRef<MediaNode[]>` — flat list of all nodes (for the drill-down + virtual scrolling)
- `currentFolderPath: ref<string>` — breadcrumb path (e.g. "ads/prime-time")
- `breadcrumbs: computed` — `currentFolderPath.split('/')` with an "All Media" root entry
- `currentFolderNodes: computed` — filtered `allNodes` where `node.virtualFolder === currentFolderPath` AND `node.type === 'folder'`, plus files in that folder
- `searchQuery: ref<string>`

**File: `src/components/MediaLibrary.vue`** — Rewrite

- **Breadcrumb bar** at top:
  ```html
  <div class="lib-breadcrumb">
    <span v-for="(crumb, idx) in mediaStore.breadcrumbs" :key="crumb.path"
          class="crumb"
          :class="{ active: idx === mediaStore.breadcrumbs.length - 1 }"
          @click="mediaStore.navigateTo(crumb.path)"
          @dragover.prevent="onBreadcrumbDragOver($event, crumb.path)"
          @drop.prevent="onBreadcrumbDrop($event, crumb.path)">
      {{ crumb.label }}
    </span>
  </div>
  ```

- **Virtualized file list** using `useVirtualList`:
  - Same `ROW_HEIGHT = 34` (matches current `.lib-row` CSS)
  - Folders listed first, then files (same sort behavior as existing)
  - Search filters within current folder and its sub-folders (or global toggle)

- **Drag to breadcrumb** for move: When a file is dragged onto a breadcrumb item, call `invoke('move_ingestor_asset', { uuid, virtualFolder: targetPath })` for managed assets. Update local store after success.

- **Context menu** additions:
  - "Rename" → prompts for new `display_name`, calls `invoke('rename_ingestor_asset', { uuid, displayName })`
  - Existing items (Add to Rundown, Insert After Selected, Set Rating, Set Tag, Trim) remain unchanged

**Remove `MediaTreeNode.vue`** — the recursive tree component is replaced by the flat drill-down list.

### 8. Data Model: Unified tree construction

**File: `src/components/MediaLibrary.vue`** — Modify `buildTree`

New flow for `rescanLibrary`:

1. Call `scan_directory` → get flat `DiscoveredMedia[]` with `displayName` and `virtualFolder` fields
2. Map each entry to a `MediaNode`:
   - `displayName = entry.display_name || entry.filename` (fallback for local)
   - `virtualFolder = entry.virtual_folder || computeRelativeFolder(entry.path, mediaRoot)` (fallback for local)
   - `isManaged = !!entry.playoutvue_id` (has a UUID = managed by Ingestor)
3. Store all nodes in `allNodes` (flat)
4. Compute folder hierarchy: iterate nodes, extract unique `virtualFolder` paths, create synthetic folder nodes for each unique path segment
5. Root folder (empty string `""`) shows top-level folders and files with no `virtualFolder`

### 9. CasparCG Parity Verification

**File: `src/services/caspar.ts`** — Audit confirmation (no changes needed)

The `buildVideoCommand` function at line 489 already uses `item.path` directly:
```ts
const buildVideoCommand = async (item: PlayoutItem, autoPlay: boolean) => {
    const rawPath = item.path || item.shortPath;
    const path = await prepareCasparMediaPath(rawPath);
    // ...
    return `LOADBG ${PROGRAM_CHANNEL}-${PROGRAM_LAYER} "${path}" ...`;
};
```

And `buildPlayVideoCommand` (line 497) similarly uses `item.path`. The `prepareCasparMediaPath` function simply normalizes the path for CasparCG. No change needed — `current_path` from the Ingestor is stored as `item.path` and used directly.

### 10. Drag State Update

**File: `src/composables/useDragState.ts`**

Add optional `playoutvueId` to `DragPayload` so the rundown store can determine if a dropped item is managed by the Ingestor:

```ts
export interface DragPayload {
    filename: string;
    path: string;
    shortPath: string;
    type: 'video' | 'live' | 'graphic';
    duration: number;
    seek: number;
    length: number;
    complianceRating?: ComplianceRating;
    playoutvueId?: string;  // NEW
}
```

### 11. Dependencies

**No new npm packages needed.** `useVirtualList` ships with `@vueuse/core` (already v14.2.1).

**No new Cargo dependencies needed.** `reqwest` is already in `Cargo.toml` for the Ingestor API.

### 12. CSS Adjustments

**RundownList.vue:**
- Remove `contain-intrinsic-size` from `.rw-row` (no longer needed with virtual scrolling)
- Remove `content-visibility: auto` (no longer needed)
- Remove `contain: layout style paint` (container handles this)
- Keep `.rw-ghost` style for possible future use but it won't be active since SortableJS is removed

**MediaLibrary.vue:**
- Add breadcrumb bar styles
- Remove `.tree-node-wrapper` styles (from deleted MediaTreeNode)
- Fix row height to 34px for `useVirtualList` consistency: add `min-height: 34px; max-height: 34px` to `.lib-row`

## Verification Checklist

### UI Performance (2000-item rundown at 60fps)
1. Load a playlist file with 2000 items
2. Scroll rapidly through the rundown — check DevTools Performance tab for frames >16ms
3. Verify only ~20 DOM nodes exist for rundown rows (via Elements panel)
4. Verify `shallowRef` — check Vue DevTools: items should show as plain objects, not `Proxy`
5. Check memory: `window.performance.memory.usedJSHeapSize` should be under 100MB for 2000 items

### Network Efficiency
1. Load a rundown with 200 assets having `playoutvueId`
2. Open Network tab (or add logging) — verify exactly `ceil(200/100) = 2` batch calls, not 200 individual calls
3. Verify each batch call is a single `invoke` → single `reqwest` POST
4. Timeout: verify batches with failed UUIDs don't block other batches

### Media Library
1. Verify breadcrumb navigation works: click folders, navigate back
2. Verify search filters within current folder
3. Verify `display_name` is shown for Ingestor-managed assets
4. Verify local fallback shows filenames correctly
5. Drag a managed asset to a breadcrumb → verify `PUT /move` is called
6. Context menu → Rename → verify `PUT /rename` is called
7. Drag from media library to rundown still works

### CasparCG
1. Play a managed asset through CasparCG
2. Verify `LOADBG 1-10 "path/to/media"` uses raw `current_path` (not display_name)

## Risks

| Risk | Mitigation |
|---|---|
| `shallowRef` + `triggerRef` causes stale UI for property-level changes (compliance rating, tag) | Since items are plain objects, the virtual list re-renders cells from the array each frame. `triggerRef` forces a full list re-render on mutation. Individual property edits will only be visible after the next mutation + triggerRef. Acceptable for a rundown editor where edits are explicit actions. |
| Break Pinia `persist` plugin with `shallowRef` | `pinia-plugin-persistedstate` serializes the entire state. It should work fine with `shallowRef` since it serializes via `JSON.stringify`. Test explicitly. |
| `useVirtualList` container height measurement on mount | The `.rw-list` element must have a defined height. Currently `flex:1` with `overflow-y:auto`. Verify it resolves to a non-zero height before `useVirtualList` initializes. Add `min-height: 0` to the flex parent if needed. |
| `scan_directory` not returning `virtualFolder`/`displayName` for old DB entries | The scanner builds these fields from the file path at scan time (not from DB). Local fallback logic is in the Rust scanner, not the DB layer. Existing DB entries are enriched during `scan_directory` output. |
