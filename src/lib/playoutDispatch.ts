import { invoke } from '@tauri-apps/api/core';
import type { RundownItem } from './rundownHydrator';
import { useSettingsStore } from '../stores/settings';
import {
    parseFpsRational,
    computeTrimFields,
    buildPlayCommand,
    buildLoadbgCommand,
    type TrimCommandFields
} from './trimCommands';

export interface FrameTrimResult {
    in_frame: number;
    out_frame: number;
    duration_frames: number;
    fps_rational: string;
    start_frame_degenerate?: boolean;
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

function channelOutputRateHz(): number {
    const settings = useSettingsStore();
    // Keep the deployed 1080i50 behaviour as the fallback, while allowing a
    // progressive 25fps channel to use frame units rather than doubled fields.
    return settings.playoutProfile === 'PAL_1080P25' ? 25 : 50;
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
        // Failing open here can turn a backend/database outage into an
        // unvalidated PLAY. The caller classifies this as transient and holds
        // a manual take rather than marking the item bad or playing blindly.
        throw new Error(`Playback pre-flight unavailable for "${path}": ${String(e)}`);
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
    nextPath: string | null = null,
    resumeSeekMs: number = 0,
    isStale?: () => boolean,
    intent?: { playGeneration: number; takeId: string; rundownItemId?: string; trimRevision?: number }
): Promise<{ durationMs: number; expectedOutMs: number } | null> {
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

    if (trim.start_frame_degenerate) {
        throw new Error(
            `Degenerate trim for "${item.path}": in-point ${item.trim_in_ms}ms exceeds the file duration, ` +
            `so playback would start from frame 0. Adjust the trim or re-import the subclip.`
        );
    }

    // 2. Compute AMCP SEEK/LENGTH values. CasparCG interprets SEEK/LENGTH in
    // channel output units (fields on 1080i50 = 50Hz). `compute_frame_trim`
    // returns file-frame values, so we convert via the field multiplier.
    // For 25fps files: multiplier = 50/25 = 2 (each frame = 2 fields).
    // For 50fps files: multiplier = 50/50 = 1 (each frame = 1 field).
    // Without this, 25fps clips play at half duration and freeze at the
    // midpoint because CasparCG plays `LENGTH` fields, not `LENGTH` frames.
    // Crash-resume: `resumeSeekMs` is the elapsed content time (relative to the
    // trim start) at which playback should continue. Convert to file frames and
    // offset the SEEK past the trim IN point; shrink LENGTH to the remaining
    // frames so the watchdog/OSC advance fires exactly at the new end.
    const fileFps = parseFpsRational(trim.fps_rational) ?? 25;
    const resumeFrames = resumeSeekMs > 0 ? Math.round((resumeSeekMs / 1000) * fileFps) : 0;
    const fields = computeTrimFields(trim, resumeFrames, channelOutputRateHz());

    // 3. Calculate precise expected duration.
    // OSC position is relative to the trim start (the producer is SEEK'd to
    // in_frame), so expectedOutMs must be the content duration — NOT the
    // absolute trim_in_ms + durationMs. Using the absolute value sets the
    // advance threshold beyond the clip's end, so the position-based advance
    // never fires and the rundown freezes on any trimmed clip.
    // On resume, report the REMAINING duration (content duration minus the
    // seek offset) — the progress timer, end guard and watchdog all count
    // down from the resumed position.
    const remainingDurationMs = Math.max(1, Math.round((fields.lengthFields / fields.fieldMultiplier / fileFps) * 1000));
    const durationMs = resumeSeekMs > 0 ? remainingDurationMs : computeDurationMsFromTrim(trim, item.id);
    const expectedOutMs = durationMs;

    // 4. Register playback with Rust backend BEFORE sending the PLAY command.
    // This prevents a race condition where the first OSC ticks from the new
    // file arrive while the Rust state machine still holds the previous
    // item's trim_in_ms and expected_out_point_ms. Without this, a manual
    // take on a trimmed subclip (absolute OSC pos ~367800ms) would be
    // normalized against the old trim_in_ms=0, producing position_ms=367800,
    // which exceeds the old expected_out_point_ms → instant advance → black.
    // On resume the trim anchor shifts by the seek offset: the producer
    // reports the absolute file position (trimInMs + resumeSeekMs at the
    // start), so subtracting `trimInMs + resumeSeekMs` yields 0 — matching
    // the remaining-duration out point and the UI clock.
    //
    // Stale-guard: a take()/play() that bumped the play token while this
    // dispatch was awaiting (verify/trim/path IPC) must NOT emit any physical
    // command. Abort silently — the newer request owns the channel now.
    if (isStale?.()) return null;
    await invoke('caspar_register_playback', {
        uuid: item.id,
        durationMs,
        expectedOutPointMs: expectedOutMs,
        currentPath: formattedPath,
        nextPath,
        trimInMs: (item.trim_in_ms || 0) + (resumeSeekMs > 0 ? resumeSeekMs : 0),
        playGeneration: intent?.playGeneration,
        takeId: intent?.takeId,
        rundownItemId: intent?.rundownItemId || item.id,
        playbackInstanceId: undefined,
        trimRevision: intent?.trimRevision || 0,
        trimOutMs: item.trim_out_ms || (durationMs > 0 ? durationMs : undefined)
    });
    if (isStale?.()) {
        await invoke('caspar_clear_playback_if_uuid', { uuid: item.id }).catch(() => {});
        return null;
    }
    // clean PLAY runs the whole file.
    const cmd = buildPlayCommand(channel, layer, formattedPath, fields);
    await invoke('caspar_send_command', { cmd });

    return { durationMs, expectedOutMs };
}

export async function dispatchLoadbg(
    item: RundownItem,
    channel: number,
    layer: number,
    auto: boolean = true,
    isStale?: () => boolean
): Promise<{ durationMs: number; expectedOutMs: number } | null> {
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

    // Never silently preload a trimmed clip without its SEEK (the LOADBG
    // "LENGTH <full> AUTO" bug). Same guard as dispatchPlay.
    if ((item.trim_in_ms || 0) > 100 && trim.in_frame === 0) {
        throw new Error(
            `Degenerate trim for "${item.path}": in-point ${item.trim_in_ms}ms exceeds the file duration, ` +
            `so the preload would start from frame 0. Adjust the trim or re-import the subclip.`
        );
    }

    // 2. prepare path
    const formattedPath = await preparePath(item.path);

    // 3. Construct and send LOADBG command. Same field-rate conversion as
    // dispatchPlay — CasparCG interprets SEEK/LENGTH in channel output fields.
    // `auto=true` (default, used by the rundown preload path) appends AUTO so
    // CasparCG auto-transitions when the current producer ends. `auto=false`
    // (used by manual cue()) loads the clip into the background without
    // scheduling an auto-transition.
    const fields = computeTrimFields(trim, 0, channelOutputRateHz());
    // Stale-guard: an in-flight preload superseded by a take()/play() must not
    // land on the shared AMCP channel after the newer request (Bug B — rapid
    // PLAY/LOADBG cycles). The caller checks the token after dispatch too, but
    // that is too late: the command may already be on the wire.
    if (isStale?.()) return null;
    const cmd = buildLoadbgCommand(channel, layer, formattedPath, fields, auto);
    await invoke('caspar_send_command', { cmd });

    // 4. Calculate duration and expected out point (relative to trim start).
    const durationMs = computeDurationMsFromTrim(trim, item.id);
    const expectedOutMs = durationMs;

    return { durationMs, expectedOutMs };
}
