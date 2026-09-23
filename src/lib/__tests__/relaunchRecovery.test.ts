import { describe, it, expect } from 'vitest';
import {
    planRelaunchRecovery,
    resolveAdoptionIndex,
    schedulePoint,
    type RelaunchInput,
    type RelaunchPolicy,
    type ScheduleItem,
} from '../relaunchRecovery';

const MIN = 60_000;
const policy: RelaunchPolicy = { resumeWithinMs: 30_000, joinWithinMs: 30 * MIN, countdownS: 10 };

// A (1 min) B (1 min) C (1 min) D (10 min) E (10 min)
const queue: ScheduleItem[] = [
    { id: 'a', durationMs: MIN },
    { id: 'b', durationMs: MIN },
    { id: 'c', durationMs: MIN },
    { id: 'd', durationMs: 10 * MIN },
    { id: 'e', durationMs: 10 * MIN },
];

const T0 = 1_000_000;
/** B on air, 20 s in, next armed = C. */
const input = (over: Partial<RelaunchInput> = {}): RelaunchInput => ({
    key: 'b',
    positionMs: 20_000,
    durationMs: MIN,
    nextKey: 'c',
    writtenAtMs: T0,
    ...over,
});

describe('resolveAdoptionIndex', () => {
    const parent = { id: 'p', path: 'D:/m/show.mxf', trimInMs: 0, trimOutMs: 0 };
    const part1 = { id: 's1', path: 'D:/m/show.mxf', trimInMs: 0, trimOutMs: 600_000 };
    const part2 = { id: 's2', path: 'D:/m/show.mxf', trimInMs: 600_000, trimOutMs: 1_200_000 };
    const other = { id: 'x', path: 'D:/m/promo.mov', trimInMs: 0, trimOutMs: 0 };

    it('prefers the identity hint over a file-name match', () => {
        const q = [part1, other, part2];
        expect(resolveAdoptionIndex(q, 'SHOW.MXF', 10_000, [{ key: 's2' }])).toBe(2);
    });

    it('ignores a hint whose file is not the one on air', () => {
        const q = [part1, other, part2];
        expect(resolveAdoptionIndex(q, 'promo.mov', 10_000, [{ key: 's2' }])).toBe(1);
    });

    it('picks the sub-clip whose trim window contains the playhead', () => {
        const q = [part1, other, part2];
        expect(resolveAdoptionIndex(q, 'show.mxf', 700_000, [])).toBe(2);
        expect(resolveAdoptionIndex(q, 'show.mxf', 100_000, [])).toBe(0);
    });

    it('breaks a tie by distance to the checkpoint row', () => {
        const q = [parent, other, other, parent];
        expect(resolveAdoptionIndex(q, 'show.mxf', 5_000, [], 3)).toBe(3);
    });

    it('returns -1 when the file is not in the rundown', () => {
        expect(resolveAdoptionIndex([other], 'unknown.mp4', 0, [])).toBe(-1);
    });
});

describe('schedulePoint', () => {
    it('stays in the same item while it would still be playing', () => {
        expect(schedulePoint(input(), queue, T0 + 10_000)).toEqual({ kind: 'join', index: 1, seekMs: 30_000 });
    });

    it('walks into later items by the elapsed wall time', () => {
        // 40 s left of B, then C (60 s): at +130 s we are 30 s into D.
        expect(schedulePoint(input(), queue, T0 + 130_000)).toEqual({ kind: 'join', index: 3, seekMs: 30_000 });
    });

    it('returns null once the rundown would have ended', () => {
        expect(schedulePoint(input(), queue, T0 + 60 * MIN)).toBeNull();
    });

    it('skips rows flagged as errors', () => {
        const q = queue.map((item) => (item.id === 'c' ? { ...item, ingestorStatus: 'error' } : item));
        // 40 s left of B, C skipped: at +50 s we are 10 s into D.
        expect(schedulePoint(input(), q, T0 + 50_000)).toEqual({ kind: 'join', index: 3, seekMs: 10_000 });
    });

    it('does not join the last seconds of an item', () => {
        // +39 s: 59 s into B, 1 s left -> start C.
        expect(schedulePoint(input(), queue, T0 + 39_000)).toEqual({ kind: 'join', index: 2, seekMs: 0 });
    });
});

describe('planRelaunchRecovery', () => {
    it('short outage: resumes the interrupted clip with a countdown', () => {
        const offer = planRelaunchRecovery(input(), queue, 'empty', T0 + 12_000, policy);
        expect(offer.primary).toEqual({ kind: 'resume', index: 1, seekMs: 19_000 });
        expect(offer.alternatives).toEqual([{ kind: 'join', index: 1, seekMs: 32_000 }]);
        expect(offer.autoConfirmS).toBe(10);
        expect(offer.offAirMs).toBe(12_000);
    });

    it('medium outage: joins the schedule, resume offered as the alternative', () => {
        const offer = planRelaunchRecovery(input(), queue, 'empty', T0 + 5 * MIN, policy);
        expect(offer.primary.kind).toBe('join');
        expect(offer.primary.index).toBe(3);
        expect(offer.alternatives[0]).toEqual({ kind: 'resume', index: 1, seekMs: 19_000 });
        expect(offer.autoConfirmS).toBe(10);
    });

    it('long outage: holds and waits for the operator', () => {
        const offer = planRelaunchRecovery(input(), queue, 'empty', T0 + 45 * MIN, policy);
        expect(offer.primary.kind).toBe('hold');
        expect(offer.autoConfirmS).toBeNull();
        expect(offer.alternatives.map((a) => a.kind)).toContain('resume');
    });

    it('counts off-air time from when the hardware ran out, not from when PlayOut died', () => {
        // PlayOut died 20 s into B; CasparCG played the rest of B (40 s) and
        // the armed C (60 s), then froze. 110 s later only 10 s were dark.
        const offer = planRelaunchRecovery(input(), queue, 'ended-on-next', T0 + 110_000, policy);
        expect(offer.offAirMs).toBe(10_000);
        expect(offer.primary).toEqual({ kind: 'resume', index: 3, seekMs: 0 });
    });

    it('frozen on the checkpoint clip itself: continue with the next one', () => {
        const offer = planRelaunchRecovery(input(), queue, 'ended-on-current', T0 + 45_000, policy);
        expect(offer.offAirMs).toBe(5_000);
        expect(offer.primary).toEqual({ kind: 'resume', index: 2, seekMs: 0 });
    });

    it('never auto-confirms over a foreign clip, a paused clip or a crash loop', () => {
        expect(planRelaunchRecovery(input(), queue, 'foreign', T0 + 5_000, policy).autoConfirmS).toBeNull();
        expect(planRelaunchRecovery(input({ paused: true }), queue, 'empty', T0 + 5_000, policy).autoConfirmS).toBeNull();
        expect(planRelaunchRecovery(input(), queue, 'empty', T0 + 5_000, policy, { crashLoop: true }).autoConfirmS).toBeNull();
    });

    it('a zero countdown always waits for the operator', () => {
        expect(planRelaunchRecovery(input(), queue, 'empty', T0 + 5_000, { ...policy, countdownS: 0 }).autoConfirmS).toBeNull();
    });

    it('holds when the interrupted row was deleted', () => {
        const offer = planRelaunchRecovery(input({ key: 'gone' }), queue, 'empty', T0 + 5_000, policy);
        expect(offer.primary.kind).toBe('hold');
    });
});
