<template>
  <BaseModal
    :open="true"
    size="xl"
    title="Recycle Bin"
    subtitle="Restore deleted media to a folder, or delete it permanently from storage."
    @close="$emit('close')"
  >

      <!-- Action & Filter Bar -->
      <div class="toolbar">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Filter trashed assets..."
            class="search-input"
          />
          <button v-if="searchQuery" class="clear-search-btn" @click="searchQuery = ''">×</button>
        </div>

        <div class="toolbar-actions">
          <button class="refresh-btn" :disabled="libraryStore.isRecycleBinLoading" @click="refreshBin" title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ 'spin': libraryStore.isRecycleBinLoading }">
              <path d="M23 4v6h-6"></path>
              <path d="M1 20v-6h6"></path>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
            <span>Refresh</span>
          </button>

          <button
            class="empty-bin-btn"
            :disabled="filteredAssets.length === 0 || isOperating"
            @click="promptEmptyBin"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            <span>Empty Recycle Bin</span>
          </button>
        </div>
      </div>

      <!-- Content Area -->
      <div class="bin-content">
        <div v-if="libraryStore.isRecycleBinLoading && filteredAssets.length === 0" class="empty-state">
          <div class="spinner"></div>
          <p>Loading Recycle Bin...</p>
        </div>

        <div v-else-if="filteredAssets.length === 0" class="empty-state">
          <div class="empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </div>
          <p class="empty-title">Recycle Bin is Empty</p>
          <p class="empty-subtitle">Deleted items will appear here before being permanently purged.</p>
        </div>

        <div v-else class="table-container">
          <table class="bin-table">
            <thead>
              <tr>
                <th style="width: 32%;">Asset Name</th>
                <th style="width: 24%;">Original Folder</th>
                <th style="width: 14%;">Duration</th>
                <th style="width: 16%;">Deleted At</th>
                <th style="width: 14%; text-align: right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="asset in filteredAssets" :key="asset.uuid" class="bin-row">
                <td class="cell-name">
                  <div class="asset-title-col">
                    <span class="asset-name" :title="asset.display_name">{{ asset.display_name }}</span>
                    <span class="asset-filename" :title="asset.current_path">{{ getFileName(asset.current_path) }}</span>
                  </div>
                </td>
                <td class="cell-folder">
                  <span class="folder-badge" :title="asset.original_virtual_folder || '/'">
                    {{ asset.original_virtual_folder || '/' }}
                  </span>
                </td>
                <td class="cell-duration">
                  {{ formatDuration(asset.duration_ms) }}
                </td>
                <td class="cell-date">
                  {{ formatDeletedAt(asset.deleted_at) }}
                </td>
                <td class="cell-actions">
                  <div class="actions-group">
                    <button
                      class="row-action-btn restore-btn"
                      :disabled="isOperating"
                      @click="doRestoreAsset(asset)"
                      title="Restore Asset"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="1 4 1 10 7 10"></polyline>
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                      </svg>
                      <span>Restore</span>
                    </button>
                    <button
                      class="row-action-btn purge-btn"
                      :disabled="isOperating"
                      @click="promptPurgeAsset(asset)"
                      title="Delete permanently"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                      <span>Purge</span>
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    <template #footer>
      <ModalFooterActions>
        <template #destructive>
          <span class="footer-stats">
            {{ filteredAssets.length }} {{ filteredAssets.length === 1 ? 'item' : 'items' }} in the Recycle Bin
          </span>
        </template>
        <template #primary>
          <BaseButton variant="secondary" @click="$emit('close')">Close</BaseButton>
        </template>
      </ModalFooterActions>
    </template>

  </BaseModal>

  <!-- UI F-11: the shared irreversible-action dialog. MediaLibrary carried a
       second copy of this "pulsing danger box"; both now use DangerConfirm. -->
  <DangerConfirm
    :open="purgeConfirmModal.show"
    :title="purgeConfirmModal.title"
    :message="purgeConfirmModal.message"
    warning="The mezzanine files, sidecars and database entries are removed from storage. This cannot be undone."
    :confirm-label="purgeConfirmModal.confirmButtonText"
    :busy="isOperating"
    @confirm="executePurgeConfirmed"
    @cancel="cancelPurgeModal"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import BaseModal from './ui/BaseModal.vue';
import BaseButton from './ui/BaseButton.vue';
import ModalFooterActions from './ui/ModalFooterActions.vue';
import DangerConfirm from './ui/DangerConfirm.vue';
import { message } from '@tauri-apps/plugin-dialog';
import { useMediaLibraryStore, type LibraryAsset } from '../stores/mediaLibrary';
import { describePurgeOutcome } from '../lib/ingestorFeedback';
import { describeErrorMessage } from '../lib/describeError';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const libraryStore = useMediaLibraryStore();
const searchQuery = ref('');
const isOperating = ref(false);

const purgeConfirmModal = ref<{
  show: boolean;
  title: string;
  message: string;
  confirmButtonText: string;
  targetType: 'single_asset' | 'empty_all';
  targetAsset?: LibraryAsset;
}>({
  show: false,
  title: '',
  message: '',
  confirmButtonText: '',
  targetType: 'single_asset'
});

onMounted(async () => {
  await libraryStore.fetchRecycleBin();
});

const filteredAssets = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return libraryStore.recycleBinAssets;
  return libraryStore.recycleBinAssets.filter((a) => {
    const nameMatch = (a.display_name || '').toLowerCase().includes(query);
    const pathMatch = (a.current_path || '').toLowerCase().includes(query);
    const folderMatch = (a.original_virtual_folder || '').toLowerCase().includes(query);
    return nameMatch || pathMatch || folderMatch;
  });
});

async function refreshBin() {
  await libraryStore.fetchRecycleBin();
}

function getFileName(filePath?: string): string {
  if (!filePath) return 'unknown';
  return filePath.split(/[/\\]/).pop() || filePath;
}

function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) return '00:00:00';
  const totalSecs = Math.floor(durationMs / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatDeletedAt(isoString?: string): string {
  if (!isoString) return 'Unknown';
  try {
    const d = new Date(isoString);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return isoString;
  }
}

// Native dialogs are unavailable under unit tests; never let a failed
// notification mask the operation's own outcome.
async function notify(text: string, title: string, kind: 'info' | 'warning' | 'error') {
  try {
    await message(text, { title, kind });
  } catch {
    console.warn(`[RecycleBin] ${title}: ${text}`);
  }
}

async function doRestoreAsset(asset: LibraryAsset) {
  isOperating.value = true;
  try {
    // Check if original virtual folder exists or fallback
    const target = asset.original_virtual_folder || '/';
    await libraryStore.restoreAsset(asset.uuid, target);
  } catch (e) {
    console.error('Failed to restore asset:', e);
    await notify(describeErrorMessage(e, `Could not restore "${asset.display_name || getFileName(asset.current_path)}".`), 'Restore Error', 'error');
  } finally {
    isOperating.value = false;
  }
}

function promptPurgeAsset(asset: LibraryAsset) {
  purgeConfirmModal.value = {
    show: true,
    title: 'Delete permanently',
    message: `Are you sure you want to permanently purge "${asset.display_name || getFileName(asset.current_path)}"?`,
    confirmButtonText: 'Delete permanently',
    targetType: 'single_asset',
    targetAsset: asset
  };
}

function promptEmptyBin() {
  purgeConfirmModal.value = {
    show: true,
    title: 'Empty Recycle Bin',
    message: `Are you sure you want to permanently purge all ${libraryStore.recycleBinAssets.length} assets from the Recycle Bin?`,
    confirmButtonText: 'Empty the bin',
    targetType: 'empty_all'
  };
}

function cancelPurgeModal() {
  purgeConfirmModal.value.show = false;
  purgeConfirmModal.value.targetAsset = undefined;
}

async function executePurgeConfirmed() {
  isOperating.value = true;
  const target = purgeConfirmModal.value.targetAsset;
  const subject = target ? (target.display_name || getFileName(target.current_path)) : 'the Recycle Bin';
  try {
    let note: string | null = null;
    if (purgeConfirmModal.value.targetType === 'single_asset' && target) {
      note = describePurgeOutcome(await libraryStore.purgeAsset(target.uuid), subject);
    } else if (purgeConfirmModal.value.targetType === 'empty_all') {
      note = describePurgeOutcome(await libraryStore.emptyRecycleBin(), subject);
    }
    if (note) {
      await notify(note, 'Purge completed with warnings', 'warning');
    }
  } catch (e) {
    console.error('Purge operation failed:', e);
    await notify(describeErrorMessage(e, `Could not permanently delete ${subject}.`), 'Purge Error', 'error');
  } finally {
    isOperating.value = false;
    cancelPurgeModal();
  }
}
</script>

<style scoped>
.toolbar {
  padding: var(--space-3) var(--space-5);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  max-width: 340px;
}

.search-box svg {
  position: absolute;
  left: 10px;
  color: var(--text-muted);
}

.search-input {
  width: 100%;
  padding: var(--space-2) var(--space-8);
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-md);
  outline: none;
}

.search-input:focus {
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-blue) 25%, transparent);
}

.clear-search-btn {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: var(--fs-lg);
  cursor: pointer;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.refresh-btn, .empty-bin-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.refresh-btn {
  background: var(--bg-hover);
  border: 1px solid var(--border-medium);
  color: var(--text-primary);
}

.refresh-btn:hover:not(:disabled) {
  background: var(--bg-surface-elevated);
  border-color: var(--border-strong);
}

.empty-bin-btn {
  background: color-mix(in srgb, var(--accent-red) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-red) 35%, transparent);
  color: var(--accent-red);
}

.empty-bin-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-red) 25%, transparent);
  border-color: var(--accent-red);
}

.empty-bin-btn:disabled, .refresh-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.bin-content {
  flex: 1;
  overflow: hidden;
  position: relative;
  background: var(--bg-primary);
}

.empty-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.empty-icon {
  margin-bottom: var(--space-3);
  opacity: 0.5;
}

.empty-title {
  margin: 0 0 var(--space-1);
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  color: var(--text-secondary);
}

.empty-subtitle {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.table-container {
  height: 100%;
  overflow-y: auto;
}

.bin-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-md);
  text-align: left;
}

.bin-table th {
  position: sticky;
  top: 0;
  background: var(--bg-tertiary);
  padding: var(--space-3) var(--space-4);
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
  z-index: 2;
}

.bin-row {
  border-bottom: 1px solid var(--border-subtle);
  transition: background var(--dur-fast) var(--ease-out);
}

.bin-row:hover {
  background: var(--bg-hover);
}

.bin-table td {
  padding: var(--space-3) var(--space-4);
  vertical-align: middle;
}

.asset-title-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-0);
}

.asset-name {
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 250px;
}

.asset-filename {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 250px;
  font-family: var(--font-mono);
}

.folder-badge {
  display: inline-block;
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-medium);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--text-secondary);
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell-duration, .cell-date {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}

.actions-group {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.row-action-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.restore-btn {
  background: var(--bg-hover);
  border: 1px solid var(--border-medium);
  color: var(--accent-blue);
}

.restore-btn:hover:not(:disabled) {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: var(--text-on-accent);
}

.purge-btn {
  background: color-mix(in srgb, var(--accent-red) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-red) 30%, transparent);
  color: var(--accent-red);
}

.purge-btn:hover:not(:disabled) {
  background: var(--accent-red);
  border-color: var(--accent-red);
  color: var(--text-on-accent);
}

.footer-stats {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

/* Pulsing Danger Confirmation Modal */
.spin {
  animation: spin var(--dur-spin) linear infinite;
}

.spinner {
  width: var(--space-6);
  height: var(--space-6);
  border: var(--border-accent-w) solid var(--border-subtle);
  border-top-color: var(--accent-blue);
  border-radius: 50%;
  animation: spin var(--dur-spin) linear infinite;
  margin-bottom: var(--space-3);
}
/* The dialog shell and the purge confirmation are BaseModal's / DangerConfirm's. */
.footer-stats {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
</style>
