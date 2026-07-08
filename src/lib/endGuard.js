import { listen } from '@tauri-apps/api/event';
export const activeGuard = new Map();
let unlistenTick = null;
let currentOnStall = null;
export async function initEndGuard(onStall) {
    currentOnStall = onStall;
    if (unlistenTick) {
        return;
    }
    unlistenTick = await listen('caspar://playback-tick', (event) => {
        const { positionMs, durationMs, currentUuid } = event.payload;
        if (!currentUuid) {
            return;
        }
        const now = Date.now();
        let state = activeGuard.get(currentUuid);
        if (!state) {
            state = {
                lastPositionMs: positionMs,
                stalledTicks: 0,
                startedAt: now,
                effectiveDurationMs: durationMs || 0
            };
            activeGuard.set(currentUuid, state);
            return;
        }
        // Verify if the position has changed by more than 40ms (~1 frame at 25fps)
        const positionChanged = Math.abs(positionMs - state.lastPositionMs) > 40;
        if (positionChanged) {
            state.stalledTicks = 0;
        }
        else {
            state.stalledTicks += 1;
        }
        state.lastPositionMs = positionMs;
        // If the tick payload contains a non-zero durationMs, keep our effectiveDurationMs updated
        if (durationMs > 0 && state.effectiveDurationMs <= 0) {
            state.effectiveDurationMs = durationMs;
        }
        const elapsed = now - state.startedAt;
        const overtime = elapsed > state.effectiveDurationMs * 1.15;
        const stalled = state.stalledTicks >= 5;
        if (overtime && stalled) {
            console.warn(`[EndGuard] HEAVY WARNING: Playout stalled for item ${currentUuid}!\n` +
                `  Elapsed wall-clock: ${elapsed}ms\n` +
                `  Expected duration: ${state.effectiveDurationMs}ms (threshold: ${state.effectiveDurationMs * 1.15}ms)\n` +
                `  Stationary for ${state.stalledTicks} ticks.\n` +
                `  Executing recovery callback.`);
            if (currentOnStall) {
                currentOnStall(currentUuid);
            }
            activeGuard.delete(currentUuid);
        }
    });
}
export function registerPlayStart(itemId, durationMs) {
    activeGuard.set(itemId, {
        lastPositionMs: -1,
        stalledTicks: 0,
        startedAt: Date.now(),
        effectiveDurationMs: durationMs
    });
}
export function stopEndGuard() {
    if (unlistenTick) {
        unlistenTick();
        unlistenTick = null;
    }
    activeGuard.clear();
}
