<script setup lang="ts">
import { computed, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useRundownStore, type ComplianceRating } from '../stores/rundown';
import { useMediaLibraryStore } from '../stores/mediaLibrary';
import ComplianceModule from './ComplianceModule.vue';
import { getActivePlayoutService } from '../services/playout';
import StatusIndicator from './StatusIndicator.vue';
import { resolveLibraryStatusTone } from '../lib/statusResolver';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{
  isOpen: boolean;
  targetItem?: any;
}>();

const emit = defineEmits(['close']);

const store = useRundownStore();
const mediaLibrary = useMediaLibraryStore();
const settings = useSettingsStore();

const ingestorFetchInFlight = ref(false);
const pushTrimInFlight = ref(false);
const pushRatingInFlight = ref(false);

const activeItem = computed(() => {
    if (props.targetItem) return props.targetItem;
    if (store.selectedItem) return store.selectedItem;
    if (mediaLibrary.selectedAsset) return mediaLibrary.selectedAsset;
    return null;
});

const isRundownItem = computed(() => {
    const item = activeItem.value;
    if (!item) return false;
    return store.activeItems.some(i => i.id === item.id);
});

const warningsList = computed<string[]>(() => {
    const item = activeItem.value;
    if (!item) return [];
    if (Array.isArray(item.warnings) && item.warnings.length > 0) {
        return item.warnings;
    }
    return [];
});

const transcodeInfo = computed(() => {
    const item = activeItem.value;
    if (!item?.playoutvueId && !item?.uuid) return null;
    return {
        uuid: item.playoutvueId || item.uuid,
        sourcePath: item.path || item.current_path || '',
    };
});

const statusLabel = (status: string) => ({
    idle: 'Unresolved',
    processing: 'Processing...',
    ready: 'Ready',
    error: 'Error',
    missing: 'Missing'
}[status] || status || 'Ready');

const statusTone = computed(() => {
    const item = activeItem.value;
    if (!item) return 'idle';
    return resolveLibraryStatusTone(item, settings.qcSensitivity);
});

const fetchFromIngestor = async () => {
    const item = activeItem.value;
    if (!item?.id && !item?.uuid) return;
    ingestorFetchInFlight.value = true;
    try {
        if (isRundownItem.value && item.id) {
            await store.resolveAssetFromApi(item.id);
        } else if (item.uuid && !item.uuid.startsWith('local:')) {
            await invoke('sync_ingestor_asset', { uuid: item.uuid, api_base_url_override: null }).catch(() => {});
        }
    } catch (error) {
        console.error('[Inspector] Ingestor fetch failed', error);
    } finally {
        ingestorFetchInFlight.value = false;
    }
};

const pushTrimToIngestor = async () => {
    const item = activeItem.value;
    const uuid = item?.playoutvueId || item?.uuid;
    if (!uuid) return;

    pushTrimInFlight.value = true;
    try {
        const trimIn = item.trim_in_ms !== undefined ? item.trim_in_ms : (item.inPoint || 0);
        const trimOut = item.trim_out_ms !== undefined ? item.trim_out_ms : (item.outPoint || item.duration_ms || 0);
        await invoke('update_ingestor_trim', {
            uuid,
            trim_in_ms: Math.round(trimIn),
            trim_out_ms: Math.round(trimOut),
            api_base_url_override: null
        });
    } catch (error) {
        console.error('[Inspector] Failed to push trim', error);
    } finally {
        pushTrimInFlight.value = false;
    }
};

const pushRatingToIngestor = async (rating: ComplianceRating) => {
    const item = activeItem.value;
    const uuid = item?.playoutvueId || item?.uuid;
    if (!uuid) return;

    pushRatingInFlight.value = true;
    try {
        await invoke('update_ingestor_rating', {
            uuid,
            rating: rating.toUpperCase(),
            apiBaseUrlOverride: null
        });
    } catch (error) {
        console.error('[Inspector] Failed to push rating', error);
    } finally {
        pushRatingInFlight.value = false;
    }
};

const adjustTrim = async (field: 'seek' | 'length', val: number) => {
    const item = activeItem.value;
    if (!item || item.type === 'gap' || !isRundownItem.value) return;
    const newVal = Math.max(0, (item[field] || 0) + val);
    store.updateItem(item.id, {
        [field]: newVal
    });

    if (field === 'seek' && item.type === 'video') {
        await getActivePlayoutService().seekMedia?.(item.filename, newVal);
    }
};

const getDisplayName = (item: any) => {
    if (!item) return '';
    if (item.display_name) return item.display_name;
    if (item.filename) return item.filename;
    if (item.current_path) {
        const filename = item.current_path.split(/[/\\]/).pop();
        if (filename && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filename)) {
            return filename;
        }
    }
    return 'Untitled Asset';
};
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="modal-backdrop" data-command-scope="modal" @click.self="emit('close')">
      <div class="glass-panel inspector-modal-content">
        <!-- Modal Header -->
        <div class="modal-header">
          <div class="modal-title-row">
            <span class="inspector-badge">INSPECTOR</span>
            <h2 class="modal-title">{{ getDisplayName(activeItem) }}</h2>
          </div>
          <button class="glass-btn btn-icon" @click="emit('close')" title="Close Inspector (Esc)">✕</button>
        </div>

        <!-- Modal Body -->
        <div v-if="activeItem" class="modal-body custom-scroll">
          
          <!-- Warnings Box (if any) -->
          <div v-if="warningsList.length > 0" class="inspector-section warnings-box">
            <div class="warnings-header">
              <span class="warn-icon">⚠️</span>
              <h4 class="warnings-title">QC Validation Advisories ({{ warningsList.length }})</h4>
            </div>
            <ul class="warnings-list">
              <li v-for="(warn, idx) in warningsList" :key="idx">{{ warn }}</li>
            </ul>
          </div>

          <!-- General & File Overview Grid -->
          <div class="inspector-grid">
            <!-- Left Card: Metadata & Paths -->
            <div class="inspector-card">
              <h4 class="card-title">Media Specification</h4>
              <div class="meta-table">
                <div class="meta-row">
                  <span class="meta-label">Status</span>
                  <span class="meta-val">
                    <StatusIndicator :tone="statusTone" variant="dot" />
                    <span style="font-weight:700;">{{ statusLabel(activeItem.status || activeItem.ingestorStatus) }}</span>
                  </span>
                </div>
                <div class="meta-row">
                  <span class="meta-label">Mezzanine Valid</span>
                  <span class="meta-val" :class="activeItem.mezzanine_ok ? 'text-green' : 'text-orange'">
                    {{ activeItem.mezzanine_ok ? '✓ Frame-Accurate Playable' : '⚠ Non-Standard / Pass-Through' }}
                  </span>
                </div>
                <div class="meta-row">
                  <span class="meta-label">Duration</span>
                  <span class="meta-val mono">
                    {{ activeItem.duration_ms ? `${(activeItem.duration_ms / 1000).toFixed(2)}s (${activeItem.duration_ms} ms)` : `${(activeItem.duration || 0).toFixed(2)}s` }}
                  </span>
                </div>
                <div class="meta-row">
                  <span class="meta-label">Trim In / Out</span>
                  <span class="meta-val mono">
                    {{ activeItem.trim_in_ms || activeItem.inPoint || 0 }} ms / {{ activeItem.trim_out_ms || activeItem.outPoint || activeItem.duration_ms || 0 }} ms
                  </span>
                </div>
                <div class="meta-row">
                  <span class="meta-label">FPS Standard</span>
                  <span class="meta-val mono">
                    {{ activeItem.fps_num && activeItem.fps_den ? `${activeItem.fps_num}/${activeItem.fps_den} (${(activeItem.fps_num / activeItem.fps_den).toFixed(2)} fps)` : `${activeItem.fps || 25} fps` }}
                  </span>
                </div>
                <div v-if="activeItem.gop_frames" class="meta-row">
                  <span class="meta-label">GOP Structure</span>
                  <span class="meta-val mono">{{ activeItem.gop_frames }} frames (Closed GOP)</span>
                </div>
                <div v-if="activeItem.total_frames" class="meta-row">
                  <span class="meta-label">Total Frames</span>
                  <span class="meta-val mono">{{ activeItem.total_frames }} frames</span>
                </div>
              </div>
            </div>

            <!-- Right Card: Ingestor API & Identification -->
            <div class="inspector-card">
              <h4 class="card-title">PlayoutTranscode Bridge</h4>
              <div class="meta-table">
                <div class="meta-row">
                  <span class="meta-label">UUID</span>
                  <span class="meta-val mono small">{{ activeItem.playoutvueId || activeItem.uuid || 'Local File (Unregistered)' }}</span>
                </div>
                <div class="meta-row">
                  <span class="meta-label">Target File</span>
                  <span class="meta-val path-val mono small">{{ activeItem.current_path || activeItem.path }}</span>
                </div>
              </div>

              <!-- Sync Actions -->
              <div class="action-buttons-row" style="margin-top: 1rem;">
                <button
                  class="glass-btn"
                  :disabled="ingestorFetchInFlight"
                  @click="fetchFromIngestor"
                  title="Re-fetch verified probe metadata from PlayoutTranscode"
                >
                  {{ ingestorFetchInFlight ? 'Probing...' : '⚡ Re-Probe Ingestor' }}
                </button>
                <button
                  v-if="activeItem.playoutvueId || activeItem.uuid"
                  class="glass-btn"
                  :disabled="pushTrimInFlight"
                  @click="pushTrimToIngestor"
                  title="Save current trim points to Ingestor backend"
                >
                  {{ pushTrimInFlight ? 'Pushing...' : '💾 Push Trim Points' }}
                </button>
              </div>
            </div>
          </div>

          <!-- Non-Destructive Frame Nudging (Rundown video items) -->
          <div v-if="isRundownItem && activeItem.type === 'video'" class="inspector-card">
            <h4 class="card-title">Instant Frame Nudge (AMCP LOADBG)</h4>
            <div class="nudge-grid">
              <div class="nudge-control">
                <label>Seek Offset (Frames)</label>
                <div class="adjuster">
                  <button class="glass-btn" @click="adjustTrim('seek', -10)">-10</button>
                  <button class="glass-btn" @click="adjustTrim('seek', -1)">-1</button>
                  <span class="nudge-display mono">{{ activeItem.seek || 0 }}</span>
                  <button class="glass-btn" @click="adjustTrim('seek', 1)">+1</button>
                  <button class="glass-btn" @click="adjustTrim('seek', 10)">+10</button>
                </div>
              </div>
              <div class="nudge-control">
                <label>Length Limit (Frames)</label>
                <div class="adjuster">
                  <button class="glass-btn" @click="adjustTrim('length', -10)">-10</button>
                  <button class="glass-btn" @click="adjustTrim('length', -1)">-1</button>
                  <span class="nudge-display mono">{{ activeItem.length || 0 }}</span>
                  <button class="glass-btn" @click="adjustTrim('length', 1)">+1</button>
                  <button class="glass-btn" @click="adjustTrim('length', 10)">+10</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Compliance Metadata -->
          <ComplianceModule v-if="isRundownItem && activeItem.type !== 'gap'" />

        </div>

        <div v-else class="modal-body custom-scroll empty-state">
          <p class="text-secondary">No item selected to inspect.</p>
        </div>

        <!-- Modal Footer -->
        <div class="modal-footer">
          <button class="glass-btn" @click="emit('close')">Close</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(10, 14, 23, 0.85);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.inspector-modal-content {
  width: 820px;
  max-width: 95vw;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-primary) 100%);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.85);
  overflow: hidden;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.2rem 1.5rem;
  border-bottom: 1px solid var(--glass-border);
}

.modal-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.inspector-badge {
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  padding: 2px 7px;
  border-radius: 4px;
  background: rgba(56, 189, 248, 0.15);
  color: var(--accent-blue);
  border: 1px solid rgba(56, 189, 248, 0.3);
  flex-shrink: 0;
}

.modal-title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.inspector-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}

.inspector-card {
  background: var(--bg-surface);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  padding: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.card-title {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
  color: var(--text-secondary);
  margin: 0;
}

.meta-table {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.82rem;
  gap: 8px;
}

.meta-label {
  color: var(--text-secondary);
  font-size: 0.78rem;
  flex-shrink: 0;
}

.meta-val {
  color: var(--text-primary);
  text-align: right;
  display: flex;
  align-items: center;
  gap: 6px;
}

.meta-val.mono {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 0.8rem;
}

.meta-val.small {
  font-size: 0.74rem;
}

.path-val {
  word-break: break-all;
  max-width: 260px;
  line-height: 1.3;
}

.text-green { color: #10b981; font-weight: 600; }
.text-orange { color: #f59e0b; font-weight: 600; }

.warnings-box {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 8px;
  padding: 1rem;
}

.warnings-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 0.5rem;
}

.warnings-title {
  font-size: 0.85rem;
  font-weight: 700;
  color: #fbbf24;
  margin: 0;
}

.warnings-list {
  margin: 0;
  padding-left: 1.25rem;
  color: #fde68a;
  font-size: 0.78rem;
  line-height: 1.45;
}

.warnings-list li {
  margin-bottom: 3px;
  word-break: break-all;
}

.action-buttons-row {
  display: flex;
  gap: 8px;
}

.nudge-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.nudge-control {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.nudge-control label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-weight: 600;
}

.adjuster {
  display: flex;
  align-items: center;
  gap: 6px;
}

.nudge-display {
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid var(--glass-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-weight: 700;
  font-size: 0.82rem;
  min-width: 44px;
  text-align: center;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--glass-border);
  background: rgba(0, 0, 0, 0.3);
}

.glass-btn {
  padding: 7px 14px;
  border-radius: 6px;
  background: var(--bg-tertiary);
  border: 1px solid var(--glass-border);
  color: var(--text-primary);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.glass-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.25);
}

.glass-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-icon {
  padding: 4px 8px;
  font-size: 1.1rem;
  background: transparent;
  border-color: transparent;
}
.btn-icon:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

@media (max-width: 768px) {
  .inspector-grid {
    grid-template-columns: 1fr;
  }
}
</style>
