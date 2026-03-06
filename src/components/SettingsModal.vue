<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useSettingsStore } from '../stores/settings';

const props = defineProps({
  isOpen: Boolean
});

const emit = defineEmits(['close']);
const settings = useSettingsStore();

// Local shadow state so we don't mutate Pinia instantly on every keystroke
const localState = ref({
    obsUrl: '',
    obsPassword: '',
    localMediaPath: '',
    complianceUrl: '',
    watermarkPath: '',
    watermarkEnabled: false,
    watermarkPosition: 'top-right' as 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
    watermarkOpacity: 80,
    watermarkScale: 15
});

onMounted(() => {
    localState.value = {
        obsUrl: settings.obsUrl,
        obsPassword: settings.obsPassword,
        localMediaPath: settings.localMediaPath,
        complianceUrl: settings.complianceUrl,
        watermarkPath: settings.watermarkPath,
        watermarkEnabled: settings.watermarkEnabled,
        watermarkPosition: settings.watermarkPosition,
        watermarkOpacity: settings.watermarkOpacity,
        watermarkScale: settings.watermarkScale
    };
});

const saveSettings = () => {
    settings.updateSettings(localState.value);
    emit('close');
};

const discardAndClose = () => {
    localState.value = {
        obsUrl: settings.obsUrl,
        obsPassword: settings.obsPassword,
        localMediaPath: settings.localMediaPath,
        complianceUrl: settings.complianceUrl,
        watermarkPath: settings.watermarkPath,
        watermarkEnabled: settings.watermarkEnabled,
        watermarkPosition: settings.watermarkPosition,
        watermarkOpacity: settings.watermarkOpacity,
        watermarkScale: settings.watermarkScale
    };
    emit('close');
};
</script>

<template>
  <div v-if="isOpen" class="modal-backdrop">
    <div class="glass-panel modal-content">
      <div class="modal-header">
        <h2 class="text-accent">System Configuration</h2>
        <button class="glass-btn btn-icon" @click="discardAndClose">✕</button>
      </div>

      <div class="modal-body">
        <!-- OBS Connection Settings -->
        <section class="settings-section">
            <h3 class="text-secondary section-title">OBS WebSocket v5</h3>
            <div class="form-grid">
                <div class="form-group">
                    <label>Server URL / IP</label>
                    <input type="text" class="glass-input" v-model="localState.obsUrl" placeholder="ws://127.0.0.1:4455">
                </div>
                <div class="form-group">
                    <label>Authentication Password</label>
                    <input type="password" class="glass-input" v-model="localState.obsPassword" placeholder="(Optional for local)">
                </div>
            </div>
        </section>

        <!-- Media & Assets Paths -->
        <section class="settings-section">
            <h3 class="text-secondary section-title">External Assets</h3>
            <div class="form-group">
                <label>Local Video Root Directory</label>
                <div class="input-with-button">
                    <input type="text" class="glass-input" v-model="localState.localMediaPath" placeholder="C:/Media">
                    <!-- A native OS folder dialog could be hooked here via Tauri -->
                    <button class="glass-btn" style="flex-shrink: 0;" title="Browse (Requires Tauri File Dialog Plugin)">📁</button>
                </div>
                <span class="hint-text">Absolute path where raw .mp4/.mxf files reside.</span>
            </div>
            
            <div class="form-group">
                <label>Compliance Overlay Host URL</label>
                <input type="text" class="glass-input" v-model="localState.complianceUrl" placeholder="http://localhost/greek_ratings.html">
                <span class="hint-text">The HTTP address OBS will use for the NCRTV graphic Browser Source.</span>
            </div>
        </section>

        <!-- TV Station Watermark / Bug -->
        <section class="settings-section">
            <h3 class="text-secondary section-title">📺 Station Watermark / Bug</h3>
            <div class="form-group">
                <label>Logo Image Path (PNG/SVG on disk)</label>
                <input type="text" class="glass-input" v-model="localState.watermarkPath" placeholder="C:/Logos/station_logo.png">
                <span class="hint-text">OBS will load this as an Image Source overlay on all scenes.</span>
            </div>
            <div class="form-grid">
                <div class="form-group">
                    <label>Position</label>
                    <select class="glass-input" v-model="localState.watermarkPosition">
                        <option value="top-left">Top Left</option>
                        <option value="top-right">Top Right</option>
                        <option value="bottom-left">Bottom Left</option>
                        <option value="bottom-right">Bottom Right</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Scale (% of frame width) — {{ localState.watermarkScale }}%</label>
                    <input type="range" min="3" max="40" v-model.number="localState.watermarkScale" style="accent-color:var(--accent-blue,#33becc);">
                </div>
                <div class="form-group">
                    <label>Opacity — {{ localState.watermarkOpacity }}%</label>
                    <input type="range" min="10" max="100" v-model.number="localState.watermarkOpacity" style="accent-color:var(--accent-blue,#33becc);">
                </div>
                <div class="form-group" style="justify-content:center; padding-top:1rem;">
                    <label style="display:flex; gap:8px; align-items:center; cursor:pointer;">
                        <input type="checkbox" v-model="localState.watermarkEnabled">
                        Enable Permanent Watermark
                    </label>
                </div>
            </div>
        </section>
      </div>

      <div class="modal-footer">
        <button class="glass-btn" @click="discardAndClose">Cancel</button>
        <button class="glass-btn btn-primary" @click="saveSettings">Save Configuration</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 9999;
}

.modal-content {
    width: 600px;
    max-width: 90vw;
    display: flex;
    flex-direction: column;
    padding: 0; /* Override glass-panel default padding */
    box-shadow: 0 24px 48px rgba(0,0,0,0.5);
    border: 1px solid rgba(255, 255, 255, 0.1);
}

.modal-header {
    padding: 1.5rem;
    border-bottom: 1px solid var(--glass-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.modal-header h2 {
    margin: 0;
    font-size: 1.25rem;
}

.modal-body {
    padding: 1.5rem;
    overflow-y: auto;
    max-height: 60vh;
}

.settings-section {
    margin-bottom: 2rem;
}

.settings-section:last-child {
    margin-bottom: 0;
}

.section-title {
    margin-bottom: 1rem;
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    padding-bottom: 0.5rem;
}

.form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
}

.form-group {
    display: flex;
    flex-direction: column;
    margin-bottom: 1rem;
}

.form-group label {
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin-bottom: 0.4rem;
}

.input-with-button {
    display: flex;
    gap: 0.5rem;
}

.input-with-button .glass-input {
    flex-grow: 1;
}

.hint-text {
    font-size: 0.75rem;
    color: rgba(255,255,255,0.4);
    margin-top: 0.4rem;
}

.modal-footer {
    padding: 1.25rem 1.5rem;
    border-top: 1px solid var(--glass-border);
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    background: rgba(0,0,0,0.2);
    border-bottom-left-radius: 12px;
    border-bottom-right-radius: 12px;
}

.glass-btn {
    padding: 8px 16px;
    border-radius: 6px;
    background: rgba(255,255,255,0.05);
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
    cursor: pointer;
    transition: all 0.2s;
}

.glass-btn:hover {
    background: rgba(255,255,255,0.1);
}

.btn-primary {
    background: rgba(51, 190, 204, 0.15);
    border-color: rgba(51, 190, 204, 0.4);
    color: var(--accent-blue);
    font-weight: 500;
}

.btn-primary:hover {
    background: rgba(51, 190, 204, 0.25);
    border-color: var(--accent-blue);
}

.btn-icon {
    padding: 4px 8px;
    font-size: 1.2rem;
    background: transparent;
    border-color: transparent;
}
.btn-icon:hover {
    background: rgba(255,255,255,0.1);
}
</style>
