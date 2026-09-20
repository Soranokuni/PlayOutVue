# UI/UX plan — implementation handoff

**For the next agent. You are assumed to have no context from the session that wrote this.**

- Plan: `UI-UX-PLAN.md` (repo root, git-ignored). Findings are referenced below as `F-01` … `F-23` and sections as `§4.2` etc. — those are *its* numbers, and it is the source of truth for anything not covered here.
- **Round 1:** branch `feat/ui-ux-phase-0-1` · PR [#9](https://github.com/Soranokuni/PlayOutVue/pull/9), **merged** (`b366be9`). 14 commits.
- **Round 2 (this one):** branch `feat/ui-ux-phase-3-4` · base `main` (`b366be9`). 5 commits: phases 3.3 and 4.3, the context-menu colour system, the emoji retirement, and the shared popover surface.
- Each commit is phase-or-finding shaped with the reasoning in its message. `git log main..HEAD` is worth reading before you change anything.

Verified at the branch tip: `npm test -- --run` **379 passed / 58 files** · `npm run type-check` clean · `npm run lint` **0 errors** (82 pre-existing warnings, unchanged) · `npm run build-only` clean.

---

## 1. Status by phase

| Phase | Status | What is left |
|---|---|---|
| 0 · Defect fixes | **Done** | — |
| 1 · Foundation | **Done** | — |
| 2 · Settings | **Done** | — |
| 3 · Library and tree | **Partial** | the shared `TreeRow`; folder-tree arrow keys (blocked — §5). **3.3 asset-row anatomy is done.** |
| 4 · Rundown grid | **Done** | — |
| 5 · Control bar | **Done** | — |
| 6 · Theme fidelity | **Partial** | the screenshot matrix has not been run as a matrix |
| 7 · A11y, empty states, copy | **Partial** | the full §9 copy pass. **The emoji are gone (§8).** |

---

## 2. Owner decisions (plan §12), as answered

| # | Question | Decision |
|---|---|---|
| 1 | Fonts | **Self-host** Inter + JetBrains Mono |
| 2 | Themes | **Drop to three** — `soft-slate` and `periwinkle` removed |
| 3 | Minimum window width | **Keep 1100**, collapse the control bar |
| 4 | Hidden settings | **Delete the eight dead ones**, keep the three live ones |
| 5 | Settings navigation | **Left rail** |
| 6 | Language | English chrome + Greek regulatory terms; strings centralised per component for a later `vue-i18n` move |
| 7 | Product name | **Aether** (already consistent in `tauri.conf.json`, `index.html`, `package.json`) |
| 8 | Orphans | **Delete all three**; make the existing `debugMode` panel self-sufficient instead |
| 9 | Library rows | **Single-line default**, two-line opt-in |

### The §12.4 investigation, and its outcome

The owner asked whether the nine "hidden" store fields were still live. They were not, and the reason is worth keeping:

**The live CG pipeline is `settings.cgAdvisoryConfig`.** `services/caspar.ts` renders everything through the `playout/advisory` HTML5 template on layer 32, reading `cgAdvisoryConfig.customLogoSvgPath`, `customRatingSvgPaths`, `ratingHoldSec`, `warningHoldSec` and `styling`. That object is populated by `updateCgAdvisoryFromDeployedPreset()` when CG Studio deploys — the "deploying changes the settings" model already existed.

Deleted (store, `sanitizeSettingsState`, `POSITION_FIELDS`, `ENUM_FIELDS`, the file picker and the Settings UI): `cgRatingKPath`/`8`/`12`/`16`/`18`/`TPPath`, `cgStationLogoPos`, `cgRatingBadgePos`, `cgTPPos`, `cgExplanationBannerPos`, `cgCrawlPos`, `complianceRenderMode`, `cgCrawlPosition`, `cg.stationIdPath`, `logosPath` — plus the dead `getLogosRoot` → `resolveLogoAsset` → `getRatingAssetPath` chain in `caspar.ts`, whose last link had **no callers**. `complianceRenderMode: 'legacy_png'` was unreachable because `caspar.ts` unconditionally clears layers 31/34 and goes HTML5.

Kept: `cg.stationIdEnabled` (gates `clearBranding()` on layer 30, now exposed in Settings › Graphics), `decklinkOutputName` and `liveInputSourceName` (shown read-only in Settings › Hardware; the wizard writes them).

The `settingsHydration` test's layer-geometry case went with the fields it guarded, with a note saying to restore `POSITION_FIELDS` and the test together if geometry ever returns.

---

## 3. What exists now that did not before

Read these before writing new UI — most of what the remaining phases need is already here.

### `src/components/ui/`

| File | Notes |
|---|---|
| `AppIcon.vue` + `icons.ts` | Lucide glyphs (MIT) hand-copied as path data. 24-grid, `currentColor`, no runtime dependency. Decorative by default — an icon-only control carries its own `aria-label`. `vue/no-v-html` is disabled for this file alone in `eslint.config.mjs`, with the reason recorded there. |
| `BaseButton.vue` | `type="button"`, one disabled treatment, and `loading` (disables + spinner) for `await invoke` — perf F-25. |
| `BaseModal.vue` | The one dialog chrome. Focus trap, focus restore, `aria-modal`/`aria-labelledby`, `dirty` → `ask()` before discarding, and Escape that respects OPERATOR-UI-CONTRACT §6. **Initial focus deliberately skips the close button** — DOM order would land there, leaving the operator one keystroke from dismissing Settings. |
| `ModalFooterActions.vue` | Enforces destructive-left, primary-right. Settings used to put Save *left* of Cancel while every other dialog did the opposite. |
| `DangerConfirm.vue` | The single irreversible-action dialog. |
| `RadioCardGroup.vue` | Real `role="radiogroup"`, roving tabindex, arrow keys. Space selects; **Enter is left alone** — the keyboard contract reserves it. |
| `Chip.vue`, `Kbd.vue`, `EmptyState.vue`, `ToastHost.vue` | |

### `src/lib/`

- `describeError.ts` — maps Tauri IPC / HTTP / AMCP / filesystem failures to one operator sentence, keeping the raw text in `detail`. **AMCP rules are tried before HTTP** because the status codes collide: an AMCP `404 PLAY FAILED` is a missing media file, not a missing endpoint.
- `toasts.ts` + `ui/ToastHost.vue` — mounted once from `App.vue`. `aria-live="polite"`. For confirmations and non-blocking notices only; a failure needing a decision still goes through `ask()`.
- `activeContextMenu.ts` — the singleton that makes opening one menu close the last.

### `src/assets/`

- `main.css` — the §3.1 semantic token layer for all three themes: text-on-colour, status, NCRTV ratings with `-fg` pairs, content type, commercial tag, elevation, backdrop, `--z-*` layers, space, radius, type scale, motion.
- `components.css` — shared `.btn`, `.input`, `.select`, `.field`, `.toolbar`, and (round 2) `.popover-surface` / `.popover-item` / `.popover-divider`. Imported once from `main.ts`. (`base.css` was deleted; nothing imported it.)
- `fonts.css` + `public/fonts/` — Inter variable and JetBrains Mono 400/500/700, latin/greek split by `unicode-range`, 164 KB, same-origin so no CSP change.

---

## 4. The guard tests — read these first

Both will fail your PR if you regress. Neither is optional and neither may be loosened.

**`src/lib/__tests__/noLiteralColors.test.ts`** (plan Appendix B) fails on any colour literal in a component's `<style>` or `style=` attribute. Its allowlist is the migration ledger and **may only shrink** — a second test fails if a budget sits *above* the real count, so it cannot rot upward.

Current entries, all deliberate:

| File | Budget | Why it stays |
|---|---|---|
| `ComplianceModule.vue` | 22 | The `.mock-screen-crop` subtree simulates the on-air raster. Its black background and white type are *content* — they must look the same in every theme because the broadcast output does. |
| `SettingsModal.vue` | 9 | The three theme swatches in Appearance. A swatch shows each theme's own palette; the light swatch must look light while the dark theme is active. |
| `TrimPanel.vue` | 2 | Video letterbox and vignette on the scrubber surface. |

(`MediaLibrary`'s ten folder swatches are operator data in `<script>`, outside this guard's surface by construction.)

**`src/lib/__tests__/themeContrast.test.ts`** computes real WCAG ratios from `main.css` for every theme: `--text-muted` and `--text-secondary` against `--bg-secondary`, all six rating chips against their `-fg` tokens, and the filled on-air / error / armed / accent surfaces. AA normal-text (4.5:1) throughout — every pair is small bold text, so the 3:1 large-text allowance does not apply.

Eight pairs failed when it was written. **Three of those eight were found by the test after the palette had already been checked by eye**, which is the whole argument for it. The fixes changed some brand-adjacent values — dark `--status-onair` `#f43f5e`→`#e11d48`, dark `--rating-18` `#ef4444`→`#dc2626`, dark `--rating-tp` `#a855f7`→`#9333ea`, light `--accent-blue` `#0284c7`→`#0369a1`, light `--text-on-warning` to white, and Monokai's 18 badge to dark type on its signature magenta.

> **Open with the owner:** these colour changes were flagged to them and have **not** been signed off visually. If they want different values the constraint is ≥ 4.5:1, not the specific hex. Round 2 added no new colour *values*; it only put existing tokens to new use.

---

## 5. Blocked, and why — do not "fix" this casually

**Folder-tree arrow-key navigation (§5.3) cannot live on the row.**

OPERATOR-UI-CONTRACT §5 gives one capture-phase listener in `composables/useOperatorShortcuts.ts` ownership of every key. In `library` scope it already claims the arrows for `library.selectPrevious` / `library.selectNext` (the *asset* list) with `preventDefault()` and `stopPropagation()`. A row-level `@keydown` never runs.

This was implemented, verified in the browser to never fire, and then removed rather than left as code that looks like it works. The reasoning is recorded in `MediaLibrary.vue` at the point where the next person will look for it.

Doing it properly means new commands in `commandRegistry` (`library.folderNext`, `library.folderExpand`, …) plus a folder cursor on `activeLibraryContext`, routed from the single listener. That is a change to the keyboard contract's surface: **its own PR, with routing tests in `operatorKeyboardRouting.test.ts`.**

---

## 6. Traps this branch already hit

Each of these cost real time. They are not hypothetical.

1. **`v-memo` must sit on the same element as `v-for`.** Moving `v-for` to a `<template>` wrapper silently disables memoization — Vue does not warn at runtime, and the rundown loses its per-row render guard. The day-separator row is rendered *inside* the memoized container for exactly this reason, with `dayBreakBefore(index)` added to the `v-memo` array. The pre-commit ESLint hook caught it (`vue/valid-v-memo`); `npm run lint` piped through `tail` did not, because the error scrolled past.

2. **`CSS.escape` is for identifiers, not quoted attribute values.** `[data-x="${CSS.escape(path)}"]` never matches when `path` contains `/`. The tree focus helper indexes the rendered rows instead.

3. **A theme switch must not be transitioned.** `body { transition: color }` left the computed colour stuck on the *previous* theme's value — near-white text on a white page until something forced a restyle. Verified before/after. Animating `background-color` on the always-visible page surface was a perf-backlog violation besides.

4. **`ResizeObserver`'s first measurement can land before layout.** If the element's box never changes afterwards, no further callback corrects it, so the control bar could stay collapsed at a width that fits everything. `App.vue` re-measures on the next frame and keeps a window-resize listener as a fallback.

5. **`BaseModal` teleports to `<body>`.** Component tests must query the document, not `wrapper.find`. `RecycleBinModal.test.ts` was updated for this when it migrated.

6. **HTML comments cannot sit inside a tag's attribute list.** Two separate template-parse failures came from putting an explanatory comment between attributes.

---

## 7. Pinned selectors and texts — rename only with the test, in the same commit

From plan §0.6, still true: `.rw-list`, `.lib-toolbar`, `.lib-actions-trigger`, `.lib-actions-menu`, `.lib-new-folder-input`, `.lib-folder-pane`, `.lib-asset-pane`, `.lib-pane-divider`, `.settings-tab-btn`, `[data-testid="age-rating-badge"]`, `[data-testid="unrated-badge"]`, `[data-testid="filter-unrated"]`, `[data-testid="ingestor-api-token"]`.

Button texts `Stop Server` and `Restart Server`, and a rail entry whose text contains `Playout`, are asserted by `SettingsModalConfirmation.test.ts`. The Settings rebuild kept `settings-tab-btn` on the *rail* buttons and named the entry "Playout engine" precisely so that test kept passing.

---

## 8. What to do next, in order of value

1. **§8 dialog migrations to `BaseModal`** — `CasparConfigModal`, `DeckLinkWizard`, `TrimPanel` (keep its `data-command-scope="trimmer"` and `@keydown.capture`), `CommandPaletteModal` (top-anchored, special), and the `MediaLibrary` purge dialog → `DangerConfirm`. The *emoji* half of this item is already done (round 2); what remains is the dialog chrome itself.
2. **Folder-tree keyboard navigation** — its own PR, see §5 above.
3. **The shared `TreeRow`** (§5.2/§5.3), used by `MediaLibrary` and `FolderPickerModal` alike.
4. **The screenshot matrix** (Appendix C), now three themes × three densities rather than five × three.
5. **The remaining §9 copy pass.** Done so far: the glossary terms the icon and dialog work already touched, Settings' marketing copy, the gap/live row labels, the README + in-app shortcut tables (both of which claimed "Enter / Space: Take / Play", the exact opposite of the keyboard contract's guard), and round 2's menu terms — "Purge" → "Delete permanently", "Folder Colors" → "Folder colour", "Legacy Tags" → "Commercial tag".

### What round 2 added that you should know about

- **`src/lib/menuTones.ts`** — the one mapping from a compliance value to the
  colour it wears in a menu. Both context menus consume it. If you add a fifth
  vocabulary, add it here, not in a component.
- **`ContextMenu`'s `MenuTone` / `badge` / `swatch`** — a menu row's colour is a
  token name, never a literal. `swatch` exists for the one case that is genuinely
  operator data rather than a theme value: the folder colour palette.
- **`src/composables/usePlaylistFile.ts`** — Save / Load / Append / Clear, with
  **module-scoped** state. The rundown header runs the action and the schedule
  row reports its outcome; two `usePlaylistFile()` calls must see one status
  message, which is why the refs live outside the function.
- **`.popover-surface` / `.popover-item`** in `components.css` — the one
  definition of a floating menu. New popovers opt in rather than restating it.
- **`--surface-popover`** — a real elevation step per theme. A menu is not the
  panel colour.
- **Two new guard tests** — `LibraryRowAnatomy.test.ts` (§5.2's three width
  decisions), `ContextMenuTones.test.ts` (the tone map reaches the DOM),
  `RundownHeaderActions.test.ts` (§6.3's overflow, tab labelling and schedule
  row). `AppIcon.test.ts` now scans eleven files instead of seven, and its
  pending list is down to three icons.

---

## 9. Reproducing the visual checks

Plan Appendix C still applies, with one correction: the seed snippet's `st.theme` no longer accepts `soft-slate` or `periwinkle`.

`.claude/launch.json` has a `vite-dev` entry. Seed the Pinia stores through `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia`. The two `transformCallback` console errors in browser mode are expected and harmless — Tauri IPC is unavailable there.

Note that a Vite HMR reload clears seeded store state, so re-seed in the same evaluation as the assertion you are making.

---

## 10. Repo hygiene notes

- **This file is git-ignored** by `.gitignore:75` (`*handoff*.md`), matching the convention set by `4ad4cd6 chore(repo): untrack agent and internal docs`. It was committed with `git add -f` at the owner's explicit request. If that convention should hold instead, `git rm --cached UI-UX-HANDOFF.md` restores it.
- `src-tauri/Cargo.toml` was already modified in the working tree when this work started and is **not** part of it.
- The CG template files show as modified in `git status` but are **content-identical** — `git diff --numstat` is empty and it is line-ending normalisation only. `templatesParity.test.ts` passes. Plan §0.5 keeps them out of scope; do not commit them.
