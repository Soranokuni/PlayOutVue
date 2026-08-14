# PlayOutVue V2-16 Ingestor Adapter & Cross-Repository Integration Design

## Baseline & Working Tree Status

- **Repository Path**: `D:\PlayOut`
- **Branch**: `main`
- **Baseline HEAD SHA**: `575367e95448669d3a5f02869c425dd4fa730870`
- **Working Tree**: Completely clean (`git status --short` is empty)

---

## 1. Vitest Investigation & Root Cause Analysis

### Background & Observed Symptoms
When running `npm test` (`vitest run`), 19 unit test files pass cleanly (139 tests), while 5 component test suites fail before executing any tests:
1. `src/components/__tests__/CommandPalette.test.ts`
2. `src/components/__tests__/LibraryNavigation.test.ts`
3. `src/components/__tests__/RatingBadgeOwnership.test.ts`
4. `src/components/__tests__/RundownAutoScroll.test.ts`
5. `src/components/__tests__/StatusIndicatorIntegration.test.ts`

Stack trace:
```text
Error: Failed to parse source for import analysis because the content contains invalid JS syntax. Install @vitejs/plugin-vue to handle .vue files.
  Plugin: vite:import-analysis
  File: D:/PlayOut/src/components/CommandPaletteModal.vue:223:9
```

### Deep Root Cause Analysis
1. **Vitest Config Isolation**:
   - `vite.config.ts` configures `plugins: [vue(), vueDevTools()]`.
   - `vitest.config.ts` defines its own configuration using `defineConfig` from `vitest/config`.
   - In Vitest v4, providing an explicit `vitest.config.ts` overrides default `vite.config.ts` discovery.
   - `vitest.config.ts` defines `@` alias and `test: { environment: 'node' }`, but **omits `plugins: [vue()]`**.
2. **Component vs Pure TypeScript Test Partition**:
   - All 19 passing test suites test pure TypeScript modules in `src/lib/` and `src/composables/` without importing `.vue` Single File Components.
   - All 5 failing test suites import `.vue` files and mount them using `@vue/test-utils` under `// @vitest-environment happy-dom`.
   - Without `@vitejs/plugin-vue` in `vitest.config.ts`, Vite's transformer has no SFC compiler registered and attempts to parse `<template>` and `<script>` blocks as vanilla JavaScript.
3. **Environment & Dependency Compatibility**:
   - `package.json` already contains `@vitejs/plugin-vue: ^6.0.7`, `@vue/test-utils: ^2.4.11`, `happy-dom: ^20.11.2`, and `vue: ^3.5.29`.
   - The five component test files already specify `// @vitest-environment happy-dom` at line 1.
4. **Planned Fix (for Phase 2 implementation)**:
   - Import `vue` from `@vitejs/plugin-vue` in `vitest.config.ts` and provide `plugins: [vue()]`.

---

## 2. Audit of Current V1 Ingestor Client

### Files Involved
- `src-tauri/src/ingestor_api.rs`: Tauri IPC commands and HTTP client communicating with PlayoutTranscode.
- `src/stores/mediaLibrary.ts`: Pinia store maintaining `LibraryAsset` records, folder hierarchies, and selection state.
- `src/stores/ingestorStatus.ts`: Store tracking online/offline status and diagnostic log streams.
- `src/components/MediaInspector.vue`: UI panel displaying asset metadata, trim points, and transcoder details.

### Existing V1 Endpoints Called
- `GET /api/health`: Ingestor health check.
- `GET /api/assets`: Full asset list.
- `GET /api/assets/{uuid}`: Single asset retrieval.
- `POST /api/assets/{uuid}/trim`: Persist trim in/out points.
- `POST /api/assets/{uuid}/rating`: Persist age compliance rating.
- `POST /api/assets/{uuid}/subclip`: Create virtual subclip.
- `POST /api/assets/{uuid}/tp`: Set true peak metadata.
- `POST /api/assets/{uuid}/purge`: Delete asset and clean storage.
- `GET/POST /api/folders/colors`: Virtual folder color registry.

### Existing V1 Data Transfer Object (`AssetResponse`)
```rust
pub struct AssetResponse {
    pub uuid: String,
    pub current_path: String,
    pub duration_ms: i64,
    pub trim_in_ms: i64,
    pub trim_out_ms: i64,
    pub rating: String,
    pub tp: String,
    pub status: String,
    pub display_name: Option<String>,
    pub virtual_folder: Option<String>,
    pub mezzanine_ok: Option<bool>,
    pub fps: Option<f64>,
    pub fps_num: Option<i64>,
    pub fps_den: Option<i64>,
    pub total_frames: Option<i64>,
    pub gop_frames: Option<i64>,
    pub keyframe_safe_start_ms: Option<i64>,
    pub warnings: Option<Vec<String>>,
    pub playoutvue_id: Option<String>,
}
```

---

## 3. V2 Adapter & Ingestor Client Architecture

```
                                  ┌────────────────────────────────┐
                                  │      PlayoutTranscode V2       │
                                  │   /api/v2/* & /api/v2/events   │
                                  └───────────────┬────────────────┘
                                                  │ (SSE / REST)
                                                  ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             PlayOutVue Tauri Backend                             │
│                                                                                  │
│  ┌─────────────────────────┐               ┌──────────────────────────────────┐  │
│  │   V2 Ingestor Client    │ ──fallback──> │        V1 Legacy Client          │  │
│  │ (/api/v2/assets, events)│   (if 404)    │      (/api/assets, /health)      │  │
│  └────────────┬────────────┘               └─────────────────┬────────────────┘  │
│               │                                              │                   │
│               └──────────────────────┬───────────────────────┘                   │
│                                      ▼                                           │
│                       ┌─────────────────────────────┐                            │
│                       │  Unified State & QC Mapper  │                            │
│                       │ (Strict Readiness Predicate)│                            │
│                       └──────────────┬──────────────┘                            │
└──────────────────────────────────────┼───────────────────────────────────────────┘
                                       │ (Tauri IPC Event / Command)
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                Vue Frontend Layer                                │
│                                                                                  │
│  ┌────────────────────────┐  ┌───────────────────────┐  ┌─────────────────────┐  │
│  │   useMediaLibraryStore │  │ useIngestorStatusStore│  │ MediaInspector.vue  │  │
│  │ (Reactive LibraryAsset)│  │ (Reconnection States) │  │  (QC & Loudness)   │  │
│  └────────────┬───────────┘  └───────────────────────┘  └─────────────────────┘  │
│               │                                                                  │
│               ▼ (Immutable Contract Hand-off)                                    │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ PROTECTED BOUNDARY: Rundown, Take, Trimming, CasparCG AMCP Dispatch Engine │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### V2 Typed Data Transfer Objects (Rust Backend)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V2AssetDto {
    pub uuid: String,
    pub playoutvue_id: String,
    pub current_path: String,
    pub duration_ms: i64,
    pub trim_in_ms: i64,
    pub trim_out_ms: i64,
    pub fps_num: i64,
    pub fps_den: i64,
    pub mezzanine_ok: bool,
    pub status: String,
    pub display_name: Option<String>,
    pub virtual_folder: Option<String>,
    pub rating: Option<String>,
    pub tp: Option<String>,
    pub qc_report: Option<V2QcReportDto>,
    pub loudness: Option<V2LoudnessDto>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V2QcReportDto {
    pub passed: bool,
    pub blocking_errors: usize,
    pub warnings_count: usize,
    pub findings: Vec<V2QcFindingDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V2QcFindingDto {
    pub severity: String, // "info" | "warning" | "error"
    pub code: String,
    pub message: String,
    pub measured: Option<String>,
    pub expected: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V2LoudnessDto {
    pub integrated_lufs: Option<f64>,
    pub true_peak_dbtp: Option<f64>,
    pub lra_lu: Option<f64>,
    pub mode: Option<String>,
}
```

---

## 4. Strict Readiness Predicate & Fallback Rules

### Strict Readiness Predicate
An asset is evaluated as playable (`ready`) **if and only if all** of the following evaluate to `true`:
1. `backend_status == "ready"` or `phase == "completed"`.
2. `mezzanine_ok == true`.
3. `!current_path.is_empty()`.
4. `!current_path.contains(".tmp_")` and `!current_path.starts_with(".tmp")`.
5. `duration_ms > 0`.
6. `trim_in_ms >= 0 && trim_out_ms > trim_in_ms && trim_out_ms <= duration_ms`.
7. `fps_num > 0 && fps_den > 0`.
8. `qc_report.blocking_errors == 0` (no blocking QC findings present).

If any check fails, the asset status in PlayOutVue is mapped to `'processing'` or `'error'` and is flagged non-playable.

### Fallback Invariant
- **Transport Fallback**: If PlayoutTranscode returns HTTP 404 or connection error for `/api/v2/*`, PlayOutVue gracefully falls back to `/api/health` and `/api/assets` (V1).
- **No Error Masking**: A definitive V2 validation failure (`mezzanine_ok == false` or blocking QC errors) **NEVER** falls back to V1 to force an asset into a ready state.
- **V1 Compatibility**: Existing V1 assets continue to hydrate with default rational FPS and safe trim defaults.

---

## 5. Event Stream (SSE) Reconnection & State Refresh

- The client subscribes to `GET /api/v2/events`.
- Tracks `last_event_id` to prevent duplicate event processing across reconnects.
- On disconnect/reconnect:
  1. Issues an immediate `GET /api/v2/assets` snapshot request to reconcile full state.
  2. Merges fresh state atomically into `useMediaLibraryStore`.
  3. Re-establishes SSE listener with updated `Last-Event-ID` header.

---

## 6. Protected Playout Boundaries (Immutable)

The following core modules are strictly protected and **must not be modified** during the V2 integration:
- `src/lib/playoutDispatch.ts`: Direct AMCP playout command generator.
- `src/services/caspar.ts`: CasparCG socket and OSC listener connection manager.
- `src/lib/trimCommands.ts` & `src/lib/trimController.ts`: Frame-accurate broadcast rational trimming calculations.
- `src/stores/rundown.ts`: Rundown state, Take sequencing, CUE/LOADBG lifecycle, and playlist execution.

---

## 7. Verification Test Plan (16 Test Cases)

1. **V2 Ready Asset Hydration**: Verify valid V2 asset payload hydrates cleanly into `LibraryAsset`.
2. **V2 Processing Phase Mapping**: Verify `Probing`, `Encoding`, `NormalizingAudio`, and `Publishing` map accurately to UI badges.
3. **V2 Validation Error Isolation**: Verify `mezzanine_ok=false` remains non-playable.
4. **Missing Final Path Gate**: Verify empty `current_path` prevents ready state.
5. **Temporary Path Rejection**: Verify `.tmp_{uuid}` paths are rejected as non-playable.
6. **Rational FPS Validation**: Verify `fps_num=0` or `fps_den=0` blocks playout readiness.
7. **V1 Fallback on 404**: Verify graceful fallback to `/api/assets` when V2 is missing.
8. **V1 Fallback Exclusion on QC Failure**: Verify definitive QC error does not fall back to V1.
9. **SSE Deduplication**: Verify duplicate event IDs are dropped.
10. **Reconnect State Refresh**: Verify snapshot fetch reconciles library upon reconnect.
11. **QC Findings Display**: Verify structured warnings/errors render in `MediaInspector.vue`.
12. **Loudness Telemetry Display**: Verify integrated LUFS and true peak render when present.
13. **Loudness Telemetry Omission Tolerance**: Verify legacy assets without loudness render cleanly.
14. **Take & Rundown Behavior Unaltered**: Verify Rundown Take execution is bit-identical.
15. **Trim Calculation Parity**: Verify `compute_frame_trim` outputs identical frames for 25fps and 50fps.
16. **End-to-End Playout Pipeline**: Real end-to-end integration test from ingest event to CasparCG `PLAY 1-1 "..." SEEK ... LENGTH ...` dispatch.

---

## 8. Changed Files, Protected Files & Stop Conditions

### Changed Files Proposed
- `vitest.config.ts`: Add `plugins: [vue()]` to resolve SFC parser in Vitest.
- `src-tauri/src/ingestor_api.rs`: Implement V2 DTOs, `/api/v2` endpoints, and strict readiness mapper.
- `src/stores/mediaLibrary.ts`: Add V2 QC findings and loudness fields to `LibraryAsset`.
- `src/components/MediaInspector.vue`: Display V2 QC findings and loudness metadata.
- `src-tauri/tests/v2_ingestor_adapter_test.rs`: Comprehensive Rust integration tests.
- `docs/V2-16-PLAYOUTVUE-INTEGRATION-HANDOFF.md`: Final integration handoff documentation.

### Protected Files
- `src/lib/playoutDispatch.ts`
- `src/services/caspar.ts`
- `src/stores/rundown.ts`
- `src/lib/trimController.ts`

### Verification Commands
```bash
# Frontend type check and tests
npm run type-check
npm test
npm run build

# Tauri backend tests
cd src-tauri
cargo check
cargo test
```

### Explicit Stop Conditions
- Any regression in existing 139 Vitest tests or 46 Tauri unit tests.
- Any change to CasparCG AMCP command formatting strings.
- Any condition allowing an asset with `.tmp_` path or `mezzanine_ok == false` to become ready.
