// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import MediaLibrary from '../MediaLibrary.vue';
import { useMediaLibraryStore } from '../../stores/mediaLibrary';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === 'list_ingestor_assets') {
      return Promise.resolve([
        {
          uuid: 'asset-healthy',
          current_path: '/media/healthy.mp4',
          display_name: 'Healthy Movie',
          virtual_folder: '/',
          duration_ms: 125000,
          trim_in_ms: 0,
          trim_out_ms: 125000,
          rating: '12',
          status: 'ready',
          mezzanine_ok: true
        },
        {
          uuid: 'asset-warning',
          current_path: '/media/warning.mp4',
          display_name: 'Warning Clip',
          virtual_folder: '/',
          duration_ms: 3665000,
          trim_in_ms: 0,
          trim_out_ms: 3665000,
          rating: 'none',
          status: 'error',
          warnings: ['Audio sample rate is 44.1kHz instead of 48kHz']
        }
      ]);
    }
    if (cmd === 'get_folder_colors') return Promise.resolve({});
    if (cmd === 'get_probe_status') {
      return Promise.resolve({ running: false, totalCandidates: 0, checked: 0, currentPath: null, error: null });
    }
    if (cmd === 'rename_ingestor_asset') return Promise.resolve();
    return Promise.resolve(null);
  })
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(true),
  message: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockResolvedValue(null)
}));

describe('Aether 3.0 MediaLibrary Ergonomics & Quiet UI', () => {
  let libraryStore: ReturnType<typeof useMediaLibraryStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    libraryStore = useMediaLibraryStore();
    document.body.innerHTML = '';

    libraryStore.setAssets([
      {
        uuid: 'asset-healthy',
        current_path: '/media/healthy.mp4',
        display_name: 'Healthy Movie',
        virtual_folder: '/',
        duration_ms: 125000,
        trim_in_ms: 0,
        trim_out_ms: 125000,
        rating: '12',
        status: 'ready',
        mezzanine_ok: true
      },
      {
        uuid: 'asset-warning',
        current_path: '/media/warning.mp4',
        display_name: 'Warning Clip',
        virtual_folder: '/',
        duration_ms: 3665000,
        trim_in_ms: 0,
        trim_out_ms: 3665000,
        rating: 'none',
        status: 'error',
        warnings: ['Audio sample rate is 44.1kHz']
      }
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders Two-Pane Explorer split with folder pane, divider, and asset pane', () => {
    const wrapper = mount(MediaLibrary, {
      global: {
        stubs: {
          ContextMenu: true,
          FolderPickerModal: true,
          TrimPanel: true,
          RecycleBinModal: true
        }
      }
    });

    expect(wrapper.find('.lib-folder-pane').exists()).toBe(true);
    expect(wrapper.find('.lib-pane-divider').exists()).toBe(true);
    expect(wrapper.find('.lib-asset-pane').exists()).toBe(true);
    wrapper.unmount();
  });

  it('renders persistent Recycle Bin system node at bottom of folder pane with count badge', () => {
    libraryStore.recycleBinAssets = [
      {
        uuid: 'asset-trashed',
        current_path: '/media/trashed.mp4',
        display_name: 'Trashed Clip',
        virtual_folder: '/',
        duration_ms: 5000,
        trim_in_ms: 0,
        trim_out_ms: 5000,
        rating: 'none',
        status: 'ready'
      }
    ];

    const wrapper = mount(MediaLibrary, {
      global: {
        stubs: {
          ContextMenu: true,
          FolderPickerModal: true,
          TrimPanel: true,
          RecycleBinModal: true
        }
      }
    });

    const bin = wrapper.find('.system-node-recycle-bin');
    expect(bin.exists()).toBe(true);
    expect(bin.text()).toContain('Recycle Bin');
    expect(bin.find('.recycle-bin-count-badge').text()).toBe('1');
    wrapper.unmount();
  });

  it('enforces MCR Quiet UI: suppresses green status indicator on healthy ready clips, shows indicator on errors/warnings', () => {
    const wrapper = mount(MediaLibrary, {
      global: {
        stubs: {
          ContextMenu: true,
          FolderPickerModal: true,
          TrimPanel: true,
          RecycleBinModal: true
        }
      }
    });

    const healthyRow = wrapper.find('[data-asset-id="asset-healthy"]');
    expect(healthyRow.exists()).toBe(true);
    // Healthy clip should NOT render a status indicator dot
    const healthyDot = healthyRow.findComponent({ name: 'StatusIndicator' });
    expect(healthyDot.exists()).toBe(false);

    const warningRow = wrapper.find('[data-asset-id="asset-warning"]');
    expect(warningRow.exists()).toBe(true);
    // Warning clip MUST render a status indicator
    const warningDot = warningRow.findComponent({ name: 'StatusIndicator' });
    expect(warningDot.exists()).toBe(true);
    wrapper.unmount();
  });

  it('renders fixed-width monospace tabular duration pill (MM:SS and HH:MM:SS)', () => {
    const wrapper = mount(MediaLibrary, {
      global: {
        stubs: {
          ContextMenu: true,
          FolderPickerModal: true,
          TrimPanel: true,
          RecycleBinModal: true
        }
      }
    });

    // 125s = 02:05
    const healthyPill = wrapper.find('[data-asset-id="asset-healthy"] .tabular-duration');
    expect(healthyPill.exists()).toBe(true);
    expect(healthyPill.text()).toBe('02:05');

    // 3665s = 01:01:05
    const warningPill = wrapper.find('[data-asset-id="asset-warning"] .tabular-duration');
    expect(warningPill.exists()).toBe(true);
    expect(warningPill.text()).toBe('01:01:05');
    wrapper.unmount();
  });

  it('allows opening Actions dropdown with Rename, Move, Delete without window.prompt', async () => {
    const promptMock = vi.fn();
    window.prompt = promptMock;
    const wrapper = mount(MediaLibrary, {
      global: {
        stubs: {
          ContextMenu: true,
          FolderPickerModal: true,
          TrimPanel: true,
          RecycleBinModal: true
        }
      }
    });

    const trigger = wrapper.find('.lib-actions-trigger');
    expect(trigger.exists()).toBe(true);
    await trigger.trigger('click');

    const menu = wrapper.find('.lib-actions-menu');
    expect(menu.exists()).toBe(true);

    const menuButtons = menu.findAll('button');
    const texts = menuButtons.map(b => b.text());
    expect(texts.some(t => t.includes('Rename'))).toBe(true);
    expect(texts.some(t => t.includes('Move'))).toBe(true);
    expect(texts.some(t => t.includes('Delete'))).toBe(true);

    expect(promptMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('canceling new virtual folder input with Escape does not create folder', async () => {
    const wrapper = mount(MediaLibrary, {
      global: {
        stubs: {
          ContextMenu: true,
          FolderPickerModal: true,
          TrimPanel: true,
          RecycleBinModal: true
        }
      }
    });

    libraryStore.currentFolderPath = '/';
    const newBtn = wrapper.findAll('.lib-toolbar button').find(b => b.text().includes('New'));
    expect(newBtn).toBeDefined();
    await newBtn!.trigger('click');

    const input = wrapper.find('.lib-new-folder-input');
    expect(input.exists()).toBe(true);

    // Hit Escape to cancel
    await input.trigger('keydown', { key: 'Escape' });
    await input.trigger('blur');

    expect(wrapper.find('.lib-new-folder-input').exists()).toBe(false);
    expect(libraryStore.transientFolders['/New Folder']).toBeUndefined();
    wrapper.unmount();
  });

  it('enables Move and Delete in actions dropdown when a non-root folder is selected', async () => {
    const wrapper = mount(MediaLibrary, {
      global: {
        stubs: {
          ContextMenu: true,
          FolderPickerModal: true,
          TrimPanel: true,
          RecycleBinModal: true
        }
      }
    });

    // Select a virtual folder
    libraryStore.clearSelection();
    libraryStore.selectNode('folder:/Promos');

    const trigger = wrapper.find('.lib-actions-trigger');
    await trigger.trigger('click');

    const menu = wrapper.find('.lib-actions-menu');
    const moveBtn = menu.findAll('button').find(b => b.text().includes('Move'));
    const deleteBtn = menu.findAll('button').find(b => b.text().includes('Delete'));

    expect(moveBtn?.attributes('disabled')).toBeUndefined();
    expect(deleteBtn?.attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });
});
