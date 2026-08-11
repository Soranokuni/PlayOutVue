import { getCurrentInstance, onMounted, onUnmounted, ref } from 'vue';
import { useRundownStore } from '../stores/rundown';
import {
  commandRegistry,
  type CommandContext,
  type ShortcutScope,
  type TrimmerCommandContext
} from '../services/commandRegistry';

export const activeScope = ref<ShortcutScope>('rundown');
export const activeModalName = ref<string | null>(null);
export const activeTrimmerContext = ref<TrimmerCommandContext | null>(null);
export const requireTakeConfirmation = ref<boolean>(false);

/**
 * Determines current active scope based on DOM focus state and open modals.
 */
export function classifyActiveScope(): ShortcutScope {
  const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

  if (active?.closest('[data-command-scope="modal"]')) {
    return 'modal';
  }

  if (active?.closest('[data-command-scope="command-palette"]')) {
    return 'command-palette';
  }

  if (active?.closest('[data-command-scope="trimmer"]') || activeModalName.value === 'trimmer') {
    return 'trimmer';
  }

  if (activeModalName.value) {
    return 'modal';
  }

  if (
    active?.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName ?? '')
  ) {
    return 'text-input';
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

export async function executeRegisteredCommand(commandId: string): Promise<boolean> {
  const rundown = useRundownStore();
  const scope = classifyActiveScope();
  const ctx: CommandContext = {
    scope,
    rundown,
    selection: {
      selectedItemIds: rundown.selectedItemIds,
      primarySelectedId: rundown.selectedItemId
    },
    activeModal: activeModalName.value,
    trimmer: activeTrimmerContext.value,
    requireTakeConfirmation: requireTakeConfirmation.value
  };
  return commandRegistry.execute(commandId, ctx);
}

/**
 * Centralized application keyboard router composable.
 */
export function useOperatorShortcuts() {
  const handleKeyDown = async (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const scope = classifyActiveScope();

    // 1. Text input handling: allow normal typing, but pass Escape to close transient UI
    if (scope === 'text-input') {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
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
      activeModal: activeModalName.value,
      trimmer: activeTrimmerContext.value,
      requireTakeConfirmation: requireTakeConfirmation.value
    };

    // 2. Global Escape cascade
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
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

    // 3. Command Palette (Ctrl+K)
    if (event.ctrlKey && (event.key === 'k' || event.key === 'K')) {
      event.preventDefault();
      event.stopPropagation();
      activeModalName.value = 'command-palette';
      return;
    }

    // Explicit Action Key Guard for PR 1: Action keys are ignored by global listener
    if (
      event.key === 'Enter' ||
      event.key === ' ' ||
      event.code === 'Space' ||
      event.code === 'F8' ||
      event.key === 'Delete' ||
      event.key === 'Backspace'
    ) {
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
        rundown.moveSelectionPage(-1);
        return;
      }
      if (event.key === 'PageDown') {
        event.preventDefault();
        event.stopPropagation();
        rundown.moveSelectionPage(1);
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
      if (event.shiftKey && event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        rundown.extendSelectionDelta(1);
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

    // 9. Undo / Redo Global Shortcuts
    if (event.ctrlKey && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      event.stopPropagation();
      const actionId = event.shiftKey ? 'rundown.redo' : 'rundown.undo';
      await commandRegistry.execute(actionId, ctx);
      return;
    }
    if (event.ctrlKey && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      event.stopPropagation();
      await commandRegistry.execute('rundown.redo', ctx);
      return;
    }
  };

  const mountShortcuts = () => {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', handleKeyDown, { capture: true });
    }
  };

  const unmountShortcuts = () => {
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
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
