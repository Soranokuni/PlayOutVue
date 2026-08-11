/**
 * Frame-accurate timecode calculations supporting broadcast frame rates,
 * drop-frame (DF) vs non-drop-frame (NDF) timecode formatting, and frame snapping.
 */

export interface FrameRate {
  fpsNum: number;
  fpsDen: number;
}

export interface ParseResult {
  valid: boolean;
  frame?: number;
  ms?: number;
  error?: string;
}

export const DEFAULT_FRAME_RATE: FrameRate = { fpsNum: 25, fpsDen: 1 };

/**
 * Normalizes fps float or fraction into a standard broadcast FrameRate rational.
 */
export function getFrameRate(fpsNum?: number, fpsDen?: number, fpsFloat?: number): FrameRate {
  if (fpsNum && fpsDen && fpsNum > 0 && fpsDen > 0) {
    return { fpsNum, fpsDen };
  }
  if (fpsFloat && fpsFloat > 0) {
    // Snap common floats to exact broadcast rationals
    if (Math.abs(fpsFloat - 23.976) < 0.05 || Math.abs(fpsFloat - 23.98) < 0.05) return { fpsNum: 24000, fpsDen: 1001 };
    if (Math.abs(fpsFloat - 29.97) < 0.05) return { fpsNum: 30000, fpsDen: 1001 };
    if (Math.abs(fpsFloat - 59.94) < 0.05) return { fpsNum: 60000, fpsDen: 1001 };
    if (Math.abs(fpsFloat - 25) < 0.01) return { fpsNum: 25, fpsDen: 1 };
    if (Math.abs(fpsFloat - 50) < 0.01) return { fpsNum: 50, fpsDen: 1 };
    if (Math.abs(fpsFloat - 60) < 0.01) return { fpsNum: 60, fpsDen: 1 };
    if (Math.abs(fpsFloat - 24) < 0.01) return { fpsNum: 24, fpsDen: 1 };
    if (Math.abs(fpsFloat - 30) < 0.01) return { fpsNum: 30, fpsDen: 1 };
    return { fpsNum: Math.round(fpsFloat * 1000), fpsDen: 1000 };
  }
  return DEFAULT_FRAME_RATE;
}

/**
 * Checks if a frame rate supports drop-frame timecode (typically 29.97 / 30000:1001 or 59.94 / 60000:1001).
 */
export function isDropFrameSupported(rate: FrameRate): boolean {
  const fps = rate.fpsNum / rate.fpsDen;
  return Math.abs(fps - 29.97) < 0.05 || Math.abs(fps - 59.94) < 0.05;
}

/**
 * Calculates absolute frame number from milliseconds based on rational frame rate.
 */
export function msToFrame(ms: number, fpsNum: number = 25, fpsDen: number = 1): number {
  if (ms <= 0 || fpsNum <= 0 || fpsDen <= 0) return 0;
  const fps = fpsNum / fpsDen;
  return Math.round((ms / 1000) * fps);
}

/**
 * Calculates exact milliseconds from frame number.
 */
export function frameToMs(frame: number, fpsNum: number = 25, fpsDen: number = 1): number {
  if (frame <= 0 || fpsNum <= 0 || fpsDen <= 0) return 0;
  const fps = fpsNum / fpsDen;
  return Math.round((frame / fps) * 1000);
}

/**
 * Snaps a millisecond duration to the nearest exact frame boundary.
 */
export function snapMsToFrame(ms: number, fpsNum: number = 25, fpsDen: number = 1): number {
  const frame = msToFrame(ms, fpsNum, fpsDen);
  return frameToMs(frame, fpsNum, fpsDen);
}

/**
 * Converts a frame number to a timecode string HH:MM:SS:FF or HH:MM:SS;FF (drop-frame).
 */
export function frameToTimecode(
  frameNumber: number,
  rate: FrameRate = DEFAULT_FRAME_RATE,
  dropFrame = false
): string {
  let frame = Math.max(0, Math.round(frameNumber));
  const nominalFps = Math.round(rate.fpsNum / rate.fpsDen);
  const isDF = dropFrame && isDropFrameSupported(rate);

  if (isDF) {
    const dropFrames = nominalFps === 60 ? 4 : 2; // 2 frames per min for 29.97, 4 for 59.94
    const framesPerMinute = nominalFps * 60 - dropFrames;
    const framesPer10Minutes = nominalFps * 600 - dropFrames * 9;

    const d = Math.floor(frame / framesPer10Minutes);
    const m = frame % framesPer10Minutes;

    if (m >= dropFrames) {
      frame += d * 9 * dropFrames + dropFrames * Math.floor((m - dropFrames) / framesPerMinute);
    } else {
      frame += d * 9 * dropFrames;
    }
  }

  const ff = frame % nominalFps;
  const s = Math.floor(frame / nominalFps);
  const ss = s % 60;
  const mm = Math.floor(s / 60) % 60;
  const hh = Math.floor(s / 3600);

  const sep = isDF ? ';' : ':';
  const pad = (n: number) => String(n).padStart(2, '0');

  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`;
}

/**
 * Converts milliseconds to timecode.
 */
export function msToTimecode(ms: number, rate: FrameRate = DEFAULT_FRAME_RATE, dropFrame = false): string {
  const frame = msToFrame(ms, rate.fpsNum, rate.fpsDen);
  return frameToTimecode(frame, rate, dropFrame);
}

/**
 * Parses timecode string (HH:MM:SS:FF or HH:MM:SS;FF) into frame number and milliseconds.
 */
export function parseTimecode(
  value: string,
  rate: FrameRate = DEFAULT_FRAME_RATE,
  dropFrame = false
): ParseResult {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Empty timecode' };
  }

  const clean = value.trim();
  const match = clean.match(/^(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{2})$/);
  if (!match) {
    return { valid: false, error: 'Format must be HH:MM:SS:FF or HH:MM:SS;FF' };
  }

  const hh = Number.parseInt(match[1]!, 10);
  const mm = Number.parseInt(match[2]!, 10);
  const ss = Number.parseInt(match[3]!, 10);
  const ff = Number.parseInt(match[4]!, 10);

  const nominalFps = Math.round(rate.fpsNum / rate.fpsDen);
  const isDF = (clean.includes(';') || dropFrame) && isDropFrameSupported(rate);

  if (mm > 59 || ss > 59 || ff >= nominalFps) {
    return { valid: false, error: `Invalid numbers (FF max ${nominalFps - 1})` };
  }

  let totalFrames = (hh * 3600 + mm * 60 + ss) * nominalFps + ff;

  if (isDF) {
    const dropFrames = nominalFps === 60 ? 4 : 2;
    const totalMinutes = hh * 60 + mm;
    const dropCount = totalMinutes - Math.floor(totalMinutes / 10);
    totalFrames -= dropCount * dropFrames;
  }

  const ms = frameToMs(totalFrames, rate.fpsNum, rate.fpsDen);
  return { valid: true, frame: totalFrames, ms };
}
