// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import MediaLibrary from '../MediaLibrary.vue';
import { useMediaLibraryStore } from '../../stores/mediaLibrary';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(),
  message: vi.fn().mockResolvedValue(undefined),
  open: vi.fn(),
}));

/**
 * UI F-22: the folder rows were plain `div`s with click handlers — no role, no
 * level, no expanded state and no tab stop — while the *asset* rows beside them
 * were already `role="option"`. A screen reader saw half a list.
 */
describe('UI F-22 · library folder tree accessibility', () => {
  const asset = (uuid: string, name: string, folder: string) => ({
    uuid,
    current_path: `D:/Media/${name}`,
    display_name: name.replace(/\.[^.]+$/, ''),
    virtual_folder: folder,
    duration_ms: 60000,
    trim_in_ms: 0,
    trim_out_ms: 0,
    rating: '',
    status: 'ready',
    mezzanine_ok: true,
  });

  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
    const store = useMediaLibraryStore();
    store.assets = [
      asset('a-1', 'Station_ID.mp4', '/Branding'),
      asset('a-2', 'Promo.mp4', '/Branding/Promos'),
      asset('a-3', 'Film.mkv', '/Movies'),
    ] as any;
  });

  const mountLibrary = async () => {
    const wrapper = mount(MediaLibrary, { attachTo: document.body });
    await nextTick();
    await nextTick();
    return wrapper;
  };

  it('exposes the folder pane as a labelled tree', async () => {
    const wrapper = await mountLibrary();

    const tree = document.querySelector('[role="tree"]');
    expect(tree).not.toBeNull();
    expect(tree?.getAttribute('aria-label')).toBe('Virtual folders');

    wrapper.unmount();
  });

  it('gives every folder row a treeitem role and a depth level', async () => {
    const wrapper = await mountLibrary();

    const rows = Array.from(document.querySelectorAll('[role="treeitem"]'));
    expect(rows.length).toBeGreaterThan(1);

    for (const row of rows) {
      const level = Number(row.getAttribute('aria-level'));
      expect(Number.isFinite(level)).toBe(true);
      // aria-level is 1-based; a depth-0 root must not announce as level 0.
      expect(level).toBeGreaterThanOrEqual(1);
      expect(row.hasAttribute('aria-selected')).toBe(true);
    }

    wrapper.unmount();
  });

  it('announces expanded state only on rows that have children', async () => {
    const wrapper = await mountLibrary();

    const rows = Array.from(document.querySelectorAll('[role="treeitem"]'));
    const withChildren = rows.filter((row) => row.hasAttribute('aria-expanded'));
    const leaves = rows.filter((row) => !row.hasAttribute('aria-expanded'));

    // The seeded tree has both: /Branding has a child, /Movies does not.
    expect(withChildren.length).toBeGreaterThan(0);
    expect(leaves.length).toBeGreaterThan(0);
    for (const row of withChildren) {
      expect(['true', 'false']).toContain(row.getAttribute('aria-expanded'));
    }

    wrapper.unmount();
  });

  it('keeps exactly one tab stop in the tree (roving tabindex)', async () => {
    const wrapper = await mountLibrary();

    const rows = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const tabbable = rows.filter((row) => row.tabIndex === 0);

    // Tab enters the tree once and lands on the selected row; the arrows are
    // the global router's job (see the note in MediaLibrary.vue).
    expect(tabbable).toHaveLength(1);

    wrapper.unmount();
  });
});
