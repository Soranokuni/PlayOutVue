// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { commandRegistry } from '../../services/commandRegistry';
import {
  useOperatorShortcuts,
  resetShortcutsMountedStateForTesting,
  activeModalName,
  activeLibraryContext
} from '../useOperatorShortcuts';

/**
 * UI F-04: Ctrl/Cmd+I is advertised by the quick guide, both context menus and
 * the command palette. It was bound nowhere. These tests pin the binding to the
 * scopes `global.inspectSelected` declares, and keep it out of text inputs.
 */
describe('UI F-04 · Ctrl/Cmd+I opens the inspector', () => {
  let shortcuts: ReturnType<typeof useOperatorShortcuts>;
  let executeSpy: any;

  const focusScope = (scope: string) => {
    const el = document.createElement('div');
    el.setAttribute('data-command-scope', scope);
    el.tabIndex = 0;
    document.body.appendChild(el);
    el.focus();
    return el;
  };

  const pressCtrlI = (init: KeyboardEventInit = {}) =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true, ...init })
    );

  beforeEach(() => {
    resetShortcutsMountedStateForTesting();
    setActivePinia(createPinia());
    document.body.innerHTML = '';
    activeModalName.value = null;

    // A selected library asset is enough to enable the command.
    activeLibraryContext.value = {
      getSelectedAssetIds: () => ['asset-1'],
      getVisibleAssetIds: () => ['asset-1'],
      selectPrevious: () => {},
      selectNext: () => {},
      selectFirst: () => {},
      selectLast: () => {},
      extendSelection: () => {},
      appendSelectedToPlaylist: async () => ({ insertedIds: [], skippedIds: [], errors: [] }),
      insertSelectedAfter: async () => ({ insertedIds: [], skippedIds: [], errors: [] })
    };

    executeSpy = vi.spyOn(commandRegistry, 'execute');
    shortcuts = useOperatorShortcuts();
    shortcuts.mountShortcuts();
  });

  afterEach(() => {
    shortcuts.unmountShortcuts();
    resetShortcutsMountedStateForTesting();
    activeModalName.value = null;
    activeLibraryContext.value = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('executes global.inspectSelected in rundown scope', () => {
    focusScope('rundown');
    pressCtrlI();
    expect(executeSpy).toHaveBeenCalledWith('global.inspectSelected', expect.any(Object));
  });

  it('executes global.inspectSelected in library scope', () => {
    focusScope('library');
    pressCtrlI();
    expect(executeSpy).toHaveBeenCalledWith('global.inspectSelected', expect.any(Object));
  });

  it('accepts Cmd+I on macOS', () => {
    focusScope('rundown');
    pressCtrlI({ ctrlKey: false, metaKey: true });
    expect(executeSpy).toHaveBeenCalledWith('global.inspectSelected', expect.any(Object));
  });

  it('dispatches the inspector open event so App.vue can react', () => {
    focusScope('rundown');
    const onOpen = vi.fn();
    window.addEventListener('playout:open-inspector', onOpen);
    pressCtrlI();
    window.removeEventListener('playout:open-inspector', onOpen);
    expect(onOpen).toHaveBeenCalled();
  });

  it('does not fire while a text input has focus', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    pressCtrlI();

    expect(executeSpy).not.toHaveBeenCalledWith('global.inspectSelected', expect.any(Object));
  });

  it('does not fire when nothing is selected', () => {
    activeLibraryContext.value = {
      ...(activeLibraryContext.value as any),
      getSelectedAssetIds: () => []
    };
    focusScope('rundown');

    pressCtrlI();

    expect(executeSpy).not.toHaveBeenCalledWith('global.inspectSelected', expect.any(Object));
  });
});
