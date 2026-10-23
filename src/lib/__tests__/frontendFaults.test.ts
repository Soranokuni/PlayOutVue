import { describe, it, expect, beforeEach } from 'vitest';
import { frontendFaults, recordFrontendFault, dismissFrontendFault, clearFrontendFaults, resolveFrontendFaults } from '../frontendFaults';

describe('frontendFaults (operator toast source)', () => {
    beforeEach(() => clearFrontendFaults());

    it('records a fault with its first line only', () => {
        recordFrontendFault('vue', 'TypeError: boom\n    at render (App.vue:12)');
        expect(frontendFaults.value).toHaveLength(1);
        expect(frontendFaults.value[0]?.message).toBe('TypeError: boom');
        expect(frontendFaults.value[0]?.source).toBe('vue');
    });

    it('collapses repeats of the same fault into a counter', () => {
        recordFrontendFault('unhandledrejection', 'Network down');
        recordFrontendFault('unhandledrejection', 'Network down');
        recordFrontendFault('unhandledrejection', 'Network down');
        expect(frontendFaults.value).toHaveLength(1);
        expect(frontendFaults.value[0]?.count).toBe(3);
    });

    it('keeps only the most recent faults', () => {
        for (let i = 0; i < 10; i += 1) recordFrontendFault('vue', `fault ${i}`);
        expect(frontendFaults.value).toHaveLength(4);
        expect(frontendFaults.value[0]?.message).toBe('fault 6');
    });

    it('dismisses by id', () => {
        recordFrontendFault('vue', 'a');
        recordFrontendFault('vue', 'b');
        const id = frontendFaults.value[0]!.id;
        dismissFrontendFault(id);
        expect(frontendFaults.value.map((f) => f.message)).toEqual(['b']);
    });

    it('resolves the toasts of one source whose fault is over', () => {
        recordFrontendFault('caspar-playout', 'Fallback clip "playout/emergency" could not be set (404)');
        recordFrontendFault('caspar-playout', 'CasparCG reported x stalled');
        recordFrontendFault('fallback', 'Fallback clip self-test failed: not found');
        resolveFrontendFaults('caspar-playout', (m) => m.startsWith('Fallback clip "'));
        expect(frontendFaults.value.map((f) => f.source + ': ' + f.message)).toEqual([
            'caspar-playout: CasparCG reported x stalled',
            'fallback: Fallback clip self-test failed: not found',
        ]);
        resolveFrontendFaults('fallback');
        expect(frontendFaults.value).toHaveLength(1);
    });
});
