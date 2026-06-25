<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { activePlayoutCapabilities, getActivePlayoutService } from '../services/playout';
import { useRundownStore, type ComplianceRating } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';

// Greek Age Rating Definitions (NCRTV Standards)
const ageRatings = [
    { id: 'none', label: 'None (Manual only)', visual: 'No automatic overlay' },
  { id: 'k', label: 'K (All Ages)', visual: 'White rhombus on green' },
  { id: '8', label: '8+ (Children restricted)', visual: 'White circle on blue' },
  { id: '12', label: '12+ (Post 9:30 PM)', visual: 'White triangle on orange' },
  { id: '16', label: '16+ (Post 11:00 PM)', visual: 'Purple square' },
  { id: '18', label: '18+ (Post 1:00 AM)', visual: 'Red Circle 18' }
];

const contentDescriptors = [
  { id: 'violence', label: 'ΒΙΑ (Violence)', text: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ' },
  { id: 'sex', label: 'ΣΕΞ (Sex)', text: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ' },
  { id: 'substances', label: 'ΧΡΗΣΗ ΟΥΣΙΩΝ (Substances)', text: 'ΠΕΡΙΕΧΕΙ ΧΡΗΣΗ ΟΥΣΙΩΝ' },
  { id: 'language', label: 'ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ (Language)', text: 'ΠΕΡΙΕΧΕΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ' }
];

const store = useRundownStore();
const settings = useSettingsStore();
const item = computed(() => store.selectedItem);
const selectedRating = ref<ComplianceRating>('none');
const selectedDescriptors = ref<string[]>([]);
const advisoryText = ref('');
const tpFlag = ref(false);
const isOverlayActive = ref(false);

const timelineFields = ref([
    { start: '0:00', end: '0:30', text: '' },
    { start: '1:00', end: '1:30', text: '' }
]);

function parseTimeToMs(t: string | number): number {
    if (typeof t === 'number') return t * 1000;
    const parts = String(t).split(':').map(Number);
    if (parts.length === 2) {
        return ((parts[0] || 0) * 60 + (parts[1] || 0)) * 1000;
    } else if (parts.length === 3) {
        return (((parts[0] || 0) * 60 + (parts[1] || 0)) * 60 + (parts[2] || 0)) * 1000;
    }
    const parsed = parseFloat(t);
    return isNaN(parsed) ? 0 : parsed * 1000;
}

function formatMsToTime(ms: number | string): string {
    const totalSecs = Math.floor(Number(ms) / 1000);
    if (isNaN(totalSecs) || totalSecs <= 0) return '0:00';
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

const syncFromItem = () => {
    selectedRating.value = item.value?.complianceRating || 'none';
    selectedDescriptors.value = [...(item.value?.complianceDescriptors || [])];
    advisoryText.value = item.value?.complianceText || '';
    tpFlag.value = item.value?.tp_flag || false;
    
    const itemTimeline = (item.value as any)?.timeline || [];
    timelineFields.value = [
        { 
            start: itemTimeline[0]?.start != null ? formatMsToTime(itemTimeline[0].start) : '0:00', 
            end: itemTimeline[0]?.end != null ? formatMsToTime(itemTimeline[0].end) : '0:30', 
            text: itemTimeline[0]?.text || '' 
        },
        { 
            start: itemTimeline[1]?.start != null ? formatMsToTime(itemTimeline[1].start) : '1:00', 
            end: itemTimeline[1]?.end != null ? formatMsToTime(itemTimeline[1].end) : '1:30', 
            text: itemTimeline[1]?.text || '' 
        }
    ];
    
    isOverlayActive.value = false;
};

watch(() => item.value?.id, syncFromItem, { immediate: true });

const computedDescriptorText = computed(() => {
    const presetText = selectedDescriptors.value
        .map((id) => contentDescriptors.find((descriptor) => descriptor.id === id)?.text)
        .filter(Boolean)
        .join(' • ');

    return [presetText, advisoryText.value.trim()].filter(Boolean).join(' • ');
});

const persistCompliance = () => {
    if (!item.value) return;
    
    // Save locally
    store.updateItem(item.value.id, {
        complianceRating: selectedRating.value,
        complianceDescriptors: selectedRating.value === 'none' ? [] : [...selectedDescriptors.value],
        complianceText: selectedRating.value === 'none' ? '' : advisoryText.value.trim(),
        tp_flag: tpFlag.value
    });

    const parsedTimeline = timelineFields.value
        .filter(field => field.text.trim() !== '')
        .map(field => ({
            start: parseTimeToMs(field.start),
            end: parseTimeToMs(field.end),
            text: field.text.trim()
        }));

    // Update metadata and push to db
    store.updateItemMetadata(item.value.id, item.value.playoutvueId, {
        complianceRating: selectedRating.value,
        tp_flag: tpFlag.value,
        content_type: item.value.content_type || 'none',
        timeline: parsedTimeline
    });
};

watch([selectedRating, selectedDescriptors, advisoryText, tpFlag, timelineFields], persistCompliance, { deep: true });

const applyComplianceOverlay = async () => {
    if (!item.value) return;
    persistCompliance();
    if (!activePlayoutCapabilities.value.compliance) {
        isOverlayActive.value = false;
        return;
    }
    if (selectedRating.value === 'none') {
        await clearComplianceOverlay();
        return;
    }
    try {
        await getActivePlayoutService().applyComplianceForItem?.({
            ...item.value,
            complianceRating: selectedRating.value,
            complianceDescriptors: [...selectedDescriptors.value],
            complianceText: computedDescriptorText.value
        });
        isOverlayActive.value = true;
    } catch (e) {
        console.error("Failed to push compliance graphics:", e);
    }
}

const clearComplianceOverlay = async () => {
    if (!activePlayoutCapabilities.value.compliance) {
        isOverlayActive.value = false;
        return;
    }
    try {
        await getActivePlayoutService().clearCompliance?.();
        isOverlayActive.value = false;
    } catch (e) {
        console.error("Failed to clear compliance graphics:", e);
    }
}
</script>

<template>
  <div class="compliance-module">
      <h3 class="text-warning" style="margin-bottom: 1rem; border-bottom: 1px solid var(--glass-border); padding-bottom: 0.5rem;">NCRTV Compliance</h3>

      <div v-if="!settings.logosPath && !settings.cgStationLogoPath" class="info-banner">Select the logos folder in settings to enable local rating PNG overlays.</div>
      <div v-if="!activePlayoutCapabilities.compliance" class="info-banner">The active playout engine does not yet expose compliance overlays. Settings are still saved per rundown item.</div>
      
      <div class="form-group">
          <label class="text-secondary text-sm">Age Rating Segment</label>
          <select v-model="selectedRating" class="glass-input full-width">
              <option v-for="rating in ageRatings" :key="rating.id" :value="rating.id">
                  {{ rating.label }}
              </option>
          </select>
      </div>

      <!-- TP Checkbox -->
      <div class="form-group">
          <label style="display:flex; gap:8px; align-items:center; cursor:pointer; font-size:0.85rem; padding: 4px 0;">
              <input type="checkbox" v-model="tpFlag" style="accent-color:var(--accent-blue);">
              <span>Product Placement (TP) Active</span>
          </label>
      </div>
      
      <div class="form-group" v-if="selectedRating !== 'none' && selectedRating !== 'k' && selectedRating !== '8'">
          <label class="text-secondary text-sm" style="margin-bottom: 0.5rem; display: block;">Content Descriptors (Mandatory for 12+)</label>
          <div v-for="desc in contentDescriptors" :key="desc.id" class="checkbox-row">
              <input type="checkbox" :id="desc.id" :value="desc.id" v-model="selectedDescriptors">
              <label :for="desc.id">{{ desc.label }}</label>
          </div>
      </div>

      <div class="form-group" v-if="selectedRating !== 'none' && selectedRating !== 'k'">
          <label class="text-secondary text-sm">Playout Advisory Text</label>
          <textarea v-model="advisoryText" class="glass-input full-width text-area" rows="3" placeholder="Π.χ. ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ"></textarea>
          <small class="helper-text">Rendered on the playout engine compliance layer so each playlist item can carry its own advisory message.</small>
      </div>

      <div v-if="selectedRating !== 'none' && selectedRating !== 'k'" class="preview-row">
          <span class="preview-label">Preview text</span>
          <span class="preview-value">{{ computedDescriptorText || 'No advisory text' }}</span>
      </div>

      <!-- Timed Explanations (Timeline Fields) -->
      <div class="form-group" v-if="selectedRating !== 'none'" style="margin-top: 1rem; border-top: 1px solid var(--glass-border); padding-top: 1rem;">
          <label class="text-secondary text-sm" style="margin-bottom: 0.5rem; display: block; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;">Timed Explanation Banner (Timeline)</label>
          
          <div v-for="(field, index) in timelineFields" :key="index" class="timeline-field-row" style="margin-bottom: 1rem; background:rgba(0,0,0,0.15); padding: 0.75rem; border-radius: 6px; border: 1px solid var(--glass-border);">
              <div style="font-size:0.75rem; font-weight: 600; color: var(--accent-blue); margin-bottom: 0.5rem; text-transform: uppercase;">
                  Field {{ index + 1 }}
              </div>
              <div style="display:flex; gap: 8px; align-items:center; margin-bottom: 0.5rem;">
                  <input type="text" class="glass-input" style="width: 70px; font-size: 0.76rem;" v-model="field.start" placeholder="0:00" title="Start Time (e.g. 0:00)">
                  <span style="font-size: 0.76rem; color: var(--text-secondary);">to</span>
                  <input type="text" class="glass-input" style="width: 70px; font-size: 0.76rem;" v-model="field.end" placeholder="0:30" title="End Time (e.g. 0:30)">
              </div>
              <input type="text" class="glass-input full-width" style="font-size: 0.8rem;" v-model="field.text" placeholder="e.g. ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 8 ΕΤΩΝ" title="Explanation Text">
          </div>
      </div>
      
      <div class="actions">
          <button v-if="!isOverlayActive" class="glass-btn btn-primary full-width" @click="applyComplianceOverlay">
              Push Current Item Overlay
          </button>
          <button v-else class="glass-btn btn-danger full-width" @click="clearComplianceOverlay">
              Clear Overlay (L31/32/34)
          </button>
      </div>
  </div>
</template>

<style scoped>
.compliance-module {
    background: var(--bg-secondary);
    border: 1px solid var(--glass-border);
    border-radius: 8px;
    padding: 1rem;
    margin-top: 2rem;
}

.form-group {
    margin-bottom: 1rem;
}

.info-banner {
    margin-bottom: 0.8rem;
    border: 1px solid rgba(248, 180, 0, 0.25);
    background: rgba(248, 180, 0, 0.08);
    color: #f8b400;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 0.75rem;
}

.full-width {
    width: 100%;
    box-sizing: border-box;
}

.glass-input {
    background: var(--bg-tertiary);
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
    padding: 8px;
    border-radius: 4px;
    margin-top: 4px;
}

.text-area {
    resize: vertical;
    min-height: 72px;
    line-height: 1.4;
}

.helper-text {
    display: block;
    margin-top: 6px;
    color: var(--text-secondary);
    opacity: 0.8;
    font-size: 0.72rem;
}

.checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 0.85rem;
}

.preview-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 1rem;
    padding: 8px 10px;
    border-radius: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--glass-border);
}

.preview-label {
    font-size: 0.72rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.08em;
}

.preview-value {
    color: var(--text-primary);
    font-size: 0.82rem;
    line-height: 1.35;
}

.glass-btn {
    padding: 10px;
    border-radius: 6px;
    font-weight: 500;
    cursor: pointer;
    transition: 0.2s;
    border: 1px solid;
}

.btn-primary {
    background: rgba(51, 190, 204, 0.1);
    color: var(--accent-blue);
    border-color: rgba(51, 190, 204, 0.3);
}

.btn-primary:hover {
    background: rgba(51, 190, 204, 0.2);
    border-color: var(--accent-blue);
}

.btn-danger {
    background: rgba(230, 57, 70, 0.1);
    color: var(--accent-red);
    border-color: rgba(230, 57, 70, 0.3);
}

.btn-danger:hover {
    background: rgba(230, 57, 70, 0.2);
    border-color: var(--accent-red);
}
</style>
