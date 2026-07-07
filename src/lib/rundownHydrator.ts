export interface RundownItem {
    id: string;
    path: string;
    playoutvue_id: string;
    duration_ms: number;
    trim_in_ms: number;
    trim_out_ms: number;
    fps_num: number;
    fps_den: number;
    mezzanine_ok?: boolean;
}

/**
 * Reconstructs rational frame rate (fps_num, fps_den) from a floating point fps
 * if they are missing or zero.
 */
function resolveFpsRational(fpsVal: unknown, rawFpsNum?: unknown, rawFpsDen?: unknown): { fps_num: number; fps_den: number } {
    const num = Number(rawFpsNum ?? 0);
    const den = Number(rawFpsDen ?? 0);
    if (num > 0 && den > 0) {
        return { fps_num: num, fps_den: den };
    }

    const fps = Number(fpsVal ?? 25);
    if (isNaN(fps) || fps <= 0) {
        return { fps_num: 25, fps_den: 1 };
    }

    // Common standard video frame rates mapping
    if (Math.abs(fps - 29.97) < 0.05) {
        return { fps_num: 30000, fps_den: 1001 };
    }
    if (Math.abs(fps - 23.976) < 0.05) {
        return { fps_num: 24000, fps_den: 1001 };
    }
    if (Math.abs(fps - 59.94) < 0.05) {
        return { fps_num: 60000, fps_den: 1001 };
    }
    if (Math.abs(fps - 25) < 0.01) {
        return { fps_num: 25, fps_den: 1 };
    }
    if (Math.abs(fps - 50) < 0.01) {
        return { fps_num: 50, fps_den: 1 };
    }
    if (Math.abs(fps - 30) < 0.01) {
        return { fps_num: 30, fps_den: 1 };
    }
    if (Math.abs(fps - 60) < 0.01) {
        return { fps_num: 60, fps_den: 1 };
    }
    if (Math.abs(fps - 24) < 0.01) {
        return { fps_num: 24, fps_den: 1 };
    }

    if (Number.isInteger(fps)) {
        return { fps_num: fps, fps_den: 1 };
    }

    // Dynamic approximation for custom rates
    return { fps_num: Math.round(fps * 1000), fps_den: 1000 };
}

export function hydrateItem(raw: Record<string, unknown>): RundownItem {
    const id = String(raw.id ?? raw.playoutvue_id ?? '');
    const path = String(raw.path ?? '');
    const playoutvue_id = String(raw.playoutvue_id ?? raw.id ?? '');
    const duration_ms = Number(raw.duration_ms ?? 0);
    const trim_in_ms = Number(raw.trim_in_ms ?? 0);
    let trim_out_ms = Number(raw.trim_out_ms ?? 0);

    const { fps_num, fps_den } = resolveFpsRational(raw.fps, raw.fps_num, raw.fps_den);
    const mezzanine_ok = raw.mezzanine_ok !== undefined ? Boolean(raw.mezzanine_ok) : undefined;

    // Strict Invariant logic:
    // trim_out_ms must ALWAYS represent an absolute timestamp from the file start.
    // 0 is a sentinel: compute_frame_trim (Rust) treats trim_out_ms<=0 as "use
    // the file's total duration from the asset DB", which is the correct
    // behavior when duration_ms is not yet resolved. Do NOT fabricate a fake
    // +2000ms duration here - that created a 2-second phantom clip whenever an
    // item was hydrated before the ingestor resolved its duration, which then
    // played wrong / appeared to skip.
    if (isNaN(trim_out_ms)) {
        trim_out_ms = 0;
    }
    if (duration_ms > 0) {
        // Duration is known: clamp trim_out_ms into (trim_in_ms, duration_ms].
        if (trim_out_ms === 0 || trim_out_ms > duration_ms) {
            trim_out_ms = duration_ms;
        }
        if (trim_out_ms <= trim_in_ms) {
            // Degenerate trim: clamp to file end. compute_frame_trim has its
            // own (in_ms + 2000).min(total_dur) fallback on the Rust side too.
            trim_out_ms = duration_ms;
        }
    }
    // else (duration_ms <= 0): leave trim_out_ms as 0 (sentinel) so
    // compute_frame_trim resolves the real total duration from the DB.

    return {
        id,
        path,
        playoutvue_id,
        duration_ms,
        trim_in_ms,
        trim_out_ms,
        fps_num,
        fps_den,
        mezzanine_ok
    };
}
