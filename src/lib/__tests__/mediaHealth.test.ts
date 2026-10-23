import { describe, expect, it } from 'vitest';
import { describeLibrary, pickHeadline, type HealthItem } from '../mediaHealth';

const rootReady: HealthItem = { key: 'media-root', tone: 'ready', label: 'Media root', detail: '', section: 'media' };

describe('describeLibrary', () => {
    it('reports nothing while the transcoder answers', () => {
        expect(describeLibrary(true, true)).toBeNull();
    });

    it('reports nothing before a heartbeat of this session (the offline flag is persisted)', () => {
        expect(describeLibrary(false, false)).toBeNull();
    });

    it('a transcoder that stopped answering outranks a verified media root', () => {
        const library = describeLibrary(false, true)!;
        expect(library).toMatchObject({ key: 'library', tone: 'warning', label: 'Library offline' });
        expect(pickHeadline([rootReady, library])?.key).toBe('library');
    });

    it('a broken fallback still comes first', () => {
        const broken: HealthItem = { key: 'fallback', tone: 'error', label: 'Fallback broken', detail: '', section: 'playout' };
        expect(pickHeadline([rootReady, describeLibrary(false, true)!, broken])?.key).toBe('fallback');
    });
});
