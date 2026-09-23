<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ContextMenu, { type MenuItem } from './ContextMenu.vue';
import { useRundownStore } from '../stores/rundown';
import { commandRegistry } from '../services/commandRegistry';
import { currentCommandContext, executeRegisteredCommand, openCommandPalette } from '../composables/useOperatorShortcuts';
import { usePanelLayout } from '../composables/usePanelLayout';
import { classifyAppMenuTarget, dispatchAppMenuAction, type AppMenuSurface } from '../lib/appMenu';

/**
 * The app's own right-click menu, for empty space.
 *
 * Without it a right-click anywhere that no row claimed opened WebView2's
 * browser menu -- Back, Refresh, Save as, Print, and in dev builds Inspect.
 * Refresh would reload the playout UI mid-take. Rows, folders and assets keep
 * their own menus (they call preventDefault, so this listener stands aside);
 * everywhere else gets the actions that need no selected item. Text fields,
 * dialogs and popovers get nothing at all.
 *
 * In `tauri dev` only, Shift+right-click still reaches the browser menu, so
 * Inspect stays one gesture away while developing.
 */

const emit = defineEmits<{ (e: 'open-settings'): void }>();

const rundown = useRundownStore();
const { libraryCollapsed, folderTreeCollapsed, toggleLibraryCollapsed, toggleFolderTreeCollapsed } = usePanelLayout();

const menu = ref<{ x: number; y: number; surface: AppMenuSurface } | null>(null);

const command = (id: string, label: string, icon: MenuItem['icon'], extra: Partial<MenuItem> = {}): MenuItem => {
  const cmd = commandRegistry.get(id);
  return {
    type: 'action',
    id,
    label,
    icon,
    shortcut: cmd?.defaultShortcut?.replace('Ctrl/Cmd', 'Ctrl'),
    disabled: cmd ? !cmd.isEnabled(currentCommandContext()) : true,
    action: () => void executeRegisteredCommand(id),
    ...extra,
  };
};

const rundownItems = (): MenuItem[] => [
  command('rundown.pasteAfterSelected', 'Paste after selection', 'copy'),
  {
    type: 'action',
    id: 'rundown.liveBlock',
    label: 'Add live block…',
    icon: 'live',
    disabled: rundown.isRundownLocked,
    action: () => dispatchAppMenuAction('rundown.liveBlock'),
  },
  {
    type: 'action',
    id: 'rundown.hardStart',
    label: 'Insert hard start…',
    icon: 'gap',
    // Offline playlists only: the on-air one takes its timing from the transport.
    disabled: !rundown.canScheduleCurrentPlaylist,
    action: () => dispatchAppMenuAction('rundown.hardStart'),
  },
  { type: 'divider' },
  command('playlist.load', 'Load playlist…', 'folder-open'),
  command('playlist.append', 'Append playlist…', 'file-plus'),
  command('playlist.save', 'Save playlist…', 'save'),
];

const libraryItems = (): MenuItem[] => [
  {
    type: 'action',
    id: 'library.newFolder',
    label: 'New folder',
    icon: 'folder-plus',
    action: () => dispatchAppMenuAction('library.newFolder'),
  },
  {
    type: 'action',
    id: 'library.refresh',
    label: 'Refresh library',
    icon: 'refresh',
    action: () => dispatchAppMenuAction('library.refresh'),
  },
  {
    type: 'action',
    id: 'library.toggleTree',
    label: folderTreeCollapsed.value ? 'Show folder tree' : 'Hide folder tree',
    icon: folderTreeCollapsed.value ? 'chevron-right' : 'chevron-down',
    action: toggleFolderTreeCollapsed,
  },
];

const globalItems = (): MenuItem[] => [
  {
    type: 'action',
    id: 'view.toggleLibrary',
    label: libraryCollapsed.value ? 'Expand library' : 'Collapse library',
    icon: libraryCollapsed.value ? 'panel-left-open' : 'panel-left-close',
    shortcut: 'Ctrl+B',
    action: toggleLibraryCollapsed,
  },
  {
    type: 'action',
    id: 'global.commandPalette',
    label: 'Command palette…',
    icon: 'search',
    shortcut: 'Ctrl+K',
    action: openCommandPalette,
  },
  {
    type: 'action',
    id: 'rundown.toggleLock',
    label: rundown.isRundownLocked ? 'Unlock rundown' : 'Lock rundown',
    icon: rundown.isRundownLocked ? 'unlock' : 'lock',
    action: () => rundown.toggleRundownLock(),
  },
  {
    type: 'action',
    id: 'global.settings',
    label: 'Settings…',
    icon: 'settings',
    action: () => emit('open-settings'),
  },
];

const items = computed<MenuItem[]>(() => {
  if (!menu.value) return [];
  const local = menu.value.surface === 'rundown' ? rundownItems() : menu.value.surface === 'library' ? libraryItems() : [];
  return local.length ? [...local, { type: 'divider' }, ...globalItems()] : globalItems();
});

const onContextMenu = (event: MouseEvent) => {
  // A row, folder or asset already opened its own menu.
  if (event.defaultPrevented) return;
  if (import.meta.env.DEV && event.shiftKey) return;
  event.preventDefault();

  const surface = classifyAppMenuTarget(event.target);
  menu.value = surface === 'none' ? null : { x: event.clientX, y: event.clientY, surface };
};

onMounted(() => window.addEventListener('contextmenu', onContextMenu));
onUnmounted(() => window.removeEventListener('contextmenu', onContextMenu));
</script>

<template>
  <Teleport to="body">
    <ContextMenu v-if="menu" :key="`${menu.x}:${menu.y}`" :x="menu.x" :y="menu.y" :items="items" @close="menu = null" />
  </Teleport>
</template>
