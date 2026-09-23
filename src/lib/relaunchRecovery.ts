/**
 * PlayOut-relaunch recovery planning.
 *
 * PlayOut (not the engine) died, hung or was closed while something was on
 * air, and has just come back. The Rust checkpoint (`src-tauri/src/recovery.rs`)
 * says what was on air and where; INFO on layer 10 says what CasparCG shows
 * now. Two pure decisions live here:
 *
 * 1. `resolveAdoptionIndex` — which rundown row the clip CasparCG is still
 *    playing belongs to. File names are not identities: a sub-clip shares its
 *    parent's file, so the checkpoint's row ids are tried first.
 * 2. `planRelaunchRecovery` — when nothing of ours is playing any more, what
 *    to do: resume where the channel stopped, join the schedule where it would
 *    be now, or hold for the operator, by how long the channel has been off air.
 */

import { MIN_RESUME_REMAINING_MS, RESUME_REWIND_MS } from './engineRecovery';

// ---------------------------------------------------------------------------
// Checkpoint shapes (mirror of recovery.rs, camelCase)
// ---------------------------------------------------------------------------

export interface OnAirCheckpoint {
    uuid: string;
    playlistId?: string | null;
    path: string;
    filename: string;
    trimInMs: number;
    trimOutMs: number;
    durationMs: number;
    resumeOffsetMs: number;
    isLive: boolean;
    nextUuid?: string | null;
    nextPath?: string | null;
    playGeneration: number;
    positionMs: number;
    paused: boolean;
}

export interface GraphicsCheckpoint {
    advisoryOnAir: boolean;
    advisoryItem?: Record<string, unknown> | null;
    crawlActive: boolean;
    crawlText: string;
}

export interface PlayoutCheckpoint {
    version: number;
    seq: number;
    sessionId: string;
    writtenAtMs: number;
    onAir: OnAirCheckpoint | null;
    graphics: GraphicsCheckpoint;
    rundownRevision: number;
    cleanShutdown: boolean;
}

export interface SessionRecord {
    sessionId: string;
    pid: number;
    startedAtMs: number;
    endedAtMs: number | null;
    clean: boolean;
    recoveredLaunch: boolean;
}

export interface BootInfo {
    previousCheckpoint: PlayoutCheckpoint | null;
    previousSession: SessionRecord | null;
    previousHandled: boolean;
    crashLoop: boolean;
    recoveredLaunch: boolean;
    uiReloads: number;
    liveCheckpoint: PlayoutCheckpoint;
}

export interface LivePlayback {
    currentUuid: string | null;
    playGeneration: number;
    isPlaying: boolean;
    isPaused: boolean;
    positionMs: number;
    durationMs: number;
    trimInMs: number;
    trimOutMs: number;
    currentPath: string;
    expectedNextPath: string | null;
    positionConfirmed: boolean;
}

// ---------------------------------------------------------------------------
// 1. Which row is CasparCG playing?
// ---------------------------------------------------------------------------

export interface AdoptionCandidate {
    id: string;
    path: string;
    /** Trim window in file time, ms (trimOutMs 0 = to the end). */
    trimInMs: number;
    trimOutMs: number;
}

export interface AdoptionHint {
    key: string;
    path?: string | null;
}

/** Lower-case file name without extension, for path comparison. */
export const clipBase = (p: string) => {
    const s = String(p || '').replace(/\\/g, '/').toLowerCase();
    const base = s.split('/').pop() || s;
    return base.replace(/\.[^./\\]+$/, '');
};

const windowContains = (c: AdoptionCandidate, elapsedMs: number) =>
    elapsedMs >= c.trimInMs - 500 && (c.trimOutMs <= 0 || elapsedMs <= c.trimOutMs + 500);

/**
 * The queue index of the clip CasparCG is playing, or -1.
 * Order of evidence: identity hints (Rust's live registration, then the
 * checkpoint's on-air row, then its armed successor) whose file matches;
 * then any row with that file whose trim window contains the playhead,
 * nearest to `nearIndex`; then any row with that file.
 */
export function resolveAdoptionIndex(
    queue: readonly AdoptionCandidate[],
    producerPath: string,
    elapsedMs: number,
    hints: readonly AdoptionHint[],
    nearIndex = -1
): number {
    const base = clipBase(producerPath);
    if (!base) return -1;

    for (const hint of hints) {
        const index = queue.findIndex((c) => c.id === hint.key);
        if (index === -1) continue;
        const candidate = queue[index]!;
        if (clipBase(candidate.path) === base || (hint.path && clipBase(hint.path) === base)) return index;
    }

    const sameFile = queue
        .map((c, index) => ({ c, index }))
        .filter(({ c }) => clipBase(c.path) === base);
    if (sameFile.length === 0) return -1;

    const inWindow = sameFile.filter(({ c }) => windowContains(c, elapsedMs));
    const pool = inWindow.length > 0 ? inWindow : sameFile;
    if (nearIndex < 0) return pool[0]!.index;
    return pool.reduce((best, entry) =>
        Math.abs(entry.index - nearIndex) < Math.abs(best.index - nearIndex) ? entry : best
    ).index;
}

// ---------------------------------------------------------------------------
// 2. What should the channel do now?
// ---------------------------------------------------------------------------

/** What layer 10 shows at relaunch, relative to the checkpoint. */
export type EngineAtRelaunch =
    /** Nothing: the engine died with PlayOut, or was restarted. */
    | 'empty'
    /** Frozen on the last frame of the checkpoint's on-air clip. */
    | 'ended-on-current'
    /** Frozen on the last frame of the successor it had preloaded. */
    | 'ended-on-next'
    /** Something that is not ours. */
    | 'foreign';

export interface ScheduleItem {
    id: string;
    type?: string;
    ingestorStatus?: string;
    /** Trimmed length, ms (0 = unknown). */
    durationMs: number;
}

export interface RelaunchPolicy {
    resumeWithinMs: number;
    joinWithinMs: number;
    /** Seconds before the primary action runs by itself; 0 = never. */
    countdownS: number;
    rewindMs?: number;
    minRemainingMs?: number;
}

export type RelaunchActionKind = 'resume' | 'join' | 'hold';

export interface RelaunchAction {
    kind: RelaunchActionKind;
    /** Queue (playable) index; -1 for hold. */
    index: number;
    seekMs: number;
}

export interface RelaunchOffer {
    primary: RelaunchAction;
    alternatives: RelaunchAction[];
    /** Seconds until the primary action runs by itself; null = wait for the operator. */
    autoConfirmS: number | null;
    /** How long the channel has been off air (estimated), ms. */
    offAirMs: number;
    reason: string;
}

export interface RelaunchInput {
    key: string;
    positionMs: number;
    durationMs: number;
    nextKey?: string | null;
    writtenAtMs: number;
    paused?: boolean;
}

const HOLD: RelaunchAction = { kind: 'hold', index: -1, seekMs: 0 };

const playable = (item: ScheduleItem | undefined) => !!item && item.ingestorStatus !== 'error';

function nextPlayableIndex(queue: readonly ScheduleItem[], from: number): number {
    for (let i = Math.max(0, from); i < queue.length; i += 1) {
        if (playable(queue[i])) return i;
    }
    return -1;
}

/** Where the channel stopped, and since when it has been off air. */
function continuationPoint(
    input: RelaunchInput,
    queue: readonly ScheduleItem[],
    engine: EngineAtRelaunch,
    rewindMs: number,
    minRemainingMs: number
): { action: RelaunchAction | null; offAirSince: number } {
    const index = queue.findIndex((q) => q.id === input.key);
    const duration = Math.max(0, input.durationMs || queue[index]?.durationMs || 0);
    const remaining = duration > 0 ? Math.max(0, duration - input.positionMs) : 0;

    if (index === -1) return { action: null, offAirSince: input.writtenAtMs };

    if (engine === 'ended-on-next' && input.nextKey) {
        const nextIndex = queue.findIndex((q) => q.id === input.nextKey);
        const nextDuration = nextIndex >= 0 ? queue[nextIndex]!.durationMs : 0;
        const start = nextPlayableIndex(queue, (nextIndex >= 0 ? nextIndex : index) + 1);
        return {
            action: start === -1 ? null : { kind: 'resume', index: start, seekMs: 0 },
            offAirSince: input.writtenAtMs + remaining + Math.max(0, nextDuration),
        };
    }
    if (engine === 'ended-on-current') {
        const start = nextPlayableIndex(queue, index + 1);
        return {
            action: start === -1 ? null : { kind: 'resume', index: start, seekMs: 0 },
            offAirSince: input.writtenAtMs + remaining,
        };
    }

    const item = queue[index]!;
    if (item.type === 'live') return { action: { kind: 'resume', index, seekMs: 0 }, offAirSince: input.writtenAtMs };
    const seek = Math.max(0, Math.round(input.positionMs) - rewindMs);
    if (duration > 0 && duration - seek < minRemainingMs) {
        const start = nextPlayableIndex(queue, index + 1);
        return {
            action: start === -1 ? null : { kind: 'resume', index: start, seekMs: 0 },
            offAirSince: input.writtenAtMs,
        };
    }
    return { action: { kind: 'resume', index, seekMs: seek }, offAirSince: input.writtenAtMs };
}

/**
 * Where the rundown would be now had nothing failed: walk the trimmed
 * durations from the checkpoint position by the elapsed wall time. Null when
 * the rundown would have ended; stops at an item of unknown length.
 */
export function schedulePoint(
    input: RelaunchInput,
    queue: readonly ScheduleItem[],
    nowMs: number,
    minRemainingMs = MIN_RESUME_REMAINING_MS
): RelaunchAction | null {
    let index = queue.findIndex((q) => q.id === input.key);
    if (index === -1) return null;
    let into = Math.max(0, input.positionMs);
    let left = Math.max(0, nowMs - input.writtenAtMs);

    while (index !== -1 && index < queue.length) {
        const item = queue[index]!;
        const duration = playable(item) ? Math.max(0, item.durationMs) : 0;
        if (playable(item) && duration <= 0) return { kind: 'join', index, seekMs: 0 };
        const remaining = Math.max(0, duration - into);
        if (playable(item) && left < remaining) {
            const seek = Math.round(into + left);
            if (item.type === 'live') return { kind: 'join', index, seekMs: 0 };
            if (duration - seek >= minRemainingMs) return { kind: 'join', index, seekMs: seek };
            const next = nextPlayableIndex(queue, index + 1);
            return next === -1 ? null : { kind: 'join', index: next, seekMs: 0 };
        }
        left -= remaining;
        into = 0;
        index = nextPlayableIndex(queue, index + 1);
    }
    return null;
}

const sameAction = (a: RelaunchAction, b: RelaunchAction) =>
    a.kind === 'hold' ? b.kind === 'hold' : a.index === b.index && Math.abs(a.seekMs - b.seekMs) < 2000;

export function planRelaunchRecovery(
    input: RelaunchInput,
    queue: readonly ScheduleItem[],
    engine: EngineAtRelaunch,
    nowMs: number,
    policy: RelaunchPolicy,
    options: { crashLoop?: boolean } = {}
): RelaunchOffer {
    const rewind = Math.max(0, policy.rewindMs ?? RESUME_REWIND_MS);
    const minRemaining = Math.max(0, policy.minRemainingMs ?? MIN_RESUME_REMAINING_MS);
    const continuation = continuationPoint(input, queue, engine, rewind, minRemaining);
    const schedule = schedulePoint(input, queue, nowMs, minRemaining);
    const offAirMs = Math.max(0, nowMs - continuation.offAirSince);

    let primary: RelaunchAction;
    let reason: string;
    if (!queue.some((q) => q.id === input.key)) {
        primary = HOLD;
        reason = 'the interrupted item is no longer in the rundown';
    } else if (offAirMs < policy.resumeWithinMs) {
        primary = continuation.action ?? schedule ?? HOLD;
        reason = continuation.action ? 'short outage: continue where the channel stopped' : 'the rundown had finished';
    } else if (offAirMs < policy.joinWithinMs) {
        primary = schedule ?? HOLD;
        reason = schedule ? 'join the schedule where it would be now' : 'the rundown would have finished by now';
    } else {
        primary = HOLD;
        reason = 'long outage: operator decision required';
    }

    const alternatives: RelaunchAction[] = [];
    for (const candidate of [continuation.action, schedule]) {
        if (candidate && !sameAction(candidate, primary) && !alternatives.some((a) => sameAction(a, candidate))) {
            alternatives.push(candidate);
        }
    }

    let autoConfirmS: number | null = policy.countdownS > 0 ? policy.countdownS : null;
    if (primary.kind === 'hold') autoConfirmS = null;
    if (engine === 'foreign') {
        autoConfirmS = null;
        reason = `CasparCG is playing something that is not in this rundown; ${reason}`;
    }
    if (input.paused) {
        autoConfirmS = null;
        reason = `the clip was paused; ${reason}`;
    }
    if (options.crashLoop) {
        autoConfirmS = null;
        reason = `PlayOut is crash-looping, so nothing runs by itself; ${reason}`;
    }

    return { primary, alternatives, autoConfirmS, offAirMs, reason };
}
