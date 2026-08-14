<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../stores/settings';
import CasparConfigModal from './CasparConfigModal.vue';
import DeckLinkWizard from './DeckLinkWizard.vue';

const props = defineProps({
  isOpen: Boolean
});

const emit = defineEmits(['close']);
const settings = useSettingsStore();
const showCasparConfigurator = ref(false);
const showDecklinkWizard = ref(false);
const activeTab = ref<'general' | 'playout' | 'cg'>('general');
const selectedWizardLayer = ref<'logo' | 'rating' | 'tp' | 'explanation' | 'crawl'>('logo');

// Local shadow state so we don't mutate Pinia instantly on every keystroke
const localState = ref({
    localMediaPath: '',
    ffmpegBinPath: '',
    debugMode: false,
    logosPath: '',
    qcSensitivity: 'production' as 'strict' | 'production' | 'lenient',
    decklinkOutputName: '',
    decklinkOutputDevice: 0,
    decklinkInputDevice: 0,
    decklinkInputFormat: '1080i5000',
    liveInputSourceName: '',
    casparConfigPath: '',
    casparOscPort: 6250,
    playoutProfile: 'PAL_1080I50' as 'PAL_1080I50' | 'PAL_1080P25',
    transitionFrames: 2,
    prerollFrames: 2,
    autoResumeAfterRestart: true,
    ingestorApiBaseUrl: '',
    
    // CG settings
    cg: {
        stationIdPath: '',
        stationIdEnabled: true,
    },
    
    // CG Paths
    cgRatingKPath: '',
    cgRating8Path: '',
    cgRating12Path: '',
    cgRating16Path: '',
    cgRating18Path: '',
    cgRatingTPPath: '',

    // CG Positions (Percentages)
    cgStationLogoPos: { left: 5, top: 5, width: 12, height: 12 },
    cgRatingBadgePos: { left: 88, top: 5, width: 7, height: 7 },
    cgTPPos: { left: 88, top: 13, width: 7, height: 7 },
    cgExplanationBannerPos: { left: 60, top: 5, width: 27, height: 7 },
    cgCrawlPos: { left: 0, top: 90, width: 100, height: 8 },

    // CG Templates & Crawl
    cgCrawlTemplate: 'playout/crawl',
    cgCrawlPosition: 'bottom' as 'top' | 'bottom',
    cgCrawlText: '',
    cgCrawlActive: false,
    cgExplanationTemplate: 'playout/explanation'
});

const currentActivePos = computed({
    get: () => {
        if (selectedWizardLayer.value === 'logo') return localState.value.cgStationLogoPos;
        if (selectedWizardLayer.value === 'rating') return localState.value.cgRatingBadgePos;
        if (selectedWizardLayer.value === 'tp') return localState.value.cgTPPos;
        if (selectedWizardLayer.value === 'explanation') return localState.value.cgExplanationBannerPos;
        return localState.value.cgCrawlPos;
    },
    set: (val) => {
        if (selectedWizardLayer.value === 'logo') localState.value.cgStationLogoPos = val;
        else if (selectedWizardLayer.value === 'rating') localState.value.cgRatingBadgePos = val;
        else if (selectedWizardLayer.value === 'tp') localState.value.cgTPPos = val;
        else if (selectedWizardLayer.value === 'explanation') localState.value.cgExplanationBannerPos = val;
        else localState.value.cgCrawlPos = val;
    }
});

// Dragging states
const isDragging = ref(false);
let startX = 0;
let startY = 0;
let startLeft = 0;
let startTop = 0;

const onDragStart = (e: MouseEvent, layer: 'logo' | 'rating' | 'tp' | 'explanation' | 'crawl') => {
    e.preventDefault();
    selectedWizardLayer.value = layer;
    isDragging.value = true;
    startX = e.clientX;
    startY = e.clientY;
    
    const pos = currentActivePos.value;
    startLeft = pos.left;
    startTop = pos.top;
    
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
};

const onDragMove = (e: MouseEvent) => {
    if (!isDragging.value) return;
    const mockScreenEl = document.querySelector('.mock-screen');
    if (!mockScreenEl) return;
    
    const rect = mockScreenEl.getBoundingClientRect();
    const deltaX = ((e.clientX - startX) / rect.width) * 100;
    const deltaY = ((e.clientY - startY) / rect.height) * 100;
    
    const pos = currentActivePos.value;
    pos.left = Math.min(100 - pos.width, Math.max(0, Math.round(startLeft + deltaX)));
    pos.top = Math.min(100 - pos.height, Math.max(0, Math.round(startTop + deltaY)));
};

const onDragEnd = () => {
    isDragging.value = false;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
};

// Auto logo scanning
const scanLogosFolder = async () => {
    if (!localState.value.localMediaPath) {
        alert('Please configure the Local Media Path first.');
        return;
    }
    
    const mediaPath = localState.value.localMediaPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const targetPath = `${mediaPath}/logos`;
    
    try {
        const listing = await invoke<{ entries: Array<{ name: string, path: string, entry_type: string }> }>('browse_filesystem', {
            path: targetPath,
            showFiles: true,
            allowedExtensions: ['png', 'jpg', 'jpeg', 'svg', 'webp']
        });
        
        let foundCount = 0;
        for (const entry of listing.entries) {
            if (entry.entry_type !== 'file') continue;
            const lowerName = entry.name.toLowerCase();
            if (lowerName === 'logo.png') {
                localState.value.cg.stationIdPath = entry.path;
                foundCount++;
            } else if (lowerName === 'k.png') {
                localState.value.cgRatingKPath = entry.path;
                foundCount++;
            } else if (lowerName === '8.png') {
                localState.value.cgRating8Path = entry.path;
                foundCount++;
            } else if (lowerName === '12.png') {
                localState.value.cgRating12Path = entry.path;
                foundCount++;
            } else if (lowerName === '16.png') {
                localState.value.cgRating16Path = entry.path;
                foundCount++;
            } else if (lowerName === '18.png') {
                localState.value.cgRating18Path = entry.path;
                foundCount++;
            } else if (lowerName === 'tp.png') {
                localState.value.cgRatingTPPath = entry.path;
                foundCount++;
            }
        }
        alert(`Scanning complete. Found and populated ${foundCount} logo assets inside ${targetPath}.`);
    } catch (e) {
        console.error('Scan failed:', e);
        alert(`Scan failed. Could not find or access: ${targetPath}`);
    }
};

const mapLocalState = () => {
    localState.value = {
        localMediaPath: settings.localMediaPath,
        ffmpegBinPath: settings.ffmpegBinPath,
        debugMode: settings.debugMode,
        logosPath: settings.logosPath,
        qcSensitivity: settings.qcSensitivity || 'production',
        decklinkOutputName: settings.decklinkOutputName || '',
        decklinkOutputDevice: settings.decklinkOutputDevice || 0,
        decklinkInputDevice: settings.decklinkInputDevice || 0,
        decklinkInputFormat: settings.decklinkInputFormat || '1080i5000',
        liveInputSourceName: settings.liveInputSourceName,
        casparConfigPath: settings.casparConfigPath,
        casparOscPort: settings.casparOscPort,
        playoutProfile: settings.playoutProfile,
        transitionFrames: settings.transitionFrames,
        prerollFrames: settings.prerollFrames,
        autoResumeAfterRestart: settings.autoResumeAfterRestart !== false,
        ingestorApiBaseUrl: settings.ingestorApiBaseUrl,
        
        // CG settings
        cg: {
            stationIdPath: settings.cg?.stationIdPath || '',
            stationIdEnabled: settings.cg?.stationIdEnabled !== false,
        },
        
        // CG Paths
        cgRatingKPath: settings.cgRatingKPath || '',
        cgRating8Path: settings.cgRating8Path || '',
        cgRating12Path: settings.cgRating12Path || '',
        cgRating16Path: settings.cgRating16Path || '',
        cgRating18Path: settings.cgRating18Path || '',
        cgRatingTPPath: settings.cgRatingTPPath || '',

        // CG Positions (Percentages)
        cgStationLogoPos: JSON.parse(JSON.stringify(settings.cgStationLogoPos || { left: 5, top: 5, width: 12, height: 12 })),
        cgRatingBadgePos: JSON.parse(JSON.stringify(settings.cgRatingBadgePos || { left: 88, top: 5, width: 7, height: 7 })),
        cgTPPos: JSON.parse(JSON.stringify(settings.cgTPPos || { left: 88, top: 13, width: 7, height: 7 })),
        cgExplanationBannerPos: JSON.parse(JSON.stringify(settings.cgExplanationBannerPos || { left: 60, top: 5, width: 27, height: 7 })),
        cgCrawlPos: JSON.parse(JSON.stringify(settings.cgCrawlPos || { left: 0, top: 90, width: 100, height: 8 })),

        // CG Templates & Crawl
        cgCrawlTemplate: settings.cgCrawlTemplate || 'playout/crawl',
        cgCrawlPosition: settings.cgCrawlPosition || 'bottom',
        cgCrawlText: settings.cgCrawlText || '',
        cgCrawlActive: settings.cgCrawlActive || false,
        cgExplanationTemplate: settings.cgExplanationTemplate || 'playout/explanation'
    };
};

onMounted(() => {
    mapLocalState();

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
    settings.updateSettings(localState.value);
    try {
        await invoke('configure_caspar_osc_listener', { port: localState.value.casparOscPort });
    } catch {}
    emit('close');
};

const discardAndClose = () => {
    mapLocalState();
    emit('close');
};

const pickPath = async (target: 'media' | 'logos' | 'ffmpeg-bin' | 'cg-logo' | 'badge-k' | 'badge-8' | 'badge-12' | 'badge-16' | 'badge-18' | 'badge-tp') => {
    const isDirectory = target === 'media' || target === 'logos' || target === 'ffmpeg-bin';
    const defaultPath = (() => {
        if (target === 'media') return localState.value.localMediaPath;
        if (target === 'ffmpeg-bin') return localState.value.ffmpegBinPath;
        if (target === 'logos') return localState.value.logosPath;
        if (target === 'cg-logo') return localState.value.cg.stationIdPath;
        if (target === 'badge-k') return localState.value.cgRatingKPath;
        if (target === 'badge-8') return localState.value.cgRating8Path;
        if (target === 'badge-12') return localState.value.cgRating12Path;
        if (target === 'badge-16') return localState.value.cgRating16Path;
        if (target === 'badge-18') return localState.value.cgRating18Path;
        return localState.value.cgRatingTPPath;
    })();

    const selection = await open({
        title: isDirectory ? 'Choose Folder' : 'Choose Image File',
        multiple: false,
        directory: isDirectory,
        defaultPath: defaultPath || undefined,
        filters: isDirectory
            ? undefined
            : [{ name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] }]
    });

    if (!selection || Array.isArray(selection)) return;

    if (target === 'media') localState.value.localMediaPath = selection;
    else if (target === 'ffmpeg-bin') localState.value.ffmpegBinPath = selection;
    else if (target === 'logos') localState.value.logosPath = selection;
    else if (target === 'cg-logo') localState.value.cg.stationIdPath = selection;
    else if (target === 'badge-k') localState.value.cgRatingKPath = selection;
    else if (target === 'badge-8') localState.value.cgRating8Path = selection;
    else if (target === 'badge-12') localState.value.cgRating12Path = selection;
    else if (target === 'badge-16') localState.value.cgRating16Path = selection;
    else if (target === 'badge-18') localState.value.cgRating18Path = selection;
    else if (target === 'badge-tp') localState.value.cgRatingTPPath = selection;
};
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="modal-backdrop" data-command-scope="modal" @click.self="discardAndClose">
      <div class="glass-panel modal-content">
        <div class="modal-header">
          <div class="modal-title-row">
            <span class="settings-badge">SYSTEM CONFIG</span>
            <h2 class="text-accent modal-title">Broadcast Preferences</h2>
          </div>
          <button class="glass-btn btn-icon" @click="discardAndClose" title="Close Settings">✕</button>
        </div>

        <div class="settings-tabs">
          <button class="settings-tab-btn" :class="{ active: activeTab === 'general' }" @click="activeTab = 'general'">
            <span>⚙️</span> General & QC
          </button>
          <button class="settings-tab-btn" :class="{ active: activeTab === 'playout' }" @click="activeTab = 'playout'">
            <span>📺</span> Playout & Hardware
          </button>
          <button class="settings-tab-btn" :class="{ active: activeTab === 'cg' }" @click="activeTab = 'cg'">
            <span>🎨</span> CG & Layouts
          </button>
        </div>

        <div class="modal-body custom-scroll">
          <!-- General & QC Tab -->
          <div v-if="activeTab === 'general'">

              <!-- QC Warning Sensitivity Profile -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">QC & Compliance Warning Sensitivity</h3>
                  <div class="qc-card-grid">
                      <!-- Production Standard -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.qcSensitivity === 'production' }"
                        @click="localState.qcSensitivity = 'production'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge badge-prod">🎬 PRODUCTION (DEFAULT)</span>
                          <input type="radio" value="production" v-model="localState.qcSensitivity">
                        </div>
                        <div class="qc-card-title">Production Standard</div>
                        <p class="qc-desc">
                          Balanced broadcast operation. Editorial subclips with non-keyframe In points are clean (<strong>green</strong>). Alarms trigger for real media corruptions or missing tracks.
                        </p>
                      </div>

                      <!-- Engineering Strict -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.qcSensitivity === 'strict' }"
                        @click="localState.qcSensitivity = 'strict'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge badge-strict">🔬 ENGINEERING STRICT</span>
                          <input type="radio" value="strict" v-model="localState.qcSensitivity">
                        </div>
                        <div class="qc-card-title">Engineering / Nerd Mode</div>
                        <p class="qc-desc">
                          Deep QC inspection. Flags every notice (including non-keyframe alignment on subclips, slight loudness deviations, and GOP notices) with orange warnings.
                        </p>
                      </div>

                      <!-- Broadcast Lenient -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.qcSensitivity === 'lenient' }"
                        @click="localState.qcSensitivity = 'lenient'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge badge-lenient">🛡️ SAFE PLAYBACK</span>
                          <input type="radio" value="lenient" v-model="localState.qcSensitivity">
                        </div>
                        <div class="qc-card-title">Broadcast Lenient</div>
                        <p class="qc-desc">
                          High tolerance. Ignores minor advisory tags; only alerts on fatal errors that would cause on-air blackout (missing file, unplayable format, zero duration).
                        </p>
                      </div>
                  </div>
              </section>

              <!-- Ingestor API & Service Base -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">PlayoutTranscode Ingestor API</h3>
                  <div class="form-group">
                      <label>API Base URL</label>
                      <input type="text" class="glass-input" v-model="localState.ingestorApiBaseUrl" placeholder="http://127.0.0.1:4353">
                      <span class="hint-text">Base URL of the PlayoutTranscode Ingestor REST API for asset metadata, mezzanine validation, and virtual subclip persistence.</span>
                  </div>
              </section>

              <!-- Media Storage & Directory Paths -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">Storage & Media Directories</h3>
                  <div class="form-group">
                      <label>Local Video Root Directory (Fallback)</label>
                      <div class="input-with-button">
                          <input type="text" class="glass-input" v-model="localState.localMediaPath" placeholder="C:/CasparCG/media">
                          <button class="glass-btn" style="flex-shrink: 0;" title="Browse folders" @click="pickPath('media')">📁</button>
                      </div>
                      <span class="hint-text">Absolute path to CasparCG media root. Used as fallback when Ingestor API is offline.</span>
                  </div>

                  <div class="form-group">
                      <label>FFmpeg Bin Directory</label>
                      <div class="input-with-button">
                          <input type="text" class="glass-input" v-model="localState.ffmpegBinPath" placeholder="Requirements/ffmpeg/bin">
                          <button class="glass-btn" style="flex-shrink: 0;" title="Browse FFmpeg bin folder" @click="pickPath('ffmpeg-bin')">📁</button>
                      </div>
                      <span class="hint-text">Optional override. Leave blank to use Requirements/ffmpeg/bin next to installation.</span>
                  </div>

                  <div class="form-group">
                      <label>Logos / Ratings Folder</label>
                      <div class="input-with-button">
                          <input type="text" class="glass-input" v-model="localState.logosPath" placeholder="C:/PlayOut/logos">
                          <button class="glass-btn" style="flex-shrink: 0;" title="Browse logos folder" @click="pickPath('logos')">📁</button>
                      </div>
                      <span class="hint-text">Expected assets: logo.png, K.png, 8.png, 12.png, 16.png, 18.png, tp.png.</span>
                  </div>
              </section>

              <!-- Debug & Diagnostics -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">Debug & Diagnostics</h3>
                  <div class="form-grid">
                      <div class="form-group">
                          <label style="display:flex; align-items:center; gap:8px;">
                              <input type="checkbox" v-model="localState.debugMode">
                              <span>Enable debug tools & diagnostics</span>
                          </label>
                          <span class="hint-text">Shows advanced probe inspectors and enables exportable diagnostic logs.</span>
                      </div>
                  </div>
              </section>
          </div>

          <!-- Playout & Hardware Tab -->
          <div v-if="activeTab === 'playout'">

              <!-- Live Ingest & DeckLink Rebroadcast Section -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">Live Ingest & DeckLink Rebroadcast</h3>
                  <div class="form-grid">
                      <div class="form-group">
                          <label>DeckLink Live Input Device</label>
                          <select class="glass-input" v-model.number="localState.decklinkInputDevice">
                              <option :value="0">None / Use Custom AMCP Route</option>
                              <option :value="1">DeckLink 1 (SDI / HDMI In)</option>
                              <option :value="2">DeckLink 2 (SDI / HDMI In)</option>
                              <option :value="3">DeckLink 3 (SDI / HDMI In)</option>
                              <option :value="4">DeckLink 4 (SDI / HDMI In)</option>
                          </select>
                          <span class="hint-text">Select the hardware DeckLink device used for live feed ingest and the top-bar CUT TO LIVE button.</span>
                      </div>

                      <div class="form-group">
                          <label>Live Input Video Standard</label>
                          <select class="glass-input" v-model="localState.decklinkInputFormat">
                              <option value="1080i5000">1080i50 (PAL Broadcast)</option>
                              <option value="1080p2500">1080p25 (PAL Progressive)</option>
                              <option value="1080i5994">1080i59.94 (NTSC Broadcast)</option>
                              <option value="1080p2997">1080p29.97 (NTSC Progressive)</option>
                              <option value="720p5000">720p50</option>
                              <option value="auto">Auto / Server Default</option>
                          </select>
                          <span class="hint-text">Video format passed to CasparCG when initializing DeckLink live feed.</span>
                      </div>
                  </div>

                  <div class="form-group" style="margin-top:0.75rem;">
                      <label>Custom AMCP Live Route (Fallback / NDI / Stream)</label>
                      <input type="text" class="glass-input" v-model="localState.liveInputSourceName" placeholder="decklink://device/1 or ROUTE 2-10">
                      <span class="hint-text">Custom route command if not using a numbered DeckLink device.</span>
                  </div>
              </section>

              <!-- CasparCG Server Configuration -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">CasparCG Server Configuration</h3>
                  <div class="form-grid">
                      <div class="form-group">
                          <label>OSC Feedback Port</label>
                          <input type="number" min="1" max="65535" class="glass-input" v-model.number="localState.casparOscPort" placeholder="6250">
                          <span class="hint-text">Must match the UDP port configured in CasparCG &lt;predefined-client&gt; (default: 6250).</span>
                      </div>
                      <div class="form-group">
                          <label>casparcg.config Path</label>
                          <input type="text" class="glass-input" v-model="localState.casparConfigPath" placeholder="C:/CasparCG/casparcg.config">
                          <span class="hint-text">Direct path to your CasparCG XML config file.</span>
                      </div>
                  </div>

                  <div style="display:flex;gap:10px;margin-top:12px;">
                      <button class="glass-btn btn-primary" @click="showDecklinkWizard = true">DeckLink Output Wizard</button>
                      <button class="glass-btn" @click="showCasparConfigurator = true">Advanced Configurator</button>
                  </div>
              </section>

              <!-- PAL / SOTA Playout Timing -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">PAL / SOTA Playout Timing</h3>
                  <div class="form-grid">
                      <div class="form-group">
                          <label>Playout Profile</label>
                          <select class="glass-input" v-model="localState.playoutProfile">
                              <option value="PAL_1080I50">PAL 1080i50 (Broadcast Interlaced)</option>
                              <option value="PAL_1080P25">PAL 1080p25 (Progressive)</option>
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
                          <label style="display:flex; align-items:center; gap:8px;">
                              <input type="checkbox" v-model="localState.autoResumeAfterRestart">
                              <span>Auto-resume on CasparCG restart</span>
                          </label>
                          <span class="hint-text">Continues playback from crash-time position if CasparCG server process restarts.</span>
                      </div>
                  </div>
              </section>
          </div>

          <!-- CG & Layouts Tab -->
          <div v-if="activeTab === 'cg'">
              <!-- Logo Scanning and Paths -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title" style="display:flex; justify-content:space-between; align-items:center;">
                      <span>CG Asset Paths</span>
                      <button class="glass-btn btn-primary" style="padding: 4px 12px; font-size: 0.76rem;" @click="scanLogosFolder" title="Scan subfolder /logos inside local media path">
                          ⚡ Auto-Scan /logos
                      </button>
                  </h3>
                  
                  <div class="form-grid">
                      <div class="form-group">
                          <label>Station Logo PNG</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cg.stationIdPath" placeholder="C:/PlayOut/logos/logo.png">
                              <button class="glass-btn" style="flex-shrink: 0;" @click="pickPath('cg-logo')">📁</button>
                          </div>
                      </div>

                      <div class="form-group">
                          <label>Rating K (Kids)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRatingKPath" placeholder="C:/PlayOut/logos/k.png">
                              <button class="glass-btn" style="flex-shrink: 0;" @click="pickPath('badge-k')">📁</button>
                          </div>
                      </div>

                      <div class="form-group">
                          <label>Rating 8 (Ages 8+)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRating8Path" placeholder="C:/PlayOut/logos/8.png">
                              <button class="glass-btn" style="flex-shrink: 0;" @click="pickPath('badge-8')">📁</button>
                          </div>
                      </div>

                      <div class="form-group">
                          <label>Rating 12 (Ages 12+)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRating12Path" placeholder="C:/PlayOut/logos/12.png">
                              <button class="glass-btn" style="flex-shrink: 0;" @click="pickPath('badge-12')">📁</button>
                          </div>
                      </div>

                      <div class="form-group">
                          <label>Rating 16 (Ages 16+)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRating16Path" placeholder="C:/PlayOut/logos/16.png">
                              <button class="glass-btn" style="flex-shrink: 0;" @click="pickPath('badge-16')">📁</button>
                          </div>
                      </div>

                      <div class="form-group">
                          <label>Rating 18 (Adults)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRating18Path" placeholder="C:/PlayOut/logos/18.png">
                              <button class="glass-btn" style="flex-shrink: 0;" @click="pickPath('badge-18')">📁</button>
                          </div>
                      </div>

                      <div class="form-group">
                          <label>TP Overlay (Telemarketing)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRatingTPPath" placeholder="C:/PlayOut/logos/tp.png">
                              <button class="glass-btn" style="flex-shrink: 0;" @click="pickPath('badge-tp')">📁</button>
                          </div>
                      </div>
                  </div>
              </section>

              <!-- Interactive Layout Positioning Studio -->
              <section class="settings-section">
                  <div style="display:flex; justify-content:space-between; align-items:center;">
                      <h3 class="text-secondary section-title" style="margin-bottom:0;">On-Screen Graphic Positioning Studio</h3>
                      <div style="display:flex; align-items:center; gap:8px;">
                          <label style="font-size:0.8rem; color:var(--text-secondary);">Selected Layer:</label>
                          <select v-model="selectedWizardLayer" class="select-layer">
                              <option value="logo">Station Logo</option>
                              <option value="rating">Rating Badge</option>
                              <option value="tp">Telemarketing (TP)</option>
                              <option value="explanation">Explanation Banner</option>
                              <option value="crawl">Emergency Crawl</option>
                          </select>
                      </div>
                  </div>

                  <div class="mock-screen">
                      <div class="safe-area-border" title="10% Title Safe Area"></div>

                      <!-- Station Logo Box -->
                      <div
                          class="layer-box logo-box"
                          :class="{ 'is-selected': selectedWizardLayer === 'logo' }"
                          :style="{
                              left: `${localState.cgStationLogoPos.left}%`,
                              top: `${localState.cgStationLogoPos.top}%`,
                              width: `${localState.cgStationLogoPos.width}%`,
                              height: `${localState.cgStationLogoPos.height}%`
                          }"
                          @mousedown="onDragStart($event, 'logo')"
                      >
                          <span class="box-label">Station Logo</span>
                      </div>

                      <!-- Rating Box -->
                      <div
                          class="layer-box rating-box"
                          :class="{ 'is-selected': selectedWizardLayer === 'rating' }"
                          :style="{
                              left: `${localState.cgRatingBadgePos.left}%`,
                              top: `${localState.cgRatingBadgePos.top}%`,
                              width: `${localState.cgRatingBadgePos.width}%`,
                              height: `${localState.cgRatingBadgePos.height}%`
                          }"
                          @mousedown="onDragStart($event, 'rating')"
                      >
                          <span class="box-label">Rating</span>
                      </div>

                      <!-- TP Box -->
                      <div
                          class="layer-box tp-box"
                          :class="{ 'is-selected': selectedWizardLayer === 'tp' }"
                          :style="{
                              left: `${localState.cgTPPos.left}%`,
                              top: `${localState.cgTPPos.top}%`,
                              width: `${localState.cgTPPos.width}%`,
                              height: `${localState.cgTPPos.height}%`
                          }"
                          @mousedown="onDragStart($event, 'tp')"
                      >
                          <span class="box-label">TP</span>
                      </div>

                      <!-- Explanation Banner Box -->
                      <div
                          class="layer-box explanation-box"
                          :class="{ 'is-selected': selectedWizardLayer === 'explanation' }"
                          :style="{
                              left: `${localState.cgExplanationBannerPos.left}%`,
                              top: `${localState.cgExplanationBannerPos.top}%`,
                              width: `${localState.cgExplanationBannerPos.width}%`,
                              height: `${localState.cgExplanationBannerPos.height}%`
                          }"
                          @mousedown="onDragStart($event, 'explanation')"
                      >
                          <span class="box-label">Explanation</span>
                      </div>

                      <!-- Crawl Box -->
                      <div
                          class="layer-box crawl-box"
                          :class="{ 'is-selected': selectedWizardLayer === 'crawl' }"
                          :style="{
                              left: `${localState.cgCrawlPos.left}%`,
                              top: `${localState.cgCrawlPos.top}%`,
                              width: `${localState.cgCrawlPos.width}%`,
                              height: `${localState.cgCrawlPos.height}%`
                          }"
                          @mousedown="onDragStart($event, 'crawl')"
                      >
                          <span class="box-label">Crawl Text</span>
                      </div>
                  </div>

                  <!-- Precision Coordinate Sliders -->
                  <div class="wizard-sliders" style="margin-top: 1.25rem;">
                      <div class="slider-row">
                          <span class="slider-label">Left X (%)</span>
                          <input type="range" min="0" :max="100 - currentActivePos.width" v-model.number="currentActivePos.left">
                          <span class="slider-value">{{ currentActivePos.left }}%</span>
                      </div>
                      <div class="slider-row">
                          <span class="slider-label">Top Y (%)</span>
                          <input type="range" min="0" :max="100 - currentActivePos.height" v-model.number="currentActivePos.top">
                          <span class="slider-value">{{ currentActivePos.top }}%</span>
                      </div>
                      <div class="slider-row">
                          <span class="slider-label">Width (%)</span>
                          <input type="range" min="2" max="100" v-model.number="currentActivePos.width">
                          <span class="slider-value">{{ currentActivePos.width }}%</span>
                      </div>
                      <div class="slider-row">
                          <span class="slider-label">Height (%)</span>
                          <input type="range" min="2" max="100" v-model.number="currentActivePos.height">
                          <span class="slider-value">{{ currentActivePos.height }}%</span>
                      </div>
                  </div>
              </section>
          </div>
        </div>

        <div class="modal-footer">
          <button class="glass-btn btn-primary" @click="saveSettings">Save Preferences</button>
          <button class="glass-btn" @click="discardAndClose">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Sub-modals -->
    <CasparConfigModal
      v-if="showCasparConfigurator"
      :is-open="showCasparConfigurator"
      :initial-path="localState.casparConfigPath"
      @close="showCasparConfigurator = false"
    />

    <DeckLinkWizard
      v-if="showDecklinkWizard"
      :is-open="showDecklinkWizard"
      :initial-path="localState.casparConfigPath"
      @close="showDecklinkWizard = false"
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
    background: rgba(10, 14, 23, 0.85);
    backdrop-filter: blur(12px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
}

.modal-content {
    width: 860px;
    max-width: 95vw;
    height: 84vh;
    max-height: 850px;
    display: flex;
    flex-direction: column;
    padding: 0;
    background: linear-gradient(180deg, #161b26 0%, #0f131a 100%);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 14px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.85);
    overflow: hidden;
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.modal-title-row {
    display: flex;
    align-items: center;
    gap: 10px;
}

.settings-badge {
    font-size: 0.65rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(56, 189, 248, 0.15);
    color: #38bdf8;
    border: 1px solid rgba(56, 189, 248, 0.3);
}

.modal-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 700;
    color: #f1f5f9;
}

.modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
}

.settings-section {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    padding: 1.15rem;
    margin-bottom: 0.5rem;
}

.section-title {
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
    color: #94a3b8;
    margin-bottom: 0.25rem;
}

.form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
}

.form-group label {
    font-size: 0.78rem;
    color: #cbd5e1;
    font-weight: 600;
}

.form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1rem;
}

.glass-input {
    background: #0b0f17;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    padding: 8px 12px;
    color: #f1f5f9;
    font-size: 0.85rem;
    outline: none;
    transition: all 0.15s;
}

.glass-input:focus {
    border-color: #38bdf8;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.25);
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
    line-height: 1.35;
}

/* QC Sensitivity Cards */
.qc-card-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
}

.qc-radio-card {
    background: rgba(11, 15, 23, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 12px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: all 0.15s;
    user-select: none;
}

.qc-radio-card:hover {
    background: rgba(15, 23, 42, 0.8);
    border-color: rgba(255, 255, 255, 0.18);
}

.qc-radio-card.is-selected {
    border-color: #38bdf8;
    background: rgba(56, 189, 248, 0.08);
    box-shadow: 0 0 12px rgba(56, 189, 248, 0.15);
}

.qc-radio-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.qc-badge {
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    border-radius: 3px;
}

.badge-prod { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }
.badge-strict { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); }
.badge-lenient { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }

.qc-card-title {
    font-size: 0.85rem;
    font-weight: 700;
    color: #f1f5f9;
}

.qc-desc {
    font-size: 0.72rem;
    color: #94a3b8;
    line-height: 1.35;
    margin: 0;
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    padding: 1rem 1.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    gap: 0.75rem;
    background: rgba(0, 0, 0, 0.4);
}

.glass-btn {
    padding: 8px 16px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #cbd5e1;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
}

.glass-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.2);
}

.btn-primary {
    background: rgba(56, 189, 248, 0.15);
    border-color: rgba(56, 189, 248, 0.4);
    color: #38bdf8;
}

.btn-primary:hover {
    background: rgba(56, 189, 248, 0.25);
    border-color: rgba(56, 189, 248, 0.6);
}

.btn-icon {
    padding: 4px 8px;
    font-size: 1.1rem;
    background: transparent;
    border-color: transparent;
}
.btn-icon:hover {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
}

.settings-tabs {
    display: flex;
    gap: 6px;
    padding: 0 1.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.25);
}

.settings-tab-btn {
    padding: 10px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #94a3b8;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 6px;
}

.settings-tab-btn:hover {
    color: #f1f5f9;
}

.settings-tab-btn.active {
    color: #38bdf8;
    border-bottom-color: #38bdf8;
}

/* Visual layout wizard styles */
.mock-screen {
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    position: relative;
    overflow: hidden;
    margin-top: 0.75rem;
    box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.8);
}

.safe-area-border {
    position: absolute;
    top: 5%;
    left: 5%;
    width: 90%;
    height: 90%;
    border: 1px dashed rgba(255, 255, 255, 0.15);
    pointer-events: none;
}

.layer-box {
    position: absolute;
    cursor: move;
    border: 1px solid rgba(255, 255, 255, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    transition: background 0.15s, border-color 0.15s;
    user-select: none;
}

.layer-box:hover {
    border-color: #38bdf8;
}

.layer-box.is-selected {
    border-color: #38bdf8;
    border-width: 2px;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.5);
    z-index: 10;
}

.box-label {
    font-size: 0.65rem;
    font-weight: 700;
    color: #fff;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
    text-transform: uppercase;
    text-align: center;
    padding: 2px;
}

.logo-box { background: rgba(56, 189, 248, 0.25); }
.rating-box { background: rgba(245, 158, 11, 0.25); }
.tp-box { background: rgba(244, 63, 94, 0.25); }
.explanation-box { background: rgba(168, 85, 247, 0.25); }
.crawl-box { background: rgba(59, 130, 246, 0.25); }

.wizard-sliders {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.slider-row {
    display: grid;
    grid-template-columns: 90px 1fr 60px;
    align-items: center;
    gap: 1rem;
}

.slider-label {
    font-size: 0.78rem;
    color: #94a3b8;
    font-weight: 600;
}

.slider-value {
    font-size: 0.8rem;
    color: #f1f5f9;
    text-align: right;
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-weight: 700;
}

.wizard-sliders input[type="range"] {
    accent-color: #38bdf8;
    cursor: pointer;
}

.select-layer {
    background: #0b0f17;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: #f1f5f9;
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 0.8rem;
    font-weight: 600;
    outline: none;
}

@media (max-width: 768px) {
    .qc-card-grid {
        grid-template-columns: 1fr;
    }
}
</style>
