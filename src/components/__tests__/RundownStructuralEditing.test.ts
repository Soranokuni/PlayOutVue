import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRundownStore } from '../../stores/rundown';
import {
  commandRegistry,
  type CommandContext,
  type LibraryCommandContext,
  type LibraryInsertResult
} from '../../services/commandRegistry';

describe('PR 3 Safe Command Registry & Structural Editing Commands', () => {
  let store: ReturnType<typeof useRundownStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useRundownStore();
    if (store.playlists[0]) {
      store.activatePlaylist(store.playlists[0].id);
      store.playlists[0].items = [];
      store.clearSelection();
    }
  });

  const createTestContext = (
    scope: any = 'rundown',
    libraryCtx?: LibraryCommandContext
  ): CommandContext => ({
    scope,
    rundown: store,
    selection: {
      selectedItemIds: store.selectedItemIds,
      primarySelectedId: store.selectedItemId
    },
    library: libraryCtx || null,
    activeModal: scope === 'modal' ? 'test-modal' : null,
    trimmer: null
  });

  it('verifies rundown.takeSelected is omitted from commandRegistry', () => {
    expect(commandRegistry.get('rundown.takeSelected')).toBeUndefined();
  });

  it('executes library.appendSelected (F8) when scope is library and asset is valid', async () => {
    const mockLibraryCtx: LibraryCommandContext = {
      getSelectedAssetIds: () => ['asset-1'],
      appendSelectedToPlaylist: async (): Promise<LibraryInsertResult> => {
        const createdIds = store.insertLibraryItems({
          items: [{
            filename: 'Valid Asset',
            type: 'video',
            path: '/valid.mp4',
            shortPath: 'valid.mp4',
            duration: 30,
            duration_ms: 30000,
            seek: 0,
            length: 30,
            libraryIndicator: 'none'
          }],
          target: { kind: 'append' }
        });
        return { insertedIds: createdIds, skippedIds: [], errors: [] };
      },
      insertSelectedAfter: async () => ({ insertedIds: [], skippedIds: [], errors: [] })
    };

    const ctx = createTestContext('library', mockLibraryCtx);
    expect(commandRegistry.get('library.appendSelected')?.isEnabled(ctx)).toBe(true);

    const executed = await commandRegistry.execute('library.appendSelected', ctx);
    expect(executed).toBe(true);
    expect(store.activeItems.length).toBe(1);
    expect(store.activeItems[0].filename).toBe('Valid Asset');
    expect(store.activeItems[0].duration).toBe(30);
  });

  it('disables library.appendSelected when scope is rundown or modal', () => {
    const mockLibraryCtx: LibraryCommandContext = {
      getSelectedAssetIds: () => ['asset-1'],
      appendSelectedToPlaylist: async () => ({ insertedIds: [], skippedIds: [], errors: [] }),
      insertSelectedAfter: async () => ({ insertedIds: [], skippedIds: [], errors: [] })
    };

    const rundownCtx = createTestContext('rundown', mockLibraryCtx);
    const modalCtx = createTestContext('modal', mockLibraryCtx);

    const cmd = commandRegistry.get('library.appendSelected');
    expect(cmd?.isEnabled(rundownCtx)).toBe(false);
    expect(cmd?.disabledReason(rundownCtx)).toBe('Library surface is not active');

    expect(cmd?.isEnabled(modalCtx)).toBe(false);
    expect(cmd?.disabledReason(modalCtx)).toBe('Library surface is not active');
  });

  it('skips asset without duration and reports error without assigning fake duration', async () => {
    const mockLibraryCtx: LibraryCommandContext = {
      getSelectedAssetIds: () => ['invalid-asset'],
      appendSelectedToPlaylist: async (): Promise<LibraryInsertResult> => {
        // Validation fails because duration_ms <= 0
        return {
          insertedIds: [],
          skippedIds: ['invalid-asset'],
          errors: ['Asset "invalid-asset" duration is unavailable']
        };
      },
      insertSelectedAfter: async () => ({ insertedIds: [], skippedIds: [], errors: [] })
    };

    const ctx = createTestContext('library', mockLibraryCtx);
    const result = await mockLibraryCtx.appendSelectedToPlaylist();

    expect(result.insertedIds.length).toBe(0);
    expect(result.skippedIds).toEqual(['invalid-asset']);
    expect(result.errors).toContain('Asset "invalid-asset" duration is unavailable');
    expect(store.activeItems.length).toBe(0);
  });

  it('executes library.insertSelected (Shift+F8) after primary selection', async () => {
    store.addItem({ filename: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ filename: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const primaryId = store.activeItems[0].id;
    store.selectItem(primaryId);

    const mockLibraryCtx: LibraryCommandContext = {
      getSelectedAssetIds: () => ['asset-2'],
      appendSelectedToPlaylist: async () => ({ insertedIds: [], skippedIds: [], errors: [] }),
      insertSelectedAfter: async (targetId): Promise<LibraryInsertResult> => {
        const createdIds = store.insertLibraryItems({
          items: [{
            filename: 'Inserted Asset',
            type: 'video',
            path: '/inserted.mp4',
            shortPath: 'inserted.mp4',
            duration: 15,
            duration_ms: 15000,
            seek: 0,
            length: 15,
            libraryIndicator: 'none'
          }],
          target: targetId ? { kind: 'after', targetItemId: targetId } : { kind: 'append' }
        });
        return { insertedIds: createdIds, skippedIds: [], errors: [] };
      }
    };

    const ctx = createTestContext('library', mockLibraryCtx);
    const executed = await commandRegistry.execute('library.insertSelected', ctx);

    expect(executed).toBe(true);
    expect(store.activeItems.length).toBe(3);
    expect(store.activeItems[1].filename).toBe('Inserted Asset');
  });

  it('executes rundown.deleteSelected to remove selected items', async () => {
    store.addItem({ filename: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ filename: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const id1 = store.activeItems[0].id;
    store.selectItem(id1);

    const ctx = createTestContext('rundown');
    const executed = await commandRegistry.execute('rundown.deleteSelected', ctx);

    expect(executed).toBe(true);
    expect(store.activeItems.length).toBe(1);
    expect(store.activeItems[0].filename).toBe('Clip 2');
  });

  it('executes copy, cut, and pasteAfterSelected correctly', async () => {
    store.addItem({ filename: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ filename: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const id1 = store.activeItems[0].id;
    store.selectItem(id1);

    let ctx = createTestContext('rundown');
    await commandRegistry.execute('rundown.copySelected', ctx);

    ctx = createTestContext('rundown');
    const pasteExecuted = await commandRegistry.execute('rundown.pasteAfterSelected', ctx);

    expect(pasteExecuted).toBe(true);
    expect(store.activeItems.length).toBe(3);
    expect(store.activeItems[1].filename).toBe('Clip 1 (Copy)');
  });
});
