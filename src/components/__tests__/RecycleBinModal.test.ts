// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import RecycleBinModal from '../RecycleBinModal.vue';

/**
 * BaseModal (UI F-11) renders through a Teleport to <body>, so these helpers
 * query the document rather than the component wrapper.
 */
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const qa = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));
const textsOf = (selector: string) => qa(selector).map((el) => el.textContent?.trim() ?? '');
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

    const assetNames = textsOf('.asset-name');
    expect(assetNames).toContain('Deleted Promo');
    expect(assetNames).toContain('Old Documentary Episode');

    wrapper.unmount();
  });

  it('filters trashed assets with search query', async () => {
    const wrapper = mount(RecycleBinModal);
    await nextTick();
    await nextTick();

    const searchInput = q<HTMLInputElement>('.search-input')!;
    searchInput.value = 'Documentary';
    searchInput.dispatchEvent(new Event('input'));
    await nextTick();

    const assetNames = textsOf('.asset-name');
    expect(assetNames).toEqual(['Old Documentary Episode']);
    expect(assetNames).not.toContain('Deleted Promo');

    wrapper.unmount();
  });

  it('triggers restore asset on restore button click', async () => {
    const wrapper = mount(RecycleBinModal);
    await nextTick();
    await nextTick();

    const restoreButtons = qa('.restore-btn');
    expect(restoreButtons.length).toBe(2);

    restoreButtons[0]!.click();
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

    wrapper.unmount();
  });

  it('confirms through the shared danger dialog before executing a purge', async () => {
    const wrapper = mount(RecycleBinModal);
    await nextTick();
    await nextTick();

    expect(q('.danger-body')).toBeNull();

    qa('.purge-btn')[0]!.click();
    await nextTick();
    await nextTick();

    // UI F-11: this is now DangerConfirm, the one irreversible-action dialog,
    // shared with MediaLibrary instead of duplicated in it.
    const dialog = q('.danger-body')!;
    expect(dialog).not.toBeNull();
    // §9 glossary: one name for the irreversible action, everywhere.
    expect(qa('.modal-title').map((el) => el.textContent?.trim())).toContain('Delete permanently');
    expect(dialog.textContent).toContain('permanently purge "Deleted Promo"');
    expect(dialog.textContent).toContain('cannot be undone');

    // The confirm button is the footer's primary, and nothing is bound to
    // Enter — an irreversible action has to be pressed.
    const confirmBtn = qa('.modal-footer .btn--danger')[0]!;
    confirmBtn.click();
    await nextTick();

    expect(mockInvoke).toHaveBeenCalledWith('purge_ingestor_asset', {
      uuid: 'trash-1',
      apiBaseUrlOverride: null
    });

    wrapper.unmount();
  });
});

