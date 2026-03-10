<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../stores/settings';
import CasparConfigModal from './CasparConfigModal.vue';
import { casparPlayoutService } from '../services/caspar';
import { obsPlayoutService } from '../services/obs';
import type { PlayoutService } from '../services/playout';

const props = defineProps({
  isOpen: Boolean
});

const emit = defineEmits(['close']);
const settings = useSettingsStore();
const showCasparConfigurator = ref(false);

// Local shadow state so we don't mutate Pinia instantly on every keystroke
const localState = ref({
    playoutEngine: 'obs' as 'obs' | 'casparcg',
    obsUrl: '',
    obsPassword: '',
    localMediaPath: '',
    complianceUrl: '',
    logosPath: '',
    decklinkOutputName: '',
    liveInputSourceName: '',
    casparConfigPath: '',
    casparOscPort: 6250,
    playoutProfile: 'PAL_1080I50' as 'PAL_1080I50' | 'PAL_1080P25',
    transitionFrames: 2,
    prerollFrames: 2,
    watermarkPath: '',
    watermarkEnabled: false,
    watermarkPosition: 'top-right' as 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
    watermarkOpacity: 80,
    watermarkScale: 15
});

const availableOutputs = ref<any[]>([]);
const availableInputs = ref<any[]>([]);

const getModalPlayoutService = (): PlayoutService => (
    localState.value.playoutEngine === 'casparcg' ? casparPlayoutService : obsPlayoutService
);

const fetchOutputs = async () => {
    try {
        availableOutputs.value = await (getModalPlayoutService().getOutputs?.() || Promise.resolve([]));
    } catch {}
};

const fetchInputs = async () => {
    try {
        availableInputs.value = await (getModalPlayoutService().getInputs?.() || Promise.resolve([]));
    } catch {}
};

watch(() => props.isOpen, (open) => {
    if (open) {
        if (localState.value.playoutEngine === 'obs') {
            fetchOutputs();
            fetchInputs();
        }
    }
});

watch(() => localState.value.playoutEngine, (engine) => {
    if (engine === 'obs' && props.isOpen) {
        fetchOutputs();
        fetchInputs();
        return;
    }

    availableOutputs.value = [];
    availableInputs.value = [];
});

onMounted(() => {
    localState.value = {
        playoutEngine: settings.playoutEngine,
        obsUrl: settings.obsUrl,
        obsPassword: settings.obsPassword,
        localMediaPath: settings.localMediaPath,
        complianceUrl: settings.complianceUrl,
        logosPath: settings.logosPath,
        decklinkOutputName: settings.decklinkOutputName,
        liveInputSourceName: settings.liveInputSourceName,
        casparConfigPath: settings.casparConfigPath,
        casparOscPort: settings.casparOscPort,
        playoutProfile: settings.playoutProfile,
        transitionFrames: settings.transitionFrames,
        prerollFrames: settings.prerollFrames,
        watermarkPath: settings.watermarkPath,
        watermarkEnabled: settings.watermarkEnabled,
        watermarkPosition: settings.watermarkPosition,
        watermarkOpacity: settings.watermarkOpacity,
        watermarkScale: settings.watermarkScale
    };

    if (!settings.logosPath) {
        invoke<string | null>('find_default_logos_dir')
            .then((path) => {
                if (path && !localState.value.logosPath) {
                    localState.value.logosPath = path;
                }
            })
            .catch(() => {});
    }
});

const saveSettings = async () => {
    const service = getModalPlayoutService();
    settings.updateSettings(localState.value);
    if (localState.value.playoutEngine === 'casparcg') {
        try {
            await invoke('configure_caspar_osc_listener', { port: localState.value.casparOscPort });
        } catch {}
    }
    try {
        await service.syncLiveInputScene?.(localState.value.liveInputSourceName);
    } catch {}
    try {
        await service.syncBrandingAssets?.();
    } catch {}
    emit('close');
};

const discardAndClose = () => {
    localState.value = {
        playoutEngine: settings.playoutEngine,
        obsUrl: settings.obsUrl,
        obsPassword: settings.obsPassword,
        localMediaPath: settings.localMediaPath,
        complianceUrl: settings.complianceUrl,
        logosPath: settings.logosPath,
        decklinkOutputName: settings.decklinkOutputName,
        liveInputSourceName: settings.liveInputSourceName,
        casparConfigPath: settings.casparConfigPath,
        casparOscPort: settings.casparOscPort,
        playoutProfile: settings.playoutProfile,
        transitionFrames: settings.transitionFrames,
        prerollFrames: settings.prerollFrames,
        watermarkPath: settings.watermarkPath,
        watermarkEnabled: settings.watermarkEnabled,
        watermarkPosition: settings.watermarkPosition,
        watermarkOpacity: settings.watermarkOpacity,
        watermarkScale: settings.watermarkScale
    };
    emit('close');
};

const pickPath = async (target: 'media' | 'watermark' | 'logos') => {
    const isDirectory = target !== 'watermark';
    const defaultPath = target === 'media'
        ? localState.value.localMediaPath
        : target === 'logos'
            ? localState.value.logosPath
            : localState.value.watermarkPath;

    const selection = await open({
        title: target === 'media'
            ? 'Choose Media Folder'
            : target === 'logos'
                ? 'Choose Logos Folder'
                : 'Choose Watermark File',
        multiple: false,
        directory: isDirectory,
        defaultPath: defaultPath || undefined,
        filters: isDirectory
            ? undefined
            : [{ name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] }]
    });

    if (!selection || Array.isArray(selection)) return;

    if (target === 'media') localState.value.localMediaPath = selection;
    if (target === 'watermark') localState.value.watermarkPath = selection;
    if (target === 'logos') localState.value.logosPath = selection;
};
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="modal-backdrop" @click.self="discardAndClose">
      <div class="glass-panel modal-content">
        <div class="modal-header">
          <h2 class="text-accent">System Configuration</h2>
          <button class="glass-btn btn-icon" @click="discardAndClose">✕</button>
        </div>

        <div class="modal-body custom-scroll">
          <section class="settings-section">
              <h3 class="text-secondary section-title">Playout Engine</h3>
              <div class="form-grid">
                  <div class="form-group">
                      <label>Active Engine</label>
                      <select class="glass-input" v-model="localState.playoutEngine">
                          <option value="obs">OBS Studio</option>
                          <option value="casparcg">CasparCG</option>
                      </select>
                      <span class="hint-text">Switches the app between OBS WebSocket control and CasparCG AMCP control.</span>
                  </div>
                  <div class="form-group">
                      <label>Engine Notes</label>
                      <div class="hint-card">
                          <template v-if="localState.playoutEngine === 'obs'">
                              OBS mode keeps preview snapshots, streaming, DeckLink output control, and branding sync enabled.
                          </template>
                          <template v-else>
                              CasparCG mode uses localhost AMCP on port 5250 and listens for OSC feedback on the configured UDP port below. That port must match your CasparCG OSC predefined-client entry.
                          </template>
                      </div>
                  </div>
              </div>
          </section>

          <!-- OBS Connection Settings -->
          <section v-if="localState.playoutEngine === 'obs'" class="settings-section">
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
                      <button class="glass-btn" style="flex-shrink: 0;" title="Browse folders" @click="pickPath('media')">📁</button>
                  </div>
                  <span class="hint-text">Absolute path where raw .mp4/.mxf files reside.</span>
              </div>
              
              <div v-if="localState.playoutEngine === 'obs'" class="form-group">
                  <label>Compliance Overlay Host URL</label>
                  <input type="text" class="glass-input" v-model="localState.complianceUrl" placeholder="http://localhost/greek_ratings.html">
                  <span class="hint-text">The HTTP address OBS will use for the NCRTV graphic Browser Source.</span>
              </div>

              <div class="form-group">
                  <label>Logos / Ratings Folder</label>
                  <div class="input-with-button">
                      <input type="text" class="glass-input" v-model="localState.logosPath" placeholder="C:/PlayOut/logos">
                      <button class="glass-btn" style="flex-shrink: 0;" title="Browse logos folder" @click="pickPath('logos')">📁</button>
                  </div>
                  <span class="hint-text">Expected assets: logo.png, K.png, 8.png, 12.png, 16.png, 18.png.</span>
              </div>
          </section>

          <!-- Hardware Output -->
          <section v-if="localState.playoutEngine === 'obs'" class="settings-section">
              <h3 class="text-secondary section-title">Hardware Output (DeckLink/NDI)</h3>
              <div class="form-group">
                  <label>Target Hardware Output</label>
                  <div style="display:flex; gap: 8px;">
                      <select class="glass-input" v-model="localState.decklinkOutputName" style="flex:1;">
                          <option value="">None / Disabled</option>
                          <option v-for="out in availableOutputs" :key="out.outputName" :value="out.outputName">
                              {{ out.outputName }} ({{ out.outputKind }})
                          </option>
                      </select>
                      <button class="glass-btn" @click="fetchOutputs" title="Refresh Outputs" style="flex-shrink:0;">↻</button>
                  </div>
                  <span class="hint-text">Select a DeckLink or NDI output to allow SDI Out toggling in the main interface.</span>
              </div>
          </section>

          <section class="settings-section">
              <h3 class="text-secondary section-title">{{ localState.playoutEngine === 'obs' ? 'Live Rebroadcast / DeckLink Input' : 'CasparCG Live Route' }}</h3>
              <div class="form-group" v-if="localState.playoutEngine === 'obs'">
                  <label>OBS Input Source for Live Rebroadcast</label>
                  <div style="display:flex; gap: 8px;">
                      <select class="glass-input" v-model="localState.liveInputSourceName" style="flex:1;">
                          <option value="">None selected</option>
                          <option v-for="input in availableInputs" :key="input.inputUuid || input.inputName" :value="input.inputName">
                              {{ input.inputName }} ({{ input.inputKind }})
                          </option>
                      </select>
                      <button class="glass-btn" @click="fetchInputs" title="Refresh Inputs" style="flex-shrink:0;">↻</button>
                  </div>
                  <span class="hint-text">Choose the OBS input that represents your DeckLink ingest or live rebroadcast source.</span>
              </div>
              <div class="form-group" v-else>
                  <label>CasparCG source / route</label>
                  <input type="text" class="glass-input" v-model="localState.liveInputSourceName" placeholder="decklink://device/1 or ROUTE 2-10">
                  <span class="hint-text">Used by the CasparCG engine for LIVE NOW and live rundown items. Enter the route or source token that your channel expects.</span>
              </div>
          </section>

          <section v-if="localState.playoutEngine === 'casparcg'" class="settings-section">
              <h3 class="text-secondary section-title">CasparCG Server Configuration</h3>
              <div class="form-grid">
                  <div class="form-group">
                      <label>OSC Feedback Port</label>
                      <input type="number" min="1" max="65535" class="glass-input" v-model.number="localState.casparOscPort" placeholder="6250">
                      <span class="hint-text">Must match the UDP port in CasparCG &lt;predefined-client&gt; for this workstation, for example 5253.</span>
                  </div>
                  <div class="form-group">
                      <label>OSC Wiring</label>
                      <div class="hint-card">CasparCG sends OSC to the client. The app listens locally on this port, similar to CGTimer, and accepts both classic foreground messages and newer stage/layer timing messages.</div>
                  </div>
              </div>
              <div class="form-group">
                  <label>casparcg.config Path</label>
                  <input type="text" class="glass-input" v-model="localState.casparConfigPath" placeholder="C:/CasparCG/casparcg.config">
                  <span class="hint-text">The configurator can load and save your CasparCG XML file directly.</span>
              </div>
              <div class="form-group">
                  <button class="glass-btn btn-primary" @click="showCasparConfigurator = true">Open CasparCG Configurator</button>
                  <span class="hint-text">Structured editing covers channels, screen consumers, system audio, DeckLink outputs, OSC, controllers, and paths. Raw XML mode handles everything else.</span>
              </div>
          </section>

          <section class="settings-section">
              <h3 class="text-secondary section-title">PAL / SOTA Playout Timing</h3>
              <div class="form-grid">
                  <div class="form-group">
                      <label>Playout Profile</label>
                      <select class="glass-input" v-model="localState.playoutProfile">
                          <option value="PAL_1080I50">PAL 1080i50</option>
                          <option value="PAL_1080P25">PAL 1080p25</option>
                      </select>
                  </div>
                  <div class="form-group">
                      <label>Transition Length — {{ localState.transitionFrames }} frames</label>
                      <input type="range" min="1" max="10" v-model.number="localState.transitionFrames" style="accent-color:var(--accent-blue,#33becc);">
                  </div>
                  <div class="form-group">
                      <label>Pre-roll Buffer — {{ localState.prerollFrames }} frames</label>
                      <input type="range" min="1" max="12" v-model.number="localState.prerollFrames" style="accent-color:var(--accent-blue,#33becc);">
                  </div>
                  <div class="form-group">
                      <label>Operator Guidance</label>
                      <div class="hint-card">Use 2-frame transitions and 2–4 frames of preroll for low-latency 1080i/25 playout into DeckLink output.</div>
                  </div>
              </div>
          </section>

          <!-- TV Station Watermark / Bug -->
          <section v-if="localState.playoutEngine === 'obs'" class="settings-section">
              <h3 class="text-secondary section-title">📺 Station Watermark / Bug</h3>
              <div class="form-group">
                  <label>Logo Image Path (PNG/SVG on disk)</label>
                  <div class="input-with-button">
                      <input type="text" class="glass-input" v-model="localState.watermarkPath" placeholder="C:/Logos/station_logo.png">
                      <button class="glass-btn" style="flex-shrink: 0;" title="Browse files" @click="pickPath('watermark')">📁</button>
                  </div>
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

        <CasparConfigModal
            :is-open="showCasparConfigurator"
            :initial-path="localState.casparConfigPath"
            @close="showCasparConfigurator = false"
            @update:path="(value) => { localState.casparConfigPath = value; }"
        />
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10000;
}

.modal-content {
    width: 600px;
    max-width: 90vw;
    display: flex;
    flex-direction: column;
    padding: 0; /* Override glass-panel default padding */
    background: var(--bg-secondary);
    box-shadow: 0 24px 64px rgba(0,0,0,0.8);
    border: 1px solid var(--glass-border);
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
    border-bottom: 1px solid var(--glass-border);
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
    color: var(--text-secondary);
    opacity: 0.6;
    margin-top: 0.4rem;
}

.hint-card {
    min-height: 42px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.04);
    color: var(--text-secondary);
    font-size: 0.78rem;
    padding: 10px 12px;
}

.modal-footer {
    padding: 1.25rem 1.5rem;
    border-top: 1px solid var(--glass-border);
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    background: var(--bg-primary);
    border-bottom-left-radius: 12px;
    border-bottom-right-radius: 12px;
    opacity: 0.95;
}

.glass-btn {
    padding: 8px 16px;
    border-radius: 6px;
    background: var(--bg-tertiary);
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
