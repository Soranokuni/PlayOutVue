# UI/UX polish round 3 — implementation handoff

**For the next agent. You are assumed to have no context from the session that wrote this.**

- Plan: `UI-UX-POLISH-PLAN.md` (repo root, git-ignored). Its section numbers are used below as `§2` … `§7.7`. It is the source of truth for anything not covered here, and it **supersedes `UI-UX-PLAN.md`** wherever the two disagree — it records the owner's reaction to the shipped round-2 result.
- Earlier rounds: `UI-UX-HANDOFF.md` (rounds 1–2, PRs [#9](https://github.com/Soranokuni/PlayOutVue/pull/9) and [#10](https://github.com/Soranokuni/PlayOutVue/pull/10), both merged). Its traps in §8 and its guard-test inventory still apply and were honoured throughout.
- **Round 3 (this one):** branch `feat/ui-ux-polish-round-3` · base `main` (`50d9ecd`). 8 commits.
- Each commit is section-shaped with the reasoning in its message. `git log main..HEAD` is worth reading before you change anything.

Verified at the branch tip: `npm test -- --run` **424 passed / 62 files** · `npm run type-check` clean · `npm run lint` **0 errors** (81 pre-existing warnings, unchanged from `main`'s 82 — one was removed) · `npm run build-only` clean · browser matrix per §9, numbers in section 4 below.

---

## 1. Status by section

| § | What the owner asked for | Status |
|---|---|---|
| 2 | Library toolbar and the `New` control | **Done** |
| 3 | Rundown timing cells (the on-air row) | **Done** |
| 4 | Control bar: fit-driven collapse | **Done** |
| 5.1–5.3 | Playlist file actions and a fool-proof Delete | **Done** |
| 5.4 | Ctrl+S / Ctrl+O / Ctrl+Shift+O | **Done** |
| 6 | Context menu: an icon rail, not a gap | **Done** |
| 7.1 | Surfaces and depth | **Done** |
| 7.2 | One button family | **Partial** — see section 3 |
| 7.3 | Tooltips that teach (`ui/Tooltip.vue`) | **Not started** — see section 3 |
| 7.4 | Motion vocabulary | **Done** (one documented departure, section 2) |
| 7.5 | State legibility without colour | **Done** |
| 7.6 | Typography / type-scale guard | **Done** |
| 7.7 | Empty and loading states | **Done** |

All six of the owner's explicit asks (§1's table) are shipped. What remains is two sections of §7's "make it fancier" brief.

---

## 2. Where the implementation departs from the plan, and why

Three places. Each is a decision the plan could not have made without measuring the running app.

### 2.1 §4.3 — the fit algorithm does not "start one step looser"

The plan's pseudocode starts each pass one step looser than the current step, so the bar expands again when space returns. Implemented literally, that recovers **one rung per resize event**. A resize that ends promptly — a window snap, a maximise, a programmatic width change — delivers few events, so a bar that had collapsed to step 5 sat at step 2 on a 1440 px window with room for step 0. Measured in the browser; that is not a subtle effect.

Since `fitControlBar()` measures the whole ladder anyway (it has to stand on each rung to read its natural width), the loosest fitting rung is already in hand and costs nothing extra. `fitToWidth()` therefore takes no `currentStep` at all and the bar settles in a single pass with no hysteresis to unwind. `fitToWidth.test.ts` pins this with a named regression case.

### 2.2 §7.4 — the playlist tab underline is per-tab, not one sliding element

The plan asks for a single 2 px element that slides between tabs on `transform: translateX`. The tabs are a horizontally scrolling flex row whose widths change with the playlist name, the item count and the `ON AIR` / `DELETING` pill. A single sliding element would need its target position measured and rewritten on every rename, every count change and every scroll of that row — a `ResizeObserver` and a scroll listener for a 2 px line.

Each tab owns its own underline, transitioned on `transform: scaleX()`. Same look, same compositor-only cost, none of the bookkeeping.

### 2.3 §3.2 — progress moved off the row background entirely

The plan says "the red gradient already exists on the row. Keep it", then adds: *"measure, and if `rowProgressPct` updates > 4×/s consider moving the whole progress to the hairline and dropping the background gradient; that is a perf win"*.

`stores/rundown.ts` drives the progress loop on `setInterval(…, 250)` — exactly 4×/s, for the length of every clip, forcing a full paint of the widest row in the app. It also said the same thing as the tint and the left bar. The tint is now a flat colour set by `data-progress-tone`, and progress is the hairline alone. `RundownTimingCell.test.ts` asserts the row carries no inline `linear-gradient`.

### 2.4 Minor: icon-button heights

§2.1 asks for icon-only buttons at 28 / 32 / 36 px across the three density scales. `--btn-h-compact` is already 26 / 30 / 34 and every control in the app derives from it. The stated goal — "hit areas match across the app" — is met by everything using the one token, so the token was left alone rather than shifting every control's height by 2 px for a number. **Change it in `main.css`'s three density blocks if the owner wants the larger targets**; nothing else needs touching.

---

## 3. What is left, and what it would take

### §7.2 — the rest of the button family (~1 day)

Done: `.icon-action` is gone from both files that defined it (`grep -c "\.icon-action" src/components/*.vue` → 0 everywhere; the one hit in `RundownList.vue` is a comment). Every control in the library toolbar, the library header and the rundown header is a `BaseButton`. `BaseButton` gained the press state (§7.2's `translateY(.5px) scale(.985)`).

Not done: `ctrl-btn` (App.vue, ~14 uses), `pl-btn` (PlaylistControls.vue), `crawl-btn` (RundownList.vue), `row-btn` (RundownRow.vue), `panel-toggle-btn`, `ctrl-meta-btn`.

**Why it was left:** `ctrl-btn` is the control bar's button, and this round just rewrote how the control bar measures and sheds its own contents. The fit ladder reads `scrollWidth` at each rung, so it is sensitive to every padding and every `display: none` in that row. Migrating those buttons in the same PR would mean the owner cannot tell a fit-ladder regression from a button-family regression. Do it as its own PR, and re-run the §9 matrix after — the ladder's measured rungs (section 4) are the before-numbers.

`row-btn` is the other one to be careful with: it is inside `RundownRow`, which is `v-memo`'d, so a `BaseButton` there adds a component instance per row × 300 rows. Measure before and after.

### §7.3 — `ui/Tooltip.vue` (~0.5 day)

Not started. Every icon-only control added this round uses native `title=`, which is honest but slow (~1 s) and unstyleable. The plan's spec is complete: 400 ms delay, `.popover-surface`, flip logic borrowed from `ContextMenu`, optional `shortcut` rendered as `Kbd`, `role="tooltip"` + `aria-describedby`.

Call sites waiting for it, all already icon-only with a `title`: `.lib-new-folder-btn`, `.lib-filter-unrated`, `.lib-row-mode-toggle`, `.lib-actions-trigger`, the three `.rw-file-group` buttons, `.rw-delete-btn`, `.rw-overflow-trigger`, `.ctrl-more-btn`, `.conn-action-btn`, `.ctrl-settings-btn`, `.lock-toggle-btn`.

Keep native `title` on row content (asset names, `trimTitle`) — a 1 s delay is fine there and the count matters for perf.

---

## 4. Browser verification, with the numbers

Run per `UI-UX-HANDOFF.md` §9: `preview_start` with the `vite-dev` launch entry. **Note:** Vite reports its own port in `preview_logs`, which may differ from the one `preview_start` returns when 5173 is taken — read the log, not the tool result.

### The control bar's measured ladder (§4, standard density, dark)

| Step | Natural width | What it shed |
|---|---|---|
| 0 | 1405 px | — |
| 1 | 1297 px | `ROUTING` label, `INGEST` word, thin dividers |
| 2 | 1160 px | utilities lose their words |
| 3 | 994 px | long labels → short forms, engine action → glyph |
| 4 | 947 px | NEXT UP dock shrinks |
| 5 | **786 px** | utilities + About + Quick guide → one `⋯` popover |

The last rung is 786 px at **all three** density scales, against a 1100 px minimum window width — so the bar cannot be clipped at any width the app permits. Settled steps: 1100 → 3, 1280 → 1, 1440 → 0, 1920 → 0, with `scrollWidth === clientWidth` at every one.

**These are the regression baseline.** If a later change makes step 5 wider than ~1090 px, the bar can be clipped again and the whole point of §4 is lost.

### Other measured acceptance criteria

- §3.2: `.col-dur` right edge to `.col-at` left edge = **12 px** exactly.
- §3.3: playing and non-playing `.rw-row` heights identical (48 px at comfortable).
- §6.2: every `.menu-item-rail` right edge at the same x; label left edge **12 px** past it, on every row.
- §7.1: `getComputedStyle(.panel-library).backdropFilter === 'none'`.

### Not run as a matrix

The full §9 grid (4 widths × 3 library widths × 3 themes × 3 densities = 108 cells) was not walked cell by cell. What was checked: the control-bar ladder at all three densities, the four window widths, and all three themes (the bar settles at the same step and clips in none of them). The library split width does not affect the control bar — `grid-area: ctrl` spans the shell — which collapses the grid considerably.

What was **not** done: the library pane at 280 / 440 / 640 px was not swept, and the rundown header has no collapse ladder of its own, so at the narrowest library split its right-hand controls scroll rather than shed. That is pre-existing behaviour, not a regression, but §4's treatment would suit it.

---

## 5. Traps this round added

1. **The control bar's fit loop interleaves DOM reads and writes.** `fitControlBar()` sets `el.dataset.step` and reads `el.scrollWidth` in a loop — a deliberate synchronous layout thrash, bounded at 6 iterations and only on resize. Do not "optimise" it by batching the reads: the whole point is that each read happens while standing on that rung. Do not call it from a render or a watcher without `nextTick`.

2. **A `watch` on a computed must come after that computed is declared.** The re-fit watcher (`connectionActionLabel`, `isLiveCutArmed`, …) was originally placed with the rest of the control-bar logic near the top of `App.vue` and threw `ReferenceError: Cannot access 'connectionActionLabel' before initialization` on every mount — `watch` runs its getter once to collect dependencies. It now sits just above `nextUpItemDuration`. If you move it, keep it below every ref it reads.

3. **`el.dataset.step` and `controlBarStep` are two writers of the same attribute.** The template binds `:data-step="controlBarStep"`; the fit loop writes `el.dataset.step` directly while measuring. They converge because the loop's last write is the value it then assigns to the ref. If you probe `data-step` from the console mid-measurement you will read a transient value — that is not a bug.

4. **`scrollWidth` never reports less than `clientWidth`.** So "does it fit" is answerable but "how much room is spare" is not. Every direct child of `.control-bar` has `flex-shrink: 0` for the same reason — a shrinking child would let the bar report that everything fits at any width.

5. **The `v-memo` array in `RundownList.vue` gained two entries** (`rowElapsedLabel`, `rowTotalLabel`) and lost one (`rowTimerLabel`). It stays on the `v-for` element. Any new `RundownRow` prop goes in it, or that row keeps a stale value forever.

6. **`closePlaylist` changed its return type** from `boolean` to `{ playlist, index } | null`. Truthiness is preserved, so existing callers still behave, but anything asserting `=== true` will break.

7. **The context menu's types moved** to `components/contextMenuTypes.ts` so `MenuRow.vue` can import them without a cycle. `ContextMenu.vue` re-exports every name from a plain `<script lang="ts">` block beside its `<script setup>`, so the dozen `import type { MenuItem } from './ContextMenu.vue'` call sites are untouched. Keep the re-export.

8. **`AppIcon.test.ts`'s pending list now contains `more-horizontal`** — it is consumed by the control bar's More popover, which only renders at step 5, and the guard greps sources for the literal name. It is in `App.vue`'s template so it is found; the entry is belt-and-braces and can be removed.

---

## 6. New and changed guard tests

| Test | Guards |
|---|---|
| `lib/__tests__/noLiteralFontSizes.test.ts` **(new)** | §7.6. Sibling of the colour guard, same shrinking-allowlist rule. **Also fails when an entry has slack**, so a budget cannot stop reflecting its file. Four plan-named files plus `MenuRow.vue` are pinned at zero. |
| `lib/__tests__/fitToWidth.test.ts` **(new)** | §4's ladder, including the named regression for 2.1 above. |
| `components/__tests__/RundownTimingCell.test.ts` **(new)** | §3's cell anatomy, the ≤ 10 s parse (including that `-01:05:03` is *not* imminent), and that progress is a transform overlay. |
| `stores/__tests__/playlistLifecycle.test.ts` **(new)** | `closePlaylist` / `restorePlaylist` round-trip, index preservation, refusal cases. |
| `components/__tests__/ContextMenu.test.ts` | +4 cases for §6's row anatomy. |
| `components/__tests__/RundownHeaderActions.test.ts` | Rewritten for §5: the file group, the reduced overflow, and 7 cases for the armed Delete. |
| `components/__tests__/MediaLibraryErgonomics.test.ts` | +4 cases for §2's toolbar. |
| `composables/__tests__/operatorKeyboardRouting.test.ts` | +4 cases for §5.4's chords and their non-collision. |
| `components/__tests__/LibraryNavigation.test.ts` | Updated: `New folder` is in the breadcrumb bar, not the toolbar. |
| `components/__tests__/AppIcon.test.ts` | `ToastHost.vue` added to the scanned set (it owns the Undo glyph). |

---

## 7. Decisions the owner may want to revisit

| Decision | Made here | Alternative |
|---|---|---|
| Delete confirmation depth | Arm (4 s) → click → `DangerConfirm` for non-empty only → toast with 10 s Undo | The plan's §10 offers "skip the modal entirely and rely on Undo". The arm plus Undo may already be enough; the modal is one line to remove. |
| Tab `×` | Only on **empty** tabs | Plan §10 offers keeping it on all non-on-air tabs. |
| Countdown colour | `--status-onair`, `--status-warning` under 10 s | Plan §10 offers keeping green. |
| Control bar `⋯` | Only at step 5 | Plan §10 offers always showing it. |
| The header overflow's contents | Rename, Duplicate, Clear all items | Plan §10 offers dropping it and moving Clear into the tab context menu. `Export as text list…` (P2, optional) was not built. |
| Icon-button heights | Left at `--btn-h-compact` (26/30/34) | §2.1's 28/32/36 — see 2.4 above. |

---

## 8. If you pick this up

1. Read `git log main..HEAD` on `feat/ui-ux-polish-round-3`. Eight commits, each one section, each message explaining the defect before the fix.
2. Re-read `UI-UX-HANDOFF.md` §8 (round 1–2 traps) — they are all still live, particularly the `v-memo` rule and the capture-phase keyboard listener.
3. Start with §7.3 (`Tooltip.vue`). It is self-contained, it has a complete spec, and every call site is already an icon-only button with a `title` to replace.
4. Leave §7.2's `ctrl-btn` migration for its own PR, and re-measure the ladder in section 4 afterwards.
