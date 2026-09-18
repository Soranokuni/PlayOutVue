# Performance backlog and playout incident notes

Condensed from the 2026-09-18 performance audit (`PERF-HANDOFF.md`, now retired) after its quick wins landed in PR #6 and the playout fix in PR #5. Only what is still open, what was deliberately rejected, and the incident analysis are kept here. Line numbers drift; symbol names are the anchors.

Ground rules for anything below: reliability and identical operator-visible behaviour first. CG templates in `public/templates/playout` and `src/assets/templates/playout` stay byte-identical (`templatesParity.test.ts`). Protected core (`src/services/playout.ts`, `src/services/caspar.ts`, `src/lib/playbackCoordinator.ts`, `src/lib/playoutDispatch.ts`, `src/lib/playoutFailurePolicy.ts`, `src-tauri/src/amcp.rs`, `src-tauri/src/caspar.rs`) needs explicit approval, one PR per item. Run the full `verify-build` pipeline before each PR.

---

## 1. Open items

### Theme A — on-air CG template split (highest on-air value, needs a CasparCG channel)

`public/templates/playout/advisory.html` (6 379 lines, ~300 KB plus 73 KB vendored GSAP) is loaded into CasparCG's CEF on every `CG ADD` and also serves as the studio editor. Verified facts:
- Mode detection runs in an inline `<script>` before render and again on `DOMContentLoaded`; the on-air branch of init **returns early** (no drag-and-drop init, no `localStorage`, no preset dropdown, no `window.play()` auto-start) and `html.on-air` CSS hides every editor surface. The on-air cost today is parse + editor DOM build + one global `resize` listener, not editor logic running.
- Timer sites: `setTimeout` for the explanation hide (~L4257), two `resizeCanvas` timers (studio only), the toast timer (studio only), one more at ~L6329. Verify each has a matching clear in `stop()`.
- GSAP is loaded synchronously in `<head>`; 21 `gsap.*` call sites. The Google Fonts stylesheet is non-blocking (`media="print"` swap) so an offline studio shows a font swap after first paint — self-hosted WOFF2 subsets would remove it.

Plan: build `advisory.html` (on-air: badge, explanation box, fonts, GSAP, `update/play/stop/next`, `sanitizeSvgMarkup`) and `advisory-studio.html` from shared partials with a small `scripts/build-templates.mjs`, extend `templatesParity.test.ts` to assert the on-air file contains no `studio-`/`inspector`/`preset-manager` selectors, keep `cgTemplateName` as the rollback switch, and pixel-compare screen grabs for every rating/badge/warning combination in `esr_presets.json` on a non-production channel. Also: `crawl.html` ticker could be a CSS `@keyframes` translate instead of a rAF loop; the duplicated `src/assets/templates` tree exists only for the parity test and the studio deploy path (pick one source of truth or generate the copy in a build step); `studio_server.rs` reads the template from disk per request (cache keyed by mtime).

### Protected core (approval required)

- **F-02** `caspar.ts updateDisplayedTime`: the 10 Hz `caspar://playback-tick` writes `currentCasparMs` and a formatted `currentCasparTime` string each tick. Format lazily (`computed`) and consider a 250 ms store-facing quantisation while keeping raw ms for the coordinator. Do not change `TICK_THROTTLE_MS`/`WATCHDOG_TICK_MS` without re-checking the end guard.
- **R-3** `caspar.rs prepare_caspar_media_path`: first take of a non-ASCII-named file copies the whole media file under `__sota_caspar/` before `PLAY`. Create aliases at scan/import and preload time, make the take path fail fast to an existing alias, use `std::fs::hard_link` when source and alias share a volume, otherwise copy in the background with a progress diagnostic. Measure `TAKE_INTENT` → `202 PLAY OK` for first and repeat takes.
- **R-5** `push_diagnostic_log` is an IPC round trip per call from tick/advance/take paths (`caspar.ts`), the jank monitor and the ingestor status store; Rust formats before checking the level. Batch info-level pushes every 250 ms into one `push_diagnostic_logs(Vec)` call, keep errors immediate, check the level before `format!`.
- **Foreground-confirmation timeout policy**: on the natural path a confirmation timeout leaves AUTO disarmed until the next verified transition, which later means a cold cut. Review whether a delayed LOADBG is the safer default (the take path already arms on timeout).

### Frontend

- **F-14 part 2**: `defineAsyncComponent` + `v-if` for `TrimPanel`, `MediaInspector`, `CommandPaletteModal` (they interact with keyboard-scope tests; keep `<KeepAlive>` only where reopen cost matters). Use `src/lib/lazyComponent.ts`.
- **F-07** virtualisation: only if a 300-row baseline still shows > 16 ms frames. Try `content-visibility: auto` + `contain-intrinsic-size` on `.rw-row-container` first; a windowed list interacts with SortableJS, PageUp/PageDown, focus retention and `scrollIntoView`.
- **F-10/F-11** library refresh: replace the 30 s full refetch with the ingestor SSE `/api/events` (see `PLAYOUT-CLIENT-DOCUMENTATION.md` §6) or a conditional poll (`X-Total-Count` + max `updated_at`); in `fetchAssets` keep object identity for unchanged assets so per-item caches hold. The poll is already paused while the window is hidden.
- **F-19** `commandRegistry.list()` and `isVisible/isEnabled` per palette render; verify `CommandPaletteModal` search debounce.
- **F-21** `backdrop-filter` on always-visible surfaces (App shell ×3, `main.css` ×2, panel chrome). Keep blur on transient overlays only; use the `--glass-bg` tokens for panels; add `prefers-reduced-transparency`.
- **F-24** 136 KB of CSS: extract shared `.glass-panel`, `.pill`, `.icon-action`, `.toolbar` utilities into `main.css`; clean the 37 `!important`s while touching each block. Verify per theme (5 themes) by screenshot.
- **F-25** perceived performance: disable + progress on Save/Apply during `await invoke` in Settings, DeckLink wizard, Caspar config; optimistic UI for rating/TP updates in the library.
- **F-26** `TrimPanel`: confirm `video.src = ''; video.load()` on close, coalesce scrub seeks (one pending seek, apply last on `seeked`), prefer `requestVideoFrameCallback` for frame stepping; consider keep-alive on the media server so scrubbing does not reconnect per range.
- **F-13** confirm `loading="lazy"`/`decoding="async"` on any `<img>` in `MediaInspector`/preview.
- Unreferenced components `FileBrowserModal.vue` and `ClientDiagnosticsLog.vue`: decide whether they are planned features or dead code. If the diagnostics log is revived, reverse `status.logEntries` once in a computed and cap at 250.

### Backend

- **R-4** `media_index.rs save_index`: whole-index pretty JSON rewritten per mutation under a per-root lock (O(N²) bytes during a scan). Keep the index in memory with a dirty flag and a debounced writer, compact `to_string`, or fold it into the SQLite `media_cache`.
- **R-6** studio server template reads per request (see Theme A).
- **R-7** boot: media server runs on a second dedicated tokio runtime and DB open happens before `tauri::Builder::run`; could move to `.setup()` on Tauri's runtime. Heartbeat back-off while the ingestor is offline was **rejected** (slows "back online" detection) — leave the 5 s cadence.
- **R-8** `filesystem.rs browse_filesystem`: per-entry `metadata()` on network shares blocks a worker for the SMB timeout; wrap in `spawn_blocking` and cap entries.
- **R-9** dev loop: `[profile.dev.package."*"] opt-level = 2`, thin-LTO CI profile, cache `cargo-audit` install in CI.

### Baselines still to capture on operator hardware

Bundle sizes are known (main JS 296 KB, main CSS 100 KB after PR #6). Still needed: time to first frame (the debug-mode `frontend:startup` diagnostic logs mount time), idle CPU of app + WebView2 + CEF with a clip playing and 300 rows visible, FPS/jank from the debug jank monitor, TAKE latency from `TAKE_INTENT` to `202 PLAY OK`, `CG ADD` → badge visible, warm-up time for 1 000 files, JS heap after 8 h.

---

## 2. Rejected after checking the code (do not re-attempt as written)

- **Minute-quantised ETAs** (audit F-01): the ETA column shows `HH:MM:SS`; quantising the wall-clock anchor would freeze visible seconds. The formatters were made cheap instead (byte-identical, tested against Intl).
- **"Remove ETA props from `v-memo`"**: for an on-air playlist the ETAs are anchored to `playStartTime`, so their strings are stable and `v-memo` already holds; only wall-clock-anchored tabs re-render every row, which is the feature.
- **"Frontend polls process status forever"** (audit R-1): false; `refreshProcessStatus` runs on init, after start/stop/restart and on a payload-less event only.
- **Heartbeat back-off while offline** (R-7): delays "ingestor back online" from 5 s to 15–30 s.
- **Integer progress percent** (F-03): a 1 % step is 36 s on a 60-min clip.
- **`structuredClone` / cap 50 for undo** (F-05): not a hot path; the JSON round-trip drops `undefined` fields, which equality checks may rely on.
- **Lower-cased search key** (F-12): a few thousand `toLowerCase` behind a 120 ms debounce is sub-millisecond.
- **Next-up-imminent row glow overlay** (F-06): `.rw-row` already uses both pseudo-elements for drop indicators and the pulse only runs ≤ 10 s before a transition.

---

## 3. Incident 2026-09-18 16:20 — next clip on air after a manual take of a trimmed clip

Fixed in PR #5 (`fix/premature-auto-swap`). Kept here because the workaround must not be "cleaned up" later.

**What happened.** A manual TAKE of clip A (trim-in 2 s) sent `PLAY 1-10 A SEEK 100 LENGTH 1006`; the app sent `LOADBG 1-10 B SEEK 100 LENGTH 1006 AUTO` 26 ms after `PLAY OK`, before A had delivered its first frame. CasparCG (build `bcc084c`) evaluates the AUTO trigger every tick as `frames_left = foreground.nb_frames() - foreground.frame_number() - delta` (delta = 1 for a CUT). `ffmpeg_producer::frame_number()` is `time() - start()` and `AVProducer::time()` returns 0 until the first frame is delivered, so with `start = 100` the `uint32_t` subtraction wrapped and `play()` fired on the first tick. Proof in the CasparCG log: `ffmpeg[…A…|1/1006] Destroyed` right after the LOADBG. B was on air from the take, played its full window, hit EOF and held its last frame; the app still believed A was playing until its monotonic gate opened, then "advanced", updated the CG and accepted OSC position 22 120 ms (B's real end) as the new clip's position (`Position reset window never observed … first accepted pos=22120 ms` in the app log). SEEK/LENGTH values were correct; the ffmpeg "frame properties" warnings are benign.

**Why it was intermittent.** The natural-advance path already waited for `caspar://foreground-confirmed` before the next LOADBG; `playItemAt` did not. The wraparound needs `SEEK > 0`, so untrimmed clips were never affected.

**The fix (keep it).** Rust emits `caspar://foreground-position-confirmed` once a `/file/time` sample inside the new clip's reset window is seen (or the wait is abandoned), which CasparCG only publishes after the first frame. `playItemAt` waits for it before `preloadNextItemAt`, with a 1.5 s timeout that still arms the preload (the race window is closed by then; no preload would mean a cold cut). The natural path prefers the same proof with the path confirmation as fallback. A switch to the preloaded clip more than 1 s before the gate is reported once per registration (`is_premature_auto_switch`: error log, diagnostics ring, `caspar://premature-transition` → fault banner); no PLAY is re-issued. Registration precedes the PLAY command, so a manual take of the preloaded clip cannot trigger a false report.

**Retest recipe.** TAKE a trimmed clip with a next item preloaded and check the CasparCG log: no `|1/1006] Destroyed` for the taken clip, the LOADBG ≥ ~100 ms after `PLAY OK`, and the gapless transition at EOF. Then let two natural transitions between trimmed clips happen in a row.

**Upstream.** The wraparound is a CasparCG bug (`frame_number()` before the first frame with `start > 0`). Not reported upstream as of 2026-09-18; the client-side gate is the mitigation.
