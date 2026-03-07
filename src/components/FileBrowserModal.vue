<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';

interface FilesystemEntry {
  name: string;
  path: string;
  entry_type: 'file' | 'folder';
}

interface FilesystemListing {
  current_path: string;
  parent_path?: string | null;
  entries: FilesystemEntry[];
}

const props = withDefaults(defineProps<{
  isOpen: boolean;
  title: string;
  mode: 'directory' | 'open-file' | 'save-file';
  startPath?: string;
  extensions?: string[];
  defaultFileName?: string;
  description?: string;
}>(), {
  startPath: '',
  extensions: () => [],
  defaultFileName: '',
  description: ''
});

const emit = defineEmits<{
  close: [];
  select: [path: string];
}>();

const roots = ref<string[]>([]);
const currentPath = ref('');
const parentPath = ref<string | null>(null);
const entries = ref<FilesystemEntry[]>([]);
const selectedEntry = ref<FilesystemEntry | null>(null);
const fileName = ref('');
const isLoading = ref(false);
const errorMessage = ref('');

const showFiles = computed(() => props.mode !== 'directory');
const canConfirm = computed(() => {
  if (props.mode === 'directory') return !!currentPath.value;
  if (props.mode === 'open-file') return selectedEntry.value?.entry_type === 'file';
  return !!currentPath.value && !!fileName.value.trim();
});

const normalizeJoin = (base: string, child: string) => {
  if (!base) return child;
  const separator = base.endsWith('\\') || base.endsWith('/') ? '' : '/';
  return `${base}${separator}${child}`;
};

const ensureExtension = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || props.mode !== 'save-file' || props.extensions.length !== 1) return trimmed;
  const ext = (props.extensions[0] || '').replace(/^\./, '');
  return trimmed.toLowerCase().endsWith(`.${ext}`) ? trimmed : `${trimmed}.${ext}`;
};

const loadRoots = async () => {
  roots.value = await invoke<string[]>('list_filesystem_roots');
};

const openDirectory = async (path: string) => {
  isLoading.value = true;
  errorMessage.value = '';
  selectedEntry.value = null;
  try {
    const listing = await invoke<FilesystemListing>('browse_filesystem', {
      path,
      showFiles: showFiles.value,
      allowedExtensions: props.extensions.length ? props.extensions : null
    });
    currentPath.value = listing.current_path;
    parentPath.value = listing.parent_path || null;
    entries.value = listing.entries;
  } catch (error) {
    errorMessage.value = String(error);
  } finally {
    isLoading.value = false;
  }
};

const initializeBrowser = async () => {
  if (!props.isOpen) return;
  fileName.value = props.defaultFileName;
  selectedEntry.value = null;
  await loadRoots();
  const rawInitialPath = props.startPath || roots.value[0] || '';
  if (rawInitialPath) {
    const looksLikeFile = showFiles.value && !!rawInitialPath.split(/[\\/]/).pop()?.includes('.');
    const initialPath = looksLikeFile ? rawInitialPath.replace(/[\\/][^\\/]+$/, '') : rawInitialPath;
    if (props.mode === 'save-file' && looksLikeFile) {
      fileName.value = rawInitialPath.split(/[\\/]/).pop() || props.defaultFileName;
    }
    await openDirectory(initialPath || roots.value[0] || rawInitialPath);
  }
};

const selectEntry = (entry: FilesystemEntry) => {
  selectedEntry.value = entry;
  if (props.mode === 'save-file' && entry.entry_type === 'file') {
    fileName.value = entry.name;
  }
};

const activateEntry = async (entry: FilesystemEntry) => {
  if (entry.entry_type === 'folder') {
    await openDirectory(entry.path);
    return;
  }

  if (props.mode === 'open-file') {
    emit('select', entry.path);
  }
};

const confirmSelection = () => {
  if (!canConfirm.value) return;

  if (props.mode === 'directory') {
    emit('select', currentPath.value);
    return;
  }

  if (props.mode === 'open-file') {
    if (selectedEntry.value?.entry_type === 'file') emit('select', selectedEntry.value.path);
    return;
  }

  emit('select', normalizeJoin(currentPath.value, ensureExtension(fileName.value)));
};

watch(() => props.isOpen, (open) => {
  if (open) initializeBrowser();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="modal-backdrop" @click.self="emit('close')">
      <div class="glass-panel browser-modal">
        <div class="browser-header">
          <div>
            <h2 class="text-accent">{{ title }}</h2>
            <p v-if="description" class="browser-description">{{ description }}</p>
          </div>
          <button class="icon-btn" @click="emit('close')">✕</button>
        </div>

        <div class="browser-shell">
          <aside class="browser-sidebar">
            <div class="sidebar-title">Drives</div>
            <button
              v-for="root in roots"
              :key="root"
              class="sidebar-item"
              :class="{ active: currentPath.startsWith(root) }"
              @click="openDirectory(root)"
            >
              {{ root }}
            </button>
          </aside>

          <section class="browser-main">
            <div class="browser-toolbar">
              <button class="toolbar-btn" :disabled="!parentPath" @click="parentPath && openDirectory(parentPath)">⬆ Up</button>
              <div class="path-pill" :title="currentPath">{{ currentPath || 'Select a drive' }}</div>
              <button class="toolbar-btn" @click="currentPath && openDirectory(currentPath)">↻ Refresh</button>
            </div>

            <div class="browser-list">
              <div v-if="isLoading" class="browser-empty">Loading…</div>
              <div v-else-if="errorMessage" class="browser-empty is-error">{{ errorMessage }}</div>
              <div v-else-if="entries.length === 0" class="browser-empty">This folder is empty.</div>
              <button
                v-for="entry in entries"
                :key="entry.path"
                class="browser-entry"
                :class="{ selected: selectedEntry?.path === entry.path }"
                @click="selectEntry(entry)"
                @dblclick="activateEntry(entry)"
              >
                <span class="entry-icon">{{ entry.entry_type === 'folder' ? '📁' : '📄' }}</span>
                <span class="entry-name">{{ entry.name }}</span>
                <span class="entry-kind">{{ entry.entry_type === 'folder' ? 'Folder' : 'File' }}</span>
              </button>
            </div>

            <div v-if="mode === 'save-file'" class="save-row">
              <label class="save-label">File name</label>
              <input v-model="fileName" class="glass-input" placeholder="playlist.playout" @keydown.enter.prevent="confirmSelection">
            </div>
          </section>
        </div>

        <div class="browser-footer">
          <div class="footer-hint">
            Double-click folders to open. {{ mode === 'directory' ? 'The current folder will be selected.' : mode === 'open-file' ? 'Select a file to continue.' : 'Choose a folder and enter a file name.' }}
          </div>
          <div class="footer-actions">
            <button class="toolbar-btn" @click="emit('close')">Cancel</button>
            <button class="toolbar-btn btn-primary" :disabled="!canConfirm" @click="confirmSelection">
              {{ mode === 'directory' ? 'Use Folder' : mode === 'open-file' ? 'Open' : 'Save Here' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(8px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10050;
}

.browser-modal {
  width: min(980px, 94vw);
  min-height: min(680px, 88vh);
  display: flex;
  flex-direction: column;
  padding: 0;
  background: var(--bg-secondary);
  overflow: hidden;
}

.browser-header,
.browser-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--glass-border);
}

.browser-footer {
  border-top: 1px solid var(--glass-border);
  border-bottom: none;
}

.browser-header h2 {
  margin: 0;
  font-size: 1.05rem;
}

.browser-description,
.footer-hint {
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.browser-shell {
  flex: 1;
  display: grid;
  grid-template-columns: 160px 1fr;
  min-height: 0;
}

.browser-sidebar {
  border-right: 1px solid var(--glass-border);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(0, 0, 0, 0.18);
}

.sidebar-title {
  font-size: 0.72rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.sidebar-item,
.toolbar-btn,
.browser-entry,
.icon-btn {
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.sidebar-item,
.toolbar-btn {
  padding: 8px 10px;
  text-align: left;
}

.sidebar-item.active,
.sidebar-item:hover,
.toolbar-btn:hover,
.browser-entry:hover,
.icon-btn:hover {
  background: rgba(51, 190, 204, 0.12);
  border-color: rgba(51, 190, 204, 0.28);
}

.browser-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.browser-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.path-pill {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.browser-list {
  flex: 1;
  overflow: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.browser-entry {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 60px;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  text-align: left;
}

.browser-entry.selected {
  background: rgba(51, 190, 204, 0.16);
  border-color: rgba(51, 190, 204, 0.35);
}

.entry-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.entry-kind {
  font-size: 0.7rem;
  color: var(--text-secondary);
  text-align: right;
}

.browser-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  color: var(--text-secondary);
  border: 1px dashed var(--glass-border);
  border-radius: 10px;
}

.browser-empty.is-error {
  color: #fca5a5;
}

.save-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.save-label {
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.glass-input {
  background: rgba(0, 0, 0, 0.38);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text-primary);
  padding: 10px 12px;
}

.footer-actions {
  display: flex;
  gap: 10px;
}

.btn-primary {
  background: rgba(51, 190, 204, 0.16);
  border-color: rgba(51, 190, 204, 0.35);
}

.icon-btn {
  width: 34px;
  height: 34px;
}

@media (max-width: 860px) {
  .browser-shell {
    grid-template-columns: 1fr;
  }

  .browser-sidebar {
    border-right: none;
    border-bottom: 1px solid var(--glass-border);
    flex-direction: row;
    flex-wrap: wrap;
  }
}
</style>
