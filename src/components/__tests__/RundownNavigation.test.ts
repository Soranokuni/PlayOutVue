import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRundownStore } from '../../stores/rundown';

describe('Rundown Navigation & Selection State', () => {
  let store: ReturnType<typeof useRundownStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useRundownStore();
    if (store.activePlaylist) {
      store.activePlaylist.items = [];
      store.clearSelection();
    }
  });

  it('navigates through items synchronously using moveSelectionDelta', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/media/2.mp4', duration: 15 });
    store.addItem({ name: 'Clip 3', type: 'video', path: '/media/3.mp4', duration: 20 });

    const items = store.activeItems;
    expect(items.length).toBe(3);

    const id1 = items[0].id;
    const id2 = items[1].id;
    const id3 = items[2].id;

    store.selectItem(id1);
    expect(store.selectedItemId).toBe(id1);

    store.moveSelectionDelta(1);
    expect(store.selectedItemId).toBe(id2);

    store.moveSelectionDelta(1);
    expect(store.selectedItemId).toBe(id3);

    // Clamps at list bounds
    store.moveSelectionDelta(1);
    expect(store.selectedItemId).toBe(id3);

    store.moveSelectionDelta(-1);
    expect(store.selectedItemId).toBe(id2);

    store.moveSelectionDelta(-9999);
    expect(store.selectedItemId).toBe(id1);
  });

  it('extends selection range using extendSelectionDelta', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/media/2.mp4', duration: 15 });
    store.addItem({ name: 'Clip 3', type: 'video', path: '/media/3.mp4', duration: 20 });

    const items = store.activeItems;
    expect(items.length).toBe(3);

    const id1 = items[0].id;
    const id2 = items[1].id;
    const id3 = items[2].id;

    store.selectItem(id1);

    store.extendSelectionDelta(1);
    expect(store.selectedItemIds).toEqual([id1, id2]);

    store.extendSelectionDelta(1);
    expect(store.selectedItemIds).toEqual([id1, id2, id3]);
  });

  it('clears selection on clearSelection', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    const id1 = store.activeItems[0].id;
    store.selectItem(id1);

    store.clearSelection();
    expect(store.selectedItemId).toBeNull();
    expect(store.selectedItemIds).toEqual([]);
  });
});
