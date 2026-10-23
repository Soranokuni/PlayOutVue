/**
 * MEDIA-FALLBACK-HANDOFF: the header chip's items (media root, fallback,
 * fillers). Each package adds its item; the chip shows the most urgent one.
 */

export type HealthTone = 'ready' | 'warning' | 'error' | 'processing' | 'offline';

export interface HealthItem {
    key: string;
    tone: HealthTone;
    label: string;
    detail: string;
    /** Settings section the chip opens. */
    section: string;
    /** Shown first whatever its tone (e.g. "On fillers"). */
    sticky?: boolean;
}

/**
 * The transcoder stopped answering. Playback does not depend on it (rows keep
 * their last known state and every take checks its file on disk), but the
 * library, readiness and the media-root check are frozen until it is back.
 * `checked`: a heartbeat answered in this session (the online flag is
 * persisted, so a relaunch must not report a stale "offline").
 */
export function describeLibrary(online: boolean, checked: boolean): HealthItem | null {
    if (online || !checked) return null;
    return {
        key: 'library',
        tone: 'warning',
        label: 'Library offline',
        detail: 'The transcoder is not answering. Playback goes on from the rundown and each take still checks its file on disk; the library and readiness are not updated until it is back.',
        section: 'media',
    };
}

const RANK: Record<HealthTone, number> = { error: 4, warning: 3, processing: 2, ready: 1, offline: 0 };

/** The item whose label the chip carries: sticky first, then the worst tone. */
export function pickHeadline(items: readonly HealthItem[]): HealthItem | null {
    if (items.length === 0) return null;
    const sticky = items.find((item) => item.sticky);
    if (sticky) return sticky;
    return [...items].sort((a, b) => RANK[b.tone] - RANK[a.tone])[0] ?? null;
}
