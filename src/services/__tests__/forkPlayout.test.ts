import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Fork mode end to end against a fake engine: the take recipe, the refill
 * behind the on-air item, natural cuts reported as `onair` events, rundown
 * edits (diff, CLEAR AFTER, 409), the take fence and the asset release.
 */
interface FakeEngine {
    foreground: string;
    /** Ticks into the foreground clip (50 per second on 1080i50). */
    foregroundFrame: number;
    waiting: string[];
    log: string[];
    /** Runs once before the next mutating fork command (a cut during an edit). */
    beforeNext: (() => void) | null;
}

const engine: FakeEngine = { foreground: '', foregroundFrame: 0, waiting: [], log: [], beforeNext: null };
/** AE-4: how the fake engine answers `FALLBACK LIST` (404 = empty folder). */
let fillerListCode = 202;

function fakeInvoke(cmd: string, args: any = {}): unknown {
    const mutate = () => {
        const hook = engine.beforeNext;
        engine.beforeNext = null;
        hook?.();
    };
    switch (cmd) {
        case 'caspar_fork_fallback_list':
            engine.log.push(`FALLBACK LIST ${args.folder}${args.shuffle ? ' SHUFFLE' : ''} TAG ${args.tag} STALL ${args.stall}`);
            return { code: fillerListCode, body: fillerListCode === 404 ? '404 FALLBACK LIST EMPTY' : '202 FALLBACK OK' };
        case 'caspar_fork_fallback':
            engine.log.push(`FALLBACK ${args.clip ?? 'CLEAR'}`);
            return { code: 202, body: '202 FALLBACK OK' };
        case 'caspar_fork_probe':
            return {
                channel: 1, layer: 10, instance: 1, frame: 0, eventSeq: 0,
                foreground: engine.foreground
                    ? { tag: engine.foreground, producer: 'ffmpeg', frame: engine.foregroundFrame, frames: 500, paused: false, starting: false }
                    : null,
                waiting: engine.waiting.map((tag) => ({ tag, producer: 'ffmpeg', auto: true })),
                fallback: { set: false, tag: '', active: false, stall: 0 },
            };
        case 'caspar_fork_queue_clear': {
            mutate();
            engine.log.push(`CLEAR${args.after ? ` AFTER ${args.after}` : ''}${args.expect ? ` EXPECT ${args.expect}` : ''}`);
            if (args.expect && args.expect !== engine.foreground) return { code: 409, body: '409 QUEUE CLEAR CONFLICT' };
            if (args.after) {
                const at = engine.waiting.indexOf(args.after);
                if (at < 0) return { code: 404, body: '404 QUEUE CLEAR FAILED' };
                engine.waiting = engine.waiting.slice(0, at + 1);
            } else {
                engine.waiting = [];
            }
            return { code: 201, body: '201 QUEUE CLEAR OK' };
        }
        case 'caspar_fork_item': {
            mutate();
            const { verb, item } = args;
            engine.log.push(`${verb.toUpperCase()} ${item.tag}${item.auto ? ' AUTO' : ''}${item.expect ? ` EXPECT ${item.expect}` : ''}`);
            if (item.expect && item.expect !== engine.foreground) return { code: 409, body: '409 QUEUE CONFLICT' };
            if (verb === 'loadbg') engine.waiting = [item.tag, ...engine.waiting.slice(1)];
            else engine.waiting.push(item.tag);
            return { code: 202, body: '202 OK' };
        }
        case 'caspar_fork_queue_remove':
            engine.log.push(`REMOVE ${args.tag}`);
            engine.waiting = engine.waiting.filter((t) => t !== args.tag);
            return { code: 202, body: '202 QUEUE REMOVE OK' };
        case 'caspar_fork_onair':
            engine.log.push(`ONAIR ${args.tag} x${args.actions.length}`);
            return args.actions.map(() => ({ code: 202, body: '202 ONAIR OK' }));
        case 'caspar_send_command':
            engine.log.push(args.cmd);
            if (args.cmd === 'PLAY 1-10') engine.foreground = engine.waiting.shift() ?? '';
            return '202 OK';
        case 'verify_playback_ready':
            return { ready: true, fileExists: true, hasDbEntry: true, hasSidecar: true, qcPassed: true, mezzanineOk: true, warnings: [], durationMs: 10_000, fpsNum: 25, fpsDen: 1, error: '' };
        case 'compute_frame_trim': {
            const inFrame = Math.round((args.trimInMs || 0) / 40);
            const outFrame = Math.round((args.trimOutMs || 10_000) / 40);
            return { in_frame: inFrame, out_frame: outFrame, duration_frames: outFrame - inFrame, fps_rational: '25/1' };
        }
        case 'prepare_caspar_media_path':
            return String(args.path).replace('D:/media/', '');
        default:
            return null;
    }
}

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn((cmd: string, args?: any) => Promise.resolve(fakeInvoke(cmd, args))),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn().mockResolvedValue(() => {}),
    emit: vi.fn().mockResolvedValue(undefined),
}));

import { setActivePinia, createPinia } from 'pinia';
import {
    applyForkFallbackSettings,
    casparPlayoutService,
    engineRecovery,
    isCasparConnected,
    __playoutQueueTestHooks as queue,
    __forkTestHooks as fork,
} from '../caspar';
import { releaseAssetsBeforeDelete } from '../../lib/assetRelease';
import { useRundownStore } from '../../stores/rundown';
import { useSettingsStore } from '../../stores/settings';
import { fallbackHealth, resetFallbackHealth } from '../../lib/fallbackHealth';

const item = (id: string, extra: Record<string, unknown> = {}) =>
    ({
        id,
        playoutvueId: `asset-${id}`,
        type: 'video',
        filename: `${id}.mp4`,
        path: `D:/media/${id}.mp4`,
        duration_ms: 10_000,
        trim_in_ms: 0,
        trim_out_ms: 10_000,
        ingestorStatus: 'ready',
        ...extra,
    }) as any;

let seq = 0;
const event = (kind: string, tag: string, reason = 'auto', file?: string) =>
    fork.handleEngineEvent({ seq: ++seq, kind, tag, frame: seq * 10, timeMs: 0, reason, ...(file ? { file } : {}) });

/** The engine cuts to the head of its queue, as an AUTO hand-over does. */
const engineCut = () => {
    const previous = engine.foreground;
    engine.foreground = engine.waiting.shift() ?? '';
    event('ended', previous, 'ended');
    event('offair', previous);
    if (engine.foreground) event('onair', engine.foreground);
};

const settle = async () => {
    for (let round = 0; round < 3; round += 1) {
        for (let i = 0; i < 40; i += 1) await Promise.resolve();
        await fork.syncIdle();
    }
};

const advances: Array<string | null> = [];

async function startOn(items: any[], index = 0) {
    queue.setState(items, null, false);
    await casparPlayoutService.play(items, index);
    await settle();
    // The take reaches air.
    event('onair', engine.foreground, 'take');
    await settle();
}

describe('fork mode playout', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        // The progress bar's rAF/visibility timer needs a DOM; not under test here.
        vi.spyOn(useRundownStore(), 'startPlaybackProgressTimer').mockImplementation(() => {});
        engine.foreground = '';
        engine.foregroundFrame = 0;
        engine.waiting = [];
        engine.log = [];
        engine.beforeNext = null;
        advances.length = 0;
        fillerListCode = 202;
        resetFallbackHealth();
        isCasparConnected.value = true;
        fork.setEngineMode('fork');
        casparPlayoutService.onAdvance((key) => advances.push(key));
    });

    afterEach(() => {
        fork.setEngineMode('unknown');
        isCasparConnected.value = false;
    });

    it('takes with QUEUE CLEAR, tagged LOADBG, ONAIR, PLAY, then queues two ahead', async () => {
        await startOn([item('a'), item('b'), item('c'), item('d')]);

        expect(engine.log.slice(0, 4)).toEqual(['CLEAR', 'LOADBG a', 'ONAIR a x4', 'PLAY 1-10']);
        expect(engine.foreground).toBe('a');
        expect(engine.waiting).toEqual(['b', 'c']);
        expect(engine.log).toContain('QUEUE b AUTO EXPECT a');
        expect(engine.log).toContain('QUEUE c AUTO EXPECT a');
        expect(fork.state()).toMatchObject({ foregroundTag: 'a', waitingTags: ['b', 'c'], currentKey: 'a' });
        // No untagged LOADBG and no PLAY of a clip: the take is the fork recipe.
        expect(engine.log.some((l) => l.startsWith('LOADBG 1-10') || l.startsWith('PLAY 1-10 "'))).toBe(false);
    });

    it('follows a natural cut from the onair event and refills', async () => {
        await startOn([item('a'), item('b'), item('c'), item('d')]);
        engine.log = [];

        engineCut();
        await settle();

        expect(fork.state().currentKey).toBe('b');
        expect(advances).toContain('b');
        expect(engine.waiting).toEqual(['c', 'd']);
        expect(engine.log).toEqual(['QUEUE d AUTO EXPECT b', 'ONAIR d x3']);
    });

    it('applies a rundown edit as CLEAR AFTER the kept prefix', async () => {
        const items = [item('a'), item('b'), item('c'), item('d')];
        await startOn(items);
        engine.log = [];

        // The operator deletes c: the window becomes b, d.
        await casparPlayoutService.refreshQueue([items[0], items[1], items[3]]);
        await settle();

        expect(engine.waiting).toEqual(['b', 'd']);
        expect(engine.log).toEqual(['CLEAR AFTER b EXPECT a', 'QUEUE d AUTO EXPECT a', 'ONAIR d x3']);
    });

    it('requeues a waiting row whose trim changed', async () => {
        const items = [item('a'), item('b'), item('c')];
        await startOn(items);
        engine.log = [];

        await casparPlayoutService.refreshQueue([items[0], { ...items[1], trim_in_ms: 2_000 }, items[2]]);
        await settle();

        expect(engine.log.slice(0, 2)).toEqual(['CLEAR EXPECT a', 'QUEUE b AUTO EXPECT a']);
        expect(engine.waiting).toEqual(['b', 'c']);
    });

    it('a cut during an edit is refused (409) and the queue is rebuilt behind the new item', async () => {
        const items = [item('a'), item('b'), item('c'), item('d'), item('e')];
        await startOn(items);
        engine.log = [];

        // The engine cuts a -> b just before the edit's CLEAR lands.
        engine.beforeNext = () => {
            engine.foreground = engine.waiting.shift() ?? '';
        };
        await casparPlayoutService.refreshQueue([items[0], items[1], items[3], items[4]]);
        await settle();
        expect(engine.log[0]).toBe('CLEAR AFTER b EXPECT a');
        expect(engine.foreground).toBe('b');

        // The onair event for b arrives: PlayOut follows it and plans behind b.
        event('onair', 'b');
        await settle();
        expect(fork.state().currentKey).toBe('b');
        expect(engine.waiting).toEqual(['d', 'e']);
        expect(engine.log).toContain('CLEAR EXPECT b');
    });

    it('a take fences the old queue: its late cut cannot claim the channel', async () => {
        const items = [item('a'), item('b'), item('c'), item('d')];
        await startOn(items);

        const taking = casparPlayoutService.play(items, 3);
        // The engine cuts a -> b from the old queue before the take's CLEAR.
        event('onair', 'b');
        await taking;
        await settle();

        expect(fork.state().currentKey).toBe('d');
        expect(advances).not.toContain('b');
        expect(engine.foreground).toBe('d');
    });

    it('a re-take of the on-air row gets its own tag', async () => {
        const items = [item('a'), item('b')];
        await startOn(items);
        engine.log = [];

        await casparPlayoutService.play(items, 0);
        await settle();

        const loadbg = engine.log.find((l) => l.startsWith('LOADBG'));
        expect(loadbg).toMatch(/^LOADBG a:t\d+$/);
        event('onair', engine.foreground, 'take');
        await settle();
        expect(fork.state().currentKey).toBe('a');
    });

    it('takes a live row explicitly when the clip before it ends', async () => {
        const items = [item('a'), item('live', { type: 'live', path: 'DECKLINK 1' }), item('c')];
        await startOn(items);
        // Nothing can be queued behind a: the next row is live.
        expect(engine.waiting).toEqual([]);

        event('ended', 'a', 'ended');
        await settle();

        expect(fork.state().currentKey).toBe('live');
        expect(engine.log).toContain('PLAY 1-20 DECKLINK 1');
    });

    it('removes a queued row before its asset is deleted, and keeps it out', async () => {
        await startOn([item('a'), item('b'), item('c'), item('d')]);
        engine.log = [];

        const release = releaseAssetsBeforeDelete(['asset-b']);
        expect(release).not.toBeNull();
        await release;
        await settle();

        expect(engine.log[0]).toBe('REMOVE b');
        expect(engine.waiting).not.toContain('b');
        expect(engine.waiting).toEqual(['c', 'd']);
    });

    it('stops at the end of the rundown like the stock path without "fill on dry"', async () => {
        useSettingsStore().updateSettings({ forkFillOnDry: false });
        await startOn([item('a')]);
        expect(engine.waiting).toEqual([]);

        event('ended', 'a', 'ended');
        await settle();

        expect(fork.state().currentKey).toBeNull();
        expect(engine.log).toContain('CLEAR 1-10');
        expect(advances[advances.length - 1]).toBeNull();
    });

    it('F1: a natural end of the rundown leaves the fallback on air', async () => {
        await startOn([item('a')]);

        event('ended', 'a', 'ended');
        event('offair', 'a');
        event('onair', 'fallback:1', 'ended', 'promo_a.mov');
        await settle();

        expect(fork.state().currentKey).toBeNull();
        expect(engine.log).not.toContain('CLEAR 1-10');
        expect(advances[advances.length - 1]).toBeNull();
        expect(fallbackHealth.rundownFinished).toBe(true);
        expect(fallbackHealth.onAir).toMatchObject({ file: 'promo_a.mov', count: 1 });

        // The next filler of the same run only updates the readout.
        event('onair', 'fallback:2', 'ended', 'promo_b.mov');
        await settle();
        expect(fallbackHealth.onAir).toMatchObject({ file: 'promo_b.mov', count: 2 });
        expect(fork.state().foregroundTag).toBe('fallback:2');

        // Stop stays an explicit CLEAR.
        await casparPlayoutService.stop();
        expect(engine.log).toContain('CLEAR 1-10');
        expect(fallbackHealth.onAir).toBeNull();
        expect(fallbackHealth.rundownFinished).toBe(false);
    });

    it('F1: also when the fallback reaches air before the ended event', async () => {
        await startOn([item('a')]);

        event('onair', 'fallback:1', 'ended', 'promo_a.mov');
        await settle();
        event('ended', 'a', 'ended');
        await settle();

        expect(fork.state().currentKey).toBeNull();
        expect(engine.log).not.toContain('CLEAR 1-10');
        expect(fallbackHealth.rundownFinished).toBe(true);
    });

    it('fillers clear the advisory to the logo and the TP / rating layers', async () => {
        await startOn([item('a'), item('b', { ingestorStatus: 'processing' })]);
        const { invoke } = await import('@tauri-apps/api/core');
        const calls = vi.mocked(invoke).mock.calls;
        const before = calls.length;

        event('onair', 'fallback:1', 'ended', 'promo_a.mov');
        await settle();

        const after = calls.slice(before);
        const cleared = after.filter(([cmd]) => cmd === 'caspar_clear_layer').map(([, args]) => (args as any).layer);
        expect(cleared).toEqual(expect.arrayContaining([31, 34]));
        const cg = after.find(([cmd]) => cmd === 'caspar_cg_update' || cmd === 'caspar_cg_add');
        expect(cg).toBeTruthy();
        // A dry queue mid-rundown is not the end: the row stays PlayOut's.
        expect(fork.state().currentKey).toBe('a');
        expect(fallbackHealth.rundownFinished).toBe(false);
    });

    it('arms the filler folder with FALLBACK LIST, and the clip when the folder is refused', async () => {
        const settings = useSettingsStore();
        settings.updateSettings({ forkFillerFolder: 'D:\\fillers', forkFillerShuffle: true, forkFallbackClip: 'D:/fallback/slate.mov', forkStallTicks: 50 });
        await applyForkFallbackSettings();
        expect(engine.log).toContain('FALLBACK LIST D:/fillers SHUFFLE TAG fallback STALL 50');
        expect(engine.log).not.toContain('FALLBACK D:/fallback/slate.mov');
        expect(fallbackHealth.mode).toBe('list');

        engine.log = [];
        fillerListCode = 404;
        await applyForkFallbackSettings();
        expect(engine.log).toEqual(['FALLBACK LIST D:/fillers SHUFFLE TAG fallback STALL 50', 'FALLBACK D:/fallback/slate.mov']);
        expect(fallbackHealth.mode).toBe('clip');
        expect(fallbackHealth.fillersUsable).toBe(false);
    });

    it('after a relaunch, fillers on air are not a foreign clip to adopt', async () => {
        queue.setState([item('a'), item('b')], null, false);
        engine.foreground = 'fallback:7';
        expect(await fork.adoptForkOnAir()).toBe(false);
        expect(fork.state().foregroundTag).toBe('fallback:7');
        expect(fallbackHealth.onAir).not.toBeNull();
        expect(engine.log).not.toContain('CLEAR 1-10');
    });

    it('a take after the fillers ends the "on fillers" state', async () => {
        await startOn([item('a')]);
        event('ended', 'a', 'ended');
        event('onair', 'fallback:1', 'ended', 'promo_a.mov');
        await settle();
        expect(fallbackHealth.onAir).not.toBeNull();

        await casparPlayoutService.play([item('a')], 0);
        await settle();
        event('onair', engine.foreground, 'take');
        await settle();
        expect(fallbackHealth.onAir).toBeNull();
        expect(fallbackHealth.rundownFinished).toBe(false);
    });

    it('the fallback going on air does not move the on-air row', async () => {
        // b is still being ingested: nothing can wait behind a.
        await startOn([item('a'), item('b', { ingestorStatus: 'processing' })]);
        expect(engine.waiting).toEqual([]);

        // The engine runs dry and shows its fallback clip.
        event('onair', 'fallback', 'ended');
        await settle();
        expect(fork.state().foregroundTag).toBe('fallback');
        expect(fork.state().currentKey).toBe('a');
        expect(fork.state().waitingTags).toEqual([]);
    });

    it('adopts the row on air by its tag after a relaunch and rebuilds the queue', async () => {
        const items = [item('a'), item('b'), item('c'), item('d')];
        queue.setState(items, null, false);
        // The engine kept playing while PlayOut was away: b (queued as b:2 by
        // the previous session) is 8 s in, with tags this session never saw.
        engine.foreground = 'b:2';
        engine.foregroundFrame = 400;
        engine.waiting = ['c', 'x'];

        expect(await fork.adoptForkOnAir()).toBe(true);
        await settle();

        expect(fork.state()).toMatchObject({ currentKey: 'b', foregroundTag: 'b:2' });
        expect(advances).toContain('b');
        // Unknown waiting tags are never trusted: cleared and queued again.
        expect(engine.log).toContain('CLEAR EXPECT b:2');
        expect(engine.waiting).toEqual(['c', 'd']);
    });

    it('does not adopt the fallback or an empty layer', async () => {
        queue.setState([item('a')], null, false);
        engine.foreground = 'fallback';
        expect(await fork.adoptForkOnAir()).toBe(false);
        engine.foreground = '';
        expect(await fork.adoptForkOnAir()).toBe(false);
    });

    it('an engine restart drops the queue state and enters the outage path', async () => {
        await startOn([item('a'), item('b'), item('c')]);
        expect(fork.state().waitingTags).toEqual(['b', 'c']);

        fork.engineInstanceChanged('event-seq-reset');

        expect(fork.state()).toMatchObject({ foregroundTag: null, waitingTags: [], clipTags: [] });
        expect(['outage', 'restoring']).toContain(engineRecovery.value.phase);
    });

    it('stock mode keeps the old path', async () => {
        fork.setEngineMode('stock');
        expect(releaseAssetsBeforeDelete(['asset-b'])).toBeNull();
    });
});
