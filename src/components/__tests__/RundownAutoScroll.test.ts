// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import RundownList from '../RundownList.vue';
import { useRundownStore } from '../../stores/rundown';

describe('PR 3A Rundown Auto-Scroll Component Watcher', () => {
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

  it('exercises actual RundownList.vue watcher on selectedItemId mutation and targets selected row element', async () => {
    store.addItem({ filename: 'Item 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ filename: 'Item 2', type: 'video', path: '/2.mp4', duration: 10 });
    const id2 = store.activeItems[1].id;

    const wrapper = mount(RundownList, {
      global: {
        stubs: {
          RundownRow: {
            template: '<div class="rw-row" :data-item-id="item.id">{{ item.filename }}</div>',
            props: ['item']
          },
          ContextMenu: true,
          StatusIndicator: true
        }
      }
    });

    const selectedRow = wrapper.get(`[data-item-id="${id2}"]`);
    const scrollSpy = vi.spyOn(selectedRow.element as HTMLElement, 'scrollIntoView').mockImplementation(() => {});

    store.selectedItemId = id2;

    await nextTick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await nextTick();

    expect(scrollSpy).toHaveBeenCalledWith({
      block: 'nearest',
      behavior: 'auto'
    });

    wrapper.unmount();
  });
});
