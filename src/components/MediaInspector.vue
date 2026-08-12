<script setup lang="ts">
import { computed, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useRundownStore, type ComplianceRating } from '../stores/rundown';
import { useMediaLibraryStore } from '../stores/mediaLibrary';
import ComplianceModule from './ComplianceModule.vue';
import { getActivePlayoutService } from '../services/playout';

const store = useRundownStore();
const mediaLibrary = useMediaLibraryStore();
const ingestorFetchInFlight = ref(false);
const pushTrimInFlight = ref(false);
const pushRatingInFlight = ref(false);

const activeAsset = computed(() => mediaLibrary.selectedAsset);

const warningsList = computed(() => {
    if (store.selectedItem?.warnings && store.selectedItem.warnings.length > 0) {
        return store.selectedItem.warnings;
    }
    if (!store.selectedItem && activeAsset.value?.warnings && activeAsset.value.warnings.length > 0) {
        return activeAsset.value.warnings;
    }
    return [];
});

const transcodeInfo = computed(() => {
    const item = store.selectedItem;
    if (!item?.playoutvueId) return null;
    return {
        uuid: item.playoutvueId,
        sourcePath: item.path,
    };
});

const statusLabel = (status: string) => ({
    idle: 'Unresolved',
    processing: 'Processing...',
    ready: 'Ready',
    error: 'Error',
    missing: 'Missing'
}[status] || status);

const statusColor = (status: string) => ({
    idle: '#555',
    processing: '#f8b400',
    ready: '#4caf50',
    error: '#e63946',
    missing: '#888'
}[status] || '#aaa');

const hasIngestorUuid = computed(() => !!(store.selectedItem?.playoutvueId));

const fetchFromIngestor = async () => {
    if (!store.selectedItem?.id || !store.selectedItem?.playoutvueId) return;
    ingestorFetchInFlight.value = true;
    try {
        await store.resolveAssetFromApi(store.selectedItem.id);
    } catch (error) {
        console.error('[Inspector] Ingestor fetch failed', error);
    } finally {
        ingestorFetchInFlight.value = false;
    }
};

const pushTrimToIngestor = async () => {
    const item = store.selectedItem;
    if (!item?.playoutvueId) return;

    pushTrimInFlight.value = true;
    try {
        const trimIn = item.trim_in_ms !== undefined ? item.trim_in_ms : item.inPoint;
        const trimOut = item.trim_out_ms !== undefined ? item.trim_out_ms : (item.outPoint || 0);
        await invoke('update_ingestor_trim', {
            uuid: item.playoutvueId,
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
    const item = store.selectedItem;
    if (!item?.playoutvueId) return;

    pushRatingInFlight.value = true;
    try {
        await invoke('update_ingestor_rating', {
            uuid: item.playoutvueId,
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
    if (store.selectedItem && store.selectedItem.type !== 'gap') {
        const newVal = Math.max(0, store.selectedItem[field] + val);
        store.updateItem(store.selectedItem.id, {
            [field]: newVal
        });

        if (field === 'seek' && store.selectedItem.type === 'video') {
            await getActivePlayoutService().seekMedia?.(store.selectedItem.filename, newVal);
        }
    }
}

const fireCue = async () => {
    if (!store.selectedItem || store.selectedItem.type === 'gap') return;
    try {
        await getActivePlayoutService().cue?.(store.selectedItem as any);
    } catch (e) {
        console.error('Playout cue failed:', e);
    }
}

const firePlay = async () => {
    if (!store.selectedItem || store.selectedItem.type === 'gap') return;
    try {
        await getActivePlayoutService().take?.();
    } catch (e) {
        console.error('Playout take failed:', e);
    }
}

const fireClear = async () => {
    if (!store.selectedItem || store.selectedItem.type === 'gap') return;
    try {
        await getActivePlayoutService().clear();
    } catch (e) {
        console.error('Playout clear failed:', e);
    }
}

const getDisplayName = (item: any) => {
    if (!item) return '';
    if (item.display_name) return item.display_name;
    if (item.current_path) {
        const filename = item.current_path.split(/[/\\]/).pop();
        if (filename && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filename)) {
            return filename;
        }
    }
    if (item.filename && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.filename)) {
        return item.filename;
    }
    return 'Untitled Asset';
};
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column;">
    <div style="padding: 1rem; border-bottom: 1px solid var(--glass-border);">
        <h2 class="text-danger">Inspector</h2>
    </div>
    
    <div v-if="store.selectedItem" style="padding: 1rem; flex: 1; overflow-y: auto;">
       <h3 class="text-primary">{{ getDisplayName(store.selectedItem) }}</h3>
       <p class="text-secondary text-sm" style="margin-bottom: 0.5rem;">{{ store.selectedItem.current_path || store.selectedItem.path }}</p>
       <p v-if="store.selectedItem.displayPath && store.selectedItem.displayPath !== (store.selectedItem.current_path || store.selectedItem.path)" class="text-secondary text-sm" style="margin-bottom: 0.5rem; opacity: 0.65; font-style: italic;">
         Display: {{ store.selectedItem.displayPath }}
       </p>

       <!-- Validation Warnings Section -->
       <div v-if="warningsList.length > 0" class="inspector-group warnings-card" style="margin-bottom: 1rem; border-color: rgba(249, 115, 22, 0.4); background: rgba(249, 115, 22, 0.08);">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 0.5rem;">
            <span style="font-size: 1rem;">⚠️</span>
            <h4 class="text-warning" style="margin: 0; color: #fdba74;">Validation Warnings ({{ warningsList.length }})</h4>
          </div>
          <ul style="margin: 0; padding-left: 1.2rem; color: #fdba74; font-size: 0.8rem; line-height: 1.4;">
            <li v-for="(warn, idx) in warningsList" :key="idx" style="margin-bottom: 4px; word-break: break-all;">
              {{ warn }}
            </li>
          </ul>
       </div>

        <div v-if="hasIngestorUuid" class="inspector-group" style="margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
              <h4 class="text-accent" style="margin:0;">Ingestor</h4>
              <span class="igs-status-badge" :style="{ color: statusColor(store.selectedItem.ingestorStatus), borderColor: statusColor(store.selectedItem.ingestorStatus) }">
                {{ statusLabel(store.selectedItem.ingestorStatus) }}
              </span>
            </div>
            <p class="text-secondary text-sm" style="margin-bottom: 0.75rem;">UUID: <span class="mono">{{ store.selectedItem.playoutvueId }}</span></p>
            <div style="display: flex; gap: 6px;">
              <button class="glass-btn btn-accent" style="flex:1;" :disabled="ingestorFetchInFlight" @click="fetchFromIngestor">
                {{ ingestorFetchInFlight ? 'Fetching...' : 'Fetch from Ingestor' }}
              </button>
            </div>
            <div v-if="store.selectedItem.ingestorStatus !== 'idle'" style="display: flex; gap: 6px; margin-top: 8px;">
              <button class="glass-btn" style="flex:1;" :disabled="pushTrimInFlight" @click="pushTrimToIngestor" title="Push current trim points to the Ingestor API">
                {{ pushTrimInFlight ? 'Pushing...' : 'Push Trim' }}
              </button>
              <button class="glass-btn" style="flex:1;" :disabled="pushRatingInFlight" @click="pushRatingToIngestor(store.selectedItem.complianceRating)" title="Push current rating to the Ingestor API">
                {{ pushRatingInFlight ? 'Pushing...' : 'Push Rating' }}
              </button>
            </div>
        </div>

        <!-- Trimming UI Context (only relevant for video) -->
    <div v-if="store.selectedItem.type === 'video'" class="inspector-group">
            <h4 class="text-accent">Non-Destructive Trimming</h4>
            
            <div class="control-row">
                <label>Seek (Frames)</label>
                <div class="adjuster">
                    <button class="glass-btn" @click="adjustTrim('seek', -10)">-10</button>
                    <input type="number" :value="store.selectedItem.seek" readonly />
                    <button class="glass-btn" @click="adjustTrim('seek', 10)">+10</button>
                </div>
            </div>

            <div class="control-row">
                <label>Length (Frames)</label>
                <div class="adjuster">
                    <button class="glass-btn" @click="adjustTrim('length', -10)">-10</button>
                    <input type="number" :value="store.selectedItem.length" readonly />
                    <button class="glass-btn" @click="adjustTrim('length', 10)">+10</button>
                </div>
            </div>
            
            <p class="text-secondary text-sm" style="margin-top: 1rem; font-style: italic;">
                Adjustments update AMCP LOADBG parameters instantly without altering the source file.
            </p>
       </div>
       
       <!-- Routing Context (only relevant for Live) -->
      <div v-else-if="store.selectedItem.type === 'live'" class="inspector-group">
            <h4 class="text-warning">SDI Routing</h4>
            <div class="control-row">
                <label>Decklink Interface</label>
                <select class="glass-input">
                    <option value="1">Decklink 8K Pro (Input 1)</option>
                    <option value="2">Decklink 8K Pro (Input 2)</option>
                </select>
            </div>
       </div>
       
       <div v-else-if="store.selectedItem.type === 'gap'" class="inspector-group">
            <h4 class="text-warning">Gap Line</h4>
            <p class="text-secondary text-sm">This marker is used only for offline schedule planning. It does not play on air and does not enter the playout queue.</p>
       </div>

       <div v-if="store.selectedItem.type !== 'gap'" class="execution-controls" style="display: flex; gap: 8px; margin-top: 1rem;">
           <button class="glass-btn btn-primary" style="flex: 1;" @click="fireCue">CUE (BG)</button>
           <button class="glass-btn btn-warning" style="flex: 1;" @click="firePlay">TAKE (ON AIR)</button>
           <button class="glass-btn btn-danger" style="flex: 1;" @click="fireClear">CLEAR</button>
       </div>
       
       <ComplianceModule v-if="store.selectedItem.type !== 'gap'" />

       <div v-if="transcodeInfo" class="inspector-group" style="margin-top: 1rem;">
           <h4 class="text-accent">Transcoded by PlayoutTranscode</h4>
           <div class="transcode-meta">
               <div class="meta-row">
                   <span class="meta-label">UUID</span>
                   <span class="meta-value mono">{{ transcodeInfo.uuid }}</span>
               </div>
               <div class="meta-row">
                   <span class="meta-label">Source Path</span>
                   <span class="meta-value">{{ transcodeInfo.sourcePath }}</span>
               </div>
           </div>
       </div>

    </div>
    <div v-else-if="activeAsset" style="padding: 1rem; flex: 1; overflow-y: auto;">
       <h3 class="text-primary">{{ activeAsset.display_name }}</h3>
       <p class="text-secondary text-sm" style="margin-bottom: 0.5rem; word-break: break-all;">{{ activeAsset.current_path }}</p>

       <!-- Validation Warnings Section -->
       <div v-if="warningsList.length > 0" class="inspector-group warnings-card" style="margin-bottom: 1rem; border-color: rgba(249, 115, 22, 0.4); background: rgba(249, 115, 22, 0.08);">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 0.5rem;">
            <span style="font-size: 1rem;">⚠️</span>
            <h4 class="text-warning" style="margin: 0; color: #fdba74;">Validation Warnings ({{ warningsList.length }})</h4>
          </div>
          <ul style="margin: 0; padding-left: 1.2rem; color: #fdba74; font-size: 0.8rem; line-height: 1.4;">
            <li v-for="(warn, idx) in warningsList" :key="idx" style="margin-bottom: 4px; word-break: break-all;">
              {{ warn }}
            </li>
          </ul>
       </div>

       <div class="inspector-group">
           <h4 class="text-accent">Library Asset Metadata</h4>
           <div class="transcode-meta">
               <div class="meta-row">
                   <span class="meta-label">UUID</span>
                   <span class="meta-value mono">{{ activeAsset.uuid }}</span>
               </div>
               <div class="meta-row">
                   <span class="meta-label">Status</span>
                   <span class="meta-value mono" :style="{ color: statusColor(activeAsset.status) }">{{ statusLabel(activeAsset.status) }}</span>
               </div>
               <div class="meta-row">
                   <span class="meta-label">Duration</span>
                   <span class="meta-value mono">{{ (activeAsset.duration_ms / 1000).toFixed(2) }}s ({{ activeAsset.duration_ms }} ms)</span>
               </div>
               <div v-if="activeAsset.trim_in_ms !== undefined || activeAsset.trim_out_ms !== undefined" class="meta-row">
                   <span class="meta-label">Trim In / Out</span>
                   <span class="meta-value mono">{{ activeAsset.trim_in_ms || 0 }} ms / {{ activeAsset.trim_out_ms || activeAsset.duration_ms }} ms</span>
               </div>
           </div>
       </div>
    </div>
    <div v-else class="empty-state">
         <p class="text-secondary text-sm">Select an item in the rundown or library.</p>
    </div>
  </div>
</template>

<style scoped>
.inspector-group {
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 8px;
    border: 1px solid var(--glass-border);
    margin-bottom: 1rem;
}

h4 {
    margin-bottom: 1rem;
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.control-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
}

label {
    font-size: 0.85rem;
    color: var(--text-secondary);
}

.adjuster {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

input {
    background: var(--bg-tertiary);
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
    padding: 4px 8px;
    width: 60px;
    text-align: center;
    border-radius: 4px;
    font-variant-numeric: tabular-nums;
}

.glass-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: 0.2s;
}

.glass-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: var(--accent-blue);
}

.glass-input {
    background: var(--bg-tertiary);
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
    padding: 6px;
    border-radius: 4px;
}

.empty-state {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
}
.transcode-meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.meta-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.meta-label {
    font-size: 0.72rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.meta-value {
    font-size: 0.78rem;
    color: var(--text-primary);
    word-break: break-all;
}
.mono {
    font-family: 'Cascadia Code', 'Consolas', monospace;
    font-size: 0.72rem;
}
.igs-status-badge {
    display: inline-flex; align-items: center; padding: 3px 10px;
    border-radius: 999px; border: 1px solid; font-size: 0.68rem;
    font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
    background: rgba(0,0,0,0.2);
}
.btn-accent {
    border-color: rgba(51,190,204,0.4); color: #33becc;
}
.btn-accent:hover { background: rgba(51,190,204,0.12); }
.btn-accent:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-primary {
    border-color: rgba(51,190,204,0.4); color: #33becc;
}
.btn-warning {
    border-color: rgba(248,180,0,0.4); color: #f8b400;
}
.btn-danger {
    border-color: rgba(230,57,70,0.4); color: #e63946;
}
</style>
