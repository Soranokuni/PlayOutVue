<script setup lang="ts">
import { ref, computed } from 'vue';
import { ObsService } from '../services/obs';
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
  { id: 'violence', label: 'ΒΙΑ (Violence)' },
  { id: 'sex', label: 'ΣΕΞ (Sex)' },
  { id: 'substances', label: 'ΧΡΗΣΗ ΟΥΣΙΩΝ (Substances)' },
  { id: 'language', label: 'ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ (Language)' }
];

const selectedRating = ref('k');
const selectedDescriptors = ref<string[]>([]);
const isOverlayActive = ref(false);

const applyComplianceOverlay = async () => {
    const settings = useSettingsStore();
    // Generate the serialized XML/JSON payload required by the HTML Producer
    const payload = {
        rating: selectedRating.value,
        descriptors: selectedDescriptors.value
    };
    const dataString = JSON.stringify(payload);
    try {
        await ObsService.applyCompliance(`${settings.complianceUrl}?data=${encodeURIComponent(dataString)}`);
        isOverlayActive.value = true;
    } catch (e) {
        console.error("Failed to push compliance graphics:", e);
    }
}

const clearComplianceOverlay = async () => {
    try {
        await ObsService.clearCompliance();
        isOverlayActive.value = false;
    } catch (e) {
        console.error("Failed to clear compliance graphics:", e);
    }
}
</script>

<template>
  <div class="compliance-module">
      <h3 class="text-warning" style="margin-bottom: 1rem; border-bottom: 1px solid var(--glass-border); padding-bottom: 0.5rem;">NCRTV Compliance</h3>
      
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
      
      <div class="actions">
          <button v-if="!isOverlayActive" class="glass-btn btn-primary full-width" @click="applyComplianceOverlay">
              Inject Rating Bug
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

.checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 0.85rem;
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
