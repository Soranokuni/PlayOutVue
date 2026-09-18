/**
 * Crash/refresh resume snapshot for the on-air clip.
 *
 * PERF F-09: the snapshot used to be 13 separate `localStorage` keys written
 * once per second while playing. It is now one JSON blob under a single key
 * (one synchronous `setItem` per save) with an in-memory mirror so a save
 * never has to read storage first. Merge semantics are unchanged: fields not
 * supplied in `extra` keep their previously saved value, exactly as the
 * per-key layout behaved. A snapshot written by an older build (per-key
 * layout) is read once, migrated to the blob and the legacy keys removed.
 */
const KEY_SNAPSHOT = 'playout_playbackSnapshot';
const SNAPSHOT_VERSION = 2;

const LEGACY_KEYS = {
    uuid: 'playout_activePlayingUuid',
    start: 'playout_playbackStartTimestamp',
    duration: 'playout_playbackDurationMs',
    itemId: 'playout_resumeItemId',
    playlistId: 'playout_resumePlaylistId',
    path: 'playout_resumePath',
    trimIn: 'playout_resumeTrimInMs',
    trimOut: 'playout_resumeTrimOutMs',
    version: 'playout_playbackSnapshotVersion',
    position: 'playout_resumePositionMs',
    updated: 'playout_resumeUpdatedAt',
    paused: 'playout_resumePaused',
    outputRate: 'playout_resumeChannelOutputRateHz',
} as const;

export interface PlaybackResumeState {
    version: number;
    uuid: string;
    startTimestamp: number;
    durationMs: number;
    itemId?: string;
    playlistId?: string;
    path?: string;
    trimInMs?: number;
    trimOutMs?: number;
    positionMs?: number;
    updatedAt?: number;
    paused?: boolean;
    channelOutputRateHz?: number;
}

/** `undefined` = not yet read from storage; `null` = known empty. */
let cached: PlaybackResumeState | null | undefined;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const parseSnapshot = (raw: string | null): PlaybackResumeState | null => {
    if (!raw) return null;
    try {
        const data = JSON.parse(raw) as Partial<PlaybackResumeState> | null;
        if (!data || typeof data !== 'object') return null;
        if (typeof data.uuid !== 'string' || !data.uuid) return null;
        if (!isFiniteNumber(data.startTimestamp) || !isFiniteNumber(data.durationMs)) return null;
        return {
            version: isFiniteNumber(data.version) ? data.version : 1,
            uuid: data.uuid,
            startTimestamp: data.startTimestamp,
            durationMs: data.durationMs,
            itemId: typeof data.itemId === 'string' ? data.itemId : undefined,
            playlistId: typeof data.playlistId === 'string' ? data.playlistId : undefined,
            path: typeof data.path === 'string' ? data.path : undefined,
            trimInMs: isFiniteNumber(data.trimInMs) ? data.trimInMs : undefined,
            trimOutMs: isFiniteNumber(data.trimOutMs) ? data.trimOutMs : undefined,
            positionMs: isFiniteNumber(data.positionMs) ? data.positionMs : 0,
            updatedAt: isFiniteNumber(data.updatedAt) ? data.updatedAt : data.startTimestamp,
            paused: data.paused === true,
            channelOutputRateHz: isFiniteNumber(data.channelOutputRateHz) && data.channelOutputRateHz > 0
                ? data.channelOutputRateHz
                : undefined,
        };
    } catch {
        return null;
    }
};

const readLegacy = (): PlaybackResumeState | null => {
    const storedUuid = localStorage.getItem(LEGACY_KEYS.uuid);
    const storedStart = localStorage.getItem(LEGACY_KEYS.start);
    const storedDuration = localStorage.getItem(LEGACY_KEYS.duration);
    if (!storedUuid || !storedStart || !storedDuration) return null;
    const trimIn = localStorage.getItem(LEGACY_KEYS.trimIn);
    const trimOut = localStorage.getItem(LEGACY_KEYS.trimOut);
    return {
        version: Number(localStorage.getItem(LEGACY_KEYS.version) || 1),
        uuid: storedUuid,
        startTimestamp: Number(storedStart),
        durationMs: Number(storedDuration),
        itemId: localStorage.getItem(LEGACY_KEYS.itemId) ?? undefined,
        playlistId: localStorage.getItem(LEGACY_KEYS.playlistId) ?? undefined,
        path: localStorage.getItem(LEGACY_KEYS.path) ?? undefined,
        trimInMs: trimIn != null ? Number(trimIn) : undefined,
        trimOutMs: trimOut != null ? Number(trimOut) : undefined,
        positionMs: Number(localStorage.getItem(LEGACY_KEYS.position) || 0),
        updatedAt: Number(localStorage.getItem(LEGACY_KEYS.updated) || storedStart),
        paused: localStorage.getItem(LEGACY_KEYS.paused) === 'true',
        channelOutputRateHz: Number(localStorage.getItem(LEGACY_KEYS.outputRate) || 0) || undefined,
    };
};

const removeLegacy = (): void => {
    for (const key of Object.values(LEGACY_KEYS)) localStorage.removeItem(key);
};

const writeSnapshot = (state: PlaybackResumeState): void => {
    localStorage.setItem(KEY_SNAPSHOT, JSON.stringify(state));
};

/** Read from storage (once), migrating a legacy per-key snapshot if present. */
const readCurrent = (): PlaybackResumeState | null => {
    if (cached !== undefined) return cached;
    const blob = parseSnapshot(localStorage.getItem(KEY_SNAPSHOT));
    if (blob) {
        cached = blob;
        return cached;
    }
    const legacy = readLegacy();
    if (legacy) {
        try {
            writeSnapshot(legacy);
            removeLegacy();
        } catch {
            // keep the legacy keys if migration fails; the next launch retries
        }
        cached = legacy;
        return cached;
    }
    cached = null;
    return cached;
};

export const savePlaybackState = (
    uuid: string,
    startTimestamp: number,
    durationMs: number,
    extra?: Partial<PlaybackResumeState>
) => {
    try {
        const previous = readCurrent();
        const next: PlaybackResumeState = {
            ...(previous ?? {}),
            version: SNAPSHOT_VERSION,
            uuid,
            startTimestamp,
            durationMs,
        };
        if (extra?.itemId) next.itemId = extra.itemId;
        if (extra?.playlistId) next.playlistId = extra.playlistId;
        if (extra?.path) next.path = extra.path;
        if (extra?.trimInMs != null) next.trimInMs = extra.trimInMs;
        if (extra?.trimOutMs != null) next.trimOutMs = extra.trimOutMs;
        if (extra?.positionMs != null) next.positionMs = extra.positionMs;
        if (extra?.updatedAt != null) next.updatedAt = extra.updatedAt;
        if (extra?.paused != null) next.paused = extra.paused;
        if (extra?.channelOutputRateHz != null) next.channelOutputRateHz = extra.channelOutputRateHz;
        writeSnapshot(next);
        cached = next;
    } catch {
        // localStorage unavailable — non-critical, progress timer still works in-session
    }
};

export const loadPlaybackState = (): PlaybackResumeState | null => {
    try {
        const state = readCurrent();
        if (!state) return null;
        return {
            ...state,
            positionMs: state.positionMs ?? 0,
            updatedAt: state.updatedAt ?? state.startTimestamp,
            paused: state.paused === true,
        };
    } catch {
        // localStorage unavailable
    }
    return null;
};

export const clearPlaybackState = () => {
    cached = null;
    try {
        localStorage.removeItem(KEY_SNAPSHOT);
        removeLegacy();
    } catch {
        // localStorage unavailable
    }
};

/** Test hook: forget the in-memory mirror so the next read hits storage. */
export const __resetPlaybackPersistenceCache = () => {
    cached = undefined;
};
