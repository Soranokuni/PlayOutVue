import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ref } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useRundownStore, type ComplianceRating, type IngestorStatus } from '../stores/rundown';
import type { PlayoutAdvanceCallback, PlayoutItem, PlayoutService } from './playout';

export const playStartTime = ref(0);
export const playStartIndex = ref(0);

const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);

const CASPAR_HOST = '127.0.0.1';
const CASPAR_AMCP_PORT = 5250;
const PROGRAM_CHANNEL = 1;
const PROGRAM_LAYER = 10;
const LIVE_LAYER = 20;
const FRAME_MS = 40;
const PAL_FPS = 25;
const RECONNECT_BASE_DELAY_MS = 750;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_FOREGROUND_ATTEMPTS = 6;
const HEARTBEAT_INTERVAL_MS = 5_000;

const jitter = () => Math.floor(Math.random() * 201) - 100;

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
let timelineTimers: ReturnType<typeof setTimeout>[] = [];

function parseTimeToMs(t: string | number): number {
    if (typeof t === 'number') return t * 1000;
    const parts = String(t).split(':').map(Number);
    if (parts.length === 2) {
        return ((parts[0] || 0) * 60 + (parts[1] || 0)) * 1000;
    } else if (parts.length === 3) {
        return (((parts[0] || 0) * 60 + (parts[1] || 0)) * 60 + (parts[2] || 0)) * 1000;
    }
    const parsed = parseFloat(t);
    return isNaN(parsed) ? 0 : parsed * 1000;
}

function escapeJson(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
let onAdvanceCallback: PlayoutAdvanceCallback | null = null;
let playToken = 0;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let positionBaseMs = 0;
let positionBaseAt = 0;
let feedbackListenerPromise: Promise<void> | null = null;
let feedbackUnlisten: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let reconnectRequested = false;
let reconnectInFlight: Promise<void> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

const assertIngestorReady = (item: PlayoutItem) => {
    const status: IngestorStatus = (item as any).ingestorStatus || 'idle';

    if (status !== 'ready' && status !== 'idle') {
        throw new Error(
            `Cannot play item "${item.filename}" — Ingestor status is "${status}". Asset must be "ready" to play.\n` +
            `UUID: ${(item as any).playoutvueId || 'N/A'}\n` +
            (status === 'processing' ? 'Still processing on the Ingestor. Retry in a moment.' :
             status === 'error' ? 'The Ingestor reported an error for this asset. Check the Ingestor logs.' :
             status === 'missing' ? 'The asset was not found by the Ingestor.' :
             'Unexpected status.')
        );
    }
};

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

const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
};

const startHeartbeat = () => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
        if (!isCasparConnected.value || reconnectInFlight) return;
        sendRawCommandCore('INFO').catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
};

const stopHeartbeat = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
};

const markDisconnected = (reason: string, error?: unknown) => {
    if (error) {
        console.warn(`[CasparCG] ${reason}`, error);
    } else {
        console.warn(`[CasparCG] ${reason}`);
    }

    isCasparConnected.value = false;
    stopHeartbeat();
    if (reconnectRequested) {
        scheduleReconnect();
    }
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

const disposeFeedbackListener = async () => {
    if (!feedbackUnlisten) return;
    try {
        feedbackUnlisten();
    } catch (error) {
        console.warn('[CasparCG] Failed to detach OSC listener', error);
    } finally {
        feedbackUnlisten = null;
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
    const rawPath = (item.path || item.shortPath || '').trim();
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

async function refreshCurrentProducerDuration(item: PlayoutItem, token: number) {
    if (advanceTimer) return;

    for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!isCasparPlaying.value || token !== playToken) return;
        
        let durationMs = currentCasparDurationMs.value;
        if (durationMs <= 0) {
            durationMs = await queryActiveLayerDurationMs();
        }
        
        if (durationMs > 0) {
            currentCasparDurationMs.value = durationMs;
            const totalDurationMs = updateItemDurationFromMs(item, durationMs);
            
            if (item.id) {
                const store = useRundownStore();
                store.updateItem(item.id, {
                    duration: totalDurationMs / 1000,
                    plannedDuration: totalDurationMs / 1000
                });
            }

            if (!advanceTimer && totalDurationMs > 0 && currentIndex >= 0 && token === playToken) {
                const remainingMs = Math.max(0, totalDurationMs - currentCasparMs.value);
                if (remainingMs > 0) {
                    advanceTimer = setTimeout(async () => {
                        await advanceNext(token);
                    }, remainingMs + 200);
                }
            }
            return;
        }
        await wait(400);
    }
}

const buildClipOptions = (item: PlayoutItem) => {
    const options: string[] = [];
    if (item.inPoint > 0) {
        options.push(`SEEK ${Math.round(item.inPoint / FRAME_MS)}`);
    }
    if (item.outPoint > item.inPoint) {
        const durationMs = item.outPoint - item.inPoint;
        if (durationMs > 0) {
            options.push(`LENGTH ${Math.round(durationMs / FRAME_MS)}`);
        }
    }
    return options.join(' ');
};

const buildVideoCommand = async (item: PlayoutItem, autoPlay: boolean) => {
    const rawPath = item.path || item.shortPath;
    const path = await prepareCasparMediaPath(rawPath);
    const options = buildClipOptions(item);
    const auto = autoPlay ? ' AUTO' : '';
    return `LOADBG ${PROGRAM_CHANNEL}-${PROGRAM_LAYER} "${path}" ${options}${auto}`.replace(/\s+/g, ' ').trim();
};

const buildPlayVideoCommand = async (item: PlayoutItem) => {
    const rawPath = item.path || item.shortPath;
    const path = await prepareCasparMediaPath(rawPath);
    const options = buildClipOptions(item);
    return `PLAY ${PROGRAM_CHANNEL}-${PROGRAM_LAYER} "${path}" ${options}`.replace(/\s+/g, ' ').trim();
};

const buildLiveCommand = (preferredSource?: string) => {
    const source = (preferredSource || getSettingsSnapshot().liveInputSourceName || '').trim();
    if (!source) return '';
    return source ? `PLAY ${PROGRAM_CHANNEL}-${LIVE_LAYER} ${source}` : '';
};

const sendRawCommandCore = async (cmd: string) => {
    return invoke<string>('caspar_send_command', { cmd });
};

const ensureFeedbackListener = async () => {
    if (feedbackUnlisten) return;
    if (feedbackListenerPromise) return feedbackListenerPromise;

    feedbackListenerPromise = (async () => {
        await invoke<number>('configure_caspar_osc_listener', { port: getConfiguredOscPort() });
        feedbackUnlisten = await listen<CasparOscPayload>('caspar-osc', (event) => {
            const payload = event.payload;
            if (!isProgramFileTimeAddress(payload.address)) {
                return;
            }
            if (payload.positionMs != null) {
                syncClockBase(payload.positionMs);
            }
            
            const positionMs = payload.positionMs ?? currentCasparMs.value;
            let durationMs = payload.durationMs != null ? Math.max(0, Math.round(payload.durationMs)) : currentCasparDurationMs.value;
            
            if (payload.durationMs != null) {
                currentCasparDurationMs.value = durationMs;
            }

            if (isCasparPlaying.value && currentIndex >= 0 && playToken > 0) {
                const item = queuedItems[currentIndex];
                if (item && item.type !== 'live') {
                    const knownDuration = itemDurationMs(item);
                    if (knownDuration <= 0 && durationMs > 0) {
                        updateItemDurationFromMs(item, durationMs);
                        const store = useRundownStore();
                        store.updateItem(item.id, {
                            duration: durationMs / 1000,
                            plannedDuration: durationMs / 1000
                        });
                    }

                    const effectiveTotalMs = itemDurationMs(item);
                    if (!advanceTimer && effectiveTotalMs > 0) {
                        const remainingMs = Math.max(0, effectiveTotalMs - positionMs);
                        if (remainingMs > 0) {
                            const currentToken = playToken;
                            advanceTimer = setTimeout(async () => {
                                await advanceNext(currentToken);
                            }, remainingMs + 200);
                        }
                    }

                    if (durationMs > 0 && positionMs >= durationMs - 80) {
                        advanceNext(playToken).catch((error) => {
                            console.error('[CasparCG] OSC advance error', error);
                        });
                    }
                }
            }
        });
    })()
        .catch((error) => {
            console.warn('[CasparCG] Failed to attach OSC listener', error);
            throw error;
        })
        .finally(() => {
            feedbackListenerPromise = null;
        });

    return feedbackListenerPromise;
};

const performHandshake = async () => {
    await ensureFeedbackListener();
    await sendRawCommandCore('INFO');
    isCasparConnected.value = true;
    reconnectAttempt = 0;
    clearReconnectTimer();
    startHeartbeat();
    await casparPlayoutService.syncBrandingAssets?.();
    await casparPlayoutService.clearCompliance?.();
};

const runReconnectAttempt = async (foreground: boolean) => {
    if (reconnectInFlight) return reconnectInFlight;

    reconnectInFlight = (async () => {
        const attempts = foreground ? RECONNECT_FOREGROUND_ATTEMPTS : 1;
        let lastError: unknown;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                stopHeartbeat();
                await performHandshake();
                return;
            } catch (error) {
                lastError = error;
                isCasparConnected.value = false;
                if (foreground && attempt < attempts - 1) {
                    const delay = Math.min(
                        RECONNECT_BASE_DELAY_MS * 2 ** attempt + jitter(),
                        RECONNECT_MAX_DELAY_MS
                    );
                    await wait(Math.max(RECONNECT_BASE_DELAY_MS, delay));
                }
            }
        }

        throw lastError;
    })().finally(() => {
        reconnectInFlight = null;
        if (!isCasparConnected.value && reconnectRequested) {
            scheduleReconnect();
        }
    });

    return reconnectInFlight;
};

function scheduleReconnect() {
    if (!reconnectRequested || reconnectTimer || reconnectInFlight) return;
    const baseDelay = reconnectAttempt === 0
        ? RECONNECT_BASE_DELAY_MS
        : Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS);
    const delay = Math.max(RECONNECT_BASE_DELAY_MS, baseDelay + jitter());
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectAttempt += 1;
        runReconnectAttempt(false).catch((error) => {
            console.warn('[CasparCG] Reconnect attempt failed', error);
        });
    }, delay);
}

const sendRawCommand = async (cmd: string) => {
    try {
        const response = await sendRawCommandCore(cmd);
        if (!isCasparConnected.value) {
            isCasparConnected.value = true;
            reconnectAttempt = 0;
            clearReconnectTimer();
            startHeartbeat();
        }
        return response;
    } catch (error) {
        const message = String(error || '');
        const isTransportError =
            /timed out|connect|econnreset|econnrefused|broken pipe|connection refused/i.test(message);
        if (isTransportError) {
            markDisconnected(`AMCP transport error: ${cmd.split(' ')[0] || 'UNKNOWN'}`, error);
        } else {
            console.warn(`[CasparCG] AMCP application error on ${cmd.split(' ')[0] || 'UNKNOWN'}:`, error);
        }
        throw error;
    }
};

async function advanceNext(token: number) {
    if (token !== playToken) return;

    playToken += 1;
    clearAdvanceTimer();

    const nextIndex = currentIndex + 1;
    if (nextIndex >= queuedItems.length) {
        await casparPlayoutService.stop();
        onAdvanceCallback?.(-1);
        return;
    }

    await playAt(nextIndex, playToken);
}

async function playAt(index: number, token: number) {
    try {
        const item = queuedItems[index];
        if (!item || token !== playToken) return;

        assertIngestorReady(item);

        await ensureItemDurationMs(item);

        currentIndex = index;
        onAdvanceCallback?.(index);
        await casparPlayoutService.applyComplianceForItem?.(item);

        const store = useRundownStore();

        if (item.type === 'live') {
            const liveCommand = buildLiveCommand(item.path);
            if (!liveCommand) {
                throw new Error('No CasparCG live source configured. Set a Live Input Source in Settings.');
            }
            const durationMs = itemDurationMs(item);
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${LIVE_LAYER}`);
            await sendRawCommand(liveCommand);
            isCasparPlaying.value = true;
            syncClockBase(0);
            currentCasparDurationMs.value = durationMs;
            startClock();
            
            store.startPlaybackProgressTimer(item.id, durationMs);

            clearAdvanceTimer();
            if (durationMs > 0) {
                const currentToken = playToken;
                advanceTimer = setTimeout(() => {
                    advanceNext(currentToken).catch((error: any) => {
                        console.error('[CasparCG] Failed to advance live item', error);
                        invoke('push_diagnostic_log', {
                            level: 'error',
                            scope: 'caspar-playout',
                            message: `Failed to advance live item: ${error?.message || error}`
                        }).catch(() => {});
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
        
        const currentToken = playToken;
        setTimeout(() => {
            if (currentToken !== playToken) return;
            refreshCurrentProducerDuration(item, currentToken).catch((error: any) => {
                console.warn('[CasparCG] Failed to refresh active producer duration', error);
                invoke('push_diagnostic_log', {
                    level: 'warn',
                    scope: 'caspar-playout',
                    message: `Failed to refresh active producer duration: ${error?.message || error}`
                }).catch(() => {});
            });
        }, 250);

        let effectiveDuration = durationMs;
        const assetDuration = (item.duration_ms || (item.duration ? item.duration * 1000 : 0));
        const trimIn = item.trim_in_ms || item.inPoint || 0;
        const trimOut = item.trim_out_ms || (item.duration ? (item.duration * 1000 - item.outPoint) : 0);
        const calculatedEffective = assetDuration - trimIn - trimOut;
        if (calculatedEffective > 0) {
            effectiveDuration = calculatedEffective;
        }
        store.startPlaybackProgressTimer(item.id, effectiveDuration);

        clearAdvanceTimer();
        if (durationMs > 0) {
            advanceTimer = setTimeout(async () => {
                try {
                    await advanceNext(currentToken);
                } catch (error: any) {
                    console.error('[CasparCG] Failed in advance timeout advanceNext', error);
                    invoke('push_diagnostic_log', {
                        level: 'error',
                        scope: 'caspar-playout',
                        message: `Failed in advance timeout advanceNext: ${error?.message || error}`
                    }).catch(() => {});
                }
            }, durationMs + 200);
        }
    } catch (error: any) {
        console.error('[CasparCG] playAt error', error);
        invoke('push_diagnostic_log', {
            level: 'error',
            scope: 'caspar-playout',
            message: `Playout crash/error at index ${index} (${queuedItems[index]?.filename || 'unknown'}): ${error?.message || error}`
        }).catch(() => {});
    }
}

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
        reconnectRequested = true;
        await runReconnectAttempt(true);
    },

    async disconnect() {
        reconnectRequested = false;
        clearReconnectTimer();
        stopHeartbeat();
        reconnectAttempt = 0;
        await this.stop();
        isCasparConnected.value = false;
        await disposeFeedbackListener();
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
        
        // Stop local progress timer
        const store = useRundownStore();
        store.stopPlaybackProgressTimer();
    },

    async cue(item) {
        assertIngestorReady(item);

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

        // Start progress timer in rundown store
        const store = useRundownStore();
        if (store.selectedItem) {
            const item = store.selectedItem;
            let effectiveDuration = (item.duration || 0) * 1000;
            const assetDuration = (item.duration_ms || (item.duration ? item.duration * 1000 : 0));
            const trimIn = item.trim_in_ms || item.inPoint || 0;
            const trimOut = item.trim_out_ms || (item.duration ? (item.duration * 1000 - item.outPoint) : 0);
            const calculatedEffective = assetDuration - trimIn - trimOut;
            if (calculatedEffective > 0) {
                effectiveDuration = calculatedEffective;
            }
            store.startPlaybackProgressTimer(item.id, effectiveDuration);
        }
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
        await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${LIVE_LAYER}`);
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

        const logoSourcePath = settings.cgStationLogoPath || settings.watermarkPath || resolveLogoAsset('logo.png');
        const logoPath = logoSourcePath ? await prepareCasparMediaPath(logoSourcePath) : '';

        if (settings.watermarkEnabled && logoPath) {
            await sendRawCommand(`PLAY ${PROGRAM_CHANNEL}-${watermarkLayer} "${logoPath}"`);

            const opacity = (settings.watermarkOpacity || 80) / 100.0;
            const lx = (settings.cgStationLogoPos?.left ?? 5) / 100;
            const ly = (settings.cgStationLogoPos?.top ?? 5) / 100;
            const lw = (settings.cgStationLogoPos?.width ?? 12) / 100;
            const lh = (settings.cgStationLogoPos?.height ?? 12) / 100;

            await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${watermarkLayer} FILL ${lx.toFixed(4)} ${ly.toFixed(4)} ${lw.toFixed(4)} ${lh.toFixed(4)}`);
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
        const settings = getSettingsSnapshot();
        const ratingLayer = 31;
        const tpLayer = 34;

        // Clear existing timers
        timelineTimers.forEach(clearTimeout);
        timelineTimers = [];

        const rating = (item.complianceRating || 'none') as ComplianceRating;
        const tpFlag = !!item.tp_flag;

        // Display Age Rating Badge
        let ratingSourcePath = '';
        if (rating === 'k') ratingSourcePath = settings.cgRatingKPath;
        else if (rating === '8') ratingSourcePath = settings.cgRating8Path;
        else if (rating === '12') ratingSourcePath = settings.cgRating12Path;
        else if (rating === '16') ratingSourcePath = settings.cgRating16Path;
        else if (rating === '18') ratingSourcePath = settings.cgRating18Path;
        
        if (!ratingSourcePath && rating !== 'none') {
            ratingSourcePath = getRatingAssetPath(rating);
        }

        if (ratingSourcePath) {
            const path = await prepareCasparMediaPath(ratingSourcePath);
            await sendRawCommand(`PLAY ${PROGRAM_CHANNEL}-${ratingLayer} "${path}"`);

            const rx = (settings.cgRatingBadgePos?.left ?? 88) / 100;
            const ry = (settings.cgRatingBadgePos?.top ?? 5) / 100;
            const rw = (settings.cgRatingBadgePos?.width ?? 7) / 100;
            const rh = (settings.cgRatingBadgePos?.height ?? 7) / 100;
            await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${ratingLayer} FILL ${rx.toFixed(4)} ${ry.toFixed(4)} ${rw.toFixed(4)} ${rh.toFixed(4)}`);
        } else {
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${ratingLayer}`);
        }

        // Display TP Badge
        if (tpFlag && settings.cgRatingTPPath) {
            const path = await prepareCasparMediaPath(settings.cgRatingTPPath);
            await sendRawCommand(`PLAY ${PROGRAM_CHANNEL}-${tpLayer} "${path}"`);

            const tpx = (settings.cgTPPos?.left ?? 88) / 100;
            const tpy = (settings.cgTPPos?.top ?? 13) / 100;
            const tpw = (settings.cgTPPos?.width ?? 7) / 100;
            const tph = (settings.cgTPPos?.height ?? 7) / 100;
            await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${tpLayer} FILL ${tpx.toFixed(4)} ${tpy.toFixed(4)} ${tpw.toFixed(4)} ${tph.toFixed(4)}`);
        } else {
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${tpLayer}`);
        }

        // Schedule dynamic explanation banners
        const timeline = item.timeline || [];
        timeline.forEach((field: any) => {
            if (!field.text) return;
            const startMs = parseTimeToMs(field.start);
            const endMs = parseTimeToMs(field.end);

            const startTimer = setTimeout(async () => {
                const template = settings.cgExplanationTemplate || 'playout/explanation';
                await sendRawCommand(`CG ${PROGRAM_CHANNEL}-32 ADD 1 "${template}" 1 "{\\"text\\":\\"${escapeJson(field.text)}\\"}"`);

                const ebx = (settings.cgExplanationBannerPos?.left ?? 60) / 100;
                const eby = (settings.cgExplanationBannerPos?.top ?? 5) / 100;
                const ebw = (settings.cgExplanationBannerPos?.width ?? 27) / 100;
                const ebh = (settings.cgExplanationBannerPos?.height ?? 7) / 100;

                await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-32 FILL ${ebx.toFixed(4)} ${eby.toFixed(4)} ${ebw.toFixed(4)} ${ebh.toFixed(4)}`);
                await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-32 OPACITY 1.0`);
            }, startMs);
            timelineTimers.push(startTimer);

            const endTimer = setTimeout(async () => {
                await sendRawCommand(`CG ${PROGRAM_CHANNEL}-32 STOP 1`);
                const cleanupTimer = setTimeout(async () => {
                    await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-32`);
                }, 1000);
                timelineTimers.push(cleanupTimer);
            }, endMs);
            timelineTimers.push(endTimer);
        });
    },

    async clearCompliance() {
        if (!isCasparConnected.value) return;
        timelineTimers.forEach(clearTimeout);
        timelineTimers = [];
        await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-31`);
        await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-32`);
        await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-34`);
    },

    async startDeckLink(outputName: string) {
        if (!isCasparConnected.value) await this.connect();
        const deviceMatch = outputName.match(/\d+/);
        const deviceId = deviceMatch ? deviceMatch[0] : '1';
        const settings = getSettingsSnapshot();
        const cmdParts = [`ADD ${PROGRAM_CHANNEL} DECKLINK ${deviceId}`];
        if (settings.decklinkEmbeddedAudio) cmdParts.push('EMBEDDED_AUDIO');
        if (settings.decklinkLatency && settings.decklinkLatency !== 'normal') cmdParts.push(`LATENCY_${settings.decklinkLatency.toUpperCase()}`);
        if (settings.decklinkKeyer && settings.decklinkKeyer !== 'external') cmdParts.push(`KEYER_${settings.decklinkKeyer.toUpperCase()}`);
        if (settings.decklinkBufferDepth && settings.decklinkBufferDepth !== 3) cmdParts.push(`BUFFER_DEPTH ${settings.decklinkBufferDepth}`);
        if (settings.decklinkKeyDevice && settings.decklinkKeyDevice > 0) cmdParts.push(`KEY_DEVICE ${settings.decklinkKeyDevice}`);
        await sendRawCommand(`REMOVE ${PROGRAM_CHANNEL} DECKLINK ${deviceId}`);
        await sendRawCommand(cmdParts.join(' '));
    },

    async stopDeckLink(outputName: string) {
        if (!isCasparConnected.value) await this.connect();
        const deviceMatch = outputName.match(/\d+/);
        const deviceId = deviceMatch ? deviceMatch[0] : '1';
        await sendRawCommand(`REMOVE ${PROGRAM_CHANNEL} DECKLINK ${deviceId}`);
        try {
            const info = await sendRawCommand(`INFO ${PROGRAM_CHANNEL}`);
            if (info.toLowerCase().includes(`decklink ${deviceId}`)) {
                console.warn(`[CasparCG] DeckLink ${deviceId} may still be active after REMOVE`);
            }
        } catch {}
    }
};

export const toggleCrawlTicker = async () => {
    if (!isCasparConnected.value) return;
    const settings = getSettingsSnapshot();
    const crawlLayer = 33;
    
    if (settings.cgCrawlActive) {
        await sendRawCommand(`CG ${PROGRAM_CHANNEL}-${crawlLayer} STOP 1`);
        setTimeout(async () => {
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${crawlLayer}`);
        }, 1000);
        settings.updateSettings({ cgCrawlActive: false });
    } else {
        await sendRawCommand(`CG ${PROGRAM_CHANNEL}-${crawlLayer} ADD 1 "${settings.cgCrawlTemplate || 'playout/crawl'}" 1 "{\\"text\\":\\"${escapeJson(settings.cgCrawlText)}\\"}"`);
        
        const cx = (settings.cgCrawlPos?.left ?? 0) / 100;
        const cy = (settings.cgCrawlPos?.top ?? 90) / 100;
        const cw = (settings.cgCrawlPos?.width ?? 100) / 100;
        const ch = (settings.cgCrawlPos?.height ?? 8) / 100;
        
        await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${crawlLayer} FILL ${cx.toFixed(4)} ${cy.toFixed(4)} ${cw.toFixed(4)} ${ch.toFixed(4)}`);
        await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${crawlLayer} OPACITY 1.0`);
        settings.updateSettings({ cgCrawlActive: true });
    }
};

export const updateCrawlTickerText = async () => {
    if (!isCasparConnected.value) return;
    const settings = getSettingsSnapshot();
    const crawlLayer = 33;
    if (settings.cgCrawlActive) {
        await sendRawCommand(`CG ${PROGRAM_CHANNEL}-${crawlLayer} UPDATE 1 "{\\"text\\":\\"${escapeJson(settings.cgCrawlText)}\\"}"`);
    }
};
