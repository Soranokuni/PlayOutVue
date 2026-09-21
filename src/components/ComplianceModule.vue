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
import AppIcon from './ui/AppIcon.vue';
import type { IconName } from './ui/icons';

/**
 * §8: the four NCRTV content descriptors carried emoji in their data. The
 * mapping lives here rather than in `greekCompliance.ts` because which glyph
 * draws a descriptor is a UI decision; the tag text that reaches air is not.
 */
const DESCRIPTOR_ICONS: Record<ContentDescriptorId, IconName> = {
  violence: 'descriptor-violence',
  sex: 'descriptor-sex',
  substances: 'descriptor-substances',
  language: 'descriptor-language',
};

const descriptorIcon = (id: ContentDescriptorId): IconName => DESCRIPTOR_ICONS[id] ?? 'alert';

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
  if (selectedRating.value === 'none' || selectedRating.value === 'k') {
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
        <AppIcon class="greek-mark" name="shield" />
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
          @click="selectedRating = r.id as ComplianceRating; if (r.id === 'k' || r.id === 'none') { selectedDescriptors = []; advisoryText = ''; }"
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

    <!-- Descriptors & Quick Presets (For 8, 12, 16, 18) -->
    <template v-if="selectedRating === '8' || selectedRating === '12' || selectedRating === '16' || selectedRating === '18'">
      <!-- Quick Presets -->
      <div class="form-group cm-stacked">
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
            <span class="desc-icon"><AppIcon :name="descriptorIcon(desc.id)" :size="14" /></span>
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
          <span class="preview-timer"><AppIcon name="clock" :size="12" /> First 30s + every 10m</span>
        </div>
        <div class="mock-screen-crop">
          <div class="preview-advisory-group">
            <div class="preview-badge" :class="'badge-' + selectedRating">
              {{ selectedRating.toUpperCase() }}
            </div>
            <div v-if="tpFlag" class="preview-tp">TP</div>
            <div v-if="advisoryText" class="preview-floating-text-wrap">
              <div class="preview-text-row">
                <span class="pill-icon"><AppIcon name="alert" :size="12" /></span>
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
        class="glass-btn btn-trigger-advisory full-width cm-stacked-below"
        :disabled="isAdvisoryTriggering"
        @click="triggerAdvisory"
      >
        <span v-if="!isAdvisoryTriggering"><AppIcon name="zap" :size="14" /> Trigger on-air advisory (CG 1-32)</span>
        <span v-else><AppIcon name="processing" :size="14" spin /> Pushing advisory CG…</span>
      </button>

      <button v-if="!isOverlayActive" class="glass-btn btn-primary full-width" @click="applyComplianceOverlay">
        <AppIcon name="play" :size="14" /> Push overlay (top-right L32)
      </button>
      <button v-else class="glass-btn btn-danger full-width" @click="clearComplianceOverlay">
        <AppIcon name="stop" :size="14" /> Clear compliance overlay
      </button>
    </div>
  </div>
</template>

<style scoped>
.compliance-module {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  margin-top: var(--space-6);
}

.module-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: var(--space-3);
}

.title-with-badge {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.greek-flag {
  font-size: var(--fs-xl);
}

.module-header h3 {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--fw-bold);
  color: var(--text-primary);
}

.active-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-on-accent);
}

.form-group {
  margin-bottom: var(--space-4);
}

.form-group label {
  display: block;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}

/* Rating Button Bar */
.rating-button-bar {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: var(--space-2);
}

/* §3.2: two inline margins, two values, one idea. */
.cm-stacked {
  margin-top: var(--space-4);
}

.cm-stacked-below {
  margin-bottom: var(--space-2);
}

.rating-select-btn {
  background: var(--bg-hover);
  border: 1px solid var(--border-medium);
  color: var(--text-secondary);
  padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-weight: var(--fw-semibold);
  font-size: var(--fs-md);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.rating-select-btn:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}

/* The selected rating button now carries the same colour the rundown chip,
   library chip and on-air badge use — these used to be a sixth, unrelated
   palette (blue for 8, purple for 16) that contradicted the NCRTV semantics
   everywhere else in the app. */
.rating-select-btn.active.btn-none { background: var(--bg-active); color: var(--text-primary); border-color: var(--border-strong); }
.rating-select-btn.active.btn-k { background: var(--rating-k); color: var(--rating-k-fg); border-color: var(--rating-k); }
.rating-select-btn.active.btn-8 { background: var(--rating-8); color: var(--rating-8-fg); border-color: var(--rating-8); }
.rating-select-btn.active.btn-12 { background: var(--rating-12); color: var(--rating-12-fg); border-color: var(--rating-12); }
.rating-select-btn.active.btn-16 { background: var(--rating-16); color: var(--rating-16-fg); border-color: var(--rating-16); }
.rating-select-btn.active.btn-18 { background: var(--rating-18); color: var(--rating-18-fg); border-color: var(--rating-18); }

/* TP Toggle */
.tp-toggle-row {
  margin: var(--space-3) 0;
  background: var(--bg-input);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}

.toggle-checkbox {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.tp-label strong {
  background: var(--status-warning);
  color: var(--text-on-warning);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  margin-right: var(--space-2);
}

/* Preset Chips */
.preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.preset-chip {
  background: var(--bg-hover);
  border: 1px solid var(--border-medium);
  color: var(--text-secondary);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.preset-chip:hover {
  background: color-mix(in srgb, var(--accent-blue) 15%, transparent);
  border-color: color-mix(in srgb, var(--accent-blue) 40%, transparent);
  color: var(--accent-blue);
}

.preset-chip.active {
  background: color-mix(in srgb, var(--accent-blue) 20%, transparent);
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}

/* Descriptor Buttons */
.descriptor-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}

.desc-toggle-btn {
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-md);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.desc-toggle-btn:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.desc-toggle-btn.active {
  background: color-mix(in srgb, var(--status-error) 15%, transparent);
  border-color: color-mix(in srgb, var(--status-error) 50%, transparent);
  color: var(--status-error);
}

.desc-icon {
  font-size: var(--fs-xl);
}

.full-width {
  width: 100%;
  box-sizing: border-box;
}

.glass-input {
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  color: var(--text-primary);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--fs-md);
  outline: none;
}

.text-area {
  resize: vertical;
  min-height: 54px;
  font-family: inherit;
  line-height: var(--lh-tight);
}

/* Live Preview Card */
.live-preview-card {
  margin: var(--space-4) 0;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-3);
}

.preview-header {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}

.preview-timer {
  color: var(--accent-blue);
}

/* NOTE: everything from here to .preview-accent-line draws a miniature of
   what CasparCG puts on air. Its black raster and white type are content, not
   theme — they must look the same in every theme because the broadcast output
   does. The lint guard whitelists this subtree. */
.mock-screen-crop {
  background: #000;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  display: flex;
  justify-content: flex-end;
  align-items: center;
}

.preview-advisory-group {
  display: flex;
  flex-direction: row-reverse;
  align-items: center;
  gap: var(--space-2);
}

.preview-badge {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
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
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.preview-floating-text-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-0);
  position: relative;
  padding: 0 var(--space-0);
}

.preview-text-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.pill-icon { font-size: var(--fs-xs); }

.preview-floating-text {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
  color: #fff;
  text-transform: uppercase;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  white-space: nowrap;
}

.preview-accent-line {
  height: 1.5px;
  background: linear-gradient(270deg, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0.35) 75%, rgba(255, 255, 255, 0) 100%);
  border-radius: var(--radius-sm);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}

/* Actions */
.actions {
  margin-top: var(--space-4);
}

.glass-btn {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  font-weight: var(--fw-bold);
  cursor: pointer;
  transition: var(--dur-fast);
  font-size: var(--fs-md);
}

.btn-trigger-advisory {
  background: color-mix(in srgb, var(--accent-blue) 24%, transparent);
  color: var(--accent-blue);
  border: 1.5px solid color-mix(in srgb, var(--accent-blue) 60%, transparent);
  font-weight: var(--fw-semibold);
}

.btn-trigger-advisory:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-blue) 40%, transparent);
  border-color: var(--accent-blue);
  color: var(--text-primary);
}

.btn-trigger-advisory:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background: color-mix(in srgb, var(--accent-blue) 15%, transparent);
  color: var(--accent-blue);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 40%, transparent);
}

.btn-primary:hover {
  background: color-mix(in srgb, var(--accent-blue) 25%, transparent);
}

.btn-danger {
  background: color-mix(in srgb, var(--status-error) 15%, transparent);
  color: var(--status-error);
  border: 1px solid color-mix(in srgb, var(--status-error) 40%, transparent);
}

.btn-danger:hover {
  background: color-mix(in srgb, var(--status-error) 25%, transparent);
}
</style>
