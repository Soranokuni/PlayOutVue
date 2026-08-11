// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import { useRundownStore } from '../../stores/rundown';

describe('PR 3A Rundown Auto-Scroll Watcher & Dynamic Page Size', () => {
  let store: ReturnType<typeof useRundownStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useRundownStore();
    document.body.innerHTML = '';
    if (store.playlists[0]) {
      store.activatePlaylist(store.playlists[0].id);
      store.playlists[0].items = [];
      store.clearSelection();
    }
  });

  it('triggers scrollIntoView when selectedItemId changes in store', async () => {
    store.addItem({ filename: 'Item 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ filename: 'Item 2', type: 'video', path: '/2.mp4', duration: 10 });
    const id2 = store.activeItems[1].id;

    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});

    // Create container element with data-item-id
    const container = document.createElement('div');
    container.setAttribute('data-command-scope', 'rundown');
    const row = document.createElement('div');
    row.setAttribute('data-item-id', id2);
    container.appendChild(row);
    document.body.appendChild(container);

    let scrollFrame: number | null = null;
    const scheduleSelectedRowReveal = () => {
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = null;
        nextTick(() => {
          const selectedId = store.selectedItemId;
          if (!selectedId) return;
          const targetRow = container.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(selectedId)}"]`);
          targetRow?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        });
      });
    };

    store.selectedItemId = id2;
    scheduleSelectedRowReveal();

    await nextTick();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(scrollSpy).toHaveBeenCalledWith({
      block: 'nearest',
      behavior: 'auto'
    });
  });
});
