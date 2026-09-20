// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import MediaLibrary from '../MediaLibrary.vue';
import { useMediaLibraryStore } from '../../stores/mediaLibrary';

/**
 * UI/UX plan §5.2 — the library asset row.
 *
 * The row used to spend its width on up to four chips (rating, TP, content
 * type, and "Unrated" even while the Unrated filter was on) and then truncate
 * the only field the operator is actually scanning: the name. These are the
 * three width decisions that fixed it, pinned so they cannot drift back.
 */

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === 'list_ingestor_assets') return Promise.resolve(null);
    return Promise.resolve(null);
  }),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(true),
  message: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockResolvedValue(null),
}));

const stubs = { ContextMenu: true, FolderPickerModal: true, TrimPanel: true, RecycleBinModal: true };

const baseAsset = {
  current_path: '/media/x.mp4',
  virtual_folder: '/Promos/Summer',
  duration_ms: 10000,
  trim_in_ms: 0,
  trim_out_ms: 10000,
  tp: 'None',
  status: 'ready',
};

describe('Library asset row anatomy (§5.2)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
    localStorage.clear();
    const store = useMediaLibraryStore();
    store.setAssets([
      // Rated, product placement, typed.
      {
        ...baseAsset,
        uuid: 'asset-tp',
        display_name: 'Rated With TP',
        rating: '12|TP|MOVIE|[]',
        tp: 'TP',
      },
      // Unrated, untyped.
      { ...baseAsset, uuid: 'asset-plain', display_name: 'Fresh Ingest', rating: 'NONE' },
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders content type as a left tint bar rather than a chip', () => {
    const wrapper = mount(MediaLibrary, { global: { stubs } });

    const row = wrapper.find('[data-asset-id="asset-tp"]');
    expect(row.attributes('data-content-type')).toBe('movie');
    expect(row.find('.lib-type-bar').exists()).toBe(true);
    // The chip is gone: the bar plus its tooltip carry the same information
    // without competing with the title for width.
    expect(row.find('.badge-content').exists()).toBe(false);

    const plain = wrapper.find('[data-asset-id="asset-plain"]');
    expect(plain.find('.lib-type-bar').exists()).toBe(false);
    wrapper.unmount();
  });

  it('rides TP on the rating chip as a dot, and only spends a chip when unrated', () => {
    const wrapper = mount(MediaLibrary, { global: { stubs } });

    const rated = wrapper.find('[data-asset-id="asset-tp"]');
    const badge = rated.find('[data-testid="age-rating-badge"]');
    expect(badge.classes()).toContain('has-tp');
    expect(badge.find('.badge-tp-dot').exists()).toBe(true);
    // No standalone TP chip while a rating chip is there to carry the dot.
    expect(rated.find('.badge-tp').exists()).toBe(false);
    // The tooltip is what spells the dot out.
    expect(badge.attributes('title')).toContain('Product placement');
    wrapper.unmount();
  });

  it('drops the Unrated chip while the Unrated filter is on', async () => {
    const wrapper = mount(MediaLibrary, { global: { stubs } });

    expect(wrapper.find('[data-testid="unrated-badge"]').exists()).toBe(true);

    await wrapper.find('[data-testid="filter-unrated"]').trigger('click');

    // Every visible row is unrated now, so the chip says nothing.
    expect(wrapper.find('[data-asset-id="asset-plain"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="unrated-badge"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps single-line rows by default and persists the two-line opt-in', async () => {
    const wrapper = mount(MediaLibrary, { global: { stubs } });

    expect(wrapper.find('[data-asset-id="asset-plain"]').classes()).not.toContain('is-two-line');
    expect(wrapper.find('.lib-subline').exists()).toBe(false);

    await wrapper.find('[data-testid="toggle-row-mode"]').trigger('click');

    expect(wrapper.find('[data-asset-id="asset-plain"]').classes()).toContain('is-two-line');
    expect(wrapper.find('.lib-subline-path').text()).toBe('Promos › Summer');
    expect(localStorage.getItem('layout.libraryRowMode')).toContain('two-line');
    wrapper.unmount();
  });
});
