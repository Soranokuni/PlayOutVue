import OBSWebSocket from 'obs-websocket-js';
import { invoke } from '@tauri-apps/api/core';
import { ref } from 'vue';
import { useSettingsStore } from '../stores/settings';
import type { PlayoutItem, PlayoutService } from './playout';

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
const PAL_FRAME_MS = 40;
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const ACTION_SAFE_MARGIN_X = 96;
const ACTION_SAFE_MARGIN_Y = 54;
const TITLE_SAFE_MARGIN_X = 192;
const TITLE_SAFE_MARGIN_Y = 108;
const STANDARD_LOGO_HEIGHT = 54;
const STANDARD_LOGO_MAX_WIDTH = 220;
const STANDARD_RATING_BOX = 68;
const STANDARD_TEXT_GAP = 20;
const STANDARD_TEXT_FONT_SIZE = 32;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getSettingsSnapshot = () => {
    try {
        return useSettingsStore();
    } catch {
        return {
            logosPath: '',
            watermarkPath: '',
            watermarkEnabled: false,
            watermarkPosition: 'top-right',
            watermarkOpacity: 80,
            watermarkScale: 15,
            liveInputSourceName: '',
            transitionFrames: 2,
            prerollFrames: 2,
            playoutProfile: 'PAL_1080I50'
        } as const;
    }
};

const getTransitionDurationMs = () => Math.max(PAL_FRAME_MS, (getSettingsSnapshot().transitionFrames || 2) * PAL_FRAME_MS);
const getPrerollDurationMs = () => Math.max(PAL_FRAME_MS, (getSettingsSnapshot().prerollFrames || 2) * PAL_FRAME_MS);
const PLAYOUT_SCENES = ['SOTA_Deck_A', 'SOTA_Deck_B', 'SOTA_Live'] as const;
const MANAGED_SCENES = ['SOTA_Black', 'SOTA_Live', 'SOTA_Program', 'SOTA_Deck_A', 'SOTA_Deck_B'] as const;
const MANAGED_INPUTS = ['SOTA_Player_A', 'SOTA_Player_B', 'SOTA_Channel_Watermark', 'SOTA_Compliance_Rating', 'SOTA_Compliance_Text'] as const;
const CORNER_ALIGNMENT_MAP = {
    'top-left': 5,
    'top-right': 9,
    'bottom-left': 1,
    'bottom-right': 3
} as const;
const DESCRIPTOR_TEXT: Record<string, string> = {
    violence: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ',
    sex: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ',
    substances: 'ΠΕΡΙΕΧΕΙ ΧΡΗΣΗ ΟΥΣΙΩΝ',
    language: 'ΠΕΡΙΕΧΕΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ'
};

type CompliancePlayItem = {
    complianceRating?: 'k' | '8' | '12' | '16' | '18';
    complianceDescriptors?: string[];
    complianceText?: string;
};

type ImageDimensions = {
    width: number;
    height: number;
};

const imageDimensionCache = new Map<string, ImageDimensions | null>();
let currentProgramSceneName = 'SOTA_Black';
let pendingComplianceState: CompliancePlayItem | null = null;
let currentPlayingItemId: string | null = null;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const fitImageWithinBox = (dimensions: ImageDimensions | null, maxWidth: number, maxHeight: number) => {
    if (!dimensions || !dimensions.width || !dimensions.height) {
        return {
            scale: 1,
            width: maxWidth,
            height: maxHeight
        };
    }

    const scale = Math.min(maxWidth / dimensions.width, maxHeight / dimensions.height);
    return {
        scale,
        width: Math.round(dimensions.width * scale),
        height: Math.round(dimensions.height * scale)
    };
};

const getImageDimensions = async (path: string): Promise<ImageDimensions | null> => {
    if (!path) return null;
    if (imageDimensionCache.has(path)) {
        return imageDimensionCache.get(path) ?? null;
    }

    try {
        const dimensions = await invoke<ImageDimensions>('get_image_dimensions', { path });
        imageDimensionCache.set(path, dimensions);
        return dimensions;
    } catch {
        imageDimensionCache.set(path, null);
        return null;
    }
};

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
    plannedDuration?: number;
} & CompliancePlayItem;

type OnAdvanceCb = (index: number) => void;
let playItems: PlayItem[] = [];
let playIndex = 0;
let onAdvanceCb: OnAdvanceCb | null = null;
let outPointTimer: ReturnType<typeof setTimeout> | null = null;
let advanceTimer: ReturnType<typeof setTimeout> | null = null;
let stopRequested = false;

export const PlaybackService = {
    isSwitching: false,
    isActiveSession: false,
    playbackToken: 0,
    activeDeck: 'A' as 'A' | 'B',
    // Pre-buffer cache: tracks which deck index has already been loaded into the standby.
    preloadedForIndex: -1,
    preloadedDeckForIndex: null as 'A' | 'B' | null,
    preloadRevision: 0,

    onAdvance(cb: OnAdvanceCb) { onAdvanceCb = cb; },

    clearTimers() {
        if (outPointTimer) clearTimeout(outPointTimer);
        if (advanceTimer) clearTimeout(advanceTimer);
        outPointTimer = null;
        advanceTimer = null;
    },

    getItemDurationMs(item: PlayItem) {
        if (item.type === 'live') return (item.plannedDuration || item.duration || 0) * 1000;
        if (item.outPoint > item.inPoint) return item.outPoint - item.inPoint;
        return (item.duration || 0) * 1000;
    },

    scheduleItemAdvance(index: number, item: PlayItem, token: number) {
        this.clearTimers();

        const itemDurationMs = this.getItemDurationMs(item);
        if (itemDurationMs <= 0) return;

        const hasNext = index + 1 < playItems.length;
        if (!hasNext) {
            outPointTimer = setTimeout(() => this.onEnded(token), itemDurationMs);
            return;
        }

        const overlapLeadMs = Math.min(
            itemDurationMs - PAL_FRAME_MS,
            getTransitionDurationMs() + getPrerollDurationMs()
        );

        if (overlapLeadMs <= 0) {
            outPointTimer = setTimeout(() => this.onEnded(token), itemDurationMs);
            return;
        }

        advanceTimer = setTimeout(() => {
            this.advanceToNext(token);
        }, Math.max(PAL_FRAME_MS, itemDurationMs - overlapLeadMs));
    },

    async advanceToNext(token: number) {
        if (!this.isActiveSession || this.playbackToken !== token || this.isSwitching) return;
        if (advanceTimer) {
            clearTimeout(advanceTimer);
            advanceTimer = null;
        }

        playIndex++;
        if (playIndex < playItems.length) {
            this.isSwitching = true;
            await this._playAt(playIndex, token);
            if (this.playbackToken === token) {
                this.isSwitching = false;
            }
            return;
        }

        this.onEnded(token);
    },

    async play(items: PlayItem[], startIndex: number) {
        this.playbackToken++;
        const token = this.playbackToken;
        this.preloadRevision++;
        this.isSwitching = true;
        this.isActiveSession = true;
        stopRequested = false;
        this.activeDeck = 'A';
        this.preloadedForIndex = -1;
        this.preloadedDeckForIndex = null;
        currentPlayingItemId = null;
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
        this.preloadRevision++;
        stopRequested = true;
        this.isActiveSession = false;
        this.isSwitching = false; // release any stale switch lock
        this.preloadedForIndex = -1;
        this.preloadedDeckForIndex = null;
        currentPlayingItemId = null;
        this.clearTimers();
        isPlaying.value = false;
        try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_A', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
        try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_B', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
        await ObsService.clearCompliance();
        try { await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Black' }); } catch { }
        currentProgramSceneName = 'SOTA_Black';
        await ObsService.syncOverlaysToScene('SOTA_Black');
        currentPlayingSourceName.value = '';
    },

    async cutToLive() {
        this.playbackToken++;
        this.preloadRevision++;
        stopRequested = true;
        this.isActiveSession = false;
        this.isSwitching = false;
        this.preloadedForIndex = -1;
        this.preloadedDeckForIndex = null;
        currentPlayingItemId = null;
        this.clearTimers();
        isPlaying.value = false;
        try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_A', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
        try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_B', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
        await ObsService.syncLiveInputScene();
        await ObsService.clearCompliance();
        try { await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Live' }); } catch { }
        currentProgramSceneName = 'SOTA_Live';
        await ObsService.syncOverlaysToScene('SOTA_Live');
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
    async preloadDeck(deckName: 'A' | 'B', item: PlayItem, token: number, revision?: number) {
        const expectedRevision = revision ?? this.preloadRevision;
        if (this.playbackToken !== token) return;
        if (expectedRevision !== this.preloadRevision) return;
        const player = `SOTA_Player_${deckName}`;
        const isNetwork = item.path.startsWith('http');
        try {
            await obs.call('SetInputSettings', {
                inputName: player,
                inputSettings: {
                    hw_decode: true,
                    close_when_inactive: false,
                    clear_on_media_end: true,
                    is_local_file: !isNetwork,
                    local_file: !isNetwork ? item.path : '',
                    input: isNetwork ? item.path : '',
                    restart_on_activate: true
                }
            });
            if (expectedRevision !== this.preloadRevision || this.playbackToken !== token) return;
        } catch (e) {
            console.error(`[OBS] Failed to stage file for ${player}`, e);
        }
    },

    async refreshQueue(items: PlayItem[]) {
        playItems = items;
        this.preloadedForIndex = -1;
        this.preloadedDeckForIndex = null;
        this.preloadRevision++;

        if (!this.isActiveSession) return;

        if (currentPlayingItemId) {
            const currentIndex = items.findIndex((item) => item.id === currentPlayingItemId);
            if (currentIndex !== -1) {
                playIndex = currentIndex;
            }
        }

        const nextItem = items[playIndex + 1];
        if (!nextItem || this.playbackToken <= 0) return;
        if (nextItem.type === 'live') return;

        const standbyDeck = this.activeDeck === 'A' ? 'B' : 'A';
        const revision = this.preloadRevision;
        await this.preloadDeck(standbyDeck, nextItem, this.playbackToken, revision);
        if (revision !== this.preloadRevision || !this.isActiveSession) return;
        this.preloadedForIndex = playIndex + 1;
        this.preloadedDeckForIndex = standbyDeck;
    },

    // Open the decoder on the standby deck, wait for the first frame to be ready,
    // handle inPoint seek if needed, then atomically switch scene-item visibility.
    // This replaces the old cutToDeck() for video items and ensures the new deck
    // is NEVER visible before it is ready at exactly the right frame.
    async openAndCut(deckName: 'A' | 'B', item: PlayItem, token: number) {
        if (this.playbackToken !== token) return;
        const newPlayer = `SOTA_Player_${deckName}`;
        const oldPlayer = `SOTA_Player_${deckName === 'A' ? 'B' : 'A'}`;
        const prerollMs = getPrerollDurationMs();
        const transitionMs = getTransitionDurationMs();

        // Update state immediately so MediaInputPlaybackEnded tracking is correct.
        this.activeDeck = deckName;
        currentPlayingSourceName.value = newPlayer;

        try {
            await obs.call('TriggerMediaInputAction', {
                inputName: newPlayer,
                mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
            });
        } catch { }

        if (item.inPoint > 0) {
            await sleep(PAL_FRAME_MS);
            try {
                await obs.call('SetMediaInputCursor', {
                    inputName: newPlayer,
                    mediaCursor: item.inPoint
                });
            } catch { }
        }

        await sleep(prerollMs);

        // OBS native Fade: switch program to this deck's dedicated scene.
        const deckScene = `SOTA_Deck_${deckName}`;
        try {
            await (obs as any).call('SetCurrentProgramScene', { sceneName: deckScene });
            currentProgramSceneName = deckScene;
        } catch (e) {
            console.error('[OBS] openAndCut: scene switch failed', e);
        }

        setTimeout(() => {
            ObsService.syncOverlaysToScene(deckScene).catch(() => { });
        }, transitionMs + 60);

        const capturedOldPlayer = oldPlayer;
        setTimeout(() => {
            obs.call('TriggerMediaInputAction', { inputName: capturedOldPlayer, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }).catch(() => { });
        }, transitionMs + prerollMs + 160);
    },

    async _playAt(index: number, token: number) {
        if (this.playbackToken !== token) return;
        this.clearTimers();

        if (index < 0 || index >= playItems.length) {
            isPlaying.value = false;
            return;
        }

        const item = playItems[index];
        if (!item) return;
        currentPlayingItemId = item.id;

        if (onAdvanceCb) onAdvanceCb(index);

        try {
            await ObsService.queueComplianceForItem(item);
            if (item.type === 'live') {
                await ObsService.syncLiveInputScene(item.path);
                await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Live' });
                currentProgramSceneName = 'SOTA_Live';
                await ObsService.syncOverlaysToScene('SOTA_Live');
                try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_A', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
                try { await obs.call('TriggerMediaInputAction', { inputName: 'SOTA_Player_B', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch { }
                currentPlayingSourceName.value = item.path || getSettingsSnapshot().liveInputSourceName || 'SOTA_Live';
                this.scheduleItemAdvance(index, item, token);
            } else {
                const newDeck = this.activeDeck === 'A' ? 'B' : 'A';

                // Always restage the target deck immediately before take.
                // Background caching remains as a hint only, but playback must never
                // depend on cached metadata because that can drift from OBS state.
                await this.preloadDeck(newDeck, item, token);
                if (this.playbackToken !== token) return;
                this.preloadedForIndex = -1;
                this.preloadedDeckForIndex = null;

                // openAndCut: RESTART decoder → wait for first frame → optional inPoint seek
                // → atomic visibility switch → play. No background playthrough possible.
                await this.openAndCut(newDeck, item, token);
                if (this.playbackToken !== token) return;

                // Reset rAF sync cursor to the start of this item's play region.
                lastSyncCursor = item.inPoint || 0;
                lastSyncTime = Date.now();

                this.scheduleItemAdvance(index, item, token);

                // Background stage the next item's file path into the STANDBY deck.
                // This is now safe — only SetInputSettings, no decoder started.
                if (index + 1 < playItems.length) {
                    const nextItem = playItems[index + 1];
                    if (nextItem && nextItem.type !== 'live') {
                        const standbyDeck = this.activeDeck === 'A' ? 'B' : 'A';
                        const revision = this.preloadRevision;
                        this.preloadDeck(standbyDeck, nextItem, token, revision)
                            .then(() => {
                                if (this.playbackToken === token && revision === this.preloadRevision) {
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
            currentPlayingItemId = null;
            return;
        }
        this.clearTimers();
        playIndex++;
        if (playIndex < playItems.length) {
            this.isSwitching = true;
            this._playAt(playIndex, token).then(() => {
                if (this.playbackToken === token) this.isSwitching = false;
            });
        } else {
            // Playlist truly finished — only NOW drop the on-air state.
            isPlaying.value = false;
            this.isActiveSession = false;
            currentPlayingItemId = null;
            currentPlayingSourceName.value = '';
            ObsService.clearCompliance().catch(() => {});
            console.log('[Playback] Playlist finished.');
        }
    }
};

// ── ObsService ───────────────────────────────────────────────────────────────

export class ObsService {
    private static async getSceneItems(sceneName: string) {
        try {
            const response = await (obs as any).call('GetSceneItemList', { sceneName });
            return Array.isArray(response?.sceneItems) ? response.sceneItems : [];
        } catch {
            return [];
        }
    }

    private static async clearScene(sceneName: string) {
        const sceneItems = await this.getSceneItems(sceneName);
        if (!sceneItems.length) return;

        await Promise.all(sceneItems.map((item: any) =>
            (obs as any).call('RemoveSceneItem', { sceneName, sceneItemId: item.sceneItemId }).catch(() => { })
        ));
    }

    private static async removeManagedInput(inputName: string) {
        try {
            await (obs as any).call('RemoveInput', { inputName });
        } catch { }
    }

    private static async resetManagedObsState() {
        pendingComplianceState = null;
        currentProgramSceneName = 'SOTA_Black';

        await Promise.all(MANAGED_SCENES.map((sceneName) => this.clearScene(sceneName)));
        await Promise.all(MANAGED_INPUTS.map((inputName) => this.removeManagedInput(inputName)));
    }

    private static async ensureInput(sceneName: string, inputName: string, inputKind: string, inputSettings: Record<string, any>) {
        try {
            await obs.call('CreateInput', {
                sceneName,
                inputName,
                inputKind,
                inputSettings,
                sceneItemEnabled: true
            });
        } catch {
            try { await obs.call('SetInputSettings', { inputName, inputSettings }); } catch { }
            try { await (obs as any).call('CreateSceneItem', { sceneName, sourceName: inputName, sceneItemEnabled: true }); } catch { }
        }
    }

    private static async removeDuplicateSceneItems(sceneName: string, sourceName: string, preferredSceneItemId?: number | null) {
        try {
            const response = await (obs as any).call('GetSceneItemList', { sceneName });
            const sceneItems = Array.isArray(response?.sceneItems) ? response.sceneItems : [];
            const matches = sceneItems.filter((item: any) => item.sourceName === sourceName);
            if (!matches.length) return preferredSceneItemId ?? null;

            const keepId = preferredSceneItemId != null && matches.some((item: any) => item.sceneItemId === preferredSceneItemId)
                ? preferredSceneItemId
                : matches[0].sceneItemId;

            await Promise.all(matches
                .filter((item: any) => item.sceneItemId !== keepId)
                .map((item: any) => (obs as any).call('RemoveSceneItem', { sceneName, sceneItemId: item.sceneItemId }).catch(() => { })));

            return keepId;
        } catch {
            return preferredSceneItemId ?? null;
        }
    }

    private static async ensureSceneItem(sceneName: string, sourceName: string) {
        try {
            const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName, sourceName });
            return await this.removeDuplicateSceneItems(sceneName, sourceName, sceneItemId);
        } catch {
            try {
                await (obs as any).call('CreateSceneItem', { sceneName, sourceName, sceneItemEnabled: true });
                const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName, sourceName });
                return await this.removeDuplicateSceneItems(sceneName, sourceName, sceneItemId);
            } catch {
                return null;
            }
        }
    }

    private static isPlayoutScene(sceneName: string): sceneName is typeof PLAYOUT_SCENES[number] {
        return (PLAYOUT_SCENES as readonly string[]).includes(sceneName);
    }

    private static async setSourceEnabledOnScene(sceneName: string, sourceName: string, enabled: boolean) {
        const sceneItemId = await this.ensureSceneItem(sceneName, sourceName);
        if (sceneItemId == null) return;
        try {
            await obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: enabled });
        } catch { }
    }

    private static async setSourceTransformOnScene(sceneName: string, sourceName: string, transform: Record<string, unknown>) {
        const sceneItemId = await this.ensureSceneItem(sceneName, sourceName);
        if (sceneItemId == null) return;
        try {
            await (obs as any).call('SetSceneItemTransform', {
                sceneName,
                sceneItemId,
                sceneItemTransform: transform
            });
        } catch { }
    }

    private static async disableSourceOnAllScenes(sourceName: string) {
        await Promise.all(PLAYOUT_SCENES.map((sceneName) => this.setSourceEnabledOnScene(sceneName, sourceName, false)));
    }

    private static async buildWatermarkTransform() {
        const settings = getSettingsSnapshot();
        const position = settings.watermarkPosition || 'top-right';
        const watermarkPath = this.getWatermarkAssetPath();
        const dimensions = await getImageDimensions(watermarkPath);
        const sizeMultiplier = clamp((settings.watermarkScale || 15) / 15, 0.65, 2.4);
        const fit = fitImageWithinBox(dimensions, STANDARD_LOGO_MAX_WIDTH * sizeMultiplier, STANDARD_LOGO_HEIGHT * sizeMultiplier);
        const isBottom = position.startsWith('bottom');
        const isRight = position.endsWith('right');

        return {
            alignment: CORNER_ALIGNMENT_MAP[position],
            positionX: isRight ? FRAME_WIDTH - ACTION_SAFE_MARGIN_X : ACTION_SAFE_MARGIN_X,
            positionY: isBottom ? FRAME_HEIGHT - ACTION_SAFE_MARGIN_Y : ACTION_SAFE_MARGIN_Y,
            scaleX: fit.scale,
            scaleY: fit.scale
        };
    }

    private static async buildRatingTransform(ratingPath: string) {
        const dimensions = await getImageDimensions(ratingPath);
        const fit = fitImageWithinBox(dimensions, STANDARD_RATING_BOX, STANDARD_RATING_BOX);
        return {
            fit,
            transform: {
                alignment: CORNER_ALIGNMENT_MAP['top-left'],
                positionX: TITLE_SAFE_MARGIN_X,
                positionY: TITLE_SAFE_MARGIN_Y,
                scaleX: fit.scale,
                scaleY: fit.scale
            }
        };
    }

    private static buildComplianceTextTransform(ratingWidth: number, ratingHeight: number) {
        return {
            alignment: CORNER_ALIGNMENT_MAP['top-left'],
            positionX: TITLE_SAFE_MARGIN_X + ratingWidth + STANDARD_TEXT_GAP,
            positionY: TITLE_SAFE_MARGIN_Y + Math.max(0, Math.round((ratingHeight - STANDARD_TEXT_FONT_SIZE) / 2)),
            scaleX: 1,
            scaleY: 1
        };
    }

    private static async applyWatermarkToScene(sceneName: typeof PLAYOUT_SCENES[number]) {
        const settings = getSettingsSnapshot();
        const watermarkPath = this.getWatermarkAssetPath();

        if (!settings.watermarkEnabled || !watermarkPath) {
            await this.disableSourceOnAllScenes('SOTA_Channel_Watermark');
            return;
        }

        await this.ensureInput('SOTA_Deck_A', 'SOTA_Channel_Watermark', 'image_source', {
            file: watermarkPath,
            unload: false
        });

        await Promise.all(PLAYOUT_SCENES.slice(1).map((targetScene) => this.ensureSceneItem(targetScene, 'SOTA_Channel_Watermark')));
        await this.disableSourceOnAllScenes('SOTA_Channel_Watermark');
        await this.setSourceTransformOnScene(sceneName, 'SOTA_Channel_Watermark', await this.buildWatermarkTransform());
        await this.setSourceEnabledOnScene(sceneName, 'SOTA_Channel_Watermark', true);
    }

    private static async applyComplianceToScene(sceneName: typeof PLAYOUT_SCENES[number]) {
        const rating = pendingComplianceState?.complianceRating || 'k';
        const ratingPath = this.getRatingAssetPath(rating);
        const descriptorText = [
            ...((pendingComplianceState?.complianceDescriptors || []).map((descriptor) => DESCRIPTOR_TEXT[descriptor]).filter(Boolean)),
            pendingComplianceState?.complianceText || ''
        ].filter(Boolean).join(' • ');

        if (ratingPath) {
            const { fit, transform } = await this.buildRatingTransform(ratingPath);
            await this.ensureInput('SOTA_Deck_A', 'SOTA_Compliance_Rating', 'image_source', {
                file: ratingPath,
                unload: false
            });
            await Promise.all(PLAYOUT_SCENES.slice(1).map((targetScene) => this.ensureSceneItem(targetScene, 'SOTA_Compliance_Rating')));
            await this.disableSourceOnAllScenes('SOTA_Compliance_Rating');
            await this.setSourceTransformOnScene(sceneName, 'SOTA_Compliance_Rating', transform);
            await this.setSourceEnabledOnScene(sceneName, 'SOTA_Compliance_Rating', true);

            if (descriptorText) {
                await this.ensureInput('SOTA_Deck_A', 'SOTA_Compliance_Text', 'text_gdiplus_v2', {
                    text: descriptorText,
                    align: 'left',
                    extents: true,
                    extents_cx: FRAME_WIDTH - (TITLE_SAFE_MARGIN_X * 2) - fit.width - STANDARD_TEXT_GAP,
                    extents_cy: 96,
                    outline: true,
                    outline_size: 4,
                    font: {
                        face: 'Arial',
                        size: STANDARD_TEXT_FONT_SIZE,
                        style: 'Bold'
                    }
                });
                await Promise.all(PLAYOUT_SCENES.slice(1).map((targetScene) => this.ensureSceneItem(targetScene, 'SOTA_Compliance_Text')));
                await this.disableSourceOnAllScenes('SOTA_Compliance_Text');
                await this.setSourceTransformOnScene(sceneName, 'SOTA_Compliance_Text', this.buildComplianceTextTransform(fit.width, fit.height));
                await this.setSourceEnabledOnScene(sceneName, 'SOTA_Compliance_Text', true);
            } else {
                await this.disableSourceOnAllScenes('SOTA_Compliance_Text');
            }
        } else {
            await this.disableSourceOnAllScenes('SOTA_Compliance_Rating');
            await this.disableSourceOnAllScenes('SOTA_Compliance_Text');
        }
    }

    static async syncOverlaysToScene(sceneName: string) {
        currentProgramSceneName = sceneName;

        if (!this.isPlayoutScene(sceneName)) {
            await Promise.all([
                this.disableSourceOnAllScenes('SOTA_Channel_Watermark'),
                this.disableSourceOnAllScenes('SOTA_Compliance_Rating'),
                this.disableSourceOnAllScenes('SOTA_Compliance_Text')
            ]);
            return;
        }

        await this.applyWatermarkToScene(sceneName);
        await this.applyComplianceToScene(sceneName);
    }

    private static resolveLogoAsset(filename: string) {
        const { logosPath } = getSettingsSnapshot();
        if (!logosPath) return '';
        const separator = /[\\/]$/.test(logosPath) ? '' : '/';
        return `${logosPath}${separator}${filename}`;
    }

    private static getWatermarkAssetPath() {
        const settings = getSettingsSnapshot();
        return settings.watermarkPath || this.resolveLogoAsset('logo.png');
    }

    private static getRatingAssetPath(rating: string) {
        const fileName = rating === 'k' ? 'K.png' : `${rating}.png`;
        return this.resolveLogoAsset(fileName);
    }

    static async syncBrandingAssets() {
        const settings = getSettingsSnapshot();
        const watermarkPath = this.getWatermarkAssetPath();

        if (!settings.watermarkEnabled || !watermarkPath) {
            await this.disableSourceOnAllScenes('SOTA_Channel_Watermark');
            return;
        }

        await this.ensureInput('SOTA_Deck_A', 'SOTA_Channel_Watermark', 'image_source', {
            file: watermarkPath,
            unload: false
        });

        await Promise.all(PLAYOUT_SCENES.slice(1).map((sceneName) => this.ensureSceneItem(sceneName, 'SOTA_Channel_Watermark')));
        await this.syncOverlaysToScene(currentProgramSceneName);
    }

    static async connect(url = 'ws://127.0.0.1:4455', password?: string) {
        try {
            await obs.connect(url, password);
            await obs.call('SetStudioModeEnabled', { studioModeEnabled: false });

            // Reset all SOTA-managed scenes and inputs on every initialization.
            // This removes clutter from prior runs and guarantees stable source order.
            await this.resetManagedObsState();

            // Create utility scenes
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Black' }); } catch { }
            try { await obs.call('CreateScene', { sceneName: 'SOTA_Live' }); } catch { }
            // SOTA_Program remains available for future downstream-key workflows
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

            await this.syncLiveInputScene();
            await this.syncBrandingAssets();
            await this.clearCompliance();

            try { await (obs as any).call('SetCurrentSceneTransition', { transitionName: 'Fade' }); } catch { }
            try { await (obs as any).call('SetCurrentSceneTransitionDuration', { transitionDuration: getTransitionDurationMs() }); } catch { }

            // Start on the black hold scene — nothing plays until the user hits PLAY.
            await obs.call('SetCurrentProgramScene', { sceneName: 'SOTA_Black' });
            currentProgramSceneName = 'SOTA_Black';
        } catch (error) {
            console.error('[OBS] Failed to connect', error);
            throw error;
        }
    }

    static async disconnect() { await obs.disconnect(); }

    static async syncLiveInputScene(preferredSourceName?: string) {
        const desiredSource = preferredSourceName || getSettingsSnapshot().liveInputSourceName;
        if (!desiredSource) return;

        try { await obs.call('CreateScene', { sceneName: 'SOTA_Live' }); } catch { }

        try {
            await obs.call('GetSceneItemId', { sceneName: 'SOTA_Live', sourceName: desiredSource });
        } catch {
            try {
                await (obs as any).call('CreateSceneItem', { sceneName: 'SOTA_Live', sourceName: desiredSource, sceneItemEnabled: true });
            } catch { }
        }

        try {
            const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: 'SOTA_Live', sourceName: desiredSource });
            await obs.call('SetSceneItemEnabled', {
                sceneName: 'SOTA_Live',
                sceneItemId,
                sceneItemEnabled: true
            });
        } catch { }
    }

    static async startStream() { await obs.call('StartStream'); }
    static async stopStream() { await obs.call('StopStream'); }

    static async queueComplianceForItem(item: CompliancePlayItem) {
        pendingComplianceState = {
            complianceRating: item.complianceRating || 'k',
            complianceDescriptors: [...(item.complianceDescriptors || [])],
            complianceText: item.complianceText || ''
        };
    }

    static async applyComplianceForItem(item: CompliancePlayItem) {
        await this.queueComplianceForItem(item);
        await this.syncOverlaysToScene(currentProgramSceneName);
    }

    static async clearCompliance() {
        pendingComplianceState = null;
        await this.disableSourceOnAllScenes('SOTA_Compliance_Rating');
        await this.disableSourceOnAllScenes('SOTA_Compliance_Text');
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

    static async getInputs(): Promise<any[]> {
        try {
            const resp = await obs.call('GetInputList');
            return resp.inputs as any[];
        } catch {
            return [];
        }
    }

    static async startDeckLink(outputName: string) {
        try { await obs.call('StartOutput', { outputName }); } catch { }
    }

    static async stopDeckLink(outputName: string) {
        try { await obs.call('StopOutput', { outputName }); } catch { }
    }
}

export const obsPlayoutService: PlayoutService = {
    engine: 'obs',
    label: 'OBS',
    supports: {
        preview: true,
        streaming: true,
        hardwareOutput: true,
        compliance: true,
        cue: true
    },

    async connect(url?: string, password?: string) {
        await ObsService.connect(url, password);
    },

    async disconnect() {
        await ObsService.disconnect();
    },

    async play(items: PlayoutItem[], startIndex: number) {
        await PlaybackService.play(items as any, startIndex);
    },

    async pause() {
        try {
            await obs.call('TriggerMediaInputAction', {
                inputName: `SOTA_Player_${PlaybackService.activeDeck}`,
                mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE'
            });
            isPlaying.value = false;
        } catch { }
    },

    async stop() {
        await PlaybackService.stop();
    },

    async cue(item: PlayoutItem) {
        if (item.type === 'live') {
            await ObsService.cueDecklink(Number(item.path));
            return;
        }

        await ObsService.cueVideo(item.filename, item.path);
    },

    async take() {
        await ObsService.take();
    },

    async clear() {
        await ObsService.clear();
    },

    async cutToLive() {
        await PlaybackService.cutToLive();
    },

    async refreshQueue(items: PlayoutItem[]) {
        await PlaybackService.refreshQueue(items as any);
    },

    onAdvance(callback) {
        PlaybackService.onAdvance(callback);
    },

    async getOutputs() {
        return ObsService.getOutputs();
    },

    async getInputs() {
        return ObsService.getInputs();
    },

    async syncLiveInputScene(preferredSourceName?: string) {
        await ObsService.syncLiveInputScene(preferredSourceName);
    },

    async syncBrandingAssets() {
        await ObsService.syncBrandingAssets();
    },

    async startStream() {
        await ObsService.startStream();
    },

    async stopStream() {
        await ObsService.stopStream();
    },

    async startDeckLink(outputName: string) {
        await ObsService.startDeckLink(outputName);
    },

    async stopDeckLink(outputName: string) {
        await ObsService.stopDeckLink(outputName);
    },

    async seekMedia(inputName: string, timeCursor: number) {
        await ObsService.seekMedia(inputName, timeCursor);
    },

    async applyComplianceForItem(item: PlayoutItem) {
        await ObsService.applyComplianceForItem(item);
    },

    async clearCompliance() {
        await ObsService.clearCompliance();
    }
};

