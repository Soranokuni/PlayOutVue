import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRundownStore } from '../../stores/rundown';
import { commandRegistry, type CommandContext } from '../../services/commandRegistry';

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

  const createTestContext = (scope: any = 'rundown'): CommandContext => ({
    scope,
    rundown: store,
    selection: {
      selectedItemIds: store.selectedItemIds,
      primarySelectedId: store.selectedItemId
    },
    activeModal: null,
    trimmer: null
  });

  it('verifies rundown.takeSelected is omitted from commandRegistry', () => {
    expect(commandRegistry.get('rundown.takeSelected')).toBeUndefined();
  });

  it('executes rundown.deleteSelected to remove selected items', async () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const id1 = store.activeItems[0].id;
    store.selectItem(id1);

    const ctx = createTestContext('rundown');
    const executed = await commandRegistry.execute('rundown.deleteSelected', ctx);

    expect(executed).toBe(true);
    expect(store.activeItems.length).toBe(1);
    expect(store.activeItems[0].name).toBe('Clip 2');
  });

  it('executes library.appendSelected (F8) to append library asset to rundown', async () => {
    store.addItem({ filename: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });

    const ctx: CommandContext = {
      ...createTestContext('library'),
      library: {
        selectedAsset: {
          filename: 'Library Clip 1',
          path: '/media/library1.mp4',
          duration: 15
        }
      }
    };

    const executed = await commandRegistry.execute('library.appendSelected', ctx);

    expect(executed).toBe(true);
    expect(store.activeItems.length).toBe(2);
    expect(store.activeItems[1].filename).toBe('Library Clip 1');
  });

  it('executes library.insertSelected (Shift+F8) to insert library asset after primary selection', async () => {
    store.addItem({ filename: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ filename: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const id1 = store.activeItems[0].id;
    store.selectItem(id1);

    const ctx: CommandContext = {
      ...createTestContext('library'),
      library: {
        selectedAsset: {
          filename: 'Inserted Asset',
          path: '/media/inserted.mp4',
          duration: 20
        }
      }
    };

    const executed = await commandRegistry.execute('library.insertSelected', ctx);

    expect(executed).toBe(true);
    expect(store.activeItems.length).toBe(3);
    expect(store.activeItems[1].filename).toBe('Inserted Asset');
  });

  it('executes copy, cut, and pasteAfterSelected correctly', async () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const id1 = store.activeItems[0].id;
    store.selectItem(id1);

    let ctx = createTestContext('rundown');
    await commandRegistry.execute('rundown.copySelected', ctx);

    ctx = createTestContext('rundown');
    const pasteExecuted = await commandRegistry.execute('rundown.pasteAfterSelected', ctx);

    expect(pasteExecuted).toBe(true);
    expect(store.activeItems.length).toBe(3);
    expect(store.activeItems[1].name).toBe('Clip 1');
  });
});
