import OBSWebSocket from 'obs-websocket-js';
import { ref } from 'vue';

export const obs = new OBSWebSocket();
export const isObsConnected = ref(false);
export const currentMediaTime = ref('00:00:00:00');
export const currentMediaMs = ref(0);
export const isPlaying = ref(false);
export const currentPlayingSourceName = ref('');
export const playStartTime = ref(0);   // epoch ms when current playlist segment started
export const playStartIndex = ref(0);  // which rundown index we started from

const startTimecodePolling = () => {
    setInterval(async () => {
        if (isPlaying.value && currentPlayingSourceName.value && currentPlayingSourceName.value.startsWith('SOTA_Player_')) {
            try {
                const status = await obs.call('GetMediaInputStatus', { inputName: currentPlayingSourceName.value });
                const ms = status.mediaCursor as number;
                currentMediaMs.value = ms;
                const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
                const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
                const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
                const f = String(Math.floor((ms % 1000) / 40)).padStart(2, '0');
                currentMediaTime.value = `${h}:${m}:${s}:${f}`;
            } catch { }
        }
    }, 80);
};

obs.on('ConnectionOpened', () => {
    isObsConnected.value = true;
    startTimecodePolling();
});
obs.on('ConnectionClosed', () => {
    isObsConnected.value = false;
    isPlaying.value = false;
});
obs.on('ConnectionError', (err) => { console.error('[OBS] Connection Error', err); });

// Timecode tracker
obs.on('MediaInputPlaybackStarted', (data) => {
    currentPlayingSourceName.value = data.inputName;
    isPlaying.value = true;
});

obs.on('MediaInputPlaybackEnded', (data: any) => {
    if (data.inputName !== `SOTA_Player_${PlaybackService.activeDeck}`) return;
    isPlaying.value = false;
    PlaybackService.onEnded(PlaybackService.playbackToken);
});

// ── PlaybackService ────────────────────────────────────────────────────────────

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
let stopRequested = false;

export const PlaybackService = {
    isSwitching: false,
    playbackToken: 0,
    activeDeck: 'A' as 'A' | 'B',

    onAdvance(cb: OnAdvanceCb) { onAdvanceCb = cb; },

    async play(items: PlayItem[], startIndex: number) {
        this.playbackToken++;
        const token = this.playbackToken;
        this.isSwitching = true;
        stopRequested = false;
        playItems = items;
        playIndex = startIndex;
        playStartTime.value = Date.now();
        playStartIndex.value = startIndex;

        await this._playAt(playIndex, token);
        if (this.playbackToken !== token) return;
        this.isSwitching = false;
    },

    async stop() {
        this.playbackToken++; // cancel ongoing plays
        stopRequested = true;
        if (outPointTimer) clearTimeout(outPointTimer);
        isPlaying.value = false;
        try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_A', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
        try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_B', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
        try { await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Black' }); } catch { }
        currentPlayingSourceName.value = '';
    },

    async cutToLive() {
        this.playbackToken++;
        stopRequested = true;
        if (outPointTimer) clearTimeout(outPointTimer);
        isPlaying.value = false;
        try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_A', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
        try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_B', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
        try { await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Live' }); } catch { }
        currentPlayingSourceName.value = '';
    },

    async cutToDeck(deckName: 'A' | 'B') {
        const newPlayer = `SOTA_Player_${deckName}`;
        const oldPlayer = `SOTA_Player_${deckName === 'A' ? 'B' : 'A'}`;

        try {
            await obs.call('SetSceneItemEnabled', {
                sceneName: 'SOTA_Program',
                sceneItemId: (await obs.call('GetSceneItemId', { sceneName: 'SOTA_Program', sourceName: newPlayer })).sceneItemId,
                sceneItemEnabled: true
            });
            await obs.call('SetSceneItemEnabled', {
                sceneName: 'SOTA_Program',
                sceneItemId: (await obs.call('GetSceneItemId', { sceneName: 'SOTA_Program', sourceName: oldPlayer })).sceneItemId,
                sceneItemEnabled: false
            });
        } catch (e) {
            console.error('[OBS] cutToDeck visibility toggle error', e);
        }

        try { await obs.call('TriggerMediaInputAction', { inputName: newPlayer, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' }); } catch { }
        try { await obs.call('TriggerMediaInputAction', { inputName: oldPlayer, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }

        this.activeDeck = deckName;
        currentPlayingSourceName.value = newPlayer;
    },

    async preloadDeck(deckName: 'A' | 'B', item: PlayItem, token: number) {
        if (this.playbackToken !== token) return;
        const player = `SOTA_Player_${deckName}`;
        const isNetwork = item.path.startsWith('http');

        try {
            await obs.call('SetInputSettings', {
                inputName: player,
                inputSettings: {
                    is_local_file: !isNetwork,
                    local_file: !isNetwork ? item.path : '',
                    input: isNetwork ? item.path : ''
                }
            });
        } catch (e) {
            console.error(`[OBS] Failed to set input settings for ${player}`, e);
        }

        if (this.playbackToken !== token) return;

        try {
            await obs.call('TriggerMediaInputAction', {
                inputName: player,
                mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
            });

            let retries = 0;
            while (retries < 40) { // Max 2 seconds wait
                if (this.playbackToken !== token) return;
                try {
                    const status = await obs.call('GetMediaInputStatus', { inputName: player });
                    if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING') break;
                } catch { }
                await new Promise(r => setTimeout(r, 50));
                retries++;
            }
            if (this.playbackToken !== token) return;

            await obs.call('TriggerMediaInputAction', {
                inputName: player,
                mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE'
            });

            if (item.inPoint > 0) {
                await obs.call('SetMediaInputCursor', {
                    inputName: player,
                    mediaCursor: item.inPoint
                });
            }
        } catch (e) {
            console.error(`[OBS] Failed to preload media into ${player}`, e);
        }
    },

    async _playAt(index: number, token: number) {
        if (this.playbackToken !== token) return;
        if (outPointTimer) clearTimeout(outPointTimer);

        if (index < 0 || index >= playItems.length) {
            isPlaying.value = false;
            return;
        }

        const item = playItems[index];
        if (!item) return;

        if (onAdvanceCb) onAdvanceCb(index);

        try {
            if (item.type === 'live') {
                await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Program' });
                try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_A', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
                try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_B', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }

                const dur = item.duration || item.outPoint || 0;
                if (dur > 0) {
                    outPointTimer = setTimeout(() => this.onEnded(token), dur * 1000);
                }
            } else {
                await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Program' });

                const newDeck = this.activeDeck === 'A' ? 'B' : 'A';

                await this.preloadDeck(newDeck, item, token);
                if (this.playbackToken !== token) return;

                await this.cutToDeck(newDeck);
                if (this.playbackToken !== token) return;

                if (item.outPoint > item.inPoint) {
                    const trimDuration = item.outPoint - item.inPoint;
                    outPointTimer = setTimeout(() => this.onEnded(token), trimDuration);
                }

                // Next-Item Buffering
                if (index + 1 < playItems.length) {
                    const nextItem = playItems[index + 1];
                    if (nextItem && nextItem.type !== 'live') {
                        const standbyDeck = this.activeDeck === 'A' ? 'B' : 'A';
                        this.preloadDeck(standbyDeck, nextItem, token).catch(e => console.error('[OBS] Buffering error:', e));
                    }
                }
            }
        } catch (e) {
            console.error('[Playback] Failed to play item:', e);
            this.onEnded(token);
        }
    },

    onEnded(token: number) {
        if (this.playbackToken !== token) return;
        if (this.isSwitching) return;
        if (stopRequested) {
            stopRequested = false;
            isPlaying.value = false;
            return;
        }
        if (outPointTimer) clearTimeout(outPointTimer);
        playIndex++;
        if (playIndex < playItems.length) {
            this.isSwitching = true;
            this._playAt(playIndex, token).then(() => {
                if (this.playbackToken === token) this.isSwitching = false;
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
            await obs.call('SetStudioModeEnabled', { studioModeEnabled: false });
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Program' }); } catch { }
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Black' }); } catch { }
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Live' }); } catch { }

            const setupPlayer = async (playerName: string) => {
                const settings = {
                    hw_decode: true,
                    close_when_inactive: false,
                    clear_on_media_end: true,
                    restart_on_activate: false
                };
                try {
                    await obs.call('CreateInput', {
                        sceneName: 'SOTA_Program',
                        inputName: playerName,
                        inputKind: 'ffmpeg_source',
                        inputSettings: settings
                    });
                } catch (e: any) {
                    try { await obs.call('SetInputSettings', { inputName: playerName, inputSettings: settings }); } catch { }
                }
            };

            await setupPlayer('SOTA_Player_A');
            await setupPlayer('SOTA_Player_B');

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

    static async clearCompliance() {
        try {
            const req = await obs.call('GetSceneItemId', { sceneName: 'SOTA_Program', sourceName: 'SOTA_Compliance_Bug' });
            await obs.call('SetSceneItemEnabled', {
                sceneName: 'SOTA_Program',
                sceneItemId: req.sceneItemId,
                sceneItemEnabled: false
            });
        } catch { }
    }

    static async seekMedia(inputName: string, timeCursor: number) {
        try {
            await obs.call('SetMediaInputCursor', {
                inputName: `SOTA_Player_${PlaybackService.activeDeck}`,
                mediaCursor: timeCursor
            });
        } catch { }
    }

    static async cueDecklink(url: number) { }
    static async cueVideo(filename: string, path: string) { }
    static async take() { }
    static async clear() {
        PlaybackService.stop();
    }

    static async getOutputs(): Promise<any[]> {
        try {
            const resp = await obs.call('GetOutputList');
            return resp.outputs as any[];
        } catch { return []; }
    }

    static async startDeckLink(outputName: string) {
        try { await obs.call('StartOutput', { outputName }); } catch { }
    }

    static async stopDeckLink(outputName: string) {
        try { await obs.call('StopOutput', { outputName }); } catch { }
    }
}

