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
    // If it is 0, missing, or higher than the total file duration, set it equal to duration_ms.
    if (!raw.trim_out_ms || isNaN(trim_out_ms) || trim_out_ms === 0 || trim_out_ms > duration_ms) {
        trim_out_ms = duration_ms;
    }

    // If it is less than or equal to trim_in_ms, fallback to a safe default of trim_in_ms + 2000
    if (trim_out_ms <= trim_in_ms) {
        trim_out_ms = trim_in_ms + 2000;
    }

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
