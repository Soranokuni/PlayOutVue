import { describe, it, expect } from 'vitest';
import { fitToWidth, MAX_FIT_STEP } from '../fitToWidth';

/**
 * Round 3 §4 — the control bar's collapse ladder.
 *
 * The owner: "when resizing the bottom bar doesn't resize … dynamic handling,
 * resizing or even minimize to just icons". The bar picked one of three tiers
 * from fixed pixel thresholds, so between them content that did not fit was
 * clipped, and the thresholds were wrong for any font, density or label length
 * other than the one they were measured against.
 *
 * The widths below are the ladder measured in the running app at standard
 * density, dark theme: step 0 is everything, and each rung sheds a little more.
 */
const LADDER = [1405, 1297, 1160, 994, 947, 786];

describe('Round 3 §4 · fitToWidth', () => {
  it('stays at step 0 when everything fits', () => {
    expect(fitToWidth({ naturalWidths: LADDER, available: 1920 })).toBe(0);
    expect(fitToWidth({ naturalWidths: LADDER, available: 1440 })).toBe(0);
  });

  it('sheds exactly as much as it has to', () => {
    expect(fitToWidth({ naturalWidths: LADDER, available: 1300 })).toBe(1);
    expect(fitToWidth({ naturalWidths: LADDER, available: 1200 })).toBe(2);
    expect(fitToWidth({ naturalWidths: LADDER, available: 1100 })).toBe(3);
    expect(fitToWidth({ naturalWidths: LADDER, available: 960 })).toBe(4);
  });

  it('never goes past the last rung, however narrow the bar gets', () => {
    expect(fitToWidth({ naturalWidths: LADDER, available: 320 })).toBe(MAX_FIT_STEP);
    expect(fitToWidth({ naturalWidths: LADDER, available: 0 })).toBe(MAX_FIT_STEP);
  });

  /**
   * The regression this function was rewritten for. The plan proposed starting
   * one step looser than the current one; measured in the browser that recovers
   * one rung per resize event, so a bar that had collapsed to step 5 sat at
   * step 2 on a 1440 px window with room for step 0. Width returning has to
   * expand the bar in one pass, from wherever it was.
   */
  it('expands all the way back in a single pass, from any previous step', () => {
    for (const available of [1440, 1920]) {
      expect(fitToWidth({ naturalWidths: LADDER, available })).toBe(0);
    }
  });

  it('settles rather than oscillating when the width sits exactly on a rung', () => {
    const settled = fitToWidth({ naturalWidths: LADDER, available: 1297 });
    expect(settled).toBe(1);
    expect(fitToWidth({ naturalWidths: LADDER, available: 1297 })).toBe(settled);
  });

  it('tolerates the sub-pixel difference between scroll width and client width', () => {
    // 1296.4 px of room for 1297 px of content is a rounding artefact, not a
    // reason to drop a control.
    expect(fitToWidth({ naturalWidths: LADDER, available: 1296.4 })).toBe(1);
  });

  it('does not walk past the widths it was given', () => {
    expect(fitToWidth({ naturalWidths: [900, 800], available: 100 })).toBe(1);
    expect(fitToWidth({ naturalWidths: [900], available: 100 })).toBe(0);
    expect(fitToWidth({ naturalWidths: [], available: 100 })).toBe(0);
  });

  it('honours a lower ceiling than the default ladder', () => {
    expect(fitToWidth({ naturalWidths: LADDER, available: 320, maxStep: 3 })).toBe(3);
  });
});
