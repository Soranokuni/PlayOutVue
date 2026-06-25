# Ingestor API Integration Plan — PlayOutVue

## Design Decisions

| Decision | Choice |
|---|---|
| Asset resolution trigger | **On item add to rundown** (auto-fetch when UUID drops in) |
| `current_path` vs local `path` | **split**: `current_path` → CasparCG playback path; original kept as `displayPath` |
| Ingestor URL persistence | **Dual**: `RuntimeSettingsState` (Rust JSON file) + mirrored in Pinia `settings.ts` |
| Trim semantics | `trim_in_ms` → `inPoint`; `trim_out_ms` → end trim; effective duration used for `LENGTH` |

---

## Task List (dependency order)

### 1. Add `reqwest` to Rust dependencies
- **File**: `src-tauri/Cargo.toml`
- Add `reqwest = { version = "0.12", features = ["json"] }` to `[dependencies]`

### 2. Extend `RuntimeSettings` with Ingestor API URL + persistence
- **Files**: `src-tauri/src/runtime_settings.rs`
- Add field: `ingestor_api_base_url: String` (default `"http://127.0.0.1:8080"`)
- Add JSON file persistence:
  - Config path: `{app_data_dir}/com.playout.client/runtime_config.json`
  - On state init, load from file if exists
  - On `apply_runtime_settings`, save to file
- Add `get_ingestor_api_base_url()` helper for other modules to read

### 3. Create `ingestor_api.rs` — Ingestor REST client module
- **New file**: `src-tauri/src/ingestor_api.rs`
- Struct: `AssetResponse { uuid, fingerprint, current_path, duration_ms, trim_in_ms, trim_out_ms, rating, status }`
- `async fn resolve_asset(uuid: &str, api_base_url: &str) -> Result<AssetResponse, String>`
  - GET `/api/assets/{uuid}`, timeout 5s, returns parsed JSON
- `async fn update_remote_trim(uuid: &str, trim_in_ms: i64, trim_out_ms: i64, api_base_url: &str) -> Result<(), String>`
  - PUT `/api/assets/{uuid}/trim` with JSON body
- `async fn update_remote_rating(uuid: &str, rating: &str, api_base_url: &str) -> Result<(), String>`
  - PUT `/api/assets/{uuid}/rating` with JSON body

### 4. Register Tauri commands in `lib.rs`
- **File**: `src-tauri/src/lib.rs`
- Add `mod ingestor_api;`
- Register commands in `invoke_handler`:
  - `resolve_ingestor_asset` — takes uuid + optional base_url override
  - `update_ingestor_trim` — takes uuid, trim_in_ms, trim_out_ms
  - `update_ingestor_rating` — takes uuid, rating
  - `set_ingestor_api_base_url` — updates RuntimeSettings

### 5. Extend Vue `RundownItem` type with API fields
- **File**: `src/stores/rundown.ts`
- Add fields to `RundownItem`:
  - `ingestorStatus: 'idle' | 'processing' | 'ready' | 'error' | 'missing'` (default `'idle'`)
  - `displayPath: string` (original local path for UI)
- Add `resolveAssetFromApi(uuid)` action to rundown store
  - Invokes `resolve_ingestor_asset` Tauri command
  - Updates item: `path ← current_path`, `duration ← duration_ms/1000`, `inPoint ← trim_in_ms`, `outPoint ← duration_ms - trim_out_ms`, `complianceRating ← rating`, `ingestorStatus ← status`

### 6. Extend `settings.ts` with Ingestor URL
- **File**: `src/stores/settings.ts`
- Add `ingestorApiBaseUrl: 'http://127.0.0.1:8080'`
- `updateSettings` action already handles this
- On `apply_runtime_settings` sync (in `App.vue` watcher), include the new field

### 7. Extend `RuntimeSettings` struct in Rust for the settings sync
- The `App.vue` watcher calls `apply_runtime_settings` with `{ debugEnabled, ffmpegBinPath, ingestorApiBaseUrl }`
- Add the field to `RuntimeSettings` serde struct

### 8. Playback guard — block non-ready status
- **File**: `src/services/caspar.ts`
- In `playAt()` and `cue()`: before sending LOADBG/PLAY, check `item.ingestorStatus !== 'ready'`
- Throw descriptive error if blocked (UI will catch and show toast)

### 9. Rundown list visual indicators
- **File**: `src/components/RundownList.vue`
- Add colored status dot per row:
  - `idle` → no dot (not yet resolved)
  - `ready` → green dot or no indicator (normal)
  - `processing` → yellow dot with pulse animation
  - `error` → red dot
  - `missing` → grey dot

### 10. Media Inspector — remote trim & rating controls
- **File**: `src/components/MediaInspector.vue`
- Show `ingestorStatus` badge prominently
- Add "Fetch from Ingestor" button
- Wire trim inputs to `update_ingestor_trim` Tauri command
- Wire rating selector to `update_ingestor_rating` Tauri command
- Show the `displayPath` (original local path) alongside the resolved CasparCG path

### 11. Ingestor API URL configuration UI
- **File**: `src/components/SettingsModal.vue`
- Add text input for Ingestor API Base URL
- Wire to `localState.ingestorApiBaseUrl` → syncs to Pinia and Rust on save

### 12. App startup — restore persisted Ingestor URL
- **File**: `src-tauri/src/lib.rs` (setup closure)
- On app startup, load `RuntimeSettings` from persisted JSON file
- Emit stored settings to frontend via event or make them available through `apply_runtime_settings` on first call

---

## Validation Checklist

1. `cargo build` passes with `reqwest` added
2. `npm run type-check` passes (Vue TS)
3. Manual test: Set Ingestor URL, add item with UUID → status appears in rundown
4. Manual test: Item with `status: "processing"` → PLAY blocked with error
5. Manual test: Item with `status: "ready"` → PLAY succeeds, rating overlay appears
6. Manual test: Edit trim in inspector → PUT fires, verify via network tab
7. Manual test: Edit rating in inspector → PUT fires, overlay updates

---

## Risks & Open Items

- **Network latency**: Ingestor calls have 5s timeout. If network is slow, resolution may delay rundown population. Mitigation: resolve is async/non-blocking; UI shows `processing` immediately.
- **In-flight race**: User edits trim locally while API resolution is pending. Mitigation: API response only overwrites fields that are still at default (0 for trim, 'idle' for status).
- **No reqwest in `Cargo.toml`** — must be added manually, no breaking changes expected.
