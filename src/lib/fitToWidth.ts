/**
 * Round 3 §4 — the control bar's collapse ladder, as a pure function.
 *
 * The bar used to pick one of three tiers from fixed pixel thresholds (980 /
 * 1180). A threshold is a guess about how wide the content happens to be, and
 * the guess is wrong the moment any of the things it guessed about change: the
 * density scale, the theme's font, the engine button's label ("Disconnect" is
 * three characters wider than "Connect"), the next-up title, whether the TAKE
 * HELD alert is up, how far the operator dragged the library split. Between
 * the thresholds, content that did not fit was simply clipped by the shell's
 * `overflow`.
 *
 * So the bar stops guessing and asks one question after every resize: does my
 * content fit? If not, it drops the least important thing and asks again.
 *
 * This is the loop, extracted so it can be tested. happy-dom lays nothing out,
 * so a DOM test of the real bar would assert against zeroes; here the caller
 * supplies the natural width at each step and the function walks the ladder.
 *
 * The plan proposed starting one step *looser* than the current one so the bar
 * expands again when space returns. Measured in the browser, that recovers one
 * rung per resize event and so leaves the bar sitting several rungs tighter
 * than it needs to be whenever a resize ends promptly -- at 1440 px the bar
 * stayed at step 2 with room for step 0. Since the caller measures the whole
 * ladder anyway, the loosest fitting rung is available directly and costs
 * nothing extra; `currentStep` is therefore not an input at all, and the bar
 * settles in a single pass with no hysteresis to unwind.
 */

/** The last rung: below this the bar cannot shed anything else. */
export const MAX_FIT_STEP = 5;

export interface FitToWidthInput {
  /**
   * The bar's natural (scroll) width at each step, `naturalWidths[n]` being the
   * width at step `n`. Widths are expected to be non-increasing.
   */
  naturalWidths: number[];
  /** The width actually available. */
  available: number;
  maxStep?: number;
}

/**
 * Picks the loosest step whose content fits, or the last rung if none does.
 */
export function fitToWidth({ naturalWidths, available, maxStep = MAX_FIT_STEP }: FitToWidthInput): number {
  const ceiling = Math.max(0, Math.min(maxStep, naturalWidths.length - 1));

  for (let step = 0; step < ceiling; step += 1) {
    // `+ 1` absorbs the sub-pixel difference between a scroll width and a
    // client width on a fractional layout; without it the bar oscillates by
    // one rung as the window is dragged.
    if ((naturalWidths[step] ?? 0) <= available + 1) return step;
  }

  return ceiling;
}
