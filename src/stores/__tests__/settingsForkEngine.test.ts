import { describe, it, expect } from 'vitest';
import { sanitizeSettingsState } from '../settings';

// The fork settings end up in AMCP: the fallback clip inside
// `FALLBACK 1-10 "<clip>"`, depth and stall as numbers. A restored or
// hand-edited value must not break the command line or the queue.
const DEFAULTS = { forkQueueDepth: 2, forkFallbackClip: 'playout/emergency', forkStallTicks: 50 };

describe('fork engine settings hydration', () => {
  it('keeps valid values', () => {
    const state = sanitizeSettingsState({ forkQueueDepth: 3, forkFallbackClip: 'slates/station id', forkStallTicks: 0 }, DEFAULTS);
    expect(state).toMatchObject({ forkQueueDepth: 3, forkFallbackClip: 'slates/station id', forkStallTicks: 0 });
  });

  it('accepts an empty fallback clip (no fallback)', () => {
    expect(sanitizeSettingsState({ ...DEFAULTS, forkFallbackClip: '' }, DEFAULTS).forkFallbackClip).toBe('');
  });

  it('accepts an absolute local path (AE-2: the fork takes D:/... as is)', () => {
    for (const good of ['D:/fallback/slate.mov', 'D:\\fallback\\slate.mov', 'e:/Fill ers/a b.mxf']) {
      expect(sanitizeSettingsState({ ...DEFAULTS, forkFallbackClip: good }, DEFAULTS).forkFallbackClip).toBe(good);
    }
  });

  it('rejects a clip that could break the AMCP line or leave the media folder', () => {
    for (const bad of ['a" LOOP\r\nKILL', 'a"b', '../system/x', 'D:/x/../y', 'D:/a"b', 'D:/a\r\nKILL', '\\\\server\\share\\x', 42]) {
      expect(sanitizeSettingsState({ ...DEFAULTS, forkFallbackClip: bad } as Record<string, unknown>, DEFAULTS).forkFallbackClip)
        .toBe('playout/emergency');
    }
  });

  it('bounds the queue depth and the stall limit', () => {
    expect(sanitizeSettingsState({ ...DEFAULTS, forkQueueDepth: 0 }, DEFAULTS).forkQueueDepth).toBe(2);
    expect(sanitizeSettingsState({ ...DEFAULTS, forkQueueDepth: 12 }, DEFAULTS).forkQueueDepth).toBe(2);
    expect(sanitizeSettingsState({ ...DEFAULTS, forkStallTicks: -1 }, DEFAULTS).forkStallTicks).toBe(50);
    expect(sanitizeSettingsState({ ...DEFAULTS, forkStallTicks: 74.6 }, DEFAULTS).forkStallTicks).toBe(75);
  });
});
