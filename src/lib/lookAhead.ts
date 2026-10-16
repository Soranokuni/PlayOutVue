/**
 * MEDIA-FALLBACK-HANDOFF AE-3: which rows the look-ahead pre-flight checks,
 * and how a problem reads on the row. Pure.
 */

export interface LookAheadCandidate {
    id: string;
    type: string;
    path?: string;
    playoutvueId?: string;
    ingestorStatus?: string;
}

export interface LookAheadRow {
    id: string;
    path: string;
    playoutvueId: string | null;
    /** Scheduled start, epoch ms. */
    startsAtMs: number;
}

export interface PreflightResult {
    id: string;
    checked: boolean;
    ok: boolean;
    reason: string | null;
    localPath: string | null;
}

export interface PreflightIssue {
    reason: string;
    startsAtMs: number;
    /** When the problem was first seen. */
    seenAtMs: number;
}

export function isRegistryId(id: string | null | undefined): boolean {
    const v = (id ?? '').trim();
    return v !== '' && !v.startsWith('local:') && !v.startsWith('local-subclip:');
}

/**
 * The next `maxRows` clip rows after `afterIndex` that start within
 * `maxMinutes` of `nowMs`. Rows already flagged `error` are skipped anyway and
 * are not checked. Without an advertised root a registry row cannot be mapped
 * to this PC's folder, so only local rows are checked then.
 */
export function selectLookAheadRows(
    items: readonly LookAheadCandidate[],
    startTimes: readonly (number | undefined)[],
    afterIndex: number,
    nowMs: number,
    maxRows: number,
    maxMinutes: number,
    haveAdvertisedRoot: boolean,
): LookAheadRow[] {
    const horizon = nowMs + Math.max(0, maxMinutes) * 60_000;
    const rows: LookAheadRow[] = [];
    for (let i = Math.max(0, afterIndex + 1); i < items.length && rows.length < maxRows; i += 1) {
        const item = items[i]!;
        const startsAtMs = startTimes[i] ?? nowMs;
        if (startsAtMs > horizon) break;
        if (item.type !== 'video' || !item.path || item.ingestorStatus === 'error') continue;
        const registry = isRegistryId(item.playoutvueId);
        if (registry && !haveAdvertisedRoot) continue;
        rows.push({ id: item.id, path: item.path, playoutvueId: item.playoutvueId ?? null, startsAtMs });
    }
    return rows;
}

/** Merge a run's results into the open issues: new ones in, fixed ones out. */
export function mergeIssues(
    previous: Readonly<Record<string, PreflightIssue>>,
    rows: readonly LookAheadRow[],
    results: readonly PreflightResult[],
    nowMs: number,
): Record<string, PreflightIssue> {
    const startsAt = new Map(rows.map((row) => [row.id, row.startsAtMs]));
    const next: Record<string, PreflightIssue> = {};
    for (const result of results) {
        if (!result.checked) {
            // Not looked at this time: keep what we knew.
            if (previous[result.id]) next[result.id] = previous[result.id]!;
            continue;
        }
        if (result.ok) continue;
        next[result.id] = {
            reason: result.reason || 'pre-flight failed',
            startsAtMs: startsAt.get(result.id) ?? previous[result.id]?.startsAtMs ?? nowMs,
            seenAtMs: previous[result.id]?.seenAtMs ?? nowMs,
        };
    }
    return next;
}

/** `will fail at 14:32` (local wall clock). */
export function issueLabel(issue: PreflightIssue): string {
    const at = new Date(issue.startsAtMs);
    const hh = String(at.getHours()).padStart(2, '0');
    const mm = String(at.getMinutes()).padStart(2, '0');
    return `will fail at ${hh}:${mm}`;
}
