import { describe, it, expect } from 'vitest';
import { sanitizeSettingsState } from '../settings';

// The trimmer's monitor preferences are restored from localStorage like every
// other setting, so a hand-edited or older entry must not leave the preview at
// a NaN volume or with a truthy string where a boolean belongs.
const DEFAULTS = { trimmerAudioMuted: false, trimmerAudioVolume: 80, trimmerScrubAudio: true };

describe('trimmer audio settings hydration', () => {
  it('keeps valid values', () => {
    const state = sanitizeSettingsState({ trimmerAudioMuted: true, trimmerAudioVolume: 35, trimmerScrubAudio: false }, DEFAULTS);
    expect(state).toMatchObject({ trimmerAudioMuted: true, trimmerAudioVolume: 35, trimmerScrubAudio: false });
  });

  it('rounds a fractional volume and rejects one out of range', () => {
    expect(sanitizeSettingsState({ ...DEFAULTS, trimmerAudioVolume: 42.6 }, DEFAULTS).trimmerAudioVolume).toBe(43);
    expect(sanitizeSettingsState({ ...DEFAULTS, trimmerAudioVolume: 400 }, DEFAULTS).trimmerAudioVolume).toBe(80);
    expect(sanitizeSettingsState({ ...DEFAULTS, trimmerAudioVolume: 'loud' }, DEFAULTS).trimmerAudioVolume).toBe(80);
  });

  it('restores the defaults for missing or non-boolean flags', () => {
    const state = sanitizeSettingsState({ trimmerAudioMuted: 'yes', trimmerAudioVolume: 80 } as Record<string, unknown>, DEFAULTS);
    expect(state.trimmerAudioMuted).toBe(false);
    expect(state.trimmerScrubAudio).toBe(true);
  });
});
