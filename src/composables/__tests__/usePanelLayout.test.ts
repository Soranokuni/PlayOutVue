// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  usePanelLayout,
  clampFolderPaneRatio,
  clampLibraryWidth,
  FOLDER_PANE_RATIO_DEFAULT,
  FOLDER_PANE_RATIO_MAX,
  FOLDER_PANE_RATIO_MIN,
  LIBRARY_WIDTH_DEFAULT,
  LIBRARY_WIDTH_MAX,
  LIBRARY_WIDTH_MIN,
} from '../usePanelLayout';
import {
  useOperatorShortcuts,
  classifyActiveScope,
  activeModalName,
  resetShortcutsMountedStateForTesting,
} from '../useOperatorShortcuts';

/**
 * The panel layout is one set of module-scoped refs: the shell, the library,
 * Ctrl+B and Settings' "Reset panel sizes" must all see the same values, and
 * a reset must land at once rather than on the next launch.
 */
describe('panel layout', () => {
  const layout = usePanelLayout();

  afterEach(() => layout.resetPanelLayout());

  it('clamps the folder split and the library width, and rejects NaN', () => {
    expect(clampFolderPaneRatio(-1)).toBe(FOLDER_PANE_RATIO_MIN);
    expect(clampFolderPaneRatio(2)).toBe(FOLDER_PANE_RATIO_MAX);
    expect(clampFolderPaneRatio(Number.NaN)).toBe(FOLDER_PANE_RATIO_DEFAULT);
    expect(clampFolderPaneRatio(0.4567891)).toBe(0.457);
    expect(clampLibraryWidth(10)).toBe(LIBRARY_WIDTH_MIN);
    expect(clampLibraryWidth(5000)).toBe(LIBRARY_WIDTH_MAX);
    expect(clampLibraryWidth(Number.NaN)).toBe(LIBRARY_WIDTH_DEFAULT);
  });

  it('shares one state across callers, and resets all of it live', () => {
    const other = usePanelLayout();
    layout.leftWidth.value = 500;
    layout.folderPaneRatio.value = 0.6;
    layout.toggleLibraryCollapsed();
    layout.toggleFolderTreeCollapsed();

    expect(other.leftWidth.value).toBe(500);
    expect(other.libraryCollapsed.value).toBe(true);
    expect(other.folderTreeCollapsed.value).toBe(true);

    other.resetPanelLayout();
    expect(layout.leftWidth.value).toBe(LIBRARY_WIDTH_DEFAULT);
    expect(layout.folderPaneRatio.value).toBe(FOLDER_PANE_RATIO_DEFAULT);
    expect(layout.libraryCollapsed.value).toBe(false);
    expect(layout.folderTreeCollapsed.value).toBe(false);
  });
});

describe('panel layout keyboard routing', () => {
  let shortcuts: ReturnType<typeof useOperatorShortcuts>;
  const layout = usePanelLayout();

  beforeEach(() => {
    resetShortcutsMountedStateForTesting();
    setActivePinia(createPinia());
    activeModalName.value = null;
    document.body.innerHTML = '';
    shortcuts = useOperatorShortcuts();
    shortcuts.mountShortcuts();
  });

  afterEach(() => {
    shortcuts.unmountShortcuts();
    resetShortcutsMountedStateForTesting();
    document.body.innerHTML = '';
    layout.resetPanelLayout();
  });

  const key = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

  it('lets a focused split handle inside the library keep its arrow keys', () => {
    document.body.innerHTML = `
      <div data-command-scope="library">
        <div id="handle" role="separator" tabindex="0"></div>
      </div>`;
    (document.getElementById('handle') as HTMLElement).focus();
    expect(classifyActiveScope()).toBe('text-input');
  });

  it('folds and unfolds the library on Ctrl+B', async () => {
    document.body.innerHTML = `<div data-command-scope="rundown"><button id="b">x</button></div>`;
    (document.getElementById('b') as HTMLElement).focus();

    key({ key: 'b', ctrlKey: true });
    await Promise.resolve();
    expect(layout.libraryCollapsed.value).toBe(true);

    key({ key: 'b', ctrlKey: true });
    await Promise.resolve();
    expect(layout.libraryCollapsed.value).toBe(false);
  });

  it('leaves Ctrl+B alone while the operator is typing', async () => {
    document.body.innerHTML = `<input id="field" type="text" />`;
    (document.getElementById('field') as HTMLInputElement).focus();

    key({ key: 'b', ctrlKey: true });
    await Promise.resolve();
    expect(layout.libraryCollapsed.value).toBe(false);
  });
});
