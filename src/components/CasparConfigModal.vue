<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

type ScreenConsumer = {
  device: number;
  aspectRatio: string;
  stretch: string;
  windowed: boolean;
  keyOnly: boolean;
  vsync: boolean;
  borderless: boolean;
  interactive: boolean;
  alwaysOnTop: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  sbsKey: boolean;
  colourSpace: string;
};

type AudioConsumer = {
  channelLayout: string;
  latency: number;
};

type DecklinkConsumer = {
  device: number;
  keyDevice: number | null;
  embeddedAudio: boolean;
  latency: string;
  keyer: string;
  keyOnly: boolean;
  bufferDepth: number;
};

type ChannelConfig = {
  videoMode: string;
  screens: ScreenConsumer[];
  systemAudio: AudioConsumer[];
  decklinks: DecklinkConsumer[];
};

type StructuredConfig = {
  logLevel: string;
  logAlignColumns: boolean;
  lockClearPhrase: string;
  mediaPath: string;
  logPath: string;
  dataPath: string;
  templatePath: string;
  fontPath: string;
  controllerPort: number;
  controllerProtocol: string;
  mediaServerHost: string;
  mediaServerPort: number;
  oscDefaultPort: number;
  oscDisableSendToAmcpClients: boolean;
  channels: ChannelConfig[];
};

type LoadResult = {
  path: string;
  raw_xml: string;
  config: any;
};

const props = defineProps<{
  isOpen: boolean;
  initialPath: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'update:path', value: string): void;
}>();

const configPath = ref('');
const activeTab = ref<'structured' | 'raw'>('structured');
const loading = ref(false);
const saving = ref(false);
const errorMessage = ref('');
const statusMessage = ref('');
const rawXml = ref('');
const structuredConfig = ref<StructuredConfig>(createDefaultConfig());

const videoModeOptions = [
  'PAL', 'NTSC', '576p2500', '720p2398', '720p2400', '720p2500', '720p5000', '720p2997', '720p5994', '720p3000', '720p6000',
  '1080p2398', '1080p2400', '1080i5000', '1080i5994', '1080i6000', '1080p2500', '1080p2997', '1080p3000', '1080p5000', '1080p5994', '1080p6000',
  '1556p2398', '1556p2400', '1556p2500', 'dci1080p2398', 'dci1080p2400', 'dci1080p2500',
  '2160p2398', '2160p2400', '2160p2500', '2160p2997', '2160p3000', '2160p5000', '2160p5994', '2160p6000'
];

const canSave = computed(() => !!configPath.value.trim() && !saving.value);

watch(() => props.initialPath, (nextPath) => {
  configPath.value = nextPath || '';
}, { immediate: true });

watch(() => props.isOpen, (openState) => {
  if (!openState) return;
  initialize().catch((error) => {
    errorMessage.value = formatError(error, 'Failed to load CasparCG configuration');
  });
});

function createDefaultScreen(): ScreenConsumer {
  return {
    device: 1,
    aspectRatio: 'default',
    stretch: 'fill',
    windowed: true,
    keyOnly: false,
    vsync: false,
    borderless: false,
    interactive: true,
    alwaysOnTop: false,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    sbsKey: false,
    colourSpace: 'RGB'
  };
}

function createDefaultAudio(): AudioConsumer {
  return {
    channelLayout: 'stereo',
    latency: 200
  };
}

function createDefaultDecklink(): DecklinkConsumer {
  return {
    device: 1,
    keyDevice: null,
    embeddedAudio: false,
    latency: 'normal',
    keyer: 'external',
    keyOnly: false,
    bufferDepth: 3
  };
}

function createDefaultChannel(): ChannelConfig {
  return {
    videoMode: '1080i5000',
    screens: [createDefaultScreen()],
    systemAudio: [createDefaultAudio()],
    decklinks: []
  };
}

function createDefaultConfig(): StructuredConfig {
  return {
    logLevel: 'info',
    logAlignColumns: true,
    lockClearPhrase: 'secret',
    mediaPath: 'C:/CasparCG/Media',
    logPath: 'log/',
    dataPath: 'C:/CasparCG/Data',
    templatePath: 'template/',
    fontPath: 'font/',
    controllerPort: 5250,
    controllerProtocol: 'AMCP',
    mediaServerHost: 'localhost',
    mediaServerPort: 8000,
    oscDefaultPort: 6250,
    oscDisableSendToAmcpClients: false,
    channels: [createDefaultChannel()]
  };
}

function toStructuredConfig(config: any): StructuredConfig {
  const channels = Array.isArray(config?.channels?.channels) && config.channels.channels.length
    ? config.channels.channels.map((channel: any) => ({
        videoMode: channel?.video_mode || '1080i5000',
        screens: Array.isArray(channel?.consumers?.screens) && channel.consumers.screens.length
          ? channel.consumers.screens.map((screen: any) => ({
              device: Number(screen?.device ?? 1),
              aspectRatio: screen?.aspect_ratio || 'default',
              stretch: screen?.stretch || 'fill',
              windowed: screen?.windowed ?? true,
              keyOnly: screen?.key_only ?? false,
              vsync: screen?.vsync ?? false,
              borderless: screen?.borderless ?? false,
              interactive: screen?.interactive ?? true,
              alwaysOnTop: screen?.always_on_top ?? false,
              x: Number(screen?.x ?? 0),
              y: Number(screen?.y ?? 0),
              width: Number(screen?.width ?? 0),
              height: Number(screen?.height ?? 0),
              sbsKey: screen?.sbs_key ?? false,
              colourSpace: screen?.colour_space || 'RGB'
            }))
          : [],
        systemAudio: Array.isArray(channel?.consumers?.system_audio) && channel.consumers.system_audio.length
          ? channel.consumers.system_audio.map((audio: any) => ({
              channelLayout: audio?.channel_layout || 'stereo',
              latency: Number(audio?.latency ?? 200)
            }))
          : [],
        decklinks: Array.isArray(channel?.consumers?.decklinks) && channel.consumers.decklinks.length
          ? channel.consumers.decklinks.map((decklink: any) => ({
              device: Number(decklink?.device ?? 1),
              keyDevice: decklink?.key_device ?? null,
              embeddedAudio: decklink?.embedded_audio ?? false,
              latency: decklink?.latency || 'normal',
              keyer: decklink?.keyer || 'external',
              keyOnly: decklink?.key_only ?? false,
              bufferDepth: Number(decklink?.buffer_depth ?? 3)
            }))
          : []
      }))
    : [createDefaultChannel()];

  return {
    logLevel: config?.log_level || 'info',
    logAlignColumns: config?.log_align_columns ?? true,
    lockClearPhrase: config?.lock_clear_phrase || 'secret',
    mediaPath: config?.paths?.media_path || 'C:/CasparCG/Media',
    logPath: config?.paths?.log_path || 'log/',
    dataPath: config?.paths?.data_path || 'C:/CasparCG/Data',
    templatePath: config?.paths?.template_path || 'template/',
    fontPath: config?.paths?.font_path || 'font/',
    controllerPort: Number(config?.controllers?.tcp?.[0]?.port ?? 5250),
    controllerProtocol: config?.controllers?.tcp?.[0]?.protocol || 'AMCP',
    mediaServerHost: config?.amcp?.media_server?.host || 'localhost',
    mediaServerPort: Number(config?.amcp?.media_server?.port ?? 8000),
    oscDefaultPort: Number(config?.osc?.default_port ?? 6250),
    oscDisableSendToAmcpClients: config?.osc?.disable_send_to_amcp_clients ?? false,
    channels
  };
}

function toStructuredPayload(config: StructuredConfig) {
  const textOrUndefined = (value: string) => value.trim() || undefined;

  return {
    log_level: textOrUndefined(config.logLevel),
    log_align_columns: config.logAlignColumns,
    lock_clear_phrase: textOrUndefined(config.lockClearPhrase),
    paths: {
      media_path: textOrUndefined(config.mediaPath),
      log_path: textOrUndefined(config.logPath),
      data_path: textOrUndefined(config.dataPath),
      template_path: textOrUndefined(config.templatePath),
      font_path: textOrUndefined(config.fontPath)
    },
    channels: {
      channels: config.channels.map((channel) => ({
        video_mode: textOrUndefined(channel.videoMode),
        consumers: {
          screens: channel.screens.map((screen) => ({
            device: screen.device,
            aspect_ratio: screen.aspectRatio,
            stretch: screen.stretch,
            windowed: screen.windowed,
            key_only: screen.keyOnly,
            vsync: screen.vsync,
            borderless: screen.borderless,
            interactive: screen.interactive,
            always_on_top: screen.alwaysOnTop,
            x: screen.x,
            y: screen.y,
            width: screen.width,
            height: screen.height,
            sbs_key: screen.sbsKey,
            colour_space: screen.colourSpace
          })),
          system_audio: channel.systemAudio.map((audio) => ({
            channel_layout: audio.channelLayout,
            latency: audio.latency
          })),
          decklinks: channel.decklinks.map((decklink) => ({
            device: decklink.device,
            key_device: decklink.keyDevice ?? undefined,
            embedded_audio: decklink.embeddedAudio,
            latency: decklink.latency,
            keyer: decklink.keyer,
            key_only: decklink.keyOnly,
            buffer_depth: decklink.bufferDepth
          }))
        }
      }))
    },
    controllers: {
      tcp: [{
        port: config.controllerPort,
        protocol: textOrUndefined(config.controllerProtocol)
      }]
    },
    amcp: {
      media_server: {
        host: textOrUndefined(config.mediaServerHost),
        port: config.mediaServerPort
      }
    },
    osc: {
      default_port: config.oscDefaultPort,
      disable_send_to_amcp_clients: config.oscDisableSendToAmcpClients
    }
  };
}

async function initialize() {
  errorMessage.value = '';
  statusMessage.value = '';

  if (!configPath.value.trim()) {
    const detected = await invoke<string | null>('find_default_caspar_config');
    if (detected) {
      configPath.value = detected;
      emit('update:path', detected);
    }
  }

  await loadConfig();
}

async function loadConfig() {
  loading.value = true;
  errorMessage.value = '';
  statusMessage.value = '';
  try {
    const result = await invoke<LoadResult>('load_caspar_config', {
      path: configPath.value.trim() || null
    });
    configPath.value = result.path;
    emit('update:path', result.path);
    rawXml.value = result.raw_xml;
    structuredConfig.value = toStructuredConfig(result.config);
    statusMessage.value = 'Configuration loaded.';
  } catch (error) {
    errorMessage.value = formatError(error, 'Failed to load CasparCG configuration');
  } finally {
    loading.value = false;
  }
}

async function pickConfigPath() {
  const selection = await open({
    title: 'Choose casparcg.config',
    multiple: false,
    directory: false,
    defaultPath: configPath.value || undefined,
    filters: [
      { name: 'CasparCG Config', extensions: ['config', 'xml'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!selection || Array.isArray(selection)) return;
  configPath.value = selection;
  emit('update:path', selection);
  await loadConfig();
}

async function saveCurrent() {
  if (!configPath.value.trim()) {
    errorMessage.value = 'Choose a CasparCG configuration path first.';
    return;
  }

  saving.value = true;
  errorMessage.value = '';
  statusMessage.value = '';
  try {
    if (activeTab.value === 'raw') {
      await invoke('save_caspar_config_raw', {
        path: configPath.value,
        rawXml: rawXml.value
      });
    } else {
      const xml = await invoke<string>('save_caspar_config_structured', {
        path: configPath.value,
        config: toStructuredPayload(structuredConfig.value)
      });
      rawXml.value = xml;
    }

    emit('update:path', configPath.value);
    statusMessage.value = 'Configuration saved.';
  } catch (error) {
    errorMessage.value = formatError(error, 'Failed to save CasparCG configuration');
  } finally {
    saving.value = false;
  }
}

function addChannel() {
  structuredConfig.value.channels.push(createDefaultChannel());
}

function removeChannel(index: number) {
  structuredConfig.value.channels.splice(index, 1);
  if (!structuredConfig.value.channels.length) addChannel();
}

function formatError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : String(error || fallback);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="modal-backdrop" @click.self="emit('close')">
      <div class="glass-panel modal-content">
        <div class="modal-header">
          <div>
            <h2 class="text-accent">CasparCG Configurator</h2>
            <p class="subtitle">Structured editing for paths, channels, screens, system audio, and DeckLink, plus raw XML for everything else.</p>
          </div>
          <button class="glass-btn btn-icon" @click="emit('close')">✕</button>
        </div>

        <div class="modal-body custom-scroll">
          <section class="settings-section compact-gap">
            <div class="form-group">
              <label>Configuration File</label>
              <div class="input-with-button">
                <input v-model="configPath" type="text" class="glass-input" placeholder="C:/CasparCG/casparcg.config">
                <button class="glass-btn" @click="pickConfigPath">Browse</button>
                <button class="glass-btn" @click="loadConfig" :disabled="loading">{{ loading ? 'Loading…' : 'Reload' }}</button>
              </div>
              <span class="hint-text">Detected defaults include C:/CasparCG/casparcg.config and C:/CasparLauncher/casparcg.config.</span>
            </div>

            <div class="tab-strip">
              <button class="tab-btn" :class="{ active: activeTab === 'structured' }" @click="activeTab = 'structured'">Structured</button>
              <button class="tab-btn" :class="{ active: activeTab === 'raw' }" @click="activeTab = 'raw'">Raw XML</button>
            </div>

            <div v-if="errorMessage" class="status-card error">{{ errorMessage }}</div>
            <div v-else-if="statusMessage" class="status-card ok">{{ statusMessage }}</div>
          </section>

          <template v-if="activeTab === 'structured'">
            <section class="settings-section">
              <h3 class="text-secondary section-title">Paths & Control</h3>
              <div class="form-grid two-col">
                <div class="form-group">
                  <label>Media Path</label>
                  <input v-model="structuredConfig.mediaPath" type="text" class="glass-input">
                </div>
                <div class="form-group">
                  <label>Log Path</label>
                  <input v-model="structuredConfig.logPath" type="text" class="glass-input">
                </div>
                <div class="form-group">
                  <label>Data Path</label>
                  <input v-model="structuredConfig.dataPath" type="text" class="glass-input">
                </div>
                <div class="form-group">
                  <label>Template Path</label>
                  <input v-model="structuredConfig.templatePath" type="text" class="glass-input">
                </div>
                <div class="form-group">
                  <label>Font Path</label>
                  <input v-model="structuredConfig.fontPath" type="text" class="glass-input">
                </div>
                <div class="form-group">
                  <label>Lock Clear Phrase</label>
                  <input v-model="structuredConfig.lockClearPhrase" type="text" class="glass-input">
                </div>
                <div class="form-group">
                  <label>Log Level</label>
                  <select v-model="structuredConfig.logLevel" class="glass-input">
                    <option value="trace">trace</option>
                    <option value="debug">debug</option>
                    <option value="info">info</option>
                    <option value="warning">warning</option>
                    <option value="error">error</option>
                    <option value="fatal">fatal</option>
                  </select>
                </div>
                <div class="form-group checkbox-inline">
                  <label>
                    <input v-model="structuredConfig.logAlignColumns" type="checkbox">
                    Align log columns
                  </label>
                </div>
                <div class="form-group">
                  <label>AMCP TCP Port</label>
                  <input v-model.number="structuredConfig.controllerPort" type="number" min="1" class="glass-input">
                </div>
                <div class="form-group">
                  <label>Controller Protocol</label>
                  <input v-model="structuredConfig.controllerProtocol" type="text" class="glass-input">
                </div>
                <div class="form-group">
                  <label>Media Server Host</label>
                  <input v-model="structuredConfig.mediaServerHost" type="text" class="glass-input">
                </div>
                <div class="form-group">
                  <label>Media Server Port</label>
                  <input v-model.number="structuredConfig.mediaServerPort" type="number" min="1" class="glass-input">
                </div>
                <div class="form-group">
                  <label>OSC Default Port</label>
                  <input v-model.number="structuredConfig.oscDefaultPort" type="number" min="1" class="glass-input">
                </div>
                <div class="form-group checkbox-inline">
                  <label>
                    <input v-model="structuredConfig.oscDisableSendToAmcpClients" type="checkbox">
                    Disable send to AMCP clients
                  </label>
                </div>
              </div>
            </section>

            <section class="settings-section">
              <div class="section-header">
                <h3 class="text-secondary section-title">Channels & Consumers</h3>
                <button class="glass-btn" @click="addChannel">＋ Add Channel</button>
              </div>

              <div v-for="(channel, channelIndex) in structuredConfig.channels" :key="channelIndex" class="channel-card">
                <div class="channel-card-header">
                  <strong>Channel {{ channelIndex + 1 }}</strong>
                  <button class="glass-btn danger" @click="removeChannel(channelIndex)">Remove</button>
                </div>

                <div class="form-group">
                  <label>Video Mode</label>
                  <input v-model="channel.videoMode" list="caspar-video-modes" class="glass-input">
                </div>

                <div class="consumer-group">
                  <div class="section-header mini">
                    <h4>Screens</h4>
                    <button class="glass-btn" @click="channel.screens.push(createDefaultScreen())">＋ Screen</button>
                  </div>
                  <div v-for="(screen, screenIndex) in channel.screens" :key="`screen-${screenIndex}`" class="consumer-card">
                    <div class="consumer-card-header">
                      <span>Screen {{ screenIndex + 1 }}</span>
                      <button class="glass-btn danger" @click="channel.screens.splice(screenIndex, 1)">Remove</button>
                    </div>
                    <div class="form-grid two-col compact-grid">
                      <div class="form-group"><label>Device</label><input v-model.number="screen.device" type="number" min="1" class="glass-input"></div>
                      <div class="form-group"><label>Aspect Ratio</label><select v-model="screen.aspectRatio" class="glass-input"><option value="default">default</option><option value="4:3">4:3</option><option value="16:9">16:9</option></select></div>
                      <div class="form-group"><label>Stretch</label><select v-model="screen.stretch" class="glass-input"><option value="none">none</option><option value="fill">fill</option><option value="uniform">uniform</option><option value="uniform_to_fill">uniform_to_fill</option></select></div>
                      <div class="form-group"><label>Colour Space</label><select v-model="screen.colourSpace" class="glass-input"><option value="RGB">RGB</option><option value="datavideo-full">datavideo-full</option><option value="datavideo-limited">datavideo-limited</option></select></div>
                      <div class="form-group"><label>X</label><input v-model.number="screen.x" type="number" class="glass-input"></div>
                      <div class="form-group"><label>Y</label><input v-model.number="screen.y" type="number" class="glass-input"></div>
                      <div class="form-group"><label>Width</label><input v-model.number="screen.width" type="number" class="glass-input"></div>
                      <div class="form-group"><label>Height</label><input v-model.number="screen.height" type="number" class="glass-input"></div>
                    </div>
                    <div class="toggle-row">
                      <label><input v-model="screen.windowed" type="checkbox"> Windowed</label>
                      <label><input v-model="screen.keyOnly" type="checkbox"> Key only</label>
                      <label><input v-model="screen.vsync" type="checkbox"> VSync</label>
                      <label><input v-model="screen.borderless" type="checkbox"> Borderless</label>
                      <label><input v-model="screen.interactive" type="checkbox"> Interactive</label>
                      <label><input v-model="screen.alwaysOnTop" type="checkbox"> Always on top</label>
                      <label><input v-model="screen.sbsKey" type="checkbox"> SBS key</label>
                    </div>
                  </div>
                </div>

                <div class="consumer-group">
                  <div class="section-header mini">
                    <h4>System Audio</h4>
                    <button class="glass-btn" @click="channel.systemAudio.push(createDefaultAudio())">＋ Audio</button>
                  </div>
                  <div v-for="(audio, audioIndex) in channel.systemAudio" :key="`audio-${audioIndex}`" class="consumer-card">
                    <div class="consumer-card-header">
                      <span>System Audio {{ audioIndex + 1 }}</span>
                      <button class="glass-btn danger" @click="channel.systemAudio.splice(audioIndex, 1)">Remove</button>
                    </div>
                    <div class="form-grid two-col compact-grid">
                      <div class="form-group"><label>Channel Layout</label><select v-model="audio.channelLayout" class="glass-input"><option value="mono">mono</option><option value="stereo">stereo</option><option value="matrix">matrix</option></select></div>
                      <div class="form-group"><label>Latency</label><input v-model.number="audio.latency" type="number" min="0" class="glass-input"></div>
                    </div>
                  </div>
                </div>

                <div class="consumer-group">
                  <div class="section-header mini">
                    <h4>DeckLink</h4>
                    <button class="glass-btn" @click="channel.decklinks.push(createDefaultDecklink())">＋ DeckLink</button>
                  </div>
                  <div v-for="(decklink, decklinkIndex) in channel.decklinks" :key="`decklink-${decklinkIndex}`" class="consumer-card">
                    <div class="consumer-card-header">
                      <span>DeckLink {{ decklinkIndex + 1 }}</span>
                      <button class="glass-btn danger" @click="channel.decklinks.splice(decklinkIndex, 1)">Remove</button>
                    </div>
                    <div class="form-grid two-col compact-grid">
                      <div class="form-group"><label>Device</label><input v-model.number="decklink.device" type="number" min="1" class="glass-input"></div>
                      <div class="form-group"><label>Key Device</label><input v-model.number="decklink.keyDevice" type="number" min="1" class="glass-input" placeholder="optional"></div>
                      <div class="form-group"><label>Latency</label><select v-model="decklink.latency" class="glass-input"><option value="normal">normal</option><option value="low">low</option><option value="default">default</option></select></div>
                      <div class="form-group"><label>Keyer</label><select v-model="decklink.keyer" class="glass-input"><option value="external">external</option><option value="external_separate_device">external_separate_device</option><option value="internal">internal</option><option value="default">default</option></select></div>
                      <div class="form-group"><label>Buffer Depth</label><input v-model.number="decklink.bufferDepth" type="number" min="1" class="glass-input"></div>
                    </div>
                    <div class="toggle-row">
                      <label><input v-model="decklink.embeddedAudio" type="checkbox"> Embedded audio</label>
                      <label><input v-model="decklink.keyOnly" type="checkbox"> Key only</label>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </template>

          <section v-else class="settings-section">
            <h3 class="text-secondary section-title">Raw XML</h3>
            <p class="hint-text">Use this tab for any CasparCG module or consumer not covered by the structured editor. Saving raw XML preserves your full custom configuration.</p>
            <textarea v-model="rawXml" class="xml-editor" spellcheck="false"></textarea>
          </section>

          <datalist id="caspar-video-modes">
            <option v-for="mode in videoModeOptions" :key="mode" :value="mode" />
          </datalist>
        </div>

        <div class="modal-footer">
          <button class="glass-btn" @click="emit('close')">Close</button>
          <button class="glass-btn btn-primary" :disabled="!canSave" @click="saveCurrent">{{ saving ? 'Saving…' : 'Save Config' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(8px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 11000;
}

.modal-content {
  width: min(1180px, 96vw);
  max-height: 92vh;
  padding: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border: 1px solid var(--glass-border);
}

.modal-header,
.modal-footer {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--glass-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.modal-footer {
  border-bottom: 0;
  border-top: 1px solid var(--glass-border);
}

.subtitle {
  margin: 6px 0 0;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.modal-body {
  padding: 1.25rem;
  overflow-y: auto;
}

.settings-section {
  margin-bottom: 1.5rem;
}

.compact-gap {
  margin-bottom: 1rem;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 1rem;
}

.section-header.mini {
  margin-bottom: 0.65rem;
}

.form-grid {
  display: grid;
  gap: 12px;
}

.form-grid.two-col {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.compact-grid {
  gap: 10px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.glass-input,
.xml-editor {
  background: var(--bg-tertiary);
  border: 1px solid var(--glass-border);
  color: var(--text-primary);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 0.8rem;
}

.xml-editor {
  width: 100%;
  min-height: 420px;
  resize: vertical;
  font-family: Consolas, 'Courier New', monospace;
}

.input-with-button {
  display: flex;
  gap: 8px;
}

.input-with-button .glass-input {
  flex: 1;
}

.glass-btn {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12);
  color: var(--text-primary);
  border-radius: 6px;
  padding: 8px 12px;
  cursor: pointer;
}

.glass-btn.danger {
  color: #ff8d8d;
  border-color: rgba(255, 141, 141, 0.28);
}

.glass-btn.btn-primary {
  background: rgba(51, 190, 204, 0.14);
  border-color: rgba(51, 190, 204, 0.35);
}

.tab-strip {
  display: flex;
  gap: 8px;
}

.tab-btn {
  background: transparent;
  border: 1px solid var(--glass-border);
  color: var(--text-secondary);
  border-radius: 999px;
  padding: 6px 12px;
  cursor: pointer;
}

.tab-btn.active {
  color: var(--text-primary);
  border-color: rgba(51, 190, 204, 0.4);
  background: rgba(51, 190, 204, 0.12);
}

.status-card {
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 0.78rem;
}

.status-card.ok {
  background: rgba(29,185,84,0.12);
  border: 1px solid rgba(29,185,84,0.26);
}

.status-card.error {
  background: rgba(230,57,70,0.14);
  border: 1px solid rgba(230,57,70,0.26);
}

.channel-card,
.consumer-card {
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  padding: 12px;
  background: rgba(255,255,255,0.03);
}

.channel-card + .channel-card {
  margin-top: 14px;
}

.channel-card-header,
.consumer-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.consumer-group + .consumer-group {
  margin-top: 14px;
}

.consumer-card + .consumer-card {
  margin-top: 10px;
}

.toggle-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
  font-size: 0.78rem;
}

.checkbox-inline {
  justify-content: center;
}

.hint-text {
  color: var(--text-secondary);
  font-size: 0.72rem;
}

@media (max-width: 900px) {
  .form-grid.two-col {
    grid-template-columns: 1fr;
  }

  .input-with-button,
  .section-header,
  .channel-card-header,
  .consumer-card-header,
  .modal-header,
  .modal-footer {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>