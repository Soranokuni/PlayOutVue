import { describe, expect, it } from 'vitest';
import { hasActiveWarnings } from '../statusResolver';

/**
 * Warnings the transcoder adds when a re-encode moves or drops a trim
 * (TRIM-CONTRACT-AUDIT C-17). They are the operator's only signal, so no QC
 * sensitivity may filter them out.
 */
describe('re-encode trim warnings stay visible', () => {
    const codes = ['trim_reset_after_reencode', 'subclip_outside_reencoded_parent'];

    for (const code of codes) {
        it(`${code} is active at every sensitivity`, () => {
            for (const sensitivity of ['strict', 'production', 'lenient'] as const) {
                expect(hasActiveWarnings([code], sensitivity)).toBe(true);
            }
        });
    }
});
