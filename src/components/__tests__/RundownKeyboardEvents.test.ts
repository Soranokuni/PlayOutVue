import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRundownStore } from '../../stores/rundown';
import { useOperatorShortcuts, classifyActiveScope, activeModalName } from '../../composables/useOperatorShortcuts';

describe('Real Keyboard Events & Global Shortcut Router Integration', () => {
  let store: ReturnType<typeof useRundownStore>;
  let originalDocument: any;
  let originalWindow: any;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useRundownStore();
    activeModalName.value = null;
    if (store.playlists[0]) {
      store.activatePlaylist(store.playlists[0].id);
      store.playlists[0].items = [];
      store.clearSelection();
    }
    originalDocument = (globalThis as any).document;
    originalWindow = (globalThis as any).window;
  });

  afterEach(() => {
    (globalThis as any).document = originalDocument;
    (globalThis as any).window = originalWindow;
    activeModalName.value = null;
  });

  it('verifies single root-level listener attachment and cleanup lifecycle', () => {
    const listeners: Array<EventListenerOrEventListenerObject> = [];
    const addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'keydown') listeners.push(listener);
    });
    const removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      const idx = listeners.indexOf(listener);
      if (idx !== -1) listeners.splice(idx, 1);
    });

    (globalThis as any).window = { addEventListener, removeEventListener };

    const instance = useOperatorShortcuts();
    instance.mountShortcuts();
    expect(addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true });
    expect(listeners.length).toBe(1);

    instance.unmountShortcuts();
    expect(removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true });
    expect(listeners.length).toBe(0);
  });

  it('routes ArrowDown keydown event to move selection down when rundown surface is focused', async () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/media/2.mp4', duration: 15 });
    store.addItem({ name: 'Clip 3', type: 'video', path: '/media/3.mp4', duration: 20 });

    const id1 = store.activeItems[0].id;
    const id2 = store.activeItems[1].id;
    store.selectItem(id1);

    const mockRundownElement = {
      closest: (selector: string) => (selector.includes('rundown') ? {} : null),
      tagName: 'DIV',
      isContentEditable: false
    };

    let keydownHandler: any = null;
    (globalThis as any).document = { activeElement: mockRundownElement };
    (globalThis as any).window = {
      addEventListener: (type: string, fn: any) => { if (type === 'keydown') keydownHandler = fn; },
      removeEventListener: () => {}
    };

    const shortcuts = useOperatorShortcuts();
    shortcuts.mountShortcuts();

    expect(classifyActiveScope()).toBe('rundown');
    expect(keydownHandler).toBeTypeOf('function');

    // Dispatch ArrowDown event
    const arrowDownEvent = {
      key: 'ArrowDown',
      code: 'ArrowDown',
      target: mockRundownElement,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    };

    await keydownHandler(arrowDownEvent);
    expect(arrowDownEvent.preventDefault).toHaveBeenCalled();
    expect(store.selectedItemId).toBe(id2);
  });

  it('bypasses rundown navigation when focus is inside a text input', async () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/media/2.mp4', duration: 15 });
    const id1 = store.activeItems[0].id;
    store.selectItem(id1);

    const mockInputElement = {
      tagName: 'INPUT',
      isContentEditable: false,
      closest: () => null
    };

    let keydownHandler: any = null;
    (globalThis as any).document = { activeElement: mockInputElement };
    (globalThis as any).window = {
      addEventListener: (type: string, fn: any) => { if (type === 'keydown') keydownHandler = fn; },
      removeEventListener: () => {}
    };

    const shortcuts = useOperatorShortcuts();
    shortcuts.mountShortcuts();

    expect(classifyActiveScope()).toBe('text-input');

    const arrowDownEvent = {
      key: 'ArrowDown',
      code: 'ArrowDown',
      target: mockInputElement,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    };

    await keydownHandler(arrowDownEvent);
    expect(arrowDownEvent.preventDefault).not.toHaveBeenCalled();
    expect(store.selectedItemId).toBe(id1);
  });

  it('bypasses rundown navigation when modal surface is active', async () => {
    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    store.addItem({ name: 'Clip 2', type: 'video', path: '/media/2.mp4', duration: 15 });
    const id1 = store.activeItems[0].id;
    store.selectItem(id1);

    const mockModalElement = {
      tagName: 'DIV',
      isContentEditable: false,
      closest: (selector: string) => (selector.includes('modal') ? {} : null)
    };

    let keydownHandler: any = null;
    (globalThis as any).document = { activeElement: mockModalElement };
    (globalThis as any).window = {
      addEventListener: (type: string, fn: any) => { if (type === 'keydown') keydownHandler = fn; },
      removeEventListener: () => {}
    };

    const shortcuts = useOperatorShortcuts();
    shortcuts.mountShortcuts();

    expect(classifyActiveScope()).toBe('modal');

    const arrowDownEvent = {
      key: 'ArrowDown',
      code: 'ArrowDown',
      target: mockModalElement,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    };

    await keydownHandler(arrowDownEvent);
    expect(arrowDownEvent.preventDefault).not.toHaveBeenCalled();
    expect(store.selectedItemId).toBe(id1);
  });
});
