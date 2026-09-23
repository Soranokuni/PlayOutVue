/**
 * Actions the app-wide right-click menu asks a panel to run. The panels own
 * the state these touch (the live-block dialog, the hard-start input, the
 * library's folder creation), so the menu dispatches and they listen -- the
 * same pattern as `playout:playlist-file`.
 */
export type AppMenuAction = 'rundown.liveBlock' | 'rundown.hardStart' | 'library.newFolder' | 'library.refresh';

export const APP_MENU_EVENT = 'playout:app-menu';

export function dispatchAppMenuAction(action: AppMenuAction): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AppMenuAction>(APP_MENU_EVENT, { detail: action }));
}

/** Subscribe to one panel's actions; returns the unsubscribe. */
export function onAppMenuAction(handler: (action: AppMenuAction) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<AppMenuAction>).detail);
  window.addEventListener(APP_MENU_EVENT, listener);
  return () => window.removeEventListener(APP_MENU_EVENT, listener);
}

export type AppMenuSurface = 'rundown' | 'library' | 'global' | 'none';

/**
 * Where a right-click landed, for the purpose of the app menu. `none` means
 * swallow it and show nothing: text fields (their native menu is gone too),
 * dialogs, popovers and menus, which own their own clicks.
 */
export function classifyAppMenuTarget(target: EventTarget | null): AppMenuSurface {
  const el = target instanceof Element ? target : null;
  if (!el) return 'global';
  if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return 'none';
  if (el.closest('[role="dialog"], [aria-modal="true"], .modal-backdrop, [data-command-scope="modal"], [data-command-scope="trimmer"], .popover-surface, [role="menu"]')) {
    return 'none';
  }
  if (el.closest('.panel-rundown')) return 'rundown';
  if (el.closest('.panel-library:not(.library-rail)')) return 'library';
  return 'global';
}
