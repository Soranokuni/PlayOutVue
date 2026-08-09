import { describe, expect, it } from 'vitest';
import { classifyPlayoutFailure, shouldFlagItemFailure } from '../playoutFailurePolicy';

describe('playout failure policy', () => {
    it('flags confirmed content failures only', () => {
        expect(classifyPlayoutFailure(new Error('AMCP command failed: Error (code 404) FILE NOT FOUND')).kind).toBe('content');
        expect(shouldFlagItemFailure(classifyPlayoutFailure(new Error('Degenerate trim')))).toBe(true);
    });

    it('keeps transport failures retryable and non-destructive', () => {
        expect(classifyPlayoutFailure(new Error('connection refused')).kind).toBe('transient');
        expect(shouldFlagItemFailure(classifyPlayoutFailure(new Error('connection refused')))).toBe(false);
    });

    it('ignores superseded requests', () => {
        expect(classifyPlayoutFailure(new Error('request superseded')).kind).toBe('cancelled');
    });
});
