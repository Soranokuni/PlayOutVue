import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRundownStore } from '../../stores/rundown';
import { commandRegistry, type CommandContext } from '../commandRegistry';

/**
 * Audit T1-11: `requiresConfirmation` is enforced inside the registry for
 * every entry point (keyboard, palette, menus), not just the palette.
 */
describe('T1-11 · registry enforces requiresConfirmation', () => {
  let store: ReturnType<typeof useRundownStore>;

  const ctx = (extra: Partial<CommandContext> = {}): CommandContext => ({
    scope: 'rundown',
    rundown: store,
    selection: { selectedItemIds: store.selectedItemIds, primarySelectedId: store.selectedItemId },
    library: null,
    activeModal: null,
    trimmer: null,
    ...extra
  });

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useRundownStore();
    store.addItem({ filename: 'Clip 1', type: 'video', path: '/1.mp4', duration: 10 } as any);
    store.addItem({ filename: 'Clip 2', type: 'video', path: '/2.mp4', duration: 10 } as any);
    store.selectItem(store.activeItems[0]!.id);
  });

  afterEach(() => {
    commandRegistry.setConfirmationHandler(null);
  });

  it('declines the destructive command when the operator cancels', async () => {
    const handler = vi.fn(async () => false);
    commandRegistry.setConfirmationHandler(handler);

    const executed = await commandRegistry.execute('rundown.deleteSelected', ctx());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(executed).toBe(false);
    expect(store.activeItems.length).toBe(2);
  });

  it('runs the destructive command when the operator confirms', async () => {
    commandRegistry.setConfirmationHandler(async () => true);

    const executed = await commandRegistry.execute('rundown.deleteSelected', ctx());

    expect(executed).toBe(true);
    expect(store.activeItems.length).toBe(1);
  });

  it('does not ask twice when the caller already confirmed', async () => {
    const handler = vi.fn(async () => true);
    commandRegistry.setConfirmationHandler(handler);

    await commandRegistry.execute('rundown.deleteSelected', ctx({ confirmed: true }));

    expect(handler).not.toHaveBeenCalled();
    expect(store.activeItems.length).toBe(1);
  });

  it('does not prompt for safe commands', async () => {
    const handler = vi.fn(async () => false);
    commandRegistry.setConfirmationHandler(handler);

    const executed = await commandRegistry.execute('rundown.selectNext', ctx());

    expect(executed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed when no dialog can be shown (default handler outside Tauri)', async () => {
    commandRegistry.setConfirmationHandler(null);
    const executed = await commandRegistry.execute('rundown.deleteSelected', ctx());
    expect(executed).toBe(false);
    expect(store.activeItems.length).toBe(2);
  });
});
