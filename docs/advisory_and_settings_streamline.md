# Broadcast CG Studio & Playout Settings Streamlining

## 1. Overview & Problem Analysis

This document details the architectural fixes and UI/UX consolidation for the **CasparCG Broadcast Graphics Engine** (Layer 32 Greek ESR Advisory & Station ID bug, Layer 33 Crawl) across `advisory.html`, the Tauri Rust backend, and `SettingsModal.vue`.

### Historical Issues Identified

1. **"Save" Acted as "Save As"**:
   - In `public/templates/playout/advisory.html`, `saveCurrentActivePreset()` checked:
     ```javascript
     if (!currentMasterPresetId || !String(currentMasterPresetId).startsWith('preset_')) {
       openSaveAsDialog();
     }
     ```
   - When editing the standard preset (`'default'`) or any broadcast standard preset (`'live'`, `'movie'`, etc.), clicking **💾 Save** was blocked from overwriting and unconditionally popped open the modal "Save As" dialog, forcing the operator to create a new preset name rather than saving in-place.

2. **Reverting to Circular Logo on Settings Deploy**:
   - When an operator changed the logo chassis and rating badge to **squircle**, saved, and deployed from `advisory.html`, deploying again from Playout Settings (`SettingsModal.vue`) reverted the on-screen badge back to **circle**.
   - **Root Causes**:
     - `src/stores/settings.ts`: `DEFAULT_CG_ADVISORY_CONFIG.badgeShape` was hardcoded to `'circle'`.
     - `SettingsModal.vue`: Initialized its local shadow state with `badgeShape: 'circle'` and rendered duplicate dropdowns for theme, stencil style, and badge shape. When the user saved preferences in the Settings modal, it overwrote Pinia with `'circle'`.
     - During playout advances, `casparPlayoutService.applyComplianceForItem()` sent `styling: settings.cgAdvisoryConfig`. In `advisory.html`, `applyStylingVariables(style)` received `style.badgeShape = 'circle'` and called `setRatingShape('circle', true)`, forcing CasparCG back to circular geometry.
     - `deploy_caspar_templates` in Rust originally deployed `TEMPLATE_ADVISORY` without dynamically baking the saved preset when called from Settings if disk reading failed.

3. **"Set Default" Reliability**:
   - `markActivePresetAsDefault()` did not reliably persist across all execution contexts (e.g. running from `file:///` where browser CORS blocks relative `fetch` calls, or when the bridge server was bound to alternate ports).

4. **UI/UX Duplication & Clutter**:
   - In `advisory.html`: Duplicate "Save As" and "Deploy to CasparCG" buttons appeared in both the top preset bar and the bottom footer.
   - In `SettingsModal.vue`: "Deploy CG Templates" was placed on the "Playout" tab while "Open CG Studio" was on the "CG & Layouts" tab. Furthermore, the CG tab contained a redundant, desynchronized mini-editor that offered poor controls compared to the full WYSIWYG studio.

---

## 2. Architectural Changes & Solutions

### A. Non-Modal Direct Overwrite for "Save"
- Modified `saveCurrentActivePreset()` in `public/templates/playout/advisory.html` to execute in-place overwriting:
  - If the active preset is a user custom preset (`preset_...`), it updates the record in `PLAYOUT_USER_PRESETS` in `localStorage`.
  - If the active preset is `'default'`, it updates `MASTER_STANDARD_PRESETS['default']` and saves `PLAYOUT_DEFAULT_PRESET_PACKAGE`.
  - If the active preset is a standard preset (`live`, `movie`, `show`, etc.), it updates `MASTER_STANDARD_PRESETS[id]` and persists `PLAYOUT_STANDARD_PRESET_<id>`.
  - Asynchronously posts the captured package to the Studio Bridge (`/api/save-default-preset`), saving `advisory_default_preset.json`, baking the default preset into `advisory.html`, and deploying to CasparCG.
  - Never triggers `openSaveAsDialog()`. The dedicated **⭐ Save As...** button handles new preset creation.

### B. Squircle As Default & End-to-End Persistence
- **Canonical Default**: `advisory_default_preset.json` specifies `"logoShape": "squircle"` and `"badgeShape": "squircle"`.
- **Static SVG Stencils**: Updated static SVG elements (`#badge-mask-shape` and `#badge-main-shape`) in both `public/templates/playout/advisory.html` and `src/assets/templates/playout/advisory.html` to render squircle rectangles (`rx="16" ry="16"`).
- **Store & Pinia Defaults**: Updated `DEFAULT_CG_ADVISORY_CONFIG` in `src/stores/settings.ts` to `badgeShape: 'squircle'` and `logoShape: 'squircle'`.
- **Rust Template Baker**: Enhanced `src-tauri/src/studio_server.rs` with `bake_preset_into_template_content` and `bake_preset_into_template_files` to ensure both `public/` and `src/assets/` copies of `advisory.html` have the latest preset baked into `let BAKED_DEFAULT_PRESET = ...;`.
- **Live Event & Focus Synchronization**:
  - `SettingsModal.vue` listens to `caspar://template-deployed` via Tauri event listener, updating `localState.value.cgAdvisoryConfig` in real time.
  - `SettingsModal.vue` listens to window `focus`, querying `get_studio_default_preset` whenever the operator returns from an external browser window.
  - `saveSettings()` invokes `save_studio_default_preset` with `localState.value.cgAdvisoryConfig`, keeping disk and memory in lockstep.

### C. Unified Playout & CG Action Center in `SettingsModal.vue`
- **Playout & Hardware Tab**:
  - Added the **Broadcast CG Graphics & Template Studio** action center directly under CasparCG Server Configuration.
  - Placed **✨ Open CG Studio (Visual Editor)**, **🚀 Deploy CG Templates to CasparCG**, and **📂 Open Templates Folder** together in the same section on the Playout path.
  - Added live status pills showing active badge shape (`Squircle`), Layer 32 template identifier, and Station ID bug status.
- **CG & Layouts Tab**:
  - Features the identical unified action center alongside CG HTML5 Template Identifiers (`playout/advisory` for Layer 32, `playout/crawl` for Layer 33).
  - **Eliminated Obsolete Mini-Editor**: Completely removed the mock screen canvas, safe-area overlay boxes, coordinate dragging scripts (`onDragStart`, `onDragMove`, `onDragEnd`), preset position buttons (`applyPositionPreset`, `resetAllLayersToStandard`), and ~180 lines of unused CSS.

### E. Studio Bridge PNA & Same-Origin HTTP Serving
- **Private Network Access (PNA) Support**: Added `Access-Control-Allow-Private-Network: true` to both `OPTIONS` preflight and standard HTTP responses in `src-tauri/src/studio_server.rs`, allowing browsers accessing via `file:///` to communicate with the local bridge on `127.0.0.1:6258/6259`.
- **Content-Type text/plain**: Updated `postToBridge()` in `advisory.html` to send `Content-Type: text/plain` payload strings parsed cleanly by `serde_json`, avoiding browser CORS preflight restrictions on simple POST requests.
- **Same-Origin Studio HTTP Serving**: Enhanced `src-tauri/src/studio_server.rs` to natively serve `GET /studio`, `/playout/advisory.html`, `/vendor/gsap.min.js`, and sidecar JSON files. `open_cg_studio_in_browser` opens `http://127.0.0.1:{port}/studio` directly, granting the editor 100% same-origin HTTP access and eliminating all browser file-origin sandbox restrictions.

### F. Playout In-Place Live Updates & CEF Stability
- **Layer 32 In-Place CG Updates**: In `src/services/caspar.ts`, when `caspar://template-deployed` is received and Layer 32 is already loaded, updates are issued via `caspar_cg_update` (`window.update(cgData)`) rather than destructive `CLEAR` + `CG ADD` cycles. This avoids tearing down CEF instances and DirectX shared textures, preventing texture deadlocks and layer freeze-ups.
- **Event Debounce**: Added 120ms debounce on template deployment events to prevent concurrent AMCP commands when backend operations synchronize settings.
- **Synchronous Frame 0 On-Air Execution**: In `advisory.html`, `DOMContentLoaded` differentiates between `studio` and `on-air` modes. In `on-air` mode, the baked preset is applied synchronously at frame 0 and asynchronous HTTP bridge polling (`hydrateDefaultPreset`) is bypassed, ensuring CasparCG runtime updates are never overwritten by delayed background network fetches.

### G. Greek Broadcast Font Family Resolution & Elimination of Latin-Only Fonts
- **Elimination of Non-Greek Fonts**: Google Fonts `Outfit` lacks Greek character set support (`greek`/`greek-ext`), causing Greek compliance strings (e.g. "ΤΟ ΠΡΟΓΡΑΜΜΑ ΠΕΡΙΕΧΕΙ", "ΣΚΗΝΕΣ ΒΙΑΣ", Greek rating badges) to fall back to broken serif typefaces in Chromium/CEF.
- **`resolveFontFamily()` & Native System Stack**: Implemented canonical Greek-safe typography across `advisory.html` and `src/stores/settings.ts`, mapping `"system"`, `"default"`, or empty selections to `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
- **Google Fonts Greek Subsets**: Updated Google Fonts stylesheet `<link>` in `advisory.html` to load Inter, Montserrat, Roboto, and Roboto Mono with explicit `&subset=greek,greek-ext,latin`.
- **Sidecar Preset Standardization**: Updated `advisory_default_preset.json` to define canonical `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif` instead of `Outfit`.

### H. Raw TCP Socket Segmentation & Full Request Buffering
- **Content-Length Loop Buffering**: In `src-tauri/src/studio_server.rs`, replaced single `stream.read(&mut buf)` with `read_http_request` which parses `Content-Length` and continuously accumulates TCP segments until the full HTTP body is buffered.
- **Elimination of Incomplete Body Fallback**: Fixed the race condition where split TCP segments caused `POST /api/deploy` to see an empty or truncated body, falsely falling back to loading the old preset from disk and locking graphics onto previous shapes (e.g. Shield).

### I. Script Syntax & SVG Mask DOM Stability
- **Eliminated Duplicate Script Declarations**: Removed duplicate `let currentShowTag`, `let currentMasterPresetId`, `let currentLogoShape`, `let currentRatingShape` which triggered a fatal `SyntaxError` in `advisory.html` under modern ECMAScript engines.
- **Direct Geometry Rect Mutation**: Updated `setRatingShape` to update `rx`/`ry` attributes directly on `<rect>` elements without detaching or replacing SVG mask DOM nodes, eliminating Chromium GPU mask cache invalidation glitches.
- **Hydration Ordering & Settings Synchronization**: In `SettingsModal.vue`, synchronized studio presets prior to invoking `reloadComplianceTemplate`, refreshed presets before saving to avoid stale shadow state overwrites, and hydrated active presets into Pinia on `App.vue` startup.

---

## 3. Verification Record

- **Frontend Unit & Integration Tests**:
  - Command: `npm test -- --run`
  - Result: **213 passed across 30 test files** (100% passing, including `templatesParity.test.ts` with script syntax validation).
- **TypeScript Strict Compilation**:
  - Command: `npm run type-check` (`vue-tsc --build`)
  - Result: **0 errors**.
- **Client Production Build**:
  - Command: `npm run build`
  - Result: Clean production bundle compiled into `dist/` with 0 errors.
- **Rust Backend Compilation & Tests**:
  - Command: `cargo check --manifest-path src-tauri/Cargo.toml`
  - Result: Compiled cleanly with **0 errors**.
  - Command: `cargo test --manifest-path src-tauri/Cargo.toml`
  - Result: **67 passed; 0 failed** (including chunked/split TCP body streaming tests).
- **Cross-Repo Boundary Contract**:
  - Command: `cargo test --manifest-path ../PlayoutTranscode/Cargo.toml --test contract_boundary`
  - Result: **10 passed; 0 failed**.
