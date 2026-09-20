import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useStudioClock } from '../useStudioClock';

describe('useStudioClock composable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats timecode as HH:MM:SS:FF defaulting to 25fps', () => {
    const date = new Date(2026, 8, 14, 15, 30, 45, 500); // 500ms at 25fps => frame 12
    vi.setSystemTime(date);

    const clock = useStudioClock(25);
    expect(clock.timecode.value).toBe('15:30:45:12');
    // UI F-14: `isNtpLocked` is gone -- it was hard-coded true and backed nothing.
    expect('isNtpLocked' in clock).toBe(false);
    expect(clock.fps.value).toBe(25);
    clock.stop();
  });

  it('calculates frame accurately at start of second', () => {
    const date = new Date(2026, 8, 14, 9, 5, 1, 0); // 0ms => frame 0
    vi.setSystemTime(date);

    const clock = useStudioClock(25);
    expect(clock.timecode.value).toBe('09:05:01:00');
    clock.stop();
  });

  it('clamps frame within fps bounds at end of second', () => {
    const date = new Date(2026, 8, 14, 23, 59, 59, 999); // 999ms at 25fps => frame 24
    vi.setSystemTime(date);

    const clock = useStudioClock(25);
    expect(clock.timecode.value).toBe('23:59:59:24');
    clock.stop();
  });

  // PERF F-18: the loop is a frame-aligned timer, not a 60 Hz rAF loop.
  it('advances one frame per 40 ms wake-up at 25 fps and stops cleanly', () => {
    vi.stubGlobal('window', {});
    try {
      const date = new Date(2026, 8, 14, 10, 0, 0, 0);
      vi.setSystemTime(date);

      const clock = useStudioClock(25);
      expect(clock.timecode.value).toBe('10:00:00:00');

      vi.advanceTimersByTime(41);
      expect(clock.timecode.value).toBe('10:00:00:01');

      vi.advanceTimersByTime(40 * 23);
      expect(clock.timecode.value).toBe('10:00:00:24');

      vi.advanceTimersByTime(40);
      expect(clock.timecode.value).toBe('10:00:01:00');

      expect(vi.getTimerCount()).toBe(1);
      clock.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
