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
          <h2 class="text-accent">System Configuration</h2>
          <button class="glass-btn btn-icon" @click="discardAndClose">✕</button>
        </div>

        <div class="settings-tabs">
          <button class="settings-tab-btn" :class="{ active: activeTab === 'general' }" @click="activeTab = 'general'">General</button>
          <button class="settings-tab-btn" :class="{ active: activeTab === 'playout' }" @click="activeTab = 'playout'">Playout & Hardware</button>
          <button class="settings-tab-btn" :class="{ active: activeTab === 'cg' }" @click="activeTab = 'cg'">CG & Layouts</button>
        </div>

        <div class="modal-body custom-scroll">
          <!-- General Tab -->
          <div v-if="activeTab === 'general'">
              <!-- Media & Assets Paths -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">External Assets</h3>
                  <div class="form-group">
                      <label>Local Video Root Directory (Fallback)</label>
                      <div class="input-with-button">
                          <input type="text" class="glass-input" v-model="localState.localMediaPath" placeholder="C:/CasparCG/media">
                          <button class="glass-btn" style="flex-shrink: 0;" title="Browse folders" @click="pickPath('media')">📁</button>
                      </div>
                      <span class="hint-text">Absolute path to the CasparCG media root. Used only as a fallback when the Ingestor API is offline, and must match the folder that CasparCG serves.</span>
                  </div>

                  <div class="form-group">
                      <label>FFmpeg Bin Directory</label>
                      <div class="input-with-button">
                          <input type="text" class="glass-input" v-model="localState.ffmpegBinPath" placeholder="Requirements/ffmpeg/bin">
                          <button class="glass-btn" style="flex-shrink: 0;" title="Browse FFmpeg bin folder" @click="pickPath('ffmpeg-bin')">📁</button>
                      </div>
                      <span class="hint-text">Optional override. Leave blank to use Requirements/ffmpeg/bin next to the PlayOut installation.</span>
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

              <section class="settings-section">
                  <h3 class="text-secondary section-title">Ingestor API</h3>
                  <div class="form-group">
                      <label>API Base URL</label>
                      <input type="text" class="glass-input" v-model="localState.ingestorApiBaseUrl" placeholder="http://127.0.0.1:4353">
                      <span class="hint-text">Base URL of the external PlayoutTranscode Ingestor REST API. Asset resolution, trim, rating, and virtual folders are served from here.</span>
                  </div>
              </section>

              <section class="settings-section">
                  <h3 class="text-secondary section-title">Debug & Diagnostics</h3>
                  <div class="form-grid">
                      <div class="form-group">
                          <label style="display:flex; align-items:center; gap:8px;">
                              <input type="checkbox" v-model="localState.debugMode">
                              <span>Enable debug tools</span>
                          </label>
                          <span class="hint-text">Shows the Library debug submenu and captures backend diagnostic logs only when enabled.</span>
                      </div>
                      <div class="form-group">
                          <label>Debug behavior</label>
                          <div class="hint-card">Debug logging stays off in normal runtime. When enabled, you can manually start a background duration probe, inspect ffprobe resolution, and export logs to a .txt file.</div>
                      </div>
                  </div>
              </section>
          </div>

          <!-- Playout & Hardware Tab -->
          <div v-if="activeTab === 'playout'">
              <section class="settings-section">
                  <h3 class="text-secondary section-title">CasparCG Live Route</h3>
                  <div class="form-group">
                      <label>CasparCG source / route</label>
                      <input type="text" class="glass-input" v-model="localState.liveInputSourceName" placeholder="decklink://device/1 or ROUTE 2-10">
                      <span class="hint-text">Used by the CasparCG engine for LIVE NOW and live rundown items. Enter the route or source token that your channel expects.</span>
                  </div>
              </section>

              <section class="settings-section">
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
                  <div class="form-group" style="margin-top: 1rem;">
                      <label>casparcg.config Path</label>
                      <input type="text" class="glass-input" v-model="localState.casparConfigPath" placeholder="C:/CasparCG/casparcg.config">
                      <span class="hint-text">The configurator can load and save your CasparCG XML file directly.</span>
                  </div>
                  <div class="form-group">
                      <button class="glass-btn btn-primary" @click="showDecklinkWizard = true">DeckLink Output Wizard</button>
                      <span class="hint-text">Step-by-step wizard to configure DeckLink output (SDI), live input (SDI), and video standard.</span>
                  </div>
                  <div class="form-group">
                      <button class="glass-btn" @click="showCasparConfigurator = true">Advanced Configurator</button>
                      <span class="hint-text">Full structured editing for channels, consumers, OSC, controllers, and raw XML mode.</span>
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

              <section class="settings-section">
                  <h3 class="text-secondary section-title">Crash Recovery</h3>
                  <div class="form-grid">
                      <div class="form-group">
                          <label style="display:flex; align-items:center; gap:8px;">
                              <input type="checkbox" v-model="localState.autoResumeAfterRestart">
                              <span>Auto-resume after CasparCG restart</span>
                          </label>
                          <span class="hint-text">If CasparCG restarts while a clip is on air, playback automatically continues from the crash-time position. If the clip already finished during the downtime, the next item starts. A brief AMCP drop (network blip) with live OSC feedback is left untouched.</span>
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
                      <button class="glass-btn btn-primary" style="padding: 2px 10px; font-size: 0.76rem;" @click="scanLogosFolder" title="Scan subfolder /logos inside local media path">
                          ⚡ Scan logos subfolder
                      </button>
                  </h3>
                  
                  <div class="form-grid">
                      <div class="form-group">
                          <label>Station Logo (logo.png)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cg.stationIdPath" placeholder="C:/PlayOut/logos/logo.png">
                              <button class="glass-btn" @click="pickPath('cg-logo')">📁</button>
                          </div>
                      </div>
                      <div class="form-group">
                          <label>Product Placement Badge (TP.png)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRatingTPPath" placeholder="C:/PlayOut/logos/TP.png">
                              <button class="glass-btn" @click="pickPath('badge-tp')">📁</button>
                          </div>
                      </div>
                  </div>

                  <div class="form-grid" style="margin-top: 1rem;">
                      <div class="form-group">
                          <label style="display:flex; gap:8px; align-items:center; cursor:pointer;">
                              <input type="checkbox" v-model="localState.cg.stationIdEnabled">
                              <span>Enable Station Logo</span>
                          </label>
                      </div>
                  </div>

                  <div class="form-grid" style="margin-top: 1rem;">
                      <div class="form-group">
                          <label>Rating Badge K (K.png)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRatingKPath" placeholder="K.png path">
                              <button class="glass-btn" @click="pickPath('badge-k')">📁</button>
                          </div>
                      </div>
                      <div class="form-group">
                          <label>Rating Badge 8 (8.png)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRating8Path" placeholder="8.png path">
                              <button class="glass-btn" @click="pickPath('badge-8')">📁</button>
                          </div>
                      </div>
                  </div>

                  <div class="form-grid" style="margin-top: 1rem;">
                      <div class="form-group">
                          <label>Rating Badge 12 (12.png)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRating12Path" placeholder="12.png path">
                              <button class="glass-btn" @click="pickPath('badge-12')">📁</button>
                          </div>
                      </div>
                      <div class="form-group">
                          <label>Rating Badge 16 (16.png)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRating16Path" placeholder="16.png path">
                              <button class="glass-btn" @click="pickPath('badge-16')">📁</button>
                          </div>
                      </div>
                  </div>

                  <div class="form-grid" style="margin-top: 1rem;">
                      <div class="form-group">
                          <label>Rating Badge 18 (18.png)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgRating18Path" placeholder="18.png path">
                              <button class="glass-btn" @click="pickPath('badge-18')">📁</button>
                          </div>
                      </div>
                  </div>
              </section>

              <!-- Resolution-Agnostic Layout Wizard -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">Visual Aspect-Ratio Positioning Wizard</h3>
                  <div class="wizard-container">
                      <div class="wizard-header" style="margin-bottom:1rem; display:flex; justify-content:space-between; align-items:center;">
                          <label class="text-secondary text-sm">Select Overlay to Position:</label>
                          <select v-model="selectedWizardLayer" class="glass-input select-layer" style="width:200px;">
                              <option value="logo">Station Logo</option>
                              <option value="rating">Age Rating Badge</option>
                              <option value="tp">Product Placement (TP)</option>
                              <option value="explanation">Explanation Banner</option>
                              <option value="crawl">Crawl Ticker</option>
                          </select>
                      </div>

                      <!-- The 16:9 aspect-ratio screen container -->
                      <div class="mock-screen">
                          <div class="safe-area-border"></div>
                          
                          <!-- Station Logo -->
                          <div 
                              class="layer-box logo-box" 
                              :class="{ 'is-selected': selectedWizardLayer === 'logo' }"
                              :style="{
                                  left: localState.cgStationLogoPos.left + '%',
                                  top: localState.cgStationLogoPos.top + '%',
                                  width: localState.cgStationLogoPos.width + '%',
                                  height: localState.cgStationLogoPos.height + '%'
                              }"
                              @mousedown="onDragStart($event, 'logo')"
                          >
                              <div class="box-label">Logo</div>
                          </div>

                          <!-- Rating Badge -->
                          <div 
                              class="layer-box rating-box" 
                              :class="{ 'is-selected': selectedWizardLayer === 'rating' }"
                              :style="{
                                  left: localState.cgRatingBadgePos.left + '%',
                                  top: localState.cgRatingBadgePos.top + '%',
                                  width: localState.cgRatingBadgePos.width + '%',
                                  height: localState.cgRatingBadgePos.height + '%'
                              }"
                              @mousedown="onDragStart($event, 'rating')"
                          >
                              <div class="box-label">Rating</div>
                          </div>

                          <!-- TP Badge -->
                          <div 
                              class="layer-box tp-box" 
                              :class="{ 'is-selected': selectedWizardLayer === 'tp' }"
                              :style="{
                                  left: localState.cgTPPos.left + '%',
                                  top: localState.cgTPPos.top + '%',
                                  width: localState.cgTPPos.width + '%',
                                  height: localState.cgTPPos.height + '%'
                              }"
                              @mousedown="onDragStart($event, 'tp')"
                          >
                              <div class="box-label">TP</div>
                          </div>

                          <!-- Explanation Banner -->
                          <div 
                              class="layer-box explanation-box" 
                              :class="{ 'is-selected': selectedWizardLayer === 'explanation' }"
                              :style="{
                                  left: localState.cgExplanationBannerPos.left + '%',
                                  top: localState.cgExplanationBannerPos.top + '%',
                                  width: localState.cgExplanationBannerPos.width + '%',
                                  height: localState.cgExplanationBannerPos.height + '%'
                              }"
                              @mousedown="onDragStart($event, 'explanation')"
                          >
                              <div class="box-label">Explanation Banner</div>
                          </div>

                          <!-- Crawl Ticker -->
                          <div 
                              class="layer-box crawl-box" 
                              :class="{ 'is-selected': selectedWizardLayer === 'crawl' }"
                              :style="{
                                  left: localState.cgCrawlPos.left + '%',
                                  top: localState.cgCrawlPos.top + '%',
                                  width: localState.cgCrawlPos.width + '%',
                                  height: localState.cgCrawlPos.height + '%'
                              }"
                              @mousedown="onDragStart($event, 'crawl')"
                          >
                              <div class="box-label">Crawl Ticker</div>
                          </div>
                      </div>

                      <!-- Slider controls for selected layer -->
                      <div class="wizard-sliders" v-if="currentActivePos" style="margin-top:1.5rem; background:rgba(0,0,0,0.2); padding:1rem; border-radius:8px; border:1px solid var(--glass-border);">
                          <h4 class="text-accent text-sm" style="margin-bottom:0.75rem; text-transform:uppercase;">
                              Adjusting: {{ selectedWizardLayer }}
                          </h4>
                          <div class="slider-row">
                              <span class="slider-label">Left</span>
                              <input type="range" min="0" max="100" v-model.number="currentActivePos.left">
                              <span class="slider-value">{{ currentActivePos.left }}%</span>
                          </div>
                          <div class="slider-row">
                              <span class="slider-label">Top</span>
                              <input type="range" min="0" max="100" v-model.number="currentActivePos.top">
                              <span class="slider-value">{{ currentActivePos.top }}%</span>
                          </div>
                          <div class="slider-row">
                              <span class="slider-label">Width</span>
                              <input type="range" min="1" max="100" v-model.number="currentActivePos.width">
                              <span class="slider-value">{{ currentActivePos.width }}%</span>
                          </div>
                          <div class="slider-row">
                              <span class="slider-label">Height</span>
                              <input type="range" min="1" max="100" v-model.number="currentActivePos.height">
                              <span class="slider-value">{{ currentActivePos.height }}%</span>
                          </div>
                          <div class="hint-text" style="margin-top: 0.5rem; text-align: center;">
                              💡 Drag bounding boxes directly on the screen mockup above or use sliders.
                          </div>
                      </div>
                  </div>
              </section>

              <!-- CG Templates Configuration -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">CG Templates</h3>
                  <div class="form-grid">
                      <div class="form-group">
                          <label>Crawl Ticker Template</label>
                          <input type="text" class="glass-input" v-model="localState.cgCrawlTemplate" placeholder="playout/crawl">
                      </div>
                      <div class="form-group">
                          <label>Explanation Template</label>
                          <input type="text" class="glass-input" v-model="localState.cgExplanationTemplate" placeholder="playout/explanation">
                      </div>
                  </div>
              </section>
          </div>
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

    <DeckLinkWizard
        :is-open="showDecklinkWizard"
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

.settings-tabs {
    display: flex;
    gap: 8px;
    padding: 0 1.5rem;
    border-bottom: 1px solid var(--glass-border);
    background: rgba(0, 0, 0, 0.15);
}

.settings-tab-btn {
    padding: 12px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
}

.settings-tab-btn:hover {
    color: var(--text-primary);
}

.settings-tab-btn.active {
    color: var(--accent-blue);
    border-bottom-color: var(--accent-blue);
}

/* Visual layout wizard styles */
.mock-screen {
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #000;
    border: 2px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    position: relative;
    overflow: hidden;
    margin-top: 1rem;
    box-shadow: inset 0 0 20px rgba(0,0,0,0.8);
}

.safe-area-border {
    position: absolute;
    top: 5%;
    left: 5%;
    width: 90%;
    height: 90%;
    border: 1px dashed rgba(255,255,255,0.15);
    pointer-events: none;
}

.layer-box {
    position: absolute;
    cursor: move;
    border: 1px solid rgba(255,255,255,0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    transition: background 0.2s, border-color 0.2s;
    user-select: none;
}

.layer-box:hover {
    border-color: var(--accent-blue);
}

.layer-box.is-selected {
    border-color: var(--accent-blue);
    border-width: 2px;
    box-shadow: 0 0 8px rgba(51, 190, 204, 0.5);
    z-index: 10;
}

.box-label {
    font-size: 0.65rem;
    font-weight: 600;
    color: #fff;
    text-shadow: 0 1px 3px rgba(0,0,0,0.8);
    text-transform: uppercase;
    text-align: center;
    padding: 2px;
}

.logo-box { background: rgba(51, 190, 204, 0.25); }
.rating-box { background: rgba(248, 180, 0, 0.25); }
.tp-box { background: rgba(230, 57, 70, 0.25); }
.explanation-box { background: rgba(147, 51, 234, 0.25); }
.crawl-box { background: rgba(59, 130, 246, 0.25); }

.wizard-sliders {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.slider-row {
    display: grid;
    grid-template-columns: 80px 1fr 50px;
    align-items: center;
    gap: 1rem;
}

.slider-label {
    font-size: 0.8rem;
    color: var(--text-secondary);
    text-transform: capitalize;
}

.slider-value {
    font-size: 0.8rem;
    color: var(--text-primary);
    text-align: right;
    font-variant-numeric: tabular-nums;
}

.wizard-sliders input[type="range"] {
    accent-color: var(--accent-blue);
    cursor: pointer;
}

.select-layer {
    background: var(--bg-tertiary);
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 0.82rem;
}
</style>
