export function msToFrame(ms, fps) {
    return Math.round((ms / 1000) * fps);
}
export function frameToMs(frame, fps) {
    return Math.round((frame / fps) * 1000);
}
/** Clamp a requested trim-in point to the nearest safe frame for this asset. */
export function clampTrimIn(requestedMs, geo) {
    if (!geo.mezzanineOk)
        return requestedMs; // legacy asset, no guarantees
    const safe = Math.max(requestedMs, geo.keyframeSafeStartMs);
    const frame = msToFrame(safe, geo.fps);
    return frameToMs(frame, geo.fps);
}
export function clampTrimOut(requestedMs, geo) {
    const frame = msToFrame(requestedMs, geo.fps);
    const clampedFrame = Math.min(frame, geo.totalFrames);
    return frameToMs(clampedFrame, geo.fps);
}
