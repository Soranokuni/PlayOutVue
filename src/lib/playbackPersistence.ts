const KEY_UUID = 'playout_activePlayingUuid';
const KEY_START = 'playout_playbackStartTimestamp';
const KEY_DURATION = 'playout_playbackDurationMs';
const KEY_ITEM_ID = 'playout_resumeItemId';
const KEY_PLAYLIST_ID = 'playout_resumePlaylistId';
const KEY_PATH = 'playout_resumePath';
const KEY_TRIM_IN = 'playout_resumeTrimInMs';
const KEY_TRIM_OUT = 'playout_resumeTrimOutMs';
const KEY_VERSION = 'playout_playbackSnapshotVersion';
const KEY_POSITION = 'playout_resumePositionMs';
const KEY_UPDATED = 'playout_resumeUpdatedAt';
const KEY_PAUSED = 'playout_resumePaused';
const KEY_OUTPUT_RATE = 'playout_resumeChannelOutputRateHz';
const SNAPSHOT_VERSION = 2;

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

export const savePlaybackState = (
    uuid: string,
    startTimestamp: number,
    durationMs: number,
    extra?: Partial<PlaybackResumeState>
) => {
    try {
        localStorage.setItem(KEY_UUID, uuid);
        localStorage.setItem(KEY_START, String(startTimestamp));
        localStorage.setItem(KEY_DURATION, String(durationMs));
        if (extra?.itemId) localStorage.setItem(KEY_ITEM_ID, extra.itemId);
        if (extra?.playlistId) localStorage.setItem(KEY_PLAYLIST_ID, extra.playlistId);
        if (extra?.path) localStorage.setItem(KEY_PATH, extra.path);
        if (extra?.trimInMs != null) localStorage.setItem(KEY_TRIM_IN, String(extra.trimInMs));
        if (extra?.trimOutMs != null) localStorage.setItem(KEY_TRIM_OUT, String(extra.trimOutMs));
        localStorage.setItem(KEY_VERSION, String(SNAPSHOT_VERSION));
        if (extra?.positionMs != null) localStorage.setItem(KEY_POSITION, String(extra.positionMs));
        if (extra?.updatedAt != null) localStorage.setItem(KEY_UPDATED, String(extra.updatedAt));
        if (extra?.paused != null) localStorage.setItem(KEY_PAUSED, String(extra.paused));
        if (extra?.channelOutputRateHz != null) localStorage.setItem(KEY_OUTPUT_RATE, String(extra.channelOutputRateHz));
    } catch {
        // localStorage unavailable — non-critical, progress timer still works in-session
    }
};

export const loadPlaybackState = (): PlaybackResumeState | null => {
    try {
        const storedUuid = localStorage.getItem(KEY_UUID);
        const storedStart = localStorage.getItem(KEY_START);
        const storedDuration = localStorage.getItem(KEY_DURATION);
        if (storedUuid && storedStart && storedDuration) {
            const trimIn = localStorage.getItem(KEY_TRIM_IN);
            const trimOut = localStorage.getItem(KEY_TRIM_OUT);
            return {
                version: Number(localStorage.getItem(KEY_VERSION) || 1),
                uuid: storedUuid,
                startTimestamp: Number(storedStart),
                durationMs: Number(storedDuration),
                itemId: localStorage.getItem(KEY_ITEM_ID) ?? undefined,
                playlistId: localStorage.getItem(KEY_PLAYLIST_ID) ?? undefined,
                path: localStorage.getItem(KEY_PATH) ?? undefined,
                trimInMs: trimIn != null ? Number(trimIn) : undefined,
                trimOutMs: trimOut != null ? Number(trimOut) : undefined,
                positionMs: Number(localStorage.getItem(KEY_POSITION) || 0),
                updatedAt: Number(localStorage.getItem(KEY_UPDATED) || storedStart),
                paused: localStorage.getItem(KEY_PAUSED) === 'true',
                channelOutputRateHz: Number(localStorage.getItem(KEY_OUTPUT_RATE) || 0) || undefined,
            };
        }
    } catch {
        // localStorage unavailable
    }
    return null;
};

export const clearPlaybackState = () => {
    try {
        localStorage.removeItem(KEY_UUID);
        localStorage.removeItem(KEY_START);
        localStorage.removeItem(KEY_DURATION);
        localStorage.removeItem(KEY_ITEM_ID);
        localStorage.removeItem(KEY_PLAYLIST_ID);
        localStorage.removeItem(KEY_PATH);
        localStorage.removeItem(KEY_TRIM_IN);
        localStorage.removeItem(KEY_TRIM_OUT);
        localStorage.removeItem(KEY_VERSION);
        localStorage.removeItem(KEY_POSITION);
        localStorage.removeItem(KEY_UPDATED);
        localStorage.removeItem(KEY_PAUSED);
        localStorage.removeItem(KEY_OUTPUT_RATE);
    } catch {
        // localStorage unavailable
    }
};
