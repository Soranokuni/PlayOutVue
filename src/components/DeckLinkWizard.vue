<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../stores/settings';
import AppIcon from './ui/AppIcon.vue';

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
  mediaPath?: string;
}

interface TemplateDeployResult {
  template_dir: string;
  templateDir?: string;
  deployed: string[];
  skipped: string[];
}

const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

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
const totalSteps = 6;

// Media Folder configuration
const mediaStorageOption = ref<'default' | 'custom'>('default');
const customMediaPath = ref('');

const defaultMediaDir = computed(() => {
  const parentDir = configPath.value ? configPath.value.replace(/\\/g, '/').replace(/\/[^/]+$/, '') : 'C:/CasparCG';
  return `${parentDir}/media`;
});

const effectiveMediaPath = computed(() => {
  if (mediaStorageOption.value === 'default') {
    return defaultMediaDir.value;
  }
  return customMediaPath.value.trim();
});

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
  if (activeStep.value === 2) return mediaStorageOption.value === 'default' || !!customMediaPath.value.trim();
  if (activeStep.value === 3) return !!videoMode.value.trim();
  if (activeStep.value === 4) return outputDevice.value >= 1 && outputDevice.value <= 8;
  if (activeStep.value === 5) return !hasLiveInput.value || (inputDevice.value >= 1 && inputDevice.value <= 8 && inputDevice.value !== outputDevice.value);
  return true;
});

const stepTitle = computed(() => {
  const titles: Record<number, string> = {
    1: 'CasparCG Configuration & Connection',
    2: 'Media Storage & Library Folder',
    3: 'Broadcast Video Standard',
    4: 'Program Output (SDI / HDMI)',
    5: 'Live Input & Rebroadcast',
    6: 'CG Templates, Review & Apply',
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
  changes.push(`Media Storage: ${effectiveMediaPath.value} (${mediaStorageOption.value === 'default' ? 'Default CasparCG root' : 'Custom'})`);
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

    // Handle media path detection
    const parentDir = result.path ? result.path.replace(/\\/g, '/').replace(/\/[^/]+$/, '') : 'C:/CasparCG';
    const computedDefaultMedia = `${parentDir}/media`;
    const cfgPaths = cfg.paths || {};
    const configuredMedia = (cfgPaths['media-path'] || cfgPaths.media_path || settings.localMediaPath || '').trim();

    if (
      configuredMedia &&
      configuredMedia !== 'media/' &&
      configuredMedia !== 'media' &&
      normalizePath(configuredMedia).toLowerCase() !== normalizePath(computedDefaultMedia).toLowerCase()
    ) {
      mediaStorageOption.value = 'custom';
      customMediaPath.value = configuredMedia;
    } else {
      mediaStorageOption.value = 'default';
      customMediaPath.value = '';
    }

    configSummary.value = {
      path: result.path,
      videoMode: vidMode,
      decklinkDevices,
      channelCount,
      mediaPath: mediaStorageOption.value === 'default' ? computedDefaultMedia : customMediaPath.value,
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

const pickMediaPath = async () => {
  const selection = await open({
    title: 'Select Media Directory for CasparCG & Playout',
    multiple: false,
    directory: true,
    defaultPath: customMediaPath.value || defaultMediaDir.value || undefined,
  });

  if (!selection || Array.isArray(selection)) return;
  customMediaPath.value = selection.replace(/\\/g, '/');
  mediaStorageOption.value = 'custom';
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

const deployTemplates = async (overwrite: boolean = true) => {
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

    const result = await invoke<{
      backup_path?: string;
      backupPath?: string;
      raw_xml?: string;
      rawXml?: string;
      channel_index?: number;
      channelIndex?: number;
      output_device?: number;
      outputDevice?: number;
      templates_deployed?: TemplateDeployResult;
      templatesDeployed?: TemplateDeployResult;
    }>(
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
          mediaPath: effectiveMediaPath.value || null,
        },
      }
    );

    const liveSourceName = hasLiveInput.value
      ? (customLiveRoute.value.trim() || `PLAY 1-20 DECKLINK ${inputDevice.value} FORMAT ${inputFormat.value}`)
      : '';

    settings.updateSettings({
      casparConfigPath: configPath.value,
      localMediaPath: effectiveMediaPath.value || '',
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

    const templates = result.templates_deployed || result.templatesDeployed;
    if (templates) {
      templateDeployResult.value = templates;
      statusMessage.value = `DeckLink configured & CG templates deployed to ${templates.template_dir || templates.templateDir || ''}.`;
    }

    const backup = result.backup_path || result.backupPath || '';
    statusMessage.value = `Configuration applied successfully! Backup saved to ${backup}.`;
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
          <button class="glass-btn btn-icon" aria-label="Close wizard" title="Close wizard" @click="$emit('close')" :disabled="applying">
            <AppIcon name="close" :size="16" />
          </button>
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
              {{
                step === 1 ? 'Server' :
                step === 2 ? 'Media' :
                step === 3 ? 'Standard' :
                step === 4 ? 'Output' :
                step === 5 ? 'Live In' :
                'Apply'
              }}
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
                <div v-if="configSummary.mediaPath" class="summary-item"><strong>Media Storage:</strong> <code>{{ configSummary.mediaPath }}</code></div>
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
            <div v-if="testResult" class="status ok inline wz-stacked">{{ testResult }}</div>
          </section>

          <!-- STEP 2: Media Storage & Library Folder -->
          <section v-if="activeStep === 2" class="wizard-section">
            <p class="section-desc">
              Specify where video clips, commercials, and broadcast media files are stored. PlayOutVue and CasparCG Server will use this directory as your shared media root.
            </p>

            <div class="storage-options-grid">
              <div
                class="mode-card"
                :class="{ selected: mediaStorageOption === 'default' }"
                @click="mediaStorageOption = 'default'"
              >
                <div class="mode-header">
                  <span class="mode-badge">DEFAULT</span>
                  <input type="radio" value="default" v-model="mediaStorageOption" />
                </div>
                <div class="mode-name">CasparCG Server Media Root</div>
                <div class="mode-desc">Use the standard <code>media/</code> subfolder inside your CasparCG Server directory.</div>
                <div class="media-path-preview">
                  <code>{{ defaultMediaDir }}</code>
                </div>
              </div>

              <div
                class="mode-card"
                :class="{ selected: mediaStorageOption === 'custom' }"
                @click="mediaStorageOption = 'custom'"
              >
                <div class="mode-header">
                  <span class="mode-badge">CUSTOM</span>
                  <input type="radio" value="custom" v-model="mediaStorageOption" />
                </div>
                <div class="mode-name">Custom Storage Folder</div>
                <div class="mode-desc">Point to a dedicated drive, media RAID volume, or network share (NAS/SAN).</div>
                <div class="media-path-preview">
                  <code>{{ customMediaPath || 'Click to choose custom path…' }}</code>
                </div>
              </div>
            </div>

            <div v-if="mediaStorageOption === 'custom'" class="form-group wz-stacked">
              <label>Custom Media Directory Path</label>
              <div class="input-with-button">
                <input
                  v-model="customMediaPath"
                  type="text"
                  class="glass-input"
                  placeholder="e.g. D:/Media or //NAS/BroadcastMedia"
                />
                <button class="glass-btn" @click="pickMediaPath">Browse…</button>
              </div>
              <span class="hint-text">CasparCG Server and PlayOutVue will scan this folder for media assets.</span>
            </div>

            <div class="summary-card wz-stacked">
              <div class="summary-title">Effective Playout Media Storage</div>
              <div class="summary-grid">
                <div class="summary-item">
                  <strong>Active Storage Path:</strong>
                  <code>{{ effectiveMediaPath || '(Not specified)' }}</code>
                </div>
                <div class="summary-item">
                  <strong>CasparCG Tag:</strong>
                  <code>&lt;paths&gt;&lt;media-path&gt;{{ effectiveMediaPath }}&lt;/media-path&gt;&lt;/paths&gt;</code>
                </div>
              </div>
            </div>
          </section>

          <!-- STEP 3: Video Standard -->
          <section v-if="activeStep === 3" class="wizard-section">
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

          <!-- STEP 4: Program Output (DeckLink SDI) -->
          <section v-if="activeStep === 4" class="wizard-section">
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
                <label class="checkbox-label wz-stacked">
                  <input v-model="enableScreenConsumer" type="checkbox" />
                  <span>Enable Local Operator Screen Preview</span>
                </label>
              </div>
            </div>
          </section>

          <!-- STEP 5: Live Input & Rebroadcast -->
          <section v-if="activeStep === 5" class="wizard-section">
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
              <div class="form-grid two-col wz-stacked">
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
                <AppIcon name="alert" :size="14" />
                Input device cannot be the same as the program output (DeckLink {{ outputDevice }}). Choose a different device number.
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

          <!-- STEP 6: Review & Apply -->
          <section v-if="activeStep === 6" class="wizard-section">
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
            <div v-if="templateDeployResult" class="status ok inline wz-stacked">
              Deployed {{ templateDeployResult.deployed.length }} files to {{ templateDeployResult.template_dir }}
            </div>
          </section>
        </div>

        <!-- Footer -->
        <div class="modal-footer">
          <button v-if="activeStep > 1" class="glass-btn" @click="goPrev" :disabled="applying">Back</button>
          <div class="footer-spacer"></div>
          <button v-if="activeStep < totalSteps" class="glass-btn btn-primary" @click="goNext" :disabled="!canGoNext">
            Next
          </button>
          <button v-if="activeStep === totalSteps" class="glass-btn btn-apply" @click="applyConfig" :disabled="applying || !!errorMessage">
            {{ applying ? 'Applying…' : 'Apply and save' }}
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
  background: var(--backdrop);
  backdrop-filter: blur(12px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: var(--z-modal);
}

.modal-content {
  width: 740px;
  max-width: 94vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-3);
  overflow: hidden;
}

.modal-header {
  padding: var(--space-5) var(--space-6);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.step-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--accent-blue);
  letter-spacing: var(--tracking-caps);
}

.modal-header h2 {
  margin: 0;
  font-size: var(--fs-xl);
  color: var(--text-primary);
}

/* Step Indicator Bar */
.step-indicator {
  display: flex;
  justify-content: space-between;
  padding: var(--space-3) var(--space-6);
  background: var(--bg-input);
  border-bottom: 1px solid var(--border-subtle);
}

/* §3.2: one answer to "this block follows the one above it". It was six
   inline `margin-top`s at four different values. */
.wz-stacked {
  margin-top: var(--space-2);
}

.step-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  opacity: var(--opacity-muted);
  transition: opacity var(--dur-fast) var(--ease-out);
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
  border: 1.5px solid var(--border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}

.step-item.active .step-circle {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: var(--text-on-accent);
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent-blue) 40%, transparent);
}

.step-item.completed .step-circle {
  background: var(--status-ready);
  border-color: var(--status-ready);
}

.step-name {
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  color: var(--text-secondary);
}

/* Body */
.modal-body {
  padding: var(--space-6);
  overflow-y: auto;
  min-height: 260px;
}

.wizard-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.section-desc {
  font-size: var(--fs-md);
  color: var(--text-secondary);
  line-height: var(--lh-body);
  margin: 0;
}

.section-desc code {
  background: var(--bg-hover);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--accent-blue);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.form-group label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-secondary);
}

.form-grid {
  display: grid;
  gap: var(--space-3);
}

.form-grid.two-col {
  grid-template-columns: 1fr 1fr;
}

.glass-input {
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  font-size: var(--fs-md);
  outline: none;
}

.glass-input:focus {
  border-color: var(--accent-blue);
}

/* §4: without an alignment the button stretched to the input's height, so
   the pair sat at two heights in every dialog that used it. */
.input-with-button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.input-with-button .glass-input {
  flex: 1;
}

.hint-text {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}

/* Checkbox */
.checkbox-group {
  justify-content: center;
  padding-top: var(--space-2);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.checkbox-label.highlight {
  background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 25%, transparent);
  font-weight: var(--fw-semibold);
  color: var(--accent-blue);
}

/* Video Mode Cards */
.video-mode-grid,
.storage-options-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.media-path-preview {
  margin-top: var(--space-2);
  font-size: var(--fs-xs);
  word-break: break-all;
}

.media-path-preview code {
  background: var(--bg-input);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--accent-blue);
}

.mode-card {
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-3);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.mode-card:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.mode-card.selected {
  background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
  border-color: var(--accent-blue);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent-blue) 15%, transparent);
}

.mode-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.mode-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  background: color-mix(in srgb, var(--accent-blue) 20%, transparent);
  color: var(--accent-blue);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
}

.mode-name {
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}

.mode-desc {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  line-height: var(--lh-tight);
}

/* Cards */
.summary-card,
.review-card,
.connection-test-card,
.template-deploy-card {
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-3) var(--space-4);
}

.connection-test-card,
.template-deploy-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
}

.connection-info,
.template-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-0);
}

.connection-info strong,
.template-info strong {
  font-size: var(--fs-md);
  color: var(--text-primary);
}

.connection-info span,
.template-info span {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.summary-title,
.review-title {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}

.summary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.review-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.review-list li {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  position: relative;
  padding-left: var(--space-4);
}

.review-list li::before {
  content: '▸';
  position: absolute;
  left: 0;
  color: var(--accent-blue);
}

/* Routing Card */
.routing-card {
  background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 25%, transparent);
  border-radius: var(--radius-lg);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.routing-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.routing-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  background: var(--accent-blue);
  color: var(--text-on-accent);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
}

.routing-text {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  color: var(--text-primary);
}

.routing-cmd-label {
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  color: var(--text-secondary);
}

.routing-cmd {
  font-family: Consolas, monospace;
  font-size: var(--fs-xs);
  background: var(--bg-input);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--accent-blue);
}

/* Status Messages */
.status {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  margin-bottom: var(--space-3);
}

.status.ok {
  background: color-mix(in srgb, var(--status-ready) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--status-ready) 30%, transparent);
  color: var(--status-ready);
}

.status.ok.inline {
  display: inline-block;
  margin: 0;
}

.status.error {
  background: color-mix(in srgb, var(--status-error) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--status-error) 30%, transparent);
  color: var(--status-error);
}

/* Buttons */
.modal-footer {
  padding: var(--space-4) var(--space-6);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  background: var(--bg-input);
}

.footer-spacer {
  flex: 1;
}

.glass-btn {
  background: var(--bg-hover);
  border: 1px solid var(--border-medium);
  color: var(--text-secondary);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.glass-btn:hover:not(:disabled) {
  background: var(--bg-active);
  color: var(--text-primary);
}

.glass-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-primary {
  background: color-mix(in srgb, var(--accent-blue) 15%, transparent);
  border-color: color-mix(in srgb, var(--accent-blue) 40%, transparent);
  color: var(--accent-blue);
}

.btn-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-blue) 25%, transparent);
}

.btn-apply {
  background: color-mix(in srgb, var(--status-ready) 15%, transparent);
  border-color: color-mix(in srgb, var(--status-ready) 40%, transparent);
  color: var(--status-ready);
  font-weight: var(--fw-bold);
}

.btn-apply:hover:not(:disabled) {
  background: color-mix(in srgb, var(--status-ready) 25%, transparent);
  box-shadow: 0 0 16px color-mix(in srgb, var(--status-ready) 20%, transparent);
}

.btn-test {
  background: color-mix(in srgb, var(--status-warning) 15%, transparent);
  border-color: color-mix(in srgb, var(--status-warning) 35%, transparent);
  color: var(--status-warning);
}

.btn-deploy {
  background: color-mix(in srgb, var(--accent-purple) 15%, transparent);
  border-color: color-mix(in srgb, var(--accent-purple) 35%, transparent);
  color: var(--accent-purple);
}

.btn-icon {
  padding: var(--space-1) var(--space-2);
  font-size: var(--fs-xl);
}
</style>
