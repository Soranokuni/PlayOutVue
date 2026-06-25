# PlayOutVue Ingestor Integration & UI Refactor Plan

## Goal
Refactor PlayOutVue so it consumes the externalheadless Ingestor API running on port 4353, removes all local transcoding, fixes the rundown/layout/click-protection bugs, rebuilds the side-panel MediaLibrary as a virtual-folder tree, and adds a background heartbeat monitor with a pulsing status indicator and diagnostics log.

## Decisions already agreed with the user
1. **Local ingestor removed.** Delete `src-tauri/src/bin/playout_ingestd.rs`, `src-tauri/src/ingest_service.rs`, the `IngestShell.vue` route, and all Tauri commands/state that spawn the local service. Default `ingestorApiBaseUrl` becomes `http://127.0.0.1:4353`.
2. **API contract aligned with the real PlayoutTranscode API.** Asset response fields are: `uuid`, `current_path`, `duration_ms`, `trim_in_ms`, `trim_out_ms`, `rating`, `status`, `display_name`, `virtual_folder`. Do **not** require `fingerprint` from the ingestor endpoints; use `uuid` as the stable identity.
3. **Virtual-folder operations limited to what the API supports today.**
   - Rename: `PUT /api/assets/{uuid}/rename` ✅
   - Move: `PUT /api/assets/{uuid}/move` ✅
   - Delete: client-side filter only. Track a local `deletedUuids` set and hide those assets from the tree. Do not call a backend delete endpoint.
   - New Virtual Folder: transient UI placeholder node. It persists only when an asset is moved into it via the existing move endpoint, or by updating the local fallback tree; otherwise it disappears on the next API refresh.
4. **MediaLibrary data source.** Primary source is always `GET /api/assets`. Local directory scan is a fallback used only when `isIngestorOnline === false`. Default `localMediaPath` is set to the CasparCG media root: `C:\Users\toutountzaki\Desktop\casparcg-server-v2.5.0-stable-windows\media`.
5. **Trim panel read-only.** Use FFmpeg/FFprobe for preview frame extraction and trim math only. Persist trim via `PUT /api/assets/{uuid}/trim`. Do not write a locally trimmed output file.

---

## 1. Purge local transcoding stack

### Backend (Rust)
- [ ] Delete `src-tauri/src/bin/playout_ingestd.rs`.
- [ ] Delete `src-tauri/src/ingest_service.rs`.
- [ ] In `src-tauri/src/lib.rs`:
  - Remove `mod ingest_service;` and `mod stream;` imports/exports if they are only used for local transcoding.
  - Remove `IngestServiceState` management.
  - Remove tray logic that calls `stop_ingestd_process` before exit.
  - Remove invoke handler entries for `start_ingestd_service`, `stop_ingestd_service`, `get_ingestd_service_status`, `ingest_shell_minimize_to_tray`, `ingest_shell_exit_app`, `set_ingestor_api_base_url`.
- [ ] In `src-tauri/Cargo.toml`:
  - Remove the `[[bin]] playout-ingestd` block.
  - Remove crates no longer needed for local encoding/transcoding (e.g. inspect whether `image`, `walkdir`, `uuid`, `reqwest` etc. are still needed; keep `reqwest` for Ingestor API and `walkdir` for fallback scanning).
- [ ] Keep `src-tauri/src/trimmer.rs`, `src-tauri/src/scanner.rs`, and `src-tauri/src/media_index.rs` **only** for:
  - FFprobe metadata (`scan_media`).
  - Preview/scrub frame extraction.
  - Trim math / frame count / timecode calculation.
- [ ] Remove any local-file-output trim command in `trimmer.rs` (e.g. `trim_file`, `trim_file_smart`) and replace with a lightweight `get_media_preview_info` command that returns duration, frame count, and a preview frame path/base64 without writing a new media file.
- [ ] Add a new `check_ingestor_health` Tauri command, or implement it only inside the background task. The background task is authoritative; the command is optional.

### Frontend
- [ ] Remove `src/components/IngestShell.vue`.
- [ ] Remove the Ingest Shell route/button from `src/App.vue`.
- [ ] Remove `@types/sortablejs` and `sortablejs` from `package.json` (they are unused today).
- [ ] Update `src/stores/settings.ts`:
  - `ingestorApiBaseUrl: 'http://127.0.0.1:4353'`.
  - `localMediaPath` default to the CasparCG media root.
  - Remove obsolete fields for the local transcode sidecar (`transcodeVideoPath`, `transcodeSidecarPath`).

---

## 2. Fix fixed-panel layout and click protection

- [ ] In `src/App.vue`, keep the CSS grid but ensure the bottom control bar is a **single fixed-height row** (`58px`) with explicit `z-index: 100` and `pointer-events: auto`. It must not overlap the rundown scroll area.
- [ ] Extract the *rundown action/planning bar* from `src/components/PlaylistControls.vue` and render it as a **fixed sub-header directly inside the rundown panel** (above the virtual list), not floating inside the scroll container.
- [ ] In `src/components/RundownList.vue`, make the virtual-list container the only scrollable area. Ensure the `@dragenter.prevent`, `@dragover.prevent`, and `@drop.prevent` listeners are attached to the **root list wrapper box** (the same element that owns `overflow: auto`), not to individual rows, so dropping on an empty list works.
- [ ] Apply `pointer-events: auto` and an explicit stacking context to the utility action buttons (`Clear List`, `New List`, `Append List` are the playlist save/load/append/clear buttons in `PlaylistControls.vue`).
- [ ] Verify the `useVirtualList` container has `position: relative; min-height: 0;` and its wrapper is the sole scrolling surface.

---

## 3. Virtual scrolling and native drag-and-drop

- [ ] Confirm `useVirtualList` from `@vueuse/core` remains in place with an absolute/relative position strategy and a row height of 40px.
- [ ] Remove SortableJS dependency entirely.
- [ ] Keyboard reordering is already implemented (`Ctrl + Arrow Up/Down` in `RundownList.vue`). Keep it and ensure it calls `store.reorderItems` cleanly and does not fight with virtual list re-rendering (call `nextTick` after reorder if needed).
- [ ] Fix drag-and-drop pipeline:
  - Side-panel `MediaLibrary.vue` already sets `draggingItem` on `dragstart`; ensure data is updated before the drop event.
  - On the rundown wrapper, accept drops via `@drop.prevent` and read `draggingItem.value` metadata.
  - Append/splice into the Pinia rundown store using `store.addItem()` or `store.insertItemAt()`.
  - After insert, hydrate duration via `scan_media` if needed, then update the item from the Ingestor API if it has a `uuid`.

---

## 4. Rebuild side-panel MediaBrowser with virtual folders

### Store changes
- [ ] Update `src/stores/mediaLibrary.ts`:
  - Replace flat `allNodes` with a tree structure or a flat asset list plus a derived tree.
  - Store `assets: Array<{ uuid, currentPath, displayName, virtualFolder, durationMs, trimInMs, trimOutMs, rating, status }>`.
  - Provide `treeNodes` computed that groups assets by `virtualFolder` (`/shows/s1/ep1`, `/promos`, etc.) and yields collapsible folder/asset nodes.
  - Track `expandedFolders: Set<string>`, `selectedNodeId`, and `deletedUuids: Set<string>` (persisted via Pinia persistence).
  - Add `moveAssetToFolder(uuid, virtualFolder)`, `renameAsset(uuid, displayName)`, `deleteAsset(uuid)`, `createVirtualFolder(name)`.

### API integration
- [ ] In `src/components/MediaLibrary.vue`, replace the existing `buildFlatNodes`/`scan_directory` first-load flow with a `fetchAssets()` routine:
  - If online: call `resolve_ingestor_assets_batch` equivalent or `GET /api/assets` via a new Rust command.
  - If offline: call `scan_directory` but **only** for `localMediaPath`; the resulting files are treated as unmanaged and placed under a fallback root folder such as `/Unmanaged/...`.
- [ ] Rename: `invoke('rename_ingestor_asset', { uuid, displayName })`.
- [ ] Move: `invoke('move_ingestor_asset', { uuid, virtualFolder })`.
- [ ] Delete: client-side only (add to `deletedUuids`).
- [ ] New Virtual Folder: insert a transient folder node. If empty, it is discarded on the next API refresh unless persisted in UI state.

### UI controls
- [ ] Add side-panel toolbar buttons: **New Virtual Folder**, **Rename**, **Delete**.
- [ ] Render a tree with expand/collapse chevrons and recursive folders.
- [ ] Keep drag-from-side-panel working. Dragging a folder is unsupported; only file/asset rows should be `draggable`.

### Rust asset model
- [ ] In `src-tauri/src/ingestor_api.rs`, update `AssetResponse` / `BatchAssetResponse` to match the real API:
  - Keep fields: `uuid`, `current_path`, `duration_ms`, `trim_in_ms`, `trim_out_ms`, `rating`, `status`, `display_name` (Option/String), `virtual_folder` (Option/String).
  - Do not require `fingerprint`.
- [ ] Add a Tauri command `list_ingestor_assets()` that calls `GET /api/assets` and returns a list of `AssetResponse`.

---

## 5. Heartbeat monitor, status light, and diagnostics panel

### Backend
- [ ] In `src-tauri/src/lib.rs`, spawn a Tokio task on `setup` that pings `GET /api/health` every 5 seconds using the configured base URL from `RuntimeSettingsState`.
- [ ] Parse the response. Emit a Tauri global window event `ingestor-heartbeat` with payload `{ online: bool, lastSeenAt: number, error?: string }`.
- [ ] On any failure (timeout, non-2xx, parse error), emit `online: false` and include a short error string.

### Frontend store
- [ ] Create `src/stores/ingestorStatus.ts`:
  - `isIngestorOnline: boolean`
  - `lastSeenAt: number | null`
  - `logEntries: Array<{ timestamp: number, level: 'warn'|'error', scope: string, message: string }>`
  - Actions: `setOnline`, `logWarning(scope, message)`, `clearLog()`.
  - Persist only `isIngestorOnline/lastSeenAt`; cap log entries in memory to ~200 entries.
  - Listen for the Tauri `ingestor-heartbeat` event via `listen` from `@tauri-apps/api/event`.

### UI
- [ ] Create `src/components/IngestorStatusLight.vue`:
  - Pulsing emerald green glow when `isIngestorOnline === true`.
  - Solid coral red when `isIngestorOnline === false`.
  - Tooltip with last seen timestamp and current base URL.
- [ ] Mount it in `src/App.vue` top control bar, near the existing CasparCG/OBS status dots.
- [ ] Create `src/components/ClientDiagnosticsLog.vue`:
  - Collapsible bottom panel.
  - Listens for API failures emitted from the Ingestor commands and from the heartbeat.
  - Logs timestamped warnings when a single asset resolve, batch resolve, move, rename, or list request fails.
  - Show a toggle button in the footer/control bar.

### Instrumentation
- [ ] Wrap every Ingestor invoke inside `try/catch` and push a diagnostic entry with scope (`ingestor-list`, `ingestor-resolve`, `ingestor-batch`, `ingestor-move`, `ingestor-rename`, `ingestor-trim`) on failure.
- [ ] Keep the existing lib debug diagnostics in the MediaLibrary separate; do not mix them unless requested.

---

## 6. Cross-check: CasparCG playback path safety

- [ ] Ensure `prepare_caspar_media_path` (in `src-tauri/src/caspar.rs`) is called before sending `current_path` to CasparCG.
- [ ] The function already:
  - Rejects empty paths.
  - Canonicalizes the source and media root.
  - Strips the configured CasparCG media root to produce a relative path.
  - Checks for path-traversal-safe ASCII characters.
  - Creates an ASCII alias under `__sota_caspar` when needed.
- [ ] In the rundown store and during `buildPlaybackPayload`, when `path` comes from an Ingestor-managed asset, pass it through `prepare_caspar_media_path`. If it does not resolve under the media root, log a diagnostic warning and skip the item instead of sending an unsafe path.
- [ ] Add an explicit check: if the resolved path contains `..` or is not within the configured CasparCG media root, treat it as an error.

---

## 7. Validation / verification checklist

After implementation, another implementation-capable agent should verify:

- [ ] `npm run type-check` passes for the frontend.
- [ ] `cargo check` / `cargo tauri build` passes for the backend.
- [ ] With the Ingestor running on port 4353, the MediaLibrary populates from `/api/assets`, groups by `virtual_folder`, and displays the pulsing green status light.
- [ ] Stopping the Ingestor turns the status light solid coral red and the diagnostics panel shows a timestamped connection warning.
- [ ] Dragging an asset from the side panel and dropping it on an empty rundown list appends it; dropping between rows inserts it at the target index.
- [ ] The action bar buttons (Clear/New/Append) are clickable with 0, 1, and a stress-tested large number of rows.
- [ ] `Ctrl + Arrow Up/Down` reorders items with 60fps scrolling.
- [ ] A rundown file with paths from the Ingestor plays through CasparCG using `prepare_caspar_media_path` and resolves to a relative path under the media root.
- [ ] Trim panel opens a preview, calculates trim in/out, and on save calls `PUT /api/assets/{uuid}/trim` without creating a new local media file.

---

## Risks

- **PlayoutTranscode does not expose delete/new-folder endpoints.** Delete and New Folder will be UI-only until the backend supports them. Document this in UI tooltips.
- **Large `/api/assets` responses.** If the Ingestor returns thousands of assets, the tree rendering must stay virtualized. The tree itself is not heavily virtualized today; consider flattening into a virtual list grouped by folder if performance regresses.
- **`current_path` mismatch.** If the Ingestor `current_path` is not under the configured CasparCG media root, playback will fail. Verification step above catches this.
- **Rust compile impact of removing modules.** Removing `playout-ingestd` binary and unused commands is safe but requires careful cleanup of `lib.rs` and `Cargo.toml`.

## Open questions / out of scope

- Delete and New Virtual Folder are intentionally client-side/pending backend support. If a backend delete endpoint (`POST /api/assets/{uuid}/delete`) and folder endpoint (`POST /api/folders`) are added to PlayoutTranscode later, the UI buttons can be wired to them.
- Fingerprint is not returned by the Ingestor API; if future correlation with sidecar files is needed, derive or load fingerprint separately.
