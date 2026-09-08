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

### D. Automated Parity & Cross-Repo Protection
- `src/lib/__tests__/templatesParity.test.ts` enforces 100% byte-for-byte identity between `public/templates/playout/advisory.html` and `src/assets/templates/playout/advisory.html`.
- `tests/contract_boundary.rs` in `PlayoutTranscode` ensures no regressions to upstream/downstream hydration contracts.

---

## 3. Verification Record

- **Frontend Unit & Integration Tests**:
  - Command: `npm test -- --run`
  - Result: **212 passed across 30 test files** (100% passing).
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
  - Result: **66 passed; 0 failed** (including new template baker tests with semicolon tolerance).
- **Cross-Repo Boundary Contract**:
  - Command: `cargo test --manifest-path ../PlayoutTranscode/Cargo.toml --test contract_boundary`
  - Result: **10 passed; 0 failed**.
