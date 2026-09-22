// @vitest-environment happy-dom
//
// Known-bug reproductions from TRIM-CONTRACT-AUDIT.md (2026-09-22).
//
// Each test asserts the *correct* behaviour and is marked `it.fails`, so the
// suite stays green while the bug exists. When a fix lands, its test starts
// passing, vitest reports that as a failure, and the fixer flips `it.fails` to
// `it`: the reproduction becomes the regression guard.
//
// Not covered here: C-4 (Rust mapping, belongs in ingestor_api.rs tests), C-5
// (ordering inside TrimPanel.saveNonDestructive), C-7 (Rust compute_frame_trim),
// C-9 (a design decision, TRIM-CONTRACT-AUDIT §5, not a bug).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { useRundownStore } from '../rundown';
import { hydrateItem as playoutHydrate } from '../../lib/rundownHydrator';
import { computeTrimFields } from '../../lib/trimCommands';
import { clampTrimIn } from '../../utils/frameMath';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('../../services/caspar', () => ({
    playStartTime: { value: 0 },
    casparPlayoutService: { refreshQueue: vi.fn(() => Promise.resolve()) }
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const PATH = 'D:/media/videos/show.mp4';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const draft = (over: Record<string, any> = {}) => ({
    playoutvueId: 'parent-uuid',
    filename: 'Show',
    path: PATH,
    shortPath: '',
    type: 'video',
    libraryIndicator: 'none',
    duration: 100,
    seek: 0,
    length: 0,
    mezzanine_ok: true,
    fps: 25,
    total_frames: 2500,
    duration_ms: 100_000,
    ...over
});

const libraryAsset = (over: Record<string, any>) => ({
    uuid: 'parent-uuid',
    current_path: PATH,
    display_name: 'Show',
    duration_ms: 100_000,
    trim_in_ms: 0,
    trim_out_ms: 100_000,
    status: 'ready',
    mezzanine_ok: true,
    ...over
});

/** The transcoder is unreachable; paths exist on disk. */
const offline = async (cmd: string, args: any) => {
    if (cmd === 'verify_paths_exist') return Object.fromEntries((args.paths as string[]).map((p) => [p, true]));
    if (cmd === 'resolve_ingestor_asset' || cmd === 'resolve_ingestor_assets_batch') throw new Error('offline');
    return undefined;
};

const trims = (store: ReturnType<typeof useRundownStore>) =>
    store.currentPlaylist!.items.map((i) => [i.playoutvueId, i.trim_in_ms, i.trim_out_ms]);

describe('TRIM-CONTRACT-AUDIT known bugs', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.mocked(invoke).mockReset();
        vi.mocked(invoke).mockImplementation(offline);
    });

    it('C-1: trimming a parent leaves its sub-clips alone', async () => {
        const store = useRundownStore();
        store.addItem(draft() as any);
        store.addItem(draft({ playoutvueId: 'sub-uuid', filename: 'Sub', inPoint: 30_000, outPoint: 40_000, trim_in_ms: 30_000, trim_out_ms: 40_000 }) as any);
        store.addItem(draft({ playoutvueId: 'local-subclip:x', filename: 'Local', inPoint: 50_000, outPoint: 60_000, trim_in_ms: 50_000, trim_out_ms: 60_000 }) as any);
        await flush();

        // What TrimPanel.saveNonDestructive does for a library parent asset. The
        // path is passed on purpose: rows sharing the file must not match on it.
        store.updateAssetTrim({ id: 'parent-uuid', uuid: 'parent-uuid', path: PATH } as any, 5_000, 20_000);

        expect(trims(store)).toEqual([
            ['parent-uuid', 5_000, 20_000],
            ['sub-uuid', 30_000, 40_000],
            ['local-subclip:x', 50_000, 60_000],
        ]);
    });

    it('C-1: a local asset trim reaches its own rows by id, not other rows on the file', async () => {
        const store = useRundownStore();
        store.addItem(draft({ playoutvueId: `local:${PATH}` }) as any);
        store.addItem(draft({ playoutvueId: 'local-subclip:z', inPoint: 50_000, outPoint: 60_000, trim_in_ms: 50_000, trim_out_ms: 60_000 }) as any);
        await flush();

        store.updateAssetTrim({ id: `local:${PATH}`, uuid: `local:${PATH}`, path: PATH } as any, 5_000, 20_000);

        expect(trims(store)).toEqual([
            [`local:${PATH}`, 5_000, 20_000],
            ['local-subclip:z', 50_000, 60_000],
        ]);
    });

    it.fails('C-2: a trimmed sub-clip survives a playlist save and reload while offline', async () => {
        const store = useRundownStore();
        store.addItem(draft({ playoutvueId: 'sub-uuid', inPoint: 30_000, outPoint: 40_000, trim_in_ms: 30_000, trim_out_ms: 40_000, duration: 10 }) as any);
        await flush();

        store.deserializeRundown(store.serializeRundown('x'));
        await flush();
        const row = store.currentPlaylist!.items[0]!;
        const hydrated = playoutHydrate({
            id: row.id, path: row.path, duration_ms: row.duration_ms,
            trim_in_ms: row.trim_in_ms, trim_out_ms: row.trim_out_ms, fps: 25,
        } as any);

        expect(row.duration_ms).toBe(100_000);
        expect(hydrated.trim_in_ms).toBe(30_000);
        expect(hydrated.trim_out_ms).toBe(40_000);
    });

    it.fails('C-3: a local sub-clip is not resolved against the transcoder and is not marked error', async () => {
        // validate_uuid on the Rust side rejects anything that is not a canonical uuid.
        vi.mocked(invoke).mockImplementation(async (cmd: string, args: any) => {
            if (cmd === 'resolve_ingestor_asset' && !UUID.test(args?.uuid ?? '')) throw new Error('Invalid asset uuid');
            return offline(cmd, args);
        });
        const store = useRundownStore();
        store.addItem(draft({ playoutvueId: 'local-subclip:y', inPoint: 30_000, outPoint: 40_000, trim_in_ms: 30_000, trim_out_ms: 40_000 }) as any);
        await flush();

        expect(store.currentPlaylist!.items[0]!.ingestorStatus).not.toBe('error');
    });

    it.fails('C-6: a resolve that lands after a reorder writes to its own row', async () => {
        let release: (value: any) => void = () => {};
        vi.mocked(invoke).mockImplementation(async (cmd: string, args: any) => {
            if (cmd === 'resolve_ingestor_asset' && args.uuid === 'b-uuid') return new Promise((resolve) => { release = resolve; });
            return offline(cmd, args);
        });
        const store = useRundownStore();
        store.addItem(draft({ playoutvueId: 'a-uuid', filename: 'A', path: 'D:/a.mp4' }) as any);
        await flush();
        store.addItem(draft({ playoutvueId: 'b-uuid', filename: 'B', path: 'D:/b.mp4' }) as any);
        store.reorderItems(1, 0); // the operator drags B above A while B resolves
        release(libraryAsset({ uuid: 'b-uuid', current_path: 'D:/b.mp4', display_name: 'B', duration_ms: 30_000, trim_in_ms: 1_000, trim_out_ms: 9_000 }));
        await flush();
        await flush();

        const a = store.currentPlaylist!.items.find((i) => i.playoutvueId === 'a-uuid')!;
        expect(a.filename).toBe('A');
        expect(a.path).toBe('D:/a.mp4');
    });

    it.fails('C-8: SEEK lands on the requested second whatever the file frame rate', () => {
        const cases: Array<[string, number, number]> = [
            ['30000/1001', 30000 / 1001, 50],
            ['24000/1001', 24000 / 1001, 50],
            ['50/1', 50, 25],
        ];
        for (const [rational, fps, channelHz] of cases) {
            const inFrame = Math.floor(60 * fps);
            const fields = computeTrimFields(
                { in_frame: inFrame, out_frame: inFrame + 100, duration_frames: 100, fps_rational: rational },
                0,
                channelHz
            );
            expect(Math.abs(fields.seekFields / channelHz - 60), rational).toBeLessThanOrEqual(1 / channelHz);
        }
    });

    it.fails('C-21: a frame-aligned 29.97 point round-trips through ms to the same frame', () => {
        const fps = 30000 / 1001;
        const geo = { fps: 29.97, totalFrames: 0, gopFrames: 0, keyframeSafeStartMs: 0, mezzanineOk: true };
        for (let frame = 1; frame <= 1000; frame++) {
            const ms = clampTrimIn((frame * 1001) / 30, geo);
            // trimmer.rs floors IN and ceils OUT.
            expect(Math.floor((ms / 1000) * fps), `IN frame ${frame}`).toBe(frame);
            expect(Math.ceil((ms / 1000) * fps), `OUT frame ${frame}`).toBe(frame);
        }
    });
});
