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

/** Clamp a requested trim-in point to the nearest safe frame for this asset. */
export function clampTrimIn(requestedMs: number, geo: FrameGeometry): number {
  if (!geo.mezzanineOk) return requestedMs; // legacy asset, no guarantees
  const safe = Math.max(requestedMs, geo.keyframeSafeStartMs);
  const frame = msToFrame(safe, geo.fps);
  return frameToMs(frame, geo.fps);
}

export function clampTrimOut(requestedMs: number, geo: FrameGeometry): number {
  const frame = msToFrame(requestedMs, geo.fps);
  const clampedFrame = Math.min(frame, geo.totalFrames);
  return frameToMs(clampedFrame, geo.fps);
}
