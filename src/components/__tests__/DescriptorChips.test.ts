// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import MediaLibrary from '../MediaLibrary.vue';
import DescriptorChips from '../ui/DescriptorChips.vue';
import { useMediaLibraryStore } from '../../stores/mediaLibrary';

// ΕΣΡ descriptors were editable from both right-click menus but shown nowhere,
// so an operator could not see why a film carried its rating.

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(true),
  message: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockResolvedValue(null)
}));

const stubs = { ContextMenu: true, FolderPickerModal: true, TrimPanel: true, RecycleBinModal: true };

describe('ΕΣΡ descriptor chips', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.clearAllMocks());

  it('renders letters in canonical order with the full label as the tooltip', () => {
    const wrapper = mount(DescriptorChips, { props: { ids: ['language', 'violence'] } });
    const chips = wrapper.findAll('.desc-chip');
    expect(chips.map((c) => c.text())).toEqual(['Β', 'Φ']);
    expect(chips[0]!.attributes('title')).toContain('Βία');
    expect(chips[1]!.classes()).toContain('desc-language');
  });

  it('renders nothing without descriptors', () => {
    expect(mount(DescriptorChips, { props: { ids: [] } }).find('[data-testid="descriptor-chips"]').exists()).toBe(false);
    expect(mount(DescriptorChips, { props: { ids: null } }).find('[data-testid="descriptor-chips"]').exists()).toBe(false);
  });

  it('shows the asset descriptors in the library row', () => {
    const store = useMediaLibraryStore();
    store.setAssets([{
      uuid: 'film', current_path: '/m/film.mxf', display_name: 'Film', virtual_folder: '/',
      duration_ms: 1000, trim_in_ms: 0, trim_out_ms: 1000, status: 'ready',
      rating: '16|NONE|MOVIE|[{"start":0,"end":30,"text":"ΣΚΗΝΕΣ ΒΙΑΣ · ΧΡΗΣΗ ΟΥΣΙΩΝ"}]',
    }]);
    const wrapper = mount(MediaLibrary, { global: { stubs } });
    const row = wrapper.find('[data-asset-id="film"]');
    expect(row.findAll('.desc-chip').map((c) => c.attributes('data-descriptor'))).toEqual(['violence', 'substances']);
    wrapper.unmount();
  });
});
