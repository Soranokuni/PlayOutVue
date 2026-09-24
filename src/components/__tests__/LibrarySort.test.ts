// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import MediaLibrary from '../MediaLibrary.vue';
import { useMediaLibraryStore } from '../../stores/mediaLibrary';
import { activeLibraryContext } from '../../composables/useOperatorShortcuts';
import { sortLibraryAssets, nextLibrarySort, sanitizeLibrarySort } from '../../lib/librarySort';

// The library list used to render in transcoder order while the arrow keys
// walked a separate folder-then-name order, so the keys jumped around the list.
// The list is now sorted once, and the keys walk that same array.

const CREATED: Record<string, number> = {
  '/media/b.mxf': 3000,
  '/media/a.mxf': 1000,
  '/media/c.mxf': 2000,
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd: string, args?: { paths?: string[] }) => {
    if (cmd === 'get_file_created_times') {
      return Promise.resolve(Object.fromEntries((args?.paths ?? []).filter((p) => p in CREATED).map((p) => [p, CREATED[p]])));
    }
    return Promise.resolve(null);
  })
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(true),
  message: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockResolvedValue(null)
}));

const stubs = { ContextMenu: true, FolderPickerModal: true, TrimPanel: true, RecycleBinModal: true };

const asset = (uuid: string, name: string, path: string, duration: number, folder = '/') => ({
  uuid, current_path: path, display_name: name, virtual_folder: folder, duration_ms: duration,
  trim_in_ms: 0, trim_out_ms: duration, rating: 'none', status: 'ready',
});

function renderedIds(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('[data-asset-id]').map((row) => row.attributes('data-asset-id'));
}

describe('library sort', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    const store = useMediaLibraryStore();
    // Transcoder order, deliberately not alphabetical; "Charlie" sits in a
    // collapsed sub-folder, which the old tree walk skipped.
    store.setAssets([
      asset('id-b', 'Bravo', '/media/b.mxf', 5000),
      asset('id-c', 'Charlie', '/media/c.mxf', 90000, '/Shows'),
      asset('id-a', 'alpha', '/media/a.mxf', 30000),
    ]);
    store.clearSelection();
  });

  afterEach(() => {
    activeLibraryContext.value = null;
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('defaults to name order and the arrow keys walk the rendered order', async () => {
    const wrapper = mount(MediaLibrary, { global: { stubs } });
    await flushPromises();
    expect(renderedIds(wrapper)).toEqual(['id-a', 'id-b', 'id-c']);

    const store = useMediaLibraryStore();
    const ctx = activeLibraryContext.value!;
    ctx.selectNext();
    expect(store.selectedAssetId).toBe('id-a');
    ctx.selectNext();
    expect(store.selectedAssetId).toBe('id-b');
    ctx.selectNext();
    expect(store.selectedAssetId).toBe('id-c');
    wrapper.unmount();
  });

  it('sorts by duration and by date added, and navigation follows', async () => {
    const wrapper = mount(MediaLibrary, { global: { stubs } });
    await flushPromises();
    const store = useMediaLibraryStore();

    await wrapper.find('[data-testid="library-sort-trigger"]').trigger('click');
    await wrapper.find('[data-sort-key="duration"]').trigger('click');
    // Longest first on the first click.
    expect(renderedIds(wrapper)).toEqual(['id-c', 'id-a', 'id-b']);
    expect(activeLibraryContext.value!.getVisibleAssetIds()).toEqual(['id-c', 'id-a', 'id-b']);
    activeLibraryContext.value!.selectLast();
    expect(store.selectedAssetId).toBe('id-b');
    activeLibraryContext.value!.selectPrevious();
    expect(store.selectedAssetId).toBe('id-a');

    await wrapper.find('[data-testid="library-sort-trigger"]').trigger('click');
    await wrapper.find('[data-sort-key="added"]').trigger('click');
    await flushPromises();
    // Newest first.
    expect(renderedIds(wrapper)).toEqual(['id-b', 'id-c', 'id-a']);
    expect(activeLibraryContext.value!.getVisibleAssetIds()).toEqual(['id-b', 'id-c', 'id-a']);
    wrapper.unmount();
  });
});

describe('sortLibraryAssets', () => {
  const list = [
    asset('3', 'Ep 10', '/x/3', 100),
    asset('1', 'Ep 2', '/x/1', 100),
    asset('2', 'έβδομο', '/x/2', 50),
  ];

  it('sorts names naturally, Greek before Latin as in the Greek collation', () => {
    expect(sortLibraryAssets(list, { key: 'name', dir: 'asc' }).map((a) => a.display_name))
      .toEqual(['έβδομο', 'Ep 2', 'Ep 10']);
  });

  it('breaks duration ties by name so the order is stable', () => {
    expect(sortLibraryAssets(list, { key: 'duration', dir: 'desc' }).map((a) => a.uuid)).toEqual(['1', '3', '2']);
  });

  it('puts assets with no creation time last in both directions', () => {
    const created = (a: { uuid: string }) => ({ '1': 10, '2': 20 } as Record<string, number>)[a.uuid];
    expect(sortLibraryAssets(list, { key: 'added', dir: 'asc' }, created).map((a) => a.uuid)).toEqual(['1', '2', '3']);
    expect(sortLibraryAssets(list, { key: 'added', dir: 'desc' }, created).map((a) => a.uuid)).toEqual(['2', '1', '3']);
  });

  it('flips direction on the active key and sanitises stored values', () => {
    expect(nextLibrarySort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextLibrarySort({ key: 'name', dir: 'desc' }, 'duration')).toEqual({ key: 'duration', dir: 'desc' });
    expect(sanitizeLibrarySort({ key: 'bogus', dir: 'up' })).toEqual({ key: 'name', dir: 'asc' });
    expect(sanitizeLibrarySort(null)).toEqual({ key: 'name', dir: 'asc' });
  });
});
