import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useMediaLibraryStore, type LibraryAsset } from '../../stores/mediaLibrary';
import { commandRegistry, type CommandContext } from '../../services/commandRegistry';

describe('PR 3A Library Keyboard Navigation & Selection State', () => {
  let libraryStore: ReturnType<typeof useMediaLibraryStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    libraryStore = useMediaLibraryStore();
    libraryStore.setAssets([
      { uuid: 'asset-1', current_path: '/media/1.mp4', display_name: 'Alpha Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
      { uuid: 'asset-2', current_path: '/media/2.mp4', display_name: 'Beta Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
      { uuid: 'asset-3', current_path: '/media/3.mp4', display_name: 'Gamma Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' }
    ]);
    libraryStore.clearSelection();
  });

  const createTestContext = (scope: any = 'library'): CommandContext => ({
    scope,
    rundown: {} as any,
    selection: { selectedItemIds: [], primarySelectedId: null },
    library: {
      getSelectedAssetIds: () => libraryStore.selectedAssetIds,
      getVisibleAssetIds: () => libraryStore.allTreeNodes.filter(n => n.type === 'asset').map(n => n.asset?.uuid || n.id),
      selectPrevious: () => libraryStore.moveSelectionDelta(-1),
      selectNext: () => libraryStore.moveSelectionDelta(1),
      selectFirst: () => libraryStore.selectFirst(),
      selectLast: () => libraryStore.selectLast(),
      extendSelection: (delta: -1 | 1) => libraryStore.extendSelection(delta),
      appendSelectedToPlaylist: async () => ({ insertedIds: [], skippedIds: [], errors: [] }),
      insertSelectedAfter: async () => ({ insertedIds: [], skippedIds: [], errors: [] })
    },
    activeModal: null,
    trimmer: null
  });

  it('selects first asset on ArrowDown when nothing is selected', async () => {
    const ctx = createTestContext('library');
    const executed = await commandRegistry.execute('library.selectNext', ctx);

    expect(executed).toBe(true);
    expect(libraryStore.selectedAssetId).toBe('asset-1');
  });

  it('navigates next and previous using ArrowDown and ArrowUp', async () => {
    const ctx = createTestContext('library');
    await commandRegistry.execute('library.selectNext', ctx); // asset-1
    await commandRegistry.execute('library.selectNext', ctx); // asset-2

    expect(libraryStore.selectedAssetId).toBe('asset-2');

    await commandRegistry.execute('library.selectPrevious', ctx); // asset-1
    expect(libraryStore.selectedAssetId).toBe('asset-1');
  });

  it('navigates to first and last asset using Home and End', async () => {
    const ctx = createTestContext('library');
    await commandRegistry.execute('library.selectLast', ctx);
    expect(libraryStore.selectedAssetId).toBe('asset-3');

    await commandRegistry.execute('library.selectFirst', ctx);
    expect(libraryStore.selectedAssetId).toBe('asset-1');
  });

  it('extends selection using Shift+ArrowDown', async () => {
    const ctx = createTestContext('library');
    await commandRegistry.execute('library.selectFirst', ctx); // asset-1
    await commandRegistry.execute('library.extendSelectionNext', ctx); // extends to asset-2

    expect(libraryStore.selectedAssetIds).toContain('asset-1');
    expect(libraryStore.selectedAssetIds).toContain('asset-2');
  });

  it('prevents library arrow navigation when scope is rundown', async () => {
    const ctx = createTestContext('rundown');
    const executed = await commandRegistry.execute('library.selectNext', ctx);

    expect(executed).toBe(false);
    expect(libraryStore.selectedAssetId).toBeNull();
  });
});
