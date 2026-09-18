import { describe, it, expect } from 'vitest';
import { formatClockTime, weekdayLabel, parseClockAnchor } from '../timeFormat';

// Reference implementations: the Intl formatters the helpers used before
// PERF F-01 replaced them with manual formatting. The new code must be
// byte-identical for every valid epoch.
const referenceClock = new Intl.DateTimeFormat('el-GR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const referenceWeekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });

const sampleEpochs = (): number[] => {
  const epochs: number[] = [];
  // Every hour of a full week (covers all weekdays and every hour label).
  const weekStart = new Date(2026, 8, 13, 0, 0, 0, 0).getTime(); // Sun 13 Sep 2026 local
  for (let h = 0; h < 24 * 7; h++) epochs.push(weekStart + h * 3_600_000 + (h % 60) * 60_000 + (h % 59) * 1000);
  // European DST transitions (EET/EEST in Greece) and around midnight.
  for (const base of [
    new Date(2026, 2, 29, 2, 30, 0).getTime(),
    new Date(2026, 9, 25, 2, 30, 0).getTime(),
    new Date(2026, 0, 1, 0, 0, 0).getTime(),
    new Date(2026, 11, 31, 23, 59, 59).getTime(),
  ]) {
    for (let m = -180; m <= 180; m += 7) epochs.push(base + m * 60_000);
  }
  // Deterministic pseudo-random spread over ~3 years, second granularity.
  let seed = 123456789;
  for (let i = 0; i < 3000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    epochs.push(1_700_000_000_000 + (seed % 94_608_000) * 1000 + (seed % 1000));
  }
  return epochs;
};

describe('PERF F-01 · timeFormat helpers match the Intl reference exactly', () => {
  const epochs = sampleEpochs();

  it('formatClockTime equals the el-GR HH:MM:SS formatter for thousands of epochs', () => {
    for (const epoch of epochs) {
      expect(formatClockTime(epoch)).toBe(referenceClock.format(new Date(epoch)));
    }
  });

  it('weekdayLabel equals the lower-cased en-GB short weekday', () => {
    for (const epoch of epochs) {
      expect(weekdayLabel(epoch)).toBe(referenceWeekday.format(new Date(epoch)).toLowerCase());
    }
  });

  it('zero-pads every component', () => {
    const t = new Date(2026, 5, 7, 3, 4, 5).getTime();
    expect(formatClockTime(t)).toBe('03:04:05');
    expect(weekdayLabel(t)).toBe('sun');
  });

  it('keeps the Intl error behaviour for an invalid epoch', () => {
    expect(() => formatClockTime(Number.NaN)).toThrow(RangeError);
    expect(() => weekdayLabel(Number.NaN)).toThrow(RangeError);
  });

  it('round-trips a parsed clock anchor', () => {
    const anchor = parseClockAnchor('18:30:15', new Date(2026, 8, 18, 12, 0, 0).getTime());
    expect(formatClockTime(anchor)).toBe('18:30:15');
  });
});
