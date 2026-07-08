import { invoke } from '@tauri-apps/api/core';
import type { RundownItem } from './rundownHydrator';
import { useSettingsStore } from '../stores/settings';

export interface FrameTrimResult {
    in_frame: number;
    out_frame: number;
    duration_frames: number;
    fps_rational: string;
}

export interface PlaybackReadiness {
    ready: boolean;
    fileExists: boolean;
    hasDbEntry: boolean;
    hasSidecar: boolean;
    qcPassed: boolean;
    mezzanineOk: boolean;
    warnings: string[];
    durationMs: number;
    fpsNum: number;
    fpsDen: number;
    error: string;
}

function parseFpsRational(rational: string): number | null {
    const parts = rational.split('/');
    if (parts.length !== 2) return null;
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
    return num / den;
}

/**
 * Pre-flight playback readiness check. Verifies file existence, DB metadata
 * availability, and QC status before attempting to play.
 * If the DB has no entry but a transcoder sidecar exists, the sidecar metadata
 * is upserted into the DB so compute_frame_trim succeeds.
 */
async function verifyPlaybackReady(path: string): Promise<PlaybackReadiness> {
    try {
        return await invoke<PlaybackReadiness>('verify_playback_ready', { path });
    } catch (e) {
        console.warn('[playoutDispatch] verify_playback_ready failed, continuing:', e);
        return {
            ready: true,
            fileExists: true,
            hasDbEntry: true,
            hasSidecar: false,
            qcPassed: true,
            mezzanineOk: true,
            warnings: [],
            durationMs: 0,
            fpsNum: 0,
            fpsDen: 0,
            error: '',
        };
    }
}

/// CasparCG channel output rate in fields/sec. The channel is configured as
/// `1080i5000` (1080 interlaced, 50.000 fields/sec). CasparCG's AMCP protocol
/// interprets SEEK and LENGTH values in units of the **channel output rate**,
/// not the source file's frame rate.
///
/// For a 25fps progressive file on a 1080i50 channel, each source frame
/// produces 2 output fields. So `LENGTH 836` (file frames) is interpreted by
/// CasparCG as 836 fields = 16.72s — exactly **half** the real 33.44s duration.
/// This was the root cause of clips freezing at the midpoint: the producer
/// hit the LENGTH limit at half the file, froze on the last frame, and the
/// position-based advance never fired because the OSC position (16,720ms) was
/// far below the watchdog's expected out point (33,440ms).
///
/// The fix: multiply file-frame values by `channelOutputRate / fileFps` before
/// sending them as AMCP SEEK/LENGTH. For 25fps → multiplier 2, for 50fps →
/// multiplier 1. The watchdog duration (`computeDurationMsFromTrim`) stays in
/// real time (file frames / file fps) and is unaffected.
const CHANNEL_OUTPUT_RATE_HZ = 50;

function computeFieldMultiplier(fileFps: number): number {
    return Math.max(1, Math.round(CHANNEL_OUTPUT_RATE_HZ / fileFps));
}

/**
 * Compute the precise content duration in ms from a frame-accurate trim result.
 * Uses the authoritative `fps_rational` returned by the Rust trimmer (sourced
 * from the asset DB) rather than the item's possibly-unresolved
 * `fps_num`/`fps_den`, and guards against invalid/zero/NaN results so the
 * watchdog deadline can never be armed with garbage. Throws on a degenerate
 * result so the caller skips the item instead of registering a frozen state.
 */
export function computeDurationMsFromTrim(trim: FrameTrimResult, itemId: string): number {
    const fps = parseFpsRational(trim.fps_rational) ?? 25;
    const durationMs = Math.round((trim.duration_frames / fps) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error(
            `Invalid durationMs for item ${itemId}: duration_frames=${trim.duration_frames}, fps_rational=${trim.fps_rational}`
        );
    }
    return durationMs;
}

/**
 * Prepares the path to be relative to the CasparCG media folder.
 */
async function preparePath(clientPath: string): Promise<string> {
    const settings = useSettingsStore();
    try {
        const prepared = await invoke<string>('prepare_caspar_media_path', {
            path: clientPath,
            mediaRoot: settings.localMediaPath || ''
        });
        return prepared.replace(/\\/g, '/').replace(/"/g, '');
    } catch (e) {
        console.warn('[playoutDispatch] Failed to prepare path via invoke, using local fallback:', e);
        let p = clientPath.replace(/\\/g, '/');
        const mediaRoot = (settings.localMediaPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (mediaRoot) {
            // Strip Windows verbatim prefix from both for comparison
            const pClean = p.replace(/^\/\/\?\//, '');
            const rootClean = mediaRoot.replace(/^\/\/\?\//, '');
            const pLower = pClean.toLowerCase();
            const rootLower = rootClean.toLowerCase();
            if (pLower.startsWith(rootLower)) {
                p = pClean.substring(rootClean.length).replace(/^\/+/, '');
            } else {
                const rootParts = rootClean.split('/');
                const rootBaseName = (rootParts[rootParts.length - 1] || '').toLowerCase();
                const pParts = pClean.split('/');
                const rootIdx = pParts.findIndex(s => s.toLowerCase() === rootBaseName);
                if (rootIdx >= 0) {
                    p = pParts.slice(rootIdx + 1).join('/');
                } else if (!pClean.includes(':') && !pClean.startsWith('/')) {
                    // Already a relative path — return as-is
                    p = pClean;
                }
                // else: return the full path. Do NOT strip to just the filename
                // — that caused CasparCG 404 errors for files in media/videos/.
            }
        }
        return p.replace(/"/g, '');
    }
}

export async function dispatchPlay(
    item: RundownItem,
    channel: number,
    layer: number,
    nextPath: string | null = null
): Promise<{ durationMs: number; expectedOutMs: number }> {
    // 0. Pre-flight: verify file exists, has metadata, and passed QC
    const readiness = await verifyPlaybackReady(item.path);
    if (!readiness.ready) {
        throw new Error(
            `Playback pre-flight check failed for "${item.path}": ${readiness.error}`
        );
    }

    // 1. compute_frame_trim and prepare path in parallel (they are independent)
    const [trim, formattedPath] = await Promise.all([
        invoke<FrameTrimResult>('compute_frame_trim', {
            path: item.path,
            trimInMs: item.trim_in_ms,
            trimOutMs: item.trim_out_ms
        }),
        preparePath(item.path)
    ]);

    // 2. Compute AMCP SEEK/LENGTH values. CasparCG interprets SEEK/LENGTH in
    // channel output units (fields on 1080i50 = 50Hz). `compute_frame_trim`
    // returns file-frame values, so we convert via the field multiplier.
    // For 25fps files: multiplier = 50/25 = 2 (each frame = 2 fields).
    // For 50fps files: multiplier = 50/50 = 1 (each frame = 1 field).
    // Without this, 25fps clips play at half duration and freeze at the
    // midpoint because CasparCG plays `LENGTH` fields, not `LENGTH` frames.
    const fileFps = parseFpsRational(trim.fps_rational) ?? 25;
    const fieldMultiplier = computeFieldMultiplier(fileFps);
    const seekFields = trim.in_frame * fieldMultiplier;
    const lengthFields = trim.duration_frames * fieldMultiplier;

    // 3. Calculate precise expected duration.
    // OSC position is relative to the trim start (the producer is SEEK'd to
    // in_frame), so expectedOutMs must be the content duration — NOT the
    // absolute trim_in_ms + durationMs. Using the absolute value sets the
    // advance threshold beyond the clip's end, so the position-based advance
    // never fires and the rundown freezes on any trimmed clip.
    const durationMs = computeDurationMsFromTrim(trim, item.id);
    const expectedOutMs = durationMs;

    // 4. Register playback with Rust backend BEFORE sending the PLAY command.
    // This prevents a race condition where the first OSC ticks from the new
    // file arrive while the Rust state machine still holds the previous
    // item's trim_in_ms and expected_out_point_ms. Without this, a manual
    // take on a trimmed subclip (absolute OSC pos ~367800ms) would be
    // normalized against the old trim_in_ms=0, producing position_ms=367800,
    // which exceeds the old expected_out_point_ms → instant advance → black.
    await invoke('caspar_register_playback', {
        uuid: item.id,
        durationMs,
        expectedOutPointMs: expectedOutMs,
        currentPath: formattedPath,
        nextPath,
        trimInMs: item.trim_in_ms || 0
    });

    // 5. Send PLAY command (state machine is already armed for this item)
    const cmd = `PLAY ${channel}-${layer} "${formattedPath}" SEEK ${seekFields} LENGTH ${lengthFields}`;
    await invoke('caspar_send_command', { cmd });

    return { durationMs, expectedOutMs };
}

export async function dispatchLoadbg(
    item: RundownItem,
    channel: number,
    layer: number,
    auto: boolean = true
): Promise<{ durationMs: number; expectedOutMs: number }> {
    // 0. Pre-flight: verify file exists and has metadata (skip QC for preload)
    const readiness = await verifyPlaybackReady(item.path);
    if (!readiness.fileExists) {
        throw new Error(`Preload pre-flight check failed — file not found: "${item.path}"`);
    }

    // 1. compute_frame_trim
    const trim = await invoke<FrameTrimResult>('compute_frame_trim', {
        path: item.path,
        trimInMs: item.trim_in_ms,
        trimOutMs: item.trim_out_ms
    });

    // 2. prepare path
    const formattedPath = await preparePath(item.path);

    // 3. Construct and send LOADBG command. Same field-rate conversion as
    // dispatchPlay — CasparCG interprets SEEK/LENGTH in channel output fields.
    // `auto=true` (default, used by the rundown preload path) appends AUTO so
    // CasparCG auto-transitions when the current producer ends. `auto=false`
    // (used by manual cue()) loads the clip into the background without
    // scheduling an auto-transition.
    const fileFps = parseFpsRational(trim.fps_rational) ?? 25;
    const fieldMultiplier = computeFieldMultiplier(fileFps);
    const seekFields = trim.in_frame * fieldMultiplier;
    const lengthFields = trim.duration_frames * fieldMultiplier;
    const autoSuffix = auto ? ' AUTO' : '';
    const cmd = `LOADBG ${channel}-${layer} "${formattedPath}" SEEK ${seekFields} LENGTH ${lengthFields}${autoSuffix}`;
    await invoke('caspar_send_command', { cmd });

    // 4. Calculate duration and expected out point (relative to trim start).
    const durationMs = computeDurationMsFromTrim(trim, item.id);
    const expectedOutMs = durationMs;

    return { durationMs, expectedOutMs };
}
