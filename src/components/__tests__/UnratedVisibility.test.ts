// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import MediaLibrary from '../MediaLibrary.vue';
import { useMediaLibraryStore } from '../../stores/mediaLibrary';

// PlayoutTranscode 1.0.0 ingests a new asset as NONE (unrated) instead of K
// (client guide §8.7). "No badge" is now the normal state of every fresh file,
// so the library must show it explicitly and let an operator filter on it.

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === 'list_ingestor_assets') return Promise.resolve(null);
    return Promise.resolve(null);
  })
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(true),
  message: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockResolvedValue(null)
}));

const stubs = { ContextMenu: true, FolderPickerModal: true, TrimPanel: true, RecycleBinModal: true };

describe('Unrated assets are visible and filterable (client guide §8.7)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const store = useMediaLibraryStore();
    document.body.innerHTML = '';
    store.setAssets([
      {
        uuid: 'asset-rated',
        current_path: '/media/rated.mp4',
        display_name: 'Rated Movie',
        virtual_folder: '/',
        duration_ms: 10000,
        trim_in_ms: 0,
        trim_out_ms: 10000,
        rating: '12|NONE|MOVIE|[]',
        tp: 'None',
        status: 'ready'
      },
      {
        uuid: 'asset-fresh',
        current_path: '/media/fresh.mp4',
        display_name: 'Fresh Ingest',
        virtual_folder: '/',
        duration_ms: 10000,
        trim_in_ms: 0,
        trim_out_ms: 10000,
        // Exactly what a 1.0.0 ingest writes.
        rating: 'NONE',
        tp: 'None',
        status: 'ready'
      }
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders an explicit Unrated chip instead of nothing for a NONE rating', () => {
    const wrapper = mount(MediaLibrary, { global: { stubs } });

    const fresh = wrapper.find('[data-asset-id="asset-fresh"]');
    expect(fresh.exists()).toBe(true);
    expect(fresh.find('[data-testid="unrated-badge"]').exists()).toBe(true);
    expect(fresh.find('[data-testid="age-rating-badge"]').exists()).toBe(false);

    const rated = wrapper.find('[data-asset-id="asset-rated"]');
    expect(rated.find('[data-testid="unrated-badge"]').exists()).toBe(false);
    expect(rated.find('[data-testid="age-rating-badge"]').text()).toBe('12');
    wrapper.unmount();
  });

  it('shows the unrated count and narrows the asset list when the filter is toggled', async () => {
    const wrapper = mount(MediaLibrary, { global: { stubs } });

    const toggle = wrapper.find('[data-testid="filter-unrated"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain('1');

    await toggle.trigger('click');
    expect(wrapper.find('[data-asset-id="asset-fresh"]').exists()).toBe(true);
    expect(wrapper.find('[data-asset-id="asset-rated"]').exists()).toBe(false);

    await toggle.trigger('click');
    expect(wrapper.find('[data-asset-id="asset-rated"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
