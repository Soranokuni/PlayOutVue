import { describe, it, expect } from 'vitest';
import {
  codeToDb,
  columnCodes,
  dbToFraction,
  FALL_DB_PER_MS,
  freshMeterChannel,
  HOLD_MS,
  peakCodesBetween,
  peaksFromBuffer,
  PEAK_DB_FLOOR,
  stepMeter,
} from '../audioPeaks';

/** Build an envelope from `[L, R]` pairs, one per 10 ms. */
const envelope = (pairs: Array<[number, number]>) => peaksFromBuffer(Uint8Array.from(pairs.flat()));

describe('trimmer audio envelope', () => {
  it('decodes the byte scale the Rust scan writes', () => {
    expect(codeToDb(0)).toBe(-Infinity);
    expect(codeToDb(255)).toBe(0);
    expect(codeToDb(1)).toBeCloseTo(PEAK_DB_FLOOR + 72 / 255, 6);
    // Byte 191 is what audio_peaks.rs writes for -18 dBFS (its own test).
    expect(codeToDb(191)).toBeCloseTo(-18, 0);
  });

  it('accepts an ArrayBuffer, a byte array, or the JSON fallback', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    expect(peaksFromBuffer(bytes.buffer).steps).toBe(2);
    expect(peaksFromBuffer(bytes).steps).toBe(2);
    expect(peaksFromBuffer([1, 2, 3, 4, 5]).steps).toBe(2);
  });

  it('reads the loudest step per channel over a window', () => {
    const peaks = envelope([[10, 0], [200, 5], [30, 250], [0, 0]]);
    expect(peakCodesBetween(peaks, 0, 40)).toEqual([200, 250]);
    expect(peakCodesBetween(peaks, 10, 20)).toEqual([200, 5]);
    // A zero-width window reads the step under it: a paused playhead.
    expect(peakCodesBetween(peaks, 25, 25)).toEqual([30, 250]);
    expect(peakCodesBetween(peaks, 9_999, 10_000)).toEqual([0, 0]);
  });

  it('keeps the channels apart', () => {
    const peaks = envelope([[255, 0], [0, 0]]);
    expect(peakCodesBetween(peaks, 0, 20)).toEqual([255, 0]);
  });

  it('draws one pair per column and never leaves gaps when zoomed in', () => {
    const peaks = envelope([[100, 100], [200, 50]]);
    // 20 ms over 8 columns: several columns per step, each must be filled.
    const cols = columnCodes(peaks, 0, 20, 8);
    expect(cols.length).toBe(16);
    for (let c = 0; c < 8; c++) expect(cols[c * 2]).toBeGreaterThan(0);
    expect(cols[0]).toBe(100);
    expect(cols[14]).toBe(200);
  });

  it('draws the window it is given, not the whole file', () => {
    const peaks = envelope([[255, 255], [0, 0], [0, 0], [0, 0]]);
    const cols = columnCodes(peaks, 10, 40, 3);
    expect(Array.from(cols)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('maps dB onto a -60..0 meter', () => {
    expect(dbToFraction(-Infinity)).toBe(0);
    expect(dbToFraction(-80)).toBe(0);
    expect(dbToFraction(-30)).toBeCloseTo(0.5);
    expect(dbToFraction(0)).toBe(1);
    expect(dbToFraction(3)).toBe(1);
  });
});

describe('trimmer meter ballistics', () => {
  it('rises instantly', () => {
    const next = stepMeter(freshMeterChannel(), -12, 16);
    expect(next.db).toBe(-12);
    expect(next.holdDb).toBe(-12);
  });

  it('falls at 20 dB per 1.7 s', () => {
    let state = stepMeter(freshMeterChannel(), -10, 0);
    state = stepMeter(state, -Infinity, 1700);
    expect(state.db).toBeCloseTo(-30, 6);
    expect(FALL_DB_PER_MS * 1700).toBeCloseTo(20);
  });

  it('holds the peak, then lets it go', () => {
    let state = stepMeter(freshMeterChannel(), -6, 0);
    state = stepMeter(state, -40, HOLD_MS - 100);
    expect(state.holdDb).toBe(-6);
    state = stepMeter(state, -40, 200);
    expect(state.holdDb).toBeLessThan(-6);
  });

  it('bottoms out at silence instead of drifting forever', () => {
    let state = stepMeter(freshMeterChannel(), -60, 0);
    state = stepMeter(state, -Infinity, 10_000);
    expect(state.db).toBe(-Infinity);
  });
});
