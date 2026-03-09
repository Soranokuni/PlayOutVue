<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { activePlayoutCapabilities, getActivePlayoutService } from '../services/playout';
import { useRundownStore } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';

// Greek Age Rating Definitions (NCRTV Standards)
const ageRatings = [
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
const selectedRating = ref('k');
const selectedDescriptors = ref<string[]>([]);
const advisoryText = ref('');
const isOverlayActive = ref(false);

const syncFromItem = () => {
    selectedRating.value = item.value?.complianceRating || 'k';
    selectedDescriptors.value = [...(item.value?.complianceDescriptors || [])];
    advisoryText.value = item.value?.complianceText || '';
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
    store.updateItem(item.value.id, {
        complianceRating: selectedRating.value as 'k' | '8' | '12' | '16' | '18',
        complianceDescriptors: [...selectedDescriptors.value],
        complianceText: advisoryText.value.trim()
    });
};

watch([selectedRating, selectedDescriptors, advisoryText], persistCompliance, { deep: true });

const applyComplianceOverlay = async () => {
    if (!item.value) return;
    persistCompliance();
    if (!activePlayoutCapabilities.value.compliance) {
        isOverlayActive.value = false;
        return;
    }
    try {
        await getActivePlayoutService().applyComplianceForItem?.({
            ...item.value,
            complianceRating: selectedRating.value as 'k' | '8' | '12' | '16' | '18',
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

      <div v-if="!settings.logosPath" class="info-banner">Select the logos folder in settings to enable local rating PNG overlays.</div>
    <div v-if="!activePlayoutCapabilities.compliance" class="info-banner">The active playout engine does not yet expose compliance overlays. Settings are still saved per rundown item.</div>
      
      <div class="form-group">
          <label class="text-secondary text-sm">Age Rating Segment</label>
          <select v-model="selectedRating" class="glass-input full-width">
              <option v-for="rating in ageRatings" :key="rating.id" :value="rating.id">
                  {{ rating.label }}
              </option>
          </select>
      </div>
      
      <div class="form-group" v-if="selectedRating !== 'k' && selectedRating !== '8'">
          <label class="text-secondary text-sm" style="margin-bottom: 0.5rem; display: block;">Content Descriptors (Mandatory for 12+)</label>
          <div v-for="desc in contentDescriptors" :key="desc.id" class="checkbox-row">
              <input type="checkbox" :id="desc.id" :value="desc.id" v-model="selectedDescriptors">
              <label :for="desc.id">{{ desc.label }}</label>
          </div>
      </div>

      <div class="form-group" v-if="selectedRating !== 'k'">
          <label class="text-secondary text-sm">OBS Advisory Text</label>
          <textarea v-model="advisoryText" class="glass-input full-width text-area" rows="3" placeholder="Π.χ. ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ"></textarea>
          <small class="helper-text">Rendered as a live OBS text source so each playlist item can carry its own advisory message.</small>
      </div>

      <div v-if="selectedRating !== 'k'" class="preview-row">
          <span class="preview-label">Preview text</span>
          <span class="preview-value">{{ computedDescriptorText || 'No advisory text' }}</span>
      </div>
      
      <div class="actions">
          <button v-if="!isOverlayActive" class="glass-btn btn-primary full-width" @click="applyComplianceOverlay">
              Push Current Item Overlay
          </button>
          <button v-else class="glass-btn btn-danger full-width" @click="clearComplianceOverlay">
              Clear Overlay (L20)
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
