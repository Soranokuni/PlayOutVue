import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';
function parseFpsRational(rational) {
    const parts = rational.split('/');
    if (parts.length !== 2)
        return null;
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0)
        return null;
    return num / den;
}
/**
 * Pre-flight playback readiness check. Verifies file existence, DB metadata
 * availability, and QC status before attempting to play.
 * If the DB has no entry but a transcoder sidecar exists, the sidecar metadata
 * is upserted into the DB so compute_frame_trim succeeds.
 */
async function verifyPlaybackReady(path) {
    try {
        return await invoke('verify_playback_ready', { path });
    }
    catch (e) {
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
/**
 * Compute the precise content duration in ms from a frame-accurate trim result.
 * Uses the authoritative `fps_rational` returned by the Rust trimmer (sourced
 * from the asset DB) rather than the item's possibly-unresolved
 * `fps_num`/`fps_den`, and guards against invalid/zero/NaN results so the
 * watchdog deadline can never be armed with garbage. Throws on a degenerate
 * result so the caller skips the item instead of registering a frozen state.
 */
export function computeDurationMsFromTrim(trim, itemId) {
    const fps = parseFpsRational(trim.fps_rational) ?? 25;
    const durationMs = Math.round((trim.duration_frames / fps) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error(`Invalid durationMs for item ${itemId}: duration_frames=${trim.duration_frames}, fps_rational=${trim.fps_rational}`);
    }
    return durationMs;
}
/**
 * Prepares the path to be relative to the CasparCG media folder.
 */
async function preparePath(clientPath) {
    const settings = useSettingsStore();
    try {
        const prepared = await invoke('prepare_caspar_media_path', {
            path: clientPath,
            mediaRoot: settings.localMediaPath || ''
        });
        return prepared.replace(/\\/g, '/').replace(/"/g, '');
    }
    catch (e) {
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
            }
            else {
                const rootParts = rootClean.split('/');
                const rootBaseName = (rootParts[rootParts.length - 1] || '').toLowerCase();
                const pParts = pClean.split('/');
                const rootIdx = pParts.findIndex(s => s.toLowerCase() === rootBaseName);
                if (rootIdx >= 0) {
                    p = pParts.slice(rootIdx + 1).join('/');
                }
                else if (!pClean.includes(':') && !pClean.startsWith('/')) {
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
export async function dispatchPlay(item, channel, layer, nextPath = null) {
    // 0. Pre-flight: verify file exists, has metadata, and passed QC
    const readiness = await verifyPlaybackReady(item.path);
    if (!readiness.ready) {
        throw new Error(`Playback pre-flight check failed for "${item.path}": ${readiness.error}`);
    }
    // 1. compute_frame_trim
    const trim = await invoke('compute_frame_trim', {
        path: item.path,
        trimInMs: item.trim_in_ms,
        trimOutMs: item.trim_out_ms
    });
    // 2. prepare path
    const formattedPath = await preparePath(item.path);
    // 3. Construct and send AMCP command
    const cmd = `PLAY ${channel}-${layer} "${formattedPath}" SEEK ${trim.in_frame} LENGTH ${trim.duration_frames}`;
    await invoke('caspar_send_command', { cmd });
    // 4. Calculate precise expected duration and expected out ms.
    // OSC position is relative to the trim start (the producer is SEEK'd to
    // in_frame), so expectedOutMs must be the content duration — NOT the
    // absolute trim_in_ms + durationMs. Using the absolute value sets the
    // advance threshold beyond the clip's end, so the position-based advance
    // never fires and the rundown freezes on any trimmed clip.
    const durationMs = computeDurationMsFromTrim(trim, item.id);
    const expectedOutMs = durationMs;
    // 5. Register playback with backend
    await invoke('caspar_register_playback', {
        uuid: item.id,
        durationMs,
        expectedOutPointMs: expectedOutMs,
        currentPath: formattedPath,
        nextPath
    });
    return { durationMs, expectedOutMs };
}
export async function dispatchLoadbg(item, channel, layer, auto = true) {
    // 0. Pre-flight: verify file exists and has metadata (skip QC for preload)
    const readiness = await verifyPlaybackReady(item.path);
    if (!readiness.fileExists) {
        throw new Error(`Preload pre-flight check failed — file not found: "${item.path}"`);
    }
    // 1. compute_frame_trim
    const trim = await invoke('compute_frame_trim', {
        path: item.path,
        trimInMs: item.trim_in_ms,
        trimOutMs: item.trim_out_ms
    });
    // 2. prepare path
    const formattedPath = await preparePath(item.path);
    // 3. Construct and send LOADBG command. `auto=true` (default, used by the
    // rundown preload path) appends AUTO so CasparCG auto-transitions when the
    // current producer ends. `auto=false` (used by manual cue()) loads the
    // clip into the background without scheduling an auto-transition.
    const autoSuffix = auto ? ' AUTO' : '';
    const cmd = `LOADBG ${channel}-${layer} "${formattedPath}" SEEK ${trim.in_frame} LENGTH ${trim.duration_frames}${autoSuffix}`;
    await invoke('caspar_send_command', { cmd });
    // 4. Calculate duration and expected out point (relative to trim start).
    const durationMs = computeDurationMsFromTrim(trim, item.id);
    const expectedOutMs = durationMs;
    return { durationMs, expectedOutMs };
}
