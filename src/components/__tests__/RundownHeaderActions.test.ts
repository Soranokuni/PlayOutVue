// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import RundownList from '../RundownList.vue';
import PlaylistControls from '../PlaylistControls.vue';
import { useRundownStore } from '../../stores/rundown';

/**
 * UI/UX plan §6.3 — the rundown header, tabs and schedule row.
 *
 * Save / Load / Append / Clear are session-scale file management that used to
 * occupy the bottom bar's prime width beside the controls used every minute;
 * they now live in the header overflow. The bottom bar itself collapsed into
 * the one thing that lives nowhere else — when an offline playlist starts —
 * and the tabs stopped labelling every playlist "OFFLINE", which is the normal
 * state and therefore not news.
 */

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(false),
  message: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

const stubs = { ContextMenu: true, LiveEntryDialog: true, TrimPanel: true, RundownRow: true };

describe('Rundown header, tabs and schedule row (§6.3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('keeps the four playlist file actions behind one header overflow', async () => {
    const wrapper = mount(RundownList, { global: { stubs } });

    // Closed by default: the header stays four controls wide.
    expect(wrapper.find('.rw-overflow-menu').exists()).toBe(false);

    await wrapper.find('[data-testid="rundown-overflow"]').trigger('click');

    const labels = wrapper.findAll('.rw-overflow-item').map((b) => b.text());
    expect(labels).toEqual(['Save playlist…', 'Load playlist…', 'Append playlist…', 'Clear playlist…']);
    // Clear is the only destructive one and is the only one marked as such.
    expect(wrapper.findAll('.rw-overflow-item.popover-item--danger')).toHaveLength(1);
    wrapper.unmount();
  });

  it('labels only the on-air tab, and gives the rest their item count', () => {
    const store = useRundownStore();
    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/media/2.mp4', duration: 10 });

    const wrapper = mount(RundownList, { global: { stubs } });

    // Nothing is on air, so no tab claims a state word at all.
    expect(wrapper.find('.playlist-tab-state').exists()).toBe(false);
    expect(wrapper.find('.playlist-tab-count').text()).toBe('2');
    expect(wrapper.text()).not.toContain('OFFLINE');
    wrapper.unmount();
  });

  it('renders the schedule row only while the playlist can be scheduled', async () => {
    const store = useRundownStore();
    const wrapper = mount(PlaylistControls);

    expect(store.canScheduleCurrentPlaylist).toBe(true);
    expect(wrapper.find('.pl-schedule').exists()).toBe(true);
    // The name, state pill and duplicated count are gone: the tab owns them.
    expect(wrapper.find('.pl-name').exists()).toBe(false);
    expect(wrapper.find('.pl-state-pill').exists()).toBe(false);

    store.onAirPlaylistId = store.activePlaylistId;
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.pl-schedule').exists()).toBe(false);
    expect(wrapper.find('.pl-onair-note').exists()).toBe(true);
    wrapper.unmount();
  });
});
