// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import RundownList from '../RundownList.vue';
import PlaylistControls from '../PlaylistControls.vue';
import { useRundownStore } from '../../stores/rundown';
import { clearToasts, toasts } from '../../lib/toasts';

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

  // Round 3 §5.1 supersedes §6.3 for the three file actions: the owner uses
  // them constantly, and an action used constantly does not belong two clicks
  // deep. The overflow keeps only what is genuinely rare.
  it('puts Load, Append and Save in the header as one labelled group', () => {
    const wrapper = mount(RundownList, { global: { stubs } });

    const group = wrapper.get('.rw-file-group');
    expect(group.attributes('role')).toBe('group');
    expect(group.attributes('aria-label')).toBe('Playlist file');

    const names = group.findAll('button').map((b) => b.attributes('aria-label'));
    expect(names).toEqual(['Load playlist', 'Append playlist', 'Save playlist']);
    wrapper.unmount();
  });

  it('leaves only the rare actions in the header overflow', async () => {
    const wrapper = mount(RundownList, { global: { stubs } });

    expect(wrapper.find('.rw-overflow-menu').exists()).toBe(false);
    await wrapper.find('[data-testid="rundown-overflow"]').trigger('click');

    const labels = wrapper.findAll('.rw-overflow-item').map((b) => b.text());
    expect(labels).toEqual(['Rename playlist…', 'Duplicate playlist', 'Clear all items…']);
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

/**
 * Round 3 §5.2 — Delete playlist.
 *
 * There was no delete-playlist control at all: only the tab's `x`, which
 * closed, and "Clear playlist…" in the overflow, which emptied — two different
 * outcomes behind names that sound alike. Delete now follows the pattern the
 * operator already knows from CUT TO LIVE: click to arm, click to confirm,
 * auto-disarm after four seconds.
 *
 * The point of the arm is not the extra click. It is that the *target* becomes
 * visible before any dialog, so what the operator is looking at when they
 * click the second time is the tab that will go — not an OK button.
 */
describe('Round 3 §5.2 · Delete playlist', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
    clearToasts();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    clearToasts();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  const deleteBtn = (wrapper: ReturnType<typeof mount>) =>
    wrapper.get('[data-testid="rundown-delete-playlist"]');

  it('refuses the ON AIR playlist, and says why', async () => {
    const store = useRundownStore();
    store.onAirPlaylistId = store.activePlaylistId;
    store.createPlaylist();
    store.activatePlaylist(store.onAirPlaylistId!);

    const wrapper = mount(RundownList, { global: { stubs } });
    await wrapper.vm.$nextTick();

    const btn = deleteBtn(wrapper);
    expect(btn.attributes('disabled')).toBeDefined();
    expect(btn.attributes('title')).toContain("Can't delete the ON AIR playlist");
    wrapper.unmount();
  });

  it('refuses the last playlist, and points at Clear instead', () => {
    const store = useRundownStore();
    expect(store.playlists).toHaveLength(1);

    const wrapper = mount(RundownList, { global: { stubs } });
    const btn = deleteBtn(wrapper);
    expect(btn.attributes('disabled')).toBeDefined();
    expect(btn.attributes('title')).toContain("Can't delete the last playlist");
    wrapper.unmount();
  });

  it('marks the target on the first click without deleting anything', async () => {
    const store = useRundownStore();
    store.createPlaylist();
    const targetId = store.activePlaylistId;

    const wrapper = mount(RundownList, { global: { stubs } });
    await deleteBtn(wrapper).trigger('click');

    expect(store.playlists).toHaveLength(2);
    const marked = wrapper.findAll('.playlist-tab.is-delete-target');
    expect(marked).toHaveLength(1);
    expect(wrapper.find('.playlist-tab-state.is-deleting').text()).toBe('DELETING');
    expect(wrapper.find('.rw-delete-overlay').exists()).toBe(true);
    expect(store.activePlaylistId).toBe(targetId);
    wrapper.unmount();
  });

  it('deletes an empty playlist on the second click and offers Undo', async () => {
    const store = useRundownStore();
    store.createPlaylist();
    const targetId = store.activePlaylistId;

    const wrapper = mount(RundownList, { global: { stubs } });
    await deleteBtn(wrapper).trigger('click');
    await deleteBtn(wrapper).trigger('click');

    expect(store.playlists.map((p) => p.id)).not.toContain(targetId);
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.message).toContain('0 items');
    expect(toasts.value[0]?.action?.label).toBe('Undo');
    wrapper.unmount();
  });

  it('asks once more before losing a playlist that has items in it', async () => {
    const store = useRundownStore();
    store.createPlaylist();
    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    const targetId = store.activePlaylistId;

    const wrapper = mount(RundownList, { global: { stubs } });
    await deleteBtn(wrapper).trigger('click');
    await deleteBtn(wrapper).trigger('click');

    // Still there: the modal is the gate, and the arm has already dropped.
    expect(store.playlists.map((p) => p.id)).toContain(targetId);
    expect(wrapper.findAll('.playlist-tab.is-delete-target')).toHaveLength(0);
    wrapper.unmount();
  });

  it('disarms on Escape', async () => {
    const store = useRundownStore();
    store.createPlaylist();

    const wrapper = mount(RundownList, { global: { stubs }, attachTo: document.body });
    await deleteBtn(wrapper).trigger('click');
    expect(wrapper.findAll('.playlist-tab.is-delete-target')).toHaveLength(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.playlist-tab.is-delete-target')).toHaveLength(0);
    expect(store.playlists).toHaveLength(2);
    wrapper.unmount();
  });

  it('disarms itself after four seconds', async () => {
    vi.useFakeTimers();
    const store = useRundownStore();
    store.createPlaylist();

    const wrapper = mount(RundownList, { global: { stubs } });
    await deleteBtn(wrapper).trigger('click');
    expect(wrapper.findAll('.playlist-tab.is-delete-target')).toHaveLength(1);

    vi.advanceTimersByTime(4000);
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.playlist-tab.is-delete-target')).toHaveLength(0);
    expect(store.playlists).toHaveLength(2);
    wrapper.unmount();
  });

  it('keeps the tab close affordance for empty tabs only', async () => {
    const store = useRundownStore();
    store.createPlaylist();
    const wrapper = mount(RundownList, { global: { stubs } });

    expect(wrapper.findAll('.playlist-tab-close')).toHaveLength(2);

    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    await wrapper.vm.$nextTick();

    // The tab that now has an item loses its `x`; the empty one keeps it.
    expect(wrapper.findAll('.playlist-tab-close')).toHaveLength(1);
    wrapper.unmount();
  });
});
