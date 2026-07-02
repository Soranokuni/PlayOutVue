<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# The output was cut, format it well and give me again the fixes, scan the repo find the issues to create the best sota playout, especially in caspar.rs ts etc. @GitHub [https://github.com/Soranokuni/PlayOutVue](https://github.com/Soranokuni/PlayOutVue) and do not break how the program works alongside its sister program [https://github.com/Soranokuni/PlayoutTranscode](https://github.com/Soranokuni/PlayoutTranscode)

All confirmed. Now I have the complete, verified current state of the live repo. Here is the final audit and consolidated fix plan.

# PlayOutVue — Verified Current State \& Final Fix Plan

I pulled the live files directly (`caspar.ts`, `rundown.ts`, `caspar.rs`) rather than relying on the earlier commit diff, so this reflects exactly what's deployed right now. Most P0 fixes landed correctly. Four real problems remain, ranked by severity.

## Verified Fixed (No Action Needed)

| Fix | Status |
| :-- | :-- |
| Rust zero-duration guard in `caspar_register_playback` | ✅ Confirmed present — `if duration_ms == 0 { return Ok(()); }` |
| EOF-watchdog only fires near expected out-point | ✅ Confirmed — gated by `position_ms >= expected_out_point_ms - 2000` |
| `waitForDurationResolution` polling before registration | ✅ Confirmed — `playItemAt` now polls up to 3s and only registers if `effectiveDuration > 0` |
| Progress timer re-anchoring after late duration resolve | ✅ Confirmed — `refreshCurrentProducerDuration` calls `startPlaybackProgressTimer(item.id, totalDurationMs, startEpoch)` |
| Dynamic ETA clock tick | ✅ Confirmed — `onAirPlaylistId.value ? 1000 : 5000` |
| `IN/OUT` AMCP trim syntax | ✅ Confirmed in `buildClipOptions` |
| `preloadNextItemAt` readiness + retry guard | ✅ Confirmed — checks `item.path` and `ingestorStatus === 'ready'`, retries 3× at 500ms |
| `refreshQueue` deep-copies items | ✅ Confirmed — `items.map((i) => ({ ...i }))` |

This is solid, professional-grade broadcast engineering work. Four issues remain.

***

## Issue 1 (P0 — Root Cause of Remaining Skips): `trim_out_ms` Fallback Still Corrupts Absolute Semantics

In `rundown.ts` → `makeItem()`, confirmed live:

```ts
trim_out_ms: (item as any).trim_out_ms !== undefined 
    ? (item as any).trim_out_ms 
    : (outPoint > 0 ? outPoint : 0),
```

This is fine *only* if `outPoint` is already an absolute ms value — and it usually is, since `outPoint` is computed elsewhere as `asset.duration_ms - asset.trim_out_ms` (i.e., an absolute position). But in `updateItem()`, the same fallback pattern is used against `updates.outPoint`, and `outPoint` is sometimes set directly by UI editors (`TrimPanel.vue`) as a **duration-relative offset from playhead**, not always guaranteed absolute. Since PlayoutTranscode's contract treats `trim_out_ms` strictly as absolute, any inconsistency here re-corrupts the value on the next save-to-Ingestor round trip via `update_ingestor_trim`.

**Fix — enforce invariant at the single choke point where trims are written back to the API**, in `TrimPanel.vue`'s `saveNonDestructive`:

```ts
store.updateItem(item.value.id, {
  inPoint: inMs.value,
  outPoint: outMs.value,
  trim_in_ms: inMs.value,   // always absolute in-point
  trim_out_ms: outMs.value, // always absolute out-point — never a delta
});
```

This is already what's shipped in `TrimPanel.vue` — correctly absolute. The remaining risk is only in the `makeItem`/`updateItem` *fallback* branches when `trim_out_ms` is undefined but `outPoint` was set by some other, less careful caller. Add a defensive comment and a runtime assertion:

```ts
// INVARIANT: trim_out_ms and outPoint must both be absolute ms positions from clip start.
// Never store a duration-relative delta in either field.
```

This is a low-probability residual risk, not an active bug — downgrade from the earlier "regression" classification to a documentation/invariant hardening task.

***

## Issue 2 (P1): Duplicate `durationMs`/`duration_ms` Fields Never Consolidated

Confirmed both fields are still declared in the `RundownItem` interface and written together everywhere (`duration_ms: durationMs, durationMs: durationMs`). This isn't actively breaking anything today because every write site sets both — but it's fragile technical debt. A future contributor adding a new hydration path (e.g., a manual rundown import) could easily write only one field and reintroduce the original UI duration bug.

**Fix:** Remove `durationMs` (camelCase) from the `RundownItem` interface entirely and delete all `durationMs: durationMs` parallel writes. Keep the defensive read in `caspar.ts`'s `itemDurationMs` (`item.duration_ms || (item as any).durationMs || ...`) for one release cycle as a safety net, then remove it once confirmed clean.

***

## Issue 3 (P1): `advanceToNext` Registers Playback Before Confirming `effectiveDuration > 0`

In the natural-video-transition branch of `advanceToNext`, confirmed:

```ts
const { effectiveDuration, expectedOutPointMs } = computePlaybackDeadline(nextItem);
...
store.startPlaybackProgressTimer(nextItem.id, effectiveDuration);
...
await invoke('caspar_register_playback', {
    uuid: key,
    durationMs: effectiveDuration,
    ...
});
```

Unlike `playItemAt` (which now correctly polls via `waitForDurationResolution` and gates registration behind `effectiveDuration > 0`), `advanceToNext`'s natural-transition path has **no equivalent gate**. If `nextItem.duration_ms` is unresolved at the moment of natural advance (e.g., the Ingestor batch resolver hasn't finished for a just-added rundown item), `computePlaybackDeadline` returns `effectiveDuration = totalMs = 0`, and it's sent straight to `caspar_register_playback` — which the Rust guard will reject (`duration_ms == 0 → return Ok(())`), so no crash occurs, but the state machine now has stale state (`is_playing` stays as previously set, no deadline set), leaving the item to advance purely on OSC EOF signal. That's actually safe, but the progress timer (`startPlaybackProgressTimer`) still gets called with `effectiveDuration = 0`, causing a `-00:00` frozen countdown until `refreshCurrentProducerDuration` fixes it 250ms later. This is a minor visible glitch, not a skip risk — but worth closing for consistency.

**Fix:** Mirror the `playItemAt` pattern in `advanceToNext`:

```ts
assertIngestorReady(nextItem);
const key = queueKey(nextItem);

let resolvedDuration = itemDurationMs(nextItem);
if (resolvedDuration <= 0) {
    resolvedDuration = await waitForDurationResolution(nextItem, 3000);
}

let effectiveDuration = 0;
let expectedOutPointMs = 0;
if (resolvedDuration > 0) {
    const deadline = computePlaybackDeadline(nextItem);
    effectiveDuration = deadline.effectiveDuration;
    expectedOutPointMs = deadline.expectedOutPointMs;
}

currentKey = key;
onAdvanceCallback?.(key);
await casparPlayoutService.applyComplianceForItem?.(nextItem);

const store = useRundownStore();
updateDisplayedTime(nextItem.inPoint || 0);

if (effectiveDuration > 0) {
    store.startPlaybackProgressTimer(nextItem.id, effectiveDuration);
}
// ... proceed to LOADBG/registration only if effectiveDuration > 0, else rely on OSC EOF
```


***

## Issue 4 (P2 — Cosmetic but worth fixing): `MAX_CONSECUTIVE_SKIPS` Halts Playout Silently on the UI Side

Confirmed `consecutiveSkips` increments on any `playItemAt` catch block and calls `casparPlayoutService.stop()` after 3 consecutive errors — correct defensive behavior for a broadcast chain, preventing an infinite skip loop from burning through the whole rundown. However, there's no corresponding UI toast/banner shown to the operator when this triggers — only a `push_diagnostic_log` call. In a live MCR, playout silently stopping with no visible alert is dangerous.

**Fix:** Emit a Tauri event (`playout://halted`) alongside the diagnostic log, and have the Vue layer (`RundownList.vue` or `App.vue`) show a persistent, dismiss-required banner: *"Playout halted after 3 consecutive errors — operator intervention required."*

***

## What Must Not Change

The `PlayoutTranscode` API contract (`AssetResponse` struct, `/api/assets/batch`, `/api/assets/{uuid}/trim`) is clean, stable, and correctly uses absolute `trim_in_ms`/`trim_out_ms`/`duration_ms` semantics. None of the remaining fixes touch that repo or its endpoints — they are entirely confined to PlayOutVue's own field-hygiene and advance-registration gating on the consumer side, preserving the existing integration contract between the two programs.

## Priority Order for This Pass

1. **Issue 3** — close the gating gap in `advanceToNext` (mirrors already-proven pattern, ~15 min fix, closes the last visible glitch class)
2. **Issue 4** — add operator-visible halt alert (~20 min, safety-critical for live broadcast use)
3. **Issue 2** — remove `durationMs` camelCase duplication (~10 min cleanup, prevents future regressions)
4. **Issue 1** — add invariant documentation/assertion around `trim_out_ms` (~5 min, low risk today but cheap insurance)
