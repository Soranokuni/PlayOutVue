<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { activePlayoutCapabilities, getActivePlayoutService } from '../services/playout';
import { useRundownStore, type ComplianceRating } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';
import {
  GREEK_CONTENT_DESCRIPTORS,
  GREEK_COMPLIANCE_PRESETS,
  buildGreekAdvisoryText,
  formatCompliancePayload,
  type ContentDescriptorId,
  type GreekCompliancePreset,
  type GreekRating,
  type GreekWarningType,
  type GreekComplianceConfig
} from '../lib/greekCompliance';

const store = useRundownStore();
const settings = useSettingsStore();
const item = computed(() => store.selectedItem);

const ageRatings = [
  { id: 'none', label: 'None / Disabled', visual: 'No automatic overlay' },
  { id: 'k', label: 'K — All Ages (Όλοι)', visual: 'Green rhombus' },
  { id: '8', label: '8+ (Children restricted)', visual: 'Blue circle' },
  { id: '12', label: '12+ (Post 9:30 PM)', visual: 'Orange triangle' },
  { id: '16', label: '16+ (Post 11:00 PM)', visual: 'Purple square' },
  { id: '18', label: '18+ (Post 1:00 AM)', visual: 'Red Circle 18' }
];

const selectedRating = ref<ComplianceRating>('none');
const selectedDescriptors = ref<ContentDescriptorId[]>([]);
const advisoryText = ref('');
const tpFlag = ref(false);
const isOverlayActive = ref(false);
const isAdvisoryTriggering = ref(false);
const durationSec = ref(30);
const repeatIntervalSec = ref(600);

const availablePresets = computed(() => {
  if (selectedRating.value === 'none' || selectedRating.value === 'k' || selectedRating.value === '8') {
    return [];
  }
  return GREEK_COMPLIANCE_PRESETS.filter(p => p.ageRating === selectedRating.value);
});

const syncFromItem = () => {
  if (!item.value) return;
  selectedRating.value = item.value.complianceRating || 'none';
  selectedDescriptors.value = [...((item.value.complianceDescriptors as ContentDescriptorId[]) || [])];
  advisoryText.value = item.value.complianceText || '';
  tpFlag.value = item.value.tp_flag || false;
  isOverlayActive.value = false;
};

watch(() => item.value?.id, syncFromItem, { immediate: true });

const onToggleDescriptor = (id: ContentDescriptorId) => {
  const idx = selectedDescriptors.value.indexOf(id);
  if (idx >= 0) {
    selectedDescriptors.value.splice(idx, 1);
  } else {
    selectedDescriptors.value.push(id);
  }
  advisoryText.value = buildGreekAdvisoryText(selectedDescriptors.value, 'movie');
  persistCompliance();
};

const applyPreset = (preset: GreekCompliancePreset) => {
  selectedRating.value = preset.ageRating;
  selectedDescriptors.value = [...preset.descriptors];
  advisoryText.value = preset.advisoryText;
  durationSec.value = preset.displayDurationSec || 30;
  repeatIntervalSec.value = preset.repeatIntervalSec || 600;
  persistCompliance();
};

const persistCompliance = () => {
  if (!item.value) return;

  const currentRating = selectedRating.value;
  const currentText = currentRating === 'none' ? '' : advisoryText.value.trim();
  const currentDescriptors = currentRating === 'none' ? [] : [...selectedDescriptors.value];

  store.updateItem(item.value.id, {
    complianceRating: currentRating,
    complianceDescriptors: currentDescriptors,
    complianceText: currentText,
    tp_flag: tpFlag.value
  });

  store.updateItemMetadata(item.value.id, item.value.playoutvueId, {
    complianceRating: currentRating,
    tp_flag: tpFlag.value,
    content_type: item.value.content_type || 'none',
    timeline: currentText ? [{ start: 0, end: durationSec.value * 1000, text: currentText }] : []
  });
};

watch([selectedRating, advisoryText, tpFlag], persistCompliance);

const triggerAdvisory = async () => {
  const currentItem = item.value;
  if (!currentItem || selectedRating.value === 'none') return;
  persistCompliance();

  isAdvisoryTriggering.value = true;
  try {
    const rawRating = selectedRating.value === 'k' ? 'K' : selectedRating.value;
    const mappedWarnings: GreekWarningType[] = selectedDescriptors.value.map(d => {
      if (d === 'substances') return 'drugs';
      return d as GreekWarningType;
    });

    const config: GreekComplianceConfig = {
      rating: rawRating as GreekRating,
      warnings: mappedWarnings,
      customText: advisoryText.value.trim() || undefined,
      holdTime: 4,
      warningHoldTime: 3
    };

    const payloadJson = formatCompliancePayload(config);
    const dataObj = JSON.parse(payloadJson);
    dataObj.tp = tpFlag.value;

    await invoke('caspar_cg_add', {
      channel: 1,
      layer: 32, // standard explanation / advisory layer
      template: 'playout/advisory',
      play: true,
      data: dataObj
    }).catch(async (err) => {
      console.warn('[ComplianceModule] Direct caspar_cg_add failed, falling back to service:', err);
      await getActivePlayoutService().applyComplianceForItem?.({
        ...currentItem,
        complianceRating: selectedRating.value,
        complianceDescriptors: [...selectedDescriptors.value],
        complianceText: advisoryText.value.trim(),
        tp_flag: tpFlag.value
      });
    });

    isOverlayActive.value = true;
  } catch (e) {
    console.error('Failed to trigger advisory graphics:', e);
  } finally {
    setTimeout(() => {
      isAdvisoryTriggering.value = false;
    }, 800);
  }
};

const applyComplianceOverlay = async () => {
  const currentItem = item.value;
  if (!currentItem) return;
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
      ...currentItem,
      complianceRating: selectedRating.value,
      complianceDescriptors: [...selectedDescriptors.value],
      complianceText: advisoryText.value.trim(),
      tp_flag: tpFlag.value
    });
    isOverlayActive.value = true;
  } catch (e) {
    console.error('Failed to push compliance graphics:', e);
  }
};

const clearComplianceOverlay = async () => {
  if (!activePlayoutCapabilities.value.compliance) {
    isOverlayActive.value = false;
    return;
  }
  try {
    await getActivePlayoutService().clearCompliance?.();
    isOverlayActive.value = false;
  } catch (e) {
    console.error('Failed to clear compliance graphics:', e);
  }
};
</script>

<template>
  <div class="compliance-module">
    <div class="module-header">
      <div class="title-with-badge">
        <span class="greek-flag">🇬🇷</span>
        <h3 class="text-warning">Greek NCRTV (ΕΣΡ) Compliance</h3>
      </div>
      <span v-if="selectedRating !== 'none'" class="active-badge" :class="'badge-' + selectedRating">
        {{ selectedRating.toUpperCase() }}
      </span>
    </div>

    <!-- Rating Selector -->
    <div class="form-group">
      <label class="text-secondary text-sm">Age Rating (Σήμα Καταλληλότητας)</label>
      <div class="rating-button-bar">
        <button
          v-for="r in ageRatings"
          :key="r.id"
          type="button"
          class="rating-select-btn"
          :class="{ active: selectedRating === r.id, ['btn-' + r.id]: true }"
          @click="selectedRating = r.id as ComplianceRating; if (r.id === 'k' || r.id === '8' || r.id === 'none') { selectedDescriptors = []; advisoryText = ''; }"
        >
          <span class="btn-rating-title">{{ r.id === 'none' ? 'OFF' : r.id.toUpperCase() }}</span>
        </button>
      </div>
    </div>

    <!-- Product Placement (TP) -->
    <div class="tp-toggle-row">
      <label class="toggle-checkbox">
        <input type="checkbox" v-model="tpFlag" />
        <span class="tp-label"><strong>TP</strong> Product Placement / Telemarketing Overlay</span>
      </label>
    </div>

    <!-- Descriptors & Quick Presets (Only for 12, 16, 18) -->
    <template v-if="selectedRating === '12' || selectedRating === '16' || selectedRating === '18'">
      <!-- Quick Presets -->
      <div class="form-group" style="margin-top: 1rem;">
        <label class="text-secondary text-sm">1-Click Warning Presets (ΕΣΡ)</label>
        <div class="preset-grid">
          <button
            v-for="preset in availablePresets"
            :key="preset.id"
            type="button"
            class="preset-chip"
            :class="{ active: advisoryText === preset.advisoryText }"
            @click="applyPreset(preset)"
          >
            {{ preset.badgeLabel }}
          </button>
        </div>
      </div>

      <!-- Warning Symbols / Descriptors Multi-Select -->
      <div class="form-group">
        <label class="text-secondary text-sm">Warning Descriptors (Σύμβολα Επεξήγησης)</label>
        <div class="descriptor-row">
          <button
            v-for="desc in GREEK_CONTENT_DESCRIPTORS"
            :key="desc.id"
            type="button"
            class="desc-toggle-btn"
            :class="{ active: selectedDescriptors.includes(desc.id) }"
            @click="onToggleDescriptor(desc.id)"
          >
            <span class="desc-icon">{{ desc.icon }}</span>
            <span class="desc-label">{{ desc.shortLabel }}</span>
          </button>
        </div>
      </div>

      <!-- Advisory Text Field -->
      <div class="form-group">
        <label class="text-secondary text-sm">On-Air Advisory Text (Επεξήγηση - 30s)</label>
        <textarea
          v-model="advisoryText"
          class="glass-input full-width text-area"
          rows="2"
          placeholder="π.χ. ΑΥΤΗ Η ΤΑΙΝΙΑ ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ"
        ></textarea>
      </div>

      <!-- On-Air Graphic Preview Card -->
      <div class="live-preview-card">
        <div class="preview-header">
          <span>ON-AIR GRAPHIC PREVIEW (TOP-RIGHT)</span>
          <span class="preview-timer">⏱️ First 30s + every 10m</span>
        </div>
        <div class="mock-screen-crop">
          <div class="preview-advisory-group">
            <div class="preview-badge" :class="'badge-' + selectedRating">
              {{ selectedRating.toUpperCase() }}
            </div>
            <div v-if="tpFlag" class="preview-tp">TP</div>
            <div v-if="advisoryText" class="preview-floating-text-wrap">
              <div class="preview-text-row">
                <span class="pill-icon">⚠️</span>
                <span class="preview-floating-text">{{ advisoryText }}</span>
              </div>
              <div class="preview-accent-line"></div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Playout Push Actions -->
    <div class="actions">
      <button
        v-if="selectedRating !== 'none'"
        class="glass-btn btn-trigger-advisory full-width"
        style="margin-bottom: 8px;"
        :disabled="isAdvisoryTriggering"
        @click="triggerAdvisory"
      >
        <span v-if="!isAdvisoryTriggering">⚡ Trigger On-Air Advisory (CG 1-32)</span>
        <span v-else>⏳ Pushing Advisory CG...</span>
      </button>

      <button v-if="!isOverlayActive" class="glass-btn btn-primary full-width" @click="applyComplianceOverlay">
        ▶ Push Overlay (Top-Right L32)
      </button>
      <button v-else class="glass-btn btn-danger full-width" @click="clearComplianceOverlay">
        ⏹ Clear Compliance Overlay
      </button>
    </div>
  </div>
</template>

<style scoped>
.compliance-module {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 1.15rem;
  margin-top: 1.5rem;
}

.module-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 0.65rem;
}

.title-with-badge {
  display: flex;
  align-items: center;
  gap: 8px;
}

.greek-flag {
  font-size: 1.1rem;
}

.module-header h3 {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 700;
  color: #f1f5f9;
}

.active-badge {
  font-size: 0.72rem;
  font-weight: 800;
  padding: 3px 8px;
  border-radius: 4px;
  color: #fff;
}

.form-group {
  margin-bottom: 0.9rem;
}

.form-group label {
  display: block;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #94a3b8;
  margin-bottom: 6px;
}

/* Rating Button Bar */
.rating-button-bar {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 6px;
}

.rating-select-btn {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #94a3b8;
  padding: 8px 4px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 800;
  font-size: 0.85rem;
  transition: all 0.15s;
}

.rating-select-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.rating-select-btn.active.btn-none { background: rgba(255, 255, 255, 0.2); color: #fff; border-color: #fff; }
.rating-select-btn.active.btn-k { background: #166534; color: #fff; border-color: #22c55e; box-shadow: 0 0 10px rgba(34, 197, 94, 0.3); }
.rating-select-btn.active.btn-8 { background: #1e40af; color: #fff; border-color: #3b82f6; box-shadow: 0 0 10px rgba(59, 130, 246, 0.3); }
.rating-select-btn.active.btn-12 { background: #9a3412; color: #fff; border-color: #f97316; box-shadow: 0 0 10px rgba(249, 115, 22, 0.3); }
.rating-select-btn.active.btn-16 { background: #6b21a8; color: #fff; border-color: #a855f7; box-shadow: 0 0 10px rgba(168, 85, 247, 0.3); }
.rating-select-btn.active.btn-18 { background: #991b1b; color: #fff; border-color: #ef4444; box-shadow: 0 0 10px rgba(239, 68, 68, 0.3); }

/* TP Toggle */
.tp-toggle-row {
  margin: 0.75rem 0;
  background: rgba(0, 0, 0, 0.25);
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.toggle-checkbox {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 0.8rem;
  color: #cbd5e1;
}

.tp-label strong {
  background: #f59e0b;
  color: #000;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 0.72rem;
  margin-right: 6px;
}

/* Preset Chips */
.preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.preset-chip {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #cbd5e1;
  padding: 5px 9px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s;
}

.preset-chip:hover {
  background: rgba(56, 189, 248, 0.15);
  border-color: rgba(56, 189, 248, 0.4);
  color: #38bdf8;
}

.preset-chip.active {
  background: rgba(56, 189, 248, 0.2);
  border-color: #38bdf8;
  color: #38bdf8;
}

/* Descriptor Buttons */
.descriptor-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.desc-toggle-btn {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #94a3b8;
  padding: 8px 4px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  font-weight: 700;
  transition: all 0.15s;
}

.desc-toggle-btn:hover {
  border-color: rgba(255, 255, 255, 0.25);
  color: #fff;
}

.desc-toggle-btn.active {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.5);
  color: #fca5a5;
}

.desc-icon {
  font-size: 1.1rem;
}

.full-width {
  width: 100%;
  box-sizing: border-box;
}

.glass-input {
  background: #0b0f17;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f1f5f9;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 0.82rem;
  outline: none;
}

.text-area {
  resize: vertical;
  min-height: 54px;
  font-family: inherit;
  line-height: 1.35;
}

/* Live Preview Card */
.live-preview-card {
  margin: 1rem 0;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 10px;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  color: #94a3b8;
  margin-bottom: 8px;
}

.preview-timer {
  color: #38bdf8;
}

.mock-screen-crop {
  background: #000;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  padding: 12px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
}

.preview-advisory-group {
  display: flex;
  flex-direction: row-reverse;
  align-items: center;
  gap: 8px;
}

.preview-badge {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 900;
  color: #fff;
  background: rgba(255, 255, 255, 0.28);
  border: 1.5px solid rgba(255, 255, 255, 0.7);
  border-radius: 50%;
  backdrop-filter: blur(16px);
  box-shadow:
    0 3px 12px rgba(0, 0, 0, 0.35),
    -1px -1px 4px rgba(255, 255, 255, 0.35),
    inset 1px 1px 2px rgba(255, 255, 255, 0.85),
    inset -1px -1px 2px rgba(0, 0, 0, 0.2);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
}

.badge-k, .badge-8, .badge-12, .badge-16, .badge-18 {
  background: rgba(255, 255, 255, 0.28);
  border-radius: 50%;
  border-color: rgba(255, 255, 255, 0.7);
}

.preview-tp {
  background: rgba(255, 255, 255, 0.26);
  border: 1px solid rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(14px);
  color: #fff;
  font-size: 11px;
  font-weight: 900;
  padding: 2px 6px;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.preview-floating-text-wrap {
  display: flex;
  flex-direction: column;
  gap: 3px;
  position: relative;
  padding: 0 2px;
}

.preview-text-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.pill-icon { font-size: 12px; }

.preview-floating-text {
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.05em;
  color: #fff;
  text-transform: uppercase;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  white-space: nowrap;
}

.preview-accent-line {
  height: 1.5px;
  background: linear-gradient(270deg, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0.35) 75%, rgba(255, 255, 255, 0) 100%);
  border-radius: 1px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}

/* Actions */
.actions {
  margin-top: 1rem;
}

.glass-btn {
  padding: 10px;
  border-radius: 6px;
  font-weight: 700;
  cursor: pointer;
  transition: 0.15s;
  font-size: 0.85rem;
}

.btn-trigger-advisory {
  background: linear-gradient(135deg, rgba(56, 189, 248, 0.3) 0%, rgba(14, 165, 233, 0.2) 100%);
  color: #38bdf8;
  border: 1.5px solid rgba(56, 189, 248, 0.6);
  box-shadow: 0 0 14px rgba(56, 189, 248, 0.25);
  font-weight: 800;
}

.btn-trigger-advisory:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(56, 189, 248, 0.45) 0%, rgba(14, 165, 233, 0.35) 100%);
  border-color: #38bdf8;
  color: #ffffff;
}

.btn-trigger-advisory:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.4);
}

.btn-primary:hover {
  background: rgba(56, 189, 248, 0.25);
}

.btn-danger {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.4);
}

.btn-danger:hover {
  background: rgba(239, 68, 68, 0.25);
}
</style>
