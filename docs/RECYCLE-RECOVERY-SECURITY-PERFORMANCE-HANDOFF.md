# Instant Recycle Recovery, Security Hardening & Performance Optimization Handoff

## Summary of Changes

### 1. Instant Recycle Recovery
- **Reactive State Sync**: Fixed `restoreAsset` and `restoreFolder` in `src/stores/mediaLibrary.ts` to immediately remove restored items from `recycleBinAssets`, remove restored UUIDs from `deletedUuids`, and upsert the restored item directly into `assets.value`.
- **Zero-Flicker & No Refresh Needed**: Restored assets immediately reappear in the active library tree without waiting for manual refresh or reload.
- **IPC Hydration**: Updated `src-tauri/src/ingestor_api.rs` (`restore_ingestor_asset`) to deserialize and return the restored asset payload directly from the PlayoutTranscode restore endpoint.

### 2. Security Hardening
- **Content Security Policy (CSP)**: Added explicit CSP in `src-tauri/tauri.conf.json` restricting resource loading to `self`, local media server (`http://127.0.0.1:* http://localhost:*`), Tauri IPC, and Google Fonts.
- **Media Server Whitelisting & Traversal Guard**: Updated `src-tauri/src/media_server.rs` to validate that files have allowed media extensions (`mp4`, `mov`, `mkv`, `avi`, `wav`, etc.) and reject path traversal components (`..`) with HTTP 403.
- **Crawl HTML Template Sanitization**: Replaced unescaped string injection in `src/assets/templates/playout/crawl.html` with HTML entity escaping (`escapeHtml`).

### 3. Performance Optimizations
- **Rundown Undo/Redo Snapshots**: Replaced expensive `JSON.parse(JSON.stringify(...))` with native `structuredClone(toRaw(...))` in `src/stores/rundown.ts`.
- **Database Indexing**: Added `idx_media_cache_playoutvue_id` and `idx_media_cache_scanned_at` indexes to SQLite `media_cache` table in `src-tauri/src/db.rs`.
- **Virtual Folder Tree Generation**: Replaced array `.includes()` with `Set.has()` for `deletedUuids` check during virtual tree population in `src/stores/mediaLibrary.ts`.

## Verification
- Unit & Integration tests: 192 frontend tests passing (`npm test -- --run`).
- Frontend typecheck: `npx vue-tsc --build` passed with 0 errors.
- Backend tests: 54 Rust tests passing in `src-tauri` (`cargo test`).
