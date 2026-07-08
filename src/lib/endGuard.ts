import { listen } from '@tauri-apps/api/event';

export interface GuardState {
    lastPositionMs: number;
    stalledTicks: number;
    startedAt: number;
    effectiveDurationMs: number;
    positionEverAdvanced: boolean;
}

export const activeGuard = new Map<string, GuardState>();

export interface PlaybackTickPayload {
    positionMs: number;
    durationMs: number;
    currentUuid: string | null;
}

let unlistenTick: (() => void) | null = null;
let currentOnStall: ((itemId: string) => void) | null = null;

export async function initEndGuard(onStall: (itemId: string) => void): Promise<void> {
    currentOnStall = onStall;
    if (unlistenTick) {
        return;
    }

    unlistenTick = await listen<PlaybackTickPayload>('caspar://playback-tick', (event) => {
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
                effectiveDurationMs: durationMs || 0,
                positionEverAdvanced: false
            };
            activeGuard.set(currentUuid, state);
            return;
        }

        // Verify if the position has changed by more than 40ms (~1 frame at 25fps)
        const positionChanged = Math.abs(positionMs - state.lastPositionMs) > 40;
        if (positionChanged) {
            state.stalledTicks = 0;
            state.positionEverAdvanced = true;
        } else {
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

        // EOF stall detection: the position was advancing but has been
        // frozen for an extended period, even though the expected duration
        // hasn't elapsed. This catches clips that hit EOF before the
        // expected out point (e.g. inflated DB duration → LENGTH larger
        // than remaining frames). Without this, the rundown would freeze
        // for the entire inflated duration before the overtime check fires.
        const eofStalled = state.positionEverAdvanced
            && state.stalledTicks >= 20
            && positionMs > 500;

        if ((overtime && stalled) || eofStalled) {
            console.warn(
                `[EndGuard] HEAVY WARNING: Playout stalled for item ${currentUuid}!\n` +
                `  Elapsed wall-clock: ${elapsed}ms\n` +
                `  Expected duration: ${state.effectiveDurationMs}ms (threshold: ${state.effectiveDurationMs * 1.15}ms)\n` +
                `  Stationary for ${state.stalledTicks} ticks.\n` +
                `  Executing recovery callback.`
            );

            if (currentOnStall) {
                currentOnStall(currentUuid);
            }

            activeGuard.delete(currentUuid);
        }
    });
}

export function registerPlayStart(itemId: string, durationMs: number) {
    activeGuard.set(itemId, {
        lastPositionMs: -1,
        stalledTicks: 0,
        startedAt: Date.now(),
        effectiveDurationMs: durationMs,
        positionEverAdvanced: false
    });
}

export function stopEndGuard() {
    if (unlistenTick) {
        unlistenTick();
        unlistenTick = null;
    }
    activeGuard.clear();
}
