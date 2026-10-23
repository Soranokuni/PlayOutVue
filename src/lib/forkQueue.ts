/**
 * PlayOut fork of CasparCG: the tagged wait queue on the program layer.
 *
 * The engine plays the queued rows back to back and reports each cut as an
 * `onair <tag>` event. PlayOut keeps a short window of the next rows queued
 * (`QUEUE … AUTO TAG <row> EXPECT <on-air tag>`) and refills it after every
 * cut or rundown edit. `EXPECT` makes the engine refuse a command (`409`)
 * when the cut happened while PlayOut was editing; the sync then re-reads
 * `QUEUE INFO` and tries again. Reference: `PLAYOUT-FORK.md` §3.3, §8.2.
 */

/** Engine mode decided by `QUEUE 1-10 INFO` on connect (handoff D1). */
export type EngineMode = 'unknown' | 'stock' | 'fork';

/** `caspar://engine-event` payload (one engine event, `PLAYOUT-FORK.md` §3.6). */
export interface EngineEvent {
    seq: number;
    kind: 'onair' | 'offair' | 'ended' | 'stalled' | 'actionfailed' | string;
    tag: string;
    frame: number;
    timeMs: number;
    reason: string;
}

export interface ForkQueueInfo {
    channel: number;
    layer: number;
    instance: number;
    frame: number;
    eventSeq: number;
    foreground: {
        tag: string;
        producer: string;
        frame: number;
        frames: number;
        paused: boolean;
        starting: boolean;
    } | null;
    waiting: Array<{ tag: string; producer: string; auto: boolean }>;
    fallback: { set: boolean; tag: string; active: boolean; stall: number };
}

/** `caspar_fork_*` reply: 2xx, or a `404`/`409` the caller handles. */
export interface ForkReply {
    code: number;
    body: string;
    removed?: number;
}

export const FORK_CONFLICT = 409;
export const FORK_NOT_FOUND = 404;

/** The fork's default fallback tag (`FALLBACK … TAG`). */
export const FALLBACK_TAG = 'fallback';

/** Row id of a tag: the part before an occurrence suffix (`<id>:2`, `<id>:t5`). */
export function tagBase(tag: string): string {
    const colon = tag.indexOf(':');
    return colon === -1 ? tag : tag.slice(0, colon);
}

/** Tag rule of the fork (`check_tag`): 1–128 of `A-Z a-z 0-9 . _ : -`. */
export function isValidTag(tag: string): boolean {
    return /^[A-Za-z0-9._:-]{1,128}$/.test(tag);
}

/**
 * A take's tag. The row id, unless the logical foreground already carries
 * it (a re-take of the on-air row): the fork applies `ONAIR` to the item
 * nearest to air, so the new item needs its own tag.
 */
export function takeTag(rowId: string, foregroundTag: string | null, counter: number): string {
    return foregroundTag && tagBase(foregroundTag) === rowId ? `${rowId}:t${counter}` : rowId;
}

/** One row that should wait behind the on-air item. */
export interface DesiredRow {
    id: string;
    /** Everything that ends up in the row's `QUEUE` and `ONAIR` lines. */
    fingerprint: string;
}

export interface ForkQueuePlan {
    /** Tags of the desired rows, in order. The first `keep` are already waiting. */
    tags: string[];
    keep: number;
    /** Waiting items after the kept prefix must go. */
    clear: boolean;
}

/**
 * Compare what waits on the engine with the rows that should wait.
 *
 * - The longest common start is kept: same row, and the fingerprint PlayOut
 *   recorded when it queued that tag (a trim or compliance edit changes it).
 *   A tag PlayOut does not know (after a relaunch) is never kept.
 * - The rest is cleared and queued again: `QUEUE` only appends.
 * - Tags are unique among the on-air item and the waiting items (handoff D2):
 *   a repeated row gets `<id>:2`, `<id>:3`, …
 */
export function planForkQueue(
    onAirTag: string,
    desired: readonly DesiredRow[],
    waiting: readonly string[],
    known: ReadonlyMap<string, string>
): ForkQueuePlan {
    const used = new Set<string>([onAirTag]);
    let keep = 0;
    while (keep < desired.length && keep < waiting.length) {
        const tag = waiting[keep]!;
        const row = desired[keep]!;
        if (tagBase(tag) !== row.id || known.get(tag) !== row.fingerprint || used.has(tag)) break;
        used.add(tag);
        keep += 1;
    }
    const tags = waiting.slice(0, keep);
    for (const row of desired.slice(keep)) {
        let tag = row.id;
        for (let n = 2; used.has(tag); n += 1) tag = `${row.id}:${n}`;
        used.add(tag);
        tags.push(tag);
    }
    return { tags, keep, clear: waiting.length > keep };
}

export interface ForkSyncDeps {
    /** `QUEUE 1-10 INFO`: the logical foreground tag and the waiting tags. */
    queueInfo(): Promise<{ foregroundTag: string; waiting: string[] } | null>;
    /** `QUEUE CLEAR [AFTER <last kept>] EXPECT <onAirTag>`. Returns the reply code. */
    clear(kept: readonly string[], expect: string): Promise<number>;
    /** `QUEUE <row> AUTO TAG <tag> EXPECT <onAirTag>` plus its `ONAIR` lines. */
    queue(index: number, tag: string, expect: string): Promise<number>;
    /** True when the sync no longer owns the channel (a take, a stop). */
    isStale(): boolean;
}

export type ForkSyncStatus =
    | 'ok'
    /** The engine's foreground is not the item PlayOut has on air. */
    | 'foreground-moved'
    | 'stale'
    /** Still `409` after every attempt. */
    | 'conflict'
    | 'failed';

export interface ForkSyncResult {
    status: ForkSyncStatus;
    /** Tags waiting behind the on-air item after the sync, in order. */
    tags: string[];
    /** Desired-row index whose `QUEUE` failed (status `failed`). */
    failedIndex?: number;
    attempts: number;
}

/**
 * Bring the engine's wait queue in line with `desired` behind `onAirTag`.
 * Every command carries `EXPECT <onAirTag>`; a `409` means the cut happened
 * during the edit, so the whole diff is read and planned again.
 */
export async function syncForkQueue(
    onAirTag: string,
    desired: readonly DesiredRow[],
    known: ReadonlyMap<string, string>,
    deps: ForkSyncDeps,
    maxAttempts = 3
): Promise<ForkSyncResult> {
    let attempts = 0;
    while (attempts < maxAttempts) {
        attempts += 1;
        if (deps.isStale()) return { status: 'stale', tags: [], attempts };
        const info = await deps.queueInfo();
        if (deps.isStale()) return { status: 'stale', tags: [], attempts };
        if (!info) return { status: 'failed', tags: [], attempts };
        if (info.foregroundTag !== onAirTag) {
            return { status: 'foreground-moved', tags: info.waiting, attempts };
        }

        const plan = planForkQueue(onAirTag, desired, info.waiting, known);
        let conflict = false;
        if (plan.clear) {
            const code = await deps.clear(plan.tags.slice(0, plan.keep), onAirTag);
            if (code === FORK_CONFLICT || code === FORK_NOT_FOUND) conflict = true;
            else if (code >= 400) return { status: 'failed', tags: plan.tags.slice(0, plan.keep), attempts };
        }
        let queued = plan.keep;
        for (let i = plan.keep; !conflict && i < plan.tags.length; i += 1) {
            if (deps.isStale()) return { status: 'stale', tags: plan.tags.slice(0, queued), attempts };
            const code = await deps.queue(i, plan.tags[i]!, onAirTag);
            if (code === FORK_CONFLICT) {
                conflict = true;
            } else if (code >= 400) {
                return { status: 'failed', tags: plan.tags.slice(0, queued), failedIndex: i, attempts };
            } else {
                queued += 1;
            }
        }
        if (!conflict) return { status: 'ok', tags: plan.tags, attempts };
    }
    return { status: 'conflict', tags: [], attempts };
}
