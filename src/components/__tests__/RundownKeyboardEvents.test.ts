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

describe('Real Window Keyboard Event Delivery & Focus Scope Integration', () => {
  let store: ReturnType<typeof useRundownStore>;
  let shortcuts: ReturnType<typeof useOperatorShortcuts>;

  beforeEach(() => {
    resetShortcutsMountedStateForTesting();
    setActivePinia(createPinia());
    store = useRundownStore();
    activeModalName.value = null;
    document.body.innerHTML = '';

    if (store.playlists[0]) {
      store.activatePlaylist(store.playlists[0].id);
      store.playlists[0].items = [];
      store.clearSelection();
    }

    shortcuts = useOperatorShortcuts();
    shortcuts.mountShortcuts();
  });

  afterEach(() => {
    shortcuts.unmountShortcuts();
    resetShortcutsMountedStateForTesting();
    activeModalName.value = null;
    document.body.innerHTML = '';
  });

  it('enforces idempotent listener registration preventing duplicate event handlers', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    shortcuts.mountShortcuts();
    shortcuts.mountShortcuts();

    const keydownCalls = spy.mock.calls.filter(([event]) => event === 'keydown');
    expect(keydownCalls.length).toBe(0); // Already mounted in beforeEach once
  });

  it('handles real window.dispatchEvent ArrowDown event when rundown is focused', async () => {
    const container = document.createElement('div');
    container.setAttribute('data-command-scope', 'rundown');
    container.setAttribute('tabindex', '0');
    container.setAttribute('role', 'listbox');
    document.body.appendChild(container);

    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/media/2.mp4', duration: 15 });
    const id1 = store.activeItems[0].id;
    const id2 = store.activeItems[1].id;

    store.selectItem(id1);
    container.focus();
    expect(document.activeElement).toBe(container);
    expect(classifyActiveScope()).toBe('rundown');

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      bubbles: true,
      cancelable: true
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(store.selectedItemId).toBe(id2);
  });

  it('bypasses rundown selection when real event is dispatched while focused inside an input', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);

    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/media/2.mp4', duration: 15 });
    const id1 = store.activeItems[0].id;

    store.selectItem(id1);
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(classifyActiveScope()).toBe('text-input');

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      bubbles: true,
      cancelable: true
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(store.selectedItemId).toBe(id1);
  });

  it('bypasses rundown selection when real event is dispatched inside a modal container', async () => {
    const modal = document.createElement('div');
    modal.setAttribute('data-command-scope', 'modal');
    modal.setAttribute('tabindex', '0');
    document.body.appendChild(modal);

    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/media/2.mp4', duration: 15 });
    const id1 = store.activeItems[0].id;

    store.selectItem(id1);
    modal.focus();
    expect(document.activeElement).toBe(modal);
    expect(classifyActiveScope()).toBe('modal');

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      bubbles: true,
      cancelable: true
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(store.selectedItemId).toBe(id1);
  });
});
