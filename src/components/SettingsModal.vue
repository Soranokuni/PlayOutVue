<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore, DEFAULT_CG_ADVISORY_CONFIG, type CgAdvisoryTemplateConfig } from '../stores/settings';
import CasparConfigModal from './CasparConfigModal.vue';
import DeckLinkWizard from './DeckLinkWizard.vue';
import {
    processStatus,
    processState,
    isPrimaryInstance,
    isStarting,
    isStopping,
    startCasparServer,
    stopCasparServer,
    restartCasparServer,
    validateCasparExecutablePath,
    type CasparValidationInfo
} from '../services/casparProcess';

const props = defineProps({
  isOpen: Boolean
});

const emit = defineEmits(['close']);
const settings = useSettingsStore();
const showCasparConfigurator = ref(false);
const showDecklinkWizard = ref(false);
const activeTab = ref<'general' | 'playout' | 'cg'>('general');
const selectedWizardLayer = ref<'logo' | 'rating' | 'tp' | 'explanation' | 'crawl'>('logo');
const validationInfo = ref<CasparValidationInfo | null>(null);
const isValidating = ref(false);

async function launchBrowserStudio() {
    try {
        await invoke('open_cg_studio_in_browser', {
            templatePath: localState.value.cgExplanationTemplate || null
        });
    } catch (e) {
        console.error('Failed to open browser studio via Tauri:', e);
        window.open('/templates/playout/advisory.html', '_blank');
    }
}

// Local shadow state so we don't mutate Pinia instantly on every keystroke
const localState = ref({
    localMediaPath: '',
    ffmpegBinPath: '',
    debugMode: false,
    logosPath: '',
    theme: 'dark' as 'dark' | 'monokai' | 'light' | 'soft-slate' | 'periwinkle',
    uiScale: 'comfortable' as 'standard' | 'comfortable' | 'large',
    qcSensitivity: 'production' as 'strict' | 'production' | 'lenient',
    decklinkOutputName: '',
    decklinkOutputDevice: 0,
    decklinkInputDevice: 0,
    decklinkInputFormat: '1080i5000',
    liveInputSourceName: '',
    casparConfigPath: '',
    casparOscPort: 6250,
    casparcgExecutablePath: '',
    casparcgConfigFilename: 'casparcg.config',
    casparAutoStart: false,
    casparKeepAliveOnExit: true,
    playoutProfile: 'PAL_1080I50' as 'PAL_1080I50' | 'PAL_1080P25',
    transitionFrames: 2,
    prerollFrames: 2,
    autoResumeAfterRestart: true,
    ingestorApiBaseUrl: '',
    recycleBinAutoPurge: 'disabled' as 'disabled' | '1week' | '2weeks' | '3weeks' | '1month',
    
    // CG settings
    complianceRenderMode: 'html5' as 'html5' | 'legacy_png',
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
    cgExplanationTemplate: 'playout/advisory',
    cgAdvisoryConfig: { ...DEFAULT_CG_ADVISORY_CONFIG } as CgAdvisoryTemplateConfig
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

const applyPositionPreset = (preset: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'unified-advisory') => {
    const layer = selectedWizardLayer.value;
    if (preset === 'top-right') {
        if (layer === 'logo') localState.value.cgStationLogoPos = { left: 88, top: 5, width: 8, height: 8 };
        else if (layer === 'rating') localState.value.cgRatingBadgePos = { left: 88, top: 5, width: 7, height: 7 };
        else if (layer === 'tp') localState.value.cgTPPos = { left: 88, top: 13, width: 7, height: 7 };
        else if (layer === 'explanation') localState.value.cgExplanationBannerPos = { left: 56, top: 5, width: 31, height: 7 };
    } else if (preset === 'top-left') {
        if (layer === 'logo') localState.value.cgStationLogoPos = { left: 5, top: 5, width: 8, height: 8 };
        else if (layer === 'rating') localState.value.cgRatingBadgePos = { left: 5, top: 5, width: 7, height: 7 };
        else if (layer === 'tp') localState.value.cgTPPos = { left: 5, top: 13, width: 7, height: 7 };
        else if (layer === 'explanation') localState.value.cgExplanationBannerPos = { left: 13, top: 5, width: 31, height: 7 };
    } else if (preset === 'bottom-right') {
        if (layer === 'logo') localState.value.cgStationLogoPos = { left: 88, top: 87, width: 8, height: 8 };
        else if (layer === 'rating') localState.value.cgRatingBadgePos = { left: 88, top: 87, width: 7, height: 7 };
        else if (layer === 'tp') localState.value.cgTPPos = { left: 88, top: 79, width: 7, height: 7 };
        else if (layer === 'explanation') localState.value.cgExplanationBannerPos = { left: 56, top: 87, width: 31, height: 7 };
    } else if (preset === 'bottom-left') {
        if (layer === 'logo') localState.value.cgStationLogoPos = { left: 5, top: 87, width: 8, height: 8 };
        else if (layer === 'rating') localState.value.cgRatingBadgePos = { left: 5, top: 87, width: 7, height: 7 };
        else if (layer === 'tp') localState.value.cgTPPos = { left: 5, top: 79, width: 7, height: 7 };
        else if (layer === 'explanation') localState.value.cgExplanationBannerPos = { left: 13, top: 87, width: 31, height: 7 };
    } else if (preset === 'unified-advisory') {
        // Greek NCRTV Standard Top-Right Stencil Advisory Combo
        localState.value.cgRatingBadgePos = { left: 89, top: 5.5, width: 6.5, height: 6.5 };
        localState.value.cgTPPos = { left: 89, top: 12.5, width: 6.5, height: 6.5 };
        localState.value.cgExplanationBannerPos = { left: 58, top: 5.5, width: 30, height: 6.5 };
    }
};

const resetAllLayersToStandard = () => {
    localState.value.cgStationLogoPos = { left: 5, top: 5, width: 10, height: 10 };
    localState.value.cgRatingBadgePos = { left: 88, top: 5, width: 7, height: 7 };
    localState.value.cgTPPos = { left: 88, top: 13, width: 7, height: 7 };
    localState.value.cgExplanationBannerPos = { left: 58, top: 5, width: 29, height: 7 };
    localState.value.cgCrawlPos = { left: 0, top: 92, width: 100, height: 8 };
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

const isDeployingTemplates = ref(false);
const deployTemplatesFromSettings = async () => {
    isDeployingTemplates.value = true;
    try {
        const configPath = localState.value.casparConfigPath || '';
        const templatePath = configPath.trim()
            ? configPath.replace(/[/\\][^/\\]+$/, '/template')
            : (localState.value.localMediaPath ? `${localState.value.localMediaPath}/../template` : null);
        const mediaPath = localState.value.localMediaPath || (configPath.trim() ? configPath.replace(/[/\\][^/\\]+$/, '/media') : null);

        const res = await invoke<{ template_dir: string; deployed: string[]; skipped: string[] }>('deploy_caspar_templates', {
            templatePath,
            mediaPath,
            overwrite: true
        });

        // Ensure cgExplanationTemplate is reset to playout/advisory if it was legacy/invalid
        if (!localState.value.cgExplanationTemplate || localState.value.cgExplanationTemplate === 'testdada' || localState.value.cgExplanationTemplate === 'playout/explanation') {
            localState.value.cgExplanationTemplate = 'playout/advisory';
        }

        alert(`Broadcast CG Templates & Logos deployed successfully!\n\nTarget Directory:\n${res.template_dir}\n\nFiles Deployed:\n• ${res.deployed.join('\n• ')}`);
    } catch (e: any) {
        console.error('Failed to deploy templates:', e);
        alert(`Failed to deploy templates: ${e}`);
    } finally {
        isDeployingTemplates.value = false;
    }
};

const mapLocalState = () => {
    localState.value = {
        localMediaPath: settings.localMediaPath,
        ffmpegBinPath: settings.ffmpegBinPath,
        debugMode: settings.debugMode,
        logosPath: settings.logosPath,
        theme: settings.theme || 'dark',
        uiScale: settings.uiScale || 'comfortable',
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
        recycleBinAutoPurge: settings.recycleBinAutoPurge || 'disabled',
        casparcgExecutablePath: settings.casparcgExecutablePath || '',
        casparcgConfigFilename: settings.casparcgConfigFilename || 'casparcg.config',
        casparAutoStart: settings.casparAutoStart ?? false,
        casparKeepAliveOnExit: settings.casparKeepAliveOnExit ?? true,
        
        // CG settings
        complianceRenderMode: settings.complianceRenderMode || 'html5',
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
        cgExplanationTemplate: (settings.cgExplanationTemplate && settings.cgExplanationTemplate !== 'testdada' && settings.cgExplanationTemplate !== 'playout/explanation')
            ? settings.cgExplanationTemplate
            : 'playout/advisory',
        cgAdvisoryConfig: {
            ...DEFAULT_CG_ADVISORY_CONFIG,
            ...(settings.cgAdvisoryConfig || {})
        }
    };
};

const validateCasparExe = async (path: string) => {
    if (!path.trim()) {
        validationInfo.value = null;
        return;
    }
    isValidating.value = true;
    try {
        validationInfo.value = await validateCasparExecutablePath(path);
    } catch {
        validationInfo.value = null;
    } finally {
        isValidating.value = false;
    }
};

const onExecutableInput = (e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    validateCasparExe(val);
};

const handleStartServerFromSettings = async () => {
    try {
        await startCasparServer();
    } catch (e) {
        alert(`Failed to start CasparCG server: ${e}`);
    }
};

const handleStopServerFromSettings = async () => {
    const confirmed = confirm("Are you sure you want to stop the CasparCG server? Any active on-air playback will be halted.");
    if (!confirmed) return;
    try {
        await stopCasparServer();
    } catch (e) {
        alert(`Failed to stop CasparCG server: ${e}`);
    }
};

const handleRestartServerFromSettings = async () => {
    const confirmed = confirm("Restart CasparCG server? On-air playback will momentarily restart.");
    if (!confirmed) return;
    try {
        await restartCasparServer();
    } catch (e) {
        alert(`Failed to restart CasparCG server: ${e}`);
    }
};

onMounted(() => {
    mapLocalState();

    if (localState.value.casparcgExecutablePath) {
        validateCasparExe(localState.value.casparcgExecutablePath);
    }

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

const emptyBinFromSettings = async () => {
    const confirmed = confirm("Are you sure you want to permanently purge all items from the Recycle Bin? This will delete all physical mezzanine files on disk and all database records for soft-deleted assets.");
    if (!confirmed) return;
    try {
        await invoke('purge_ingestor_recycle_bin', { apiBaseUrlOverride: null });
        alert("Recycle Bin successfully emptied.");
    } catch (e) {
        alert(`Failed to empty Recycle Bin: ${e}`);
    }
};

const pickPath = async (target: 'media' | 'logos' | 'ffmpeg-bin' | 'cg-logo' | 'badge-k' | 'badge-8' | 'badge-12' | 'badge-16' | 'badge-18' | 'badge-tp' | 'caspar-config' | 'caspar-exe' | 'cg-advisory-template' | 'cg-crawl-template') => {
    const isDirectory = target === 'media' || target === 'logos' || target === 'ffmpeg-bin';
    const isConfigFile = target === 'caspar-config';
    const isExeFile = target === 'caspar-exe';
    const isTemplateFile = target === 'cg-advisory-template' || target === 'cg-crawl-template';

    const defaultPath = (() => {
        if (target === 'media') return localState.value.localMediaPath;
        if (target === 'ffmpeg-bin') return localState.value.ffmpegBinPath;
        if (target === 'logos') return localState.value.logosPath;
        if (target === 'caspar-config') return localState.value.casparConfigPath;
        if (target === 'caspar-exe') return localState.value.casparcgExecutablePath;
        if (target === 'cg-advisory-template') return localState.value.cgExplanationTemplate;
        if (target === 'cg-crawl-template') return localState.value.cgCrawlTemplate;
        if (target === 'cg-logo') return localState.value.cg.stationIdPath;
        if (target === 'badge-k') return localState.value.cgRatingKPath;
        if (target === 'badge-8') return localState.value.cgRating8Path;
        if (target === 'badge-12') return localState.value.cgRating12Path;
        if (target === 'badge-16') return localState.value.cgRating16Path;
        if (target === 'badge-18') return localState.value.cgRating18Path;
        return localState.value.cgRatingTPPath;
    })();

    let filters = undefined;
    let title = 'Choose File';
    if (isDirectory) {
        title = 'Choose Folder';
        filters = undefined;
    } else if (isExeFile) {
        title = 'Choose casparcg.exe';
        filters = [
            { name: 'CasparCG Executable', extensions: ['exe'] },
            { name: 'All Files', extensions: ['*'] }
        ];
    } else if (isConfigFile) {
        title = 'Choose casparcg.config';
        filters = [
            { name: 'CasparCG Config', extensions: ['config', 'xml'] },
            { name: 'All Files', extensions: ['*'] }
        ];
    } else if (isTemplateFile) {
        title = 'Choose HTML / Flash CG Template';
        filters = [
            { name: 'HTML5 & Flash Templates', extensions: ['html', 'htm', 'ft'] },
            { name: 'All Files', extensions: ['*'] }
        ];
    } else {
        title = 'Choose Image File';
        filters = [
            { name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp'] },
            { name: 'All Files', extensions: ['*'] }
        ];
    }

    const selection = await open({
        title,
        multiple: false,
        directory: isDirectory,
        defaultPath: defaultPath || undefined,
        filters
    });

    if (!selection || Array.isArray(selection)) return;

    if (target === 'media') localState.value.localMediaPath = selection;
    else if (target === 'ffmpeg-bin') localState.value.ffmpegBinPath = selection;
    else if (target === 'logos') localState.value.logosPath = selection;
    else if (target === 'caspar-config') localState.value.casparConfigPath = selection;
    else if (target === 'caspar-exe') {
        localState.value.casparcgExecutablePath = selection;
        validateCasparExe(selection);
    }
    else if (target === 'cg-advisory-template') {
        // If file is selected, simplify relative path if inside a template directory
        const normalized = selection.replace(/\\/g, '/');
        const match = normalized.match(/template\/(.+?)(\.html|\.htm|\.ft)?$/i);
        localState.value.cgExplanationTemplate = match ? match[1]! : selection;
    }
    else if (target === 'cg-crawl-template') {
        const normalized = selection.replace(/\\/g, '/');
        const match = normalized.match(/template\/(.+?)(\.html|\.htm|\.ft)?$/i);
        localState.value.cgCrawlTemplate = match ? match[1]! : selection;
    }
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

              <!-- UI Scaling & Display Density -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">UI Scale & Layout Density</h3>
                  <div class="qc-card-grid">
                      <!-- Standard Scale (100%) -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.uiScale === 'standard' }"
                        @click="localState.uiScale = 'standard'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge badge-lenient">100% SCALE</span>
                          <input type="radio" value="standard" v-model="localState.uiScale">
                        </div>
                        <div class="qc-card-title">Standard (Compact)</div>
                        <p class="qc-desc">
                          Compact density with 42px rundown rows. Ideal for laptops or multi-window desktop workspaces.
                        </p>
                      </div>

                      <!-- Comfortable Scale (115%) -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.uiScale === 'comfortable' }"
                        @click="localState.uiScale = 'comfortable'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge badge-prod">115% (RECOMMENDED)</span>
                          <input type="radio" value="comfortable" v-model="localState.uiScale">
                        </div>
                        <div class="qc-card-title">Comfortable / Broadcast</div>
                        <p class="qc-desc">
                          Balanced 48px rundown rows with enlarged titles and tabular timing. SOTA default for 1080p/1440p master control.
                        </p>
                      </div>

                      <!-- Large Scale (130%) -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.uiScale === 'large' }"
                        @click="localState.uiScale = 'large'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge badge-strict">130% SCALE</span>
                          <input type="radio" value="large" v-model="localState.uiScale">
                        </div>
                        <div class="qc-card-title">High Visibility / Large</div>
                        <p class="qc-desc">
                          High visibility 54px rows, maximum text contrast, and enlarged click targets for operators needing larger text or wall monitors.
                        </p>
                      </div>
                  </div>
              </section>

              <!-- Visual Theme & Workplace Atmosphere -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">Visual Atmosphere & Theme</h3>
                  <div class="qc-card-grid">
                      <!-- Broadcast Midnight -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.theme === 'dark' }"
                        @click="localState.theme = 'dark'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge badge-lenient">🌌 DARK (DEFAULT)</span>
                          <input type="radio" value="dark" v-model="localState.theme">
                        </div>
                        <div class="qc-card-title">Broadcast Midnight</div>
                        <p class="qc-desc">
                          Deep slate surfaces for low eye fatigue in master control and studio environments.
                        </p>
                      </div>

                      <!-- Monokai Pro -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.theme === 'monokai' }"
                        @click="localState.theme = 'monokai'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge badge-strict">👾 MONOKAI PRO</span>
                          <input type="radio" value="monokai" v-model="localState.theme">
                        </div>
                        <div class="qc-card-title">Engineering Dark ("Nerd Mode")</div>
                        <p class="qc-desc">
                          High-contrast charcoal surfaces with iconic Monokai lime green, cyan, and magenta syntax accents.
                        </p>
                      </div>

                      <!-- Clean Studio Light -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.theme === 'light' }"
                        @click="localState.theme = 'light'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge badge-prod">☀️ STUDIO LIGHT</span>
                          <input type="radio" value="light" v-model="localState.theme">
                        </div>
                        <div class="qc-card-title">Clean Studio Light</div>
                        <p class="qc-desc">
                          High-contrast daylight theme with crisp slate typography and clear borders for well-lit rooms.
                        </p>
                      </div>

                      <!-- Soft Slate Neumorphic (Images 1, 3, 5) -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.theme === 'soft-slate' }"
                        @click="localState.theme = 'soft-slate'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge" style="background: rgba(37, 99, 235, 0.15); color: #2563eb; border-color: rgba(37, 99, 235, 0.3);">🪨 SOFT SLATE NEUMORPHIC</span>
                          <input type="radio" value="soft-slate" v-model="localState.theme">
                        </div>
                        <div class="qc-card-title">Soft Slate Clay</div>
                        <p class="qc-desc">
                          Tactile clay neumorphism with soft dual-shadow extrusion, sunken inputs, and steel blue accents.
                        </p>
                      </div>

                      <!-- Periwinkle Studio Glow (Images 2, 4) -->
                      <div
                        class="qc-radio-card"
                        :class="{ 'is-selected': localState.theme === 'periwinkle' }"
                        @click="localState.theme = 'periwinkle'"
                      >
                        <div class="qc-radio-header">
                          <span class="qc-badge" style="background: rgba(124, 105, 239, 0.15); color: #7c69ef; border-color: rgba(124, 105, 239, 0.3);">💜 PERIWINKLE STUDIO</span>
                          <input type="radio" value="periwinkle" v-model="localState.theme">
                        </div>
                        <div class="qc-card-title">Lavender / Periwinkle Glow</div>
                        <p class="qc-desc">
                          Music &amp; entertainment neumorphic theme with soft lilac surfaces, pill controls, and periwinkle glow.
                        </p>
                      </div>
                  </div>
              </section>

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

              <!-- Recycle Bin & Storage Auto-Purge -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">Recycle Bin & Storage Auto-Purge</h3>
                  <div class="form-group">
                      <label>Automatic Purge Schedule</label>
                      <select class="glass-select" v-model="localState.recycleBinAutoPurge">
                          <option value="disabled">Disabled (Keep deleted items indefinitely)</option>
                          <option value="1week">After 1 Week (7 Days)</option>
                          <option value="2weeks">After 2 Weeks (14 Days)</option>
                          <option value="3weeks">After 3 Weeks (21 Days)</option>
                          <option value="1month">After 1 Month (30 Days)</option>
                      </select>
                      <span class="hint-text">Items older than the selected retention window will be permanently removed from disk and database during background maintenance.</span>
                  </div>

                  <div class="form-group" style="margin-top: 12px;">
                      <label>Manual Storage Cleanup</label>
                      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); padding: 10px 14px; border-radius: 8px;">
                          <div>
                              <div style="font-weight: 600; font-size: 0.85rem; color: #fca5a5;">Empty Recycle Bin</div>
                              <div style="font-size: 0.75rem; color: #94a3b8;">Permanently delete all soft-deleted items from physical storage now.</div>
                          </div>
                          <button
                              class="glass-btn"
                              style="background: #dc2626; color: #fff; border-color: #b91c1c; font-weight: 600; padding: 6px 14px; flex-shrink: 0;"
                              @click="emptyBinFromSettings"
                          >
                              Empty Now
                          </button>
                      </div>
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

              <!-- Unified Hardware & DeckLink Setup Card -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title" style="display:flex; justify-content:space-between; align-items:center;">
                      <span>Playout Hardware & DeckLink I/O</span>
                      <button class="glass-btn btn-primary" style="padding: 5px 14px; font-size: 0.78rem;" @click="showDecklinkWizard = true">
                          ⚡ Launch Hardware Setup Wizard
                      </button>
                  </h3>
                  <p class="hint-text" style="margin: 0 0 10px 0;">
                      Use the Setup Wizard to configure Blackmagic DeckLink SDI Program Output, Live Camera/Ingest feed, Video Standards, and auto-deploy broadcast HTML5 CG templates in one coherent flow.
                  </p>

                  <div class="qc-card-grid" style="grid-template-columns: repeat(3, 1fr);">
                      <div class="qc-radio-card" style="cursor:default;">
                          <div class="qc-radio-header">
                              <span class="qc-badge badge-prod">PROGRAM OUT</span>
                          </div>
                          <div class="qc-card-title">
                              {{ localState.decklinkOutputDevice > 0 ? `DeckLink ${localState.decklinkOutputDevice}` : 'Not Configured' }}
                          </div>
                          <p class="qc-desc">
                              Master SDI Out • {{ localState.playoutProfile || '1080i50' }}
                          </p>
                      </div>

                      <div class="qc-radio-card" style="cursor:default;">
                          <div class="qc-radio-header">
                              <span class="qc-badge" :class="localState.decklinkInputDevice > 0 ? 'badge-lenient' : 'badge-strict'">
                                  {{ localState.decklinkInputDevice > 0 ? 'LIVE INGEST ACTIVE' : 'NO LIVE IN' }}
                              </span>
                          </div>
                          <div class="qc-card-title">
                              {{ localState.decklinkInputDevice > 0 ? `DeckLink ${localState.decklinkInputDevice}` : 'Disabled / Custom' }}
                          </div>
                          <p class="qc-desc">
                              {{ localState.decklinkInputDevice > 0 ? `${localState.decklinkInputFormat} (Rebroadcast)` : 'Manual or Stream route' }}
                          </p>
                      </div>

                      <div class="qc-radio-card" style="cursor:default;">
                          <div class="qc-radio-header">
                              <span class="qc-badge badge-prod">CG TEMPLATES</span>
                          </div>
                          <div class="qc-card-title">HTML5 / CEF</div>
                          <p class="qc-desc">
                              Greek NCRTV Advisory + 50fps Crawl
                          </p>
                      </div>
                  </div>
              </section>

              <!-- CasparCG Process Lifecycle & Binary Management -->
              <section class="settings-section">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                      <h3 class="text-secondary section-title" style="margin: 0;">CasparCG Process & Lifecycle Supervision</h3>
                      <div style="display: flex; gap: 8px; align-items: center;">
                          <span class="instance-role-badge" :class="isPrimaryInstance ? 'role-primary' : 'role-monitor'">
                              {{ isPrimaryInstance ? '🛡️ PRIMARY SUPERVISOR' : '👁️ MONITOR MODE (READ-ONLY)' }}
                          </span>
                          <span class="process-state-badge" :class="'state-' + processState">
                              {{ processStatus?.pid ? `PID: ${processStatus.pid} (${processState.toUpperCase()})` : processState.toUpperCase() }}
                          </span>
                      </div>
                  </div>
                  <p class="hint-text" style="margin: 0 0 12px 0;">
                      Configure the host binary path for dynamic process lifecycle management. When Primary, PlayOutVue supervises server startup, monitors child health, and prevents split-brain command collisions.
                  </p>

                  <div class="form-grid">
                      <div class="form-group" style="grid-column: span 2;">
                          <label>CasparCG Executable Path (casparcg.exe)</label>
                          <div class="input-with-button">
                              <input
                                  type="text"
                                  class="glass-input"
                                  v-model="localState.casparcgExecutablePath"
                                  placeholder="e.g. C:/CasparCG/casparcg.exe"
                                  @input="onExecutableInput"
                              >
                              <button class="glass-btn" style="flex-shrink: 0;" title="Browse CasparCG binary" @click="pickPath('caspar-exe')">📁 Browse</button>
                          </div>
                          <div v-if="validationInfo" style="margin-top: 6px; font-size: 0.75rem; display: flex; align-items: center; gap: 6px;">
                              <span :style="{ color: validationInfo.isValid ? '#4ade80' : '#f87171' }">
                                  {{ validationInfo.isValid ? '✓' : '⚠️' }} {{ validationInfo.message }}
                              </span>
                              <span v-if="validationInfo.parentDir" class="hint-text">
                                  (Working Dir CWD: {{ validationInfo.parentDir }})
                              </span>
                          </div>
                      </div>

                      <div class="form-group">
                          <label>Config Filename / Channel Argument</label>
                          <input
                              type="text"
                              class="glass-input"
                              v-model="localState.casparcgConfigFilename"
                              placeholder="casparcg.config (or custom like channel_2.config)"
                          >
                          <span class="hint-text">Allows multi-instance channel configurations in the same folder.</span>
                      </div>

                      <div class="form-group" style="display: flex; flex-direction: column; justify-content: center; gap: 8px;">
                          <label class="checkbox-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                              <input type="checkbox" v-model="localState.casparAutoStart">
                              <span>Auto-start CasparCG server on PlayOut launch</span>
                          </label>
                          <label class="checkbox-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                              <input type="checkbox" v-model="localState.casparKeepAliveOnExit">
                              <span>24/7 Playout Continuity (Keep server running if PlayOut exits)</span>
                          </label>
                      </div>
                  </div>

                  <!-- Process Lifecycle Actions -->
                  <div style="display: flex; gap: 10px; margin-top: 14px; align-items: center;">
                      <button
                          class="glass-btn btn-primary"
                          :disabled="!isPrimaryInstance || isStarting || processState === 'starting' || processState === 'operational'"
                          @click="handleStartServerFromSettings"
                      >
                          {{ isStarting ? '⏳ Starting...' : '▶ Start Server' }}
                      </button>
                      <button
                          class="glass-btn"
                          :disabled="!isPrimaryInstance || isStopping || processState === 'stopped' || processState === 'unconfigured'"
                          @click="handleStopServerFromSettings"
                          style="color: #f87171; border-color: rgba(248, 113, 113, 0.4);"
                      >
                          {{ isStopping ? '⏳ Stopping...' : '■ Stop Server' }}
                      </button>
                      <button
                          class="glass-btn"
                          :disabled="!isPrimaryInstance || isStarting || processState === 'stopped' || processState === 'unconfigured'"
                          @click="handleRestartServerFromSettings"
                      >
                          🔄 Restart Server
                      </button>
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
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.casparConfigPath" placeholder="C:/CasparCG/casparcg.config">
                              <button class="glass-btn" style="flex-shrink: 0;" title="Browse casparcg.config" @click="pickPath('caspar-config')">📁 Browse</button>
                          </div>
                          <span class="hint-text">Direct path to your CasparCG XML config file.</span>
                      </div>
                  </div>

                  <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;">
                       <button class="glass-btn btn-primary" @click="showDecklinkWizard = true">Open Setup Wizard</button>
                       <button class="glass-btn" @click="showCasparConfigurator = true">Advanced XML Configurator</button>
                       <button class="glass-btn" @click="deployTemplatesFromSettings" :disabled="isDeployingTemplates" style="background: rgba(56, 189, 248, 0.15); border-color: rgba(56, 189, 248, 0.4); color: #38bdf8;">
                           {{ isDeployingTemplates ? '⏳ Deploying Templates...' : '🚀 Deploy CG Templates & Logos to CasparCG' }}
                       </button>
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
              <!-- Graphics Pipeline Selector -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">Age Rating Graphics Engine (Σήματα Καταλληλότητας)</h3>
                  <div class="qc-radio-grid">
                      <div
                          class="qc-radio-card"
                          :class="{ active: localState.complianceRenderMode === 'html5' }"
                          @click="localState.complianceRenderMode = 'html5'"
                      >
                          <div class="qc-radio-header">
                              <span class="qc-badge badge-prod">RECOMMENDED (SOTA)</span>
                              <input type="radio" value="html5" v-model="localState.complianceRenderMode" />
                          </div>
                          <div class="qc-card-title">HTML5 Vector Graphics (Layer 32)</div>
                          <p class="qc-desc">
                              Dynamic frosted-glass stencils with 30s Greek ESR rating &amp; content warning banners, smooth elastic pop-in and fade-out. No PNG files required.
                          </p>
                      </div>

                      <div
                          class="qc-radio-card"
                          :class="{ active: localState.complianceRenderMode === 'legacy_png' }"
                          @click="localState.complianceRenderMode = 'legacy_png'"
                      >
                          <div class="qc-radio-header">
                              <span class="qc-badge badge-lenient">LEGACY PIPELINE</span>
                              <input type="radio" value="legacy_png" v-model="localState.complianceRenderMode" />
                          </div>
                          <div class="qc-card-title">Static PNG Images (Layer 31)</div>
                          <p class="qc-desc">
                              Plays classic static image badges (<code style="font-size:0.75rem;">16.png</code>, <code style="font-size:0.75rem;">K.png</code>) via CasparCG Image Producer.
                          </p>
                      </div>
                  </div>
              </section>

              <!-- HTML5 Advisory & Stencil Theme Architecture -->
              <section v-if="localState.complianceRenderMode === 'html5'" class="settings-section">
                  <h3 class="text-secondary section-title" style="display:flex; justify-content:space-between; align-items:center;">
                      <span>🎨 HTML5 Advisory &amp; Neumorphic Stencil Studio</span>
                      <button class="glass-btn btn-primary" style="padding: 4px 12px; font-size: 0.76rem;" @click="launchBrowserStudio" title="Launch standalone interactive visual studio in default browser">
                          ✨ Launch Full Interactive CG Studio
                      </button>
                  </h3>
                  <div class="form-grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));">
                      <div class="form-group">
                          <label>Design Language Preset</label>
                          <select class="glass-input" v-model="localState.cgAdvisoryConfig.themeName">
                              <option value="frosted">Hybrid Frosted Glass (Default SOTA)</option>
                              <option value="matte-slate">Option 1: Matte Extruded Slate</option>
                              <option value="vibrant-accent">Option 2: Vibrant Accent Extrusion</option>
                              <option value="inset-embossed">Option 3: Inset Embossed Slate</option>
                              <option value="dark-obsidian">Option 5: Obsidian Dark MCR</option>
                          </select>
                      </div>

                      <div class="form-group">
                          <label>Badge Stencil Cutout Style</label>
                          <select class="glass-input" v-model="localState.cgAdvisoryConfig.stencilStyle">
                              <option value="neumorphic">Soft Deboss (Low Contrast Neumorphic)</option>
                              <option value="frosted">Frosted Glass Specular</option>
                              <option value="contrast">High Contrast Outline</option>
                          </select>
                      </div>

                      <div class="form-group">
                          <label>Badge Geometric Shape</label>
                          <select class="glass-input" v-model="localState.cgAdvisoryConfig.badgeShape">
                              <option value="circle">Circular (Standard NCRTV)</option>
                              <option value="squircle">Squircle (Modern Soft Neumorphic)</option>
                              <option value="pill">Pill Tag</option>
                          </select>
                      </div>

                      <div class="form-group">
                          <label>Screen Anchor Position</label>
                          <select class="glass-input" v-model="localState.cgAdvisoryConfig.anchorPosition">
                              <option value="top-right">Top-Right (Standard NCRTV)</option>
                              <option value="top-left">Top-Left</option>
                              <option value="bottom-right">Bottom-Right</option>
                              <option value="bottom-left">Bottom-Left</option>
                          </select>
                      </div>

                      <div class="form-group">
                          <label>Text &amp; Bar Vertical Offset (px)</label>
                          <input type="number" min="-40" max="40" class="glass-input" v-model.number="localState.cgAdvisoryConfig.textOffsetYPx" placeholder="0">
                      </div>

                      <div class="form-group">
                          <label>Rating Explanation Hold (Seconds)</label>
                          <input type="number" min="2" max="120" class="glass-input" v-model.number="localState.cgAdvisoryConfig.ratingHoldSec" placeholder="4">
                      </div>

                      <div class="form-group">
                          <label>Warning Descriptors Hold (Seconds)</label>
                          <input type="number" min="4" max="120" class="glass-input" v-model.number="localState.cgAdvisoryConfig.warningHoldSec" placeholder="30">
                      </div>
                  </div>
              </section>

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

              <!-- CG HTML5 Templates -->
              <section class="settings-section">
                  <h3 class="text-secondary section-title">CG HTML5 Templates</h3>
                  <div class="form-grid">
                      <div class="form-group">
                          <label>Greek ESR Advisory Template (Layer 32)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgExplanationTemplate" placeholder="playout/advisory">
                              <button class="glass-btn" style="flex-shrink: 0;" title="Browse template file" @click="pickPath('cg-advisory-template')">📁</button>
                          </div>
                          <span class="hint-text">Default: <code>playout/advisory</code> (Standard Greek ESR 30s Rating Banner &amp; Content Warnings).</span>
                      </div>

                      <div class="form-group">
                          <label>Emergency Crawl Template (Layer 33)</label>
                          <div class="input-with-button">
                              <input type="text" class="glass-input" v-model="localState.cgCrawlTemplate" placeholder="playout/crawl">
                              <button class="glass-btn" style="flex-shrink: 0;" title="Browse crawl template file" @click="pickPath('cg-crawl-template')">📁</button>
                          </div>
                          <span class="hint-text">Default: <code>playout/crawl</code> (50fps Broadcast Ticker).</span>
                      </div>

                      <div class="form-group" style="grid-column: 1 / -1; margin-top: 4px;">
                          <button type="button" class="glass-btn studio-launch-btn" @click="launchBrowserStudio">
                              🌐 Open Greek Advisory Template Studio in Browser
                          </button>
                          <span class="hint-text" style="margin-top: 4px;">Opens the interactive WYSIWYG studio in your default browser to customize fonts, sizes, margins, and icons with universal station default persistence.</span>
                      </div>
                  </div>
              </section>

              <!-- Interactive Layout Positioning Studio -->
              <section class="settings-section">
                  <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                      <h3 class="text-secondary section-title" style="margin-bottom:0;">On-Screen Graphic Positioning Studio (Σήματα)</h3>
                      <div style="display:flex; align-items:center; gap:8px;">
                          <label style="font-size:0.8rem; color:var(--text-secondary);">Selected Layer:</label>
                          <select v-model="selectedWizardLayer" class="select-layer">
                              <option value="logo">Station Logo (L30)</option>
                              <option value="rating">Rating Badge (L31)</option>
                              <option value="tp">Telemarketing TP (L34)</option>
                              <option value="explanation">Advisory / Explanation (L32)</option>
                              <option value="crawl">Emergency Crawl (L33)</option>
                          </select>
                      </div>
                  </div>

                  <!-- Quick Position Presets Toolbar -->
                  <div class="position-presets-bar" style="display:flex; flex-wrap:wrap; gap:6px; margin-top:0.75rem;">
                      <span style="font-size:0.75rem; font-weight:700; color:#94a3b8; align-self:center; margin-right:4px;">Presets:</span>
                      <button type="button" class="preset-btn" @click="applyPositionPreset('top-right')">↗ Top-Right</button>
                      <button type="button" class="preset-btn" @click="applyPositionPreset('top-left')">↖ Top-Left</button>
                      <button type="button" class="preset-btn" @click="applyPositionPreset('bottom-right')">↘ Bottom-Right</button>
                      <button type="button" class="preset-btn" @click="applyPositionPreset('bottom-left')">↙ Bottom-Left</button>
                      <button type="button" class="preset-btn btn-highlight" @click="applyPositionPreset('unified-advisory')">🇬🇷 Greek Advisory Standard</button>
                      <button type="button" class="preset-btn" @click="resetAllLayersToStandard">↺ Reset All Layers</button>
                  </div>

                  <div class="mock-screen">
                      <!-- Broadcast Safe Areas (EBU R95: 90% Action Safe, 80% Title Safe) -->
                      <div class="safe-area-action" title="90% Action Safe Area"></div>
                      <div class="safe-area-border" title="80% Title Safe Area"></div>

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
                          <span class="box-label">Logo</span>
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
                          <span class="box-label">16</span>
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
                          <span class="box-label">⚠️ Advisory Banner</span>
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
                          <span class="box-label">Emergency Crawl Ticker</span>
                      </div>
                  </div>

                  <!-- Precision Coordinate Sliders with Exact Numeric Inputs -->
                  <div class="wizard-sliders" style="margin-top: 1.25rem;">
                      <div class="slider-row">
                          <span class="slider-label">Left X (%)</span>
                          <input type="range" min="0" :max="100 - currentActivePos.width" step="0.5" v-model.number="currentActivePos.left">
                          <div class="input-coord-wrap">
                              <input type="number" min="0" :max="100 - currentActivePos.width" step="0.5" class="coord-number-input" v-model.number="currentActivePos.left">
                              <span class="coord-unit">%</span>
                          </div>
                      </div>
                      <div class="slider-row">
                          <span class="slider-label">Top Y (%)</span>
                          <input type="range" min="0" :max="100 - currentActivePos.height" step="0.5" v-model.number="currentActivePos.top">
                          <div class="input-coord-wrap">
                              <input type="number" min="0" :max="100 - currentActivePos.height" step="0.5" class="coord-number-input" v-model.number="currentActivePos.top">
                              <span class="coord-unit">%</span>
                          </div>
                      </div>
                      <div class="slider-row">
                          <span class="slider-label">Width (%)</span>
                          <input type="range" min="2" max="100" step="0.5" v-model.number="currentActivePos.width">
                          <div class="input-coord-wrap">
                              <input type="number" min="2" max="100" step="0.5" class="coord-number-input" v-model.number="currentActivePos.width">
                              <span class="coord-unit">%</span>
                          </div>
                      </div>
                      <div class="slider-row">
                          <span class="slider-label">Height (%)</span>
                          <input type="range" min="2" max="100" step="0.5" v-model.number="currentActivePos.height">
                          <div class="input-coord-wrap">
                              <input type="number" min="2" max="100" step="0.5" class="coord-number-input" v-model.number="currentActivePos.height">
                              <span class="coord-unit">%</span>
                          </div>
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
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(12px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
}

.modal-content {
    width: 890px;
    max-width: 95vw;
    height: 86vh;
    max-height: 860px;
    display: flex;
    flex-direction: column;
    padding: 0;
    background: var(--bg-secondary);
    border: 1px solid var(--border-medium);
    border-radius: 14px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
    overflow: hidden;
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
}

.modal-title-row {
    display: flex;
    align-items: center;
    gap: 10px;
}

.settings-badge {
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    padding: 2px 7px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent-blue) 15%, transparent);
    color: var(--accent-blue);
    border: 1px solid color-mix(in srgb, var(--accent-blue) 35%, transparent);
}

.modal-title {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 700;
    color: var(--text-primary);
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
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    padding: 1.15rem;
    margin-bottom: 0.5rem;
}

.section-title {
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
    color: var(--text-secondary);
    margin-bottom: 0.25rem;
}

.form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
}

.form-group label {
    font-size: 0.82rem;
    color: var(--text-primary);
    font-weight: 600;
}

.form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1rem;
}

.glass-input {
    background: var(--bg-input);
    border: 1px solid var(--border-medium);
    border-radius: 6px;
    padding: 8px 12px;
    color: var(--text-primary);
    font-size: 0.88rem;
    outline: none;
    transition: all 0.15s;
}

.glass-input:focus {
    border-color: var(--accent-blue);
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent-blue) 25%, transparent);
}

.input-with-button {
    display: flex;
    gap: 8px;
}

.input-with-button .glass-input {
    flex: 1;
}

.hint-text {
    font-size: 0.74rem;
    color: var(--text-muted);
    line-height: 1.35;
}

/* QC & Scale Cards */
.qc-card-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
}

.qc-radio-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
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
    background: var(--bg-hover);
    border-color: var(--border-strong);
}

.qc-radio-card.is-selected {
    border-color: var(--accent-blue);
    background: color-mix(in srgb, var(--accent-blue) 12%, var(--bg-secondary));
    box-shadow: 0 0 12px color-mix(in srgb, var(--accent-blue) 20%, transparent);
}

.qc-radio-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.qc-badge {
    font-size: 0.64rem;
    font-weight: 800;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    border-radius: 3px;
}

.badge-prod { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.35); }
.badge-strict { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.35); }
.badge-lenient { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); }

.qc-card-title {
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--text-primary);
}

.qc-desc {
    font-size: 0.75rem;
    color: var(--text-secondary);
    line-height: 1.35;
    margin: 0;
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--border-subtle);
    gap: 0.75rem;
    background: var(--bg-tertiary);
}

.glass-btn {
    padding: 8px 16px;
    border-radius: 6px;
    background: var(--bg-hover);
    border: 1px solid var(--border-medium);
    color: var(--text-primary);
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
}

.glass-btn:hover {
    background: color-mix(in srgb, var(--accent-blue) 10%, var(--bg-hover));
    border-color: var(--border-strong);
}

.btn-primary {
    background: color-mix(in srgb, var(--accent-blue) 18%, transparent);
    border-color: var(--accent-blue);
    color: var(--accent-blue);
    font-weight: 700;
}

.btn-primary:hover {
    background: color-mix(in srgb, var(--accent-blue) 28%, transparent);
    box-shadow: 0 0 12px color-mix(in srgb, var(--accent-blue) 35%, transparent);
}

.btn-icon {
    padding: 4px 8px;
    font-size: 1.1rem;
    background: transparent;
    border-color: transparent;
    color: var(--text-secondary);
}
.btn-icon:hover {
    background: rgba(239, 68, 68, 0.15);
    color: var(--accent-red);
}

.settings-tabs {
    display: flex;
    gap: 6px;
    padding: 0 1.5rem;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-tertiary);
}

.settings-tab-btn {
    padding: 10px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 6px;
}

.settings-tab-btn:hover {
    color: var(--text-primary);
}

.settings-tab-btn.active {
    color: var(--accent-blue);
    border-bottom-color: var(--accent-blue);
    font-weight: 700;
}

/* Visual layout wizard styles */
.mock-screen {
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #06090e;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    position: relative;
    overflow: hidden;
    margin-top: 0.75rem;
    box-shadow: inset 0 0 30px rgba(0, 0, 0, 0.9);
}

.safe-area-action {
    position: absolute;
    top: 5%;
    left: 5%;
    width: 90%;
    height: 90%;
    border: 1px dashed rgba(34, 197, 94, 0.35);
    pointer-events: none;
}

.safe-area-border {
    position: absolute;
    top: 10%;
    left: 10%;
    width: 80%;
    height: 80%;
    border: 1px dashed rgba(234, 179, 8, 0.4);
    pointer-events: none;
}

.layer-box {
    position: absolute;
    cursor: move;
    border: 1.5px solid rgba(255, 255, 255, 0.6);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
    user-select: none;
    border-radius: 4px;
}

.layer-box:hover {
    border-color: #38bdf8;
    box-shadow: 0 0 10px rgba(56, 189, 248, 0.4);
}

.layer-box.is-selected {
    border-color: #38bdf8;
    border-width: 2px;
    box-shadow: 0 0 14px rgba(56, 189, 248, 0.7);
    z-index: 10;
}

.box-label {
    font-size: 0.68rem;
    font-weight: 800;
    color: #fff;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
    text-transform: uppercase;
    text-align: center;
    padding: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.logo-box { background: rgba(56, 189, 248, 0.3); border-radius: 6px; }
.rating-box { background: rgba(255, 255, 255, 0.28); border-radius: 50%; border-color: rgba(255, 255, 255, 0.8); }
.tp-box { background: rgba(255, 255, 255, 0.25); border-radius: 4px; }
.explanation-box { background: rgba(255, 255, 255, 0.22); border-radius: 16px; }
.crawl-box { background: rgba(15, 23, 42, 0.75); border-radius: 0; border-top-color: #38bdf8; }

.position-presets-bar {
    margin-bottom: 0.5rem;
}

.preset-btn {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: #cbd5e1;
    font-size: 0.75rem;
    font-weight: 700;
    padding: 4px 10px;
    border-radius: 5px;
    cursor: pointer;
    transition: all 0.15s ease;
}

.preset-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.35);
    color: #fff;
}

.preset-btn.btn-highlight {
    background: rgba(56, 189, 248, 0.18);
    border-color: rgba(56, 189, 248, 0.45);
    color: #38bdf8;
}

.preset-btn.btn-highlight:hover {
    background: rgba(56, 189, 248, 0.3);
    border-color: #38bdf8;
    color: #fff;
}

.wizard-sliders {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.slider-row {
    display: grid;
    grid-template-columns: 90px 1fr 90px;
    align-items: center;
    gap: 1rem;
}

.slider-label {
    font-size: 0.78rem;
    color: #94a3b8;
    font-weight: 600;
}

.input-coord-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
    background: #0b0f17;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 5px;
    padding: 3px 6px;
}

.coord-number-input {
    width: 50px;
    background: transparent;
    border: none;
    color: #f1f5f9;
    font-size: 0.8rem;
    font-weight: 700;
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    text-align: right;
    outline: none;
    -moz-appearance: textfield;
}
.coord-number-input::-webkit-outer-spin-button,
.coord-number-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
}

.coord-unit {
    font-size: 0.75rem;
    color: #64748b;
    font-weight: 600;
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

.studio-launch-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: linear-gradient(135deg, rgba(14, 165, 233, 0.25) 0%, rgba(59, 130, 246, 0.25) 100%);
    border: 1px solid rgba(56, 189, 248, 0.45);
    color: #38bdf8;
    font-weight: 700;
    padding: 10px 18px;
    border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    transition: all 0.2s ease;
    cursor: pointer;
}

.studio-launch-btn:hover {
    background: linear-gradient(135deg, rgba(14, 165, 233, 0.45) 0%, rgba(59, 130, 246, 0.45) 100%);
    border-color: #38bdf8;
    color: #ffffff;
    box-shadow: 0 0 16px rgba(56, 189, 248, 0.35);
    transform: translateY(-1px);
}

.instance-role-badge {
    font-size: 0.72rem;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 6px;
    letter-spacing: 0.04em;
}
.role-primary {
    background: rgba(34, 197, 94, 0.15);
    border: 1px solid rgba(34, 197, 94, 0.4);
    color: #4ade80;
}
.role-monitor {
    background: rgba(168, 85, 247, 0.15);
    border: 1px solid rgba(168, 85, 247, 0.4);
    color: #c084fc;
}
.process-state-badge {
    font-size: 0.72rem;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 6px;
    letter-spacing: 0.04em;
}
.state-operational {
    background: rgba(34, 197, 94, 0.15);
    border: 1px solid rgba(34, 197, 94, 0.4);
    color: #4ade80;
}
.state-starting {
    background: rgba(56, 189, 248, 0.15);
    border: 1px solid rgba(56, 189, 248, 0.4);
    color: #38bdf8;
}
.state-stopped {
    background: rgba(245, 158, 11, 0.15);
    border: 1px solid rgba(245, 158, 11, 0.4);
    color: #fbbf24;
}
.state-crashed {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: #f87171;
}
.state-unconfigured {
    background: rgba(148, 163, 184, 0.15);
    border: 1px solid rgba(148, 163, 184, 0.4);
    color: #94a3b8;
}
.state-external_running {
    background: rgba(168, 85, 247, 0.15);
    border: 1px solid rgba(168, 85, 247, 0.4);
    color: #c084fc;
}
</style>
