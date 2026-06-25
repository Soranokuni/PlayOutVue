# UUID-Based Asset Identity — PlayoutTranscode + PlayOut Harmony Plan

## Current State Audit

### What Already Works (Backend)

| Step | Mechanism | Survives Rename? |
|------|-----------|-----------------|
| Trim re-link | `hydrate_entry_from_index` — fingerprint match (first 64KB) | ✅ Yes |
| UUID preservation | `enrich_entry_from_index_by_alias` — UUID match in media index | ✅ Yes |
| Duration/width/height | Same fingerprint match mechanism | ✅ Yes |
| DB write on first probe | `load_cached_or_probe` → `db.upsert()` after ffprobe | ✅ Writes at current path |
| DB refresh after rename | `hydrate_entry_from_index` → `db.upsert()` at new path | ✅ Yes |
| UUID discovery from video | `run_ffprobe` reads `playoutvue_id` from video tags | ✅ Yes |
| UUID discovery from sidecar | `try_sidecar_uuid` reads `<video>.uuid.json` (next to file) | ✅ When sidecar is co-located |

### What's Broken

| Issue | Root Cause |
|-------|-----------|
| **Compliance/indicator lost on rename** | `mediaDefaults.ts` stores by **file path**, not UUID |
| **Transcode metadata not displayed** | Sidecar JSON has profile/timestamp/source, but scanner reads only UUID from it |
| **Sidecar location mismatch** | PlayoutTranscode writes to `sidecars/` subfolder, PlayOut checks next to video |

### Data Flow Trace (Rename Scenario)

```
Before: C:\Media\show__pbtx.mp4 → compliance set to "K"
After:  C:\Media\renamed.mp4     → rescan

scan_directory for "renamed.mp4":
  1. db.get_valid("renamed.mp4") → None (path changed)
  2. hydrate_entry_from_index → fingerprint: 64KB hash
     → matches old "show__pbtx.mp4" record
     → returns: duration, width, height, trims, UUID ✅
  3. db.upsert → writes at "renamed.mp4" path ✅
  4. Returns DiscoveredMedia with correct metadata ✅

Frontend buildTree:
  5. MediaNode created with playoutvueId = correct UUID
  6. getDefaultCompliance("renamed.mp4") → looks up by PATH
     → "renamed.mp4" not in complianceByPath → returns "none" ❌
  7. "K" badge GONE despite having correct UUID
```

**The fix is purely frontend**: switch `mediaDefaults` to UUID-keyed storage. The backend already handles re-linking perfectly via fingerprint.

---

## Phase A: PlayoutTranscode — Sidecar Co-Location

### The Problem
PlayOut's `try_sidecar_uuid` (`scanner.rs:509`) does `filepath.with_extension("uuid.json")` — looks next to the video file. PlayoutTranscode writes sidecars to `{target}/sidecars/` (separate folder). Sidecar is never found.

### A.1 `processor.rs` — Write sidecar next to output video

Replace the separate `sidecars/` directory approach with co-located sidecars:

```rust
// BEFORE (Phase 2 code — broken)
let video_dir = target_root.join("videos");
let sidecar_dir = target_root.join("sidecars");
let _ = std::fs::create_dir_all(&sidecar_dir);
// ...
let _ = identity::write_sidecar(&sidecar_dir, ...);  // separate folder

// AFTER (co-located with video)
let video_dir = target_root.join("videos");
let _ = std::fs::create_dir_all(&video_dir);
let output_path = video_dir.join(&output_filename);
// ...
let _ = identity::write_sidecar_next_to_video(&result.output_path, ...);
```

### A.2 `identity.rs` — Add `write_sidecar_next_to_video()`

```rust
pub fn write_sidecar_next_to_video(
    output_path: &Path,
    uuid: &str,
    source_probe: &ProbeData,
    output_probe: &ProbeData,
    profile_name: &str,
    target_codec: &str,
    target_audio_codec: &str,
) -> Result<PathBuf, String> {
    let sidecar_path = sidecar_path_for(output_path);  // <video>.uuid.json
    // ... same SidecarPayload construction as write_sidecar ...
    fs::write(&sidecar_path, json)?;
    Ok(sidecar_path)
}
```

Keep `write_sidecar()` and `sidecar_path_in_dir()` for optional archival use, but don't call them from processor.

### A.3 `web-ui/App.vue` — Update PATH card

Dashboard shows: `Watch: ...` and `Videos: {target}/videos/`. Remove `Sidecars:` sub-path since sidecars are now co-located with videos.

---

## Phase B: PlayOut — Backend Sidecar Enrichment

### B.1 `scanner.rs` — Read full SidecarPayload

**Current** (`try_sidecar_uuid` line 509): Reads only `playoutvue_id` from sidecar JSON:
```rust
parsed.get("playoutvue_id").and_then(|v| v.as_str()).map(|s| s.to_string())
```

**Change**: Add `try_sidecar_payload()` that deserializes the full JSON matching PlayoutTranscode's `SidecarPayload` struct. Define a matching local struct:

```rust
#[derive(Deserialize)]
struct SidecarPayload {
    playoutvue_id: String,
    transcoded_at: String,
    profile_used: String,
    original_source: SidecarSource,
    output_media: SidecarOutput,
}
#[derive(Deserialize)]
struct SidecarSource { path: String, codec: String, /* ... */ }
#[derive(Deserialize)]  
struct SidecarOutput { width: i64, height: i64, duration_secs: f64, /* ... */ }
```

Reads `<video>.uuid.json` — now found because PlayoutTranscode writes it co-located (Phase A).

### B.2 `scanner.rs` — Enrich CachedMediaEntry with transcode fields

Add to `CachedMediaEntry`:
```rust
pub transcode_profile: String,
pub transcoded_at: String,
pub original_source_path: String,
```

Update `enrich_entry_with_sidecar` to call `try_sidecar_payload` and populate these fields when a sidecar is found.

### B.3 `db.rs` — Add transcode columns to media_cache

Migration columns (no schema migration needed — `ensure_media_cache_columns` handles it):

```
transcode_profile      TEXT DEFAULT ''
transcoded_at          TEXT DEFAULT ''  
original_source_path   TEXT DEFAULT ''
```

Update `CachedMediaEntry`, `upsert`, `get_valid`, `ensure_media_cache_columns`.

### B.4 `scanner.rs` — Expose transcode fields in DiscoveredMedia

Add to `DiscoveredMedia`:
```rust
pub transcode_profile: String,
pub transcoded_at: String,
pub original_source_path: String,
```

Populate from `CachedMediaEntry` in `scan_directory`. These fields survive renames via the fingerprint-based re-linking that already exists.

### B.5 `scan_directory` — Map new fields

In the `DiscoveredMedia` constructor within `visit_directory` (line 1142-1160), add the three new fields from `entry_meta`.

---

## Phase C: PlayOut — Frontend UUID-Based Metadata

### C.1 `mediaDefaults.ts` — UUID-Keyed Compliance & Indicators

**Current state**:
```typescript
complianceByPath: {} as Record<string, ComplianceRating>  // path-keyed ❌
indicatorByPath: {} as Record<string, LibraryIndicator>   // path-keyed ❌
```

**New state**:
```typescript
complianceByUuid: {} as Record<string, ComplianceRating>
indicatorByUuid: {} as Record<string, LibraryIndicator>
complianceByPath: {} as Record<string, ComplianceRating>  // kept for backward compat
indicatorByPath: {} as Record<string, LibraryIndicator>   // kept for backward compat
```

**Changed methods**:
```typescript
getCompliance(uuid?: string, path?: string): ComplianceRating {
    if (uuid && this.complianceByUuid[uuid]) return this.complianceByUuid[uuid];
    if (path) return this.complianceByPath[normalizePath(path)] || 'none';
    return 'none';
}

setCompliance(uuid?: string, path?: string, rating: ComplianceRating) {
    if (uuid) this.complianceByUuid[uuid] = rating;
    if (path) {
        const normalized = normalizePath(path);
        if (rating === 'none') delete this.complianceByPath[normalized];
        else this.complianceByPath[normalized] = rating;
    }
}
```

Same pattern for `getIndicator` / `setIndicator`.

### C.2 `MediaLibrary.vue` — UUID-Aware Defaults + Cleanup

**Changes**:
- `getDefaultCompliance(node.path)` → `getDefaultCompliance(node.playoutvueId, node.path)`
- `getDefaultIndicator(node.path)` → `getDefaultIndicator(node.playoutvueId, node.path)`
- **Remove**: `hydrateTranscodeMetadata()` function — backend handles this via fingerprint re-linking
- **Remove**: `transcoded`, `transcodeProfile`, `transcodeTimestamp`, `transcodeOriginPath` from `MediaNode` (these were my Phase 4 hacks)
- **Add**: `transcodedAt?: string`, `transcodeProfile?: string`, `transcodeOriginPath?: string` — populated from new `DiscoveredMedia` fields
- **Remove**: `hydrateTranscodeMetadata` call from `rescanLibrary`
- **Remove**: `transcodeVideoPath` from the rescan watch (was: `watch(() => [settings.localMediaPath, settings.liveInputSourceName, settings.transcodeVideoPath], ...)` → back to `watch(() => [settings.localMediaPath, settings.liveInputSourceName], ...)`)
- **Update `buildTree`**: Map `f.transcode_profile`, `f.transcoded_at`, `f.original_source_path` from `scan_directory` results to node fields

### C.3 `MediaTreeNode.vue` — Transcoded Badge from UUID

- `transcodedBadge` computed: show when `node.playoutvueId` is present (UUID = transcoded by PlayoutTranscode)
- Title: `Transcoded by PlayoutTranscode${node.transcodeProfile ? ' · ' + node.transcodeProfile : ''}`
- Same blue badge styling (already implemented)

### C.4 `MediaInspector.vue` — Transcode Metadata Display

When `store.selectedItem.playoutvueId` is present, show:

```
┌─ Transcoded by PlayoutTranscode ──────────────────┐
│ UUID      1234abcd...                              │
│ Profile   ProfileA (if available from scan)        │
│ Timestamp 2026-06-09T12:00:00+00:00               │
│ Source    C:\Media\original_source.mp4             │
└────────────────────────────────────────────────────┘
```

Get `transcodeProfile`, `transcodedAt`, `transcodeOriginPath` from the selected MediaNode in the library tree (find by `playoutvueId`).

### C.5 `SettingsModal.vue` — Keep Transcoding Section

Keep `transcodeVideoPath` and `transcodeSidecarPath` fields. Update hint text:
- Videos: "Where PlayoutTranscode outputs transcoded .mp4 files."
- Sidecars: "Co-located .uuid.json files are read automatically by the scanner when probing transcoded videos."

---

## Files Modified

### `D:\PlayoutTranscode\`

| File | Change |
|------|--------|
| `src\processor.rs` | Write sidecar next to video (not separate folder); remove `sidecar_dir` logic |
| `src\identity.rs` | Add `write_sidecar_next_to_video()` function |
| `web-ui\src\App.vue` | Remove `Sidecars:` sub-path from PATH card |

### `D:\PlayOut\`

| File | Change |
|------|--------|
| `src-tauri\src\scanner.rs` | Add `try_sidecar_payload()`, enrich `CachedMediaEntry` + `DiscoveredMedia` with transcode fields |
| `src-tauri\src\db.rs` | Add transcode columns to schema + `CachedMediaEntry`, update `upsert`/`get_valid` |
| `src\stores\mediaDefaults.ts` | UUID-keyed storage with path fallback |
| `src\components\MediaLibrary.vue` | UUID-aware defaults, remove `hydrateTranscodeMetadata`, clean MediaNode, map transcode fields from `scan_directory` |
| `src\components\MediaTreeNode.vue` | Transcoded badge from UUID + profile |
| `src\components\MediaInspector.vue` | Transcode metadata section (UUID, profile, timestamp, source) |
| `src\components\SettingsModal.vue` | Updated hint text |

---

## Verification

1. **Sidecar co-location**: Drop video in PlayoutTranscode → `videos/show__pbtx.mp4` + `videos/show__pbtx.mp4.uuid.json` exist side by side
2. **UUID survives rename**: Set compliance "K" on `show__pbtx.mp4` → rename to `renamed.mp4` → rescan → "K" badge present
3. **Transcoded badge**: File with playoutvueId shows blue "Transcoded" badge
4. **Transcode metadata**: Select transcoded file → inspector shows UUID, profile, timestamp, source path
5. **Trims survive rename**: Already works (fingerprint-based), no regression test needed
6. **Non-transcoded files unaffected**: Files without UUID get no "Transcoded" badge, path-based compliance fallback works
