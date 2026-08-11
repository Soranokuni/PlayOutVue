import { describe, it, expect } from 'vitest';
import {
  msToFrame,
  frameToMs,
  snapMsToFrame,
  frameToTimecode,
  parseTimecode,
  getFrameRate,
  isDropFrameSupported
} from '../timecode';

describe('timecode module', () => {
  it('correctly normalizes frame rates', () => {
    expect(getFrameRate(25, 1)).toEqual({ fpsNum: 25, fpsDen: 1 });
    expect(getFrameRate(undefined, undefined, 23.976)).toEqual({ fpsNum: 24000, fpsDen: 1001 });
    expect(getFrameRate(undefined, undefined, 29.97)).toEqual({ fpsNum: 30000, fpsDen: 1001 });
    expect(getFrameRate(undefined, undefined, 59.94)).toEqual({ fpsNum: 60000, fpsDen: 1001 });
  });

  it('detects drop-frame support', () => {
    expect(isDropFrameSupported({ fpsNum: 30000, fpsDen: 1001 })).toBe(true);
    expect(isDropFrameSupported({ fpsNum: 60000, fpsDen: 1001 })).toBe(true);
    expect(isDropFrameSupported({ fpsNum: 25, fpsDen: 1 })).toBe(false);
  });

  it('converts ms <-> frame for 25fps', () => {
    expect(msToFrame(0, 25, 1)).toBe(0);
    expect(msToFrame(1000, 25, 1)).toBe(25);
    expect(msToFrame(40, 25, 1)).toBe(1);
    expect(frameToMs(25, 25, 1)).toBe(1000);
    expect(frameToMs(1, 25, 1)).toBe(40);
  });

  it('snaps ms to frame boundaries', () => {
    expect(snapMsToFrame(43, 25, 1)).toBe(40); // 43ms snaps to frame 1 = 40ms
    expect(snapMsToFrame(78, 25, 1)).toBe(80); // 78ms snaps to frame 2 = 80ms
  });

  it('formats non-drop-frame timecode', () => {
    const rate25 = { fpsNum: 25, fpsDen: 1 };
    expect(frameToTimecode(0, rate25)).toBe('00:00:00:00');
    expect(frameToTimecode(25, rate25)).toBe('00:00:01:00');
    expect(frameToTimecode(1500, rate25)).toBe('00:01:00:00');
    expect(frameToTimecode(90000, rate25)).toBe('01:00:00:00');
  });

  it('formats drop-frame timecode for 29.97 (30000/1001)', () => {
    const rate30df = { fpsNum: 30000, fpsDen: 1001 };
    expect(frameToTimecode(0, rate30df, true)).toBe('00:00:00;00');
    expect(frameToTimecode(30, rate30df, true)).toBe('00:00:01;00');
    // Drop-frame skips frame numbers at 1 minute mark
    const tcMin1 = frameToTimecode(1798, rate30df, true); // 1 minute mark in DF
    expect(tcMin1).toContain(';');
  });

  it('parses timecode strings correctly', () => {
    const rate25 = { fpsNum: 25, fpsDen: 1 };
    const res1 = parseTimecode('00:01:00:00', rate25);
    expect(res1.valid).toBe(true);
    expect(res1.frame).toBe(1500);
    expect(res1.ms).toBe(60000);

    const resDF = parseTimecode('00:01:00;00', { fpsNum: 30000, fpsDen: 1001 }, true);
    expect(resDF.valid).toBe(true);
  });

  it('handles invalid timecode strings gracefully', () => {
    const rate25 = { fpsNum: 25, fpsDen: 1 };
    expect(parseTimecode('', rate25).valid).toBe(false);
    expect(parseTimecode('invalid', rate25).valid).toBe(false);
    expect(parseTimecode('00:00:00:30', rate25).valid).toBe(false); // 30 is invalid for 25fps (max 24)
  });
});
