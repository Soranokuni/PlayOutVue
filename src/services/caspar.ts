import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ref } from 'vue';
import { useSettingsStore } from '../stores/settings';
import type { ComplianceRating } from '../stores/rundown';
import { playStartIndex, playStartTime } from './obs';
import type { PlayoutAdvanceCallback, PlayoutItem, PlayoutService } from './playout';

const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);

const CASPAR_HOST = '127.0.0.1';
const CASPAR_AMCP_PORT = 5250;
const PROGRAM_CHANNEL = 1;
const PROGRAM_LAYER = 10;
const LIVE_LAYER = 20;
const FRAME_MS = 40;
const PAL_FPS = 25;

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
export const currentCasparDurationMs = ref(0);

let queuedItems: PlayoutItem[] = [];
let currentIndex = -1;
let advanceTimer: ReturnType<typeof setTimeout> | null = null;
let onAdvanceCallback: PlayoutAdvanceCallback | null = null;
let playToken = 0;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let positionBaseMs = 0;
let positionBaseAt = 0;
let feedbackListenerPromise: Promise<(() => void) | void> | null = null;

const isProgramFileTimeAddress = (address: string) => {
    const normalized = (address || '').trim();
    if (!normalized.startsWith(`/channel/${PROGRAM_CHANNEL}/`)) {
        return false;
    }

    if (normalized === `/channel/${PROGRAM_CHANNEL}/foreground/file/time`) {
        return true;
    }

    return new RegExp(
        `^/channel/${PROGRAM_CHANNEL}/stage/layer/${PROGRAM_LAYER}/(?:foreground/)?file/time$`
    ).test(normalized);
};

const getSettingsSnapshot = () => {
    try {
        return useSettingsStore();
    } catch {
        return {
            liveInputSourceName: '',
            localMediaPath: '',
            watermarkPath: '',
            watermarkEnabled: false,
            watermarkPosition: 'top-left',
            watermarkOpacity: 80,
            watermarkScale: 15,
            logosPath: '',
            casparOscPort: 6250
        } as ReturnType<typeof useSettingsStore>;
    }
};

const getConfiguredOscPort = () => {
    const port = Number(getSettingsSnapshot().casparOscPort || 6250);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return 6250;
    }
    return Math.round(port);
};

const normalizeMediaPath = (rawPath: string) => {
    const settings = getSettingsSnapshot();
    let p = rawPath.replace(/\\/g, '/');
    const mediaRoot = (settings.localMediaPath || '').replace(/\\/g, '/').replace(/\/+$/, '');

    // Try stripping the configured media root (handles both long and short paths):
    // We strip based on the last occurrence of the media root base name segment.
    // A short path like C:/CASPAR~1/Media/VIDEO~1.mp4 may not share prefix with
    // C:/CasparCG/Media, so we try stripping just the drive+root portion by attempting
    // both the original path and looking for the known relative portion.
    if (mediaRoot) {
        const pLower = p.toLowerCase();
        const rootLower = mediaRoot.toLowerCase();
        if (pLower.startsWith(rootLower)) {
            p = p.substring(mediaRoot.length).replace(/^\/+/, '');
        } else {
            // Short path case: extract relative to the root folder name
            // e.g. if mediaRoot = 'C:/CasparCG/Media' and short path is 'C:/CASPAR~1/MEDIA/VIDEO~1.MP4'
            // we find 'MEDIA' folder portion and keep only the relative tree.
            const rootParts = mediaRoot.split('/');
            const rootBaseName = (rootParts[rootParts.length - 1] || '').toLowerCase();
            const pParts = p.split('/');
            const rootIdx = pParts.findIndex(s => s.toLowerCase() === rootBaseName ||
                s.toLowerCase().replace(/~\d+$/, '').startsWith(rootBaseName.substring(0, 4)));
            if (rootIdx >= 0) {
                p = pParts.slice(rootIdx + 1).join('/');
            } else {
                // Absolute fallback: just the filename
                p = pParts[pParts.length - 1] || p;
            }
        }
    }

    // Remove extension that CasparCG doesn't need
    return p.replace(/"/g, '\\"');
};

const prepareCasparMediaPath = async (rawPath: string) => {
    if (!rawPath) return '';

    try {
        return await invoke<string>('prepare_caspar_media_path', {
            path: rawPath,
            mediaRoot: getSettingsSnapshot().localMediaPath || ''
        });
    } catch (error) {
        console.warn('[CasparCG] Falling back to direct path after prepare failure', rawPath, error);
        return normalizeMediaPath(rawPath);
    }
};

const getLogosRoot = () => {
    const { logosPath, localMediaPath } = getSettingsSnapshot();
    if (logosPath) return logosPath;
    if (!localMediaPath) return '';
    const separator = /[\\/]$/.test(localMediaPath) ? '' : '/';
    return `${localMediaPath}${separator}logos`;
};

const resolveLogoAsset = (filename: string): string => {
    const logosRoot = getLogosRoot();
    if (!logosRoot) return '';
    const separator = /[\\/]$/.test(logosRoot) ? '' : '/';
    return `${logosRoot}${separator}${filename}`;
};

const getRatingAssetPath = (rating: string): string => {
    const fileName = rating === 'k' ? 'K.png' : `${rating}.png`;
    return resolveLogoAsset(fileName);
};

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

const stripMediaExtension = (value: string) => value.replace(/\.[^./\\]+$/, '');

const parseCasparTimecodeMs = (value: string, fps = PAL_FPS) => {
    const match = value.match(/(\d{2}):(\d{2}):(\d{2}):(\d{2})/);
    if (!match) return 0;
    const [, hours, minutes, seconds, frames] = match;
    const frameMs = 1000 / Math.max(1, fps);
    return (
        Number(hours) * 3600000 +
        Number(minutes) * 60000 +
        Number(seconds) * 1000 +
        Math.round(Number(frames) * frameMs)
    );
};

const parseSecondsToMs = (value: string) => {
    const seconds = Number.parseFloat(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.round(seconds * 1000);
};

const parseNumericXmlTag = (response: string, tagName: string) => {
    const match = response.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'i'));
    if (!match?.[1]) return 0;
    const value = Number.parseFloat(match[1].trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const parseDurationFromCasparResponse = (response: string) => {
    if (!response) return 0;

    const elapsedTotalMatch = response.match(/(?:\||\b)(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?:\b|\|)/);
    if (elapsedTotalMatch?.[2]) {
        const durationMs = parseSecondsToMs(elapsedTotalMatch[2]);
        if (durationMs > 0) return durationMs;
    }

    const durationFieldMatch = response.match(/duration[^\d]{0,12}(\d+(?:\.\d+)?)/i);
    if (durationFieldMatch?.[1]) {
        const durationMs = parseSecondsToMs(durationFieldMatch[1]);
        if (durationMs > 0) return durationMs;
    }

    const secondsTags = ['duration', 'length', 'file-duration', 'clip-duration'];
    for (const tagName of secondsTags) {
        const tagValue = parseNumericXmlTag(response, tagName);
        const durationMs = parseSecondsToMs(String(tagValue));
        if (durationMs > 0) return durationMs;
    }

    const frameCount =
        parseNumericXmlTag(response, 'file-nb-frames') ||
        parseNumericXmlTag(response, 'nb-frames') ||
        parseNumericXmlTag(response, 'frame-count');
    if (frameCount > 0) {
        const fps =
            parseNumericXmlTag(response, 'fps') ||
            parseNumericXmlTag(response, 'frame-rate') ||
            parseNumericXmlTag(response, 'framerate') ||
            PAL_FPS;
        const durationMs = Math.round((frameCount / Math.max(1, fps)) * 1000);
        if (durationMs > 0) return durationMs;
    }

    const timecodeMatches = [...response.matchAll(/(\d{2}:\d{2}:\d{2}:\d{2})/g)];
    if (timecodeMatches.length > 0) {
        const lastMatch = timecodeMatches[timecodeMatches.length - 1]?.[1];
        if (lastMatch) {
            const durationMs = parseCasparTimecodeMs(lastMatch);
            if (durationMs > 0) return durationMs;
        }
    }

    return 0;
};

const parseDurationFromCasparList = (response: string, clipKey: string) => {
    const normalizedKey = stripMediaExtension((clipKey || '').replace(/\\/g, '/')).toLowerCase();
    const fallbackName = normalizedKey.split('/').pop() || normalizedKey;

    for (const line of response.split(/\r?\n/)) {
        const match = line.match(/^"([^"]+)"\s+\S+\s+(\d{2}:\d{2}:\d{2}:\d{2})/i);
        if (!match) continue;
        const [, rawEntryName, rawTimecode] = match;
        if (!rawEntryName || !rawTimecode) continue;
        const entryName = stripMediaExtension(rawEntryName).toLowerCase();
        if (entryName === normalizedKey || entryName.endsWith(`/${fallbackName}`) || entryName === fallbackName) {
            return parseCasparTimecodeMs(rawTimecode);
        }
    }

    return 0;
};

const queryActiveLayerDurationMs = async () => {
    try {
        const response = await sendRawCommand(`INFO ${PROGRAM_CHANNEL}-${PROGRAM_LAYER}`);
        return parseDurationFromCasparResponse(response);
    } catch (error) {
        console.warn('[CasparCG] INFO duration lookup failed', error);
        return 0;
    }
};

const queryCasparDurationMs = async (item: PlayoutItem) => {
    const rawPath = (item.shortPath || item.path || '').trim();
    if (!rawPath || /^https?:/i.test(rawPath)) return 0;

    try {
        const preparedPath = await prepareCasparMediaPath(rawPath);
        const clipKey = stripMediaExtension(preparedPath.replace(/\\/g, '/').replace(/^\/+/, ''));
        if (!clipKey) return 0;

        const directory = clipKey.includes('/') ? clipKey.slice(0, clipKey.lastIndexOf('/')) : '';
        const listResponse = await sendRawCommand(directory ? `CLS "${directory}"` : 'CLS');
        const listDurationMs = parseDurationFromCasparList(listResponse, clipKey);
        if (listDurationMs > 0) {
            return listDurationMs;
        }

        return 0;
    } catch (error) {
        console.warn('[CasparCG] Failed to query clip metadata via AMCP', rawPath, error);
        return 0;
    }
};

const updateItemDurationFromMs = (item: PlayoutItem, durationMs: number) => {
    if (durationMs <= 0) return 0;
    const seconds = durationMs / 1000;
    item.duration = seconds;
    if (!item.plannedDuration) {
        item.plannedDuration = seconds;
    }
    return itemDurationMs(item);
};

const ensureItemDurationMs = async (item: PlayoutItem) => {
    const knownDurationMs = itemDurationMs(item);
    if (knownDurationMs > 0 || item.type === 'live') {
        return knownDurationMs;
    }

    const scanPath = (item.path || '').trim();
    if (!scanPath || /^https?:/i.test(scanPath)) {
        return 0;
    }

    const casparDurationMs = await queryCasparDurationMs(item);
    if (casparDurationMs > 0) {
        return updateItemDurationFromMs(item, casparDurationMs);
    }

    try {
        const metadata = await invoke<{ duration: string }>('scan_media', { filepath: scanPath });
        const scannedSeconds = Number.parseFloat(metadata.duration || '0');
        if (Number.isFinite(scannedSeconds) && scannedSeconds > 0) {
            item.duration = scannedSeconds;
            if (!item.plannedDuration) {
                item.plannedDuration = scannedSeconds;
            }
            return itemDurationMs(item);
        }
    } catch (error) {
        console.warn('[CasparCG] Failed to resolve item duration', scanPath, error);
    }

    return 0;
};

const refreshCurrentProducerDuration = async (item: PlayoutItem) => {
    if (currentCasparDurationMs.value > 0) return;

    for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!isCasparPlaying.value) return;
        const durationMs = await queryActiveLayerDurationMs();
        if (durationMs > 0) {
            currentCasparDurationMs.value = durationMs;
            const totalDurationMs = updateItemDurationFromMs(item, durationMs);
            if (!advanceTimer && totalDurationMs > 0 && currentIndex >= 0) {
                const remainingMs = Math.max(0, totalDurationMs - currentCasparMs.value);
                if (remainingMs > 0) {
                    advanceTimer = setTimeout(async () => {
                        if (currentIndex < 0) return;
                        const nextIndex = currentIndex + 1;
                        if (nextIndex >= queuedItems.length) {
                            await casparPlayoutService.stop();
                            onAdvanceCallback?.(-1);
                            return;
                        }
                        await playAt(nextIndex, playToken);
                    }, remainingMs);
                }
            }
            return;
        }
        await wait(400);
    }
};

const buildClipOptions = (item: PlayoutItem) => {
    const options: string[] = [];
    if (item.inPoint > 0) {
        options.push(`SEEK ${Math.round(item.inPoint / FRAME_MS)}`);
    }
    const durationMs = itemDurationMs(item);
    if (durationMs > 0) {
        options.push(`LENGTH ${Math.round(durationMs / FRAME_MS)}`);
    }
    return options.join(' ');
};

const buildVideoCommand = async (item: PlayoutItem, autoPlay: boolean) => {
    const rawPath = item.shortPath || item.path;
    const path = await prepareCasparMediaPath(rawPath);
    const options = buildClipOptions(item);
    const auto = autoPlay ? ' AUTO' : '';
    return `LOADBG ${PROGRAM_CHANNEL}-${PROGRAM_LAYER} "${path}" ${options}${auto}`.replace(/\s+/g, ' ').trim();
};

const buildPlayVideoCommand = async (item: PlayoutItem) => {
    const rawPath = item.shortPath || item.path;
    const path = await prepareCasparMediaPath(rawPath);
    const options = buildClipOptions(item);
    return `PLAY ${PROGRAM_CHANNEL}-${PROGRAM_LAYER} "${path}" ${options}`.replace(/\s+/g, ' ').trim();
};

const buildLiveCommand = (preferredSource?: string) => {
    const source = (preferredSource || getSettingsSnapshot().liveInputSourceName || '').trim();
    if (!source || source === 'SOTA_Live') return '';
    return source ? `PLAY ${PROGRAM_CHANNEL}-${LIVE_LAYER} ${source}` : '';
};

const sendRawCommand = async (cmd: string) => {
    return invoke<string>('caspar_send_command', { cmd });
};

const ensureFeedbackListener = async () => {
    await invoke<number>('configure_caspar_osc_listener', { port: getConfiguredOscPort() });

    if (feedbackListenerPromise) return feedbackListenerPromise;
    feedbackListenerPromise = listen<CasparOscPayload>('caspar-osc', (event) => {
        const payload = event.payload;
        if (!isProgramFileTimeAddress(payload.address)) {
            return;
        }
        if (payload.positionMs != null) {
            syncClockBase(payload.positionMs);
        }
        if (payload.durationMs != null) {
            currentCasparDurationMs.value = Math.max(0, Math.round(payload.durationMs));
        }
    }).catch((error) => {
        console.warn('[CasparCG] Failed to attach OSC listener', error);
    });
    return feedbackListenerPromise;
};

const playAt = async (index: number, token: number) => {
    const item = queuedItems[index];
    if (!item || token !== playToken) return;

    await ensureItemDurationMs(item);

    currentIndex = index;
    onAdvanceCallback?.(index);
    await casparPlayoutService.applyComplianceForItem?.(item);

    if (item.type === 'live') {
        const liveCommand = buildLiveCommand(item.path);
        if (!liveCommand) {
            throw new Error('No CasparCG live source configured. Set a Live Input Source in Settings.');
        }
        const durationMs = itemDurationMs(item);
        await sendRawCommand(liveCommand);
        isCasparPlaying.value = true;
        syncClockBase(0);
        currentCasparDurationMs.value = durationMs;
        startClock();
        clearAdvanceTimer();
        if (durationMs > 0) {
            advanceTimer = setTimeout(() => {
                playAt(index + 1, token).catch((error) => {
                    console.error('[CasparCG] Failed to advance live item', error);
                });
            }, durationMs);
        }
        return;
    }

    const durationMs = await ensureItemDurationMs(item);
    currentCasparDurationMs.value = durationMs;
    await sendRawCommand(await buildPlayVideoCommand(item));
    isCasparPlaying.value = true;
    syncClockBase(item.inPoint || 0);
    startClock();
    setTimeout(() => {
        refreshCurrentProducerDuration(item).catch((error) => {
            console.warn('[CasparCG] Failed to refresh active producer duration', error);
        });
    }, 250);

    clearAdvanceTimer();
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
        hardwareOutput: true,
        compliance: true,
        cue: true
    },

    async connect() {
        await ensureFeedbackListener();
        await sendRawCommand('INFO');
        isCasparConnected.value = true;
        await this.syncBrandingAssets?.();
        await this.clearCompliance?.();
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
        currentCasparDurationMs.value = 0;
        currentIndex = -1;
        syncClockBase(0);
        if (isCasparConnected.value) {
            await this.clearCompliance?.();
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

        await sendRawCommand(await buildVideoCommand(item, false));
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
        if (!isCasparConnected.value) return;
        const settings = getSettingsSnapshot();
        const watermarkLayer = 30;

        const logoSourcePath = settings.watermarkPath || resolveLogoAsset('logo.png');
        const logoPath = logoSourcePath ? await prepareCasparMediaPath(logoSourcePath) : '';

        if (settings.watermarkEnabled && logoPath) {
            await sendRawCommand(`PLAY ${PROGRAM_CHANNEL}-${watermarkLayer} "${logoPath}"`);

            const opacity = (settings.watermarkOpacity || 80) / 100.0;
            const scale = clamp((settings.watermarkScale || 15) / 100.0, 0.01, 1.0);

            // Position as fraction of screen (0.0-1.0).
            // Logo sits top-left, leaving a 5% margin.
            let x = 0.04, y = 0.04;
            if (settings.watermarkPosition === 'top-right') { x = 1.0 - scale - 0.04; y = 0.04; }
            else if (settings.watermarkPosition === 'bottom-left') { x = 0.04; y = 1.0 - scale - 0.04; }
            else if (settings.watermarkPosition === 'bottom-right') { x = 1.0 - scale - 0.04; y = 1.0 - scale - 0.04; }

            await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${watermarkLayer} FILL ${x.toFixed(4)} ${y.toFixed(4)} ${scale.toFixed(4)} ${scale.toFixed(4)}`);
            await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${watermarkLayer} OPACITY ${opacity.toFixed(3)}`);
        } else {
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${watermarkLayer}`);
        }
    },

    async seekMedia(_inputName: string, timeCursor: number) {
        syncClockBase(timeCursor);
    },

    async applyComplianceForItem(item) {
        if (!isCasparConnected.value) return;
        const ratingLayer = 31;
        const rating = (item.complianceRating || 'none') as ComplianceRating;
        if (rating === 'none') {
            await this.clearCompliance?.();
            return;
        }
        const ratingSourcePath = getRatingAssetPath(rating);

        if (ratingSourcePath) {
            const path = await prepareCasparMediaPath(ratingSourcePath);
            await sendRawCommand(`PLAY ${PROGRAM_CHANNEL}-${ratingLayer} "${path}"`);

            // Standard small rating top right
            const scale = 0.07;
            const x = 0.88;
            const y = 0.08;
            await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${ratingLayer} FILL ${x.toFixed(4)} ${y.toFixed(4)} ${scale.toFixed(4)} ${scale.toFixed(4)}`);
        } else {
            if (this.clearCompliance) await this.clearCompliance();
        }
    },

    async clearCompliance() {
        if (!isCasparConnected.value) return;
        await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-31`);
        await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-32`);
    },

    async startDeckLink(outputName: string) {
        if (!isCasparConnected.value) await this.connect();
        const deviceMatch = outputName.match(/\d+/);
        const deviceId = deviceMatch ? deviceMatch[0] : '1';
        await sendRawCommand(`ADD 1 DECKLINK ${deviceId}`);
    },

    async stopDeckLink(outputName: string) {
        if (!isCasparConnected.value) await this.connect();
        const deviceMatch = outputName.match(/\d+/);
        const deviceId = deviceMatch ? deviceMatch[0] : '1';
        await sendRawCommand(`REMOVE 1 DECKLINK ${deviceId}`);
    }
};
