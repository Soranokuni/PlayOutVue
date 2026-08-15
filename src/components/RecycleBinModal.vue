<template>
  <div class="recycle-bin-overlay" @click.self="$emit('close')" @keydown.esc="$emit('close')">
    <div class="recycle-bin-modal" role="dialog" aria-modal="true">
      <!-- Modal Header -->
      <div class="modal-header">
        <div class="header-title-group">
          <div class="trash-icon-pill">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </div>
          <div>
            <h2 class="modal-title">Recycle Bin</h2>
            <p class="modal-subtitle">Manage soft-deleted media assets, restore to folders, or permanently purge storage</p>
          </div>
        </div>
        <button class="close-btn" @click="$emit('close')" title="Close (Esc)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

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
                      title="Delete & Purge Mezzanine and DB Row"
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

      <!-- Footer Info -->
      <div class="modal-footer">
        <div class="footer-stats">
          <span>{{ filteredAssets.length }} {{ filteredAssets.length === 1 ? 'item' : 'items' }} in Recycle Bin</span>
        </div>
        <button class="footer-close-btn" @click="$emit('close')">Close</button>
      </div>
    </div>

    <!-- Pulsing Alert Purge Confirmation Dialog -->
    <div v-if="purgeConfirmModal.show" class="purge-dialog-backdrop" @click.self="cancelPurgeModal">
      <div class="purge-dialog-box danger-pulse-box">
        <div class="purge-icon-circle">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        </div>

        <h3 class="purge-dialog-title">{{ purgeConfirmModal.title }}</h3>
        
        <p class="purge-dialog-text">
          {{ purgeConfirmModal.message }}
        </p>

        <div class="purge-warning-callout">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span>This action is destructive and irreversible. Physical mezzanine files, sidecars, and database entries will be completely removed.</span>
        </div>

        <div class="purge-dialog-actions">
          <button class="dialog-cancel-btn" :disabled="isOperating" @click="cancelPurgeModal">
            Cancel
          </button>
          <button class="dialog-danger-btn" :disabled="isOperating" @click="executePurgeConfirmed">
            <span v-if="isOperating">Purging...</span>
            <span v-else>{{ purgeConfirmModal.confirmButtonText }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useMediaLibraryStore, type LibraryAsset } from '../stores/mediaLibrary';

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

async function doRestoreAsset(asset: LibraryAsset) {
  isOperating.value = true;
  try {
    // Check if original virtual folder exists or fallback
    const target = asset.original_virtual_folder || '/';
    await libraryStore.restoreAsset(asset.uuid, target);
  } catch (e) {
    console.error('Failed to restore asset:', e);
  } finally {
    isOperating.value = false;
  }
}

function promptPurgeAsset(asset: LibraryAsset) {
  purgeConfirmModal.value = {
    show: true,
    title: 'Delete & Purge Asset',
    message: `Are you sure you want to permanently purge "${asset.display_name || getFileName(asset.current_path)}"?`,
    confirmButtonText: 'Permanently Purge',
    targetType: 'single_asset',
    targetAsset: asset
  };
}

function promptEmptyBin() {
  purgeConfirmModal.value = {
    show: true,
    title: 'Empty Recycle Bin',
    message: `Are you sure you want to permanently purge all ${libraryStore.recycleBinAssets.length} assets from the Recycle Bin?`,
    confirmButtonText: 'Empty All Now',
    targetType: 'empty_all'
  };
}

function cancelPurgeModal() {
  purgeConfirmModal.value.show = false;
  purgeConfirmModal.value.targetAsset = undefined;
}

async function executePurgeConfirmed() {
  isOperating.value = true;
  try {
    if (purgeConfirmModal.value.targetType === 'single_asset' && purgeConfirmModal.value.targetAsset) {
      await libraryStore.purgeAsset(purgeConfirmModal.value.targetAsset.uuid);
    } else if (purgeConfirmModal.value.targetType === 'empty_all') {
      await libraryStore.emptyRecycleBin();
    }
  } catch (e) {
    console.error('Purge operation failed:', e);
  } finally {
    isOperating.value = false;
    cancelPurgeModal();
  }
}
</script>

<style scoped>
.recycle-bin-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.recycle-bin-modal {
  background: #18191c;
  border: 1px solid #2d3139;
  border-radius: 12px;
  width: 900px;
  max-width: 95vw;
  height: 650px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
  overflow: hidden;
  color: #e2e8f0;
}

.modal-header {
  padding: 16px 20px;
  background: #141518;
  border-bottom: 1px solid #23272e;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-title-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.trash-icon-pill {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(239, 68, 68, 0.25);
}

.modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.3px;
}

.modal-subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  color: #94a3b8;
}

.close-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  transition: all 0.15s ease;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.toolbar {
  padding: 12px 20px;
  background: #18191c;
  border-bottom: 1px solid #23272e;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
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
  color: #64748b;
}

.search-input {
  width: 100%;
  padding: 7px 28px 7px 32px;
  background: #111214;
  border: 1px solid #2d3139;
  border-radius: 6px;
  color: #e2e8f0;
  font-size: 12px;
  outline: none;
}

.search-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.clear-search-btn {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  color: #64748b;
  font-size: 16px;
  cursor: pointer;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.refresh-btn, .empty-bin-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.refresh-btn {
  background: #23272e;
  border: 1px solid #333842;
  color: #cbd5e1;
}

.refresh-btn:hover:not(:disabled) {
  background: #2d3139;
  color: #fff;
}

.empty-bin-btn {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #f87171;
}

.empty-bin-btn:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.25);
  border-color: #ef4444;
  color: #fecaca;
}

.empty-bin-btn:disabled, .refresh-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.bin-content {
  flex: 1;
  overflow: hidden;
  position: relative;
  background: #111214;
}

.empty-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #64748b;
}

.empty-icon {
  margin-bottom: 12px;
  opacity: 0.4;
}

.empty-title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: #94a3b8;
}

.empty-subtitle {
  margin: 0;
  font-size: 12px;
  color: #64748b;
}

.table-container {
  height: 100%;
  overflow-y: auto;
}

.bin-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: left;
}

.bin-table th {
  position: sticky;
  top: 0;
  background: #18191c;
  padding: 10px 14px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #94a3b8;
  border-bottom: 1px solid #23272e;
  z-index: 2;
}

.bin-row {
  border-bottom: 1px solid #1a1c20;
  transition: background 0.12s ease;
}

.bin-row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.bin-table td {
  padding: 10px 14px;
  vertical-align: middle;
}

.asset-title-col {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.asset-name {
  font-weight: 600;
  color: #f1f5f9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 250px;
}

.asset-filename {
  font-size: 11px;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 250px;
  font-family: monospace;
}

.folder-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: #1e2229;
  border: 1px solid #2d3139;
  font-size: 11px;
  color: #94a3b8;
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell-duration, .cell-date {
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}

.actions-group {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.row-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.12s ease;
}

.restore-btn {
  background: #1e293b;
  border: 1px solid #334155;
  color: #38bdf8;
}

.restore-btn:hover:not(:disabled) {
  background: #0284c7;
  border-color: #0284c7;
  color: #fff;
}

.purge-btn {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.purge-btn:hover:not(:disabled) {
  background: #ef4444;
  border-color: #ef4444;
  color: #fff;
}

.modal-footer {
  padding: 12px 20px;
  background: #141518;
  border-top: 1px solid #23272e;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.footer-stats {
  font-size: 12px;
  color: #64748b;
}

.footer-close-btn {
  padding: 6px 16px;
  background: #23272e;
  border: 1px solid #333842;
  border-radius: 6px;
  color: #e2e8f0;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.footer-close-btn:hover {
  background: #2d3139;
  color: #fff;
}

/* Pulsing Danger Confirmation Modal */
.purge-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.danger-pulse-box {
  background: #1c1315;
  border: 2px solid #ef4444;
  border-radius: 12px;
  width: 480px;
  max-width: 90vw;
  padding: 24px;
  box-shadow: 0 0 35px rgba(239, 68, 68, 0.35);
  animation: danger-pulse 2s infinite ease-in-out;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}

@keyframes danger-pulse {
  0% {
    box-shadow: 0 0 20px rgba(239, 68, 68, 0.3);
    border-color: #ef4444;
  }
  50% {
    box-shadow: 0 0 45px rgba(239, 68, 68, 0.7), 0 0 10px rgba(239, 68, 68, 0.5);
    border-color: #f87171;
  }
  100% {
    box-shadow: 0 0 20px rgba(239, 68, 68, 0.3);
    border-color: #ef4444;
  }
}

.purge-icon-circle {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.purge-dialog-title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 700;
  color: #fee2e2;
}

.purge-dialog-text {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  color: #cbd5e1;
}

.purge-warning-callout {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 11px;
  color: #fca5a5;
  text-align: left;
  margin-bottom: 20px;
}

.purge-warning-callout svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.purge-dialog-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  width: 100%;
}

.dialog-cancel-btn {
  flex: 1;
  padding: 9px 16px;
  background: #23272e;
  border: 1px solid #333842;
  border-radius: 6px;
  color: #cbd5e1;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.dialog-cancel-btn:hover:not(:disabled) {
  background: #2d3139;
  color: #fff;
}

.dialog-danger-btn {
  flex: 1;
  padding: 9px 16px;
  background: #dc2626;
  border: 1px solid #b91c1c;
  border-radius: 6px;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s ease;
}

.dialog-danger-btn:hover:not(:disabled) {
  background: #ef4444;
  box-shadow: 0 0 12px rgba(239, 68, 68, 0.5);
}

.spin {
  animation: rotate-spin 1s linear infinite;
}

@keyframes rotate-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: rotate-spin 0.8s linear infinite;
  margin-bottom: 12px;
}
</style>
