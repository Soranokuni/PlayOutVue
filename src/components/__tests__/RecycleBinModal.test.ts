// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import RecycleBinModal from '../RecycleBinModal.vue';
import { useMediaLibraryStore } from '../../stores/mediaLibrary';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args)
}));

describe('RecycleBinModal Component & Store Actions', () => {
  let libraryStore: ReturnType<typeof useMediaLibraryStore>;

  beforeEach(() => {
    mockInvoke.mockReset();
    setActivePinia(createPinia());
    libraryStore = useMediaLibraryStore();

    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'list_ingestor_recycle_bin') {
        return Promise.resolve([
          {
            uuid: 'trash-1',
            current_path: '/media/deleted_promo.mp4',
            display_name: 'Deleted Promo',
            virtual_folder: '/Commercials',
            original_virtual_folder: '/Commercials',
            duration_ms: 30000,
            trim_in_ms: 0,
            trim_out_ms: 30000,
            rating: 'K',
            status: 'ready',
            deleted_at: '2026-08-15T12:00:00Z'
          },
          {
            uuid: 'trash-2',
            current_path: '/media/deleted_show.mp4',
            display_name: 'Old Documentary Episode',
            virtual_folder: '/Documentaries',
            original_virtual_folder: '/Documentaries',
            duration_ms: 1200000,
            trim_in_ms: 0,
            trim_out_ms: 1200000,
            rating: '12',
            status: 'ready',
            deleted_at: '2026-08-15T14:30:00Z'
          }
        ]);
      }
      if (cmd === 'restore_ingestor_asset') {
        return Promise.resolve({
          asset: {
            uuid: args.uuid,
            virtual_folder: args.targetFolder || '/',
            deleted_at: null
          },
          restored_to: args.targetFolder || '/',
          fallback_applied: false
        });
      }
      if (cmd === 'purge_ingestor_asset') {
        return Promise.resolve({
          purged_uuid: args.uuid,
          file_purged: true,
          sidecar_purged: true,
          caspar_unregistered: true
        });
      }
      if (cmd === 'purge_ingestor_recycle_bin') {
        return Promise.resolve({
          purged_assets_count: 2,
          purged_files_count: 2
        });
      }
      return Promise.resolve(null);
    });
  });

  it('mounts RecycleBinModal, fetches and renders trashed assets', async () => {
    const wrapper = mount(RecycleBinModal);
    await nextTick();
    await nextTick();

    expect(mockInvoke).toHaveBeenCalledWith('list_ingestor_recycle_bin', { apiBaseUrlOverride: null });
    expect(libraryStore.recycleBinAssets.length).toBe(2);

    const assetNames = wrapper.findAll('.asset-name').map((w) => w.text());
    expect(assetNames).toContain('Deleted Promo');
    expect(assetNames).toContain('Old Documentary Episode');
  });

  it('filters trashed assets with search query', async () => {
    const wrapper = mount(RecycleBinModal);
    await nextTick();
    await nextTick();

    const searchInput = wrapper.find('.search-input');
    await searchInput.setValue('Documentary');
    await nextTick();

    const assetNames = wrapper.findAll('.asset-name').map((w) => w.text());
    expect(assetNames).toEqual(['Old Documentary Episode']);
    expect(assetNames).not.toContain('Deleted Promo');
  });

  it('triggers restore asset on restore button click', async () => {
    const wrapper = mount(RecycleBinModal);
    await nextTick();
    await nextTick();

    const restoreButtons = wrapper.findAll('.restore-btn');
    expect(restoreButtons.length).toBe(2);

    await restoreButtons[0].trigger('click');
    await nextTick();

    expect(mockInvoke).toHaveBeenCalledWith('restore_ingestor_asset', {
      uuid: 'trash-1',
      targetFolder: '/Commercials',
      apiBaseUrlOverride: null
    });

    // Check that asset immediately appeared in active library assets
    expect(libraryStore.assets.some((a) => a.uuid === 'trash-1')).toBe(true);
    expect(libraryStore.recycleBinAssets.some((a) => a.uuid === 'trash-1')).toBe(false);
    expect(libraryStore.deletedUuids.includes('trash-1')).toBe(false);
  });

  it('prompts pulsing danger alert dialog before executing purge', async () => {
    const wrapper = mount(RecycleBinModal);
    await nextTick();
    await nextTick();

    expect(wrapper.find('.danger-pulse-box').exists()).toBe(false);

    const purgeButtons = wrapper.findAll('.purge-btn');
    await purgeButtons[0].trigger('click');
    await nextTick();

    // Dialog should now be open with pulsing danger styling
    const dialog = wrapper.find('.danger-pulse-box');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain('Delete & Purge Asset');
    expect(dialog.text()).toContain('This action is destructive and irreversible');

    // Confirm purge
    const confirmBtn = wrapper.find('.dialog-danger-btn');
    await confirmBtn.trigger('click');
    await nextTick();

    expect(mockInvoke).toHaveBeenCalledWith('purge_ingestor_asset', {
      uuid: 'trash-1',
      apiBaseUrlOverride: null
    });
  });
});

