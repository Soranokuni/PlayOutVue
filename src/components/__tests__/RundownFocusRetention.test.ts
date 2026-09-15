// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import RundownList from '../RundownList.vue';
import { useRundownStore } from '../../stores/rundown';
import { ask } from '@tauri-apps/plugin-dialog';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({})
}));

vi.mock('../../services/playout', () => ({
  currentPlayoutMs: { value: 0 },
  currentTotalPlayoutMs: { value: 0 },
  getActivePlayoutService: vi.fn(() => ({
    stop: vi.fn().mockResolvedValue(undefined),
    refreshQueue: vi.fn().mockResolvedValue(undefined)
  })),
  isPlayoutPlaying: { value: false },
  registerPlayoutAdvanceListener: vi.fn()
}));

describe('Slice 5: Rundown Focus Retention & Selection Clamping', () => {
  let store: ReturnType<typeof useRundownStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useRundownStore();
    document.body.innerHTML = '';
    vi.clearAllMocks();

    if (store.playlists[0]) {
      store.activatePlaylist(store.playlists[0].id);
      store.playlists[0].items = [];
      store.clearSelection();
    }
  });

  const mountRundown = () => {
    return mount(RundownList, {
      attachTo: document.body,
      global: {
        stubs: {
          RundownRow: {
            template: `
              <div class="rw-row" :data-item-id="item.id">
                <button class="del-btn" @click="$emit('delete')">Delete</button>
              </div>
            `,
            props: ['item'],
            emits: ['delete']
          },
          ContextMenu: true,
          StatusIndicator: true,
          LiveEntryDialog: true,
          PlaylistControls: true
        }
      }
    });
  };

  it('restores list focus and clamps selection to next item on row delete confirmation', async () => {
    store.addItem({ filename: 'Item 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ filename: 'Item 2', type: 'video', path: '/2.mp4', duration: 10 });
    store.addItem({ filename: 'Item 3', type: 'video', path: '/3.mp4', duration: 10 });

    const [id1, id2, id3] = store.activeItems.map(i => i.id);
    store.selectItem(id2);

    vi.mocked(ask).mockResolvedValueOnce(true);

    const wrapper = mountRundown();
    const listEl = wrapper.find('.rw-list').element as HTMLElement;
    const focusSpy = vi.spyOn(listEl, 'focus');

    // Trigger delete on middle item (index 1)
    const deleteButtons = wrapper.findAll('.del-btn');
    expect(deleteButtons.length).toBe(3);
    await deleteButtons[1].trigger('click');
    await nextTick();

    expect(ask).toHaveBeenCalledTimes(1);
    expect(store.activeItems.map(i => i.id)).toEqual([id1, id3]);
    // Clamped selection should now point to id3 (index 1 in remaining)
    expect(store.selectedItemId).toBe(id3);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

    wrapper.unmount();
  });

  it('restores list focus and clamps selection when deleting the last item in the list', async () => {
    store.addItem({ filename: 'Item 1', type: 'video', path: '/1.mp4', duration: 10 });
    store.addItem({ filename: 'Item 2', type: 'video', path: '/2.mp4', duration: 10 });

    const [id1, id2] = store.activeItems.map(i => i.id);
    store.selectItem(id2);

    vi.mocked(ask).mockResolvedValueOnce(true);

    const wrapper = mountRundown();
    const listEl = wrapper.find('.rw-list').element as HTMLElement;
    const focusSpy = vi.spyOn(listEl, 'focus');

    // Delete last item (index 1)
    const deleteButtons = wrapper.findAll('.del-btn');
    await deleteButtons[1].trigger('click');
    await nextTick();

    expect(store.activeItems.map(i => i.id)).toEqual([id1]);
    // Selection clamped to index 0 (id1)
    expect(store.selectedItemId).toBe(id1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

    wrapper.unmount();
  });

  it('restores list focus even when user cancels the deletion dialog', async () => {
    store.addItem({ filename: 'Item 1', type: 'video', path: '/1.mp4', duration: 10 });
    const id1 = store.activeItems[0].id;
    store.selectItem(id1);

    vi.mocked(ask).mockResolvedValueOnce(false);

    const wrapper = mountRundown();
    const listEl = wrapper.find('.rw-list').element as HTMLElement;
    const focusSpy = vi.spyOn(listEl, 'focus');

    const deleteBtn = wrapper.find('.del-btn');
    await deleteBtn.trigger('click');
    await nextTick();

    // Item was not removed
    expect(store.activeItems.length).toBe(1);
    expect(store.selectedItemId).toBe(id1);
    // Focus was still restored to list container
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

    wrapper.unmount();
  });
});
