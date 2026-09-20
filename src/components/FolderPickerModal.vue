<script setup lang="ts">
import BaseModal from './ui/BaseModal.vue';
import BaseButton from './ui/BaseButton.vue';
import ModalFooterActions from './ui/ModalFooterActions.vue';
import AppIcon from './ui/AppIcon.vue';
import { computed, ref, watch } from 'vue';
import { useMediaLibraryStore, buildVirtualFolderTree, type VirtualFolderNode } from '../stores/mediaLibrary';

const props = withDefaults(
  defineProps<{
    isOpen: boolean;
    title?: string;
    currentPath?: string;
    forbiddenPaths?: string[];
    mode?: 'asset' | 'folder';
  }>(),
  {
    title: 'Move to Virtual Folder',
    currentPath: '/',
    forbiddenPaths: () => [],
    mode: 'asset',
  }
);

const emit = defineEmits<{
  (e: 'select', targetFolderPath: string): void;
  (e: 'close'): void;
}>();

const mediaLibrary = useMediaLibraryStore();
const searchQuery = ref('');
const selectedFolder = ref('/');
const expandedFolders = ref<Record<string, boolean>>({ '/': true });
const isCreatingSubfolder = ref(false);
const newSubfolderName = ref('');

const folderTree = computed(() => {
  return buildVirtualFolderTree(
    mediaLibrary.assets,
    mediaLibrary.transientFolders,
    mediaLibrary.folderColors,
    mediaLibrary.deletedUuids,
    ''
  );
});

// Breadcrumbs for selected folder
const breadcrumbs = computed(() => {
  const path = selectedFolder.value;
  if (!path || path === '/') return [{ name: 'All Media (Root)', path: '/' }];
  const parts = path.split('/').filter(Boolean);
  const crumbs = [{ name: 'All Media (Root)', path: '/' }];
  let accum = '';
  for (const p of parts) {
    accum += `/${p}`;
    crumbs.push({ name: p, path: accum });
  }
  return crumbs;
});

const isForbidden = (path: string): boolean => {
  if (!props.forbiddenPaths || props.forbiddenPaths.length === 0) return false;
  return props.forbiddenPaths.some(
    (fp) => path === fp || path.startsWith(fp + '/')
  );
};

const isCurrentDestination = computed(() => {
  if (props.mode === 'folder') {
    // When moving a folder, selecting its current parent or itself is a no-op
    const parts = (props.currentPath || '/').split('/').filter(Boolean);
    parts.pop();
    const parent = parts.length ? `/${parts.join('/')}` : '/';
    return selectedFolder.value === parent || selectedFolder.value === props.currentPath;
  }
  return selectedFolder.value === props.currentPath;
});

const canConfirm = computed(() => {
  if (isForbidden(selectedFolder.value)) return false;
  if (props.mode === 'folder' && isCurrentDestination.value) return false;
  return true;
});

const selectFolder = (path: string) => {
  if (isForbidden(path)) return;
  selectedFolder.value = path;
  expandedFolders.value[path] = true;
};

const toggleExpand = (path: string) => {
  expandedFolders.value[path] = !expandedFolders.value[path];
};

const startCreateSubfolder = () => {
  isCreatingSubfolder.value = true;
  newSubfolderName.value = '';
};

const commitCreateSubfolder = () => {
  const name = newSubfolderName.value.trim();
  if (!name) {
    isCreatingSubfolder.value = false;
    return;
  }
  const created = mediaLibrary.createVirtualFolder(selectedFolder.value, name);
  if (created) {
    selectedFolder.value = created;
    expandedFolders.value[created] = true;
  }
  isCreatingSubfolder.value = false;
  newSubfolderName.value = '';
};

const cancelCreateSubfolder = () => {
  isCreatingSubfolder.value = false;
  newSubfolderName.value = '';
};

const confirmMove = () => {
  if (!canConfirm.value) return;
  emit('select', selectedFolder.value);
};

// Arbitrary N-level recursive tree flattener
export interface VisiblePickerFolder {
  path: string;
  name: string;
  depth: number;
  color?: string;
  allAssetCount: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isForbidden: boolean;
}

const visiblePickerRows = computed<VisiblePickerFolder[]>(() => {
  const rows: VisiblePickerFolder[] = [];
  const walk = (node: VirtualFolderNode) => {
    const isExpanded = expandedFolders.value[node.path] !== false;
    const forbidden = isForbidden(node.path);

    rows.push({
      path: node.path,
      name: node.path === '/' ? 'All Media (Root /)' : node.name,
      depth: node.depth,
      color: node.color,
      allAssetCount: node.allAssetCount,
      hasChildren: node.children.length > 0,
      isExpanded,
      isForbidden: forbidden,
    });

    if (isExpanded) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };

  walk(folderTree.value);
  return rows;
});

// Flatten tree for search filtering if user typed a search query
interface FlatFolderItem {
  path: string;
  name: string;
  depth: number;
  color?: string;
  allAssetCount: number;
  node: VirtualFolderNode;
}

const flattenAllTree = (node: VirtualFolderNode, list: FlatFolderItem[] = []): FlatFolderItem[] => {
  list.push({
    path: node.path,
    name: node.name,
    depth: node.depth,
    color: node.color,
    allAssetCount: node.allAssetCount,
    node,
  });
  for (const child of node.children) {
    flattenAllTree(child, list);
  }
  return list;
};

const flatFolders = computed(() => flattenAllTree(folderTree.value));

const filteredFlatFolders = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return null;
  return flatFolders.value.filter(
    (f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)
  );
});

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      searchQuery.value = '';
      isCreatingSubfolder.value = false;
      newSubfolderName.value = '';

      // Default selection to current path or root
      let initial = props.currentPath || '/';
      if (props.mode === 'folder' && initial !== '/') {
        const parts = initial.split('/').filter(Boolean);
        parts.pop();
        initial = parts.length ? `/${parts.join('/')}` : '/';
      }
      selectedFolder.value = initial;

      // Expand all ancestors
      const expanded: Record<string, boolean> = { '/': true };
      const parts = selectedFolder.value.split('/').filter(Boolean);
      let accum = '';
      for (const p of parts) {
        accum += `/${p}`;
        expanded[accum] = true;
      }
      expandedFolders.value = expanded;
    }
  },
  { immediate: true }
);
</script>

<template>
  <BaseModal
    :open="isOpen"
    size="md"
    :title="title"
    subtitle="Choose the virtual folder to move into."
    nested
    @close="$emit('close')"
  >
    <template #header-actions>
      <BaseButton variant="ghost" size="sm" icon="folder-plus" @click="startCreateSubfolder">New folder</BaseButton>
    </template>

    <!-- Search & Filter Bar -->
    <div class="search-bar-row">
      <div class="search-input-wrapper">
        <AppIcon class="search-icon" name="search" :size="14" />
        <input
          v-model="searchQuery"
          type="text"
          class="input search-input"
          placeholder="Search destination folders…"
        />
        <BaseButton
          v-if="searchQuery"
          class="clear-search-btn"
          variant="icon"
          size="sm"
          icon="close"
          label="Clear search"
          @click="searchQuery = ''"
        />
      </div>
    </div>

    <!-- Inline Folder Creation Input -->
    <div v-if="isCreatingSubfolder" class="inline-create-box">
          <div class="create-prompt">
            Create new subfolder inside <code>{{ selectedFolder }}</code>:
          </div>
          <div class="create-input-row">
            <input
              v-model="newSubfolderName"
              type="text"
              class="input"
              placeholder="Subfolder name (e.g. Season 1)"
              @keydown.enter="commitCreateSubfolder"
              @keydown.esc="cancelCreateSubfolder"
            />
            <BaseButton variant="primary" :disabled="!newSubfolderName.trim()" @click="commitCreateSubfolder">
              Create
            </BaseButton>
            <BaseButton variant="secondary" @click="cancelCreateSubfolder">Cancel</BaseButton>
          </div>
        </div>

    <!-- Body: Tree or Filtered List -->
    <div class="picker-body">
          <!-- Filtered List (When searching) -->
          <div v-if="filteredFlatFolders !== null" class="filtered-list">
            <div v-if="filteredFlatFolders.length === 0" class="empty-results">
              No virtual folders matching "{{ searchQuery }}"
            </div>
            <div
              v-for="item in filteredFlatFolders"
              :key="item.path"
              class="folder-row"
              :class="{
                'is-selected': selectedFolder === item.path,
                'is-disabled': isForbidden(item.path),
              }"
              @click="selectFolder(item.path)"
              @dblclick="selectFolder(item.path); confirmMove();"
            >
              <span class="folder-color-dot" :style="{ background: item.color || 'var(--accent-blue)' }"></span>
              <span class="folder-path-display">{{ item.path }}</span>
              <span class="asset-count-pill">{{ item.allAssetCount }} items</span>
              <span v-if="isForbidden(item.path)" class="forbidden-pill">Source / Forbidden</span>
            </div>
          </div>

          <!-- Arbitrary N-Level Recursive Tree View -->
          <div v-else class="tree-container">
            <!-- F-17: the indent step matches the library tree. It was 20px
                 here and 18px there, for the same folders. -->
            <div
              v-for="folder in visiblePickerRows"
              :key="folder.path"
              class="folder-row"
              :class="{
                'is-selected': selectedFolder === folder.path,
                'is-disabled': folder.isForbidden,
                'is-root': folder.depth === 0,
              }"
              :style="{ paddingLeft: `${folder.depth * 18 + 8}px` }"
              @click="selectFolder(folder.path)"
              @dblclick="selectFolder(folder.path); confirmMove();"
            >
              <!-- Tree Indentation Guide Lines -->
              <span
                v-for="d in folder.depth"
                :key="d"
                class="tree-guide-indent"
                :style="{ left: `${(d - 1) * 20 + 16}px` }"
              ></span>

              <!-- Chevron -->
              <span
                v-if="folder.hasChildren"
                class="chevron"
                :class="{ 'is-expanded': folder.isExpanded }"
                @click.stop="toggleExpand(folder.path)"
              >
                ▶
              </span>
              <span v-else class="chevron-spacer"></span>

              <!-- Folder Icon / Color Dot -->
              <span v-if="folder.depth === 0" class="folder-icon">📂</span>
              <span
                v-else
                class="folder-color-dot"
                :style="{ background: folder.color || 'var(--accent-blue)' }"
              ></span>

              <!-- Folder Title -->
              <span class="folder-title">{{ folder.name }}</span>

              <!-- Asset Count Badge -->
              <span class="asset-count-pill">{{ folder.allAssetCount }}</span>

              <!-- Forbidden Pill -->
              <span v-if="folder.isForbidden" class="forbidden-pill">Source / Forbidden</span>
            </div>
          </div>
        </div>

        <!-- Selected Breadcrumb Trail & Target Bar -->
        <div class="selected-target-bar">
          <span class="target-label">DESTINATION:</span>
          <div class="breadcrumb-trail custom-scroll">
            <span
              v-for="(crumb, idx) in breadcrumbs"
              :key="crumb.path"
              class="crumb-item"
              @click="selectFolder(crumb.path)"
            >
              {{ crumb.name }}
              <span v-if="idx < breadcrumbs.length - 1" class="crumb-separator">/</span>
            </span>
          </div>
        </div>

    <template #footer>
      <ModalFooterActions>
        <template #secondary>
          <BaseButton variant="secondary" @click="$emit('close')">Cancel</BaseButton>
        </template>
        <template #primary>
          <BaseButton variant="primary" icon="check" :disabled="!canConfirm" @click="confirmMove">
            Move here
          </BaseButton>
        </template>
      </ModalFooterActions>
    </template>
  </BaseModal>
</template>

<style scoped>
/* Search Bar */
.search-bar-row {
  display: flex;
  gap: 10px;
  padding: 10px 1.4rem;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-subtle);
}

.search-input-wrapper {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  font-size: 0.85rem;
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding-left: 32px;
  padding-right: 28px;
}

.clear-search-btn {
  position: absolute;
  right: 8px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.85rem;
}

.clear-search-btn:hover {
  color: var(--text-primary);
}

/* Inline Create Box */
.inline-create-box {
  background: color-mix(in srgb, var(--accent-blue) 10%, var(--bg-secondary));
  border-bottom: 1px solid color-mix(in srgb, var(--accent-blue) 30%, transparent);
  padding: 10px 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.create-prompt {
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.create-prompt code {
  color: var(--accent-blue);
  font-weight: 700;
}

.create-input-row {
  display: flex;
  gap: 8px;
}

.create-input-row .input {
  flex: 1;
}

/* Body */
.tree-container {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.folder-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  height: 34px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s ease;
  user-select: none;
  background: var(--bg-secondary);
}

.folder-row:hover:not(.is-disabled) {
  background: var(--bg-hover);
}

.folder-row.is-selected {
  background: var(--bg-active);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 45%, transparent);
}

.folder-row.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Tree Guide Lines */
.tree-guide-indent {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-medium);
  pointer-events: none;
}

.folder-row:hover .tree-guide-indent {
  background: var(--accent-blue);
}

.chevron {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s ease, color 0.15s ease;
  cursor: pointer;
  flex-shrink: 0;
}

.chevron.is-expanded {
  transform: rotate(90deg);
  color: var(--accent-blue);
}

.chevron-spacer {
  width: 16px;
  flex-shrink: 0;
}

.folder-icon {
  font-size: 0.95rem;
  flex-shrink: 0;
}

.folder-color-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 6px color-mix(in srgb, var(--accent-blue) 40%, transparent);
}

.folder-title,
.folder-path-display {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-row.is-root .folder-title {
  font-weight: 700;
  color: var(--accent-blue);
}

.asset-count-pill {
  font-size: var(--fs-xs);
  font-weight: 700;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  padding: 2px 7px;
  border-radius: 4px;
  border: 1px solid var(--border-medium);
}

.forbidden-pill {
  font-size: var(--fs-xs);
  font-weight: 800;
  color: var(--accent-red);
  background: color-mix(in srgb, var(--accent-red) 15%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
}

.empty-results {
  text-align: center;
  padding: 2.5rem;
  font-size: 0.85rem;
  color: var(--text-muted);
}

/* Destination Target Bar */
.selected-target-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 1.4rem;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-subtle);
}

.target-label {
  font-size: 0.72rem;
  font-weight: 800;
  color: var(--text-muted);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  flex-shrink: 0;
}

.breadcrumb-trail {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  font-size: 0.82rem;
  color: var(--accent-blue);
  font-weight: 700;
}

.crumb-item {
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.12s ease;
}

.crumb-item:hover {
  color: var(--accent-blue);
  text-decoration: underline;
}

.crumb-separator {
  color: var(--text-muted);
  margin: 0 3px;
}

/* Footer */
/* The dialog shell (backdrop, header, body scroll, footer) is BaseModal's. */
.picker-body {
  min-height: 220px;
}

.search-bar-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.search-input-wrapper {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: var(--space-2);
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  padding-left: calc(var(--space-2) * 2 + 14px);
}

.clear-search-btn {
  position: absolute;
  right: var(--space-1);
}
</style>
