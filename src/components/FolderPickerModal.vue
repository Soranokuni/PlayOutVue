<script setup lang="ts">
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

// Flatten tree for search filtering if user typed a search query
interface FlatFolderItem {
  path: string;
  name: string;
  depth: number;
  color?: string;
  allAssetCount: number;
  directCount: number;
  node: VirtualFolderNode;
}

const flattenTree = (node: VirtualFolderNode, list: FlatFolderItem[] = []): FlatFolderItem[] => {
  list.push({
    path: node.path,
    name: node.name,
    depth: node.depth,
    color: node.color,
    allAssetCount: node.allAssetCount,
    directCount: node.directAssets.length,
    node,
  });
  for (const child of node.children) {
    flattenTree(child, list);
  }
  return list;
};

const flatFolders = computed(() => flattenTree(folderTree.value));

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
  <Teleport to="body">
    <div v-if="isOpen" class="modal-backdrop" data-command-scope="modal" @click.self="$emit('close')">
      <div class="glass-panel folder-picker-modal">
        <!-- Modal Header -->
        <div class="modal-header">
          <div class="header-left">
            <span class="header-badge">VIRTUAL FOLDER SYSTEM</span>
            <h2 class="text-accent">{{ title }}</h2>
          </div>
          <button class="glass-btn btn-icon" @click="$emit('close')" title="Close">✕</button>
        </div>

        <!-- Search & Filter Bar -->
        <div class="search-bar-row">
          <div class="search-input-wrapper">
            <span class="search-icon">🔍</span>
            <input
              v-model="searchQuery"
              type="text"
              class="glass-input search-input"
              placeholder="Search destination folders..."
              autofocus
            />
            <button v-if="searchQuery" class="clear-search-btn" @click="searchQuery = ''">✕</button>
          </div>
          <button class="glass-btn btn-new-folder" @click="startCreateSubfolder" title="Create a new subfolder in selected destination">
            📁+ New Folder
          </button>
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
              class="glass-input"
              placeholder="Subfolder name (e.g. Season 1)"
              @keydown.enter="commitCreateSubfolder"
              @keydown.esc="cancelCreateSubfolder"
            />
            <button class="glass-btn btn-primary" @click="commitCreateSubfolder" :disabled="!newSubfolderName.trim()">
              Create
            </button>
            <button class="glass-btn" @click="cancelCreateSubfolder">Cancel</button>
          </div>
        </div>

        <!-- Body: Tree or Filtered List -->
        <div class="modal-body custom-scroll">
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
              <span class="folder-color-dot" :style="{ background: item.color || '#38bdf8' }"></span>
              <span class="folder-path-display">{{ item.path }}</span>
              <span class="asset-count-pill">{{ item.allAssetCount }} items</span>
              <span v-if="isForbidden(item.path)" class="forbidden-pill">Source / Forbidden</span>
            </div>
          </div>

          <!-- Recursive Tree (Normal Navigation) -->
          <div v-else class="tree-container">
            <!-- Root Folder Item -->
            <div
              class="folder-row"
              :class="{
                'is-selected': selectedFolder === '/',
                'is-disabled': isForbidden('/'),
              }"
              @click="selectFolder('/')"
              @dblclick="selectFolder('/'); confirmMove();"
            >
              <span
                class="chevron"
                :class="{ 'is-expanded': expandedFolders['/'] }"
                @click.stop="toggleExpand('/')"
              >
                ▶
              </span>
              <span class="folder-icon">📂</span>
              <span class="folder-title">All Media (Root /)</span>
              <span class="asset-count-pill">{{ folderTree.allAssetCount }} items</span>
              <span v-if="isForbidden('/')" class="forbidden-pill">Source / Forbidden</span>
            </div>

            <!-- Recursive Subfolders Container -->
            <div v-show="expandedFolders['/']" class="subfolders-wrapper">
              <template v-for="child in folderTree.children" :key="child.path">
                <!-- Recursive Tree Node Component (Nested View) -->
                <div class="folder-tree-branch">
                  <div
                    class="folder-row"
                    :class="{
                      'is-selected': selectedFolder === child.path,
                      'is-disabled': isForbidden(child.path),
                    }"
                    :style="{ paddingLeft: `${child.depth * 18}px` }"
                    @click="selectFolder(child.path)"
                    @dblclick="selectFolder(child.path); confirmMove();"
                  >
                    <span
                      v-if="child.children.length > 0"
                      class="chevron"
                      :class="{ 'is-expanded': expandedFolders[child.path] }"
                      @click.stop="toggleExpand(child.path)"
                    >
                      ▶
                    </span>
                    <span v-else class="chevron-spacer"></span>

                    <span class="folder-color-dot" :style="{ background: child.color || '#38bdf8' }"></span>
                    <span class="folder-title">{{ child.name }}</span>
                    <span class="asset-count-pill">{{ child.allAssetCount }}</span>
                    <span v-if="isForbidden(child.path)" class="forbidden-pill">Source / Forbidden</span>
                  </div>

                  <!-- Render Level 2+ Subfolders Recursively -->
                  <div v-show="expandedFolders[child.path] && child.children.length > 0" class="nested-children">
                    <template v-for="sub in child.children" :key="sub.path">
                      <div class="folder-tree-branch">
                        <div
                          class="folder-row"
                          :class="{
                            'is-selected': selectedFolder === sub.path,
                            'is-disabled': isForbidden(sub.path),
                          }"
                          :style="{ paddingLeft: `${sub.depth * 18}px` }"
                          @click="selectFolder(sub.path)"
                          @dblclick="selectFolder(sub.path); confirmMove();"
                        >
                          <span
                            v-if="sub.children.length > 0"
                            class="chevron"
                            :class="{ 'is-expanded': expandedFolders[sub.path] }"
                            @click.stop="toggleExpand(sub.path)"
                          >
                            ▶
                          </span>
                          <span v-else class="chevron-spacer"></span>

                          <span class="folder-color-dot" :style="{ background: sub.color || '#38bdf8' }"></span>
                          <span class="folder-title">{{ sub.name }}</span>
                          <span class="asset-count-pill">{{ sub.allAssetCount }}</span>
                          <span v-if="isForbidden(sub.path)" class="forbidden-pill">Forbidden</span>
                        </div>

                        <!-- Level 3 Children -->
                        <div v-show="expandedFolders[sub.path] && sub.children.length > 0">
                          <div
                            v-for="sub3 in sub.children"
                            :key="sub3.path"
                            class="folder-row"
                            :class="{
                              'is-selected': selectedFolder === sub3.path,
                              'is-disabled': isForbidden(sub3.path),
                            }"
                            :style="{ paddingLeft: `${sub3.depth * 18}px` }"
                            @click="selectFolder(sub3.path)"
                            @dblclick="selectFolder(sub3.path); confirmMove();"
                          >
                            <span class="chevron-spacer"></span>
                            <span class="folder-color-dot" :style="{ background: sub3.color || '#38bdf8' }"></span>
                            <span class="folder-title">{{ sub3.name }}</span>
                            <span class="asset-count-pill">{{ sub3.allAssetCount }}</span>
                          </div>
                        </div>
                      </div>
                    </template>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- Selected Breadcrumb Trail & Target Bar -->
        <div class="selected-target-bar">
          <span class="target-label">DESTINATION:</span>
          <div class="breadcrumb-trail">
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

        <!-- Footer -->
        <div class="modal-footer">
          <button class="glass-btn" @click="$emit('close')">Cancel</button>
          <div class="footer-spacer"></div>
          <button
            class="glass-btn btn-primary"
            :disabled="!canConfirm"
            @click="confirmMove"
          >
            ✔ Move Here
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(8, 12, 20, 0.88);
  backdrop-filter: blur(12px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10000;
}

.folder-picker-modal {
  width: 640px;
  max-width: 94vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #141a26 0%, #0d121c 100%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.85);
  overflow: hidden;
}

.modal-header {
  padding: 1.1rem 1.4rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.header-badge {
  font-size: 0.62rem;
  font-weight: 800;
  color: #38bdf8;
  letter-spacing: 0.08em;
}

.modal-header h2 {
  margin: 0;
  font-size: 1.05rem;
  color: #f1f5f9;
}

/* Search Bar */
.search-bar-row {
  display: flex;
  gap: 10px;
  padding: 10px 1.4rem;
  background: rgba(0, 0, 0, 0.25);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
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
  font-size: 0.8rem;
  color: #94a3b8;
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
  color: #94a3b8;
  cursor: pointer;
  font-size: 0.75rem;
}

.clear-search-btn:hover {
  color: #fff;
}

.btn-new-folder {
  white-space: nowrap;
  font-size: 0.76rem;
  font-weight: 700;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.1);
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.btn-new-folder:hover {
  background: rgba(56, 189, 248, 0.2);
}

/* Inline Create Box */
.inline-create-box {
  background: rgba(56, 189, 248, 0.08);
  border-bottom: 1px solid rgba(56, 189, 248, 0.25);
  padding: 10px 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.create-prompt {
  font-size: 0.75rem;
  color: #cbd5e1;
}

.create-prompt code {
  color: #38bdf8;
  font-weight: 700;
}

.create-input-row {
  display: flex;
  gap: 8px;
}

.create-input-row .glass-input {
  flex: 1;
}

/* Body */
.modal-body {
  padding: 8px 12px;
  overflow-y: auto;
  min-height: 240px;
  max-height: 380px;
}

.folder-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s;
  user-select: none;
}

.folder-row:hover:not(.is-disabled) {
  background: rgba(255, 255, 255, 0.06);
}

.folder-row.is-selected {
  background: rgba(56, 189, 248, 0.18);
  border: 1px solid rgba(56, 189, 248, 0.4);
}

.folder-row.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.chevron {
  font-size: 0.65rem;
  color: #94a3b8;
  width: 14px;
  text-align: center;
  transition: transform 0.15s;
  cursor: pointer;
}

.chevron.is-expanded {
  transform: rotate(90deg);
}

.chevron-spacer {
  width: 14px;
}

.folder-icon {
  font-size: 0.95rem;
}

.folder-color-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.folder-title,
.folder-path-display {
  font-size: 0.8rem;
  font-weight: 600;
  color: #f1f5f9;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-count-pill {
  font-size: 0.65rem;
  font-weight: 700;
  color: #94a3b8;
  background: rgba(0, 0, 0, 0.35);
  padding: 2px 6px;
  border-radius: 4px;
}

.forbidden-pill {
  font-size: 0.62rem;
  font-weight: 800;
  color: #f87171;
  background: rgba(239, 68, 68, 0.15);
  padding: 2px 6px;
  border-radius: 4px;
}

.empty-results {
  text-align: center;
  padding: 2rem;
  font-size: 0.82rem;
  color: #64748b;
}

/* Destination Target Bar */
.selected-target-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 1.4rem;
  background: rgba(0, 0, 0, 0.35);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.target-label {
  font-size: 0.68rem;
  font-weight: 800;
  color: #94a3b8;
  letter-spacing: 0.05em;
}

.breadcrumb-trail {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  font-size: 0.78rem;
  color: #38bdf8;
  font-weight: 700;
}

.crumb-item {
  cursor: pointer;
  white-space: nowrap;
}

.crumb-item:hover {
  text-decoration: underline;
}

.crumb-separator {
  color: #64748b;
  margin: 0 2px;
}

/* Footer */
.modal-footer {
  padding: 10px 1.4rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.3);
}

.footer-spacer {
  flex: 1;
}

.glass-input {
  background: #0b0f17;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f1f5f9;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 0.8rem;
  outline: none;
}

.glass-input:focus {
  border-color: #38bdf8;
}

.glass-btn {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #cbd5e1;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.glass-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.glass-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-primary {
  background: rgba(56, 189, 248, 0.15);
  border-color: rgba(56, 189, 248, 0.4);
  color: #38bdf8;
  font-weight: 700;
}

.btn-primary:hover:not(:disabled) {
  background: rgba(56, 189, 248, 0.25);
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.2);
}

.btn-icon {
  padding: 3px 8px;
  font-size: 1rem;
}
</style>
