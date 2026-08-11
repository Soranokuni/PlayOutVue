import { describe, it, expect } from 'vitest';
import {
  createTrimDraft,
  setInAt,
  setOutAt,
  nudgeBoundary,
  validateTrim,
  isTrimDirty,
  revertTrim,
  parseRationalFps,
  msToFrame,
  frameToMs
} from '../trimController';

describe('PR 5B UI Trim Controller & Rational FPS Math', () => {
  it('parses rational FPS correctly for standard broadcast frame rates', () => {
    expect(parseRationalFps(25, 1)).toEqual({ num: 25, den: 1 });
    expect(parseRationalFps(50, 1)).toEqual({ num: 50, den: 1 });
    expect(parseRationalFps(30000, 1001)).toEqual({ num: 30000, den: 1001 });
    expect(parseRationalFps(24000, 1001)).toEqual({ num: 24000, den: 1001 });
    expect(parseRationalFps(60000, 1001)).toEqual({ num: 60000, den: 1001 });
    expect(parseRationalFps(undefined, undefined, 29.97)).toEqual({ num: 30000, den: 1001 });
  });

  it('converts ms to frame and frame to ms accurately for rational frame rates', () => {
    const fps25 = { num: 25, den: 1 };
    expect(msToFrame(1000, fps25)).toBe(25);
    expect(frameToMs(25, fps25)).toBe(1000);

    const fpsNtsc = { num: 30000, den: 1001 }; // ~29.97 fps
    expect(msToFrame(1001, fpsNtsc)).toBe(30);
    expect(frameToMs(30, fpsNtsc)).toBe(1001);
  });

  it('validates trim bounds and returns validation errors without silent clamping', () => {
    const validDraft = createTrimDraft(1000, 5000, 10000, 25, 1);
    expect(validateTrim(validDraft)).toEqual({ valid: true, errors: [] });

    const invalidOut = setOutAt(validDraft, 500);
    const resInvalid = validateTrim(invalidOut);
    expect(resInvalid.valid).toBe(false);
    expect(resInvalid.errors).toContain('OUT point must be greater than IN point.');

    const invalidExceed = setOutAt(validDraft, 15000);
    const resExceed = validateTrim(invalidExceed);
    expect(resExceed.valid).toBe(false);
    expect(resExceed.errors).toContain('OUT point cannot exceed source duration.');
  });

  it('nudges boundary by delta frames accurately', () => {
    const draft = createTrimDraft(0, 10000, 20000, 25, 1);
    const nudgedIn = nudgeBoundary(draft, 'in', 5);
    expect(nudgedIn.inMs).toBe(200); // 5 frames @ 25fps = 200ms

    const nudgedOut = nudgeBoundary(draft, 'out', -5);
    expect(nudgedOut.outMs).toBe(9800);
  });

  it('tracks dirty state and reverts to baseline cleanly', () => {
    const baseline = { inMs: 1000, outMs: 5000 };
    const draft = createTrimDraft(1000, 5000, 10000, 25, 1);

    expect(isTrimDirty(draft, baseline)).toBe(false);

    const modified = setInAt(draft, 2000);
    expect(isTrimDirty(modified, baseline)).toBe(true);

    const reverted = revertTrim(modified, baseline);
    expect(reverted.inMs).toBe(1000);
    expect(isTrimDirty(reverted, baseline)).toBe(false);
  });
});
