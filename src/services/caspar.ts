import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ref } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { playStartIndex, playStartTime } from './obs';
import type { PlayoutAdvanceCallback, PlayoutItem, PlayoutService } from './playout';

const CASPAR_HOST = '127.0.0.1';
const CASPAR_AMCP_PORT = 5250;
const PROGRAM_CHANNEL = 1;
const PROGRAM_LAYER = 10;
const LIVE_LAYER = 20;
const FRAME_MS = 40;

interface CasparOscPayload {
    address: string;
    args: string[];
    positionMs?: number | null;
    durationMs?: number | null;
    receivedAt: string;
}

export const isCasparConnected = ref(false);
export const isCasparPlaying = ref(false);
export const currentCasparTime = ref('00:00:00:00');
export const currentCasparMs = ref(0);

let queuedItems: PlayoutItem[] = [];
let currentIndex = -1;
let advanceTimer: ReturnType<typeof setTimeout> | null = null;
let onAdvanceCallback: PlayoutAdvanceCallback | null = null;
let playToken = 0;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let positionBaseMs = 0;
let positionBaseAt = 0;
let feedbackListenerPromise: Promise<(() => void) | void> | null = null;

const getSettingsSnapshot = () => {
    try {
        return useSettingsStore();
    } catch {
        return {
            liveInputSourceName: ''
        } as const;
    }
};

const normalizeMediaPath = (path: string) => path.replace(/\\/g, '/').replace(/"/g, '\\"');

const formatTimecode = (ms: number) => {
    const safeMs = Math.max(0, Math.round(ms));
    const h = String(Math.floor(safeMs / 3600000)).padStart(2, '0');
    const m = String(Math.floor((safeMs % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((safeMs % 60000) / 1000)).padStart(2, '0');
    const f = String(Math.floor((safeMs % 1000) / FRAME_MS)).padStart(2, '0');
    return `${h}:${m}:${s}:${f}`;
};

const updateDisplayedTime = (ms: number) => {
    currentCasparMs.value = Math.max(0, Math.round(ms));
    currentCasparTime.value = formatTimecode(currentCasparMs.value);
};

const syncClockBase = (ms: number) => {
    positionBaseMs = Math.max(0, Math.round(ms));
    positionBaseAt = Date.now();
    updateDisplayedTime(positionBaseMs);
};

const startClock = () => {
    if (clockTimer) return;
    clockTimer = setInterval(() => {
        if (!isCasparPlaying.value) return;
        updateDisplayedTime(positionBaseMs + (Date.now() - positionBaseAt));
    }, 100);
};

const stopClock = () => {
    if (!clockTimer) return;
    clearInterval(clockTimer);
    clockTimer = null;
};

const clearAdvanceTimer = () => {
    if (!advanceTimer) return;
    clearTimeout(advanceTimer);
    advanceTimer = null;
};

const itemDurationMs = (item: PlayoutItem) => {
    if (item.type === 'live') return (item.plannedDuration || item.duration || 0) * 1000;
    if (item.outPoint > item.inPoint) return item.outPoint - item.inPoint;
    return (item.duration || item.plannedDuration || 0) * 1000;
};

const buildClipOptions = (item: PlayoutItem) => {
    const options: string[] = [];
    if (item.inPoint > 0) {
        options.push(`SEEK ${(item.inPoint / 1000).toFixed(3)}`);
    }
    const durationMs = itemDurationMs(item);
    if (durationMs > 0) {
        options.push(`LENGTH ${(durationMs / 1000).toFixed(3)}`);
    }
    return options.join(' ');
};

const buildVideoCommand = (item: PlayoutItem, autoPlay: boolean) => {
    const path = normalizeMediaPath(item.path);
    const options = buildClipOptions(item);
    const auto = autoPlay ? ' AUTO' : '';
    return `LOADBG ${PROGRAM_CHANNEL}-${PROGRAM_LAYER} "${path}" ${options}${auto}`.replace(/\s+/g, ' ').trim();
};

const buildLiveCommand = (preferredSource?: string) => {
    const source = (preferredSource || getSettingsSnapshot().liveInputSourceName || '').trim();
    return source ? `PLAY ${PROGRAM_CHANNEL}-${LIVE_LAYER} ${source}` : '';
};

const sendRawCommand = async (cmd: string) => {
    return invoke<string>('caspar_send_command', { cmd });
};

const ensureFeedbackListener = () => {
    if (feedbackListenerPromise) return feedbackListenerPromise;
    feedbackListenerPromise = listen<CasparOscPayload>('caspar-osc', (event) => {
        const payload = event.payload;
        if (payload.positionMs != null) {
            syncClockBase(payload.positionMs);
        }
    }).catch((error) => {
        console.warn('[CasparCG] Failed to attach OSC listener', error);
    });
    return feedbackListenerPromise;
};

const playAt = async (index: number, token: number) => {
    const item = queuedItems[index];
    if (!item || token !== playToken) return;

    currentIndex = index;
    onAdvanceCallback?.(index);

    if (item.type === 'live') {
        const liveCommand = buildLiveCommand(item.path);
        if (!liveCommand) {
            throw new Error('No CasparCG live source configured. Set a Live Input Source in Settings.');
        }
        await sendRawCommand(liveCommand);
        isCasparPlaying.value = true;
        syncClockBase(0);
        startClock();
        clearAdvanceTimer();
        const durationMs = itemDurationMs(item);
        if (durationMs > 0) {
            advanceTimer = setTimeout(() => {
                playAt(index + 1, token).catch((error) => {
                    console.error('[CasparCG] Failed to advance live item', error);
                });
            }, durationMs);
        }
        return;
    }

    await sendRawCommand(buildVideoCommand(item, true));
    isCasparPlaying.value = true;
    syncClockBase(item.inPoint || 0);
    startClock();

    clearAdvanceTimer();
    const durationMs = itemDurationMs(item);
    if (durationMs > 0) {
        advanceTimer = setTimeout(async () => {
            if (token !== playToken) return;
            const nextIndex = index + 1;
            if (nextIndex >= queuedItems.length) {
                await casparPlayoutService.stop();
                onAdvanceCallback?.(-1);
                return;
            }
            await playAt(nextIndex, token);
        }, durationMs);
    }
};

export const casparPlayoutService: PlayoutService = {
    engine: 'casparcg',
    label: 'CASPAR',
    supports: {
        preview: false,
        streaming: false,
        hardwareOutput: false,
        compliance: false,
        cue: true
    },

    async connect() {
        await ensureFeedbackListener();
        await sendRawCommand('INFO');
        isCasparConnected.value = true;
    },

    async disconnect() {
        await this.stop();
        isCasparConnected.value = false;
    },

    async play(items, startIndex) {
        await ensureFeedbackListener();
        if (!isCasparConnected.value) {
            await this.connect();
        }

        queuedItems = items;
        playToken += 1;
        clearAdvanceTimer();
        playStartTime.value = Date.now();
        playStartIndex.value = startIndex;

        if (startIndex < 0 || startIndex >= queuedItems.length) {
            await this.stop();
            return;
        }

        await playAt(startIndex, playToken);
    },

    async pause() {
        if (!isCasparConnected.value) return;
        await sendRawCommand(`PAUSE ${PROGRAM_CHANNEL}-${PROGRAM_LAYER}`);
        positionBaseMs = currentCasparMs.value;
        positionBaseAt = Date.now();
        isCasparPlaying.value = false;
    },

    async stop() {
        playToken += 1;
        clearAdvanceTimer();
        stopClock();
        isCasparPlaying.value = false;
        currentIndex = -1;
        syncClockBase(0);
        if (isCasparConnected.value) {
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}`);
        }
    },

    async cue(item) {
        await ensureFeedbackListener();
        if (!isCasparConnected.value) {
            await this.connect();
        }

        if (item.type === 'live') {
            const liveCommand = buildLiveCommand(item.path);
            if (!liveCommand) {
                throw new Error('No CasparCG live source configured. Set a Live Input Source in Settings.');
            }
            await sendRawCommand(liveCommand);
            return;
        }

        await sendRawCommand(buildVideoCommand(item, false));
        syncClockBase(item.inPoint || 0);
    },

    async take() {
        if (!isCasparConnected.value) {
            await this.connect();
        }
        await sendRawCommand(`PLAY ${PROGRAM_CHANNEL}-${PROGRAM_LAYER}`);
        isCasparPlaying.value = true;
        positionBaseAt = Date.now();
        startClock();
    },

    async clear() {
        await this.stop();
    },

    async cutToLive() {
        if (!isCasparConnected.value) {
            await this.connect();
        }
        const liveCommand = buildLiveCommand();
        if (!liveCommand) {
            throw new Error('No CasparCG live source configured. Set a Live Input Source in Settings.');
        }
        await sendRawCommand(liveCommand);
        isCasparPlaying.value = true;
        syncClockBase(0);
        startClock();
    },

    async refreshQueue(items) {
        queuedItems = items;
    },

    onAdvance(callback) {
        onAdvanceCallback = callback;
    },

    async getOutputs() {
        return [];
    },

    async getInputs() {
        return [];
    },

    async syncLiveInputScene() {
        return;
    },

    async syncBrandingAssets() {
        return;
    },

    async seekMedia(_inputName: string, timeCursor: number) {
        syncClockBase(timeCursor);
    },

    async applyComplianceForItem() {
        return;
    },

    async clearCompliance() {
        return;
    }
};
