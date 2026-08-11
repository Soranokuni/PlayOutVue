import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import RundownList from '../RundownList.vue';
import { useRundownStore } from '../../stores/rundown';

describe('PR 3A Rundown Auto-Scroll Watcher & Dynamic Page Size', () => {
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

  it('triggers scrollIntoView when selectedItemId changes in store', async () => {
    store.addItem({ filename: 'Item 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ filename: 'Item 2', type: 'video', path: '/2.mp4', duration: 10 });
    const id1 = store.activeItems[0].id;
    const id2 = store.activeItems[1].id;

    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});

    const wrapper = mount(RundownList, {
      global: {
        stubs: {
          RundownRow: {
            template: '<div class="rw-row" :data-item-id="item.id">{{ item.filename }}</div>',
            props: ['item']
          }
        }
      }
    });

    store.selectedItemId = id2;
    await nextTick();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(scrollSpy).toHaveBeenCalledWith({
      block: 'nearest',
      behavior: 'auto'
    });

    wrapper.unmount();
  });
});
