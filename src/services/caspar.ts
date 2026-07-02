import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ref } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useRundownStore, type ComplianceRating, type IngestorStatus } from '../stores/rundown';
import type { PlayoutAdvanceCallback, PlayoutItem, PlayoutService } from './playout';

export const playStartTime = ref(0);
export const playStartIndex = ref(0);

const PROGRAM_CHANNEL = 1;
const FRAME_MS = 40;
const PAL_FPS = 25;
const RECONNECT_BASE_DELAY_MS = 750;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_FOREGROUND_ATTEMPTS = 6;
const HEARTBEAT_INTERVAL_MS = 5_000;

// --- Layer registry (TS mirror of src-tauri/src/caspar_layers.rs) ---
// Single source of truth for layer numbers on the program channel. Keep in
// sync with the Rust enum — see plan §1.1.
export const CASPAR_LAYERS = {
    video: 10,
    live: 20,
    stationLogo: 30,
    rating: 31,
    explanation: 32,
    crawl: 33,
    tp: 34,
    stationId: 35,
} as const;

const jitter = () => Math.floor(Math.random() * 201) - 100;

interface CasparOscPayload {
    address: string;
    args: string[];
    positionMs?: number | null;
    durationMs?: number | null;
    receivedAt: string;
}

interface PlaybackTickPayload {
    positionMs: number;
    durationMs: number;
    currentUuid: string | null;
}

interface PlaybackAdvancePayload {
    currentUuid: string | null;
    reason: string;
}

export const isCasparConnected = ref(false);
export const isCasparPlaying = ref(false);
export const currentCasparTime = ref('00:00:00:00');
export const currentCasparMs = ref(0);
export const currentCasparDurationMs = ref(0);

// --- UUID-keyed queue (plan §2.2) ---
// The queue is an ordered array; the current item is tracked by a stable key
// (playoutvueId || local id) instead of a positional index. refreshQueue() can
// reorder/replace the list without losing the current item's identity, which
// fixes the index-space desync where advanceNext advanced the wrong item.
let queuedItems: PlayoutItem[] = [];
let currentKey: string | null = null;
let timelineTimers: ReturnType<typeof setTimeout>[] = [];

function queueKey(item: PlayoutItem): string {
    return item.id;
}

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

let onAdvanceCallback: PlayoutAdvanceCallback | null = null;
let playToken = 0;
let consecutiveSkips = 0;
const MAX_CONSECUTIVE_SKIPS = 3;
let advanceInFlight = false;
let feedbackListenerPromise: Promise<void> | null = null;
let feedbackUnlisten: (() => void) | null = null;
let tickUnlisten: (() => void) | null = null;
let advanceUnlisten: (() => void) | null = null;
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

const getSettingsSnapshot = () => {
    try {
        return useSettingsStore();
    } catch {
        return {
            liveInputSourceName: '',
            localMediaPath: '',
            logosPath: '',
            casparOscPort: 6250,
            cg: {
                stationIdPath: '',
                stationIdEnabled: true,
            },
            cgRatingKPath: '',
            cgRating8Path: '',
            cgRating12Path: '',
            cgRating16Path: '',
            cgRating18Path: '',
            cgRatingTPPath: '',
            cgExplanationTemplate: 'playout/explanation',
            cgCrawlTemplate: 'playout/crawl',
            cgCrawlText: '',
            cgCrawlActive: false,
            cgStationLogoPos: { left: 5, top: 5, width: 12, height: 12 },
            cgRatingBadgePos: { left: 88, top: 5, width: 7, height: 7 },
            cgTPPos: { left: 88, top: 13, width: 7, height: 7 },
            cgExplanationBannerPos: { left: 60, top: 5, width: 27, height: 7 },
            cgCrawlPos: { left: 0, top: 90, width: 100, height: 8 },
            updateSettings: (() => {}) as (p: any) => void,
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

    if (mediaRoot) {
        const pLower = p.toLowerCase();
        const rootLower = mediaRoot.toLowerCase();
        if (pLower.startsWith(rootLower)) {
            p = p.substring(mediaRoot.length).replace(/^\/+/, '');
        } else {
            const rootParts = mediaRoot.split('/');
            const rootBaseName = (rootParts[rootParts.length - 1] || '').toLowerCase();
            const pParts = p.split('/');
            const rootIdx = pParts.findIndex(s => s.toLowerCase() === rootBaseName ||
                s.toLowerCase().replace(/~\d+$/, '').startsWith(rootBaseName.substring(0, 4)));
            if (rootIdx >= 0) {
                p = pParts.slice(rootIdx + 1).join('/');
            } else {
                p = pParts[pParts.length - 1] || p;
            }
        }
    }

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
    if (feedbackUnlisten) {
        try { feedbackUnlisten(); } catch (error) { console.warn('[CasparCG] Failed to detach OSC listener', error); }
        feedbackUnlisten = null;
    }
    if (tickUnlisten) {
        try { tickUnlisten(); } catch { /* ignore */ }
        tickUnlisten = null;
    }
    if (advanceUnlisten) {
        try { advanceUnlisten(); } catch { /* ignore */ }
        advanceUnlisten = null;
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

const itemDurationMs = (item: PlayoutItem) => {
    if (item.type === 'live') return (item.plannedDuration || item.duration || 0) * 1000;
    const totalMs = item.duration_ms || (item as any).durationMs || (item.duration ? item.duration * 1000 : 0);
    const inMs = item.trim_in_ms ?? item.inPoint ?? 0;
    const outMs = item.trim_out_ms ? item.trim_out_ms : (item.outPoint > 0 ? item.outPoint : totalMs);
    if (outMs > inMs && inMs >= 0) return outMs - inMs;
    return totalMs;
};

const computePlaybackDeadline = (item: PlayoutItem) => {
    const totalMs = item.duration_ms || (item as any).durationMs || (item.duration ? item.duration * 1000 : 0);
    const inMs = item.trim_in_ms ?? item.inPoint ?? 0;
    const outMs = item.trim_out_ms ? item.trim_out_ms : (item.outPoint > 0 ? item.outPoint : totalMs);
    const effectiveDuration = (outMs > inMs && inMs >= 0) ? (outMs - inMs) : totalMs;
    const expectedOutPointMs = effectiveDuration; // OSC position is relative to trim start
    return { effectiveDuration, expectedOutPointMs };
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
        const response = await sendRawCommand(`INFO ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.video}`);
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

const waitForDurationResolution = async (item: PlayoutItem, timeoutMs: number): Promise<number> => {
    const start = Date.now();
    const interval = 250;
    while (Date.now() - start < timeoutMs) {
        const dur = await ensureItemDurationMs(item);
        if (dur > 0) {
            return dur;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    return 0;
};

/// Late-resolve an active producer's duration and re-register it with the Rust
/// state machine so the watchdog deadline tracks the correct end point (plan
/// §2.1). Replaces the old JS `advanceTimer`-setting retry loop.
async function refreshCurrentProducerDuration(item: PlayoutItem, key: string, token: number) {
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
                // Re-anchor progress timer with real duration
                const startEpoch = playStartTime.value;
                store.startPlaybackProgressTimer(item.id, totalDurationMs, startEpoch);
            }

            const expectedOutPointMs = totalDurationMs; // Relative to trim start

            // Prepare paths for registration
            const currentRawPath = item.path || item.shortPath;
            const currentPath = (await prepareCasparMediaPath(currentRawPath)).replace(/\\/g, '/').replace(/"/g, '');

            const index = queuedItems.findIndex(it => queueKey(it) === key);
            const nextItem = index !== -1 ? queuedItems[index + 1] : null;
            let nextPath: string | null = null;
            if (nextItem && nextItem.type === 'video') {
                const nextRawPath = nextItem.path || nextItem.shortPath;
                nextPath = (await prepareCasparMediaPath(nextRawPath)).replace(/\\/g, '/').replace(/"/g, '');
            }

            // Re-register so the Rust watchdog deadline uses the resolved length.
            if (totalDurationMs > 0 && token === playToken && currentKey === key) {
                await invoke('caspar_register_playback', {
                    uuid: key,
                    durationMs: totalDurationMs,
                    expectedOutPointMs: expectedOutPointMs,
                    currentPath: currentPath,
                    nextPath: nextPath
                }).catch((e: any) => {
                    console.warn('[CasparCG] Failed to re-register playback duration', e);
                });
            }
            return;
        }
        await wait(400);
    }
}

const buildClipOptions = (item: PlayoutItem) => {
    const fps = item.fps || PAL_FPS;
    const msPerFrame = 1000 / fps;
    const totalMs = item.duration_ms || (item.duration ? item.duration * 1000 : 0);
    const inMs = item.trim_in_ms ?? item.inPoint ?? 0;
    const outMs = item.trim_out_ms ?? (item.outPoint > 0 ? item.outPoint : totalMs);

    const seekFrames = Math.max(0, Math.round(inMs / msPerFrame));
    const totalClipFrames = Math.round(totalMs / msPerFrame);
    
    const isImage = (item.type as string) === 'image' || (item.path && /\.(png|jpe?g|gif|bmp|tiff|tga)$/i.test(item.path));
    let endFrames = outMs > 0 && outMs < totalMs
        ? Math.round(outMs / msPerFrame)
        : totalClipFrames;
    
    if (endFrames <= seekFrames) {
        // Fallback if metadata is corrupted or mismatching
        endFrames = totalClipFrames > seekFrames ? totalClipFrames : seekFrames + 25;
    }

    if (!isImage && (endFrames - seekFrames) < 25) {
        endFrames = seekFrames + 25;
    }

    return `IN ${seekFrames} OUT ${endFrames} CLEAR_ON_404`;
};

const buildVideoCommand = async (item: PlayoutItem, autoPlay: boolean) => {
    const rawPath = item.path || item.shortPath;
    const path = await prepareCasparMediaPath(rawPath);
    const formattedPath = path.replace(/\\/g, '/').replace(/"/g, '');
    const auto = autoPlay ? ' AUTO' : '';
    const options = buildClipOptions(item);
    return `LOADBG ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.video} "${formattedPath}" ${options}${auto}`.trim();
};

const buildPlayVideoCommand = async (item: PlayoutItem) => {
    const rawPath = item.path || item.shortPath;
    const path = await prepareCasparMediaPath(rawPath);
    const formattedPath = path.replace(/\\/g, '/').replace(/"/g, '');
    const options = buildClipOptions(item);
    return `PLAY ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.video} "${formattedPath}" ${options}`.trim();
};

const buildLiveCommand = (preferredSource?: string) => {
    const source = (preferredSource || getSettingsSnapshot().liveInputSourceName || '').trim();
    if (!source) return '';
    return source ? `PLAY ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live} ${source}` : '';
};

const sendRawCommandCore = async (cmd: string) => {
    return invoke<string>('caspar_send_command', { cmd });
};

/// Subscribe to the Rust-authoritative playback events (plan §2.1/§2.4).
/// `caspar://playback-tick` drives the single clock; `caspar://advance` drives
/// the single advance decision. The legacy per-OSC `caspar-osc` JS advance logic
/// and dual JS timers are removed.
const ensureFeedbackListener = async () => {
    if (feedbackListenerPromise) return feedbackListenerPromise;

    feedbackListenerPromise = (async () => {
        // Start the Rust OSC listener (configures UDP port + watchdog).
        await invoke<number>('configure_caspar_osc_listener', { port: getConfiguredOscPort() });

        if (!tickUnlisten) {
            tickUnlisten = await listen<PlaybackTickPayload>('caspar://playback-tick', (event) => {
                const { positionMs, durationMs } = event.payload;
                updateDisplayedTime(positionMs);
                if (durationMs > 0) {
                    currentCasparDurationMs.value = durationMs;
                }
            });
        }

        if (!advanceUnlisten) {
            advanceUnlisten = await listen<PlaybackAdvancePayload>('caspar://advance', (event) => {
                if (!isCasparPlaying.value) return;
                advanceNext(true).catch((error) => {
                    console.error('[CasparCG] advance error', error);
                });
                // Acknowledge the payload reference (currentUuid == the item that ended).
                void event.payload.currentUuid;
            });
        }
    })().catch((error) => {
        console.warn('[CasparCG] Failed to attach playback listeners', error);
        feedbackListenerPromise = null;
        throw error;
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

async function preloadNextItemAt(index: number, retriesLeft = 3) {
    if (index < 0 || index >= queuedItems.length) return;
    const item = queuedItems[index];
    if (!item || item.type !== 'video' || item.ingestorStatus === 'error') return;

    // If item path is not resolved yet, or status is not ready, retry in 500ms
    if (!item.path || item.ingestorStatus !== 'ready') {
        if (retriesLeft > 0) {
            setTimeout(() => {
                preloadNextItemAt(index, retriesLeft - 1).catch(() => {});
            }, 500);
        }
        return;
    }

    try {
        const rawPath = item.path || item.shortPath;
        const path = await prepareCasparMediaPath(rawPath);
        const formattedPath = path.replace(/\\/g, '/').replace(/"/g, '');
        const options = buildClipOptions(item);
        const cmd = `LOADBG ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.video} "${formattedPath}" ${options} AUTO`.trim();
        await sendRawCommand(cmd);
    } catch (error) {
        console.warn('[CasparCG] Failed to preload next item', item.filename, error);
    }
}

/// Play a single queued item by its array index. Registers it with the Rust
/// state machine (uuid + duration) so Rust owns the advance. No JS advance timer
/// is set — advance fires from `caspar://advance` (OSC EOF or watchdog deadline).
async function playItemAt(index: number, token: number) {
    try {
        const item = queuedItems[index];
        if (!item || token !== playToken) return;

        // Skip items with error status immediately
        if (item.ingestorStatus === 'error') {
            console.warn(`[CasparCG] Skipping item ${item.filename} because it is flagged with error status.`);
            setTimeout(() => {
                advanceNext(false).catch(() => {});
            }, 100);
            return;
        }

        assertIngestorReady(item);

        const key = queueKey(item);
        const durationMs = await ensureItemDurationMs(item);

        currentKey = key;
        onAdvanceCallback?.(key);
        await casparPlayoutService.applyComplianceForItem?.(item);

        const store = useRundownStore();

        if (item.type === 'live') {
            const liveCommand = buildLiveCommand(item.path);
            if (!liveCommand) {
                throw new Error('No CasparCG live source configured. Set a Live Input Source in Settings.');
            }
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live}`);
            await sendRawCommand(liveCommand);
            isCasparPlaying.value = true;
            consecutiveSkips = 0;
            updateDisplayedTime(0);
            currentCasparDurationMs.value = durationMs;

            store.startPlaybackProgressTimer(item.id, durationMs);

            await invoke('caspar_register_playback', {
                uuid: key,
                durationMs,
                expectedOutPointMs: durationMs,
                currentPath: '',
                nextPath: null
            }).catch((e: any) => {
                console.warn('[CasparCG] Failed to register live playback', e);
            });

            await preloadNextItemAt(index + 1);
            return;
        }

        currentCasparDurationMs.value = durationMs;
        
        // Prepare current path
        const currentRawPath = item.path || item.shortPath;
        const currentPath = (await prepareCasparMediaPath(currentRawPath)).replace(/\\/g, '/').replace(/"/g, '');

        // Prepare next path
        const nextItem = queuedItems[index + 1];
        let nextPath: string | null = null;
        if (nextItem && nextItem.type === 'video') {
            const nextRawPath = nextItem.path || nextItem.shortPath;
            nextPath = (await prepareCasparMediaPath(nextRawPath)).replace(/\\/g, '/').replace(/"/g, '');
        }

        await sendRawCommand(await buildPlayVideoCommand(item));
        isCasparPlaying.value = true;
        consecutiveSkips = 0;
        updateDisplayedTime(item.inPoint || 0);

        let resolvedDuration = durationMs;
        if (resolvedDuration <= 0) {
            resolvedDuration = await waitForDurationResolution(item, 3000);
        }

        let effectiveDuration = 0;
        let expectedOutPointMs = 0;
        if (resolvedDuration > 0) {
            const deadline = computePlaybackDeadline(item);
            effectiveDuration = deadline.effectiveDuration;
            expectedOutPointMs = deadline.expectedOutPointMs;
        }

        if (effectiveDuration > 0) {
            store.startPlaybackProgressTimer(item.id, effectiveDuration);

            // Register with Rust so the OSC-authoritative state machine owns advance.
            await invoke('caspar_register_playback', {
                uuid: key,
                durationMs: effectiveDuration,
                expectedOutPointMs: expectedOutPointMs,
                currentPath: currentPath,
                nextPath: nextPath
            }).catch((e: any) => {
                console.warn('[CasparCG] Failed to register playback', e);
            });
        }

        // Preload next item immediately
        await preloadNextItemAt(index + 1);

        // Late-resolve duration if still unknown and re-register the deadline.
        setTimeout(() => {
            if (token !== playToken) return;
            refreshCurrentProducerDuration(item, key, token).catch((error: any) => {
                console.warn('[CasparCG] Failed to refresh active producer duration', error);
                invoke('push_diagnostic_log', {
                    level: 'warn',
                    scope: 'caspar-playout',
                    message: `Failed to refresh active producer duration: ${error?.message || error}`
                }).catch(() => {});
            });
        }, 250);
    } catch (error: any) {
        console.error('[CasparCG] playItemAt error', error);
        
        // Mark the rundown item visually as broken/missing
        const store = useRundownStore();
        const item = queuedItems[index];
        if (item) {
            store.updateItem(item.id, { ingestorStatus: 'error' });
        }

        invoke('push_diagnostic_log', {
            level: 'error',
            scope: 'caspar-playout',
            message: `Playout error at index ${index} (${item?.filename || 'unknown'}): ${error?.message || error}`
        }).catch(() => {});

        consecutiveSkips += 1;
        if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
            console.error(`[CasparCG] ${MAX_CONSECUTIVE_SKIPS} consecutive playout errors - halting playout.`);
            invoke('push_diagnostic_log', {
                level: 'error',
                scope: 'caspar-playout',
                message: `Halting playout: ${MAX_CONSECUTIVE_SKIPS} consecutive playout errors reached.`
            }).catch(() => {});
            await casparPlayoutService.stop();
            return;
        }

        // Automatically trigger advanceNext(false) to skip to the next playable clip!
        setTimeout(() => {
            advanceNext(false).catch(err => {
                console.error('[CasparCG] auto skip failed', err);
            });
        }, 200);
    }
}

/// Advance to the next queued item by re-resolving the current key's position in
/// the (possibly reordered) queue. Identity-based, so edits mid-playback cannot
/// advance the wrong item (plan §2.2 / §A fix).
async function advanceToNext(token: number, natural: boolean) {
    if (token !== playToken) return;
    if (advanceInFlight) return;
    advanceInFlight = true;

    try {
        playToken += 1;

        if (currentKey == null) {
            await casparPlayoutService.stop();
            onAdvanceCallback?.(null);
            return;
        }

        const currentIndex = queuedItems.findIndex((it) => queueKey(it) === currentKey);
        const nextIndex = currentIndex + 1;

        if (nextIndex >= queuedItems.length) {
            await casparPlayoutService.stop();
            onAdvanceCallback?.(null);
            return;
        }

        const currentItem = queuedItems[currentIndex];
        const nextItem = queuedItems[nextIndex];

        const isNaturalVideoTransition = 
            natural && 
            currentItem && 
            currentItem.type === 'video' && 
            nextItem && 
            nextItem.type === 'video';

        if (isNaturalVideoTransition && nextItem) {
            if (nextItem.ingestorStatus === 'error') {
                console.warn(`[CasparCG] Skipping item ${nextItem.filename} on natural advance because it is flagged with error status.`);
                setTimeout(() => {
                    advanceNext(false).catch(() => {});
                }, 100);
                return;
            }

            try {
                assertIngestorReady(nextItem);
                const key = queueKey(nextItem);
                const { effectiveDuration, expectedOutPointMs } = computePlaybackDeadline(nextItem);

                currentKey = key;
                onAdvanceCallback?.(key);
                await casparPlayoutService.applyComplianceForItem?.(nextItem);

                const store = useRundownStore();
                updateDisplayedTime(nextItem.inPoint || 0);

                store.startPlaybackProgressTimer(nextItem.id, effectiveDuration);

                // Prepare paths for registration
                const nextItemRawPath = nextItem.path || nextItem.shortPath;
                const nextItemPath = (await prepareCasparMediaPath(nextItemRawPath)).replace(/\\/g, '/').replace(/"/g, '');

                const nextNextItem = queuedItems[nextIndex + 1];
                let nextNextPath: string | null = null;
                if (nextNextItem && nextNextItem.type === 'video') {
                    const nextNextRawPath = nextNextItem.path || nextNextItem.shortPath;
                    nextNextPath = (await prepareCasparMediaPath(nextNextRawPath)).replace(/\\/g, '/').replace(/"/g, '');
                }

                await invoke('caspar_register_playback', {
                    uuid: key,
                    durationMs: effectiveDuration,
                    expectedOutPointMs: expectedOutPointMs,
                    currentPath: nextItemPath,
                    nextPath: nextNextPath
                }).catch((e: any) => {
                    console.warn('[CasparCG] Failed to register playback on natural advance', e);
                });

                await preloadNextItemAt(nextIndex + 1);

                setTimeout(() => {
                    const currentPlayToken = playToken;
                    refreshCurrentProducerDuration(nextItem, key, currentPlayToken).catch((error: any) => {
                        console.warn('[CasparCG] Failed to refresh active producer duration', error);
                    });
                }, 250);
            } catch (error: any) {
                console.error('[CasparCG] advanceToNext natural error', error);
                const store = useRundownStore();
                store.updateItem(nextItem.id, { ingestorStatus: 'error' });
                setTimeout(() => {
                    advanceNext(false).catch(() => {});
                }, 100);
            }
        } else {
            await playItemAt(nextIndex, playToken);
        }
    } finally {
        advanceInFlight = false;
    }
}

export async function advanceNext(natural = false) {
    const token = playToken;
    await advanceToNext(token, natural);
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

        queuedItems = items.map((i: any) => ({ ...i }));
        playToken += 1;
        playStartTime.value = Date.now();
        playStartIndex.value = startIndex;

        if (startIndex < 0 || startIndex >= queuedItems.length) {
            await this.stop();
            return;
        }

        await playItemAt(startIndex, playToken);
    },

    async pause() {
        if (!isCasparConnected.value) return;
        await sendRawCommand(`PAUSE ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.video}`);
        isCasparPlaying.value = false;
        // Tell Rust to suppress the watchdog/EOF advance while paused.
        await invoke('caspar_set_playback_paused', { paused: true }).catch(() => {});
    },

    async stop() {
        playToken += 1;
        isCasparPlaying.value = false;
        currentCasparDurationMs.value = 0;
        currentKey = null;
        updateDisplayedTime(0);
        timelineTimers.forEach(clearTimeout);
        timelineTimers = [];
        if (isCasparConnected.value) {
            // Targeted clears first (clean logging), then the nuclear fallback.
            await this.clearCompliance?.();
            await this.clearOverlays?.();
            await this.clearBranding?.();
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}`);
        }

        // Release Rust playback ownership.
        await invoke('caspar_clear_playback').catch(() => {});
        await invoke('caspar_set_playback_paused', { paused: false }).catch(() => {});

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
        updateDisplayedTime(item.inPoint || 0);
    },

    async take() {
        if (!isCasparConnected.value) {
            await this.connect();
        }
        const store = useRundownStore();
        const item = store.selectedItem;
        if (!item) return;

        playToken += 1; // Flush/invalidate previous preloads or natural advance tokens

        try {
            if (item.ingestorStatus === 'error') {
                throw new Error(`Cannot play item "${item.filename}" because it has an error status.`);
            }

            const key = queueKey(item);
            currentKey = key;

            if (item.type === 'live') {
                const liveCommand = buildLiveCommand(item.path);
                if (!liveCommand) {
                    throw new Error('No CasparCG live source configured. Set a Live Input Source in Settings.');
                }
                // Clear video layer to avoid holding the last video frame
                await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.video}`);
                await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live}`);
                await sendRawCommand(liveCommand);
                isCasparPlaying.value = true;
                updateDisplayedTime(0);
                
                const durationMs = itemDurationMs(item);
                currentCasparDurationMs.value = durationMs;
                store.startPlaybackProgressTimer(item.id, durationMs);
                
                onAdvanceCallback?.(key); // Notify UI progression immediately!

                await invoke('caspar_register_playback', {
                    uuid: key,
                    durationMs,
                    expectedOutPointMs: durationMs,
                    currentPath: '',
                    nextPath: null
                }).catch(() => {});
                
                const index = queuedItems.findIndex(it => queueKey(it) === key);
                if (index !== -1) {
                    await preloadNextItemAt(index + 1);
                }
                return;
            }

            // For video: force hard PLAY with clip options, flushing any background clips
            const playCmd = await buildPlayVideoCommand(item);
            await sendRawCommand(playCmd);
            isCasparPlaying.value = true;

            const { effectiveDuration, expectedOutPointMs } = computePlaybackDeadline(item);
            store.startPlaybackProgressTimer(item.id, effectiveDuration);
            updateDisplayedTime(item.trim_in_ms ?? item.inPoint ?? 0);
            
            onAdvanceCallback?.(key); // Notify UI progression immediately!

            const currentRawPath = item.path || item.shortPath;
            const currentPath = (await prepareCasparMediaPath(currentRawPath)).replace(/\\/g, '/').replace(/"/g, '');

            const index = queuedItems.findIndex(it => queueKey(it) === key);
            const nextItem = index !== -1 ? queuedItems[index + 1] : null;
            let nextPath: string | null = null;
            if (nextItem && nextItem.type === 'video') {
                const nextRawPath = nextItem.path || nextItem.shortPath;
                nextPath = (await prepareCasparMediaPath(nextRawPath)).replace(/\\/g, '/').replace(/"/g, '');
            }

            await invoke('caspar_register_playback', { 
                uuid: key, 
                durationMs: effectiveDuration,
                expectedOutPointMs: expectedOutPointMs,
                currentPath: currentPath,
                nextPath: nextPath
            }).catch(() => {});

            if (index !== -1) {
                await preloadNextItemAt(index + 1);
            }
        } catch (error: any) {
            console.error('[CasparCG] take error', error);
            store.updateItem(item.id, { ingestorStatus: 'error' });
            
            invoke('push_diagnostic_log', {
                level: 'error',
                scope: 'caspar-playout',
                message: `Take error for ${item.filename}: ${error?.message || error}`
            }).catch(() => {});

            // Auto advance on failure!
            setTimeout(() => {
                advanceNext(false).catch(() => {});
            }, 100);
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
        await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live}`);
        await sendRawCommand(liveCommand);
        isCasparPlaying.value = true;
        updateDisplayedTime(0);
    },

    async refreshQueue(items) {
        // Identity-keyed: the current item is tracked by `currentKey`, so a
        // reordered/replaced queue is re-resolved on the next advance without any
        // index remapping. This is the §A desync fix.
        queuedItems = items.map((i: any) => ({ ...i }));
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

    /// Station logo (layer 30) — always-on persistent branding.
    /// Reads strictly from the CG configuration path for Layer 30 (settings.cg).
    async syncBrandingAssets() {
        if (!isCasparConnected.value) return;
        const settings = getSettingsSnapshot();
        const logoLayer = CASPAR_LAYERS.stationLogo;

        const logoEnabled = settings.cg?.stationIdEnabled !== false;
        const logoSourcePath = settings.cg?.stationIdPath || resolveLogoAsset('logo.png');
        const logoPath = logoSourcePath ? await prepareCasparMediaPath(logoSourcePath) : '';

        if (logoEnabled && logoPath) {
            await invoke('caspar_play_image', { channel: PROGRAM_CHANNEL, layer: logoLayer, path: logoPath }).catch((e: any) => {
                console.warn('[CasparCG] Failed to play station logo', e);
            });

            const opacity = 0.8; // Defaults strictly to 80% opacity
            const lx = (settings.cgStationLogoPos?.left ?? 5) / 100;
            const ly = (settings.cgStationLogoPos?.top ?? 5) / 100;
            const lw = (settings.cgStationLogoPos?.width ?? 12) / 100;
            const lh = (settings.cgStationLogoPos?.height ?? 12) / 100;

            await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${logoLayer} FILL ${lx.toFixed(4)} ${ly.toFixed(4)} ${lw.toFixed(4)} ${lh.toFixed(4)}`);
            await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${logoLayer} OPACITY ${opacity.toFixed(3)}`);
        } else {
            await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: logoLayer }).catch(() => {});
        }
    },

    async seekMedia(_inputName: string, timeCursor: number) {
        updateDisplayedTime(timeCursor);
    },

    async applyComplianceForItem(item) {
        if (!isCasparConnected.value) return;
        const settings = getSettingsSnapshot();
        const ratingLayer = CASPAR_LAYERS.rating;
        const tpLayer = CASPAR_LAYERS.tp;

        timelineTimers.forEach(clearTimeout);
        timelineTimers = [];

        const rating = (item.complianceRating || 'none') as ComplianceRating;
        const tpFlag = !!item.tp_flag;

        // Age rating badge (image producer via typed command).
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
            await invoke('caspar_play_image', { channel: PROGRAM_CHANNEL, layer: ratingLayer, path }).catch((e: any) => {
                console.warn('[CasparCG] Failed to play rating badge', e);
            });

            const rx = (settings.cgRatingBadgePos?.left ?? 88) / 100;
            const ry = (settings.cgRatingBadgePos?.top ?? 5) / 100;
            const rw = (settings.cgRatingBadgePos?.width ?? 7) / 100;
            const rh = (settings.cgRatingBadgePos?.height ?? 7) / 100;
            await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${ratingLayer} FILL ${rx.toFixed(4)} ${ry.toFixed(4)} ${rw.toFixed(4)} ${rh.toFixed(4)}`);
        } else {
            await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: ratingLayer }).catch(() => {});
        }

        // TP badge (image producer). Fallback to resolveLogoAsset('TP.png') when
        // the configured path is unset (plan §B fix).
        const tpSourcePath = settings.cgRatingTPPath || (tpFlag ? resolveLogoAsset('TP.png') : '');
        if (tpFlag && tpSourcePath) {
            const path = await prepareCasparMediaPath(tpSourcePath);
            await invoke('caspar_play_image', { channel: PROGRAM_CHANNEL, layer: tpLayer, path }).catch((e: any) => {
                console.warn('[CasparCG] Failed to play TP badge', e);
            });

            const tpx = (settings.cgTPPos?.left ?? 88) / 100;
            const tpy = (settings.cgTPPos?.top ?? 13) / 100;
            const tpw = (settings.cgTPPos?.width ?? 7) / 100;
            const tph = (settings.cgTPPos?.height ?? 7) / 100;
            await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${tpLayer} FILL ${tpx.toFixed(4)} ${tpy.toFixed(4)} ${tpw.toFixed(4)} ${tph.toFixed(4)}`);
        } else {
            await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: tpLayer }).catch(() => {});
        }

        // Dynamic explanation banners (CG template, layer 32). No MIXER on template
        // layers — templates self-position (plan §1.1 rule).
        const timeline = item.timeline || [];
        timeline.forEach((field: any) => {
            if (!field.text) return;
            const startMs = parseTimeToMs(field.start);
            const endMs = parseTimeToMs(field.end);

            const startTimer = setTimeout(async () => {
                const template = settings.cgExplanationTemplate || 'playout/explanation';
                await invoke('caspar_cg_add', {
                    channel: PROGRAM_CHANNEL,
                    layer: CASPAR_LAYERS.explanation,
                    template,
                    play: true,
                    data: { text: field.text }
                }).catch((e: any) => {
                    console.warn('[CasparCG] Failed to add explanation CG', e);
                });
            }, startMs);
            timelineTimers.push(startTimer);

            const endTimer = setTimeout(async () => {
                await invoke('caspar_cg_stop', { channel: PROGRAM_CHANNEL, layer: CASPAR_LAYERS.explanation }).catch(() => {});
                const cleanupTimer = setTimeout(async () => {
                    await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: CASPAR_LAYERS.explanation }).catch(() => {});
                }, 1000);
                timelineTimers.push(cleanupTimer);
            }, endMs);
            timelineTimers.push(endTimer);
        });
    },

    /// Clears per-item compliance layers: 31 (rating), 32 (explanation), 34 (TP).
    async clearCompliance() {
        if (!isCasparConnected.value) return;
        timelineTimers.forEach(clearTimeout);
        timelineTimers = [];
        for (const layer of [CASPAR_LAYERS.rating, CASPAR_LAYERS.explanation, CASPAR_LAYERS.tp]) {
            await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer }).catch(() => {});
        }
    },

    /// Clears the on-demand crawl layer (33). (plan §B / §3.2)
    async clearOverlays() {
        if (!isCasparConnected.value) return;
        await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: CASPAR_LAYERS.crawl }).catch(() => {});
    },

    /// Clears the station logo layer (30). (plan §B / §3.2)
    async clearBranding() {
        if (!isCasparConnected.value) return;
        await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: CASPAR_LAYERS.stationLogo }).catch(() => {});
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

/// Toggle the on-demand crawl (layer 33, CG template). Uses the typed CG commands
/// so the payload is serde-serialized (fixes the broken hand-rolled `escapeJson`
/// that corrupted crawls with quotes/newlines/emoji — plan §B). No MIXER on the
/// crawl layer — templates self-position.
export const toggleCrawlTicker = async () => {
    if (!isCasparConnected.value) return;
    const settings = getSettingsSnapshot();
    const crawlLayer = CASPAR_LAYERS.crawl;

    if (settings.cgCrawlActive) {
        await invoke('caspar_cg_stop', { channel: PROGRAM_CHANNEL, layer: crawlLayer }).catch(() => {});
        setTimeout(async () => {
            await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: crawlLayer }).catch(() => {});
        }, 1000);
        settings.updateSettings({ cgCrawlActive: false });
    } else {
        await invoke('caspar_cg_add', {
            channel: PROGRAM_CHANNEL,
            layer: crawlLayer,
            template: settings.cgCrawlTemplate || 'playout/crawl',
            play: true,
            data: { text: settings.cgCrawlText || '' }
        }).catch((e: any) => {
            console.warn('[CasparCG] Failed to add crawl CG', e);
        });
        settings.updateSettings({ cgCrawlActive: true });
    }
};

export const updateCrawlTickerText = async () => {
    if (!isCasparConnected.value) return;
    const settings = getSettingsSnapshot();
    const crawlLayer = CASPAR_LAYERS.crawl;
    if (settings.cgCrawlActive) {
        await invoke('caspar_cg_update', {
            channel: PROGRAM_CHANNEL,
            layer: crawlLayer,
            data: { text: settings.cgCrawlText || '' }
        }).catch((e: any) => {
            console.warn('[CasparCG] Failed to update crawl CG', e);
        });
    }
};