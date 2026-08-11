import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRundownStore, calculateMove, type InsertionTarget } from '../../stores/rundown';

describe('Deterministic Drag & Drop & Move Invariants', () => {
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

  it('calculateMove returns changed: false when moving item to its current position', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    store.addItem({ name: 'Clip 3', type: 'video', path: '/3.mp4', duration: 10 });

    const items = store.activeItems;
    const item1 = items[0].id;
    const item2 = items[1].id;

    // Moving item 1 before item 2 is a no-op because item 1 is already before item 2
    const target: InsertionTarget = { kind: 'before', targetItemId: item2 };
    const res = calculateMove(items, [item1], target);

    expect(res.changed).toBe(false);
  });

  it('moveRundownItems does NOT save an undo snapshot if order is unchanged', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const item1 = store.activeItems[0].id;
    const item2 = store.activeItems[1].id;

    expect(store.canUndo).toBe(false);

    // No-op move: target before item2 when item1 is already before it
    const res = store.moveRundownItems({
      itemIds: [item1],
      target: { kind: 'before', targetItemId: item2 }
    });

    expect(res.changed).toBe(false);
    expect(store.canUndo).toBe(false);
  });

  it('moveRundownItems saves undo snapshot and updates order when move changes list', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const item1 = store.activeItems[0].id;
    const item2 = store.activeItems[1].id;

    const res = store.moveRundownItems({
      itemIds: [item1],
      target: { kind: 'after', targetItemId: item2 }
    });

    expect(res.changed).toBe(true);
    expect(store.canUndo).toBe(true);
    expect(store.activeItems[0].id).toBe(item2);
    expect(store.activeItems[1].id).toBe(item1);
  });

  it('moves multiple selected items as a block preserving relative order', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    store.addItem({ name: 'Clip 3', type: 'video', path: '/3.mp4', duration: 10 });
    store.addItem({ name: 'Clip 4', type: 'video', path: '/4.mp4', duration: 10 });

    const [i1, i2, i3, i4] = store.activeItems.map(i => i.id);

    // Move items [i1, i2] after i3
    const res = store.moveRundownItems({
      itemIds: [i1, i2],
      target: { kind: 'after', targetItemId: i3 }
    });

    expect(res.changed).toBe(true);
    expect(store.activeItems.map(i => i.id)).toEqual([i3, i1, i2, i4]);
  });

  it('resolves append target to place items at end of playlist', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    store.addItem({ name: 'Clip 3', type: 'video', path: '/3.mp4', duration: 10 });

    const [i1, i2, i3] = store.activeItems.map(i => i.id);

    const res = store.moveRundownItems({
      itemIds: [i1],
      target: { kind: 'append' }
    });

    expect(res.changed).toBe(true);
    expect(store.activeItems.map(i => i.id)).toEqual([i2, i3, i1]);
  });
});
