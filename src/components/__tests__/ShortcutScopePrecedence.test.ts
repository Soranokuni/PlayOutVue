// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRundownStore } from '../../stores/rundown';
import {
  useOperatorShortcuts,
  classifyActiveScope,
  activeModalName,
  resetShortcutsMountedStateForTesting
} from '../../composables/useOperatorShortcuts';
import { commandRegistry } from '../../services/commandRegistry';

/**
 * Audit T1-9: text inputs inside modal / trimmer containers must classify as
 * `text-input`, and global rundown shortcuts (Ctrl+Z, F8, Delete) must never
 * fire while the operator is typing in a dialog field.
 */
describe('T1-9 · shortcut scope precedence for inputs inside dialogs', () => {
  let store: ReturnType<typeof useRundownStore>;
  let shortcuts: ReturnType<typeof useOperatorShortcuts>;

  beforeEach(() => {
    resetShortcutsMountedStateForTesting();
    setActivePinia(createPinia());
    store = useRundownStore();
    activeModalName.value = null;
    document.body.innerHTML = '';
    commandRegistry.setConfirmationHandler(async () => true);
    shortcuts = useOperatorShortcuts();
    shortcuts.mountShortcuts();
  });

  afterEach(() => {
    shortcuts.unmountShortcuts();
    resetShortcutsMountedStateForTesting();
    activeModalName.value = null;
    document.body.innerHTML = '';
    commandRegistry.setConfirmationHandler(null);
  });

  const mountInputInside = (scopeAttr: string) => {
    document.body.innerHTML = `
      <div data-command-scope="${scopeAttr}">
        <input id="field" type="text" />
      </div>`;
    const input = document.getElementById('field') as HTMLInputElement;
    input.focus();
    return input;
  };

  const key = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

  it('classifies an input inside a modal container as text-input', () => {
    mountInputInside('modal');
    expect(classifyActiveScope()).toBe('text-input');
  });

  it('classifies an input inside the trimmer as text-input', () => {
    mountInputInside('trimmer');
    expect(classifyActiveScope()).toBe('text-input');
  });

  it('still classifies a non-input element inside a modal as modal', () => {
    document.body.innerHTML = `<div data-command-scope="modal"><button id="b">x</button></div>`;
    (document.getElementById('b') as HTMLButtonElement).focus();
    expect(classifyActiveScope()).toBe('modal');
  });

  it('Ctrl+Z inside a modal input does not undo the rundown', async () => {
    store.addItem({ filename: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 } as any);
    const undoSpy = vi.spyOn(store, 'undo');
    mountInputInside('modal');

    key({ key: 'z', ctrlKey: true });
    await Promise.resolve();

    expect(undoSpy).not.toHaveBeenCalled();
    expect(store.activeItems.length).toBe(1);
  });

  it('Ctrl+Z from a non-input element inside a modal does not undo either', async () => {
    store.addItem({ filename: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 } as any);
    const undoSpy = vi.spyOn(store, 'undo');
    document.body.innerHTML = `<div data-command-scope="modal"><button id="b">x</button></div>`;
    (document.getElementById('b') as HTMLButtonElement).focus();

    key({ key: 'z', ctrlKey: true });
    await Promise.resolve();

    expect(undoSpy).not.toHaveBeenCalled();
  });

  it('F8 inside a modal does not execute the library append command', async () => {
    const execSpy = vi.spyOn(commandRegistry, 'execute');
    document.body.innerHTML = `<div data-command-scope="modal"><button id="b">x</button></div>`;
    (document.getElementById('b') as HTMLButtonElement).focus();

    key({ key: 'F8', code: 'F8' });
    await Promise.resolve();

    expect(execSpy).not.toHaveBeenCalledWith('library.appendSelected', expect.anything());
  });

  it('Escape inside an input blurs it without stopping propagation', () => {
    const input = mountInputInside('modal');
    let reachedTarget = false;
    input.addEventListener('keydown', () => {
      reachedTarget = true;
    });
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(reachedTarget).toBe(true);
    expect(document.activeElement).not.toBe(input);
  });
});
