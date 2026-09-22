/**
 * The trim panel's audio envelope: decoding, lookup and meter ballistics.
 *
 * `get_audio_peaks` (src-tauri/src/audio_peaks.rs) returns interleaved
 * `[L, R, L, R, …]` bytes, one per channel every 10 ms. A byte is the peak in
 * dBFS mapped linearly from {@link PEAK_DB_FLOOR} (0) to 0 dBFS (255); 0 also
 * means digital silence. The constants here must match the Rust ones.
 *
 * Everything in this file is pure so it can be tested without a WebView.
 */

export const PEAKS_PER_SECOND = 100;
export const PEAK_DB_FLOOR = -72;
export const PEAK_CHANNELS = 2;

/** The error `get_audio_peaks` answers with when a file has no audio stream. */
export const NO_AUDIO = 'no_audio';

export interface AudioPeaks {
  /** Interleaved per-channel peak codes. */
  data: Uint8Array;
  /** Number of 10 ms steps, i.e. `data.length / PEAK_CHANNELS`. */
  steps: number;
}

export function peaksFromBuffer(buffer: ArrayBuffer | Uint8Array | number[]): AudioPeaks {
  const data =
    buffer instanceof Uint8Array
      ? buffer
      : Array.isArray(buffer)
        ? Uint8Array.from(buffer)
        : new Uint8Array(buffer);
  return { data, steps: Math.floor(data.length / PEAK_CHANNELS) };
}

/** dBFS for a peak code; `-Infinity` for silence. */
export function codeToDb(code: number): number {
  if (code <= 0) return -Infinity;
  return PEAK_DB_FLOOR + (code / 255) * -PEAK_DB_FLOOR;
}

/** The loudest code per channel over `[fromMs, toMs)`. A zero-width window reads the one step at `fromMs`. */
export function peakCodesBetween(peaks: AudioPeaks, fromMs: number, toMs: number): [number, number] {
  if (peaks.steps === 0) return [0, 0];
  const msPerStep = 1000 / PEAKS_PER_SECOND;
  const lo = Math.max(0, Math.floor(Math.min(fromMs, toMs) / msPerStep));
  const hi = Math.min(peaks.steps, Math.max(lo + 1, Math.ceil(Math.max(fromMs, toMs) / msPerStep)));
  if (lo >= peaks.steps) return [0, 0];
  let l = 0;
  let r = 0;
  for (let step = lo; step < hi; step++) {
    const a = peaks.data[step * PEAK_CHANNELS] ?? 0;
    const b = peaks.data[step * PEAK_CHANNELS + 1] ?? 0;
    if (a > l) l = a;
    if (b > r) r = b;
  }
  return [l, r];
}

/**
 * Per-column maxima for drawing `[startMs, endMs)` into `columns` pixels.
 * Returns interleaved `[L, R, …]` codes, one pair per column. When a column is
 * narrower than a step the nearest step is used, so zooming in never shows gaps.
 */
export function columnCodes(peaks: AudioPeaks, startMs: number, endMs: number, columns: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, columns) * PEAK_CHANNELS);
  if (columns <= 0 || endMs <= startMs || peaks.steps === 0) return out;
  const spanMs = endMs - startMs;
  for (let col = 0; col < columns; col++) {
    const from = startMs + (col / columns) * spanMs;
    const to = startMs + ((col + 1) / columns) * spanMs;
    const [l, r] = peakCodesBetween(peaks, from, to);
    out[col * PEAK_CHANNELS] = l;
    out[col * PEAK_CHANNELS + 1] = r;
  }
  return out;
}

/**
 * Position on a meter or waveform, 0..1, over `[floorDb, 0]` dBFS. The scale
 * is in dB so the onset of a quiet word is as visible as a loud one: that is
 * what an operator is looking for when they cut.
 */
export function dbToFraction(db: number, floorDb = -60): number {
  if (!Number.isFinite(db) || db <= floorDb) return 0;
  if (db >= 0) return 1;
  return (db - floorDb) / -floorDb;
}

/**
 * Peak-programme ballistics: instant rise, a fall of 20 dB in 1.7 s (the IEC
 * 60268-10 Type I return time), and a peak-hold marker that drops after
 * {@link HOLD_MS}.
 */
export const FALL_DB_PER_MS = 20 / 1700;
export const HOLD_MS = 1500;

export interface MeterChannelState {
  db: number;
  holdDb: number;
  holdAgeMs: number;
}

export function freshMeterChannel(): MeterChannelState {
  return { db: -Infinity, holdDb: -Infinity, holdAgeMs: 0 };
}

export function stepMeter(state: MeterChannelState, inputDb: number, dtMs: number): MeterChannelState {
  const dt = Math.max(0, dtMs);
  const fallen = Number.isFinite(state.db) ? state.db - FALL_DB_PER_MS * dt : -Infinity;
  const db = inputDb >= fallen ? inputDb : fallen < PEAK_DB_FLOOR ? -Infinity : fallen;

  let holdDb = state.holdDb;
  let holdAgeMs = state.holdAgeMs + dt;
  if (db >= holdDb || holdAgeMs >= HOLD_MS) {
    holdDb = db;
    holdAgeMs = 0;
  }
  return { db, holdDb, holdAgeMs };
}
