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
- **Live Event Synchronization**: Emits `caspar://template-deployed` carrying the active preset payload; `src/services/caspar.ts` listens and invokes `settingsStore.updateCgAdvisoryFromDeployedPreset(preset)`.
- **Settings Modal Hydration**: On `onMounted` in `SettingsModal.vue`, queries `get_studio_default_preset` from the Rust backend to ensure local shadow state stays in sync with CG Studio.

### C. UI/UX Consolidation in `SettingsModal.vue`
- **Playout Tab**: Removed the redundant "Deploy CG Templates" button from the CasparCG Server Configuration section, keeping that section focused on core server process management and OSC port configuration.
- **CG & Layouts Tab**:
  - Replaced the fragmented layout and redundant mini-editor with a consolidated **Broadcast CG Graphics & Template Studio** hero section.
  - Placed **✨ Open CG Studio (Visual Editor)** and **🚀 Deploy CG Templates to CasparCG** side-by-side in the same section, alongside **📂 Open Templates Folder**.
  - Added visual status badges showing active shape (Squircle), Layer 32 (Greek ESR Advisory), and Station ID bug status.
  - Preserved clean template identifier inputs (`playout/advisory` for Layer 32, `playout/crawl` for Layer 33) and the On-Screen Graphic Positioning Studio with broadcast safe-area overlay guides.
  - Removed ~115 lines of dead mini-editor code and manual SVG overrides that caused state desynchronization.

### D. Automated Template Parity Enforcement
- Added `src/lib/__tests__/templatesParity.test.ts` to ensure `public/templates/playout/advisory.html` and `src/assets/templates/playout/advisory.html` remain 100% byte-identical on every commit and build.

---

## 3. Verification & Test Evidence

All automated verification pipelines passed with zero errors:

1. **Frontend Unit & Integration Tests**:
   - `npm test -- --run`: **212 passed across 30 test files** (including template parity and compliance tests).
2. **TypeScript Compilation**:
   - `npm run type-check` (`vue-tsc --build`): **0 errors**.
3. **Production Client Bundle**:
   - `npm run build`: Clean production build in `dist/`.
4. **Rust Backend Check & Tests**:
   - `cargo check --manifest-path src-tauri/Cargo.toml`: **0 errors**.
   - `cargo test --manifest-path src-tauri/Cargo.toml`: **63 passed; 0 failed**.
5. **Cross-Repo Boundary Contract**:
   - `cargo test --manifest-path ../PlayoutTranscode/Cargo.toml --test contract_boundary`: **10 passed; 0 failed**.
