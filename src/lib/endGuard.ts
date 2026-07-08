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

        const state = activeGuard.get(currentUuid);
        if (!state) {
            return;
        }

        const now = Date.now();

        // Verify if the position has changed by more than 40ms (~1 frame at 25fps)
        const positionChanged = Math.abs(positionMs - state.lastPositionMs) > 40;
        if (positionChanged) {
            state.stalledTicks = 0;
            state.positionEverAdvanced = true;
        } else {
            state.stalledTicks += 1;
        }
        state.lastPositionMs = positionMs;

        const elapsed = now - state.startedAt;
        const overtime = state.effectiveDurationMs > 0 && elapsed > state.effectiveDurationMs * 1.15;
        const stalled = state.stalledTicks >= 10;

        // EOF stall detection: the position was advancing but has been
        // frozen for an extended period, even though the expected duration
        // hasn't elapsed. This catches clips that hit EOF before the
        // expected out point (e.g. inflated DB duration → LENGTH larger
        // than remaining frames). Without this, the rundown would freeze
        // for the entire inflated duration before the overtime check fires.
        //
        // The stall threshold scales with the clip duration to avoid false
        // positives on short clips. For a 4s subclip, a fixed 20-tick (2s)
        // threshold could fire mid-playback during a brief OSC gap. We use
        // max(20, duration/200) so a 4s clip needs 20 ticks (2s) and a 30s
        // clip needs 150 ticks (15s) — well past any normal OSC jitter.
        const stallThreshold = Math.max(20, Math.floor(state.effectiveDurationMs / 200));
        const eofStalled = state.positionEverAdvanced
            && state.stalledTicks >= stallThreshold
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
