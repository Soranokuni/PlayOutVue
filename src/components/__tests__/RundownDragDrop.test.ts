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

  it('does not append when before target is missing', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const items = store.activeItems;
    const originalIds = items.map(i => i.id);

    const result = calculateMove(items, [originalIds[0]], {
      kind: 'before',
      targetItemId: 'missing-id'
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('invalid-target');
    expect(result.newItems.map(i => i.id)).toEqual(originalIds);
  });

  it('does not append when after target is missing', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const items = store.activeItems;

    const result = calculateMove(items, [items[0].id], {
      kind: 'after',
      targetItemId: 'missing-id'
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('invalid-target');
  });

  it('does not move a block relative to a target inside the same block', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    store.addItem({ name: 'Clip 3', type: 'video', path: '/3.mp4', duration: 10 });
    const items = store.activeItems;
    const [i1, i2] = items.map(i => i.id);

    const result = calculateMove(items, [i1, i2], {
      kind: 'after',
      targetItemId: i2
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('invalid-target');
  });

  it('does not create undo history for invalid drag targets', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const item1 = store.activeItems[0].id;

    expect(store.canUndo).toBe(false);

    const result = store.moveRundownItems({
      itemIds: [item1],
      target: {
        kind: 'before',
        targetItemId: 'deleted-id'
      }
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('invalid-target');
    expect(store.canUndo).toBe(false);
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

  it('moves multi-selected items upward cleanly without off-by-one errors', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    store.addItem({ name: 'Clip 3', type: 'video', path: '/3.mp4', duration: 10 });
    store.addItem({ name: 'Clip 4', type: 'video', path: '/4.mp4', duration: 10 });

    const [i1, i2, i3, i4] = store.activeItems.map(i => i.id);

    // Move items [i3, i4] before i1
    const res = store.moveRundownItems({
      itemIds: [i3, i4],
      target: { kind: 'before', targetItemId: i1 }
    });

    expect(res.changed).toBe(true);
    expect(store.activeItems.map(i => i.id)).toEqual([i3, i4, i1, i2]);
  });

  it('inserts library items at exact before target row', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const targetId = store.activeItems[1].id;

    const inserted = store.insertLibraryItems({
      items: [{ filename: 'New Library Asset', path: '/new.mp4', type: 'video', duration: 10, seek: 0, length: 10 }],
      target: { kind: 'before', targetItemId: targetId }
    });

    expect(inserted.length).toBe(1);
    expect(store.activeItems.length).toBe(3);
    expect(store.activeItems[1].path).toBe('/new.mp4');
    expect(store.activeItems[2].id).toBe(targetId);
  });

  it('inserts library items at exact after target row', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    const targetId = store.activeItems[0].id;

    const inserted = store.insertLibraryItems({
      items: [{ filename: 'New Library Asset', path: '/new.mp4', type: 'video', duration: 10, seek: 0, length: 10 }],
      target: { kind: 'after', targetItemId: targetId }
    });

    expect(inserted.length).toBe(1);
    expect(store.activeItems.length).toBe(3);
    expect(store.activeItems[0].id).toBe(targetId);
    expect(store.activeItems[1].path).toBe('/new.mp4');
  });

  it('inserts library items at append target when dropping below last row', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });

    const inserted = store.insertLibraryItems({
      items: [{ filename: 'New Library Asset', path: '/new.mp4', type: 'video', duration: 10, seek: 0, length: 10 }],
      target: { kind: 'append' }
    });

    expect(inserted.length).toBe(1);
    expect(store.activeItems.length).toBe(3);
    expect(store.activeItems[2].path).toBe('/new.mp4');
  });

  it('moves non-contiguous selected items preserving visual order without including unselected items', () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 });
    store.addItem({ name: 'Clip 3', type: 'video', path: '/3.mp4', duration: 10 });
    store.addItem({ name: 'Clip 4', type: 'video', path: '/4.mp4', duration: 10 });

    const [i1, i2, i3, i4] = store.activeItems.map(i => i.id);

    // Non-contiguous selection: select i1 and i3
    const selectedIds = [i1, i3];
    const movingItemIds = store.activeItems.filter(item => selectedIds.includes(item.id)).map(item => item.id);

    expect(movingItemIds).toEqual([i1, i3]);

    // Move [i1, i3] after i4
    const res = store.moveRundownItems({
      itemIds: movingItemIds,
      target: { kind: 'after', targetItemId: i4 }
    });

    expect(res.changed).toBe(true);
    // i2 and i4 remain in relative order, i1 and i3 moved to end in original order
    expect(store.activeItems.map(i => i.id)).toEqual([i2, i4, i1, i3]);
  });

  it('SortableJS is not used for rundown reorder', async () => {
    // Read RundownList.vue source dynamically to verify SortableJS import and instance creation are absent
    const fs = await import('fs');
    const path = await import('path');
    const rundownListPath = path.resolve(__dirname, '../RundownList.vue');
    const content = fs.readFileSync(rundownListPath, 'utf-8');

    expect(content).not.toContain("import Sortable from 'sortablejs'");
    expect(content).not.toContain("Sortable.create");
  });

  it('internal HTML5 drag handlers are absent from RundownList.vue reorder path', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const rundownListPath = path.resolve(__dirname, '../RundownList.vue');
    const content = fs.readFileSync(rundownListPath, 'utf-8');

    expect(content).not.toContain('onRowDragStart');
    expect(content).not.toContain('onRowDragEnd');
    expect(content).not.toContain('onRowDragOver');
    expect(content).not.toContain('onRowDrop');
  });
});


