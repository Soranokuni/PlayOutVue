import { describe, it, expect } from 'vitest';
import { CONTENT_TYPES, parseContentType, effectiveContentType, legacyIndicatorFor } from '../contentTypes';
import { parseBroadcastRating, serializeBroadcastRating } from '../../stores/rundown';

describe('content types', () => {
  it('lists programme types before interstitials', () => {
    const firstInterstitial = CONTENT_TYPES.findIndex((t) => t.interstitial);
    expect(CONTENT_TYPES.slice(firstInterstitial).every((t) => t.interstitial)).toBe(true);
    expect(CONTENT_TYPES.map((t) => t.id)).toEqual(
      ['movie', 'show', 'documentary', 'news', 'kids', 'spot', 'promo', 'jingle', 'telemarketing']
    );
  });

  it('parses any case and a few aliases, and nothing else', () => {
    expect(parseContentType('KIDS')).toBe('kids');
    expect(parseContentType('Series')).toBe('show');
    expect(parseContentType('ident')).toBe('jingle');
    expect(parseContentType('bogus')).toBe('none');
    expect(parseContentType(undefined)).toBe('none');
  });

  it('reads a legacy commercial tag as the matching type, but never over a real type', () => {
    expect(effectiveContentType('none', 'spot')).toBe('spot');
    expect(effectiveContentType(undefined, 'telemarketing')).toBe('telemarketing');
    expect(effectiveContentType('movie', 'spot')).toBe('movie');
    expect(effectiveContentType('none', 'none')).toBe('none');
  });

  it('keeps the legacy tag in step for older builds', () => {
    expect(legacyIndicatorFor('spot')).toBe('spot');
    expect(legacyIndicatorFor('telemarketing')).toBe('telemarketing');
    expect(legacyIndicatorFor('kids')).toBe('none');
  });

  it('round-trips every new type through the rating string sent to the transcoder', () => {
    for (const { id } of CONTENT_TYPES) {
      const serialized = serializeBroadcastRating({ ageRating: '12', tpFlag: false, contentType: id, timeline: [] });
      expect(parseBroadcastRating(serialized).contentType).toBe(id);
    }
  });
});
