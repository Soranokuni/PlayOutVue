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

let lastSyncCursor = 0;
let lastSyncTime = 0;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let rafId: number | null = null;

const syncMediaCursor = async () => {
    if (isPlaying.value && PlaybackService.isActiveSession && currentPlayingSourceName.value && currentPlayingSourceName.value.startsWith('SOTA_Player_')) {
        try {
            const status = await obs.call('GetMediaInputStatus', { inputName: currentPlayingSourceName.value });
            if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING') {
                const ms = status.mediaCursor as number;
                // only update if valid backslash difference isn't wildly off, or just trust OBS
                lastSyncCursor = ms;
                lastSyncTime = Date.now();
            }
        } catch { }
    }
};

const updateTimecodeLoop = () => {
    if (isPlaying.value && PlaybackService.isActiveSession) {
        const ms = lastSyncCursor + (Date.now() - lastSyncTime);
        currentMediaMs.value = ms;
        const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
        const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
        const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
        const f = String(Math.floor((ms % 1000) / 40)).padStart(2, '0');
        currentMediaTime.value = `${h}:${m}:${s}:${f}`;
    }
    rafId = requestAnimationFrame(updateTimecodeLoop);
};

obs.on('ConnectionOpened', () => {
    isObsConnected.value = true;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(syncMediaCursor, 1000);
    if (!rafId) rafId = requestAnimationFrame(updateTimecodeLoop);
    // Kill any residual media left from a previous session so OBS does not
    // auto-play the last loaded file on reconnect.
    setTimeout(async () => {
        if (!PlaybackService.isActiveSession) {
            try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_A', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
            try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_B', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
        }
    }, 500);
});
obs.on('ConnectionClosed', () => {
    isObsConnected.value = false;
    isPlaying.value = false;
    PlaybackService.isActiveSession = false;
    if (syncTimer) clearInterval(syncTimer);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
});
obs.on('ConnectionError', (err) => { console.error('[OBS] Connection Error', err); });

// FIX: Do NOT set isPlaying=false here — that causes the ON-AIR indicator to
// blink off while the playlist is still advancing to the next item.
// isPlaying is only set to false by onEnded() when the playlist is exhausted,
// or by stop() / cutToLive() when explicitly stopped.
obs.on('MediaInputPlaybackEnded', (data: any) => {
    if (data.inputName !== `SOTA_Player_${PlaybackService.activeDeck}`) return;
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
    isActiveSession: false,
    playbackToken: 0,
    activeDeck: 'A' as 'A' | 'B',
    // Pre-buffer cache: tracks which deck index has already been loaded into the standby.
    preloadedForIndex: -1,
    preloadedDeckForIndex: null as 'A' | 'B' | null,

    onAdvance(cb: OnAdvanceCb) { onAdvanceCb = cb; },

    async play(items: PlayItem[], startIndex: number) {
        this.playbackToken++;
        const token = this.playbackToken;
        this.isSwitching = true;
        this.isActiveSession = true;
        stopRequested = false;
        playItems = items;
        playIndex = startIndex;
        playStartTime.value = Date.now();
        playStartIndex.value = startIndex;

        // Force UI to show immediately instead of waiting for OBS WebSockets
        isPlaying.value = true;
        lastSyncCursor = 0;
        lastSyncTime = Date.now();

        await this._playAt(playIndex, token);
        if (this.playbackToken !== token) return;
        this.isSwitching = false;
    },

    async stop() {
        this.playbackToken++;
        stopRequested = true;
        this.isActiveSession = false;
        this.isSwitching = false; // release any stale switch lock
        this.preloadedForIndex = -1;
        this.preloadedDeckForIndex = null;
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
        this.isActiveSession = false;
        this.isSwitching = false;
        this.preloadedForIndex = -1;
        this.preloadedDeckForIndex = null;
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

    // Stage the next file path into the standby deck's source settings.
    // Critically: NO decoder is started here — zero background playthrough risk.
    // The actual RESTART + decode happens in openAndCut() at cut time.
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
                    input: isNetwork ? item.path : '',
                    restart_on_activate: true
                }
            });
        } catch (e) {
            console.error(`[OBS] Failed to stage file for ${player}`, e);
        }
    },

    // Open the decoder on the standby deck, wait for the first frame to be ready,
    // handle inPoint seek if needed, then atomically switch scene-item visibility.
    // This replaces the old cutToDeck() for video items and ensures the new deck
    // is NEVER visible before it is ready at exactly the right frame.
    async openAndCut(deckName: 'A' | 'B', item: PlayItem, token: number) {
        if (this.playbackToken !== token) return;
        const newPlayer = `SOTA_Player_${deckName}`;
        const oldPlayer = `SOTA_Player_${deckName === 'A' ? 'B' : 'A'}`;

        // SOTA LAZY LOADER PATTERN:
        // By relying on setupPlayer's `restart_on_activate: true`, OBS natively handles 
        // the frame-zero initialization exactly when the scene crossfade makes it active.
        // We no longer manually PAUSE/SEEK/PLAY decoder logic (Physical Trimming only).

        // Update state immediately so MediaInputPlaybackEnded tracking is correct.
        this.activeDeck = deckName;
        currentPlayingSourceName.value = newPlayer;

        // OBS native Fade: switch program to this deck's dedicated scene.
        // OBS crossfades from the current scene to the new one at 400 ms.
        const deckScene = `SOTA_Deck_${deckName}`;
        try {
            await (obs as any).call('SetCurrentProgramScene', { sceneName: deckScene });
        } catch (e) {
            console.error('[OBS] openAndCut: scene switch failed', e);
        }

        // Schedule the old deck STOP significantly AFTER the fade completes.
        // A full 1500ms safety net ensures we never chop off the outgoing
        // clip if OBS drops frames or stutters during the heavy rendering of a fade.
        const capturedOldPlayer = oldPlayer;
        setTimeout(() => {
            obs.call('TriggerMediaInputAction', { inputName: capturedOldPlayer, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }).catch(() => { });
        }, 1500);
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
                const newDeck = this.activeDeck === 'A' ? 'B' : 'A';

                // If the file path was already staged into the standby deck via the
                // background preload, we can skip staging and go straight to openAndCut.
                // If not staged, call preloadDeck to set the file path now.
                const alreadyStaged = this.preloadedForIndex === index && this.preloadedDeckForIndex === newDeck;
                if (alreadyStaged) {
                    this.preloadedForIndex = -1;
                    this.preloadedDeckForIndex = null;
                } else {
                    await this.preloadDeck(newDeck, item, token);
                    if (this.playbackToken !== token) return;
                }

                // openAndCut: RESTART decoder → wait for first frame → optional inPoint seek
                // → atomic visibility switch → play. No background playthrough possible.
                await this.openAndCut(newDeck, item, token);
                if (this.playbackToken !== token) return;

                // Reset rAF sync cursor to the start of this item's play region.
                lastSyncCursor = item.inPoint || 0;
                lastSyncTime = Date.now();

                // If the user specified an outPoint, schedule the playlist to advance exactly then.
                // If outPoint is 0, we let the clip play to EOF natively and rely on MediaInputPlaybackEnded.
                if (item.outPoint > 0 && item.outPoint > (item.inPoint || 0)) {
                    const trimDuration = item.outPoint - (item.inPoint || 0);
                    outPointTimer = setTimeout(() => this.onEnded(token), trimDuration);
                }

                // Background stage the next item's file path into the STANDBY deck.
                // This is now safe — only SetInputSettings, no decoder started.
                if (index + 1 < playItems.length) {
                    const nextItem = playItems[index + 1];
                    if (nextItem && nextItem.type !== 'live') {
                        const standbyDeck = this.activeDeck === 'A' ? 'B' : 'A';
                        this.preloadDeck(standbyDeck, nextItem, token)
                            .then(() => {
                                if (this.playbackToken === token) {
                                    this.preloadedForIndex = index + 1;
                                    this.preloadedDeckForIndex = standbyDeck;
                                }
                            })
                            .catch(e => console.error('[OBS] Staging error:', e));
                    }
                }
            }
        } catch (e) {
            console.error('[Playback] Failed to play item:', e);
            this.onEnded(token);
        }

    },

    onEnded(token: number) {
        if (!this.isActiveSession) return;
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
            // isPlaying stays TRUE here — we are advancing to the next item.
            // The ON-AIR/PLAY button must remain active while we transition.
            this._playAt(playIndex, token).then(() => {
                if (this.playbackToken === token) this.isSwitching = false;
            });
        } else {
            // Playlist truly finished — only NOW drop the on-air state.
            isPlaying.value = false;
            this.isActiveSession = false;
            currentPlayingSourceName.value = '';
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

            // Create utility scenes
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Black' }); } catch { }
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Live' }); } catch { }
            // SOTA_Program remains for compliance/graphic overlays
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Program' }); } catch { }

            // Each player lives in its own dedicated scene so that OBS can
            // crossfade between them using a native scene transition.
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Deck_A' }); } catch { }
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Deck_B' }); } catch { }

            const setupPlayer = async (playerName: string, sceneName: string) => {
                const settings = {
                    hw_decode: true,
                    close_when_inactive: false,
                    clear_on_media_end: true,
                    // SOTA Playback: OBS handles frame-zero restarts perfectly
                    // natively on scene visibility.
                    restart_on_activate: true
                };
                try {
                    await obs.call('CreateInput', {
                        sceneName,
                        inputName: playerName,
                        inputKind: 'ffmpeg_source',
                        inputSettings: settings
                    });
                } catch {
                    try { await obs.call('SetInputSettings', { inputName: playerName, inputSettings: settings }); } catch { }
                    // CRITICAL: ensure the source is a scene item in the deck scene.
                    // If the input already exists (e.g. from SOTA_Program), it MUST be added here.
                    try { await (obs as any).call('CreateSceneItem', { sceneName, sourceName: playerName, sceneItemEnabled: true }); } catch { }
                }
            };

            await setupPlayer('SOTA_Player_A', 'SOTA_Deck_A');
            await setupPlayer('SOTA_Player_B', 'SOTA_Deck_B');

            // Configure OBS scene transition to a smooth Fade at 600 ms.
            // This is what gives seamless crossfades between clips automatically.
            try { await (obs as any).call('SetCurrentSceneTransition', { transitionName: 'Fade' }); } catch { }
            try { await (obs as any).call('SetCurrentSceneTransitionDuration', { transitionDuration: 600 }); } catch { }

            // Start on the black hold scene — nothing plays until the user hits PLAY.
            await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Black' });
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

