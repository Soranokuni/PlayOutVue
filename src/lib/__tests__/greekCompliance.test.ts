import { describe, it, expect } from 'vitest';
import {
  getGreekRatingDefaultText,
  getGreekWarningText,
  getGreekWarningBadgeLabel,
  formatCompliancePayload,
  buildGreekAdvisoryText,
  GREEK_COMPLIANCE_PRESETS,
  type GreekComplianceConfig
} from '../greekCompliance';

describe('Greek Compliance Library & Payload Formatter', () => {
  it('returns appropriate Greek default texts for ratings', () => {
    expect(getGreekRatingDefaultText('K')).toBe('ΚΑΤΑΛΛΗΛΟ ΓΙΑ ΟΛΟΥΣ');
    expect(getGreekRatingDefaultText('8')).toBe('ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 8');
    expect(getGreekRatingDefaultText('12')).toBe('ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 12');
    expect(getGreekRatingDefaultText('16')).toBe('ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 16');
    expect(getGreekRatingDefaultText('18')).toBe('ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 18');
  });

  it('returns correct advisory warning texts', () => {
    expect(getGreekWarningText('violence')).toBe('ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ');
    expect(getGreekWarningText('sex')).toBe('ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ');
    expect(getGreekWarningText('drugs')).toBe('ΠΕΡΙΕΧΕΙ ΧΡΗΣΗ ΟΥΣΙΩΝ');
    expect(getGreekWarningText('language')).toBe('ΠΕΡΙΕΧΕΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ');
  });

  it('returns short badge labels for warning icons', () => {
    expect(getGreekWarningBadgeLabel('violence')).toBe('ΒΙΑ');
    expect(getGreekWarningBadgeLabel('sex')).toBe('ΣΕΞ');
    expect(getGreekWarningBadgeLabel('drugs')).toBe('ΝΑΡΚΩΤΙΚΑ');
    expect(getGreekWarningBadgeLabel('language')).toBe('ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ');
  });

  it('formats compliance payload with default texts and timings', () => {
    const config: GreekComplianceConfig = {
      rating: '16',
      warnings: ['violence', 'language']
    };

    const payloadJson = formatCompliancePayload(config);
    const parsed = JSON.parse(payloadJson);

    expect(parsed.rating).toBe('16');
    expect(parsed.custom_text).toBe('ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 16');
    expect(parsed.warnings).toEqual(['ΒΙΑ', 'ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ']);
    expect(parsed.hold_time).toBe(4);
    expect(parsed.warning_hold_time).toBe(3);
    expect(parsed.top).toBe(60);
    expect(parsed.left).toBe(80);
  });

  it('formats compliance payload with custom text and custom timing', () => {
    const config: GreekComplianceConfig = {
      rating: '18',
      warnings: ['sex', 'drugs'],
      customText: 'ΕΙΔΙΚΗ ΠΡΟΕΙΔΟΠΟΙΗΣΗ',
      holdTime: 5,
      warningHoldTime: 4
    };

    const payloadJson = formatCompliancePayload(config);
    const parsed = JSON.parse(payloadJson);

    expect(parsed.rating).toBe('18');
    expect(parsed.custom_text).toBe('ΕΙΔΙΚΗ ΠΡΟΕΙΔΟΠΟΙΗΣΗ');
    expect(parsed.warnings).toEqual(['ΣΕΞ', 'ΝΑΡΚΩΤΙΚΑ']);
    expect(parsed.hold_time).toBe(5);
    expect(parsed.warning_hold_time).toBe(4);
  });

  it('preserves existing buildGreekAdvisoryText and presets', () => {
    expect(buildGreekAdvisoryText(['violence'])).toBe('ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ');
    expect(buildGreekAdvisoryText(['violence', 'sex'])).toBe('ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ ΚΑΙ ΣΕΞ');
    expect(GREEK_COMPLIANCE_PRESETS.length).toBeGreaterThan(10);
  });
});
