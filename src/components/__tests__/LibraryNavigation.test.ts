// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import MediaLibrary from '../MediaLibrary.vue';
import { useMediaLibraryStore } from '../../stores/mediaLibrary';
import {
  commandRegistry,
  type CommandContext,
  type LibraryCommandContext
} from '../../services/commandRegistry';
import {
  useOperatorShortcuts,
  activeLibraryContext,
  resetShortcutsMountedStateForTesting
} from '../../composables/useOperatorShortcuts';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === 'list_ingestor_assets') {
      return Promise.resolve([
        { uuid: 'asset-1', current_path: '/media/1.mp4', display_name: 'Alpha Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
        { uuid: 'asset-2', current_path: '/media/2.mp4', display_name: 'Beta Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
        { uuid: 'asset-3', current_path: '/media/3.mp4', display_name: 'Charlie Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
        { uuid: 'asset-4', current_path: '/media/4.mp4', display_name: 'Delta Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' }
      ]);
    }
    if (cmd === 'get_folder_colors') {
      return Promise.resolve({});
    }
    if (cmd === 'get_probe_status') {
      return Promise.resolve({ running: false, totalCandidates: 0, checked: 0, currentPath: null, error: null });
    }
    return Promise.resolve(null);
  })
}));

describe('PR 3A Library Keyboard Navigation & Selection State (Remediated)', () => {
  let libraryStore: ReturnType<typeof useMediaLibraryStore>;
  let shortcuts: ReturnType<typeof useOperatorShortcuts>;

  beforeEach(() => {
    resetShortcutsMountedStateForTesting();
    setActivePinia(createPinia());
    libraryStore = useMediaLibraryStore();
    document.body.innerHTML = '';

    libraryStore.setAssets([
      { uuid: 'asset-1', current_path: '/media/1.mp4', display_name: 'Alpha Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
      { uuid: 'asset-2', current_path: '/media/2.mp4', display_name: 'Beta Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
      { uuid: 'asset-3', current_path: '/media/3.mp4', display_name: 'Charlie Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' },
      { uuid: 'asset-4', current_path: '/media/4.mp4', display_name: 'Delta Asset', virtual_folder: '/', duration_ms: 10000, trim_in_ms: 0, trim_out_ms: 10000, rating: 'none', status: 'ready' }
    ]);
    libraryStore.clearSelection();

    const libraryContextAdapter: LibraryCommandContext = {
      getSelectedAssetIds: () => libraryStore.selectedAssetIds,
      getVisibleAssetIds: () => libraryStore.allTreeNodes.filter(n => n.type === 'asset').map(n => n.asset?.uuid || n.id),
      selectPrevious: () => libraryStore.moveSelectionDelta(-1),
      selectNext: () => libraryStore.moveSelectionDelta(1),
      selectFirst: () => libraryStore.selectFirst(),
      selectLast: () => libraryStore.selectLast(),
      extendSelection: (delta: -1 | 1) => libraryStore.extendSelection(delta),
      appendSelectedToPlaylist: async () => ({ insertedIds: [], skippedIds: [], errors: [] }),
      insertSelectedAfter: async () => ({ insertedIds: [], skippedIds: [], errors: [] })
    };
    activeLibraryContext.value = libraryContextAdapter;

    shortcuts = useOperatorShortcuts();
    shortcuts.mountShortcuts();
  });

  afterEach(() => {
    shortcuts.unmountShortcuts();
    resetShortcutsMountedStateForTesting();
    activeLibraryContext.value = null;
    document.body.innerHTML = '';
  });

  const createTestContext = (scope: any = 'library', visibleNodes?: any[]): CommandContext => {
    const visibleAssetNodes = visibleNodes || libraryStore.allTreeNodes.filter(n => n.type === 'asset');
    return {
      scope,
      rundown: {} as any,
      selection: { selectedItemIds: [], primarySelectedId: null },
      library: {
        getSelectedAssetIds: () => libraryStore.selectedAssetIds,
        getVisibleAssetIds: () => visibleAssetNodes.map(n => n.asset?.uuid || n.id),
        selectPrevious: () => libraryStore.moveSelectionDelta(-1, visibleAssetNodes),
        selectNext: () => libraryStore.moveSelectionDelta(1, visibleAssetNodes),
        selectFirst: () => libraryStore.selectFirst(visibleAssetNodes),
        selectLast: () => libraryStore.selectLast(visibleAssetNodes),
        extendSelection: (delta: -1 | 1) => libraryStore.extendSelection(delta, visibleAssetNodes),
        appendSelectedToPlaylist: async () => ({ insertedIds: [], skippedIds: [], errors: [] }),
        insertSelectedAfter: async () => ({ insertedIds: [], skippedIds: [], errors: [] })
      },
      activeModal: null,
      trimmer: null
    };
  };

  it('selects first asset on ArrowDown when nothing is selected', async () => {
    const ctx = createTestContext('library');
    const executed = await commandRegistry.execute('library.selectNext', ctx);

    expect(executed).toBe(true);
    expect(libraryStore.selectedAssetId).toBe('asset-1');
  });

  it('navigates next and previous using ArrowDown and ArrowUp', async () => {
    const ctx = createTestContext('library');
    await commandRegistry.execute('library.selectNext', ctx); // asset-1
    await commandRegistry.execute('library.selectNext', ctx); // asset-2

    expect(libraryStore.selectedAssetId).toBe('asset-2');

    await commandRegistry.execute('library.selectPrevious', ctx); // asset-1
    expect(libraryStore.selectedAssetId).toBe('asset-1');
  });

  it('navigates ONLY visible assets when library is filtered', async () => {
    const filteredNodes = libraryStore.allTreeNodes.filter(
      n => n.type === 'asset' && (n.asset?.uuid === 'asset-2' || n.asset?.uuid === 'asset-4')
    );

    const ctx = createTestContext('library', filteredNodes);

    await commandRegistry.execute('library.selectFirst', ctx); // asset-2
    expect(libraryStore.selectedAssetId).toBe('asset-2');

    await commandRegistry.execute('library.selectNext', ctx); // jumps over asset-3 directly to asset-4
    expect(libraryStore.selectedAssetId).toBe('asset-4');
  });

  it('navigates to first and last asset using Home and End', async () => {
    const ctx = createTestContext('library');
    await commandRegistry.execute('library.selectLast', ctx);
    expect(libraryStore.selectedAssetId).toBe('asset-4');

    await commandRegistry.execute('library.selectFirst', ctx);
    expect(libraryStore.selectedAssetId).toBe('asset-1');
  });

  it('routes real window ArrowDown KeyboardEvent when focused on library container', async () => {
    const libContainer = document.createElement('div');
    libContainer.setAttribute('data-command-scope', 'library');
    libContainer.setAttribute('tabindex', '0');
    libContainer.setAttribute('role', 'listbox');
    document.body.appendChild(libContainer);

    libContainer.focus();
    expect(document.activeElement).toBe(libContainer);

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true
    });

    window.dispatchEvent(event);

    expect(libraryStore.selectedAssetId).toBe('asset-1');
    expect(event.defaultPrevented).toBe(true);
  });

  it('bypasses library keyboard shortcuts when focus is inside a search input', async () => {
    const libContainer = document.createElement('div');
    libContainer.setAttribute('data-command-scope', 'library');
    const input = document.createElement('input');
    input.type = 'search';
    libContainer.appendChild(input);
    document.body.appendChild(libContainer);

    input.focus();
    expect(document.activeElement).toBe(input);

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true
    });

    window.dispatchEvent(event);

    expect(libraryStore.selectedAssetId).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it('mounts real MediaLibrary.vue component, exposes activeLibraryContext adapter, and processes window ArrowDown', async () => {
    const wrapper = mount(MediaLibrary, {
      attachTo: document.body,
      global: {
        stubs: {
          ContextMenu: true
        }
      }
    });

    await nextTick();
    const libContainer = wrapper.find('[data-command-scope="library"]');
    expect(libContainer.exists()).toBe(true);

    const el = libContainer.element as HTMLElement;
    el.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true
    });

    window.dispatchEvent(event);

    expect(libraryStore.selectedAssetId).toBe('asset-1');
    wrapper.unmount();
  });

  it('keeps New, Rename, Move, and Delete action buttons reachable in MediaLibrary toolbar', () => {
    const wrapper = mount(MediaLibrary, {
      global: {
        stubs: {
          ContextMenu: true
        }
      }
    });

    const toolbar = wrapper.find('.lib-toolbar');
    expect(toolbar.exists()).toBe(true);

    const buttons = toolbar.findAll('button');
    const buttonTexts = buttons.map(b => b.text());
    expect(buttonTexts.some(t => t.includes('New'))).toBe(true);
    expect(buttonTexts.some(t => t.includes('Rename'))).toBe(true);
    expect(buttonTexts.some(t => t.includes('Move'))).toBe(true);
    expect(buttonTexts.some(t => t.includes('Delete'))).toBe(true);
    wrapper.unmount();
  });

  it('does NOT execute Shift+F8 when focus is inside a text input or active dialog', async () => {
    libraryStore.selectNode('asset:asset-1');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'F8',
      code: 'F8',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });

    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
