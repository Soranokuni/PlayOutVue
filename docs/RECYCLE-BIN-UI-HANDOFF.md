# Recycle Bin, Storage Purge, Restore, and Auto-Purge Handoff

## Summary

This document describes the Recycle Bin, Restore, Storage Purge, and Auto-Purge implementation in `PlayOut` (PlayOutVue / Tauri application), complementing the `PlayoutTranscode` backend capabilities.

---

## 1. Architecture & Flow

```
[MediaLibrary UI / Context Menus]
       │
       ├── Move to Recycle Bin (Soft Delete)
       │       │
       │       ▼ (Tauri IPC: trash_ingestor_asset / trash_ingestor_folder)
       │       └── PlayoutTranscode: sets `deleted_at = now()`, preserves original folder
       │
       ├── Delete & Purge (Destructive Permanent Deletion)
       │       │
       │       ├── Pulsing Red Warning Dialog (Confirmation)
       │       │
       │       ▼ (Tauri IPC: purge_ingestor_asset / purge_ingestor_folder)
       │       └── PlayoutTranscode: validates path safety, unlinks mezzanine & sidecar, removes DB record
       │
[RecycleBinModal.vue]
       ├── View all soft-deleted assets & original virtual folders
       ├── Filter / Search trashed assets
       ├── Individual Restore (restores to original folder or fallback to '/')
       ├── Individual Purge (with pulsing red confirmation dialog)
       └── Empty Recycle Bin (purges all trashed items and local files)

[SettingsModal.vue & App Startup]
       ├── Auto-Purge Policy Dropdown (Disabled, 1 Week, 2 Weeks, 3 Weeks, 1 Month)
       ├── Manual Empty Bin Action
       └── Background / Startup maintenance invocation
```

---

## 2. Component & Store Updates

1. **`src/stores/mediaLibrary.ts`**:
   - `LibraryAsset`: added `deleted_at?: string; original_virtual_folder?: string;`
   - Filtered out `deleted_at` items in `setAssets()` to isolate active media tree.
   - Added actions: `fetchRecycleBin()`, `trashAsset(uuid)`, `trashFolder(folderPath)`, `restoreAsset(uuid, targetFolder)`, `restoreFolder(folderPath, fallbackToRoot)`, `purgeAsset(uuid)`, `purgeFolder(folderPath)`, `emptyRecycleBin()`, and `checkAndTriggerAutoPurge(policy)`.

2. **`src/components/RecycleBinModal.vue`**:
   - High-contrast broadcast modal matching dark slate theme.
   - Detailed list of soft-deleted assets, original folders, formatted durations, and deletion timestamps.
   - Live search filter and refresh controls.
   - Restores assets back to their original virtual folders.
   - Built-in pulsing alert confirmation dialog (`@keyframes danger-pulse`) for destructive unlinking actions.

3. **`src/components/MediaLibrary.vue`**:
   - Header/toolbar: added Recycle Bin toggle button with live count badge.
   - Context menus:
     - Media assets: `🗑 Move to Recycle Bin` & `💥 Delete & Purge…`
     - Virtual folders: `🗑 Move Folder to Recycle Bin` & `💥 Delete & Purge Folder…`
   - Contextual pulsing danger alert dialog before executing permanent mezzanine deletion.

4. **`src/components/SettingsModal.vue`**:
   - Added `Recycle Bin & Storage Auto-Purge` section.
   - Policy select: `disabled`, `1week`, `2weeks`, `3weeks`, `1month`.
   - Manual `Empty Recycle Bin Now` button with double confirmation.

5. **`src-tauri/src/ingestor_api.rs` & `lib.rs`**:
   - Implemented 8 typed Tauri commands bridging to PlayoutTranscode REST endpoints.

---

## 3. Verification & Test Coverage

- **PlayOut Frontend Unit Tests**: 192/192 tests passing (`npm test -- --run`) across 27 suites.
- **PlayOut Type Check**: Clean (`npm run type-check`).
- **PlayOut Production Build**: Clean (`npm run build`).
- **PlayOut Tauri Backend Tests**: 53 unit tests + 1 integration test passing (`cargo test`).
- **PlayoutTranscode Backend Tests**: 91 unit tests + 10 contract boundary + 5 reliability + 10 wire contract tests passing.
