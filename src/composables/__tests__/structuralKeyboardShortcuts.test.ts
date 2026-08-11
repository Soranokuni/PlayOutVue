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

describe('PR4A Structural Keyboard Shortcuts Routing', () => {
  let shortcuts: ReturnType<typeof useOperatorShortcuts>;
  let executeSpy: any;

  beforeEach(() => {
    resetShortcutsMountedStateForTesting();
    setActivePinia(createPinia());
    document.body.innerHTML = '';
    activeModalName.value = null;

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

  it('executes rundown.copySelected on Ctrl+C in rundown scope', async () => {
    const rundownContainer = document.createElement('div');
    rundownContainer.setAttribute('data-command-scope', 'rundown');
    rundownContainer.tabIndex = 0;
    document.body.appendChild(rundownContainer);
    rundownContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })
    );

    expect(executeSpy).toHaveBeenCalledWith('rundown.copySelected', expect.any(Object));
  });

  it('executes rundown.copySelected on Cmd+C on macOS in rundown scope', async () => {
    const rundownContainer = document.createElement('div');
    rundownContainer.setAttribute('data-command-scope', 'rundown');
    rundownContainer.tabIndex = 0;
    document.body.appendChild(rundownContainer);
    rundownContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true })
    );

    expect(executeSpy).toHaveBeenCalledWith('rundown.copySelected', expect.any(Object));
  });

  it('executes rundown.cutSelected on Ctrl+X in rundown scope', async () => {
    const rundownContainer = document.createElement('div');
    rundownContainer.setAttribute('data-command-scope', 'rundown');
    rundownContainer.tabIndex = 0;
    document.body.appendChild(rundownContainer);
    rundownContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true, cancelable: true })
    );

    expect(executeSpy).toHaveBeenCalledWith('rundown.cutSelected', expect.any(Object));
  });

  it('executes rundown.pasteAfterSelected on Ctrl+V in rundown scope', async () => {
    const rundownContainer = document.createElement('div');
    rundownContainer.setAttribute('data-command-scope', 'rundown');
    rundownContainer.tabIndex = 0;
    document.body.appendChild(rundownContainer);
    rundownContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    );

    expect(executeSpy).toHaveBeenCalledWith('rundown.pasteAfterSelected', expect.any(Object));
  });

  it('executes rundown.duplicateSelected on Ctrl+D in rundown scope', async () => {
    const rundownContainer = document.createElement('div');
    rundownContainer.setAttribute('data-command-scope', 'rundown');
    rundownContainer.tabIndex = 0;
    document.body.appendChild(rundownContainer);
    rundownContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true })
    );

    expect(executeSpy).toHaveBeenCalledWith('rundown.duplicateSelected', expect.any(Object));
  });

  it('executes rundown.deleteSelected on Delete in rundown scope', async () => {
    const rundownContainer = document.createElement('div');
    rundownContainer.setAttribute('data-command-scope', 'rundown');
    rundownContainer.tabIndex = 0;
    document.body.appendChild(rundownContainer);
    rundownContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
    );

    expect(executeSpy).toHaveBeenCalledWith('rundown.deleteSelected', expect.any(Object));
  });

  it('executes rundown.deleteSelected on Backspace in rundown scope', async () => {
    const rundownContainer = document.createElement('div');
    rundownContainer.setAttribute('data-command-scope', 'rundown');
    rundownContainer.tabIndex = 0;
    document.body.appendChild(rundownContainer);
    rundownContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    );

    expect(executeSpy).toHaveBeenCalledWith('rundown.deleteSelected', expect.any(Object));
  });

  it('does NOT execute rundown copy when focused in a text input', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })
    );

    expect(executeSpy).not.toHaveBeenCalledWith('rundown.copySelected', expect.any(Object));
  });

  it('preserves native input paste behavior when focused in a text input', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    );

    expect(executeSpy).not.toHaveBeenCalledWith('rundown.pasteAfterSelected', expect.any(Object));
  });

  it('does NOT execute global rundown command when command palette is focused', async () => {
    activeModalName.value = 'command-palette';
    const paletteContainer = document.createElement('div');
    paletteContainer.setAttribute('data-command-scope', 'command-palette');
    paletteContainer.tabIndex = 0;
    document.body.appendChild(paletteContainer);
    paletteContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })
    );

    expect(executeSpy).not.toHaveBeenCalledWith('rundown.copySelected', expect.any(Object));
  });

  it('executes library.appendSelected (F8) exactly once when focused in library scope', async () => {
    const libContainer = document.createElement('div');
    libContainer.setAttribute('data-command-scope', 'library');
    libContainer.tabIndex = 0;
    document.body.appendChild(libContainer);
    libContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F8', code: 'F8', bubbles: true, cancelable: true })
    );

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith('library.appendSelected', expect.any(Object));
  });

  it('executes library.appendSelected (F8) from rundown scope when a library asset is selected', async () => {
    const rundownContainer = document.createElement('div');
    rundownContainer.setAttribute('data-command-scope', 'rundown');
    rundownContainer.tabIndex = 0;
    document.body.appendChild(rundownContainer);
    rundownContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F8', code: 'F8', bubbles: true, cancelable: true })
    );

    expect(executeSpy).toHaveBeenCalledWith('library.appendSelected', expect.any(Object));
  });

  it('does NOT execute library.appendSelected (F8) when NO library asset is selected', async () => {
    activeLibraryContext.value = {
      ...activeLibraryContext.value!,
      getSelectedAssetIds: () => []
    };

    const rundownContainer = document.createElement('div');
    rundownContainer.setAttribute('data-command-scope', 'rundown');
    rundownContainer.tabIndex = 0;
    document.body.appendChild(rundownContainer);
    rundownContainer.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F8', code: 'F8', bubbles: true, cancelable: true })
    );

    expect(executeSpy).not.toHaveBeenCalledWith('library.appendSelected', expect.any(Object));
  });
});
