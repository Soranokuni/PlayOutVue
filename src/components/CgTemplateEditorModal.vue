<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useSettingsStore, DEFAULT_CG_ADVISORY_CONFIG, type CgAdvisoryTemplateConfig } from '../stores/settings';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const settings = useSettingsStore();

// Local editable configuration model cloned from settings
const formConfig = ref<CgAdvisoryTemplateConfig>({
  ...DEFAULT_CG_ADVISORY_CONFIG,
  ...(settings.cgAdvisoryConfig || {})
});

// Interactive preview parameters
const previewRating = ref<string>('16');
const previewWarnings = ref<{ [key: string]: boolean }>({
  violence: true,
  sex: false,
  drugs: true,
  language: false
});
const previewTp = ref<boolean>(false);
const previewBg = ref<'dark' | 'bright' | 'checker' | 'transparent'>('dark');
const isPlaying = ref<boolean>(false);
const saveFeedback = ref<string>('');

const iframeRef = ref<HTMLIFrameElement | null>(null);

// Greek font options suitable for European broadcast overlays
const FONT_OPTIONS = [
  { label: 'Outfit (Modern Semi-Geometric Sans)', value: 'Outfit, system-ui, -apple-system, sans-serif' },
  { label: 'Inter (Clean Neutral Broadcast)', value: 'Inter, system-ui, -apple-system, sans-serif' },
  { label: 'Roboto (Standard High Legibility)', value: 'Roboto, -apple-system, sans-serif' },
  { label: 'Montserrat (Broad Headline Sans)', value: 'Montserrat, sans-serif' },
  { label: 'System Default (Native OS Sans)', value: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif' }
];

const activeWarningsList = computed(() => {
  return Object.keys(previewWarnings.value).filter(k => previewWarnings.value[k]);
});

function syncIframePreview() {
  if (!iframeRef.value || !iframeRef.value.contentWindow) return;
  const win = iframeRef.value.contentWindow as any;
  if (typeof win.applyConfig === 'function') {
    win.applyConfig({
      rating: previewRating.value,
      warnings: activeWarningsList.value,
      tp: previewTp.value,
      styling: formConfig.value,
      hold_time: formConfig.value.ratingHoldSec,
      warning_hold_time: formConfig.value.warningHoldSec
    });
  }
  if (typeof win.setDevBackground === 'function') {
    win.setDevBackground(previewBg.value);
  }
}

watch([formConfig, previewRating, previewWarnings, previewTp, previewBg], () => {
  syncIframePreview();
}, { deep: true });

function onIframeLoad() {
  syncIframePreview();
  restartPreview();
}

function playPreview() {
  if (iframeRef.value?.contentWindow) {
    const win = iframeRef.value.contentWindow as any;
    if (typeof win.play === 'function') {
      win.play();
      isPlaying.value = true;
    }
  }
}

function stopPreview() {
  if (iframeRef.value?.contentWindow) {
    const win = iframeRef.value.contentWindow as any;
    if (typeof win.stop === 'function') {
      win.stop();
      isPlaying.value = false;
    }
  }
}

function restartPreview() {
  if (iframeRef.value?.contentWindow) {
    const win = iframeRef.value.contentWindow as any;
    if (typeof win.replayTimeline === 'function') {
      win.replayTimeline();
      isPlaying.value = true;
    }
  }
}

function saveDefaults() {
  settings.updateSettings({
    cgAdvisoryConfig: { ...formConfig.value }
  });
  saveFeedback.value = 'Saved! Universal default behavior updated for subsequent clips.';
  setTimeout(() => {
    saveFeedback.value = '';
  }, 3500);
}

function resetToStandard() {
  formConfig.value = { ...DEFAULT_CG_ADVISORY_CONFIG };
  saveFeedback.value = 'Reset to official NCRTV Greek standard defaults.';
  setTimeout(() => {
    saveFeedback.value = '';
  }, 3500);
}

watch(() => props.isOpen, (open) => {
  if (open) {
    formConfig.value = {
      ...DEFAULT_CG_ADVISORY_CONFIG,
      ...(settings.cgAdvisoryConfig || {})
    };
    saveFeedback.value = '';
    setTimeout(syncIframePreview, 100);
  }
});
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="modal-backdrop" data-command-scope="modal" @click.self="emit('close')">
      <div class="glass-panel modal-content cg-studio-modal">
        <!-- Header -->
        <div class="modal-header">
          <div>
            <div class="header-title-row">
              <span class="badge-tag">CG STUDIO</span>
              <h2 class="text-accent">Universal Greek Advisory Template Customizer</h2>
            </div>
            <p class="subtitle">
              Fine-tune typography, safe areas, badge dimensions, and warning icon sizes. Changes saved here become the station's universal default for all upcoming on-air clips.
            </p>
          </div>
          <button class="glass-btn btn-icon" title="Close" @click="emit('close')">✕</button>
        </div>

        <!-- Body 2-Column Split -->
        <div class="modal-body custom-scroll cg-studio-body">
          <!-- Left Column: Live Canvas & Controls -->
          <div class="studio-preview-col">
            <div class="preview-card glass-panel">
              <div class="preview-top-toolbar">
                <div class="toolbar-cluster">
                  <span class="cluster-label">Preview Rating:</span>
                  <button
                    v-for="r in ['K', '8', '12', '16', '18', 'NONE']"
                    :key="r"
                    class="mini-btn"
                    :class="{ active: previewRating === r }"
                    @click="previewRating = r"
                  >
                    {{ r === 'NONE' ? 'Logo Only' : r }}
                  </button>
                </div>

                <div class="toolbar-cluster">
                  <span class="cluster-label">Background:</span>
                  <button
                    v-for="bg in (['dark', 'bright', 'checker', 'transparent'] as const)"
                    :key="bg"
                    class="mini-btn"
                    :class="{ active: previewBg === bg }"
                    @click="previewBg = bg"
                  >
                    {{ bg === 'dark' ? '🌑 Dark' : (bg === 'bright' ? '☀️ Bright' : (bg === 'checker' ? '🏁 Grid' : '🌫️ Transp')) }}
                  </button>
                </div>
              </div>

              <!-- Interactive 16:9 Scaled Viewport Container -->
              <div class="canvas-viewport-wrapper" :class="'bg-' + previewBg">
                <iframe
                  ref="iframeRef"
                  src="/templates/playout/advisory.html"
                  class="advisory-iframe"
                  @load="onIframeLoad"
                ></iframe>
              </div>

              <!-- Viewport Bottom Controls -->
              <div class="preview-bottom-bar">
                <div class="warnings-toggle-strip">
                  <span class="cluster-label">Warnings:</span>
                  <label class="toggle-chip">
                    <input type="checkbox" v-model="previewWarnings.violence">
                    <span>Violence</span>
                  </label>
                  <label class="toggle-chip">
                    <input type="checkbox" v-model="previewWarnings.sex">
                    <span>Sex</span>
                  </label>
                  <label class="toggle-chip">
                    <input type="checkbox" v-model="previewWarnings.drugs">
                    <span>Drugs/Subst</span>
                  </label>
                  <label class="toggle-chip">
                    <input type="checkbox" v-model="previewWarnings.language">
                    <span>Language</span>
                  </label>
                  <label class="toggle-chip">
                    <input type="checkbox" v-model="previewTp">
                    <span>TP</span>
                  </label>
                </div>

                <div class="transport-cluster">
                  <button class="action-btn play" @click="playPreview">▶ Play</button>
                  <button class="action-btn stop" @click="stopPreview">⏹ Stop</button>
                  <button class="action-btn replay" @click="restartPreview">↺ Replay</button>
                </div>
              </div>
            </div>

            <!-- Sequence Info Note -->
            <div class="info-banner">
              <span class="info-icon">ℹ️</span>
              <div class="info-text">
                <strong>Standard Playout Sequence:</strong>
                0s–30s displays Corner Badge + Rating Text. At 30s, it transitions smoothly to the high-contrast Warning SVG Icon + Descriptor. At 60s, the banner slides out while the Corner Badge remains continuously on air.
              </div>
            </div>
          </div>

          <!-- Right Column: Settings & Sliders -->
          <div class="studio-settings-col">
            <!-- Section 1: Typography -->
            <div class="settings-group glass-card">
              <div class="group-header">
                <h3>🔤 Typography & Font Family</h3>
              </div>
              <div class="form-group">
                <label>Overlay Font Family</label>
                <select v-model="formConfig.fontFamily" class="glass-select">
                  <option v-for="opt in FONT_OPTIONS" :key="opt.value" :value="opt.value">
                    {{ opt.label }}
                  </option>
                </select>
              </div>

              <div class="slider-grid">
                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Rating Explanation Font</label>
                    <span class="value-tag">{{ formConfig.explanationFontSizePx }}px</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="22"
                    step="0.5"
                    v-model.number="formConfig.explanationFontSizePx"
                    class="glass-slider"
                  >
                </div>

                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Warning Body Font</label>
                    <span class="value-tag">{{ formConfig.warningBodyFontSizePx }}px</span>
                  </div>
                  <input
                    type="range"
                    min="9"
                    max="20"
                    step="0.5"
                    v-model.number="formConfig.warningBodyFontSizePx"
                    class="glass-slider"
                  >
                </div>

                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Warning Lead Subtitle</label>
                    <span class="value-tag">{{ formConfig.warningLeadFontSizePx }}px</span>
                  </div>
                  <input
                    type="range"
                    min="8"
                    max="16"
                    step="0.5"
                    v-model.number="formConfig.warningLeadFontSizePx"
                    class="glass-slider"
                  >
                </div>
              </div>
            </div>

            <!-- Section 2: Safe Area & Placement -->
            <div class="settings-group glass-card">
              <div class="group-header">
                <h3>📐 Placement & Safe Area</h3>
              </div>
              <div class="slider-grid">
                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Top Margin</label>
                    <span class="value-tag">{{ formConfig.topOffsetPx }}px</span>
                  </div>
                  <input
                    type="range"
                    min="20"
                    max="160"
                    step="2"
                    v-model.number="formConfig.topOffsetPx"
                    class="glass-slider"
                  >
                </div>

                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Right Margin</label>
                    <span class="value-tag">{{ formConfig.rightOffsetPx }}px</span>
                  </div>
                  <input
                    type="range"
                    min="20"
                    max="180"
                    step="2"
                    v-model.number="formConfig.rightOffsetPx"
                    class="glass-slider"
                  >
                </div>
              </div>
            </div>

            <!-- Section 3: Corner Badge & Warning Icon Dimensions -->
            <div class="settings-group glass-card">
              <div class="group-header">
                <h3>🛡️ Badge & Warning Icon Sizes</h3>
              </div>
              <div class="slider-grid">
                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Corner Badge Diameter</label>
                    <span class="value-tag">{{ formConfig.badgeSizePx }}px</span>
                  </div>
                  <input
                    type="range"
                    min="36"
                    max="80"
                    step="1"
                    v-model.number="formConfig.badgeSizePx"
                    class="glass-slider"
                  >
                </div>

                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Badge Number Font Size</label>
                    <span class="value-tag">{{ formConfig.badgeFontSizePx }}px</span>
                  </div>
                  <input
                    type="range"
                    min="16"
                    max="42"
                    step="1"
                    v-model.number="formConfig.badgeFontSizePx"
                    class="glass-slider"
                  >
                </div>

                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Warning SVG Icon Size</label>
                    <span class="value-tag">{{ formConfig.warningIconSizePx }}px</span>
                  </div>
                  <input
                    type="range"
                    min="20"
                    max="44"
                    step="1"
                    v-model.number="formConfig.warningIconSizePx"
                    class="glass-slider"
                  >
                </div>

                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Accent Underline Height</label>
                    <span class="value-tag">{{ formConfig.accentLineHeightPx }}px</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="6"
                    step="0.5"
                    v-model.number="formConfig.accentLineHeightPx"
                    class="glass-slider"
                  >
                </div>
              </div>
            </div>

            <!-- Section 4: Hold Durations -->
            <div class="settings-group glass-card">
              <div class="group-header">
                <h3>⏱️ Hold Durations</h3>
              </div>
              <div class="slider-grid">
                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Rating Explanation Hold</label>
                    <span class="value-tag">{{ formConfig.ratingHoldSec }}s</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="60"
                    step="1"
                    v-model.number="formConfig.ratingHoldSec"
                    class="glass-slider"
                  >
                </div>

                <div class="form-group">
                  <div class="slider-label-row">
                    <label>Warning Descriptor Hold</label>
                    <span class="value-tag">{{ formConfig.warningHoldSec }}s</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="60"
                    step="1"
                    v-model.number="formConfig.warningHoldSec"
                    class="glass-slider"
                  >
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="modal-footer">
          <div class="footer-left">
            <button class="glass-btn btn-secondary" @click="resetToStandard">
              ↺ Reset to NCRTV Broadcast Standard
            </button>
            <span v-if="saveFeedback" class="save-toast">
              {{ saveFeedback }}
            </span>
          </div>

          <div class="footer-right">
            <button class="glass-btn btn-secondary" @click="emit('close')">Cancel</button>
            <button class="glass-btn btn-primary" @click="saveDefaults">
              💾 Save Default Configuration
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cg-studio-modal {
  width: 95vw;
  max-width: 1440px;
  height: 90vh;
  max-height: 920px;
  display: flex;
  flex-direction: column;
}

.header-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.badge-tag {
  background: rgba(56, 189, 248, 0.2);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.4);
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.cg-studio-body {
  display: grid;
  grid-template-columns: 1.15fr 0.85fr;
  gap: 20px;
  padding: 16px 24px;
  flex: 1;
  overflow-y: auto;
}

.studio-preview-col {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.preview-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.6);
}

.preview-top-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-cluster {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cluster-label {
  font-size: 11px;
  font-weight: 700;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-right: 2px;
}

.mini-btn {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #e2e8f0;
  font-size: 11px;
  font-weight: 700;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mini-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.mini-btn.active {
  background: #38bdf8;
  color: #0f172a;
  border-color: #38bdf8;
  box-shadow: 0 0 10px rgba(56, 189, 248, 0.4);
}

.canvas-viewport-wrapper {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.2);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
}

.canvas-viewport-wrapper.bg-dark {
  background: #090d16 radial-gradient(circle at 85% 15%, #1e293b 0%, #090d16 70%);
}

.canvas-viewport-wrapper.bg-bright {
  background: #e2e8f0 linear-gradient(135deg, #f8fafc 0%, #cbd5e1 50%, #94a3b8 100%);
}

.canvas-viewport-wrapper.bg-checker {
  background-color: #1e293b;
  background-image:
    linear-gradient(45deg, #0f172a 25%, transparent 25%),
    linear-gradient(-45deg, #0f172a 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #0f172a 75%),
    linear-gradient(-45deg, transparent 75%, #0f172a 75%);
  background-size: 24px 24px;
}

.canvas-viewport-wrapper.bg-transparent {
  background: #000000;
}

.advisory-iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

.preview-bottom-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.warnings-toggle-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.toggle-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 3px 7px;
  border-radius: 5px;
  cursor: pointer;
}

.toggle-chip input {
  accent-color: #38bdf8;
  cursor: pointer;
}

.transport-cluster {
  display: flex;
  align-items: center;
  gap: 6px;
}

.action-btn {
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}

.action-btn.play {
  background: rgba(34, 197, 94, 0.2);
  color: #4ade80;
  border-color: rgba(34, 197, 94, 0.4);
}
.action-btn.play:hover {
  background: #22c55e;
  color: #0f172a;
}

.action-btn.stop {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
  border-color: rgba(239, 68, 68, 0.4);
}
.action-btn.stop:hover {
  background: #ef4444;
  color: #ffffff;
}

.action-btn.replay {
  background: rgba(255, 255, 255, 0.1);
  color: #f8fafc;
  border-color: rgba(255, 255, 255, 0.2);
}
.action-btn.replay:hover {
  background: rgba(255, 255, 255, 0.25);
}

.info-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(56, 189, 248, 0.1);
  border: 1px solid rgba(56, 189, 248, 0.25);
}

.info-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.info-text {
  font-size: 12px;
  line-height: 1.4;
  color: #cbd5e1;
}

.studio-settings-col {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.settings-group {
  padding: 14px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.group-header {
  margin-bottom: 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.group-header h3 {
  font-size: 13px;
  font-weight: 700;
  color: #f1f5f9;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.slider-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.slider-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.slider-label-row label {
  font-size: 11.5px;
  font-weight: 600;
  color: #94a3b8;
}

.value-tag {
  font-size: 11px;
  font-weight: 700;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.15);
  padding: 1px 6px;
  border-radius: 4px;
}

.glass-slider {
  width: 100%;
  accent-color: #38bdf8;
  cursor: pointer;
}

.glass-select {
  width: 100%;
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #ffffff;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(15, 23, 42, 0.8);
}

.footer-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.save-toast {
  color: #4ade80;
  font-size: 12px;
  font-weight: 700;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
