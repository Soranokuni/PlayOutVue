// Pure AMCP SEEK/LENGTH computation and PLAY/LOADBG command builders.
//
// Kept free of imports and side effects so it can be unit-tested in isolation
// (vitest). CasparCG's AMCP protocol interprets SEEK and LENGTH in units of
// the CHANNEL OUTPUT RATE (fields on a 1080i50 channel), not the source
// file's frame rate, so file-frame values from `compute_frame_trim` must be
// multiplied by `channelOutputRate / fileFps` before being sent. For a 25fps
// file the multiplier is 2, for 50fps it is 1.

/**
 * Legacy fallback for installations that have not selected a channel profile.
 * CasparCG's SEEK/LENGTH units follow the channel output cadence, not a fixed
 * application-wide PAL value.
 */
export const DEFAULT_CHANNEL_OUTPUT_RATE_HZ = 50;

export function parseFpsRational(rational: string): number | null {
    const parts = rational.split('/');
    if (parts.length !== 2) return null;
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
    return num / den;
}

export function computeFieldMultiplier(fileFps: number, channelOutputRateHz = DEFAULT_CHANNEL_OUTPUT_RATE_HZ): number {
    const safeOutputRate = Number.isFinite(channelOutputRateHz) && channelOutputRateHz > 0
        ? channelOutputRateHz
        : DEFAULT_CHANNEL_OUTPUT_RATE_HZ;
    return Math.max(1, Math.round(safeOutputRate / fileFps));
}

export interface TrimInput {
    in_frame: number;
    out_frame: number;
    duration_frames: number;
    fps_rational: string;
}

export interface TrimCommandFields {
    fileFps: number;
    fieldMultiplier: number;
    seekFields: number;
    lengthFields: number;
    totalFileFields: number;
    hasInTrim: boolean;
    hasOutTrim: boolean;
}

/**
 * Convert a frame-accurate trim result into channel-output SEEK/LENGTH fields.
 * `resumeFrames` (file frames already played, from a crash-resume seek)
 * shifts the SEEK forward and shrinks LENGTH to the remaining window.
 *
 * Invariants:
 * - SEEK is only appended when it is non-zero AND strictly inside the file
 *   (a stale IN past EOF must never inject a bogus SEEK).
 * - LENGTH is only appended when the trim window is non-empty AND does not
 *   run past EOF.
 */
export function computeTrimFields(
    trim: TrimInput,
    resumeFrames = 0,
    channelOutputRateHz = DEFAULT_CHANNEL_OUTPUT_RATE_HZ
): TrimCommandFields {
    const fileFps = parseFpsRational(trim.fps_rational) ?? 25;
    const fieldMultiplier = computeFieldMultiplier(fileFps, channelOutputRateHz);

    const safeResumeFrames = Math.max(0, Math.min(resumeFrames, Math.max(0, trim.duration_frames - 1)));
    const inFrames = trim.in_frame + safeResumeFrames;
    const remainingFrames = Math.max(1, trim.duration_frames - safeResumeFrames);

    const seekFields = inFrames * fieldMultiplier;
    const lengthFields = remainingFrames * fieldMultiplier;
    const totalFileFields =
        (trim.out_frame > 0 ? trim.out_frame : trim.in_frame + trim.duration_frames) * fieldMultiplier;

    const hasInTrim = seekFields > 0 && seekFields < totalFileFields;
    // LENGTH is appended whenever the trimmed window is non-empty and does not
    // run past EOF. `FrameTrimResult` carries no separate physical total:
    // `totalFileFields` == the trimmed window end, so an out-only trim
    // (in=0, out<file) legitimately emits `LENGTH <out>` and an untrimmed clip
    // emits a harmless `LENGTH <full>`. The dangerous shape — a dropped SEEK
    // combined with a TRIMMED-length LENGTH — is prevented upstream by the
    // degenerate-trim guard (dispatchPlay/dispatchLoadbg throw before this
    // builder runs when a stale IN past EOF was clamped to frame 0).
    const hasOutTrim = lengthFields > 0 && seekFields + lengthFields <= totalFileFields;

    return { fileFps, fieldMultiplier, seekFields, lengthFields, totalFileFields, hasInTrim, hasOutTrim };
}

export function buildPlayCommand(
    channel: number,
    layer: number,
    path: string,
    fields: TrimCommandFields
): string {
    let cmd = `PLAY ${channel}-${layer} "${path}"`;
    if (fields.hasInTrim) cmd += ` SEEK ${fields.seekFields}`;
    if (fields.hasOutTrim) cmd += ` LENGTH ${fields.lengthFields}`;
    return cmd;
}

export function buildLoadbgCommand(
    channel: number,
    layer: number,
    path: string,
    fields: TrimCommandFields,
    auto = true
): string {
    let cmd = `LOADBG ${channel}-${layer} "${path}"`;
    if (fields.hasInTrim) cmd += ` SEEK ${fields.seekFields}`;
    if (fields.hasOutTrim) cmd += ` LENGTH ${fields.lengthFields}`;
    if (auto) cmd += ' AUTO';
    return cmd;
}
