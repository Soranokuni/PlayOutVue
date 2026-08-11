import type { useRundownStore } from '../stores/rundown';

export type ShortcutScope =
  | 'global'
  | 'rundown'
  | 'library'
  | 'trimmer'
  | 'text-input'
  | 'command-palette'
  | 'modal';

export interface SelectionSnapshot {
  selectedItemIds: string[];
  primarySelectedId: string | null;
}

export interface TrimmerCommandContext {
  itemId?: string;
  playheadMs: number;
  inMs: number;
  outMs: number;
  isDirty: boolean;
  onShuttle?: (direction: -1 | 0 | 1) => void;
  onStepFrame?: (delta: number) => void;
  onSetIn?: () => void;
  onSetOut?: () => void;
  onClearIn?: () => void;
  onClearOut?: () => void;
  onNudge?: (boundary: 'in' | 'out', deltaFrames: number) => void;
  onSave?: () => void;
  onRevert?: () => void;
}

export interface LibraryCommandContext {
  selectedAsset?: {
    filename: string;
    path: string;
    duration?: number;
  } | null;
  appendSelectedToRundown?: () => void;
  insertSelectedIntoRundown?: () => void;
}

export interface CommandContext {
  scope: ShortcutScope;
  rundown: ReturnType<typeof useRundownStore>;
  selection: SelectionSnapshot;
  library?: LibraryCommandContext | null;
  activeModal: string | null;
  trimmer: TrimmerCommandContext | null;
  requireTakeConfirmation?: boolean;
}

export interface CommandDefinition {
  id: string;
  label: string;
  scopes: ShortcutScope[];
  defaultShortcut?: string;
  category?: 'Rundown' | 'Library' | 'Trimmer' | 'Global';
  description?: string;
  isVisible: (ctx: CommandContext) => boolean;
  isEnabled: (ctx: CommandContext) => boolean;
  disabledReason?: (ctx: CommandContext) => string | undefined;
  execute: (ctx: CommandContext) => Promise<void> | void;
}

class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();

  public register(command: CommandDefinition): void {
    this.commands.set(command.id, command);
  }

  public unregister(id: string): void {
    this.commands.delete(id);
  }

  public get(id: string): CommandDefinition | undefined {
    return this.commands.get(id);
  }

  public getAll(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  public getForScope(scope: ShortcutScope, ctx: CommandContext): CommandDefinition[] {
    return this.getAll().filter(
      (cmd) => cmd.scopes.includes(scope) && cmd.isVisible(ctx)
    );
  }

  public async execute(id: string, ctx: CommandContext): Promise<boolean> {
    const cmd = this.commands.get(id);
    if (!cmd) return false;
    if (!cmd.isEnabled(ctx)) return false;
    await cmd.execute(ctx);
    return true;
  }
}

export const commandRegistry = new CommandRegistry();

// ── Default Broadcast Command Registrations ──────────────────────────────────

commandRegistry.register({
  id: 'rundown.selectPrevious',
  label: 'Select Previous Item',
  scopes: ['rundown'],
  defaultShortcut: 'Up',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.rundown.activeItems.length > 0,
  execute: (ctx) => {
    ctx.rundown.moveSelectionDelta(-1);
  }
});

commandRegistry.register({
  id: 'rundown.selectNext',
  label: 'Select Next Item',
  scopes: ['rundown'],
  defaultShortcut: 'Down',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.rundown.activeItems.length > 0,
  execute: (ctx) => {
    ctx.rundown.moveSelectionDelta(1);
  }
});

commandRegistry.register({
  id: 'rundown.selectFirst',
  label: 'Select First Item',
  scopes: ['rundown'],
  defaultShortcut: 'Home',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.rundown.activeItems.length > 0,
  execute: (ctx) => {
    const first = ctx.rundown.activeItems[0];
    if (first) ctx.rundown.selectedItemId = first.id;
  }
});

commandRegistry.register({
  id: 'rundown.selectLast',
  label: 'Select Last Item',
  scopes: ['rundown'],
  defaultShortcut: 'End',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.rundown.activeItems.length > 0,
  execute: (ctx) => {
    const last = ctx.rundown.activeItems[ctx.rundown.activeItems.length - 1];
    if (last) ctx.rundown.selectedItemId = last.id;
  }
});



commandRegistry.register({
  id: 'rundown.deleteSelected',
  label: 'Delete Selected Item(s)',
  scopes: ['rundown'],
  defaultShortcut: 'Delete',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.selection.selectedItemIds.length > 0,
  execute: (ctx) => {
    const ids = ctx.selection.selectedItemIds.length > 0 
      ? ctx.selection.selectedItemIds 
      : (ctx.selection.primarySelectedId ? [ctx.selection.primarySelectedId] : []);
    ctx.rundown.removeItems(ids);
  }
});

commandRegistry.register({
  id: 'rundown.copySelected',
  label: 'Copy Selected Item(s)',
  scopes: ['rundown'],
  defaultShortcut: 'Ctrl+C',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.selection.selectedItemIds.length > 0 || !!ctx.selection.primarySelectedId,
  execute: (ctx) => {
    ctx.rundown.copySelectionToClipboard();
  }
});

commandRegistry.register({
  id: 'rundown.cutSelected',
  label: 'Cut Selected Item(s)',
  scopes: ['rundown'],
  defaultShortcut: 'Ctrl+X',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.selection.selectedItemIds.length > 0 || !!ctx.selection.primarySelectedId,
  execute: (ctx) => {
    ctx.rundown.cutSelectionToClipboard();
  }
});

commandRegistry.register({
  id: 'rundown.pasteAfterSelected',
  label: 'Paste After Selection',
  scopes: ['rundown'],
  defaultShortcut: 'Ctrl+V',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.rundown.canPasteClipboard(),
  execute: (ctx) => {
    ctx.rundown.pasteClipboardAfterSelection();
  }
});

commandRegistry.register({
  id: 'rundown.duplicateSelected',
  label: 'Duplicate Selected Item(s)',
  scopes: ['rundown'],
  defaultShortcut: 'Ctrl+D',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.selection.primarySelectedId || ctx.selection.selectedItemIds.length > 0,
  execute: (ctx) => {
    if (ctx.selection.primarySelectedId) {
      ctx.rundown.duplicateItem(ctx.selection.primarySelectedId);
    }
  }
});

commandRegistry.register({
  id: 'rundown.undo',
  label: 'Undo Rundown Action',
  scopes: ['rundown', 'global'],
  defaultShortcut: 'Ctrl+Z',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.rundown.canUndo,
  execute: (ctx) => {
    ctx.rundown.undo();
  }
});

commandRegistry.register({
  id: 'rundown.redo',
  label: 'Redo Rundown Action',
  scopes: ['rundown', 'global'],
  defaultShortcut: 'Ctrl+Shift+Z',
  category: 'Rundown',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.rundown.canRedo,
  execute: (ctx) => {
    ctx.rundown.redo();
  }
});

commandRegistry.register({
  id: 'library.appendSelected',
  label: 'Append Library Selection to Active Rundown',
  scopes: ['library'],
  defaultShortcut: 'F8',
  category: 'Library',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.scope === 'library' && (!!ctx.library?.appendSelectedToRundown || !!ctx.library?.selectedAsset),
  disabledReason: (ctx) => (ctx.scope !== 'library' ? 'Library surface is not active' : 'No library asset selected'),
  execute: (ctx) => {
    if (ctx.library?.appendSelectedToRundown) {
      ctx.library.appendSelectedToRundown();
    } else if (ctx.library?.selectedAsset) {
      const dur = ctx.library.selectedAsset.duration || 10;
      ctx.rundown.addItem({
        filename: ctx.library.selectedAsset.filename,
        type: 'video',
        path: ctx.library.selectedAsset.path,
        shortPath: ctx.library.selectedAsset.filename,
        duration: dur,
        seek: 0,
        length: dur,
        libraryIndicator: 'none'
      });
    }
  }
});

commandRegistry.register({
  id: 'library.insertSelected',
  label: 'Insert Library Selection After Rundown Selection',
  scopes: ['library'],
  defaultShortcut: 'Shift+F8',
  category: 'Library',
  isVisible: () => true,
  isEnabled: (ctx) => ctx.scope === 'library' && (!!ctx.library?.insertSelectedIntoRundown || !!ctx.library?.selectedAsset),
  disabledReason: (ctx) => (ctx.scope !== 'library' ? 'Library surface is not active' : 'No library asset selected'),
  execute: (ctx) => {
    if (ctx.library?.insertSelectedIntoRundown) {
      ctx.library.insertSelectedIntoRundown();
    } else if (ctx.library?.selectedAsset) {
      const dur = ctx.library.selectedAsset.duration || 10;
      const target = ctx.selection.primarySelectedId
        ? { kind: 'after' as const, targetItemId: ctx.selection.primarySelectedId }
        : { kind: 'append' as const };
      ctx.rundown.insertLibraryItems({
        items: [{
          filename: ctx.library.selectedAsset.filename,
          type: 'video',
          path: ctx.library.selectedAsset.path,
          shortPath: ctx.library.selectedAsset.filename,
          duration: dur,
          seek: 0,
          length: dur,
          libraryIndicator: 'none'
        }],
        target
      });
    }
  }
});

commandRegistry.register({
  id: 'trimmer.shuttleReverse',
  label: 'Shuttle Reverse (J)',
  scopes: ['trimmer'],
  defaultShortcut: 'J',
  category: 'Trimmer',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer,
  execute: (ctx) => {
    ctx.trimmer?.onShuttle?.(-1);
  }
});

commandRegistry.register({
  id: 'trimmer.shuttlePause',
  label: 'Shuttle Pause (K)',
  scopes: ['trimmer'],
  defaultShortcut: 'K',
  category: 'Trimmer',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer,
  execute: (ctx) => {
    ctx.trimmer?.onShuttle?.(0);
  }
});

commandRegistry.register({
  id: 'trimmer.shuttleForward',
  label: 'Shuttle Forward (L)',
  scopes: ['trimmer'],
  defaultShortcut: 'L',
  category: 'Trimmer',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer,
  execute: (ctx) => {
    ctx.trimmer?.onShuttle?.(1);
  }
});

commandRegistry.register({
  id: 'trimmer.stepBackward',
  label: 'Step Frame Backward ( , )',
  scopes: ['trimmer'],
  defaultShortcut: ',',
  category: 'Trimmer',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer,
  execute: (ctx) => {
    ctx.trimmer?.onStepFrame?.(-1);
  }
});

commandRegistry.register({
  id: 'trimmer.stepForward',
  label: 'Step Frame Forward ( . )',
  scopes: ['trimmer'],
  defaultShortcut: '.',
  category: 'Trimmer',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer,
  execute: (ctx) => {
    ctx.trimmer?.onStepFrame?.(1);
  }
});

commandRegistry.register({
  id: 'trimmer.setInPoint',
  label: 'Set In Point (I)',
  scopes: ['trimmer'],
  defaultShortcut: 'I',
  category: 'Trimmer',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer,
  execute: (ctx) => {
    ctx.trimmer?.onSetIn?.();
  }
});

commandRegistry.register({
  id: 'trimmer.setOutPoint',
  label: 'Set Out Point (O)',
  scopes: ['trimmer'],
  defaultShortcut: 'O',
  category: 'Trimmer',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer,
  execute: (ctx) => {
    ctx.trimmer?.onSetOut?.();
  }
});

commandRegistry.register({
  id: 'trimmer.clearInPoint',
  label: 'Clear In Point (Shift+I)',
  scopes: ['trimmer'],
  defaultShortcut: 'Shift+I',
  category: 'Trimmer',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer,
  execute: (ctx) => {
    ctx.trimmer?.onClearIn?.();
  }
});

commandRegistry.register({
  id: 'trimmer.clearOutPoint',
  label: 'Clear Out Point (Shift+O)',
  scopes: ['trimmer'],
  defaultShortcut: 'Shift+O',
  category: 'Trimmer',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer,
  execute: (ctx) => {
    ctx.trimmer?.onClearOut?.();
  }
});

commandRegistry.register({
  id: 'trimmer.save',
  label: 'Save Trim Edits',
  scopes: ['trimmer'],
  defaultShortcut: 'Ctrl+Enter',
  category: 'Trimmer',
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer && ctx.trimmer.isDirty,
  execute: (ctx) => {
    ctx.trimmer?.onSave?.();
  }
});
