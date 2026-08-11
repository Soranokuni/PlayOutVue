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

export type LibraryInsertResult = {
  insertedIds: string[];
  skippedIds: string[];
  errors: string[];
};

export interface LibraryCommandContext {
  getSelectedAssetIds(): string[];
  getVisibleAssetIds(): string[];
  selectPrevious(): void;
  selectNext(): void;
  selectFirst(): void;
  selectLast(): void;
  extendSelection(delta: -1 | 1): void;
  appendSelectedToPlaylist(): Promise<LibraryInsertResult>;
  insertSelectedAfter(rundownItemId: string | null): Promise<LibraryInsertResult>;
}

export interface CommandContext {
  scope: ShortcutScope;
  originScope?: ShortcutScope;
  rundown: ReturnType<typeof useRundownStore>;
  selection: SelectionSnapshot;
  library?: LibraryCommandContext | null;
  activeModal: string | null;
  trimmer: TrimmerCommandContext | null;
  requireTakeConfirmation?: boolean;
}

export type CommandCategory =
  | 'Rundown'
  | 'Library'
  | 'Trimmer'
  | 'Global'
  | 'View'
  | 'System';

export type CommandSafety = 'safe' | 'destructive' | 'playback';

export interface CommandDefinition {
  id: string;
  label: string;
  scopes: ShortcutScope[];
  category: CommandCategory;
  safety: CommandSafety;
  paletteVisible: boolean;
  defaultShortcut?: string;
  description?: string;
  destructive?: boolean;
  requiresConfirmation?: boolean;
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'destructive',
  paletteVisible: true,
  destructive: true,
  requiresConfirmation: true,
  isVisible: () => true,
  isEnabled: (ctx) => ctx.selection.selectedItemIds.length > 0 || !!ctx.selection.primarySelectedId,
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
  defaultShortcut: 'Ctrl/Cmd+C',
  category: 'Rundown',
  safety: 'safe',
  paletteVisible: true,
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
  defaultShortcut: 'Ctrl/Cmd+X',
  category: 'Rundown',
  safety: 'destructive',
  paletteVisible: true,
  destructive: true,
  requiresConfirmation: true,
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
  defaultShortcut: 'Ctrl/Cmd+V',
  category: 'Rundown',
  safety: 'safe',
  paletteVisible: true,
  isVisible: () => true,
  isEnabled: (ctx) => ctx.rundown.canPasteClipboard(),
  disabledReason: (ctx) => (ctx.rundown.canPasteClipboard() ? undefined : 'Nothing in clipboard to paste'),
  execute: (ctx) => {
    ctx.rundown.pasteClipboardAfterSelection();
  }
});

commandRegistry.register({
  id: 'rundown.duplicateSelected',
  label: 'Duplicate Selected Item(s)',
  scopes: ['rundown'],
  defaultShortcut: 'Ctrl/Cmd+D',
  category: 'Rundown',
  safety: 'safe',
  paletteVisible: true,
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
  defaultShortcut: 'Ctrl/Cmd+Z',
  category: 'Rundown',
  safety: 'safe',
  paletteVisible: true,
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
  defaultShortcut: 'Ctrl/Cmd+Shift+Z',
  category: 'Rundown',
  safety: 'safe',
  paletteVisible: true,
  isVisible: () => true,
  isEnabled: (ctx) => ctx.rundown.canRedo,
  execute: (ctx) => {
    ctx.rundown.redo();
  }
});

commandRegistry.register({
  id: 'library.selectPrevious',
  label: 'Select Previous Library Asset',
  scopes: ['library'],
  defaultShortcut: 'Up',
  category: 'Library',
  safety: 'safe',
  paletteVisible: false,
  isVisible: () => true,
  isEnabled: (ctx) => (ctx.originScope ?? ctx.scope) === 'library' && !!ctx.library,
  execute: (ctx) => {
    ctx.library?.selectPrevious();
  }
});

commandRegistry.register({
  id: 'library.selectNext',
  label: 'Select Next Library Asset',
  scopes: ['library'],
  defaultShortcut: 'Down',
  category: 'Library',
  safety: 'safe',
  paletteVisible: false,
  isVisible: () => true,
  isEnabled: (ctx) => (ctx.originScope ?? ctx.scope) === 'library' && !!ctx.library,
  execute: (ctx) => {
    ctx.library?.selectNext();
  }
});

commandRegistry.register({
  id: 'library.selectFirst',
  label: 'Select First Library Asset',
  scopes: ['library'],
  defaultShortcut: 'Home',
  category: 'Library',
  safety: 'safe',
  paletteVisible: false,
  isVisible: () => true,
  isEnabled: (ctx) => (ctx.originScope ?? ctx.scope) === 'library' && !!ctx.library,
  execute: (ctx) => {
    ctx.library?.selectFirst();
  }
});

commandRegistry.register({
  id: 'library.selectLast',
  label: 'Select Last Library Asset',
  scopes: ['library'],
  defaultShortcut: 'End',
  category: 'Library',
  safety: 'safe',
  paletteVisible: false,
  isVisible: () => true,
  isEnabled: (ctx) => (ctx.originScope ?? ctx.scope) === 'library' && !!ctx.library,
  execute: (ctx) => {
    ctx.library?.selectLast();
  }
});

commandRegistry.register({
  id: 'library.extendSelectionPrevious',
  label: 'Extend Library Selection Previous',
  scopes: ['library'],
  defaultShortcut: 'Shift+Up',
  category: 'Library',
  safety: 'safe',
  paletteVisible: false,
  isVisible: () => true,
  isEnabled: (ctx) => (ctx.originScope ?? ctx.scope) === 'library' && !!ctx.library,
  execute: (ctx) => {
    ctx.library?.extendSelection(-1);
  }
});

commandRegistry.register({
  id: 'library.extendSelectionNext',
  label: 'Extend Library Selection Next',
  scopes: ['library'],
  defaultShortcut: 'Shift+Down',
  category: 'Library',
  safety: 'safe',
  paletteVisible: false,
  isVisible: () => true,
  isEnabled: (ctx) => (ctx.originScope ?? ctx.scope) === 'library' && !!ctx.library,
  execute: (ctx) => {
    ctx.library?.extendSelection(1);
  }
});

commandRegistry.register({
  id: 'library.appendSelected',
  label: 'Append Library Selection to Active Rundown',
  scopes: ['library'],
  defaultShortcut: 'F8',
  category: 'Library',
  safety: 'safe',
  paletteVisible: true,
  isVisible: () => true,
  isEnabled: (ctx) => (ctx.scope === 'library' || ctx.originScope === 'library') && !!ctx.library && ctx.library.getSelectedAssetIds().length > 0,
  disabledReason: (ctx) => (
    (ctx.scope !== 'library' && ctx.originScope !== 'library')
      ? 'Library surface is not active'
      : (!ctx.library || ctx.library.getSelectedAssetIds().length === 0 ? 'No library asset selected' : undefined)
  ),
  execute: async (ctx) => {
    if (ctx.library) {
      await ctx.library.appendSelectedToPlaylist();
    }
  }
});

commandRegistry.register({
  id: 'library.insertSelected',
  label: 'Insert Library Selection After Rundown Selection',
  scopes: ['library'],
  defaultShortcut: 'Shift+F8',
  category: 'Library',
  safety: 'safe',
  paletteVisible: true,
  isVisible: () => true,
  isEnabled: (ctx) => (ctx.scope === 'library' || ctx.originScope === 'library') && !!ctx.library && ctx.library.getSelectedAssetIds().length > 0,
  disabledReason: (ctx) => (
    (ctx.scope !== 'library' && ctx.originScope !== 'library')
      ? 'Library surface is not active'
      : (!ctx.library || ctx.library.getSelectedAssetIds().length === 0 ? 'No library asset selected' : undefined)
  ),
  execute: async (ctx) => {
    if (ctx.library) {
      await ctx.library.insertSelectedAfter(ctx.selection.primarySelectedId);
    }
  }
});

commandRegistry.register({
  id: 'trimmer.shuttleReverse',
  label: 'Shuttle Reverse (J)',
  scopes: ['trimmer'],
  defaultShortcut: 'J',
  category: 'Trimmer',
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
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
  safety: 'safe',
  paletteVisible: false,
  isVisible: () => true,
  isEnabled: (ctx) => !!ctx.trimmer && ctx.trimmer.isDirty,
  execute: (ctx) => {
    ctx.trimmer?.onSave?.();
  }
});
