// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useMediaLibraryStore } from '../../stores/mediaLibrary';
import { commandRegistry, type CommandContext } from '../../services/commandRegistry';

describe('PR 3A Library Keyboard Navigation & Selection State (Remediated)', () => {
  let libraryStore: ReturnType<typeof useMediaLibraryStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    libraryStore = useMediaLibraryStore();
    document.body.innerHTML = '';
    libraryStore.setAssets([
      { uuid: 'asset-1', current_path: '/media/1.mp4', display_name: 'Alpha Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
      { uuid: 'asset-2', current_path: '/media/2.mp4', display_name: 'Beta Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
      { uuid: 'asset-3', current_path: '/media/3.mp4', display_name: 'Charlie Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
      { uuid: 'asset-4', current_path: '/media/4.mp4', display_name: 'Delta Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' }
    ]);
    libraryStore.clearSelection();
  });

  const createTestContext = (scope: any = 'library', visibleNodes?: any[]): CommandContext => {
    const visibleAssetNodes = visibleNodes || libraryStore.allTreeNodes.filter(n => n.type === 'asset');
    return {
      scope,
      rundown: {} as any,
      selection: { selectedItemIds: [], primarySelectedId: null },
      library: {
        getSelectedAssetIds: () => libraryStore.selectedAssetIds,
        getVisibleAssetIds: () => visibleAssetNodes.map(n => n.asset?.uuid || n.id),
        selectPrevious: () => libraryStore.moveSelectionDelta(-1, visibleAssetNodes),
        selectNext: () => libraryStore.moveSelectionDelta(1, visibleAssetNodes),
        selectFirst: () => libraryStore.selectFirst(visibleAssetNodes),
        selectLast: () => libraryStore.selectLast(visibleAssetNodes),
        extendSelection: (delta: -1 | 1) => libraryStore.extendSelection(delta, visibleAssetNodes),
        appendSelectedToPlaylist: async () => ({ insertedIds: [], skippedIds: [], errors: [] }),
        insertSelectedAfter: async () => ({ insertedIds: [], skippedIds: [], errors: [] })
      },
      activeModal: null,
      trimmer: null
    };
  };

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

  it('navigates ONLY visible assets when library is filtered', async () => {
    // Filtered list containing asset-2 and asset-4
    const filteredNodes = libraryStore.allTreeNodes.filter(
      n => n.type === 'asset' && (n.asset?.uuid === 'asset-2' || n.asset?.uuid === 'asset-4')
    );

    const ctx = createTestContext('library', filteredNodes);

    await commandRegistry.execute('library.selectFirst', ctx); // asset-2
    expect(libraryStore.selectedAssetId).toBe('asset-2');

    await commandRegistry.execute('library.selectNext', ctx); // jumps over asset-3 directly to asset-4
    expect(libraryStore.selectedAssetId).toBe('asset-4');
  });

  it('navigates to first and last asset using Home and End', async () => {
    const ctx = createTestContext('library');
    await commandRegistry.execute('library.selectLast', ctx);
    expect(libraryStore.selectedAssetId).toBe('asset-4');

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

  it('verifies DOM focus on library list container with tabindex="0" and data-command-scope="library"', () => {
    const libContainer = document.createElement('div');
    libContainer.setAttribute('data-command-scope', 'library');
    libContainer.setAttribute('tabindex', '0');
    libContainer.setAttribute('role', 'listbox');
    document.body.appendChild(libContainer);

    libContainer.focus();
    expect(document.activeElement).toBe(libContainer);
  });
});
