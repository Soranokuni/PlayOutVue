import { onMounted, onUnmounted, ref } from 'vue';
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
  if (activeModalName.value) {
    if (activeModalName.value === 'trimmer') return 'trimmer';
    return 'modal';
  }

  const active = document.activeElement as HTMLElement | null;
  if (!active) return activeScope.value;

  if (
    active.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)
  ) {
    return 'text-input';
  }

  if (active.closest('[role="listbox"][aria-label="Playlist rundown"]')) {
    return 'rundown';
  }

  if (active.closest('.media-library-panel') || active.closest('[data-scope="library"]')) {
    return 'library';
  }

  return activeScope.value;
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

    // 4. Physical Function Keys (F8, Shift+F8)
    if (event.code === 'F8') {
      if (scope === 'library') {
        event.preventDefault();
        event.stopPropagation();
        const actionId = event.shiftKey ? 'library.insertSelected' : 'library.appendSelected';
        await commandRegistry.execute(actionId, ctx);
      }
      return;
    }

    // 5. Spacebar Take guard
    if (event.key === ' ' || event.code === 'Space') {
      if (isInteractiveControl(target)) {
        return; // Allow native button click or checkbox toggle
      }
      if (scope === 'rundown' && ctx.selection.primarySelectedId) {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.takeSelected', ctx);
        return;
      }
    }

    // 6. Enter Take
    if (event.key === 'Enter') {
      if (scope === 'rundown' && ctx.selection.primarySelectedId) {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.takeSelected', ctx);
        return;
      }
    }

    // 7. Arrows / Navigation in Rundown
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

      // Reorder items via Ctrl+Up / Ctrl+Down
      if (event.ctrlKey && event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        rundown.moveSelectedItemsDelta(-1);
        return;
      }
      if (event.ctrlKey && event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        rundown.moveSelectedItemsDelta(1);
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

      // Delete / Backspace
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.deleteSelected', ctx);
        return;
      }

      // Clipboard operations (Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+D)
      if (event.ctrlKey && (event.key === 'c' || event.key === 'C')) {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.copySelected', ctx);
        return;
      }
      if (event.ctrlKey && (event.key === 'x' || event.key === 'X')) {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.cutSelected', ctx);
        return;
      }
      if (event.ctrlKey && (event.key === 'v' || event.key === 'V')) {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.pasteAfterSelected', ctx);
        return;
      }
      if (event.ctrlKey && (event.key === 'd' || event.key === 'D')) {
        event.preventDefault();
        event.stopPropagation();
        await commandRegistry.execute('rundown.duplicateSelected', ctx);
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

  onMounted(() => {
    window.addEventListener('keydown', handleKeyDown, { capture: true });
  });

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeyDown, { capture: true });
  });

  return {
    activeScope,
    activeModalName,
    activeTrimmerContext,
    requireTakeConfirmation
  };
}
