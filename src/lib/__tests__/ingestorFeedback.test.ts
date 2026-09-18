import { describe, it, expect } from 'vitest';
import { normalizePurgeOutcome, describePurgeOutcome } from '../ingestorFeedback';

// PlayoutTranscode remediation §8.2: purging a non-ready row deletes the
// registry entry but keeps the file. "Media removed" must come from the
// response, never from the row disappearing.
describe('normalizePurgeOutcome', () => {
    it('maps a structured Ingestor result', () => {
        const out = normalizePurgeOutcome({
            operation: 'purge_asset',
            rows_deleted: 1,
            media_removed: true,
            sidecar_removed: true,
            skipped_referenced_files: [],
            cleanup_failures: [],
            warnings: [],
        });
        expect(out.rows_deleted).toBe(1);
        expect(out.media_removed).toBe(true);
        expect(out.sidecar_removed).toBe(true);
    });

    it('tolerates null, legacy and malformed bodies', () => {
        for (const raw of [null, undefined, '', 42, { success: true }, { rows_deleted: 'x', warnings: 'nope', media_removed: 'true' }]) {
            const out = normalizePurgeOutcome(raw);
            expect(out.rows_deleted).toBe(0);
            expect(out.media_removed).toBe(false);
            expect(out.warnings).toEqual([]);
            expect(out.cleanup_failures).toEqual([]);
        }
    });

    it('drops non-string entries from list fields', () => {
        const out = normalizePurgeOutcome({ warnings: ['a', 1, null, 'b'], cleanup_failures: [{}] });
        expect(out.warnings).toEqual(['a', 'b']);
        expect(out.cleanup_failures).toEqual([]);
    });
});

describe('describePurgeOutcome', () => {
    const clean = normalizePurgeOutcome({ rows_deleted: 1, media_removed: true, sidecar_removed: true });

    it('says nothing when rows and media are gone', () => {
        expect(describePurgeOutcome(clean, 'Promo A')).toBeNull();
    });

    it('says nothing for an already-empty Recycle Bin', () => {
        expect(describePurgeOutcome(normalizePurgeOutcome({ rows_deleted: 0 }), 'the Recycle Bin')).toBeNull();
    });

    it('warns when the registry row went but the file was kept', () => {
        const note = describePurgeOutcome(
            normalizePurgeOutcome({ rows_deleted: 1, media_removed: false, warnings: ['asset was not ready; source file kept'] }),
            'Promo A'
        );
        expect(note).toContain('Promo A');
        expect(note).toContain('kept on disk');
        expect(note).toContain('source file kept');
    });

    it('reports referenced files and cleanup failures', () => {
        const note = describePurgeOutcome(
            normalizePurgeOutcome({
                rows_deleted: 3,
                media_removed: true,
                skipped_referenced_files: ['a.mp4'],
                cleanup_failures: ['b.mp4', 'c.mp4'],
            }),
            '/Promos'
        );
        expect(note).toContain('1 file was kept because subclips still reference it');
        expect(note).toContain('2 files could not be deleted');
    });

    it('does not repeat identical warnings', () => {
        const note = describePurgeOutcome(
            normalizePurgeOutcome({ rows_deleted: 1, media_removed: true, warnings: ['x', ' x ', ''] }),
            'A'
        );
        expect(note).toBe('x');
    });
});
