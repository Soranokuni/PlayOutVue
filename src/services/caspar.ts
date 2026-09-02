import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import { ref } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useRundownStore, type ComplianceRating, type IngestorStatus } from '../stores/rundown';
import type { PlayoutAdvanceCallback, PlayoutItem, PlayoutService } from './playout';
import { hydrateItem, type RundownItem } from '../lib/rundownHydrator';
import { dispatchPlay, dispatchLoadbg, computeDurationMsFromTrim, type FrameTrimResult } from '../lib/playoutDispatch';
import { initEndGuard, registerPlayStart, activeGuard, stopEndGuard } from '../lib/endGuard';
import { clearPlaybackState, loadPlaybackState, savePlaybackState } from '../lib/playbackPersistence';
import { classifyPlayoutFailure, shouldFlagItemFailure } from '../lib/playoutFailurePolicy';
import { PlaybackCoordinator, type PlaybackIntent } from '../lib/playbackCoordinator';
import { parseDescriptorsFromText, getGreekRatingDefaultText } from '../lib/greekCompliance';
import { onCasparProcessStateChange, type CasparProcessStatus } from './casparProcess';

export const playbackCoordinator = new PlaybackCoordinator();

export const playStartTime = ref(0);
export const playStartIndex = ref(0);
// Advance dedup is UUID-keyed, not time-keyed: a time window also swallows
// legitimate advances for DIFFERENT items that follow a short clip closely
// (Rust latches advance_fired and the JS side then freezes). Only a duplicate
// advance for the SAME item inside the window is dropped.
let lastAdvanceUuid: string | null = null;
let lastAdvanceAt = 0;
const ADVANCE_DEDUP_WINDOW_MS = 1000;

const PROGRAM_CHANNEL = 1;
const FRAME_MS = 40;
const PAL_FPS = 25;
const RECONNECT_BASE_DELAY_MS = 750;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_FOREGROUND_ATTEMPTS = 6;
const HEARTBEAT_INTERVAL_MS = 5_000;

// Dispatch retry policy: a manual take is single-shot today, so any transient
// dispatch failure (ingestor still copying the file / sidecar JSON not yet
// written, scanner probe lag, momentary CasparCG connection flap) throws and
// take() auto-advances to the NEXT item — the "trimmed clip sometimes skips"
// symptom. Retrying a few times absorbs those races; hard errors (missing
// file, broken trim, QC rejection) fail fast.
const DISPATCH_RETRY_ATTEMPTS = 3;
const DISPATCH_RETRY_DELAY_MS = 400;

/** Errors that retrying cannot fix — fail immediately. */
function isHardDispatchError(error: unknown): boolean {
    const msg = String((error as any)?.message || error || '').toLowerCase();
    return (
        msg.includes('degenerate trim') ||
        msg.includes('file not found') ||
        msg.includes('qc not passed') ||
        msg.includes('mezzanine_ok=false') ||
        msg.includes('critical')
    );
}

/**
 * dispatchPlay with bounded retries for transient failures. The Rust side is
 * also hardened with an ffprobe last-resort fallback, so in practice a retry
 * only fires on connection-level hiccups — but a single spurious throw must
 * never skip an item the operator explicitly took.
 */
async function dispatchPlayWithRetry(
    item: RundownItem,
    channel: number,
    layer: number,
    nextPath: string | null,
    resumeSeekMs = 0,
    token?: number
): Promise<{ durationMs: number; expectedOutMs: number } | null> {
    // A dispatch that outlives its play token is obsolete: abort silently
    // (no error, no retry) so a stale PLAY never lands on the AMCP channel
    // after a newer take()/play() took control (Bug B).
    const isStale = token !== undefined ? () => token !== playToken : undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= DISPATCH_RETRY_ATTEMPTS; attempt++) {
        try {
            const result = await dispatchPlay(item, channel, layer, nextPath, resumeSeekMs, isStale);
            if (result === null) return null;
            return result;
        } catch (error) {
            lastError = error;
            if (isHardDispatchError(error) || attempt === DISPATCH_RETRY_ATTEMPTS) {
                throw error;
            }
            console.warn(
                `[CasparCG] dispatchPlay attempt ${attempt}/${DISPATCH_RETRY_ATTEMPTS} failed, retrying in ${DISPATCH_RETRY_DELAY_MS}ms:`,
                error
            );
            await new Promise((resolve) => setTimeout(resolve, DISPATCH_RETRY_DELAY_MS));
        }
    }
    throw lastError;
}

// --- Layer registry (TS mirror of src-tauri/src/caspar_layers.rs) ---
// Single source of truth for layer numbers on the program channel. Keep in
// sync with the Rust enum — see plan §1.1.
//
// CROSS-REFERENCE: src-tauri/src/caspar_layers.rs defines the Rust-side
// `CasparLayer` enum with identical numeric values. Any layer added here MUST
// also be added there, and vice-versa. The Rust `from_layer()` + `layer()`
// methods must map the same numbers. Run `cargo test` in src-tauri after
// changing either side to ensure the layer_numbers_match_registry_table test
// still passes.
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
export const isLiveActive = ref(false);
export const currentCasparTime = ref('00:00:00:00');
export const currentCasparMs = ref(0);
export const currentCasparDurationMs = ref(0);
export const manualTakeFailure = ref<{ itemId: string; filename: string; message: string } | null>(null);

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

/// Resolve the LIVE store item by id. The queue snapshot (`queuedItems`) is a
/// shallow copy taken at play() time; ingestor trim resolution writes
/// `trim_in_ms`/`trim_out_ms` to the store asynchronously and only re-syncs
/// the snapshot through the debounced `refreshQueue`. Preloading and natural
/// advances must read the live item so a LOADBG/PLAY never uses stale
/// zeroed trims (Bug A — "plays from frame 0 instead of the in-point").
const findLiveItemById = (id: string): PlayoutItem | null => {
    try {
        const store = useRundownStore();
        for (const playlist of store.playlists) {
            const found = playlist.items.find((i) => i.id === id);
            if (found) return found as PlayoutItem;
        }
    } catch {
        // store unavailable (early boot / SSR) — fall back to the snapshot
    }
    return null;
};

/// Normalized basename (lowercase, no extension) for comparing preloaded vs
/// live clip paths without media-root/absolute-path noise.
const normBasename = (p: string) => {
    const s = String(p || '').replace(/\\/g, '/').toLowerCase();
    const base = s.split('/').pop() || s;
    return base.replace(/\.[^./\\]+$/, '');
};

// --- Crash-resume state (plan §C) ---
// If CasparCG dies mid-clip and restarts, the producer is gone but our queue,
// rundown store and persisted playback state survive. On reconnect we decide
// (a) it was a transient blip and ticks resumed → do nothing, or (b) the
// producer truly restarted → re-issue PLAY ... SEEK at the crash-time position
// (or auto-advance if the clip finished during downtime).
let wasPlayingOnDisconnect = false;
let resumeEvalTimer: ReturnType<typeof setTimeout> | null = null;
let resumeEvalToken = -1;
let resumeInFlight = false;
let lastOscTickAtMs = 0;
let lastSnapshotAtMs = 0;
/** Resume seek (ms into the current item's content) for the next playItemAt dispatch. */
let pendingResumeSeekMs = 0;
const RESUME_EVAL_DELAY_MS = 2000;
const RESUME_TICK_SURVIVAL_MS = 1500;

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
// AUTO background ownership is distinct from foreground playback ownership.
// A rundown edit must cancel an in-flight LOADBG without cancelling the
// on-air item (which would otherwise turn a safe edit into a hard cut).
let preloadGeneration = 0;
let consecutiveSkips = 0;
const MAX_CONSECUTIVE_SKIPS = 3;
let advanceInFlight = false;
let feedbackListenerPromise: Promise<void> | null = null;
let feedbackUnlisten: (() => void) | null = null;
let tickUnlisten: (() => void) | null = null;
let advanceUnlisten: (() => void) | null = null;
let confirmUnlisten: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let reconnectRequested = false;
let reconnectInFlight: Promise<void> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// Track which items have been successfully preloaded via LOADBG AUTO.
// The natural advance path assumes CasparCG auto-transitioned to the
// preloaded clip. If the preload failed (e.g. ingestor not ready), there
// is nothing to auto-transition to and the screen would freeze. By
// checking this set, advanceToNext can fall back to playItemAt (which
// sends an explicit PLAY) when the preload didn't happen.
const preloadedKeys = new Set<string>();

// Trim fingerprint of every successful preload (keyed by queue key). The
// natural advance validates the on-air transition against the LIVE item's
// current trim; a mismatch means the LOADBG carried stale (zeroed) trim and
// the AUTO transition would play from frame 0 — force a hard PLAY instead
// (validate-on-advance, plan Phase 1).
const preloadedFingerprints = new Map<string, { trimInMs: number; trimOutMs: number; path: string }>();

const invalidatePreloads = () => {
    preloadGeneration += 1;
    preloadedKeys.clear();
    preloadedFingerprints.clear();
};

const preloadMatchesItem = (key: string, item: PlayoutItem) => {
    const fingerprint = preloadedFingerprints.get(key);
    if (!fingerprint) return false;
    const hydrated = hydratePlayoutItem(item);
    return fingerprint.trimInMs === hydrated.trim_in_ms
        && fingerprint.trimOutMs === hydrated.trim_out_ms
        && normBasename(fingerprint.path) === normBasename(item.path || item.shortPath || '');
};

async function applyComplianceForPlayback(item: PlayoutItem, token: number): Promise<boolean> {
    if (token !== playToken) return false;
    await casparPlayoutService.applyComplianceForItem?.(item);
    return token === playToken;
}

/// Waiters for Rust's `caspar://foreground-confirmed` event (Phase 4).
let confirmWaiters: Array<{ uuid: string; resolve: (ok: boolean) => void }> = [];
function waitForForegroundConfirmation(uuid: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
            if (!settled) {
                settled = true;
                resolve(ok);
            }
        };
        const entry = { uuid, resolve: finish };
        confirmWaiters.push(entry);
        setTimeout(() => {
            confirmWaiters = confirmWaiters.filter((w) => w !== entry);
            finish(false);
        }, timeoutMs);
    });
}

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
            cgExplanationTemplate: 'playout/advisory',
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
        sendRawCommand('INFO').catch(() => {});
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

    // Remember that a clip was on air when the transport dropped so the
    // reconnect handler can resume it after a genuine CasparCG restart.
    wasPlayingOnDisconnect = isCasparPlaying.value && currentKey != null;

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

        // Strip Windows verbatim prefix from both for comparison
        const pClean = p.replace(/^\/\/\?\//, '');
        const rootClean = mediaRoot.replace(/^\/\/\?\//, '');
        const pCleanLower = pClean.toLowerCase();
        const rootCleanLower = rootClean.toLowerCase();

        if (pCleanLower.startsWith(rootCleanLower)) {
            p = pClean.substring(rootClean.length).replace(/^\/+/, '');
        } else {
            // Try to find the media root base name in the path and strip from there
            const rootParts = rootClean.split('/');
            const rootBaseName = (rootParts[rootParts.length - 1] || '').toLowerCase();
            const pParts = pClean.split('/');
            const rootIdx = pParts.findIndex(s => s.toLowerCase() === rootBaseName);
            if (rootIdx >= 0) {
                p = pParts.slice(rootIdx + 1).join('/');
            } else if (!pClean.includes(':') && !pClean.startsWith('/')) {
                // Already a relative path — return as-is (preserves subdirectory structure)
                p = pClean;
            }
            // else: full absolute path that doesn't match media root.
            // Do NOT strip to just the filename — return the full path so
            // CasparCG can try to resolve it. This prevents the critical bug
            // where videos/...mp4 was stripped to just ...mp4.
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
    stopEndGuard();
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
    if (confirmUnlisten) {
        try { confirmUnlisten(); } catch { /* ignore */ }
        confirmUnlisten = null;
    }
    confirmWaiters = [];
    // Release the ensureFeedbackListener singleton promise so a subsequent
    // connect() re-runs the listener setup. Without this, disconnect()→connect()
    // short-circuits in ensureFeedbackListener (feedbackListenerPromise != null)
    // and never re-registers the OSC/advance listeners — the rundown freezes.
    feedbackListenerPromise = null;
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
    if (!logosRoot) {
        console.warn(`[CasparCG] Cannot resolve logo asset "${filename}" — no logosPath or localMediaPath configured in Settings.`);
        return '';
    }
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

/// Hydrate a PlayoutItem (store shape, may carry legacy `inPoint`/`outPoint`/
/// `shortPath`/`playoutvueId` fields) into a canonical RundownItem suitable
/// for the frame-accurate dispatch path. Centralizes the rawItem+hydrateItem
/// mapping that was previously duplicated inline in playItemAt,
/// advanceToNext, preloadNextItemAt, cue, and take — ensuring every AMCP
/// command is built from the same hydrated shape (plan §3 unification).
const hydratePlayoutItem = (item: PlayoutItem): RundownItem => {
    return hydrateItem({
        id: item.id,
        path: item.path || item.shortPath,
        playoutvue_id: item.playoutvueId || item.id,
        duration_ms: item.duration_ms || (item.duration ? item.duration * 1000 : 0) || 0,
        trim_in_ms: (item.trim_in_ms !== undefined && item.trim_in_ms > 0) ? item.trim_in_ms : (item.inPoint ?? 0),
        trim_out_ms: (item.trim_out_ms !== undefined && item.trim_out_ms > 0) ? item.trim_out_ms : (item.outPoint && item.outPoint > 0 ? item.outPoint : 0),
        fps_num: item.fps_num ?? 0,
        fps_den: item.fps_den ?? 0,
        fps: item.fps,
        mezzanine_ok: item.mezzanine_ok
    });
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

/// Extract the foreground producer path from an `INFO <ch>-<layer>` response
/// (CasparCG 2.x reports `Path:` / `File:` for file producers, and nothing for
/// an empty layer).
const parseForegroundPathFromInfo = (response: string) => {
    const match = String(response || '').match(/^\s*(?:path|file)\s*:\s*(.+?)\s*$/im);
    if (!match?.[1]) return '';
    return match[1].trim().replace(/\\/g, '/').replace(/"/g, '');
};

/// Phase 4 defense-in-depth: after a natural advance commits (register + timer
/// started), wait for Rust's `caspar://foreground-confirmed` — i.e. the OSC
/// path/position proving the preloaded clip is genuinely on air. On timeout,
/// verify via `INFO 1-10` and only re-issue a hard PLAY when the on-air clip is
/// provably wrong (empty layer or an unrelated path). A still-pending
/// transition (previous clip still foreground) is allowed an extra round.
async function confirmAndRepairForeground(
    key: string,
    hydrated: RundownItem,
    expectedPath: string,
    prevPath: string,
    token: number
) {
    try {
        const confirmed = await waitForForegroundConfirmation(key, 1500);
        if (confirmed) return;
        if (token !== playToken || currentKey !== key) return;

        for (let round = 0; round < 2; round += 1) {
            if (round > 0) await wait(800);
            if (token !== playToken || currentKey !== key) return;

            let info = '';
            try {
                info = await sendRawCommand(`INFO ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.video}`);
            } catch {
                // Transport/AMCP failure — the watchdog and end guard still
                // own the advance; do not repair blindly.
                return;
            }

            const onAir = parseForegroundPathFromInfo(info);
            if (!onAir) {
                // Empty layer: the AUTO transition never fired — hard PLAY.
                await repairForegroundPlay(key, hydrated, token, 'empty layer after natural advance');
                return;
            }
            const onAirNorm = normBasename(onAir);
            const expectedNorm = normBasename(expectedPath);
            if (expectedNorm && onAirNorm === expectedNorm) return;
            const prevNorm = normBasename(prevPath);
            if (prevNorm && onAirNorm === prevNorm) {
                continue; // transition still pending — allow one more round
            }
            await repairForegroundPlay(key, hydrated, token, `foreground is "${onAir}" instead of the expected clip`);
            return;
        }
    } catch (error) {
        console.warn('[CasparCG] Foreground confirmation check failed', error);
    }
}

async function repairForegroundPlay(key: string, hydrated: RundownItem, token: number, reason: string) {
    if (token !== playToken || currentKey !== key) return;
    console.warn(`[CasparCG] Repairing foreground: ${reason} — re-issuing hard PLAY with correct trim.`);
    invoke('push_diagnostic_log', {
        level: 'warn',
        scope: 'caspar-playout',
        message: `Foreground repair: ${reason} for ${hydrated.path}`
    }).catch(() => {});
    await dispatchPlayWithRetry(hydrated, PROGRAM_CHANNEL, CASPAR_LAYERS.video, null, 0, token).catch((error) => {
        console.warn('[CasparCG] Foreground repair PLAY failed', error);
    });
}

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
///
/// IMPORTANT: This function is only needed when the initial duration was
/// UNKNOWN (0) at dispatch time — e.g. an unresolved ingestor asset. When the
/// trim duration was already computed by `compute_frame_trim` +
/// `computeDurationMsFromTrim` (the normal path for all clips including
/// subclips), the initial `caspar_register_playback` call already armed the
/// watchdog with the correct `expected_out_point_ms`. Re-registering would
/// RESET the Rust state machine (position_ms=0, advance_fired=false,
/// position_ever_advanced=false) mid-playback, which is destructive:
///   - For short subclips (4s), the reset wipes accumulated OSC state and
///     can overwrite the correct trim-based `expectedOutPointMs` with the
///     OSC-reported FILE duration (e.g. 15.64s), causing the position-based
///     advance to never fire and the clip to freeze at EOF for 3s.
///   - The progress bar re-anchor causes a visible jump back to 0%.
/// `initialDurationMs` gates the refresh: if it's > 0, the function returns
/// immediately without touching the state machine or the progress timer.
async function refreshCurrentProducerDuration(
    item: PlayoutItem,
    key: string,
    token: number,
    initialDurationMs: number = 0
) {
    // If the dispatch path already computed a valid trim duration, the
    // watchdog is correctly armed. Do NOT re-register — that would reset
    // the Rust state machine mid-playback and overwrite the trim-based
    // expected_out_point_ms with the OSC file duration, breaking subclips.
    if (initialDurationMs > 0) {
        return;
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!isCasparPlaying.value || token !== playToken) return;

        let durationMs = currentCasparDurationMs.value;
        if (durationMs <= 0) {
            durationMs = await queryActiveLayerDurationMs();
        }

        if (durationMs > 0) {
            currentCasparDurationMs.value = durationMs;
            // Use itemDurationMs (respects trim_in_ms/trim_out_ms) rather
            // than updateItemDurationFromMs, which would mutate item.duration
            // with the OSC file duration and potentially return the wrong
            // value for trimmed subclips.
            const totalDurationMs = itemDurationMs(item);

            if (item.id && totalDurationMs > 0) {
                const store = useRundownStore();
                // Only re-anchor the progress timer if the resolved duration
                // is significantly different from what's already running.
                // This prevents the progress bar from snapping back to 0%.
                // The progress timer was already started by the advance path
                // with the correct trim duration; only override if we
                // genuinely resolved a different value.
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
                    nextPath: nextPath,
                    trimInMs: 0
                }).catch((e: any) => {
                    console.warn('[CasparCG] Failed to re-register playback duration', e);
                });
            }
            return;
        }
        await wait(400);
    }
}

const buildLiveCommand = (preferredSource?: string) => {
    if (preferredSource && preferredSource.trim()) {
        return `PLAY ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live} ${preferredSource.trim()}`;
    }
    const s = getSettingsSnapshot();
    if (s.decklinkInputDevice && s.decklinkInputDevice > 0) {
        const fmt = s.decklinkInputFormat && s.decklinkInputFormat !== 'auto' ? ` FORMAT ${s.decklinkInputFormat}` : '';
        return `PLAY ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live} DECKLINK ${s.decklinkInputDevice}${fmt}`;
    }
    const source = (s.liveInputSourceName || '').trim();
    if (!source) return '';
    return `PLAY ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live} ${source}`;
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

        await initEndGuard((itemId) => {
            console.warn('[EndGuard Callback] Playout stalled overtime! Forcing advance next.', itemId);
            invoke('push_diagnostic_log', {
                level: 'warn',
                scope: 'caspar-playout',
                message: `JS end guard triggered: item ${itemId} stalled`
            }).catch(() => {});
            // Pass natural=true so advanceToNext prefers the gapless LOADBG
            // AUTO path when the next item was preloaded. This avoids a hard
            // `PLAY` cut (and the black frame it introduces) on EOF stalls.
            // If no preload exists, advanceToNext falls back to playItemAt
            // (explicit PLAY) automatically. The itemId enables UUID-keyed
            // advance dedup.
            advanceNext(true, itemId).catch((e) => console.error(e));
        });

        if (!tickUnlisten) {
            tickUnlisten = await listen<PlaybackTickPayload>('caspar://playback-tick', (event) => {
                const { positionMs, durationMs, currentUuid } = event.payload;
                lastOscTickAtMs = Date.now();
                updateDisplayedTime(positionMs);
                if (durationMs > 0 && currentCasparDurationMs.value <= 0) {
                    currentCasparDurationMs.value = durationMs;
                }
                if (currentUuid && Date.now() - lastSnapshotAtMs >= 1000) {
                    const item = findLiveItemById(currentUuid);
                    savePlaybackState(currentUuid, Date.now() - positionMs, durationMs || currentCasparDurationMs.value, {
                        itemId: item?.id,
                        path: item?.path,
                        trimInMs: (item as any)?.trim_in_ms,
                        trimOutMs: (item as any)?.trim_out_ms,
                        positionMs,
                        updatedAt: Date.now(),
                        channelOutputRateHz: getSettingsSnapshot().playoutProfile === 'PAL_1080P25' ? 25 : 50,
                    });
                    lastSnapshotAtMs = Date.now();
                }
            });
        }

        if (!advanceUnlisten) {
            advanceUnlisten = await listen<QualifiedAdvanceEvent>('caspar://advance', (event) => {
                const payload = event.payload;
                // Strict stale-advance guard: the backend's currently
                // registered UUID is the only authority. Do not fall back to
                // a rundown item id: a late UDP event can carry an old intent
                // record but must never advance the new on-air UUID.
                const uuid = payload?.currentUuid;
                if (currentKey && uuid === currentKey) {
                    advanceNext(true, uuid).catch((error) => {
                        console.error('[CasparCG] advanceNext error', error);
                    });
                }
            });
        }

        if (!confirmUnlisten) {
            confirmUnlisten = await listen<{ currentUuid: string | null }>('caspar://foreground-confirmed', (event) => {
                const uuid = event.payload?.currentUuid;
                if (!uuid || confirmWaiters.length === 0) return;
                const remaining: typeof confirmWaiters = [];
                for (const waiter of confirmWaiters) {
                    if (waiter.uuid === uuid) {
                        waiter.resolve(true);
                    } else {
                        remaining.push(waiter);
                    }
                }
                confirmWaiters = remaining;
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

    // Clear in-flight preloads, guard, and duration states on reconnect
    invalidatePreloads();
    currentCasparDurationMs.value = 0;
    activeGuard.clear();

    scheduleResumeEvaluation();
};

/// Schedule the post-reconnect crash-resume evaluation. A single timer per
/// reconnect cycle; token-guarded so a manual stop/take during the window
/// cancels it.
const scheduleResumeEvaluation = (isForcedServerRestart = false) => {
    if (resumeEvalTimer) clearTimeout(resumeEvalTimer);
    resumeEvalToken = playToken;
    resumeEvalTimer = setTimeout(() => {
        resumeEvalTimer = null;
        evaluateResume(isForcedServerRestart).catch((error) => {
            console.warn('[CasparCG] Resume evaluation failed', error);
        });
    }, RESUME_EVAL_DELAY_MS);
};

/// Decide what to do after a transport drop + reconnect:
/// - OSC ticks still flowing → transient blip, producer survived → do nothing.
/// - No persisted state (clip finished / user stopped) but we were mid-queue →
///   advance the queue normally.
/// - Clip still within its duration → re-issue PLAY ... SEEK at crash position.
const evaluateResume = async (isForcedServerRestart = false) => {
    if (resumeInFlight) return;
    resumeInFlight = true;
    try {
        const settings = useSettingsStore();
        if (settings.autoResumeAfterRestart === false) return;

        // If this was a forced server restart (watchdog relaunch), we know the engine died
        if (!isForcedServerRestart && Date.now() - lastOscTickAtMs < RESUME_TICK_SURVIVAL_MS) {
            console.info('[CasparCG] OSC ticks survived the transport drop — no resume needed.');
            return;
        }

        const state = loadPlaybackState();
        if (!state) {
            // Persisted state was cleared (clip ended during downtime or a
            // stop happened). If the queue is still active, let it continue.
            if (wasPlayingOnDisconnect && currentKey != null && isCasparPlaying.value) {
                await advanceNext(true, currentKey);
            }
            return;
        }

        const elapsed = state.positionMs && state.updatedAt
            ? Math.min(state.durationMs, state.positionMs + Math.max(0, Date.now() - state.updatedAt))
            : Date.now() - state.startTimestamp;
        if (elapsed >= state.durationMs) {
            // The interrupted clip finished while CasparCG was down — behave
            // as if it ended normally and start the next item.
            console.warn('[CasparCG] Clip finished during downtime — auto-advancing to the next item.');
            await advanceNext(true, currentKey);
            return;
        }

        if (queuedItems.length === 0) {
            const store = useRundownStore();
            if (store.activeItems.length > 0) {
                queuedItems = store.activeItems.map((i: any) => ({ ...i }));
            }
        }

        const index = queuedItems.findIndex((it) => it.id === state.itemId || queueKey(it) === state.uuid);
        if (index === -1) {
            console.warn('[CasparCG] Interrupted item no longer in the queue — skipping resume.');
            clearPlaybackState();
            return;
        }

        const label = state.path || queuedItems[index]?.filename || 'the interrupted item';
        console.warn(`[CasparCG] Auto-resuming "${label}" at ${(elapsed / 1000).toFixed(1)}s into its trimmed window.`);
        await casparPlayoutService.play([...queuedItems], index, elapsed);
        await casparPlayoutService.syncBrandingAssets?.();
    } finally {
        resumeInFlight = false;
        wasPlayingOnDisconnect = false;
    }
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

async function preloadNextItemAt(
    index: number,
    token: number = playToken,
    retriesLeft = 6,
    delayMs = 500,
    preloadToken: number = preloadGeneration
) {
    const isStale = () => token !== playToken || preloadToken !== preloadGeneration;
    if (isStale()) return;
    if (index < 0 || index >= queuedItems.length) return;
    const snapshotItem = queuedItems[index];
    if (!snapshotItem || snapshotItem.type !== 'video') return;

    // Resolve the LIVE store item: the queue snapshot may carry zeroed/stale
    // trims from before the ingestor resolution ran (Bug A). Every retry
    // re-reads the live item so late-resolved trims are picked up.
    const item = findLiveItemById(queueKey(snapshotItem)) ?? snapshotItem;
    if (!item || item.type !== 'video' || item.ingestorStatus === 'error') return;

    // If item path is not resolved yet, or status is not ready, retry with
    // exponential-ish backoff (~500, 750, 1125, 1687, 2531, 3896ms ~= 10.5s
    // total) so late-added ingestor assets still get preloaded. Log on final
    // give-up instead of silently dropping the preload - a dropped preload
    // causes a cold-play black cut when the AUTO trigger fires unprepared.
    // The retry is token-guarded: a manual take or new play during the
    // backoff invalidates the pending preload (a stale LOADBG AUTO would
    // auto-transition onto the wrong clip).
    if (!item.path || item.ingestorStatus !== 'ready') {
        if (retriesLeft > 0) {
            const nextDelay = Math.round(delayMs * 1.5);
            setTimeout(() => {
                if (isStale()) return;
                preloadNextItemAt(index, token, retriesLeft - 1, nextDelay, preloadToken).catch(() => {});
            }, delayMs);
        } else {
            console.warn(`[CasparCG] preloadNextItemAt gave up after retries for item ${item.filename || item.id}`);
            invoke('push_diagnostic_log', {
                level: 'warn',
                scope: 'caspar-playout',
                message: `preload failed for ${item.filename || item.id}: path or ingestor status not ready after retries`
            }).catch(() => {});
        }
        return;
    }

    try {
        const hydrated = hydratePlayoutItem(item);
        // Pre-send stale guard: the caller also checks the token after
        // dispatch, but by then the LOADBG may already be on the wire after a
        // newer take()/play() (Bug B). Passing the guard into dispatchLoadbg
        // aborts the send itself.
        const result = await dispatchLoadbg(hydrated, PROGRAM_CHANNEL, CASPAR_LAYERS.video, true, isStale);
        if (result === null) return;
        if (!isStale()) {
            preloadedKeys.add(queueKey(item));
            preloadedFingerprints.set(queueKey(item), {
                trimInMs: hydrated.trim_in_ms,
                trimOutMs: hydrated.trim_out_ms,
                path: hydrated.path
            });
        }
    } catch (error) {
        console.warn('[CasparCG] Failed to preload next item', item.filename, error);
    }
}

/// Play a single queued item by its array index. Registers it with the Rust
/// state machine (uuid + duration) so Rust owns the advance. No JS advance timer
/// is set — advance fires from `caspar://advance` (OSC EOF or watchdog deadline).
async function playItemAt(index: number, token: number, isManual: boolean = false) {
    try {
        const snapshotItem = queuedItems[index];
        if (!snapshotItem || token !== playToken) return;

        // Prefer the LIVE store item: the snapshot may carry zeroed trims
        // (Bug A). Falls back to the snapshot when the store no longer has it.
        const item = findLiveItemById(queueKey(snapshotItem)) ?? snapshotItem;

        // Consume the crash-resume seek offset atomically at the top so a
        // failed dispatch below can never leak it into the next item.
        const resumeSeekMs = pendingResumeSeekMs;
        pendingResumeSeekMs = 0;

        // Skip items with error status immediately
        if (item.ingestorStatus === 'error') {
            console.warn(`[CasparCG] Skipping item ${item.filename} because it is flagged with error status.`);
            setTimeout(() => {
                advanceNext(false).catch(() => {});
            }, 100);
            return;
        }

        assertIngestorReady(item);

        // Claim the current key SYNCHRONOUSLY, before `ensureItemDurationMs`
        // (which can take ~1s doing CLS/INFO queries). If a stale advance from
        // the previous item's EOF fires while duration is resolving, it would
        // otherwise see the OLD currentKey, pass the guard and take us to the
        // wrong next item (plan §1.4).
        currentKey = queueKey(item);
        const key = currentKey;
        const durationMs = await ensureItemDurationMs(item);
        // A take()/play()/advance during duration resolution invalidates this
        // play request — abort before any side effect (plan §1.4).
        if (token !== playToken) return;

        onAdvanceCallback?.(key);
        if (!await applyComplianceForPlayback(item, token)) return;

        // Synchronously persist playback state immediately at dispatch start
        savePlaybackState(key, Date.now() - resumeSeekMs, durationMs, {
            itemId: item.id,
            path: item.path,
            trimInMs: (item as any)?.trim_in_ms,
            trimOutMs: (item as any)?.trim_out_ms,
            positionMs: resumeSeekMs,
            updatedAt: Date.now(),
            channelOutputRateHz: getSettingsSnapshot().playoutProfile === 'PAL_1080P25' ? 25 : 50,
        });

        // Ensure station branding logo is running on Layer 30
        casparPlayoutService.syncBrandingAssets?.().catch(() => {});

        const store = useRundownStore();

        if (item.type === 'live') {
            const liveCommand = buildLiveCommand(item.path);
            if (!liveCommand) {
                throw new Error('No CasparCG live source configured. Set a Live Input Source in Settings.');
            }
            activeGuard.clear();
            playStartTime.value = Date.now();
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live}`);
            await sendRawCommand(liveCommand);
            if (token !== playToken) return;
            isCasparPlaying.value = true;
            consecutiveSkips = 0;
            updateDisplayedTime(0);
            currentCasparDurationMs.value = durationMs;

            store.startPlaybackProgressTimer(item.id, durationMs, playStartTime.value);

            await invoke('caspar_register_playback', {
                uuid: key,
                durationMs,
                expectedOutPointMs: durationMs,
                currentPath: '',
                nextPath: null,
                trimInMs: 0
            }).catch((e: any) => {
                console.warn('[CasparCG] Failed to register live playback', e);
            });

            await preloadNextItemAt(index + 1, token);
            return;
        }

        if (isLiveActive.value) {
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live}`);
            isLiveActive.value = false;
        }

        const nextItem = queuedItems[index + 1];
        let nextPath: string | null = null;
        if (nextItem && nextItem.type === 'video') {
            const nextRawPath = nextItem.path || nextItem.shortPath;
            try {
                const settings = useSettingsStore();
                nextPath = await invoke<string>('prepare_caspar_media_path', {
                    path: nextRawPath,
                    mediaRoot: settings.localMediaPath || ''
                });
                nextPath = nextPath.replace(/\\/g, '/').replace(/"/g, '');
            } catch (e) {
                console.warn('[CasparCG] Failed to prepare next path:', e);
                nextPath = nextRawPath.replace(/\\/g, '/').replace(/"/g, '');
            }
        }
        if (token !== playToken) return;

        activeGuard.clear();
        playStartTime.value = Date.now();

        // Hydrate the item
        const hydrated = hydratePlayoutItem(item);

        // Zero the elapsed timer / playhead BEFORE dispatching PLAY so the old
        // clip's position cannot bleed into the new clip's UI during the
        // dispatch window (same state-leak fix as take()).
        updateDisplayedTime(0);
        currentCasparDurationMs.value = 0;
        store.stopPlaybackProgressTimer();

        // Dispatch frame-accurate trim PLAY and register playback. On a
        // crash-resume the pending seek offset continues the clip where it
        // stopped (SEEK past the trim IN point, LENGTH = remaining frames).
        // Retried on transient failures so a metadata/connection race never
        // skips the clip to the next item.
        const dispatchResult = await dispatchPlayWithRetry(
            hydrated,
            PROGRAM_CHANNEL,
            CASPAR_LAYERS.video,
            nextPath,
            resumeSeekMs,
            token
        );
        if (dispatchResult === null) return; // superseded by a newer take()/play()
        if (token !== playToken) return;

        isCasparPlaying.value = true;
        consecutiveSkips = 0;
        updateDisplayedTime(0);
        currentCasparDurationMs.value = dispatchResult.durationMs;

        // Register play start with our end-guard
        registerPlayStart(hydrated.id, dispatchResult.durationMs);

        // Snapshot wall-clock AFTER async dispatch so the first rAF tick does
        // not include the 50-200ms IPC gap. Matches the natural advance path
        // pattern (progressStartTime captured after all async prepare work).
        const progressStartTime = Date.now();
        store.startPlaybackProgressTimer(hydrated.id, dispatchResult.durationMs, progressStartTime);

        // Preload next item immediately
        await preloadNextItemAt(index + 1, token);

        // Late-resolve duration if still unknown and re-register the deadline.
        // Pass the initial trim duration so the refresh can skip re-registration
        // when the watchdog was already armed correctly (the normal path for
        // all clips with known trim, including subclips).
        setTimeout(() => {
            if (token !== playToken) return;
            refreshCurrentProducerDuration(item, key, token, dispatchResult.durationMs).catch((error: any) => {
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
        
        const failure = classifyPlayoutFailure(error);
        const store = useRundownStore();
        const item = queuedItems[index];
        if (item && shouldFlagItemFailure(failure)) {
            store.updateItem(item.id, { ingestorStatus: 'error' });
        }

        invoke('push_diagnostic_log', {
            level: 'error',
            scope: 'caspar-playout',
            message: `Playout error at index ${index} (${item?.filename || 'unknown'}): ${failure.message}`
        }).catch(() => {});

        if (isManual && item) {
            manualTakeFailure.value = { itemId: item.id, filename: item.filename, message: failure.message };
            return;
        }

        consecutiveSkips += 1;
        if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
            console.error(`[CasparCG] ${MAX_CONSECUTIVE_SKIPS} consecutive playout errors - halting playout.`);
            invoke('push_diagnostic_log', {
                level: 'error',
                scope: 'caspar-playout',
                message: `Halting playout: ${MAX_CONSECUTIVE_SKIPS} consecutive playout errors reached.`
            }).catch(() => {});
            emit('playout://halted', { consecutiveSkips }).catch((e) => {
                console.warn('[CasparCG] Failed to emit playout://halted event', e);
            });
            await casparPlayoutService.stop();
            return;
        }

        // Automatically trigger advanceNext(false) only for natural advance failures!
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

    // Set playStartTime synchronously at the very top of the transition
    playStartTime.value = Date.now();

    // Clear previous clip's guard state synchronously
    if (currentKey) {
        activeGuard.delete(currentKey);
    }

    try {
        playToken += 1;
        // The transition runs under its own token: any take()/play()/new
        // advance during the awaits below bumps playToken and aborts this
        // transition (plan §1.4 — manual takes must never be clobbered by an
        // in-flight natural advance).
        const transitionToken = playToken;

        if (currentKey == null) {
            await casparPlayoutService.stop();
            onAdvanceCallback?.(null);
            return;
        }

        const currentIndex = queuedItems.findIndex((it) => queueKey(it) === currentKey);
        if (currentIndex === -1) {
            // The current item is no longer in the queue snapshot (queue was
            // rebuilt or cleared mid-playback). Stop instead of wrapping
            // around to queuedItems[0] — the old behavior preloaded and then
            // played the WRONG first row when the queue context changed.
            await casparPlayoutService.stop();
            onAdvanceCallback?.(null);
            return;
        }
        const nextIndex = currentIndex + 1;

        if (nextIndex >= queuedItems.length) {
            await casparPlayoutService.stop();
            onAdvanceCallback?.(null);
            return;
        }

        const currentItem = queuedItems[currentIndex];
        const nextItem = queuedItems[nextIndex];
        if (!nextItem) {
            await casparPlayoutService.stop();
            onAdvanceCallback?.(null);
            return;
        }

        const nextKey = nextItem ? queueKey(nextItem) : '';
        // Prefer the LIVE store item for the next clip: the queue snapshot may
        // carry zeroed trims, and the LOADBG that is about to fire (or already
        // fired) was built from the live item at preload time. Hydrating both
        // sides from the same live source makes the fingerprint check below
        // meaningful (Bug A).
        const liveNextItem = findLiveItemById(nextKey) ?? nextItem;
        const preloadMatches = preloadMatchesItem(nextKey, liveNextItem);

        // Only take the natural (no-PLAY) path when the next clip was
        // successfully preloaded via LOADBG AUTO **with the trim the live
        // item now carries**. If the preload failed (ingestor not ready, path
        // unresolved) or its trim fingerprint no longer matches (trim resolved
        // or edited after the preload), the AUTO transition would play from
        // frame 0 / the wrong window — fall through to playItemAt, which sends
        // an explicit PLAY with the correct SEEK/LENGTH.
        const isNaturalVideoTransition =
            natural &&
            currentItem &&
            currentItem.type === 'video' &&
            nextItem &&
            nextItem.type === 'video' &&
            preloadedKeys.has(nextKey) &&
            preloadMatches;

        if (isNaturalVideoTransition && nextItem) {
            preloadedKeys.delete(nextKey);
            preloadedFingerprints.delete(nextKey);
            if (liveNextItem.ingestorStatus === 'error') {
                console.warn(`[CasparCG] Skipping item ${liveNextItem.filename} on natural advance because it is flagged with error status.`);
                setTimeout(() => {
                    advanceNext(false).catch(() => {});
                }, 100);
                return;
            }

            try {
                assertIngestorReady(liveNextItem);
                const key = queueKey(liveNextItem);

                // Resolve duration before hydrating so the hydrator doesn't
                // fabricate a fake clip for an unresolved item. This mirrors
                // playItemAt (which calls ensureItemDurationMs). Without it, a
                // next item with duration_ms=0 hydrates to a 0/2000ms sentinel
                // and plays as a 2-second phantom clip.
                await ensureItemDurationMs(liveNextItem);
                if (transitionToken !== playToken) return;

                // Hydrate the next item (from the LIVE item — freshest trims)
                const hydrated = hydratePlayoutItem(liveNextItem);

                // Call compute_frame_trim to get frame-accurate values
                const trim = await invoke<FrameTrimResult>('compute_frame_trim', {
                    path: hydrated.path,
                    trimInMs: hydrated.trim_in_ms,
                    trimOutMs: hydrated.trim_out_ms
                });
                if (transitionToken !== playToken) return;

                // Calculate precise expected duration. OSC position is
                // relative to the trim start (the producer is SEEK'd), so
                // expectedOutMs must be the content duration — NOT the
                // absolute trim_in_ms + durationMs. The old absolute value
                // set the advance threshold beyond the clip end, freezing the
                // rundown on any trimmed clip on a natural video transition.
                const durationMs = computeDurationMsFromTrim(trim, hydrated.id);
                const expectedOutMs = durationMs;

                currentKey = key;
                const store = useRundownStore();
                store.stopPlaybackProgressTimer();
                onAdvanceCallback?.(key);
                if (!await applyComplianceForPlayback(liveNextItem, transitionToken)) return;

                updateDisplayedTime(0);
                currentCasparDurationMs.value = durationMs;

                activeGuard.clear();

                // Snapshot wall-clock now, AFTER the async trim/path work.
                // playStartTime.value (set at fn top) stays for ETA computation;
                // this local timestamp goes to the progress timer so the first
                // rAF tick doesn't include the transition gap.
                const progressStartTime = Date.now();

                // Prepare paths for registration
                const nextItemPath = (await prepareCasparMediaPath(hydrated.path)).replace(/\\/g, '/').replace(/"/g, '');
                if (transitionToken !== playToken) return;

                const nextNextItem = queuedItems[nextIndex + 1];
                let nextNextPath: string | null = null;
                if (nextNextItem && nextNextItem.type === 'video') {
                    const nextNextRawPath = nextNextItem.path || nextNextItem.shortPath;
                    try {
                        const settings = useSettingsStore();
                        nextNextPath = await invoke<string>('prepare_caspar_media_path', {
                            path: nextNextRawPath,
                            mediaRoot: settings.localMediaPath || ''
                        });
                        nextNextPath = nextNextPath.replace(/\\/g, '/').replace(/"/g, '');
                    } catch (e) {
                        nextNextPath = nextNextRawPath.replace(/\\/g, '/').replace(/"/g, '');
                    }
                }
                if (transitionToken !== playToken) return;

                // Arms the Rust state machine BEFORE the JS progress timer:
                // if caspar_register_playback fails, we won't have a running
                // timer with no watchdog. The register .catch logs but doesn't
                // throw; a register failure here is non-fatal for the timer
                // since the OSC EOF advance + endGuard still work.
                // Register the waiter first: a path-switch advance can mean
                // the next clip is already on air, and its confirmation event
                // may be emitted during the registration IPC round-trip.
                const foregroundConfirmation = waitForForegroundConfirmation(key, 1500);
                await invoke('caspar_register_playback', {
                    uuid: key,
                    durationMs: durationMs,
                    expectedOutPointMs: expectedOutMs,
                    currentPath: nextItemPath,
                    nextPath: nextNextPath,
                    trimInMs: hydrated.trim_in_ms || 0
                }).catch((e: any) => {
                    console.warn('[CasparCG] Failed to register playback on natural advance', e);
                });
                if (transitionToken !== playToken) return;

                // Register with our end-guard and start the progress timer
                // ONLY after the Rust watchdog is armed.
                registerPlayStart(hydrated.id, durationMs);
                store.startPlaybackProgressTimer(hydrated.id, durationMs, progressStartTime);

                // Do not overwrite the current item's LOADBG background until
                // OSC proves it has become foreground. This preserves B when
                // A -> B is natural: issuing LOADBG C while B is still only
                // background would replace B and skip it entirely. A timeout
                // leaves the next transition to the guarded hard-PLAY fallback
                // rather than guessing that it is safe to overwrite hardware.
                if (await foregroundConfirmation && transitionToken === playToken) {
                    await preloadNextItemAt(nextIndex + 1, transitionToken);
                } else if (transitionToken === playToken) {
                    console.warn('[CasparCG] Foreground confirmation timed out; AUTO preload remains disarmed until the next verified transition.');
                }

                setTimeout(() => {
                    const currentPlayToken = playToken;
                    refreshCurrentProducerDuration(liveNextItem, key, currentPlayToken, durationMs).catch((error: any) => {
                        console.warn('[CasparCG] Failed to refresh active producer duration', error);
                    });
                }, 250);
            } catch (error: any) {
                console.error('[CasparCG] advanceToNext natural error', error);
                const store = useRundownStore();
                store.stopPlaybackProgressTimer();
                store.updateItem(liveNextItem.id, { ingestorStatus: 'error' });
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

export async function advanceNext(natural = false, sourceUuid?: string | null) {
    if (natural) {
        // Every automatic transition is ownership-fenced by the item that was
        // actually on air. The Rust listener already performs this check, but
        // the end-guard and recovery paths also call this public function;
        // keeping the invariant here prevents an old guard callback from
        // advancing the item a producer has just manually taken.
        if (!sourceUuid || sourceUuid !== currentKey) {
            console.warn('[CasparCG] Ignoring stale natural advance for a non-current item.');
            return;
        }
        // UUID-keyed dedup: drop only a duplicate natural advance for the SAME
        // item inside the window (both the endGuard and the caspar://advance
        // listener can fire for one transition). Advances for different items
        // are NEVER dropped — the old time-window debounce froze the rundown
        // when a short clip's legitimate advance fell inside the window while
        // Rust had already latched advance_fired (plan §1.4).
        if (
            sourceUuid &&
            sourceUuid === lastAdvanceUuid &&
            Date.now() - lastAdvanceAt < ADVANCE_DEDUP_WINDOW_MS
        ) {
            console.warn('[CasparCG] Ignoring duplicate natural advance for the same item (deduped).');
            return;
        }
        lastAdvanceUuid = sourceUuid ?? null;
        lastAdvanceAt = Date.now();
    }

    const token = playToken;
    await advanceToNext(token, natural);
}

export type QualifiedAdvanceEvent = {
    currentUuid: string | null;
    playGeneration: number;
    takeId: string;
    rundownItemId: string;
    playbackInstanceId: string;
    trimRevision: number;
    reason: string;
    observedPositionMs?: number;
    expectedDurationMs?: number;
    emittedAtMonotonicMs?: number;
};

export function assertPlaybackIntent(intent: PlaybackIntent): void {
    if (
        intent.playGeneration !== playbackCoordinator.playGeneration ||
        intent.takeId !== playbackCoordinator.activeIntent?.takeId
    ) {
        throw new Error(
            `Blocked playback command without current intent (intent gen=${intent.playGeneration}, active gen=${playbackCoordinator.playGeneration})`
        );
    }
}

export async function requestAutoAdvance(event: QualifiedAdvanceEvent): Promise<boolean> {
    if (!isCasparPlaying.value) return false;

    const targetItemId = playbackCoordinator.evaluateAutoAdvance(
        {
            generation: event.playGeneration,
            takeId: event.takeId,
            playbackInstanceId: event.playbackInstanceId,
            itemId: event.rundownItemId,
        },
        useRundownStore().getPlayableItems() as any
    );

    if (!targetItemId) {
        invoke('push_diagnostic_log', {
            level: 'warn',
            scope: 'caspar-playout',
            message: `ADVANCE_REJECTED: Stale or unverified auto-advance event rejected (gen=${event.playGeneration}, item=${event.rundownItemId}, reason=${event.reason})`
        }).catch(() => {});
        return false;
    }

    const store = useRundownStore();
    const takeResult = playbackCoordinator.initiateTake(
        { targetItemId, rundownRevision: (store as any).rundownRevision || 0, source: 'auto' },
        store.getPlayableItems() as any
    );

    if (!takeResult) {
        return false;
    }

    invoke('push_diagnostic_log', {
        level: 'info',
        scope: 'caspar-playout',
        message: `ADVANCE_ACCEPTED: Auto-advance to item ${targetItemId} initiated (gen=${takeResult.intent.playGeneration}, takeId=${takeResult.intent.takeId}, reason=${event.reason})`
    }).catch(() => {});

    const item = store.getPlayableItems().find((i: any) => i.id === targetItemId);
    if (!item) return false;

    return await playItemWithIntent(item as any, takeResult.intent);
}

export async function playItemWithIntent(
    item: PlayoutItem,
    intent: PlaybackIntent,
    requestToken: number = playToken
): Promise<boolean> {
    assertPlaybackIntent(intent);
    if (requestToken !== playToken) return false;
    const store = useRundownStore();
    manualTakeFailure.value = null;

    try {
        if (item.ingestorStatus === 'error') {
            throw new Error(`Cannot play item "${item.filename}" because it has an error status.`);
        }

        const key = queueKey(item);
        currentKey = key;

        let queueIndex = queuedItems.findIndex((it) => queueKey(it) === key);
        if (queueIndex === -1) {
            const fresh = store.getPlayableItems() as unknown as PlayoutItem[];
            if (fresh.some((it) => it.id === key)) {
                queuedItems = fresh.map((i: any) => ({ ...i }));
                queueIndex = queuedItems.findIndex((it) => queueKey(it) === key);
            }
        }

        if (isLiveActive.value) {
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live}`);
            if (requestToken !== playToken) return false;
            isLiveActive.value = false;
        }

        const hydrated = hydratePlayoutItem(item);
        updateDisplayedTime(0);
        currentCasparDurationMs.value = 0;
        store.stopPlaybackProgressTimer();

        const nextQueueItem = queueIndex !== -1 ? queuedItems[queueIndex + 1] : null;
        let nextPath: string | null = null;
        if (nextQueueItem && nextQueueItem.type === 'video') {
            const nextRawPath = nextQueueItem.path || nextQueueItem.shortPath || '';
            if (nextRawPath) {
                try {
                    nextPath = (await invoke<string>('prepare_caspar_media_path', {
                        path: nextRawPath,
                        mediaRoot: getSettingsSnapshot().localMediaPath || ''
                    })).replace(/\\/g, '/').replace(/"/g, '');
                } catch (e) {
                    nextPath = nextRawPath.replace(/\\/g, '/').replace(/"/g, '');
                }
            }
        }

        assertPlaybackIntent(intent);
        if (requestToken !== playToken) return false;

        const dispatchResult = await dispatchPlay(
            hydrated,
            PROGRAM_CHANNEL,
            CASPAR_LAYERS.video,
            nextPath,
            0,
            () => requestToken !== playToken
                || intent.playGeneration !== playbackCoordinator.playGeneration
                || intent.takeId !== playbackCoordinator.activeIntent?.takeId,
            {
                playGeneration: intent.playGeneration,
                takeId: intent.takeId,
                rundownItemId: intent.targetItemId,
                trimRevision: intent.rundownRevisionAtIntent
            }
        );

        if (
            dispatchResult === null
            || requestToken !== playToken
            || intent.playGeneration !== playbackCoordinator.playGeneration
        ) return false;

        const confirmed = playbackCoordinator.confirmTake(
            intent.takeId,
            intent.playGeneration,
            PROGRAM_CHANNEL,
            CASPAR_LAYERS.video,
            store.getPlayableItems() as any
        );

        if (!confirmed) return false;

        isCasparPlaying.value = true;
        currentCasparDurationMs.value = dispatchResult.durationMs;
        const progressStartTime = Date.now();
        registerPlayStart(hydrated.id, dispatchResult.durationMs);
        store.startPlaybackProgressTimer(hydrated.id, dispatchResult.durationMs, progressStartTime);
        updateDisplayedTime(0);

        onAdvanceCallback?.(key);
        if (!await applyComplianceForPlayback(item, requestToken)) return false;

        if (queueIndex !== -1 && requestToken === playToken) {
            await preloadNextItemAt(queueIndex + 1, requestToken);
        }

        return true;
    } catch (error: any) {
        console.error('[CasparCG] playItemWithIntent error', error);
        const failure = classifyPlayoutFailure(error);
        if (shouldFlagItemFailure(failure)) {
            store.updateItem(item.id, { ingestorStatus: 'error' });
        }
        invoke('push_diagnostic_log', {
            level: 'error',
            scope: 'caspar-playout',
            message: `Playout intent ${intent.takeId} ${failure.kind} failure for ${item.filename}: ${failure.message}`
        }).catch(() => {});
        return false;
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

    async play(items, startIndex, resumeSeekMs = 0) {
        // Synchronously take control BEFORE any await: bump the play token at
        // the top so an in-flight take()/advance cannot clobber this play
        // request, and open the advance dedup window for a fresh run
        // (plan §1.4).
        playToken += 1;
        invalidatePreloads();
        activeGuard.clear();
        lastAdvanceUuid = null;
        lastAdvanceAt = 0;
        wasPlayingOnDisconnect = false;
        if (resumeEvalTimer) clearTimeout(resumeEvalTimer);
        resumeEvalTimer = null;

        // Crash-resume seek offset, consumed by playItemAt's dispatch.
        pendingResumeSeekMs = resumeSeekMs > 0 ? Math.round(resumeSeekMs) : 0;

        // Claim the new current item SYNCHRONOUSLY, before any await. The
        // stale-advance guard in the `caspar://advance` listener drops events
        // whose uuid does not match `currentKey`; if we left the OLD key in
        // place across the connect()/ensureFeedbackListener() awaits (and the
        // duration-resolution window inside playItemAt), the previous clip's
        // EOF advance could fire during the dispatch, advance from the OLD
        // item's position and clobber this manual play with the old item's
        // successor ("plays a file above the running one → skips to next").
        currentKey = startIndex >= 0 && startIndex < items.length
            ? queueKey(items[startIndex]!)
            : null;

        await ensureFeedbackListener();
        if (!isCasparConnected.value) {
            await this.connect();
        }

        queuedItems = items.map((i: any) => ({ ...i }));
        playStartTime.value = Date.now();
        playStartIndex.value = startIndex;

        if (startIndex < 0 || startIndex >= queuedItems.length) {
            await this.stop();
            return;
        }

        await playItemAt(startIndex, playToken, true);
    },

    async pause() {
        if (!isCasparConnected.value) return;
        await sendRawCommand(`PAUSE ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.video}`);
        isCasparPlaying.value = false;
        // Tell Rust to suppress the watchdog/EOF advance while paused.
        await invoke('caspar_set_playback_paused', { paused: true }).catch(() => {});
        const snapshot = loadPlaybackState();
        if (snapshot) {
            savePlaybackState(snapshot.uuid, Date.now() - currentCasparMs.value, snapshot.durationMs, {
                itemId: snapshot.itemId,
                playlistId: snapshot.playlistId,
                path: snapshot.path,
                trimInMs: snapshot.trimInMs,
                trimOutMs: snapshot.trimOutMs,
                positionMs: currentCasparMs.value,
                updatedAt: Date.now(),
                paused: true,
                channelOutputRateHz: snapshot.channelOutputRateHz,
            });
        }
    },

    async stop() {
        playToken += 1;
        invalidatePreloads();
        activeGuard.clear();
        playbackCoordinator.stop('operator stop');
        isCasparPlaying.value = false;
        isLiveActive.value = false;
        currentCasparDurationMs.value = 0;
        currentKey = null;
        updateDisplayedTime(0);
        timelineTimers.forEach(clearTimeout);
        timelineTimers = [];
        pendingResumeSeekMs = 0;
        wasPlayingOnDisconnect = false;
        if (resumeEvalTimer) clearTimeout(resumeEvalTimer);
        resumeEvalTimer = null;
        if (isCasparConnected.value) {
            // Targeted clears first (clean logging)
            await this.clearCompliance?.();
            await this.clearOverlays?.();
            const settings = getSettingsSnapshot();
            if (settings.cg?.stationIdEnabled === false) {
                await this.clearBranding?.();
            }
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.video}`);
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live}`);
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

        // Layer 10 has only one background producer. Replacing it with an
        // arbitrary CUE while a clip is on-air silently disarms the scheduled
        // LOADBG ... AUTO and can put the wrong item to air at EOF. On-air cue
        // is therefore allowed only for the actual UUID successor, which is
        // re-armed as AUTO; cueing any other item belongs to an off-air/preview
        // workflow and is rejected rather than compromising programme output.
        if (isCasparPlaying.value && currentKey) {
            const currentIndex = queuedItems.findIndex((queued) => queueKey(queued) === currentKey);
            const scheduledNext = currentIndex >= 0 ? queuedItems[currentIndex + 1] : null;
            if (!scheduledNext || queueKey(scheduledNext) !== queueKey(item)) {
                throw new Error('Cannot cue a non-next item while programme is on air: it would replace the protected AUTO background.');
            }

            invalidatePreloads();
            const token = playToken;
            const epoch = preloadGeneration;
            const hydrated = hydratePlayoutItem(item);
            const result = await dispatchLoadbg(
                hydrated,
                PROGRAM_CHANNEL,
                CASPAR_LAYERS.video,
                true,
                () => token !== playToken || epoch !== preloadGeneration
            );
            if (result !== null && token === playToken && epoch === preloadGeneration) {
                preloadedKeys.add(queueKey(item));
                preloadedFingerprints.set(queueKey(item), {
                    trimInMs: hydrated.trim_in_ms,
                    trimOutMs: hydrated.trim_out_ms,
                    path: hydrated.path
                });
            }
            return;
        }

        const hydrated = hydratePlayoutItem(item);
        await dispatchLoadbg(hydrated, PROGRAM_CHANNEL, CASPAR_LAYERS.video, false);
        updateDisplayedTime(0);
    },

    async take() {
        lastAdvanceUuid = null;
        lastAdvanceAt = 0;
        playStartTime.value = Date.now();
        pendingResumeSeekMs = 0;
        wasPlayingOnDisconnect = false;
        if (resumeEvalTimer) clearTimeout(resumeEvalTimer);
        resumeEvalTimer = null;

        // Claim both the queue identity and the local cancellation generation
        // before the first await. Connecting can take seconds; an EOF event
        // from the previous item in that window must be unable to advance the
        // newly requested take's successor.
        const store = useRundownStore();
        const item = store.selectedItem;
        if (!item) return;

        const takeResult = playbackCoordinator.initiateTake(
            { targetItemId: item.id, rundownRevision: (store as any).rundownRevision || 0, source: 'manual' },
            store.getPlayableItems() as any
        );

        if (!takeResult) {
            const errorMsg = `Cannot take item "${item.filename}": PlaybackCoordinator rejected take intent.`;
            manualTakeFailure.value = { itemId: item.id, filename: item.filename, message: errorMsg };
            throw new Error(errorMsg);
        }

        currentKey = queueKey(item);
        manualTakeFailure.value = null;
        playToken += 1;
        const takeToken = playToken;
        invalidatePreloads();
        activeGuard.clear();

        if (!isCasparConnected.value) {
            await this.connect();
        }
        if (takeToken !== playToken) return;

        await playItemWithIntent(item as any, takeResult.intent, takeToken);
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
            throw new Error('No CasparCG live source configured. Set a DeckLink Input Device or Live Route in Settings.');
        }
        await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live}`);
        await sendRawCommand(liveCommand);
        isLiveActive.value = true;
        isCasparPlaying.value = true;
        updateDisplayedTime(0);
    },

    async returnFromLive() {
        if (isCasparConnected.value) {
            await sendRawCommand(`CLEAR ${PROGRAM_CHANNEL}-${CASPAR_LAYERS.live}`);
        }
        isLiveActive.value = false;
    },

    async refreshQueue(items) {
        // Identity-keyed: the current item is tracked by `currentKey`, so a
        // reordered/replaced queue is re-resolved on the next advance without any
        // index remapping. This is the §A desync fix.
        queuedItems = items.map((i: any) => ({ ...i }));

        // A queued AUTO background belongs to the prior queue topology. Keep
        // the foreground token intact (the on-air clip must continue), but
        // replace an obsolete background with the new UUID-successor. Without
        // this an operator who moves or deletes the next row can see CasparCG
        // auto-take the old background while the frontend advances to the
        // edited queue.
        if (!isCasparPlaying.value || !currentKey) {
            invalidatePreloads();
            return;
        }

        const currentIndex = queuedItems.findIndex((item) => queueKey(item) === currentKey);
        if (currentIndex < 0) {
            // The on-air UUID was removed from the playable queue. Do not
            // guess a new current index or issue a hard command; the next EOF
            // transition will stop safely rather than wrapping to row zero.
            invalidatePreloads();
            return;
        }

        const nextItem = queuedItems[currentIndex + 1];
        if (!nextItem || nextItem.type !== 'video') {
            invalidatePreloads();
            return;
        }
        const nextKey = queueKey(nextItem);
        const liveNextItem = findLiveItemById(nextKey) ?? nextItem;

        // A queue update unrelated to the immediate successor must not throw
        // away a valid, already-armed AUTO background. Doing so close to EOF
        // would force a fallback PLAY and restart the correctly transitioned
        // item from frame zero.
        if (preloadedKeys.has(nextKey) && preloadMatchesItem(nextKey, liveNextItem)) return;

        invalidatePreloads();
        const token = playToken;
        const epoch = preloadGeneration;
        void preloadNextItemAt(currentIndex + 1, token, 6, 250, epoch).catch((error) => {
            console.warn('[CasparCG] Failed to re-arm AUTO preload after rundown edit', error);
        });
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

    /// Removed no-op stub. When live-input scene routing is needed, implement
    /// AMCP routing for the live input layer (20) here.

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
            const cleanPath = logoPath.replace(/\\/g, '/').replace(/"/g, '');
            const pathWithoutExt = cleanPath.replace(/\.[^/.]+$/, '');

            let playSuccess = false;
            for (let attempt = 1; attempt <= 3 && !playSuccess; attempt++) {
                try {
                    await invoke('caspar_play_image', {
                        channel: PROGRAM_CHANNEL,
                        layer: logoLayer,
                        path: cleanPath
                    });
                    playSuccess = true;
                } catch (err1) {
                    try {
                        await invoke('caspar_play_image', {
                            channel: PROGRAM_CHANNEL,
                            layer: logoLayer,
                            path: pathWithoutExt
                        });
                        playSuccess = true;
                    } catch (err2) {
                        if (attempt < 3) {
                            console.info(`[CasparCG] Station logo not ready in media scanner (attempt ${attempt}/3). Triggering CLS rescan...`);
                            await sendRawCommandCore('CLS').catch(() => {});
                            await wait(300 * attempt);
                        } else {
                            console.warn('[CasparCG] Failed to play station logo after retries and CLS rescan:', err2);
                        }
                    }
                }
            }

            if (playSuccess) {
                const opacity = 0.8; // Defaults strictly to 80% opacity
                const lx = (settings.cgStationLogoPos?.left ?? 5) / 100;
                const ly = (settings.cgStationLogoPos?.top ?? 5) / 100;
                const lw = (settings.cgStationLogoPos?.width ?? 12) / 100;
                const lh = (settings.cgStationLogoPos?.height ?? 12) / 100;

                await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${logoLayer} FILL ${lx.toFixed(4)} ${ly.toFixed(4)} ${lw.toFixed(4)} ${lh.toFixed(4)}`);
                await sendRawCommand(`MIXER ${PROGRAM_CHANNEL}-${logoLayer} OPACITY ${opacity.toFixed(3)}`);
            }
        } else {
            await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: logoLayer }).catch(() => {});
        }
    },

    handleProcessStateEvent(status: CasparProcessStatus) {
        if (status.state === 'crashed' || status.state === 'starting') {
            if (isCasparPlaying.value && currentKey != null) {
                wasPlayingOnDisconnect = true;
                const item = findLiveItemById(currentKey);
                if (item) {
                    savePlaybackState(currentKey, Date.now() - currentCasparMs.value, currentCasparDurationMs.value, {
                        itemId: item.id,
                        path: item.path,
                        trimInMs: (item as any)?.trim_in_ms,
                        trimOutMs: (item as any)?.trim_out_ms,
                        positionMs: currentCasparMs.value,
                        updatedAt: Date.now(),
                        channelOutputRateHz: getSettingsSnapshot().playoutProfile === 'PAL_1080P25' ? 25 : 50,
                    });
                }
            }
            lastOscTickAtMs = 0;
            markDisconnected(`Process supervisor reported CasparCG ${status.state}`);
        } else if (status.state === 'operational') {
            console.info('[CasparCG] Process supervisor reported CasparCG is operational. Reconnecting...');
            reconnectRequested = true;
            runReconnectAttempt(true).then(() => {
                scheduleResumeEvaluation(true);
            }).catch((err) => {
                console.warn('[CasparCG] Reconnect after process startup failed:', err);
            });
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

        const renderMode = settings.complianceRenderMode || 'html5';

        if (renderMode === 'legacy_png') {
            // Legacy Static PNG Image Mode (Layer 31 & Layer 34)
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

            // TP badge (image producer)
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

            // In legacy mode, Layer 32 HTML5 template is cleared
            await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: CASPAR_LAYERS.explanation }).catch(() => {});
        } else {
            // SOTA HTML5 Vector Graphics Mode (Layer 32 advisory.html with 30s banner and continuous stencil badge)
            // Ensure Layer 31 and Layer 34 PNG layers are completely cleared so no legacy PNGs ever display
            await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: ratingLayer }).catch(() => {});
            await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: tpLayer }).catch(() => {});

            // Unified Greek NCRTV Rating Badge & 30s Advisory Banner (HTML5 CG Template, layer 32).
            if (rating !== 'none' || tpFlag) {
                let template = settings.cgExplanationTemplate || 'playout/advisory';
                if (!template || template === 'testdada') {
                    template = 'playout/advisory';
                }
                const advisoryText = item.complianceText || '';
                const isLogoOnly = advisoryText === '__LOGO_ONLY__' || advisoryText === 'LOGO_ONLY';
                let descriptors = item.complianceDescriptors || [];
                if ((!descriptors || descriptors.length === 0) && advisoryText && !isLogoOnly) {
                    descriptors = parseDescriptorsFromText(advisoryText);
                }

                const ratingExplanationText = isLogoOnly ? '' : getGreekRatingDefaultText(rating as any);
                const ratingHoldSec = settings.cgAdvisoryConfig?.ratingHoldSec ?? 30;
                const warningHoldSec = settings.cgAdvisoryConfig?.warningHoldSec ?? 30;

                // Load custom SVGs if specified in Settings (swappable without code changes)
                let customLogoSvg: string | null = null;
                const customLogos: Record<string, string> = {};

                const logoSvgPath = settings.cgAdvisoryConfig?.customLogoSvgPath;
                if (logoSvgPath) {
                    try {
                        customLogoSvg = await invoke<string>('read_svg_file', { path: logoSvgPath });
                    } catch (err) {
                        console.warn('[CasparCG] Failed to load custom logo SVG from:', logoSvgPath, err);
                    }
                }

                const ratingSvgPaths = settings.cgAdvisoryConfig?.customRatingSvgPaths;
                if (ratingSvgPaths && typeof ratingSvgPaths === 'object') {
                    for (const [key, p] of Object.entries(ratingSvgPaths)) {
                        if (p) {
                            try {
                                const svgContent = await invoke<string>('read_svg_file', { path: p });
                                customLogos[key.toUpperCase()] = svgContent;
                            } catch (err) {
                                console.warn(`[CasparCG] Failed to load custom rating SVG for ${key} from:`, p, err);
                            }
                        }
                    }
                }

                const cgData = {
                    rating: rating !== 'none' ? rating : 'none',
                    rating_text: isLogoOnly ? '__LOGO_ONLY__' : ratingExplanationText,
                    warning_text: isLogoOnly ? '' : advisoryText,
                    text: isLogoOnly ? '' : ratingExplanationText,
                    custom_text: isLogoOnly ? '__LOGO_ONLY__' : ratingExplanationText,
                    explanation: !isLogoOnly,
                    show_explanation: !isLogoOnly,
                    warnings: descriptors,
                    durationSec: ratingHoldSec,
                    hold_time: ratingHoldSec,
                    warning_hold_time: warningHoldSec,
                    repeatIntervalSec: 600,
                    tp: tpFlag,
                    styling: settings.cgAdvisoryConfig,
                    customLogoSvg: customLogoSvg || undefined,
                    customLogos: Object.keys(customLogos).length > 0 ? customLogos : undefined
                };

                // Clear layer 32 first so previous instance is completely removed, then add fresh with full payload
                await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: CASPAR_LAYERS.explanation }).catch(() => {});

                await invoke('caspar_cg_add', {
                    channel: PROGRAM_CHANNEL,
                    layer: CASPAR_LAYERS.explanation,
                    template,
                    play: true,
                    data: cgData
                }).catch((e: any) => {
                    console.warn('[CasparCG] Failed to add unified advisory CG', e);
                });
            } else {
                await invoke('caspar_clear_layer', { channel: PROGRAM_CHANNEL, layer: CASPAR_LAYERS.explanation }).catch(() => {});
            }
        }
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

// Automatically bind process supervisor lifecycle to playout engine
onCasparProcessStateChange((status) => {
    casparPlayoutService.handleProcessStateEvent?.(status);
});
