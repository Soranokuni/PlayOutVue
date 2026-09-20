import { ref } from 'vue';

/**
 * UI F-05: only one context menu may be open at a time.
 *
 * Each parent used to close its own menu on a `window` `click`. Right-clicking
 * in another panel fires `contextmenu`, not `click`, so the first menu stayed
 * open behind the second — two menus, two sets of destructive actions, one
 * pointer. A `ContextMenu` instance claims this slot when it mounts; claiming
 * it closes whoever held it.
 */
type CloseFn = () => void;

const current = ref<CloseFn | null>(null);

/** Registers `close` as the active menu, closing any menu already open. */
export function claimContextMenu(close: CloseFn): void {
  const previous = current.value;
  current.value = close;
  if (previous && previous !== close) previous();
}

/** Releases the slot, but only if `close` still owns it. */
export function releaseContextMenu(close: CloseFn): void {
  if (current.value === close) current.value = null;
}

/** Closes whatever menu is open. Safe to call when none is. */
export function closeActiveContextMenu(): void {
  const close = current.value;
  current.value = null;
  close?.();
}

/** @internal Test-only. */
export function hasActiveContextMenu(): boolean {
  return current.value !== null;
}
