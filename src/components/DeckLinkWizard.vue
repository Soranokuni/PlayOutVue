<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{
  isOpen: boolean;
  initialPath?: string;
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

interface TemplateDeployResult {
  template_dir: string;
  deployed: string[];
  skipped: string[];
}

const configPath = ref('');
const configLoaded = ref(false);
const configSummary = ref<ConfigSummary | null>(null);
const loading = ref(false);
const applying = ref(false);
const testing = ref(false);
const deploying = ref(false);
const errorMessage = ref('');
const statusMessage = ref('');
const templateDeployResult = ref<TemplateDeployResult | null>(null);

const activeStep = ref(1);
const totalSteps = 5;

// Output configuration
const outputDevice = ref(1);
const outputKeyDevice = ref(0);
const outputEmbeddedAudio = ref(true);
const outputBufferDepth = ref(3);
const outputLatency = ref<'normal' | 'low' | 'default'>('normal');
const outputKeyer = ref<'external' | 'external_separate_device' | 'internal' | 'default'>('external');
const enableScreenConsumer = ref(true);

// Live Input configuration
const hasLiveInput = ref(false);
const inputDevice = ref(2);
const inputFormat = ref('1080i5000');
const customLiveRoute = ref('');

// Video standard
const videoMode = ref('1080i5000');
const testResult = ref('');

const videoModeOptions = [
  { value: '1080i5000', label: '1080i50 — PAL Broadcast (Standard in Greece & Europe)', badge: 'PAL 50Hz' },
  { value: '1080p2500', label: '1080p25 — PAL Progressive Full HD', badge: 'PAL 25Hz' },
  { value: '1080p5000', label: '1080p50 — High Frame Rate Progressive', badge: 'PAL 50p' },
  { value: '720p5000', label: '720p50 — HD Progressive', badge: '720p' },
  { value: '1080i5994', label: '1080i59.94 — NTSC Broadcast Standard', badge: 'NTSC' },
  { value: '1080p2997', label: '1080p29.97 — NTSC Progressive', badge: 'NTSC' },
  { value: '2160p5000', label: '2160p50 — 4K Ultra HD (PAL)', badge: '4K UHD' },
];

const deviceOptions = [1, 2, 3, 4, 5, 6, 7, 8];
const bufferOptions = [1, 2, 3, 4, 5, 6, 7];

const canGoNext = computed(() => {
  if (activeStep.value === 1) return configLoaded.value && !!configPath.value.trim() && !errorMessage.value;
  if (activeStep.value === 2) return !!videoMode.value.trim();
  if (activeStep.value === 3) return outputDevice.value >= 1 && outputDevice.value <= 8;
  if (activeStep.value === 4) return !hasLiveInput.value || (inputDevice.value >= 1 && inputDevice.value <= 8 && inputDevice.value !== outputDevice.value);
  return true;
});

const stepTitle = computed(() => {
  const titles: Record<number, string> = {
    1: 'CasparCG Configuration & Connection',
    2: 'Broadcast Video Standard',
    3: 'Program Output (SDI / HDMI)',
    4: 'Live Input & Rebroadcast',
    5: 'CG Templates, Review & Apply',
  };
  return titles[activeStep.value] || '';
});

const routingSummary = computed(() => {
  if (!hasLiveInput.value) return null;
  return `SDI In DeckLink ${inputDevice.value} → CasparCG Channel 1 (Live Layer 20) → Program Out DeckLink ${outputDevice.value}`;
});

const changesList = computed(() => {
  const changes: string[] = [];
  changes.push(`CasparCG XML: ${configPath.value}`);
  changes.push(`Video Standard: ${videoMode.value} (${videoMode.value.startsWith('1080i') ? '1080i50 Interlaced' : 'Progressive'})`);
  changes.push(`Program Out: DeckLink ${outputDevice.value} (Buffer: ${outputBufferDepth.value}, Audio: ${outputEmbeddedAudio.value ? 'SDI Embedded' : 'System'}, Latency: ${outputLatency.value})`);
  if (enableScreenConsumer.value) {
    changes.push(`Local Preview: Screen Consumer active (windowed preview for operator)`);
  }
  if (hasLiveInput.value) {
    changes.push(`Live Ingest: DeckLink ${inputDevice.value} (${inputFormat.value}) → Cut To Live active`);
  } else {
    changes.push('Live Ingest: Disabled');
  }
  changes.push('OSC Feedback: Port 6250 configured for real-time playout sync');
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
    inputDevice.value = settings.decklinkInputDevice > 0 && settings.decklinkInputDevice !== outputDevice.value
      ? settings.decklinkInputDevice
      : (outputDevice.value === 1 ? 2 : 1);
    hasLiveInput.value = settings.decklinkInputDevice > 0;
    inputFormat.value = settings.decklinkInputFormat || '1080i5000';
    customLiveRoute.value = settings.liveInputSourceName || '';

    configSummary.value = {
      path: result.path,
      videoMode: vidMode,
      decklinkDevices,
      channelCount,
    };

    statusMessage.value = 'Configuration file loaded successfully.';
  } catch (error) {
    errorMessage.value = String(error || 'Failed to load configuration');
  } finally {
    loading.value = false;
  }
};

const pickConfigPath = async () => {
  const selection = await open({
    title: 'Select casparcg.config',
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
    testResult.value = `Online: ${result.split('\n')[0] || '200 OK'}`;
  } catch (error) {
    testResult.value = '';
    errorMessage.value = `CasparCG Connection Test failed: ${String(error)}`;
  } finally {
    testing.value = false;
  }
};

const deployTemplates = async (overwrite: boolean = false) => {
  deploying.value = true;
  errorMessage.value = '';
  try {
    const parentDir = configPath.value ? configPath.value.replace(/\\/g, '/').replace(/\/[^/]+$/, '') : 'C:/CasparCG';
    const templateBase = `${parentDir}/template`;

    const res = await invoke<TemplateDeployResult>('deploy_caspar_templates', {
      templatePath: templateBase,
      overwrite,
    });
    templateDeployResult.value = res;
    statusMessage.value = `CG Templates deployed to ${res.template_dir}: ${res.deployed.length} installed, ${res.skipped.length} existing.`;
  } catch (error) {
    errorMessage.value = `Failed to deploy templates: ${String(error)}`;
  } finally {
    deploying.value = false;
  }
};

const applyConfig = async () => {
  applying.value = true;
  errorMessage.value = '';
  statusMessage.value = '';
  try {
    const parentDir = configPath.value ? configPath.value.replace(/\\/g, '/').replace(/\/[^/]+$/, '') : 'C:/CasparCG';
    const templateBase = `${parentDir}/template`;

    const result = await invoke<{ backup_path: string; raw_xml: string; channel_index: number; output_device: number; templates_deployed?: TemplateDeployResult }>(
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
          enableScreenConsumer: enableScreenConsumer.value,
          deployTemplates: true,
          templatePath: templateBase,
        },
      }
    );

    const liveSourceName = hasLiveInput.value
      ? (customLiveRoute.value.trim() || `PLAY 1-20 DECKLINK ${inputDevice.value} FORMAT ${inputFormat.value}`)
      : '';

    settings.updateSettings({
      casparConfigPath: configPath.value,
      decklinkOutputName: `DeckLink ${outputDevice.value}`,
      decklinkOutputDevice: outputDevice.value,
      decklinkInputDevice: hasLiveInput.value ? inputDevice.value : 0,
      decklinkInputFormat: inputFormat.value,
      liveInputSourceName: liveSourceName,
      decklinkEmbeddedAudio: outputEmbeddedAudio.value,
      decklinkBufferDepth: outputBufferDepth.value,
      decklinkLatency: outputLatency.value,
      decklinkKeyer: outputKeyer.value,
      decklinkKeyDevice: outputKeyDevice.value,
      playoutProfile: videoMode.value.startsWith('1080i') ? 'PAL_1080I50' : 'PAL_1080P25',
    });

    statusMessage.value = `Configuration applied successfully! Backup saved to ${result.backup_path}.`;
    setTimeout(() => emit('close'), 1800);
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
      inputDevice.value = storedInput > 0 ? storedInput : (storedOutput === 1 ? 2 : 1);
      hasLiveInput.value = storedInput > 0;
      inputFormat.value = settings.decklinkInputFormat || '1080i5000';
      customLiveRoute.value = settings.liveInputSourceName || '';
      outputEmbeddedAudio.value = settings.decklinkEmbeddedAudio !== false;
      outputBufferDepth.value = settings.decklinkBufferDepth || 3;
      outputLatency.value = settings.decklinkLatency || 'normal';
      outputKeyer.value = settings.decklinkKeyer || 'external';
      outputKeyDevice.value = settings.decklinkKeyDevice || 0;

      const initial = props.initialPath || settings.casparConfigPath;
      if (initial) {
        configPath.value = initial;
        loadConfig(initial);
      } else {
        invoke<string | null>('find_default_caspar_config')
          .then((path) => {
            if (path) {
              configPath.value = path;
              loadConfig(path);
            }
          })
          .catch(() => {});
      }
    }
  },
  { immediate: true }
);
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="modal-backdrop" data-command-scope="modal" @click.self="$emit('close')">
      <div class="glass-panel modal-content">
        <!-- Header -->
        <div class="modal-header">
          <div class="header-left">
            <span class="step-badge">STEP {{ activeStep }} OF {{ totalSteps }}</span>
            <h2 class="text-accent">{{ stepTitle }}</h2>
          </div>
          <button class="glass-btn btn-icon" @click="$emit('close')" :disabled="applying">✕</button>
        </div>

        <!-- Step Indicator Bar -->
        <div class="step-indicator">
          <div
            v-for="step in totalSteps"
            :key="step"
            class="step-item"
            :class="{ active: step === activeStep, completed: step < activeStep }"
            @click="goToStep(step)"
          >
            <div class="step-circle">{{ step }}</div>
            <span class="step-name">
              {{ step === 1 ? 'Server' : step === 2 ? 'Standard' : step === 3 ? 'Output' : step === 4 ? 'Live In' : 'Apply' }}
            </span>
          </div>
        </div>

        <!-- Body -->
        <div class="modal-body custom-scroll">
          <div v-if="errorMessage" class="status error">{{ errorMessage }}</div>
          <div v-else-if="statusMessage" class="status ok">{{ statusMessage }}</div>

          <!-- STEP 1: CasparCG Config & Connection -->
          <section v-if="activeStep === 1" class="wizard-section">
            <p class="section-desc">
              Locate your <code>casparcg.config</code> file. PlayOutVue will read and update the channel, DeckLink consumer, and OSC feedback settings automatically.
            </p>

            <div class="form-group">
              <label>CasparCG Configuration File</label>
              <div class="input-with-button">
                <input v-model="configPath" type="text" class="glass-input" placeholder="C:/CasparCG/casparcg.config" />
                <button class="glass-btn" @click="pickConfigPath">Browse…</button>
                <button class="glass-btn btn-primary" @click="loadConfig()" :disabled="loading || !configPath.trim()">
                  {{ loading ? 'Loading…' : 'Load Config' }}
                </button>
              </div>
            </div>

            <div v-if="configSummary" class="summary-card">
              <div class="summary-title">Configuration Summary</div>
              <div class="summary-grid">
                <div class="summary-item"><strong>Path:</strong> <code>{{ configSummary.path }}</code></div>
                <div class="summary-item"><strong>Channels:</strong> {{ configSummary.channelCount }}</div>
                <div class="summary-item"><strong>Channel 1 Video Standard:</strong> <span class="text-accent">{{ configSummary.videoMode }}</span></div>
                <div class="summary-item">
                  <strong>DeckLink Consumers:</strong>
                  <span v-if="configSummary.decklinkDevices.length">{{ configSummary.decklinkDevices.map(d => `Card ${d}`).join(', ') }}</span>
                  <span v-else class="text-muted">None (Will be configured)</span>
                </div>
              </div>
            </div>

            <!-- Connection Test -->
            <div class="connection-test-card">
              <div class="connection-info">
                <strong>CasparCG Server AMCP (Port 5250)</strong>
                <span>Verify that CasparCG Server is currently running.</span>
              </div>
              <button class="glass-btn btn-test" @click="testConnection" :disabled="testing">
                {{ testing ? 'Testing…' : 'Test Connection' }}
              </button>
            </div>
            <div v-if="testResult" class="status ok inline" style="margin-top:8px;">{{ testResult }}</div>
          </section>

          <!-- STEP 2: Video Standard -->
          <section v-if="activeStep === 2" class="wizard-section">
            <p class="section-desc">
              Select the master broadcast video standard for CasparCG Channel 1. For Greek and European television (ERT, ANT1, MEGA, etc.), <strong>1080i50</strong> is the broadcast standard.
            </p>

            <div class="video-mode-grid">
              <div
                v-for="opt in videoModeOptions"
                :key="opt.value"
                class="mode-card"
                :class="{ selected: videoMode === opt.value }"
                @click="videoMode = opt.value"
              >
                <div class="mode-header">
                  <span class="mode-badge">{{ opt.badge }}</span>
                  <input type="radio" :value="opt.value" v-model="videoMode" />
                </div>
                <div class="mode-name">{{ opt.value }}</div>
                <div class="mode-desc">{{ opt.label }}</div>
              </div>
            </div>
          </section>

          <!-- STEP 3: Program Output (DeckLink SDI) -->
          <section v-if="activeStep === 3" class="wizard-section">
            <p class="section-desc">
              Configure the primary Blackmagic DeckLink SDI card that outputs your on-air Program feed to the transmitter / master control switcher.
            </p>

            <div class="form-grid two-col">
              <div class="form-group">
                <label>Program Output Card # (DeckLink)</label>
                <select v-model.number="outputDevice" class="glass-input">
                  <option v-for="d in deviceOptions" :key="d" :value="d">DeckLink {{ d }}</option>
                </select>
                <span class="hint-text">Physical Blackmagic card device index (1–8)</span>
              </div>

              <div class="form-group">
                <label>Buffer Depth (Frames)</label>
                <select v-model.number="outputBufferDepth" class="glass-input">
                  <option v-for="b in bufferOptions" :key="b" :value="b">{{ b }} frames {{ b === 3 ? '(Recommended)' : '' }}</option>
                </select>
                <span class="hint-text">Default: 3 frames for zero dropouts</span>
              </div>

              <div class="form-group">
                <label>Latency Mode</label>
                <select v-model="outputLatency" class="glass-input">
                  <option value="normal">Normal (Standard broadcast buffer)</option>
                  <option value="low">Low Latency</option>
                  <option value="default">Default</option>
                </select>
              </div>

              <div class="form-group">
                <label>Keyer Mode</label>
                <select v-model="outputKeyer" class="glass-input">
                  <option value="external">External (Standard SDI Fill + Key)</option>
                  <option value="internal">Internal Keyer</option>
                  <option value="default">Default</option>
                </select>
              </div>

              <div class="form-group">
                <label>Separate Key Device (Optional)</label>
                <select v-model.number="outputKeyDevice" class="glass-input">
                  <option :value="0">None / Same Card</option>
                  <option v-for="d in deviceOptions" :key="'k' + d" :value="d">DeckLink {{ d }}</option>
                </select>
                <span class="hint-text">Use when Fill and Key are on separate physical BNC ports</span>
              </div>

              <div class="form-group checkbox-group">
                <label class="checkbox-label">
                  <input v-model="outputEmbeddedAudio" type="checkbox" />
                  <span>Embed Audio in SDI Stream</span>
                </label>
                <label class="checkbox-label" style="margin-top:6px;">
                  <input v-model="enableScreenConsumer" type="checkbox" />
                  <span>Enable Local Operator Screen Preview</span>
                </label>
              </div>
            </div>
          </section>

          <!-- STEP 4: Live Input & Rebroadcast -->
          <section v-if="activeStep === 4" class="wizard-section">
            <p class="section-desc">
              Configure an SDI DeckLink input for live studio cameras, incoming feeds, or outside broadcasts. When you click <strong>LIVE</strong> or play a live rundown item, this feed routes directly to Program Out.
            </p>

            <div class="form-group">
              <label class="checkbox-label highlight">
                <input v-model="hasLiveInput" type="checkbox" />
                <span>Enable Live Rebroadcast Ingest (DeckLink Input)</span>
              </label>
            </div>

            <template v-if="hasLiveInput">
              <div class="form-grid two-col" style="margin-top:1rem;">
                <div class="form-group">
                  <label>Live Input Device # (DeckLink)</label>
                  <select v-model.number="inputDevice" class="glass-input">
                    <option v-for="d in deviceOptions" :key="d" :value="d">DeckLink {{ d }}</option>
                  </select>
                  <span class="hint-text">The card capturing your live SDI signal</span>
                </div>

                <div class="form-group">
                  <label>Live Input Video Standard</label>
                  <select v-model="inputFormat" class="glass-input">
                    <option value="1080i5000">1080i50 (PAL Broadcast Standard)</option>
                    <option value="1080p2500">1080p25</option>
                    <option value="1080p5000">1080p50</option>
                    <option value="auto">Auto / Detect</option>
                  </select>
                </div>
              </div>

              <div v-if="inputDevice === outputDevice" class="status error">
                ⚠️ Input device cannot be the same as Program Output device (DeckLink {{ outputDevice }}). Please select a different device number.
              </div>

              <div v-else-if="routingSummary" class="routing-card">
                <div class="routing-row">
                  <span class="routing-badge">SIGNAL ROUTING</span>
                  <span class="routing-text">{{ routingSummary }}</span>
                </div>
                <div class="routing-row">
                  <span class="routing-cmd-label">AMCP LIVE COMMAND:</span>
                  <code class="routing-cmd">PLAY 1-20 DECKLINK {{ inputDevice }} FORMAT {{ inputFormat }}</code>
                </div>
              </div>
            </template>
          </section>

          <!-- STEP 5: Review & Apply -->
          <section v-if="activeStep === 5" class="wizard-section">
            <p class="section-desc">
              Review your broadcast configuration before applying. A timestamped backup of your original <code>casparcg.config</code> will be created automatically.
            </p>

            <div class="review-card">
              <div class="review-title">Proposed Broadcast Profile</div>
              <ul class="review-list">
                <li v-for="(change, i) in changesList" :key="i">{{ change }}</li>
              </ul>
            </div>

            <!-- HTML5 CG Templates Deploy Card -->
            <div class="template-deploy-card">
              <div class="template-info">
                <strong>Broadcast HTML5 CG Templates (Greek NCRTV Advisory & Crawl)</strong>
                <span>Installs <code>playout/advisory.html</code> and <code>playout/crawl.html</code> into CasparCG template folder.</span>
              </div>
              <button class="glass-btn btn-deploy" @click="deployTemplates(false)" :disabled="deploying">
                {{ deploying ? 'Installing…' : 'Install Templates Now' }}
              </button>
            </div>
            <div v-if="templateDeployResult" class="status ok inline" style="margin-top:8px;">
              Deployed {{ templateDeployResult.deployed.length }} files to {{ templateDeployResult.template_dir }}
            </div>
          </section>
        </div>

        <!-- Footer -->
        <div class="modal-footer">
          <button v-if="activeStep > 1" class="glass-btn" @click="goPrev" :disabled="applying">← Back</button>
          <div class="footer-spacer"></div>
          <button v-if="activeStep < totalSteps" class="glass-btn btn-primary" @click="goNext" :disabled="!canGoNext">
            Next →
          </button>
          <button v-if="activeStep === totalSteps" class="glass-btn btn-apply" @click="applyConfig" :disabled="applying || !!errorMessage">
            {{ applying ? 'Applying & Saving…' : '✔ Apply & Save Configuration' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(8, 12, 20, 0.88);
  backdrop-filter: blur(12px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10000;
}

.modal-content {
  width: 740px;
  max-width: 94vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #141a26 0%, #0d121c 100%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.85);
  overflow: hidden;
}

.modal-header {
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-badge {
  font-size: 0.65rem;
  font-weight: 800;
  color: #38bdf8;
  letter-spacing: 0.08em;
}

.modal-header h2 {
  margin: 0;
  font-size: 1.15rem;
  color: #f1f5f9;
}

/* Step Indicator Bar */
.step-indicator {
  display: flex;
  justify-content: space-between;
  padding: 12px 1.5rem;
  background: rgba(0, 0, 0, 0.3);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.step-item {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  opacity: 0.5;
  transition: all 0.15s;
}

.step-item.active {
  opacity: 1;
}

.step-item.completed {
  opacity: 0.85;
}

.step-circle {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 800;
  color: #fff;
}

.step-item.active .step-circle {
  background: #38bdf8;
  border-color: #38bdf8;
  color: #000;
  box-shadow: 0 0 10px rgba(56, 189, 248, 0.4);
}

.step-item.completed .step-circle {
  background: #10b981;
  border-color: #10b981;
}

.step-name {
  font-size: 0.75rem;
  font-weight: 700;
  color: #cbd5e1;
}

/* Body */
.modal-body {
  padding: 1.5rem;
  overflow-y: auto;
  min-height: 260px;
}

.wizard-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.section-desc {
  font-size: 0.82rem;
  color: #94a3b8;
  line-height: 1.45;
  margin: 0;
}

.section-desc code {
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 5px;
  border-radius: 4px;
  color: #38bdf8;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #cbd5e1;
}

.form-grid {
  display: grid;
  gap: 12px;
}

.form-grid.two-col {
  grid-template-columns: 1fr 1fr;
}

.glass-input {
  background: #0b0f17;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f1f5f9;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 0.82rem;
  outline: none;
}

.glass-input:focus {
  border-color: #38bdf8;
}

.input-with-button {
  display: flex;
  gap: 8px;
}

.input-with-button .glass-input {
  flex: 1;
}

.hint-text {
  font-size: 0.7rem;
  color: #64748b;
}

/* Checkbox */
.checkbox-group {
  justify-content: center;
  padding-top: 8px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: #cbd5e1;
  cursor: pointer;
}

.checkbox-label.highlight {
  background: rgba(56, 189, 248, 0.08);
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid rgba(56, 189, 248, 0.25);
  font-weight: 600;
  color: #38bdf8;
}

/* Video Mode Cards */
.video-mode-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.mode-card {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: all 0.15s;
}

.mode-card:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.2);
}

.mode-card.selected {
  background: rgba(56, 189, 248, 0.1);
  border-color: #38bdf8;
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.15);
}

.mode-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.mode-badge {
  font-size: 0.62rem;
  font-weight: 800;
  background: rgba(56, 189, 248, 0.2);
  color: #38bdf8;
  padding: 2px 6px;
  border-radius: 4px;
}

.mode-name {
  font-size: 0.88rem;
  font-weight: 800;
  color: #f1f5f9;
}

.mode-desc {
  font-size: 0.72rem;
  color: #94a3b8;
  line-height: 1.3;
}

/* Cards */
.summary-card,
.review-card,
.connection-test-card,
.template-deploy-card {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 12px 14px;
}

.connection-test-card,
.template-deploy-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.connection-info,
.template-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.connection-info strong,
.template-info strong {
  font-size: 0.82rem;
  color: #f1f5f9;
}

.connection-info span,
.template-info span {
  font-size: 0.72rem;
  color: #94a3b8;
}

.summary-title,
.review-title {
  font-size: 0.75rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
  margin-bottom: 8px;
}

.summary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  font-size: 0.78rem;
  color: #cbd5e1;
}

.review-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.review-list li {
  font-size: 0.78rem;
  color: #cbd5e1;
  position: relative;
  padding-left: 16px;
}

.review-list li::before {
  content: '▸';
  position: absolute;
  left: 0;
  color: #38bdf8;
}

/* Routing Card */
.routing-card {
  background: rgba(56, 189, 248, 0.08);
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.routing-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.routing-badge {
  font-size: 0.62rem;
  font-weight: 800;
  background: #38bdf8;
  color: #000;
  padding: 2px 6px;
  border-radius: 4px;
}

.routing-text {
  font-size: 0.8rem;
  font-weight: 700;
  color: #f1f5f9;
}

.routing-cmd-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: #94a3b8;
}

.routing-cmd {
  font-family: Consolas, monospace;
  font-size: 0.76rem;
  background: rgba(0, 0, 0, 0.4);
  padding: 2px 6px;
  border-radius: 4px;
  color: #38bdf8;
}

/* Status Messages */
.status {
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 0.78rem;
  margin-bottom: 12px;
}

.status.ok {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: #34d399;
}

.status.ok.inline {
  display: inline-block;
  margin: 0;
}

.status.error {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #f87171;
}

/* Buttons */
.modal-footer {
  padding: 1rem 1.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.3);
}

.footer-spacer {
  flex: 1;
}

.glass-btn {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #cbd5e1;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.glass-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.glass-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-primary {
  background: rgba(56, 189, 248, 0.15);
  border-color: rgba(56, 189, 248, 0.4);
  color: #38bdf8;
}

.btn-primary:hover:not(:disabled) {
  background: rgba(56, 189, 248, 0.25);
}

.btn-apply {
  background: rgba(16, 185, 129, 0.15);
  border-color: rgba(16, 185, 129, 0.4);
  color: #34d399;
  font-weight: 700;
}

.btn-apply:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.25);
  box-shadow: 0 0 16px rgba(16, 185, 129, 0.2);
}

.btn-test {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.35);
  color: #fbbf24;
}

.btn-deploy {
  background: rgba(168, 85, 247, 0.15);
  border-color: rgba(168, 85, 247, 0.35);
  color: #c084fc;
}

.btn-icon {
  padding: 4px 8px;
  font-size: 1.1rem;
}
</style>
