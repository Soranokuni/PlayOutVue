<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const settings = useSettingsStore();

interface ConfigSummary {
  path: string;
  videoMode: string;
  decklinkDevices: number[];
  channelCount: number;
}

const configPath = ref('');
const configLoaded = ref(false);
const configSummary = ref<ConfigSummary | null>(null);
const loading = ref(false);
const applying = ref(false);
const testing = ref(false);
const errorMessage = ref('');
const statusMessage = ref('');

const activeStep = ref(1);
const totalSteps = 5;

const outputDevice = ref(1);
const outputKeyDevice = ref(0);
const outputEmbeddedAudio = ref(false);
const outputBufferDepth = ref(3);
const outputLatency = ref<'normal' | 'low' | 'default'>('normal');
const outputKeyer = ref<'external' | 'external_separate_device' | 'internal' | 'default'>('external');

const hasLiveInput = ref(false);
const inputDevice = ref(1);

const videoMode = ref('1080i5000');
const testResult = ref('');

const videoModeOptions = [
  { value: '1080i5000', label: '1080i50 (PAL)' },
  { value: '1080p2500', label: '1080p25' },
  { value: '1080p3000', label: '1080p30' },
  { value: '1080p5000', label: '1080p50' },
  { value: '1080p5994', label: '1080p59.94' },
  { value: '1080p6000', label: '1080p60' },
  { value: '720p5000', label: '720p50' },
  { value: '720p5994', label: '720p59.94' },
  { value: '720p6000', label: '720p60' },
  { value: '2160p2500', label: '2160p25' },
  { value: '2160p5000', label: '2160p50' },
];

const deviceOptions = [1, 2, 3, 4, 5, 6, 7, 8];
const bufferOptions = [1, 2, 3, 4, 5, 6, 7];

const canGoNext = computed(() => {
  if (activeStep.value === 1) return configLoaded.value && !!configPath.value.trim() && !errorMessage.value;
  if (activeStep.value === 2) return outputDevice.value >= 1 && outputDevice.value <= 8;
  if (activeStep.value === 3) return !hasLiveInput.value || (inputDevice.value >= 1 && inputDevice.value <= 8 && inputDevice.value !== outputDevice.value);
  if (activeStep.value === 4) return !!videoMode.value.trim();
  return true;
});

const stepTitle = computed(() => {
  const titles: Record<number, string> = {
    1: 'Load Configuration',
    2: 'Program Output (SDI)',
    3: 'Live Input (SDI)',
    4: 'Video Standard',
    5: 'Review & Apply',
  };
  return titles[activeStep.value] || '';
});

const outputDeviceLabel = computed(() => `DeckLink ${outputDevice.value}`);
const inputDeviceLabel = computed(() => `DeckLink ${inputDevice.value}`);

const routingSummary = computed(() => {
  if (!hasLiveInput.value) return null;
  return `Input DeckLink ${inputDevice.value} → Channel 1 → Output DeckLink ${outputDevice.value}`;
});

const changesList = computed(() => {
  const changes: string[] = [];
  changes.push(`Config file: ${configPath.value}`);
  changes.push(`Channel 1 video mode: ${videoMode.value}`);
  changes.push(`Output: DeckLink ${outputDevice.value} (audio: ${outputEmbeddedAudio.value ? 'embedded' : 'system'}, buffer: ${outputBufferDepth.value}, latency: ${outputLatency.value}, keyer: ${outputKeyer.value})`);
  if (outputKeyDevice.value > 0) {
    changes.push(`Key output: DeckLink ${outputKeyDevice.value}`);
  }
  if (hasLiveInput.value) {
    changes.push(`Live input: DeckLink ${inputDevice.value} (rebroadcast to DeckLink ${outputDevice.value})`);
  } else {
    changes.push('Live input: disabled');
  }
  return changes;
});

const loadConfig = async (path?: string) => {
  loading.value = true;
  errorMessage.value = '';
  statusMessage.value = '';
  try {
    const result = await invoke<{ path: string; raw_xml: string; config: any }>('load_caspar_config', {
      path: path || configPath.value.trim() || null,
    });
    configPath.value = result.path;
    configLoaded.value = true;

    const cfg = result.config as any;
    const decklinkDevices: number[] = [];
    let vidMode = '1080i5000';
    let channelCount = 0;

    if (cfg.channels?.channels && Array.isArray(cfg.channels.channels)) {
      channelCount = cfg.channels.channels.length;
      const ch1 = cfg.channels.channels[0];
      if (ch1) {
        vidMode = ch1.video_mode || vidMode;
        if (ch1.consumers?.decklinks && Array.isArray(ch1.consumers.decklinks)) {
          for (const dl of ch1.consumers.decklinks) {
            if (dl.device) decklinkDevices.push(Number(dl.device));
            if (dl.buffer_depth) outputBufferDepth.value = Number(dl.buffer_depth);
            if (dl.latency) outputLatency.value = dl.latency as typeof outputLatency.value;
            if (dl.keyer) outputKeyer.value = dl.keyer as typeof outputKeyer.value;
            if (dl.embedded_audio !== undefined) outputEmbeddedAudio.value = !!dl.embedded_audio;
            if (dl.key_device) outputKeyDevice.value = Number(dl.key_device);
          }
        }
      }
    }

    if (decklinkDevices.length > 0) {
      outputDevice.value = decklinkDevices[0]!;
    }
    videoMode.value = vidMode;
    inputDevice.value = settings.decklinkInputDevice || 1;
    hasLiveInput.value = settings.decklinkInputDevice > 0;

    configSummary.value = {
      path: result.path,
      videoMode: vidMode,
      decklinkDevices,
      channelCount,
    };

    statusMessage.value = 'Configuration loaded successfully.';
  } catch (error) {
    errorMessage.value = String(error || 'Failed to load configuration');
  } finally {
    loading.value = false;
  }
};

const pickConfigPath = async () => {
  const selection = await open({
    title: 'Choose casparcg.config',
    multiple: false,
    directory: false,
    defaultPath: configPath.value || undefined,
    filters: [
      { name: 'CasparCG Config', extensions: ['config', 'xml'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!selection || Array.isArray(selection)) return;
  configPath.value = selection;
  await loadConfig(selection);
};

const testConnection = async () => {
  testing.value = true;
  errorMessage.value = '';
  testResult.value = '';
  try {
    const result = await invoke<string>('caspar_test_connection');
    testResult.value = `Connected: ${result.split('\n')[0] || 'OK'}`;
  } catch (error) {
    testResult.value = '';
    errorMessage.value = `Connection test failed: ${String(error)}`;
  } finally {
    testing.value = false;
  }
};

const applyConfig = async () => {
  applying.value = true;
  errorMessage.value = '';
  statusMessage.value = '';
  try {
    const result = await invoke<{ backup_path: string; raw_xml: string; channel_index: number; output_device: number }>(
      'apply_caspar_decklink_config',
      {
        payload: {
          path: configPath.value,
          channelIndex: 0,
          outputDevice: outputDevice.value,
          keyDevice: outputKeyDevice.value > 0 ? outputKeyDevice.value : null,
          embeddedAudio: outputEmbeddedAudio.value,
          bufferDepth: outputBufferDepth.value,
          latency: outputLatency.value,
          keyer: outputKeyer.value,
          videoMode: videoMode.value,
        },
      }
    );

    settings.updateSettings({
      casparConfigPath: configPath.value,
      decklinkOutputName: `DeckLink ${outputDevice.value}`,
      decklinkOutputDevice: outputDevice.value,
      decklinkInputDevice: hasLiveInput.value ? inputDevice.value : 0,
      liveInputSourceName: hasLiveInput.value ? `decklink://device/${inputDevice.value}` : '',
      decklinkEmbeddedAudio: outputEmbeddedAudio.value,
      decklinkBufferDepth: outputBufferDepth.value,
      decklinkLatency: outputLatency.value,
      decklinkKeyer: outputKeyer.value,
      decklinkKeyDevice: outputKeyDevice.value,
    });

    statusMessage.value = `Configuration applied. Backup saved to ${result.backup_path}.`;
    setTimeout(() => emit('close'), 1500);
  } catch (error) {
    errorMessage.value = String(error || 'Failed to apply configuration');
  } finally {
    applying.value = false;
  }
};

const goToStep = (step: number) => {
  if (step < 1 || step > totalSteps) return;
  if (step > activeStep.value && !canGoNext.value) return;
  activeStep.value = step;
  errorMessage.value = '';
  statusMessage.value = '';
};

const goNext = () => goToStep(activeStep.value + 1);
const goPrev = () => goToStep(activeStep.value - 1);

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      activeStep.value = 1;
      errorMessage.value = '';
      statusMessage.value = '';
      testResult.value = '';
      configLoaded.value = false;
      configSummary.value = null;

      const storedOutput = settings.decklinkOutputDevice;
      if (storedOutput > 0) outputDevice.value = storedOutput;
      const storedInput = settings.decklinkInputDevice;
      inputDevice.value = storedInput > 0 ? storedInput : 1;
      hasLiveInput.value = storedInput > 0;
      outputEmbeddedAudio.value = settings.decklinkEmbeddedAudio;
      outputBufferDepth.value = settings.decklinkBufferDepth || 3;
      outputLatency.value = settings.decklinkLatency || 'normal';
      outputKeyer.value = settings.decklinkKeyer || 'external';
      outputKeyDevice.value = settings.decklinkKeyDevice || 0;

      if (settings.casparConfigPath) {
        configPath.value = settings.casparConfigPath;
        loadConfig();
      } else {
        invoke<string | null>('find_default_caspar_config')
          .then((path) => {
            if (path) {
              configPath.value = path;
              loadConfig();
            }
          })
          .catch(() => {});
      }
    }
  }
);
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="modal-backdrop" @click.self="$emit('close')">
      <div class="glass-panel modal-content">
        <div class="modal-header">
          <div>
            <h2 class="text-accent">DeckLink Output Wizard</h2>
            <p class="subtitle">Step-by-step CasparCG DeckLink configuration for broadcast output.</p>
          </div>
          <button class="glass-btn btn-icon" @click="$emit('close')" :disabled="applying">✕</button>
        </div>

        <div class="step-indicator">
          <button
            v-for="step in totalSteps"
            :key="step"
            class="step-dot"
            :class="{
              active: step === activeStep,
              completed: step < activeStep,
            }"
            @click="goToStep(step)"
            :disabled="step > activeStep && !canGoNext"
          >
            {{ step }}
          </button>
        </div>

        <div class="modal-body custom-scroll">
          <div v-if="errorMessage" class="status error">{{ errorMessage }}</div>
          <div v-else-if="statusMessage" class="status ok">{{ statusMessage }}</div>

          <section v-if="activeStep === 1" class="wizard-section">
            <h3 class="section-title">Step 1: Load CasparCG Configuration</h3>
            <div class="form-group">
              <label>Configuration File Path</label>
              <div class="input-with-button">
                <input v-model="configPath" type="text" class="glass-input" placeholder="C:/CasparCG/casparcg.config" />
                <button class="glass-btn" @click="pickConfigPath">Browse</button>
                <button class="glass-btn" @click="loadConfig()" :disabled="loading || !configPath.trim()">{{ loading ? 'Loading…' : 'Load' }}</button>
              </div>
            </div>

            <div v-if="configSummary" class="summary-card">
              <div class="summary-row"><strong>File:</strong> {{ configSummary.path }}</div>
              <div class="summary-row"><strong>Channels:</strong> {{ configSummary.channelCount }}</div>
              <div class="summary-row"><strong>Channel 1 Video Mode:</strong> {{ configSummary.videoMode }}</div>
              <div class="summary-row">
                <strong>Channel 1 DeckLink Consumers:</strong>
                <span v-if="configSummary.decklinkDevices.length">{{ configSummary.decklinkDevices.map(d => `Device ${d}`).join(', ') }}</span>
                <span v-else class="text-muted">None configured</span>
              </div>
            </div>
          </section>

          <section v-if="activeStep === 2" class="wizard-section">
            <h3 class="section-title">Step 2: Program Output Device</h3>
            <p class="hint">Select the Blackmagic DeckLink device that will output your program feed.</p>

            <div class="form-grid two-col">
              <div class="form-group">
                <label>Output Device # (DeckLink)</label>
                <select v-model.number="outputDevice" class="glass-input">
                  <option v-for="d in deviceOptions" :key="d" :value="d">DeckLink {{ d }}</option>
                </select>
                <span class="hint-text">Physical DeckLink card device number (1–8)</span>
              </div>
              <div class="form-group">
                <label>Key Output Device #</label>
                <select v-model.number="outputKeyDevice" class="glass-input">
                  <option :value="0">None / Disabled</option>
                  <option v-for="d in deviceOptions" :key="'k' + d" :value="d">DeckLink {{ d }}</option>
                </select>
                <span class="hint-text">Separate device for fill+key output (0 = same device)</span>
              </div>
              <div class="form-group">
                <label>Buffer Depth</label>
                <select v-model.number="outputBufferDepth" class="glass-input">
                  <option v-for="b in bufferOptions" :key="b" :value="b">{{ b }}</option>
                </select>
                <span class="hint-text">Higher values = more stable, more latency</span>
              </div>
              <div class="form-group">
                <label>Latency</label>
                <select v-model="outputLatency" class="glass-input">
                  <option value="normal">Normal</option>
                  <option value="low">Low</option>
                  <option value="default">Default</option>
                </select>
              </div>
              <div class="form-group">
                <label>Keyer Mode</label>
                <select v-model="outputKeyer" class="glass-input">
                  <option value="external">External</option>
                  <option value="external_separate_device">External Separate Device</option>
                  <option value="internal">Internal</option>
                  <option value="default">Default</option>
                </select>
              </div>
              <div class="form-group" style="justify-content:center; padding-top:1rem;">
                <label style="display:flex; gap:8px; align-items:center;">
                  <input v-model="outputEmbeddedAudio" type="checkbox" />
                  <span>Embed Audio in SDI</span>
                </label>
                <span class="hint-text">When on, audio is embedded in the SDI stream</span>
              </div>
            </div>
          </section>

          <section v-if="activeStep === 3" class="wizard-section">
            <h3 class="section-title">Step 3: Live Input / Rebroadcast Source</h3>
            <p class="hint">Configure an SDI input for live rebroadcast. When a live rundown item plays, this input will be routed to the program output.</p>

            <div class="form-group">
              <label style="display:flex; gap:8px; align-items:center;">
                <input v-model="hasLiveInput" type="checkbox" />
                <span>Enable Live Rebroadcast Input</span>
              </label>
            </div>

            <template v-if="hasLiveInput">
              <div class="form-group">
                <label>Live Input Device # (DeckLink)</label>
                <select v-model.number="inputDevice" class="glass-input">
                  <option v-for="d in deviceOptions" :key="d" :value="d">DeckLink {{ d }}</option>
                </select>
                <span class="hint-text">The physical DeckLink input feeding your live signal</span>
              </div>

              <div v-if="inputDevice === outputDevice" class="status error">
                Input device must differ from output device ({{ outputDevice }}). Please choose a different device number.
              </div>

              <div v-else-if="routingSummary" class="routing-card">
                <div class="routing-row">
                  <span class="routing-label">Routing</span>
                  <span class="routing-path">{{ routingSummary }}</span>
                </div>
                <div class="routing-row">
                  <span class="routing-label">AMCP Command</span>
                  <code class="routing-cmd">PLAY 1-20 decklink://device/{{ inputDevice }}</code>
                </div>
              </div>
            </template>
          </section>

          <section v-if="activeStep === 4" class="wizard-section">
            <h3 class="section-title">Step 4: Video Standard</h3>
            <p class="hint">Set the video mode for Channel 1. Must match your broadcast infrastructure.</p>

            <div class="form-group">
              <label>Channel 1 Video Mode</label>
              <select v-model="videoMode" class="glass-input">
                <option v-for="opt in videoModeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
              <span class="hint-text">Matches the {{ videoMode.startsWith('1080i') ? 'interlaced PAL' : videoMode.startsWith('2160') ? '4K' : 'progressive scan' }} broadcast standard</span>
            </div>

            <div v-if="videoMode !== '1080i5000' && settings.playoutProfile !== 'PAL_1080I50'" class="status warn">
              The selected video mode ({{ videoMode }}) differs from your playout profile ({{ settings.playoutProfile }}). For PAL broadcast, 1080i5000 is recommended.
            </div>
          </section>

          <section v-if="activeStep === 5" class="wizard-section">
            <h3 class="section-title">Step 5: Review & Apply</h3>

            <div class="review-card">
              <div class="review-header">Configuration Summary</div>
              <ul class="review-list">
                <li v-for="(change, i) in changesList" :key="i">{{ change }}</li>
              </ul>
            </div>

            <div class="form-group" style="margin-top: 1rem;">
              <button class="glass-btn btn-test" @click="testConnection" :disabled="testing">
                {{ testing ? 'Testing…' : 'Test CasparCG Connection' }}
              </button>
              <span v-if="testResult" class="status ok inline">{{ testResult }}</span>
            </div>

            <div class="warn-card">
              This will rewrite your CasparCG configuration file. A timestamped backup will be created automatically.
            </div>
          </section>
        </div>

        <div class="modal-footer">
          <button v-if="activeStep > 1" class="glass-btn" @click="goPrev" :disabled="applying">Back</button>
          <div class="footer-spacer"></div>
          <button v-if="activeStep < totalSteps" class="glass-btn btn-primary" @click="goNext" :disabled="!canGoNext">Next</button>
          <button v-if="activeStep === totalSteps" class="glass-btn btn-apply" @click="applyConfig" :disabled="applying || !!errorMessage">
            {{ applying ? 'Applying…' : 'Apply & Save' }}
          </button>
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
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(8px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10000;
}

.modal-content {
  width: 620px;
  max-width: 92vw;
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  padding: 0;
  background: var(--bg-secondary);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.8);
  border: 1px solid var(--glass-border);
}

.modal-header {
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--glass-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.modal-header h2 {
  margin: 0;
  font-size: 1.2rem;
}

.subtitle {
  margin: 4px 0 0;
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.step-indicator {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding: 14px;
  border-bottom: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.02);
}

.step-dot {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 2px solid var(--glass-border);
  background: transparent;
  color: var(--text-secondary);
  font-weight: 700;
  font-size: 0.82rem;
  cursor: pointer;
  transition: all 0.2s;
}

.step-dot.active {
  border-color: var(--accent-blue);
  background: rgba(51, 190, 204, 0.15);
  color: var(--accent-blue);
  box-shadow: 0 0 12px rgba(51, 190, 204, 0.2);
}

.step-dot.completed {
  border-color: #4caf50;
  background: rgba(76, 175, 80, 0.12);
  color: #4caf50;
}

.step-dot:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.modal-body {
  padding: 1.25rem 1.5rem;
  overflow-y: auto;
  min-height: 200px;
}

.wizard-section {
  min-height: 180px;
}

.section-title {
  margin-bottom: 1rem;
  font-size: 0.9rem;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-secondary);
}

.hint {
  font-size: 0.78rem;
  color: var(--text-secondary);
  margin-bottom: 1rem;
}

.hint-text {
  font-size: 0.72rem;
  color: var(--text-secondary);
  opacity: 0.65;
  margin-top: 4px;
}

.text-muted {
  color: var(--text-secondary);
  opacity: 0.5;
}

.form-grid {
  display: grid;
  gap: 12px;
}

.form-grid.two-col {
  grid-template-columns: 1fr 1fr;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.form-group label {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.glass-input {
  background: var(--bg-tertiary);
  border: 1px solid var(--glass-border);
  color: var(--text-primary);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 0.82rem;
}

.input-with-button {
  display: flex;
  gap: 8px;
}

.input-with-button .glass-input {
  flex: 1;
}

.glass-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--text-primary);
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 0.8rem;
  white-space: nowrap;
  transition: all 0.15s;
}

.glass-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
}

.glass-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-primary {
  background: rgba(51, 190, 204, 0.15);
  border-color: rgba(51, 190, 204, 0.4);
  color: var(--accent-blue);
  font-weight: 600;
}

.btn-primary:hover:not(:disabled) {
  background: rgba(51, 190, 204, 0.25);
}

.btn-apply {
  background: rgba(76, 175, 80, 0.15);
  border-color: rgba(76, 175, 80, 0.4);
  color: #66bb6a;
  font-weight: 700;
}

.btn-apply:hover:not(:disabled) {
  background: rgba(76, 175, 80, 0.25);
  box-shadow: 0 0 16px rgba(76, 175, 80, 0.2);
}

.btn-test {
  background: rgba(248, 180, 0, 0.12);
  border-color: rgba(248, 180, 0, 0.35);
  color: var(--accent-yellow);
}

.btn-icon {
  padding: 4px 8px;
  font-size: 1.2rem;
}

.status {
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 0.78rem;
  margin-bottom: 12px;
}

.status.ok {
  background: rgba(29, 185, 84, 0.12);
  border: 1px solid rgba(29, 185, 84, 0.26);
  color: #66bb6a;
}

.status.ok.inline {
  display: inline-block;
  margin: 0 0 0 10px;
  padding: 4px 10px;
}

.status.error {
  background: rgba(230, 57, 70, 0.14);
  border: 1px solid rgba(230, 57, 70, 0.26);
  color: #f4a261;
}

.status.warn {
  background: rgba(248, 180, 0, 0.12);
  border: 1px solid rgba(248, 180, 0, 0.26);
  color: var(--accent-yellow);
  margin-top: 12px;
}

.summary-card {
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.03);
}

.summary-row {
  padding: 4px 0;
  font-size: 0.78rem;
  color: var(--text-primary);
}

.summary-row strong {
  color: var(--text-secondary);
  margin-right: 6px;
}

.routing-card {
  border: 1px solid rgba(51, 190, 204, 0.25);
  border-radius: 8px;
  padding: 12px;
  background: rgba(51, 190, 204, 0.06);
  margin-top: 8px;
}

.routing-row {
  display: flex;
  gap: 10px;
  padding: 4px 0;
  align-items: center;
}

.routing-label {
  font-size: 0.78rem;
  color: var(--text-secondary);
  min-width: 110px;
}

.routing-path {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--accent-blue);
}

.routing-cmd {
  font-family: 'Courier New', monospace;
  font-size: 0.78rem;
  background: rgba(0, 0, 0, 0.3);
  padding: 4px 8px;
  border-radius: 4px;
  color: #e0e0e0;
}

.review-card {
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  padding: 14px;
  background: rgba(255, 255, 255, 0.03);
}

.review-header {
  font-weight: 700;
  font-size: 0.85rem;
  margin-bottom: 10px;
  color: var(--text-primary);
}

.review-list {
  padding-left: 18px;
  display: grid;
  gap: 6px;
}

.review-list li {
  font-size: 0.78rem;
  color: var(--text-primary);
  line-height: 1.4;
}

.warn-card {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(248, 180, 0, 0.08);
  border: 1px solid rgba(248, 180, 0, 0.2);
  font-size: 0.76rem;
  color: var(--accent-yellow);
}

.modal-footer {
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--glass-border);
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-primary);
  opacity: 0.96;
}

.footer-spacer {
  flex: 1;
}

@media (max-width: 640px) {
  .form-grid.two-col {
    grid-template-columns: 1fr;
  }
}
</style>
