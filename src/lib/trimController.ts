export interface FpsRational {
  num: number;
  den: number;
}

export interface TrimDraft {
  inMs: number;
  outMs: number;
  totalDurationMs: number;
  fps: FpsRational;
}

export type TrimValidationResult =
  | { valid: true; errors: [] }
  | { valid: false; errors: string[] };

export function parseRationalFps(fpsNum?: number, fpsDen?: number, floatFps?: number): FpsRational {
  if (fpsNum && fpsNum > 0 && fpsDen && fpsDen > 0) {
    return { num: fpsNum, den: fpsDen };
  }
  if (floatFps && floatFps > 0) {
    // Standard broadcast snapping for common float approximations
    if (Math.abs(floatFps - 29.97) < 0.05) return { num: 30000, den: 1001 };
    if (Math.abs(floatFps - 59.94) < 0.05) return { num: 60000, den: 1001 };
    if (Math.abs(floatFps - 23.976) < 0.05) return { num: 24000, den: 1001 };
    if (Math.abs(floatFps - 25) < 0.05) return { num: 25, den: 1 };
    if (Math.abs(floatFps - 50) < 0.05) return { num: 50, den: 1 };
    if (Math.abs(floatFps - 30) < 0.05) return { num: 30, den: 1 };
    if (Math.abs(floatFps - 60) < 0.05) return { num: 60, den: 1 };
  }
  return { num: 25, den: 1 };
}

export function msToFrame(ms: number, fps: FpsRational): number {
  if (ms <= 0) return 0;
  return Math.round((ms * fps.num) / (1000 * fps.den));
}

export function frameToMs(frame: number, fps: FpsRational): number {
  if (frame <= 0) return 0;
  return Math.round((frame * 1000 * fps.den) / fps.num);
}

export function createTrimDraft(
  inMs: number,
  outMs: number,
  totalDurationMs: number,
  fpsNum?: number,
  fpsDen?: number,
  floatFps?: number
): TrimDraft {
  const fps = parseRationalFps(fpsNum, fpsDen, floatFps);
  return {
    inMs: Math.max(0, inMs),
    outMs: outMs > 0 ? outMs : totalDurationMs,
    totalDurationMs: Math.max(0, totalDurationMs),
    fps
  };
}

export function validateTrim(draft: TrimDraft): TrimValidationResult {
  const errors: string[] = [];

  if (draft.inMs < 0) {
    errors.push('IN point cannot be negative.');
  }

  if (draft.totalDurationMs > 0 && draft.inMs >= draft.totalDurationMs) {
    errors.push('IN point must be less than total duration.');
  }

  if (draft.outMs <= draft.inMs) {
    errors.push('OUT point must be greater than IN point.');
  }

  if (draft.totalDurationMs > 0 && draft.outMs > draft.totalDurationMs) {
    errors.push('OUT point cannot exceed source duration.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, errors: [] };
}

export function setInAt(draft: TrimDraft, positionMs: number): TrimDraft {
  return {
    ...draft,
    inMs: Math.max(0, positionMs)
  };
}

export function setOutAt(draft: TrimDraft, positionMs: number): TrimDraft {
  return {
    ...draft,
    outMs: Math.max(0, positionMs)
  };
}

export function nudgeBoundary(
  draft: TrimDraft,
  boundary: 'in' | 'out',
  deltaFrames: number
): TrimDraft {
  const currentMs = boundary === 'in' ? draft.inMs : draft.outMs;
  const currentFrame = msToFrame(currentMs, draft.fps);
  const targetFrame = Math.max(0, currentFrame + deltaFrames);
  const targetMs = frameToMs(targetFrame, draft.fps);

  if (boundary === 'in') {
    return setInAt(draft, targetMs);
  } else {
    return setOutAt(draft, targetMs);
  }
}

export function isTrimDirty(draft: TrimDraft, baseline: { inMs: number; outMs: number }): boolean {
  return draft.inMs !== baseline.inMs || draft.outMs !== baseline.outMs;
}

export function revertTrim(draft: TrimDraft, baseline: { inMs: number; outMs: number }): TrimDraft {
  return {
    ...draft,
    inMs: baseline.inMs,
    outMs: baseline.outMs
  };
}
