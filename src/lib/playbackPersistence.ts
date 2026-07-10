const KEY_UUID = 'playout_activePlayingUuid';
const KEY_START = 'playout_playbackStartTimestamp';
const KEY_DURATION = 'playout_playbackDurationMs';

export const savePlaybackState = (uuid: string, startTimestamp: number, durationMs: number) => {
    try {
        localStorage.setItem(KEY_UUID, uuid);
        localStorage.setItem(KEY_START, String(startTimestamp));
        localStorage.setItem(KEY_DURATION, String(durationMs));
    } catch {
        // localStorage unavailable — non-critical, progress timer still works in-session
    }
};

export const loadPlaybackState = () => {
    try {
        const storedUuid = localStorage.getItem(KEY_UUID);
        const storedStart = localStorage.getItem(KEY_START);
        const storedDuration = localStorage.getItem(KEY_DURATION);
        if (storedUuid && storedStart && storedDuration) {
            return {
                uuid: storedUuid,
                startTimestamp: Number(storedStart),
                durationMs: Number(storedDuration),
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
    } catch {
        // localStorage unavailable
    }
};
