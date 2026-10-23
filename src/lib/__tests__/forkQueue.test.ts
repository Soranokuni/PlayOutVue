import { describe, expect, it } from 'vitest';
import {
    FORK_CONFLICT,
    isValidTag,
    planForkQueue,
    syncForkQueue,
    tagBase,
    takeTag,
    type DesiredRow,
    type ForkSyncDeps,
} from '../forkQueue';

const row = (id: string, fingerprint = `fp-${id}`): DesiredRow => ({ id, fingerprint });
const known = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('fork tags', () => {
    it('maps an occurrence or re-take suffix back to the row id', () => {
        expect(tagBase('0b6c4f2e-8a1d-4e7b-9c3a-5d2f1e0a9be1')).toBe('0b6c4f2e-8a1d-4e7b-9c3a-5d2f1e0a9be1');
        expect(tagBase('a:2')).toBe('a');
        expect(tagBase('a:t7')).toBe('a');
    });

    it('follows the server tag rule', () => {
        expect(isValidTag('0b6c4f2e-8a1d-4e7b-9c3a-5d2f1e0a9be1:2')).toBe(true);
        expect(isValidTag('')).toBe(false);
        expect(isValidTag('a b')).toBe(false);
        expect(isValidTag('x'.repeat(129))).toBe(false);
    });

    it('gives a re-take of the on-air row its own tag', () => {
        expect(takeTag('a', null, 1)).toBe('a');
        expect(takeTag('a', 'b', 2)).toBe('a');
        expect(takeTag('a', 'a', 3)).toBe('a:t3');
        expect(takeTag('a', 'a:2', 4)).toBe('a:t4');
    });
});

describe('planForkQueue', () => {
    it('queues everything on an empty queue', () => {
        const plan = planForkQueue('a', [row('b'), row('c')], [], known({}));
        expect(plan).toEqual({ tags: ['b', 'c'], keep: 0, clear: false });
    });

    it('keeps the longest common start and clears the rest', () => {
        const plan = planForkQueue('a', [row('b'), row('d')], ['b', 'c'], known({ b: 'fp-b', c: 'fp-c' }));
        expect(plan).toEqual({ tags: ['b', 'd'], keep: 1, clear: true });
    });

    it('requeues a waiting row whose trim or graphics changed', () => {
        const plan = planForkQueue('a', [row('b', 'fp-b2'), row('c')], ['b', 'c'], known({ b: 'fp-b', c: 'fp-c' }));
        expect(plan).toEqual({ tags: ['b', 'c'], keep: 0, clear: true });
    });

    it('never keeps a tag PlayOut did not queue (after a relaunch)', () => {
        const plan = planForkQueue('a', [row('b')], ['b'], known({}));
        expect(plan.keep).toBe(0);
        expect(plan.clear).toBe(true);
    });

    it('is a no-op when the queue already matches', () => {
        const plan = planForkQueue('a', [row('b'), row('c')], ['b', 'c'], known({ b: 'fp-b', c: 'fp-c' }));
        expect(plan).toEqual({ tags: ['b', 'c'], keep: 2, clear: false });
    });

    it('drops waiting items beyond a shorter window', () => {
        const plan = planForkQueue('a', [row('b')], ['b', 'c'], known({ b: 'fp-b', c: 'fp-c' }));
        expect(plan).toEqual({ tags: ['b'], keep: 1, clear: true });
    });

    it('suffixes a row that repeats inside the window (D2)', () => {
        // A short loop: a is on air, then b, then a again.
        const plan = planForkQueue('a', [row('b'), row('a')], [], known({}));
        expect(plan.tags).toEqual(['b', 'a:2']);
        const three = planForkQueue('x', [row('x'), row('x')], [], known({}));
        expect(three.tags).toEqual(['x:2', 'x:3']);
    });

    it('keeps a suffixed tag once its row is next', () => {
        // After the cut b is on air and a:2 waits: its tag must stay a:2.
        const plan = planForkQueue('b', [row('a'), row('c')], ['a:2'], known({ 'a:2': 'fp-a' }));
        expect(plan).toEqual({ tags: ['a:2', 'c'], keep: 1, clear: false });
    });
});

/** A fake engine queue that enforces EXPECT like the fork. */
function fakeEngine(initial: { foreground: string; waiting: string[] }) {
    const engine = { ...initial, waiting: [...initial.waiting], log: [] as string[] };
    let cutBeforeNextCommand: (() => void) | null = null;
    const deps: ForkSyncDeps = {
        async queueInfo() {
            engine.log.push('INFO');
            return { foregroundTag: engine.foreground, waiting: [...engine.waiting] };
        },
        async clear(kept, expect) {
            cutBeforeNextCommand?.();
            cutBeforeNextCommand = null;
            engine.log.push(`CLEAR ${kept.join(',') || '-'} EXPECT ${expect}`);
            if (engine.foreground !== expect) return FORK_CONFLICT;
            engine.waiting = engine.waiting.slice(0, kept.length);
            return 201;
        },
        async queue(_index, tag, expect) {
            cutBeforeNextCommand?.();
            cutBeforeNextCommand = null;
            engine.log.push(`QUEUE ${tag} EXPECT ${expect}`);
            if (engine.foreground !== expect) return FORK_CONFLICT;
            engine.waiting.push(tag);
            return 202;
        },
        isStale: () => false,
    };
    return {
        engine,
        deps,
        cutBefore(next: () => void) {
            cutBeforeNextCommand = next;
        },
    };
}

describe('syncForkQueue', () => {
    it('refills behind the on-air item with EXPECT', async () => {
        const { engine, deps } = fakeEngine({ foreground: 'a', waiting: [] });
        const result = await syncForkQueue('a', [row('b'), row('c')], known({}), deps);
        expect(result.status).toBe('ok');
        expect(engine.waiting).toEqual(['b', 'c']);
        expect(engine.log).toEqual(['INFO', 'QUEUE b EXPECT a', 'QUEUE c EXPECT a']);
    });

    it('edits with CLEAR AFTER the last kept item', async () => {
        const { engine, deps } = fakeEngine({ foreground: 'a', waiting: ['b', 'c'] });
        const result = await syncForkQueue('a', [row('b'), row('d')], known({ b: 'fp-b', c: 'fp-c' }), deps);
        expect(result).toMatchObject({ status: 'ok', tags: ['b', 'd'] });
        expect(engine.log).toEqual(['INFO', 'CLEAR b EXPECT a', 'QUEUE d EXPECT a']);
        expect(engine.waiting).toEqual(['b', 'd']);
    });

    it('reports a moved foreground instead of editing (the onair event follows)', async () => {
        const { engine, deps } = fakeEngine({ foreground: 'b', waiting: ['c'] });
        const result = await syncForkQueue('a', [row('b'), row('c')], known({}), deps);
        expect(result.status).toBe('foreground-moved');
        expect(engine.log).toEqual(['INFO']);
    });

    it('re-reads and retries when the cut lands during the edit (409)', async () => {
        const { engine, deps, cutBefore } = fakeEngine({ foreground: 'a', waiting: ['b', 'c'] });
        // The engine cuts a -> b between INFO and CLEAR: the CLEAR is refused,
        // and the retry sees b on air. The caller planned behind a, so the
        // sync stops and waits for the onair event.
        cutBefore(() => {
            engine.foreground = engine.waiting.shift()!;
        });
        const result = await syncForkQueue('a', [row('b'), row('d')], known({ b: 'fp-b', c: 'fp-c' }), deps);
        expect(engine.log).toEqual(['INFO', 'CLEAR b EXPECT a', 'INFO']);
        expect(result.status).toBe('foreground-moved');
        expect(engine.waiting).toEqual(['c']);
    });

    it('retries a 409 on QUEUE from a fresh INFO', async () => {
        const { engine, deps } = fakeEngine({ foreground: 'a', waiting: [] });
        let refused = false;
        const flaky: ForkSyncDeps = {
            ...deps,
            async queue(index, tag, expect) {
                if (!refused) {
                    refused = true;
                    return FORK_CONFLICT;
                }
                return deps.queue(index, tag, expect);
            },
        };
        const result = await syncForkQueue('a', [row('b')], known({}), flaky);
        expect(result).toMatchObject({ status: 'ok', attempts: 2 });
        expect(engine.waiting).toEqual(['b']);
    });

    it('gives up after the attempts with conflict', async () => {
        const { deps } = fakeEngine({ foreground: 'a', waiting: [] });
        const always409: ForkSyncDeps = { ...deps, queue: async () => FORK_CONFLICT };
        const result = await syncForkQueue('a', [row('b')], known({}), always409, 3);
        expect(result).toMatchObject({ status: 'conflict', attempts: 3 });
    });

    it('stops at a refused row and reports its index', async () => {
        const { engine, deps } = fakeEngine({ foreground: 'a', waiting: [] });
        const refuses: ForkSyncDeps = {
            ...deps,
            queue: async (index, tag, expect) => (tag === 'c' ? 404 : deps.queue(index, tag, expect)),
        };
        const result = await syncForkQueue('a', [row('b'), row('c'), row('d')], known({}), refuses);
        expect(result).toMatchObject({ status: 'failed', failedIndex: 1, tags: ['b'] });
        expect(engine.waiting).toEqual(['b']);
    });

    it('does nothing once stale', async () => {
        const { engine, deps } = fakeEngine({ foreground: 'a', waiting: [] });
        const result = await syncForkQueue('a', [row('b')], known({}), { ...deps, isStale: () => true });
        expect(result.status).toBe('stale');
        expect(engine.log).toEqual([]);
    });
});
