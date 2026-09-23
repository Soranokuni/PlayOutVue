import { getCurrentInstance, onMounted, onUnmounted, ref } from 'vue';
import { useRundownStore } from '../stores/rundown';
import { activeDragSession } from './useDragSession';
import {
  commandRegistry,
  type CommandContext,
  type LibraryCommandContext,
  type ShortcutScope,
  type TrimmerCommandContext
} from '../services/commandRegistry';

export const activeScope = ref<ShortcutScope>('rundown');
export const activeModalName = ref<string | null>(null);
export const activeTrimmerContext = ref<TrimmerCommandContext | null>(null);
export const activeLibraryContext = ref<LibraryCommandContext | null>(null);
export const requireTakeConfirmation = ref<boolean>(false);

let capturedActiveElement: HTMLElement | null = null;
let commandPaletteOriginScope: ShortcutScope = 'rundown';

export function openCommandPalette(): void {
  if (activeModalName.value && activeModalName.value !== 'command-palette') return;
  commandPaletteOriginScope = classifyActiveScope();
  capturedActiveElement = typeof document !== 'undefined' ? (document.activeElement as HTMLElement) || null : null;
  activeModalName.value = 'command-palette';
}

export function closeCommandPalette(): void {
  if (activeModalName.value === 'command-palette') {
    activeModalName.value = null;
  }
  if (capturedActiveElement && typeof document !== 'undefined' && document.body.contains(capturedActiveElement)) {
    capturedActiveElement.focus({ preventScroll: true });
  } else if (typeof document !== 'undefined') {
    const fallback = document.querySelector<HTMLElement>('[data-command-scope="rundown"], [data-command-scope="library"]');
    fallback?.focus({ preventScroll: true });
  }
  capturedActiveElement = null;
}

export const activeInspectorItem = ref<any>(null);

export function openInspectorModal(item?: any): void {
  if (activeModalName.value && activeModalName.value !== 'inspector') return;
  activeInspectorItem.value = item || null;
  activeModalName.value = 'inspector';
}

export function closeInspectorModal(): void {
  if (activeModalName.value === 'inspector') {
    activeModalName.value = null;
    activeInspectorItem.value = null;
  }
}

export function createCurrentCommandContext(): CommandContext {
  const currentScope = classifyActiveScope();
  const rundown = useRundownStore();
  const paletteIsOpen = activeModalName.value === 'command-palette';
  return {
    scope: currentScope,
    originScope: paletteIsOpen ? commandPaletteOriginScope : currentScope,
    rundown,
    selection: {
      selectedItemIds: rundown.selectedItemIds,
      primarySelectedId: rundown.selectedItemId
    },
    library: activeLibraryContext.value,
    activeModal: activeModalName.value,
    trimmer: activeTrimmerContext.value,
    requireTakeConfirmation: requireTakeConfirmation.value
  };
}

export function getVisiblePageSize(containerEl: HTMLElement | null): number {
  if (!containerEl) return 10;
  const firstRow = containerEl.querySelector<HTMLElement>('[data-item-id], [data-asset-id]');
  if (!firstRow) return 10;
  const rowHeight = firstRow.getBoundingClientRect().height;
  return rowHeight > 0 ? Math.max(1, Math.floor(containerEl.clientHeight / rowHeight)) : 10;
}

/**
 * Determines current active scope based on DOM focus state and open modals.
 */
export function classifyActiveScope(): ShortcutScope {
  const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

  // Audit T1-9: native text controls win over every container scope. A
  // focused input inside a modal or the trimmer must keep native typing,
  // undo and Escape semantics; otherwise Ctrl+Z in a Settings field undid
  // the on-air rundown (OPERATOR-UI-CONTRACT §5: text-input above trimmer).
  // A focused split handle (`role="separator"`) owns its arrow keys the same
  // way: they move the split. Inside the library the scope's own arrow
  // navigation claimed them first, so the handle could not be moved by keyboard.
  if (
    active?.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName ?? '') ||
    active?.getAttribute?.('role') === 'separator'
  ) {
    return 'text-input';
  }

  if (active?.closest('[data-command-scope="modal"]')) {
    return 'modal';
  }

  if (active?.closest('[data-command-scope="command-palette"]') || activeModalName.value === 'command-palette') {
    return 'command-palette';
  }

  if (active?.closest('[data-command-scope="trimmer"]') || activeModalName.value === 'trimmer') {
    return 'trimmer';
  }

  if (activeModalName.value) {
    return 'modal';
  }

  if (active?.closest('[data-command-scope="rundown"]') || active?.closest('[role="listbox"][aria-label="Playlist rundown"]')) {
    return 'rundown';
  }

  if (active?.closest('[data-command-scope="library"]') || active?.closest('.media-library-panel')) {
    return 'library';
  }

  return activeScope.value || 'global';
}

/**
 * Checks if target element is an interactive control that should consume Spacebar clicks natively.
 */
export function isInteractiveControl(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'VIDEO', 'A'].includes(element.tagName)) {
    return true;
  }
  const role = element.getAttribute('role');
  if (role && ['button', 'checkbox', 'menuitem', 'option', 'tab', 'textbox'].includes(role)) {
    return true;
  }
  return false;
}

/** The context a command runs in right now, for callers outside the key router. */
export function currentCommandContext(): CommandContext {
  const rundown = useRundownStore();
  return {
    scope: classifyActiveScope(),
    rundown,
    selection: {
      selectedItemIds: rundown.selectedItemIds,
      primarySelectedId: rundown.selectedItemId
    },
    activeModal: activeModalName.value,
    trimmer: activeTrimmerContext.value,
    requireTakeConfirmation: requireTakeConfirmation.value
  };
}

export async function executeRegisteredCommand(commandId: string): Promise<boolean> {
  return commandRegistry.execute(commandId, currentCommandContext());
}

let shortcutsMounted = false;

/** @internal Test-only reset helper. Never call from production application code. */
export function resetShortcutsMountedStateForTesting(): void {
  shortcutsMounted = false;
}

/**
 * Centralized application keyboard router composable.
 */
export function useOperatorShortcuts() {
  const handleKeyDown = async (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const scope = classifyActiveScope();

    // 1. Text input handling: allow normal typing. Escape blurs the field but
    //    is NOT swallowed, so the owning dialog / trim panel can still close
    //    on it (audit T1-9).
    if (scope === 'text-input') {
      if (event.key === 'Escape') {
        target?.blur();
      }
      return;
    }

    const rundown = useRundownStore();
    const selection = {
      selectedItemIds: rundown.selectedItemIds,
      primarySelectedId: rundown.selectedItemId
    };

    const ctx: CommandContext = {
      scope,
      rundown,
      selection,
      library: activeLibraryContext.value,
      activeModal: activeModalName.value,
      trimmer: activeTrimmerContext.value,
      requireTakeConfirmation: requireTakeConfirmation.value
    };

    // 2. Global Escape cascade
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (activeModalName.value === 'command-palette') {
        closeCommandPalette();
        return;
      }
      if (activeModalName.value) {
        activeModalName.value = null;
        return;
      }
      if (rundown.selectedItemId || rundown.selectedItemIds.length > 0) {
        rundown.clearSelection();
        return;
      }
      return;
    }

    // 3. Command Palette (Ctrl+K / Cmd+K)
    if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
      event.preventDefault();
      event.stopPropagation();
      if (activeModalName.value === 'command-palette') {
        closeCommandPalette();
      } else {
        openCommandPalette();
      }
      return;
    }

    // 3b. Inspector (Ctrl/Cmd+I). UI F-04: the quick guide, both context menus
    //     and the command palette all advertised this shortcut while nothing
    //     bound it. The command only dispatches `playout:open-inspector`, so it
    //     is safe in every non-text scope. Text inputs returned above, which
    //     keeps native behaviour per OPERATOR-UI-CONTRACT §6.
    if ((event.ctrlKey || event.metaKey) && (event.key === 'i' || event.key === 'I')) {
      if (scope === 'rundown' || scope === 'library' || scope === 'global') {
        const inspect = commandRegistry.get('global.inspectSelected');
        if (inspect?.isEnabled(ctx)) {
          event.preventDefault();
          event.stopPropagation();
          await commandRegistry.execute('global.inspectSelected', ctx);
          return;
        }
      }
    }

    // 3c. Playlist file actions (§5.4). Ctrl/Cmd+S saves, Ctrl/Cmd+O loads and
    //     Ctrl/Cmd+Shift+O appends. Text inputs returned above, so a rename
    //     field keeps the browser's own Ctrl+S; these are only live in the
    //     three operating scopes.
    if (
      (event.ctrlKey || event.metaKey) &&
      (scope === 'rundown' || scope === 'library' || scope === 'global')
    ) {
      const key = event.key.toLowerCase();
      // Ctrl/Cmd+B folds the library to a rail and back, as a sidebar does.
      if (key === 'b' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('view.toggleLibrary', ctx);
        return;
      }
      const playlistCommandId =
        key === 's' ? 'playlist.save' : key === 'o' ? (event.shiftKey ? 'playlist.append' : 'playlist.load') : null;
      if (playlistCommandId) {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute(playlistCommandId, ctx);
        return;
      }
    }

    // Explicit Action Key Guard for Playback Take: Enter and Space are ignored (no playback)
    if (
      event.key === 'Enter' ||
      event.key === ' ' ||
      event.code === 'Space'
    ) {
      return;
    }

    // 4. Structural & Playlist Reorder Shortcuts for Rundown Scope (Ctrl/Cmd + C, X, V, D, Z, ArrowUp, ArrowDown)
    const isModifier = event.ctrlKey || event.metaKey;
    if (scope === 'rundown' && isModifier && !activeDragSession.value) {
      if (!event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const commandId = event.key === 'ArrowUp' ? 'rundown.moveCurrentUp' : 'rundown.moveCurrentDown';
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute(commandId, ctx);
        return;
      }

      const key = event.key.toLowerCase();
      const commandByKey: Record<string, string> = {
        c: 'rundown.copySelected',
        x: 'rundown.cutSelected',
        v: 'rundown.pasteAfterSelected',
        d: 'rundown.duplicateSelected',
        z: event.shiftKey ? 'rundown.redo' : 'rundown.undo'
      };

      const commandId = commandByKey[key];
      if (commandId) {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute(commandId, ctx);
        return;
      }
    }

    // Delete / Backspace in Rundown Scope
    if ((event.key === 'Delete' || event.key === 'Backspace') && scope === 'rundown') {
      event.preventDefault();
      event.stopPropagation();
      await commandRegistry.execute('rundown.deleteSelected', ctx);
      return;
    }

    // F8 Library Action (F8: append, Shift+F8: insert after rundown selection)
    if (event.code === 'F8' || event.key === 'F8') {
      event.preventDefault();
      event.stopPropagation();
      // Do not execute inside active dialogs -- including DOM-only modals
      // that never set activeModalName (Settings, wizards, trimmer).
      if (activeModalName.value || scope === 'modal' || scope === 'command-palette' || scope === 'trimmer') return;
      const actionId = event.shiftKey ? 'library.insertSelected' : 'library.appendSelected';
      const cmd = commandRegistry.get(actionId);
      const f8Ctx: CommandContext = { ...ctx, originScope: 'library' };
      if (cmd && cmd.isEnabled(f8Ctx)) {
        await commandRegistry.execute(actionId, f8Ctx);
      }
      return;
    }

    // 4. Navigation & Range Selection in Rundown
    if (scope === 'rundown') {
      if (!event.ctrlKey && !event.shiftKey && event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.selectPrevious', ctx);
        return;
      }
      if (!event.ctrlKey && !event.shiftKey && event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.selectNext', ctx);
        return;
      }
      if (event.key === 'PageUp') {
        event.preventDefault();
        event.stopPropagation();
        const container = document.querySelector('[data-command-scope="rundown"]') as HTMLElement | null;
        const pageSize = getVisiblePageSize(container);
        rundown.moveSelectionDelta(-pageSize);
        return;
      }
      if (event.key === 'PageDown') {
        event.preventDefault();
        event.stopPropagation();
        const container = document.querySelector('[data-command-scope="rundown"]') as HTMLElement | null;
        const pageSize = getVisiblePageSize(container);
        rundown.moveSelectionDelta(pageSize);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.selectFirst', ctx);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.selectLast', ctx);
        return;
      }

      // Range select via Shift+Up / Shift+Down
      if (event.shiftKey && event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        rundown.extendSelectionDelta(-1);
        return;
      }
    }

    // 5. Navigation & Selection in Media Library
    if (scope === 'library') {
      if (!event.ctrlKey && !event.shiftKey && event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('library.selectPrevious', ctx);
        return;
      }
      if (!event.ctrlKey && !event.shiftKey && event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('library.selectNext', ctx);
        return;
      }
      if (event.shiftKey && event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('library.extendSelectionPrevious', ctx);
        return;
      }
      if (event.shiftKey && event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('library.extendSelectionNext', ctx);
        return;
      }
      if (event.key === 'PageUp') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('library.selectPageUp', ctx);
        return;
      }
      if (event.key === 'PageDown') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('library.selectPageDown', ctx);
        return;
      }
      if (event.key === 'F2') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('library.renameSelected', ctx);
        return;
      }
      if (event.key === 'Delete') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('library.trashSelected', ctx);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('library.selectFirst', ctx);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('library.selectLast', ctx);
        return;
      }
    }

    // 8. Trimmer Scope Shortcuts
    if (scope === 'trimmer' && activeTrimmerContext.value) {
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('trimmer.shuttleReverse', ctx);
        return;
      }
      if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('trimmer.shuttlePause', ctx);
        return;
      }
      if (event.key === 'l' || event.key === 'L') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('trimmer.shuttleForward', ctx);
        return;
      }
      if (event.key === ',') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('trimmer.stepBackward', ctx);
        return;
      }
      if (event.key === '.') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('trimmer.stepForward', ctx);
        return;
      }
      if (event.key === 'i' || event.key === 'I') {
        event.preventDefault();
        event.stopPropagation();
        const actionId = event.shiftKey ? 'trimmer.clearInPoint' : 'trimmer.setInPoint';
        await commandRegistry.execute(actionId, ctx);
        return;
      }
      if (event.key === 'o' || event.key === 'O') {
        event.preventDefault();
        event.stopPropagation();
        const actionId = event.shiftKey ? 'trimmer.clearOutPoint' : 'trimmer.setOutPoint';
        await commandRegistry.execute(actionId, ctx);
        return;
      }
      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('trimmer.save', ctx);
        return;
      }
    }

    // 9. Undo / Redo Shortcuts -- rundown history only. Never fire while a
    //    dialog, the palette or the trimmer owns focus (audit T1-9).
    const undoRedoAllowed = scope === 'rundown' || scope === 'library' || scope === 'global';
    if (undoRedoAllowed && event.ctrlKey && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      event.stopPropagation();
      const actionId = event.shiftKey ? 'rundown.redo' : 'rundown.undo';
      await commandRegistry.execute(actionId, ctx);
      return;
    }
    if (undoRedoAllowed && event.ctrlKey && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      event.stopPropagation();
      await commandRegistry.execute('rundown.redo', ctx);
      return;
    }
  };

  const mountShortcuts = () => {
    if (shortcutsMounted) return;
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', handleKeyDown, { capture: true });
      shortcutsMounted = true;
    }
  };

  const unmountShortcuts = () => {
    if (!shortcutsMounted) return;
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      shortcutsMounted = false;
    }
  };

  if (getCurrentInstance()) {
    onMounted(mountShortcuts);
    onUnmounted(unmountShortcuts);
  }

  return {
    activeScope,
    activeModalName,
    activeTrimmerContext,
    requireTakeConfirmation,
    mountShortcuts,
    unmountShortcuts
  };
}
