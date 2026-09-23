/**
 * Engine-loss recovery planning.
 *
 * When CasparCG dies with a clip on air, the producer, the LOADBG background
 * and every graphics layer die with it; the rundown, the queue and the last
 * OSC position survive in PlayOut. This module decides, from what survived,
 * what the channel should do once an engine answers again. It is pure so the
 * decision can be tested without an engine; `services/caspar.ts` executes it.
 */

/** What was on air when the engine was lost. */
export interface EngineLossSnapshot {
    /** Queue key (row id) of the interrupted item. */
    key: string;
    /** Position into the item's trimmed window, ms. */
    positionMs: number;
    /** Length of the item's trimmed window, ms (0 = unknown). */
    durationMs: number;
    /** Wall-clock time the loss was detected. */
    lostAt: number;
    /** Whether the advisory / station-ID template was on air. */
    graphicsOnAir: boolean;
    /** Whether the crawl was running. */
    crawlOnAir: boolean;
}

export interface RecoveryQueueItem {
    id: string;
    type?: string;
    ingestorStatus?: string;
}

export type RecoveryPlan =
    /** Re-issue the interrupted item at `seekMs` into its trimmed window. */
    | { kind: 'resume'; index: number; seekMs: number }
    /** The item had (almost) finished: take the next one from its start. */
    | { kind: 'advance'; index: number }
    /** Stay off air (operator choice, or nothing sensible to play). */
    | { kind: 'hold'; reason: string };

export interface RecoveryOptions {
    autoResume: boolean;
    /** Rewind applied to the resume point, ms (covers frames buffered but never output). */
    rewindMs?: number;
    /** Less than this left in the item → advance instead of resuming a fragment. */
    minRemainingMs?: number;
}

export const RESUME_REWIND_MS = 1000;
export const MIN_RESUME_REMAINING_MS = 2000;

export function planEngineRecovery(
    snapshot: EngineLossSnapshot | null,
    queue: readonly RecoveryQueueItem[],
    options: RecoveryOptions
): RecoveryPlan {
    if (!snapshot) return { kind: 'hold', reason: 'nothing was on air' };
    if (!options.autoResume) return { kind: 'hold', reason: 'automatic resume is disabled in Settings' };

    const index = queue.findIndex((item) => item.id === snapshot.key);
    if (index === -1) return { kind: 'hold', reason: 'the interrupted item is no longer in the rundown' };

    const item = queue[index]!;
    const rewind = Math.max(0, options.rewindMs ?? RESUME_REWIND_MS);
    const minRemaining = Math.max(0, options.minRemainingMs ?? MIN_RESUME_REMAINING_MS);

    // A live source has no position to seek to; re-take it.
    if (item.type === 'live') return { kind: 'resume', index, seekMs: 0 };

    const position = Math.max(0, Math.round(snapshot.positionMs));
    const duration = Math.max(0, Math.round(snapshot.durationMs));
    const seekMs = Math.max(0, position - rewind);

    if (duration > 0 && duration - seekMs < minRemaining) {
        const next = findNextPlayable(queue, index + 1);
        return next === -1
            ? { kind: 'hold', reason: 'the interrupted item was the last in the rundown and had finished' }
            : { kind: 'advance', index: next };
    }

    return { kind: 'resume', index, seekMs };
}

function findNextPlayable(queue: readonly RecoveryQueueItem[], from: number): number {
    for (let i = from; i < queue.length; i += 1) {
        if (queue[i]?.ingestorStatus !== 'error') return i;
    }
    return -1;
}
