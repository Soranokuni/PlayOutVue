export interface FrameGeometry {
  fps: number;
  totalFrames: number;
  gopFrames: number;
  keyframeSafeStartMs: number;
  mezzanineOk: boolean;
}

export function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

export function frameToMs(frame: number, fps: number): number {
  return Math.round((frame / fps) * 1000);
}

/**
 * Round a requested trim-in point to the nearest frame boundary.
 *
 * Audit F-2: this used to raise the IN point to `keyframe_safe_start_ms`
 * (`Math.max(requestedMs, geo.keyframeSafeStartMs)`). Two things made that
 * indefensible:
 *
 *  - the transcoder computes `keyframe_safe_start_ms` wrong — it drops the
 *    keyframe at pts 0 — so every mezzanine reports 2000 and every clip in the
 *    rundown lost its first two seconds on air;
 *  - even with a correct value, raising an IN point is not this function's
 *    job. CasparCG's FFmpeg producer seeks to the preceding keyframe and
 *    decodes forward, so a non-keyframe IN is frame-accurate anyway. Snapping
 *    a sub-clip's IN to a keyframe is the transcoder's decision, taken in
 *    `POST /subclip`, and it reports it back with a warning.
 *
 * `keyframeSafeStartMs` stays on `FrameGeometry` because the trim panel shows
 * it and the snap modes use it — it is just no longer a floor.
 */
export function clampTrimIn(requestedMs: number, geo: FrameGeometry): number {
  if (!geo.mezzanineOk) return requestedMs; // legacy asset, no guarantees
  const frame = msToFrame(Math.max(0, requestedMs), geo.fps);
  return frameToMs(frame, geo.fps);
}

export function clampTrimOut(requestedMs: number, geo: FrameGeometry): number {
  const frame = msToFrame(requestedMs, geo.fps);
  // `totalFrames` is only a cap when we actually know it. The batch/v1 resolve
  // paths do not always carry `total_frames`, and capping against 0 used to
  // collapse a valid OUT point to zero.
  const clampedFrame = geo.totalFrames > 0 ? Math.min(frame, geo.totalFrames) : frame;
  return frameToMs(clampedFrame, geo.fps);
}
