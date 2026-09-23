// @vitest-environment happy-dom
//
// Guard tests for the reliability audit (2026-09-22):
//
//   F-0  a persisted rundown is reconciled against the library on every poll
//   F-1  a path that no longer exists takes its row offline before air
//   F-2  the client never raises an IN point to `keyframe_safe_start_ms`
//   F-3  the batch resolve is keyed by row, not by uuid, and marks the
//        uuids the server did not return as `missing`
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { useRundownStore, type ReconcileAsset } from '../rundown';
import { casparPlayoutService } from '../../services/caspar';
import { clampTrimIn, clampTrimOut } from '../../utils/frameMath';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('../../services/caspar', () => ({
    playStartTime: { value: 0 },
    casparPlayoutService: { refreshQueue: vi.fn(() => Promise.resolve()) }
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const asset = (over: Partial<ReconcileAsset> & { uuid: string }): ReconcileAsset => ({
    current_path: 'D:/media/videos/a.mp4',
    display_name: 'A',
    duration_ms: 60_000,
    trim_in_ms: 0,
    trim_out_ms: 60_000,
    status: 'ready',
    mezzanine_ok: true,
    keyframe_safe_start_ms: 2000,
    ...over
});

const addRow = (store: ReturnType<typeof useRundownStore>, over: Record<string, any> = {}) => {
    store.addItem({
        playoutvueId: 'uuid-a',
        filename: 'A',
        path: 'D:/old/a.mp4',
        shortPath: '',
        type: 'video',
        libraryIndicator: 'none',
        duration: 60,
        seek: 0,
        length: 0,
        mezzanine_ok: true,
        keyframe_safe_start_ms: 2000,
        fps: 25,
        total_frames: 1500,
        duration_ms: 60_000,
        ...over
    } as any);
    const items = store.currentPlaylist!.items;
    return items[items.length - 1]!;
};

describe('audit F-2 — the client does not raise the IN point', () => {
    const geo = {
        fps: 25,
        totalFrames: 1500,
        gopFrames: 50,
        keyframeSafeStartMs: 2000,
        mezzanineOk: true
    };

    it('leaves an IN point of 0 at 0 even when keyframe_safe_start_ms is 2000', () => {
        // The transcoder reports 2000 for every mezzanine it has ever produced
        // (it drops the keyframe at pts 0). Raising the IN to it cut the first
        // two seconds off every clip that went to air.
        expect(clampTrimIn(0, geo)).toBe(0);
    });

    it('still rounds to a frame boundary', () => {
        expect(clampTrimIn(1017, geo)).toBe(1000); // 25.425 frames -> frame 25
        expect(clampTrimIn(1023, geo)).toBe(1040); // 25.575 frames -> frame 26
    });

    it('does not collapse an OUT point when total_frames is unknown', () => {
        expect(clampTrimOut(60_000, { ...geo, totalFrames: 0 })).toBe(60_000);
    });
});

describe('audit F-2 — an unrelated updateItem does not re-derive trims', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.mocked(invoke).mockReset();
        vi.mocked(invoke).mockRejectedValue(new Error('offline'));
    });

    it('keeps trim_in_ms at 0 across a field edit', () => {
        const store = useRundownStore();
        const row = addRow(store);
        expect(row.trim_in_ms).toBe(0);

        // This is exactly what the playout service does on a failure, and what
        // every note/rating edit does. It used to re-run the frame math and
        // push a corrected 0 back up to 2000.
        store.updateItem(row.id, { note: 'x' });
        store.updateItem(row.id, { ingestorStatus: 'error' });

        const after = store.currentPlaylist!.items.find((i) => i.id === row.id)!;
        expect(after.trim_in_ms).toBe(0);
        expect(after.note).toBe('x');
    });
});

describe('audit F-0 — reconcileWithLibrary', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.mocked(invoke).mockReset();
        vi.mocked(invoke).mockResolvedValue({});
    });

    it('adopts a moved path and the server trims verbatim', () => {
        const store = useRundownStore();
        const row = addRow(store);

        store.reconcileWithLibrary([
            asset({ uuid: 'uuid-a', current_path: 'D:/new/a.mp4', trim_in_ms: 0 })
        ]);

        const after = store.currentPlaylist!.items.find((i) => i.id === row.id)!;
        expect(after.path).toBe('D:/new/a.mp4');
        expect(after.current_path).toBe('D:/new/a.mp4');
        expect(after.ingestorStatus).toBe('ready');
        // Verbatim: not raised to keyframe_safe_start_ms.
        expect(after.trim_in_ms).toBe(0);
        expect(after.inPoint).toBe(0);
    });

    it('marks a row the registry does not know as missing and keeps it', () => {
        const store = useRundownStore();
        const row = addRow(store, { playoutvueId: 'uuid-gone' });

        store.reconcileWithLibrary([asset({ uuid: 'uuid-other' })]);

        const items = store.currentPlaylist!.items;
        expect(items).toHaveLength(1);
        expect(items.find((i) => i.id === row.id)!.ingestorStatus).toBe('missing');
    });

    it('treats an empty snapshot as "not loaded", not "everything deleted"', () => {
        const store = useRundownStore();
        const row = addRow(store);
        const before = store.currentPlaylist!.items.find((i) => i.id === row.id)!.ingestorStatus;

        expect(store.reconcileWithLibrary([])).toBe(0);
        expect(store.currentPlaylist!.items.find((i) => i.id === row.id)!.ingestorStatus).toBe(before);
    });

    it('carries the server status through, so a QC-failed asset is not green', () => {
        const store = useRundownStore();
        const row = addRow(store);

        store.reconcileWithLibrary([
            asset({ uuid: 'uuid-a', status: 'error', mezzanine_ok: false })
        ]);

        expect(store.currentPlaylist!.items.find((i) => i.id === row.id)!.ingestorStatus).toBe('error');
    });
});

describe('audit F-3 — the batch resolve', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.mocked(invoke).mockReset();
    });

    it('resolves every row that shares a uuid, not just the last one', async () => {
        const store = useRundownStore();
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
            if (cmd === 'resolve_ingestor_assets_batch') {
                return {
                    'uuid-ident': {
                        uuid: 'uuid-ident',
                        current_path: 'D:/new/ident.mp4',
                        display_name: 'Ident',
                        duration_ms: 10_000,
                        trim_in_ms: 0,
                        trim_out_ms: 10_000,
                        status: 'ready',
                        mezzanine_ok: true
                    }
                };
            }
            return {};
        });

        // An ident appears twice, as it does in every real rundown.
        const first = addRow(store, { playoutvueId: 'uuid-ident' });
        const second = addRow(store, { playoutvueId: 'uuid-ident' });

        const playlistId = store.currentPlaylist!.id;
        store.resolveItemsBatch(playlistId, store.currentPlaylist!.items);
        await flush();

        const items = store.currentPlaylist!.items;
        for (const id of [first.id, second.id]) {
            const row = items.find((i) => i.id === id)!;
            expect(row.path).toBe('D:/new/ident.mp4');
            expect(row.ingestorStatus).toBe('ready');
        }
    });

    it('marks a requested uuid the server did not return as missing', async () => {
        const store = useRundownStore();
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
            if (cmd === 'resolve_ingestor_assets_batch') return {};
            return {};
        });

        const row = addRow(store, { playoutvueId: 'uuid-from-a-dead-registry' });
        store.resolveItemsBatch(store.currentPlaylist!.id, store.currentPlaylist!.items);
        await flush();

        expect(store.currentPlaylist!.items.find((i) => i.id === row.id)!.ingestorStatus).toBe('missing');
    });

    it('leaves rows alone when the batch call itself fails', async () => {
        const store = useRundownStore();
        vi.mocked(invoke).mockRejectedValue(new Error('ingestor unreachable'));
        const row = addRow(store);
        await flush();

        store.resolveItemsBatch(store.currentPlaylist!.id, store.currentPlaylist!.items);
        await flush();

        // An outage is not a deletion: the row may be flagged, never `missing`.
        expect(store.currentPlaylist!.items.find((i) => i.id === row.id)!.ingestorStatus)
            .not.toBe('missing');
    });
});

describe('audit F-1 — existence is checked before air, not at TAKE', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.mocked(invoke).mockReset();
    });

    it('marks a row whose file is gone as missing', async () => {
        const store = useRundownStore();
        vi.mocked(invoke).mockImplementation(async (cmd: string, args: any) => {
            if (cmd === 'verify_paths_exist') {
                return Object.fromEntries((args.paths as string[]).map((p) => [p, false]));
            }
            return {};
        });

        const row = addRow(store);
        await store.verifyRundownPaths();

        expect(store.currentPlaylist!.items.find((i) => i.id === row.id)!.ingestorStatus).toBe('missing');
    });

    it('does not demote rows when the check is unavailable', async () => {
        const store = useRundownStore();
        vi.mocked(invoke).mockRejectedValue(new Error('no backend'));
        const row = addRow(store);
        await flush();

        await store.verifyRundownPaths();

        // An unavailable check is not evidence of a missing file.
        expect(store.currentPlaylist!.items.find((i) => i.id === row.id)!.ingestorStatus)
            .not.toBe('missing');
    });
});

// PERF-PLAN PR C: the registry and the disk check used to disagree on every
// poll about a file the registry calls `ready` but this machine cannot open.
// Each poll set the row `ready` (re-arming the on-air queue through
// refreshQueue, the path behind the 2026-09-23 skipped-clip incident) and the
// disk check set it `missing` again.
describe('PERF-PLAN PR C — reconcile respects the disk check', () => {
    let onDisk: boolean;

    beforeEach(() => {
        setActivePinia(createPinia());
        vi.mocked(invoke).mockReset();
        onDisk = false;
        vi.mocked(invoke).mockImplementation(async (cmd: string, args: any) => {
            if (cmd === 'verify_paths_exist') {
                return Object.fromEntries((args.paths as string[]).map((p) => [p, onDisk]));
            }
            // addItem resolves the new row against the transcoder.
            if (cmd === 'resolve_ingestor_asset') return asset({ uuid: 'uuid-a' });
            return {};
        });
    });

    const library = [asset({ uuid: 'uuid-a' })];

    /** Add the row and let the add-time resolve, the first poll and its disk check settle. */
    const settle = async (store: ReturnType<typeof useRundownStore>) => {
        const row = addRow(store);
        await flush();
        store.reconcileWithLibrary(library);
        await flush();
        store.reconcileWithLibrary(library);
        await flush();
        return row;
    };
    const status = (store: ReturnType<typeof useRundownStore>, id: string) =>
        store.currentPlaylist!.items.find((i) => i.id === id)!.ingestorStatus;

    it('a ready asset whose file is gone stays missing, and polls stop touching the rundown', async () => {
        const store = useRundownStore();
        const row = await settle(store);
        expect(status(store, row.id)).toBe('missing');

        const refreshQueue = vi.mocked(casparPlayoutService.refreshQueue!);
        refreshQueue.mockClear();
        const items = store.currentPlaylist!.items;

        for (let poll = 0; poll < 3; poll++) {
            expect(store.reconcileWithLibrary(library)).toBe(0);
            await flush();
        }

        expect(status(store, row.id)).toBe('missing');
        expect(store.currentPlaylist!.items).toBe(items);
        expect(refreshQueue).not.toHaveBeenCalled();
    });

    it('a file that comes back goes ready at the next disk check, not the next poll', async () => {
        const store = useRundownStore();
        const row = await settle(store);
        expect(status(store, row.id)).toBe('missing');

        onDisk = true;
        await store.verifyRundownPaths();
        await flush();

        expect(status(store, row.id)).toBe('ready');
    });

    it('an unchanged library with the file present never re-arms the queue', async () => {
        onDisk = true;
        const store = useRundownStore();
        await settle(store);

        const refreshQueue = vi.mocked(casparPlayoutService.refreshQueue!);
        refreshQueue.mockClear();
        for (let poll = 0; poll < 3; poll++) {
            store.reconcileWithLibrary(library);
            await flush();
        }
        expect(refreshQueue).not.toHaveBeenCalled();
    });
});
