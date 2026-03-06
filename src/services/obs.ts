import OBSWebSocket from 'obs-websocket-js';
import { ref } from 'vue';

export const obs = new OBSWebSocket();
export const isObsConnected = ref(false);
export const currentMediaTime = ref('00:00:00:00');
export const isPlaying = ref(false);
export const currentPlayingSourceName = ref('');
export const playStartTime = ref(0);   // epoch ms when current playlist segment started
export const playStartIndex = ref(0);  // which rundown index we started from

let tcInterval: ReturnType<typeof setInterval> | null = null;

obs.on('ConnectionOpened', () => { isObsConnected.value = true; });
obs.on('ConnectionClosed', () => { isObsConnected.value = false; isPlaying.value = false; });
obs.on('ConnectionError', (err) => { console.error('[OBS] Connection Error', err); });

// Timecode tracker
obs.on('MediaInputPlaybackStarted', (data) => {
    if (tcInterval) clearInterval(tcInterval);
    currentPlayingSourceName.value = data.inputName;
    isPlaying.value = true;
    tcInterval = setInterval(async () => {
        try {
            const status = await obs.call('GetMediaInputStatus', { inputName: data.inputName });
            const ms = status.mediaCursor as number;
            const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
            const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
            const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
            const f = String(Math.floor((ms % 1000) / 40)).padStart(2, '0');
            currentMediaTime.value = `${h}:${m}:${s}:${f}`;
        } catch { if (tcInterval) clearInterval(tcInterval); }
    }, 80);
});

obs.on('MediaInputPlaybackEnded', (data: any) => {
    // Only care about our unified media source
    if (data.inputName !== 'SOTA_Playout_Media' && data.inputName !== currentPlayingSourceName.value) return;
    if (tcInterval) clearInterval(tcInterval);
    isPlaying.value = false;
    // Auto-advance is handled externally by the playback service
    PlaybackService.onEnded();
});

// ── PlaybackService ────────────────────────────────────────────────────────────
// Manages playlist-style sequential playback through rundown items.
// The consumer (RundownList / App) calls PlaybackService.play(items, startIndex).
// ─────────────────────────────────────────────────────────────────────────────

type PlayItem = {
    id: string;
    type: 'video' | 'live' | 'graphic';
    filename: string;
    path: string;
    inPoint: number;
    outPoint: number;
    duration: number;
};

type OnAdvanceCb = (index: number) => void;
let playItems: PlayItem[] = [];
let playIndex = 0;
let onAdvanceCb: OnAdvanceCb | null = null;
let outPointTimer: ReturnType<typeof setTimeout> | null = null;
let stopRequested = false; // prevents onEnded() auto-advance on manual stop

export const PlaybackService = {
    isSwitching: false,

    onAdvance(cb: OnAdvanceCb) { onAdvanceCb = cb; },

    async play(items: PlayItem[], startIndex: number) {
        this.isSwitching = true;
        stopRequested = false;
        playItems = items;
        playIndex = startIndex;
        playStartTime.value = Date.now();
        playStartIndex.value = startIndex;
        await this._playAt(playIndex);
        this.isSwitching = false;
    },

    async stop() {
        stopRequested = true; // must be set BEFORE triggering OBS stop
        if (outPointTimer) clearTimeout(outPointTimer);
        isPlaying.value = false;
        try {
            await obs.call('TriggerMediaInputAction', {
                inputName: 'SOTA_Playout_Media',
                mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP'
            });
        } catch { }
        try { await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Black' }); } catch { }
        currentPlayingSourceName.value = '';
    },

    async _playAt(index: number) {
        if (outPointTimer) clearTimeout(outPointTimer);
        if (index < 0 || index >= playItems.length) {
            isPlaying.value = false;
            return;
        }
        const item = playItems[index];
        if (!item) return;

        if (onAdvanceCb) onAdvanceCb(index);

        // Unified 1-player strategy removes layering bugs
        const sourceName = 'SOTA_Playout_Media';

        try {
            if (item.type === 'live') {
                await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Program' });
                const dur = item.duration || item.outPoint || 0;
                if (dur > 0) {
                    outPointTimer = setTimeout(() => PlaybackService.onEnded(), dur * 1000);
                }
            } else {
                const isNetwork = item.path.startsWith('http');
                try {
                    await obs.call('CreateInput', {
                        sceneName: 'SOTA_Program',
                        inputName: sourceName,
                        inputKind: 'ffmpeg_source',
                        inputSettings: {
                            is_local_file: !isNetwork,
                            local_file: !isNetwork ? item.path : '',
                            input: isNetwork ? item.path : '',
                            hw_decode: true,
                            close_when_inactive: true,
                            clear_on_media_end: true // makes transparent when done
                        }
                    });
                } catch (e: any) {
                    // Update existing unified source
                    await obs.call('SetInputSettings', {
                        inputName: sourceName,
                        inputSettings: {
                            is_local_file: !isNetwork,
                            local_file: !isNetwork ? item.path : '',
                            input: isNetwork ? item.path : ''
                        }
                    });
                }

                await obs.call('TriggerMediaInputAction', {
                    inputName: sourceName,
                    mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
                });

                if (item.inPoint > 0) {
                    setTimeout(async () => {
                        try {
                            await obs.call('SetMediaInputCursor', {
                                inputName: sourceName, mediaCursor: item.inPoint
                            });
                        } catch { }
                    }, 300);
                }

                if (item.outPoint > item.inPoint) {
                    const trimDuration = item.outPoint - item.inPoint;
                    outPointTimer = setTimeout(() => PlaybackService.onEnded(), trimDuration);
                }

                await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Program' });
                currentPlayingSourceName.value = sourceName;
            }
        } catch (e) {
            console.error('[Playback] Failed to play item:', e);
            PlaybackService.onEnded();
        }
    },

    onEnded() {
        if (this.isSwitching) return; // Prevent OBS "Ended" events from skipping during file changes
        if (stopRequested) {
            stopRequested = false;
            isPlaying.value = false;
            return;
        }
        if (outPointTimer) clearTimeout(outPointTimer);
        playIndex++;
        if (playIndex < playItems.length) {
            this.isSwitching = true;
            PlaybackService._playAt(playIndex).then(() => {
                this.isSwitching = false;
            });
        } else {
            isPlaying.value = false;
            console.log('[Playback] Playlist finished.');
        }
    }
};

// ── ObsService ───────────────────────────────────────────────────────────────

export class ObsService {
    static async connect(url = 'ws://127.0.0.1:4455', password?: string) {
        try {
            await obs.connect(url, password);
            await obs.call('SetStudioModeEnabled', { studioModeEnabled: false }); // Simplified: direct to program
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Program' }); } catch { }
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Black' }); } catch { }
            await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Program' });
        } catch (error) {
            console.error('[OBS] Failed to connect', error);
            throw error;
        }
    }

    static async disconnect() { await obs.disconnect(); }

    static async startStream() { await obs.call('StartStream'); }
    static async stopStream() { await obs.call('StopStream'); }

    static async applyCompliance(fullUrl: string) {
        const sourceName = 'SOTA_Compliance_Bug';
        try {
            await obs.call('CreateInput', {
                sceneName: 'SOTA_Program', inputName: sourceName,
                inputKind: 'browser_source',
                inputSettings: {
                    url: fullUrl, width: 1920, height: 1080, is_local_file: false,
                    css: 'body{background:rgba(0,0,0,0);margin:0;overflow:hidden;}'
                }
            });
        } catch (e: any) {
            if (e.code === 600 || String(e).includes('exists')) {
                await obs.call('SetInputSettings', { inputName: sourceName, inputSettings: { url: fullUrl } });
            }
        }
    }
}
