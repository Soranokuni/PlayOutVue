// @vitest-environment happy-dom
/**
 * PERF-PLAN PR E: a 30 s poll that brings nothing new must not replace the
 * library, and a click must not rebuild the folder tree.
 *
 * With 2 000 assets a click cost ~180 ms (every row re-rendered, the persist
 * plugin walked every asset) and an unchanged poll ~270 ms (dev build).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { sameJsonValue, useMediaLibraryStore, type LibraryAsset } from '../mediaLibrary';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));

const asset = (i: number, over: Partial<LibraryAsset> = {}): LibraryAsset => ({
  uuid: `a${i}`,
  current_path: `D:/media/a${i}.mxf`,
  display_name: `Asset ${i}`,
  virtual_folder: `/Shows/F${i % 3}`,
  duration_ms: 60_000,
  trim_in_ms: 0,
  trim_out_ms: 0,
  rating: '16|None|show',
  status: 'ready',
  warnings: [],
  qc_report: { passed: true, blocking_errors: 0, warnings_count: 0, findings: [] },
  ...over
});

const snapshot = (count = 6) => Array.from({ length: count }, (_, i) => asset(i));

describe('PERF-PLAN PR E · library identity', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it('an unchanged poll keeps the array and every asset object', () => {
    const store = useMediaLibraryStore();
    store.setAssets(snapshot(), { reconcile: false });
    const list = store.assets;
    const first = store.assets[0];

    store.setAssets(snapshot(), { reconcile: false });

    expect(store.assets).toBe(list);
    expect(store.assets[0]).toBe(first);
  });

  it('a changed asset gets a new object; the others keep theirs', () => {
    const store = useMediaLibraryStore();
    store.setAssets(snapshot(), { reconcile: false });
    const untouched = store.assets[1];
    const renamed = store.assets[2];

    const next = snapshot();
    next[2] = asset(2, { display_name: 'Renamed' });
    store.setAssets(next, { reconcile: false });

    expect(store.assets[1]).toBe(untouched);
    expect(store.assets[2]).not.toBe(renamed);
    expect(store.assets[2]!.display_name).toBe('Renamed');
  });

  it('additions, removals and reorders still land', () => {
    const store = useMediaLibraryStore();
    store.setAssets(snapshot(3), { reconcile: false });
    store.setAssets([asset(2), asset(0), asset(9)], { reconcile: false });
    expect(store.assets.map((a) => a.uuid)).toEqual(['a2', 'a0', 'a9']);
  });

  it('an unchanged recycle bin is not replaced', async () => {
    const store = useMediaLibraryStore();
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === 'list_ingestor_recycle_bin' ? [{ uuid: 'r1', current_path: 'D:/bin/r1.mxf', deleted_at: '2026-09-01' }] : null
    );
    await store.fetchRecycleBin();
    const bin = store.recycleBinAssets;
    await store.fetchRecycleBin();
    expect(store.recycleBinAssets).toBe(bin);
    expect(store.recycleBinAssets).toHaveLength(1);
  });

  it('selecting an asset does not rebuild the folder tree', () => {
    const store = useMediaLibraryStore();
    store.setAssets(snapshot(), { reconcile: false });
    const tree = store.allTreeNodes;
    store.selectNode('asset:a1');
    store.selectNode('asset:a2');
    expect(store.allTreeNodes).toBe(tree);
  });

  it('selecting a collapsed folder still expands it', () => {
    const store = useMediaLibraryStore();
    store.setAssets(snapshot(), { reconcile: false });
    store.expandedFolders = ['/'];
    expect(store.allTreeNodes.find((n) => n.id === 'folder:/Shows')?.expanded).toBe(false);

    store.selectNode('folder:/Shows');

    expect(store.expandedFolders).toContain('/Shows');
    expect(store.allTreeNodes.find((n) => n.id === 'folder:/Shows')?.expanded).toBe(true);
  });

  it('the asset lists are not store state, so the persist watch never walks them', () => {
    const store = useMediaLibraryStore();
    store.setAssets(snapshot(), { reconcile: false });
    expect(Object.keys(store.$state)).not.toContain('assets');
    expect(Object.keys(store.$state)).not.toContain('recycleBinAssets');
    // Still assignable, as tests and callers do.
    store.assets = [asset(7)];
    expect(store.assets.map((a) => a.uuid)).toEqual(['a7']);
  });
});

describe('sameJsonValue', () => {
  it('compares JSON-shaped values structurally', () => {
    expect(sameJsonValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameJsonValue({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(sameJsonValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJsonValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(sameJsonValue(null, {})).toBe(false);
    expect(sameJsonValue(Number.NaN, Number.NaN)).toBe(true);
  });
});
