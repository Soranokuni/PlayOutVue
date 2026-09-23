import { describe, it, expect } from 'vitest';
import { planEngineRecovery, type EngineLossSnapshot } from '../engineRecovery';

const loss = (over: Partial<EngineLossSnapshot> = {}): EngineLossSnapshot => ({
    key: 'b',
    positionMs: 42_000,
    durationMs: 60_000,
    lostAt: 0,
    graphicsOnAir: true,
    crawlOnAir: false,
    ...over,
});

const queue = [
    { id: 'a', type: 'video', ingestorStatus: 'ready' },
    { id: 'b', type: 'video', ingestorStatus: 'ready' },
    { id: 'c', type: 'video', ingestorStatus: 'ready' },
];

describe('planEngineRecovery', () => {
    it('resumes the interrupted clip just before where it stopped', () => {
        expect(planEngineRecovery(loss(), queue, { autoResume: true })).toEqual({ kind: 'resume', index: 1, seekMs: 41_000 });
    });

    it('never seeks before the start of the window', () => {
        expect(planEngineRecovery(loss({ positionMs: 400 }), queue, { autoResume: true })).toEqual({ kind: 'resume', index: 1, seekMs: 0 });
    });

    it('takes the next item instead of resuming the last second of a clip', () => {
        expect(planEngineRecovery(loss({ positionMs: 59_500 }), queue, { autoResume: true })).toEqual({ kind: 'advance', index: 2 });
    });

    it('skips rows flagged as errors when advancing', () => {
        const q = [...queue.slice(0, 2), { id: 'c', type: 'video', ingestorStatus: 'error' }, { id: 'd', type: 'video' }];
        expect(planEngineRecovery(loss({ positionMs: 59_900 }), q, { autoResume: true })).toEqual({ kind: 'advance', index: 3 });
    });

    it('holds when the finished clip was the last one', () => {
        expect(planEngineRecovery(loss({ key: 'c', positionMs: 59_900 }), queue, { autoResume: true }).kind).toBe('hold');
    });

    it('resumes with an unknown duration rather than guessing it finished', () => {
        expect(planEngineRecovery(loss({ durationMs: 0 }), queue, { autoResume: true })).toEqual({ kind: 'resume', index: 1, seekMs: 41_000 });
    });

    it('re-takes a live source from its start', () => {
        const q = [{ id: 'b', type: 'live' }];
        expect(planEngineRecovery(loss(), q, { autoResume: true })).toEqual({ kind: 'resume', index: 0, seekMs: 0 });
    });

    it('holds when resume is disabled, nothing was on air, or the row is gone', () => {
        expect(planEngineRecovery(loss(), queue, { autoResume: false }).kind).toBe('hold');
        expect(planEngineRecovery(null, queue, { autoResume: true }).kind).toBe('hold');
        expect(planEngineRecovery(loss({ key: 'zz' }), queue, { autoResume: true }).kind).toBe('hold');
    });
});
