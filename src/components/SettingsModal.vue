<script setup lang="ts">
import { computed, nextTick, ref, watch, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ask, message, open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore, DEFAULT_CG_ADVISORY_CONFIG, type CgAdvisoryTemplateConfig } from '../stores/settings';
import { describePurgeOutcome, normalizePurgeOutcome } from '../lib/ingestorFeedback';
import { lazyComponent } from '../lib/lazyComponent';
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
import { getActivePlayoutService } from '../services/playout';
import { describeError, describeErrorMessage } from '../lib/describeError';
import { showToast } from '../lib/toasts';
import BaseModal from './ui/BaseModal.vue';
import BaseButton from './ui/BaseButton.vue';
import ModalFooterActions from './ui/ModalFooterActions.vue';
import RadioCardGroup from './ui/RadioCardGroup.vue';
import { THEMES, DEFAULT_THEME_ID, type ThemeDefinition, type ThemeId } from '../config/themes';
import { applyTheme, applyUiScale } from '../lib/theme';
import AppIcon from './ui/AppIcon.vue';
import type { IconName } from './ui/icons';

// PERF F-14: both tools are large, rarely used and already `v-if` guarded.
const { component: CasparConfigModal, preload: preloadCasparConfigModal } = lazyComponent(
    'CasparConfigModal',
    () => import('./CasparConfigModal.vue'),
);
const { component: DeckLinkWizard, preload: preloadDeckLinkWizard } = lazyComponent(
    'DeckLinkWizard',
    () => import('./DeckLinkWizard.vue'),
);

const props = defineProps({
  isOpen: Boolean
});

const emit = defineEmits(['close']);
const settings = useSettingsStore();
const showCasparConfigurator = ref(false);
const showDecklinkWizard = ref(false);
/**
 * UI §4.1: a left rail of seven groups replaces three emoji tabs holding
 * twelve sections. The class stays `settings-tab-btn` because
 * SettingsModalConfirmation.test.ts pins it, and the "Playout engine" entry
 * still contains the word the test looks for.
 */
type SettingsSection = 'appearance' | 'playout' | 'hardware' | 'media' | 'graphics' | 'qc' | 'advanced';

const RAIL: { id: SettingsSection; label: string; icon: IconName }[] = [
    { id: 'appearance', label: 'Appearance', icon: 'graphic' },
    { id: 'playout', label: 'Playout engine', icon: 'play' },
    { id: 'hardware', label: 'Hardware', icon: 'live' },
    { id: 'media', label: 'Media & ingest', icon: 'film' },
    { id: 'graphics', label: 'Graphics (CG)', icon: 'ticker' },
    { id: 'qc', label: 'QC & compliance', icon: 'check' },
    { id: 'advanced', label: 'Advanced', icon: 'settings' },
];

const activeSection = ref<SettingsSection>('appearance');
const modalBodyRef = ref<HTMLElement | null>(null);
const sectionFilter = ref('');

/** Which rail entries still match the filter box. */
const visibleRail = computed(() => {
    const query = sectionFilter.value.trim().toLowerCase();
    if (!query) return RAIL;
    return RAIL.filter((entry) => entry.label.toLowerCase().includes(query));
});

const selectSection = (id: SettingsSection) => {
    activeSection.value = id;
};

// UI F-07: the panes share one scroll container, so moving between them carried
// the previous offset over -- the Playout pane opened scrolled to its bottom.
watch(activeSection, () => {
    nextTick(() => {
        if (modalBodyRef.value) modalBodyRef.value.scrollTop = 0;
    });
});

// Keep a matching entry selected as the operator types in the filter.
watch(visibleRail, (entries) => {
    if (entries.length && !entries.some((entry) => entry.id === activeSection.value)) {
        activeSection.value = entries[0]!.id;
    }
});
const validationInfo = ref<CasparValidationInfo | null>(null);
const isValidating = ref(false);

const detectedCasparDir = computed(() => {
    if (validationInfo.value?.parentDir) {
        return validationInfo.value.parentDir.replace(/\\/g, '/');
    }
    const raw = localState.value.casparcgExecutablePath;
    if (!raw) return '';
    const norm = raw.replace(/\\/g, '/').trim();
    if (!norm) return '';
    if (norm.toLowerCase().endsWith('.exe')) {
        return norm.substring(0, norm.lastIndexOf('/'));
    }
    return norm.replace(/\/$/, '');
});

const effectiveCasparConfigPath = computed(() => {
    if (localState.value.casparConfigPath?.trim()) {
        return localState.value.casparConfigPath.trim();
    }
    if (settings.casparConfigPath?.trim()) {
        return settings.casparConfigPath.trim();
    }
    if (detectedCasparDir.value) {
        return `${detectedCasparDir.value}/${localState.value.casparcgConfigFilename || 'casparcg.config'}`;
    }
    return '';
});

const syncCasparDerivedPaths = (path: string) => {
    if (!path || !path.trim()) return;
    const norm = path.replace(/\\/g, '/').trim();
    const dir = norm.toLowerCase().endsWith('.exe') ? norm.substring(0, norm.lastIndexOf('/')) : norm.replace(/\/$/, '');
    if (dir) {
        if (!localState.value.casparConfigPath || localState.value.casparConfigPath.includes('casparcg.config')) {
            localState.value.casparConfigPath = `${dir}/${localState.value.casparcgConfigFilename || 'casparcg.config'}`;
        }
        if (!localState.value.localMediaPath) {
            localState.value.localMediaPath = `${dir}/media`;
        }
    }
};

const onCasparConfigPathUpdate = (newPath: string) => {
    if (newPath) {
        localState.value.casparConfigPath = newPath;
        settings.updateSettings({ casparConfigPath: newPath });
    }
};

const onDecklinkWizardClose = () => {
    showDecklinkWizard.value = false;
    if (settings.casparConfigPath) {
        localState.value.casparConfigPath = settings.casparConfigPath;
    }
    if (settings.localMediaPath) {
        localState.value.localMediaPath = settings.localMediaPath;
    }
    if (settings.casparcgExecutablePath && !localState.value.casparcgExecutablePath) {
        localState.value.casparcgExecutablePath = settings.casparcgExecutablePath;
    }
    if (settings.playoutProfile) {
        localState.value.playoutProfile = settings.playoutProfile;
    }
};

const onConfigFilenameInput = (e: Event) => {
    const filename = (e.target as HTMLInputElement).value.trim();
    if (detectedCasparDir.value && filename) {
        localState.value.casparConfigPath = `${detectedCasparDir.value}/${filename}`;
    }
};

async function launchBrowserStudio() {
    try {
        const baseDir = detectedCasparDir.value;
        const templatePath = baseDir ? `${baseDir}/template` : null;
        await invoke('open_cg_studio_in_browser', {
            templatePath
        });
    } catch (e) {
        console.error('Failed to open browser studio via Tauri:', e);
        window.open('/templates/playout/advisory.html?studio=1#studio=1', '_blank');
    }
}

// The Ingestor API token is a secret: masked by default, revealed on demand.
const showIngestorToken = ref(false);

// Local shadow state so we don't mutate Pinia instantly on every keystroke
const localState = ref({
    localMediaPath: '',
    ffmpegBinPath: '',
    debugMode: false,
    theme: DEFAULT_THEME_ID as ThemeId,
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
    casparAutoRelaunchOnCrash: true,
    playoutProfile: 'PAL_1080I50' as 'PAL_1080I50' | 'PAL_1080P25',
    transitionFrames: 2,
    prerollFrames: 2,
    autoResumeAfterRestart: true,
    ingestorApiBaseUrl: '',
    ingestorApiToken: '',
    recycleBinAutoPurge: 'disabled' as 'disabled' | '1week' | '2weeks' | '3weeks' | '1month',
    
    // CG settings. The per-rating PNG paths, the five layout positions,
    // complianceRenderMode, cgCrawlPosition, cg.stationIdPath and logosPath are
    // gone (§12.4): they drove the legacy PNG overlay path, which caspar.ts no
    // longer takes. Geometry, colours and SVGs now come from cgAdvisoryConfig,
    // authored in CG Studio and applied on deploy.
    cg: {
        stationIdEnabled: true,
    },

    // CG Templates & Crawl
    cgCrawlTemplate: 'playout/crawl',
    cgCrawlText: '',
    cgCrawlActive: false,
    cgExplanationTemplate: 'playout/advisory',
    cgAdvisoryConfig: { ...DEFAULT_CG_ADVISORY_CONFIG } as CgAdvisoryTemplateConfig
});


const isDeployingTemplates = ref(false);
const deployTemplatesFromSettings = async () => {
    isDeployingTemplates.value = true;
    try {
        const baseDir = detectedCasparDir.value;
        const templatePath = baseDir ? `${baseDir}/template` : null;

        const res = await invoke<{ template_dir: string; deployed: string[]; skipped: string[] }>('deploy_caspar_templates', {
            templatePath,
            mediaPath: null,
            overwrite: true
        });

        // Ensure cgExplanationTemplate is reset to playout/advisory if it was legacy/invalid
        if (!localState.value.cgExplanationTemplate || localState.value.cgExplanationTemplate === 'testdada' || localState.value.cgExplanationTemplate === 'playout/explanation') {
            localState.value.cgExplanationTemplate = 'playout/advisory';
        }

        try {
            const preset = await invoke<any>('get_studio_default_preset');
            if (preset) {
                settings.updateCgAdvisoryFromDeployedPreset(preset);
                localState.value.cgAdvisoryConfig = {
                    ...DEFAULT_CG_ADVISORY_CONFIG,
                    ...(settings.cgAdvisoryConfig || {}),
                };
            }
        } catch (_) {}

        // Auto-refresh Layer 32 so changes take effect immediately with latest preset styling
        await getActivePlayoutService().reloadComplianceTemplate?.();

        await message(`Broadcast CG Templates deployed successfully!\n\nTarget Directory:\n${res.template_dir}\n\nFiles Deployed:\n• ${res.deployed.join('\n• ')}\n\n(On-air graphics have been refreshed automatically without server restart)`, {
            title: 'Broadcast CG Studio',
            kind: 'info'
        });
    } catch (e: any) {
        console.error('Failed to deploy templates:', e);
        await message(describeErrorMessage(e, 'Could not deploy the CG templates.'), {
            title: 'Template Deployment Error',
            kind: 'error'
        });
    } finally {
        isDeployingTemplates.value = false;
    }
};

const mapLocalState = () => {
    localState.value = {
        localMediaPath: settings.localMediaPath,
        ffmpegBinPath: settings.ffmpegBinPath,
        debugMode: settings.debugMode,
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
        ingestorApiToken: settings.ingestorApiToken || '',
        recycleBinAutoPurge: settings.recycleBinAutoPurge || 'disabled',
        casparcgExecutablePath: settings.casparcgExecutablePath || '',
        casparcgConfigFilename: settings.casparcgConfigFilename || 'casparcg.config',
        casparAutoStart: settings.casparAutoStart ?? false,
        casparKeepAliveOnExit: settings.casparKeepAliveOnExit ?? true,
        casparAutoRelaunchOnCrash: settings.casparAutoRelaunchOnCrash ?? true,
        
        // CG settings
        cg: {
            stationIdEnabled: settings.cg?.stationIdEnabled !== false,
        },

        // CG Templates & Crawl
        cgCrawlTemplate: settings.cgCrawlTemplate || 'playout/crawl',
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

    if (!localState.value.casparConfigPath) {
        if (settings.casparConfigPath) {
            localState.value.casparConfigPath = settings.casparConfigPath;
        } else if (localState.value.casparcgExecutablePath) {
            syncCasparDerivedPaths(localState.value.casparcgExecutablePath);
        }
    }
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
    syncCasparDerivedPaths(val);
};

const handleStartServerFromSettings = async () => {
    try {
        await startCasparServer();
        await getActivePlayoutService().connect().catch(() => {});
    } catch (e) {
        await message(describeErrorMessage(e, 'Could not start the CasparCG server.'), {
            title: 'CasparCG Server Error',
            kind: 'error'
        });
    }
};

const handleStopServerFromSettings = async () => {
    const confirmed = await ask("Are you sure you want to stop the CasparCG server? Any active on-air playback will be halted.", {
        title: 'Stop CasparCG Server',
        kind: 'warning'
    });
    if (!confirmed) return;
    try {
        await getActivePlayoutService().disconnect().catch(() => {});
        await stopCasparServer(true);
    } catch (e) {
        await message(describeErrorMessage(e, 'Could not stop the CasparCG server.'), {
            title: 'CasparCG Server Error',
            kind: 'error'
        });
    }
};

const handleRestartServerFromSettings = async () => {
    const confirmed = await ask("Restart CasparCG server? On-air playback will momentarily restart.", {
        title: 'Restart CasparCG Server',
        kind: 'warning'
    });
    if (!confirmed) return;
    try {
        await restartCasparServer();
        const service = getActivePlayoutService();
        await service.connect().catch((err) => console.warn('[Settings] Connect after restart:', err));
    } catch (e) {
        await message(describeErrorMessage(e, 'Could not restart the CasparCG server.'), {
            title: 'CasparCG Server Error',
            kind: 'error'
        });
    }
};

let templateDeployedUnlisten: UnlistenFn | null = null;

const refreshStudioPresetState = async () => {
    try {
        const defaultPreset = await invoke<any>('get_studio_default_preset');
        if (defaultPreset) {
            settings.updateCgAdvisoryFromDeployedPreset(defaultPreset);
            localState.value.cgAdvisoryConfig = {
                ...DEFAULT_CG_ADVISORY_CONFIG,
                ...(settings.cgAdvisoryConfig || {}),
            };
        }
    } catch (err) {
        console.warn('[Settings] Failed to fetch studio default preset:', err);
    }
};

const onWindowFocus = () => {
    refreshStudioPresetState();
};

// Audit T1-10: the component stays mounted for the app's lifetime, so the
// local shadow state was captured once at launch. Saving later wrote that
// stale snapshot over live store values (e.g. reverting an active crawl).
// Re-map from the store every time the dialog opens.
watch(
    () => props.isOpen,
    (open) => {
        if (open) {
            mapLocalState();
            savedSnapshot.value = snapshotOf(localState.value);
            connectionProbe.value = { state: 'idle', message: '' };
            void refreshStudioPresetState();
        }
    }
);

onMounted(async () => {
    mapLocalState();
    savedSnapshot.value = snapshotOf(localState.value);
    await refreshStudioPresetState();

    try {
        templateDeployedUnlisten = await listen<any>('caspar://template-deployed', (event) => {
            if (event?.payload) {
                settings.updateCgAdvisoryFromDeployedPreset(event.payload);
                localState.value.cgAdvisoryConfig = {
                    ...DEFAULT_CG_ADVISORY_CONFIG,
                    ...(settings.cgAdvisoryConfig || {}),
                };
            } else {
                refreshStudioPresetState();
            }
        });
    } catch (err) {
        console.warn('[Settings] Failed to register template-deployed listener:', err);
    }

    window.addEventListener('focus', onWindowFocus);

    if (localState.value.casparcgExecutablePath) {
        validateCasparExe(localState.value.casparcgExecutablePath);
    }

});

onUnmounted(() => {
    if (templateDeployedUnlisten) {
        templateDeployedUnlisten();
        templateDeployedUnlisten = null;
    }
    window.removeEventListener('focus', onWindowFocus);
});

/* ---------------------------------------------------------------- §4.3 ----
 * Behaviours the dialog did not have: a live preview, a dirty state, and any
 * feedback at all on Save.
 * ------------------------------------------------------------------------ */

/** Snapshot taken whenever the dialog opens; `isDirty` is measured against it. */
const savedSnapshot = ref('');

const snapshotOf = (value: unknown) => JSON.stringify(value);

const isDirty = computed(() => snapshotOf(localState.value) !== savedSnapshot.value);

/* --- Appearance (§5.2: the cards and their swatches come from the registry) - */

const themeOptions = (THEMES as readonly ThemeDefinition[]).map((theme) => ({
    value: theme.id as string,
    title: theme.title,
    ...(theme.badge ? { badge: theme.badge } : {}),
    description: theme.description,
}));

const swatchFor = (id: string) =>
    (THEMES as readonly ThemeDefinition[]).find((theme) => theme.id === id)?.swatch ?? THEMES[0].swatch;

/**
 * UI F-07: theme and density changed `localState` only, so the operator had to
 * Save and reopen the dialog to see a theme. They now apply to the document the
 * moment they change, and Cancel puts the previous pair back.
 *
 * This writes the same body class and data attribute the App.vue watcher does
 * -- literally the same functions, since §2.1 moved both into `lib/theme.ts`;
 * once Save commits the value to the store, that watcher takes over again.
 */
watch(() => localState.value.theme, (theme) => applyTheme(theme));
watch(() => localState.value.uiScale, (scale) => applyUiScale(scale));

/** Puts the document back to whatever the store still holds. */
const revertAppearancePreview = () => {
    applyTheme(settings.theme);
    applyUiScale(settings.uiScale);
};

/* --- Validation (§4.3). Shown at the field, not in a modal wall of text. --- */

const apiUrlError = computed(() => {
    const value = localState.value.ingestorApiBaseUrl.trim();
    if (!value) return 'Required — the library cannot load without it.';
    if (!/^https?:\/\/[^\s]+$/i.test(value)) return 'Must start with http:// or https://';
    return '';
});

const oscPortError = computed(() => {
    const port = Number(localState.value.casparOscPort);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return 'Must be a port between 1 and 65535.';
    return '';
});

const validationErrors = computed(() => [apiUrlError.value, oscPortError.value].filter(Boolean));

const canSave = computed(() => isDirty.value && validationErrors.value.length === 0);

/* --- Ingestor test connection (§4.2, Media & ingest) --- */

type ConnectionProbe = { state: 'idle' | 'testing' | 'ok' | 'warn' | 'fail'; message: string };
const connectionProbe = ref<ConnectionProbe>({ state: 'idle', message: '' });

const testIngestorConnection = async () => {
    if (apiUrlError.value) {
        connectionProbe.value = { state: 'fail', message: apiUrlError.value };
        return;
    }
    connectionProbe.value = { state: 'testing', message: 'Contacting the Ingestor…' };
    try {
        const healthy = await invoke<boolean>('check_ingestor_health', {
            apiBaseUrlOverride: localState.value.ingestorApiBaseUrl.trim(),
        });
        connectionProbe.value = healthy
            ? { state: 'ok', message: 'Reachable.' }
            : { state: 'warn', message: 'Answered, but reported itself unhealthy. Check the Ingestor logs.' };
    } catch (e) {
        const described = describeError(e, 'Could not reach the Ingestor.');
        // An auth rejection still proves the service is up, which is a
        // different problem from an unreachable host — say which.
        connectionProbe.value = {
            state: described.kind === 'auth' ? 'warn' : 'fail',
            message: described.message,
        };
    }
};

/* --- Layout reset (§4.2, Advanced) --- */

const resetPanelLayout = () => {
    // The library width is the one layout value the app persists.
    localStorage.removeItem('layout.leftWidth');
    showToast('Panel sizes reset. Reopen the window to see it.', 'info');
};

const isSaving = ref(false);

const saveSettings = async () => {
    if (!canSave.value || isSaving.value) return;
    isSaving.value = true;
    try {
        const latestPreset = await invoke<any>('get_studio_default_preset');
        if (latestPreset) {
            settings.updateCgAdvisoryFromDeployedPreset(latestPreset);
            localState.value.cgAdvisoryConfig = {
                ...DEFAULT_CG_ADVISORY_CONFIG,
                ...(settings.cgAdvisoryConfig || {}),
            };
        }
    } catch (_) {}

    settings.updateSettings(localState.value);
    try {
        await invoke('save_studio_default_preset', { preset: localState.value.cgAdvisoryConfig });
    } catch (err) {
        console.warn('[Settings] Failed to persist studio default preset on save:', err);
    }
    try {
        await invoke('configure_caspar_osc_listener', { port: localState.value.casparOscPort });
    } catch {}

    // UI F-07: Save used to close the dialog silently, so there was no way to
    // tell a save from a mis-click on Cancel.
    savedSnapshot.value = snapshotOf(localState.value);
    isSaving.value = false;
    showToast('Settings saved');
    emit('close');
};

const discardAndClose = () => {
    // Put the document back before dropping the draft, or a previewed theme
    // would survive a Cancel.
    revertAppearancePreview();
    mapLocalState();
    savedSnapshot.value = snapshotOf(localState.value);
    emit('close');
};

/** Ctrl/Cmd+S saves, scoped to this dialog. */
const onModalKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        event.stopPropagation();
        void saveSettings();
    }
};

const emptyBinFromSettings = async () => {
    const confirmed = await ask("Are you sure you want to permanently purge all items from the Recycle Bin? This will delete all physical mezzanine files on disk and all database records for soft-deleted assets.", {
        title: 'Empty Recycle Bin',
        kind: 'warning'
    });
    if (!confirmed) return;
    try {
        const outcome = normalizePurgeOutcome(
            await invoke<unknown>('purge_ingestor_recycle_bin', { apiBaseUrlOverride: null })
        );
        const note = describePurgeOutcome(outcome, 'the Recycle Bin');
        if (note) {
            await message(`Recycle Bin emptied with warnings.\n\n${note}`, {
                title: 'Recycle Bin',
                kind: 'warning'
            });
        } else {
            await message("Recycle Bin successfully emptied.", {
                title: 'Recycle Bin',
                kind: 'info'
            });
        }
    } catch (e) {
        await message(describeErrorMessage(e, 'Could not empty the Recycle Bin.'), {
            title: 'Recycle Bin Error',
            kind: 'error'
        });
    }
};

const pickPath = async (target: 'media' | 'ffmpeg-bin' | 'caspar-config' | 'caspar-exe' | 'cg-advisory-template' | 'cg-crawl-template') => {
    const isDirectory = target === 'media' || target === 'ffmpeg-bin';
    const isConfigFile = target === 'caspar-config';
    const isExeFile = target === 'caspar-exe';
    const isTemplateFile = target === 'cg-advisory-template' || target === 'cg-crawl-template';

    const defaultPath = (() => {
        if (target === 'media') return localState.value.localMediaPath;
        if (target === 'ffmpeg-bin') return localState.value.ffmpegBinPath;
        if (target === 'caspar-config') return localState.value.casparConfigPath;
        if (target === 'caspar-exe') return localState.value.casparcgExecutablePath;
        if (target === 'cg-advisory-template') return localState.value.cgExplanationTemplate;
        return localState.value.cgCrawlTemplate;
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
    else if (target === 'caspar-config') localState.value.casparConfigPath = selection;
    else if (target === 'caspar-exe') {
        localState.value.casparcgExecutablePath = selection;
        validateCasparExe(selection);
        syncCasparDerivedPaths(selection);
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
};

const openTemplateDir = async () => {
    try {
        const baseDir = detectedCasparDir.value;
        const templatePath = baseDir ? `${baseDir}/template` : null;
        const path = await invoke<string>('open_template_directory', {
            templatePath
        });
        console.info('[Settings] Opened template directory:', path);
    } catch (e) {
        await message(describeErrorMessage(e, 'Could not open that folder.'), {
            title: 'Open Directory Error',
            kind: 'error'
        });
    }
};
</script>

<template>
  <BaseModal
    :open="isOpen"
    size="lg"
    title="Settings"
    :dirty="isDirty"
    dirty-prompt="Discard unsaved settings?"
    @close="discardAndClose"
  >
    <div class="settings-layout" @keydown="onModalKeyDown">
      <!-- UI §4.1: left rail. Class pinned by SettingsModalConfirmation.test.ts. -->
      <nav class="settings-rail" aria-label="Settings sections">
        <div class="rail-filter">
          <AppIcon class="rail-filter-icon" name="search" :size="14" />
          <input v-model="sectionFilter" class="input rail-filter-input" type="search" placeholder="Find a setting…" />
        </div>
        <button
          v-for="entry in visibleRail"
          :key="entry.id"
          type="button"
          class="settings-tab-btn"
          :class="{ active: activeSection === entry.id }"
          :aria-current="activeSection === entry.id ? 'true' : undefined"
          @click="selectSection(entry.id)"
        >
          <AppIcon :name="entry.icon" :size="16" />
          <span>{{ entry.label }}</span>
        </button>
        <p v-if="!visibleRail.length" class="rail-empty">No section matches “{{ sectionFilter }}”.</p>
      </nav>

      <div class="settings-pane custom-scroll" ref="modalBodyRef">
        <!-- ============================================ Appearance ==== -->
        <div v-if="activeSection === 'appearance'">
          <section class="settings-section">
            <h3 class="section-title">Theme</h3>
            <p class="section-hint">Applies immediately. Cancel puts the previous theme back.</p>
            <RadioCardGroup v-model="localState.theme" label="Theme" :options="themeOptions">
              <template #preview="{ option }">
                <span class="theme-swatch" aria-hidden="true">
                  <span class="swatch-chip" :style="{ background: swatchFor(option.value).panel }"></span>
                  <span class="swatch-chip" :style="{ background: swatchFor(option.value).row }"></span>
                  <span class="swatch-chip swatch-accent" :style="{ background: swatchFor(option.value).accent }"></span>
                </span>
              </template>
            </RadioCardGroup>
          </section>

          <section class="settings-section">
            <h3 class="section-title">Density</h3>
            <p class="section-hint">Sets row heights and text size across the whole app.</p>
            <RadioCardGroup
              v-model="localState.uiScale"
              label="Density"
              :options="[
                { value: 'standard', title: 'Standard', badge: '100%', description: '42 px rundown rows — fits more on a laptop screen.' },
                { value: 'comfortable', title: 'Comfortable', badge: '115% · recommended', description: '48 px rows with larger titles and timing.' },
                { value: 'large', title: 'Large', badge: '130%', description: '54 px rows and bigger targets, for wall monitors.' }
              ]"
            />
          </section>
        </div>

        <!-- ======================================== Playout engine ==== -->
        <div v-if="activeSection === 'playout'">
          <section class="settings-section">
            <div class="section-head">
              <h3 class="section-title">CasparCG server</h3>
              <div class="section-head-status">
                <span class="instance-role-badge" :class="isPrimaryInstance ? 'role-primary' : 'role-monitor'">
                  {{ isPrimaryInstance ? 'Primary supervisor' : 'Monitor (read-only)' }}
                </span>
                <span class="process-state-badge" :class="'state-' + processState">
                  {{ processStatus?.pid ? `PID ${processStatus.pid} · ${processState}` : processState }}
                </span>
              </div>
            </div>
            <p class="section-hint">
              Point at the CasparCG folder or executable. Config, media, templates and logs are detected from it.
            </p>

            <div class="field">
              <label class="field-label" for="caspar-exe">Server location</label>
              <div class="input-with-button">
                <input
                  id="caspar-exe"
                  v-model="localState.casparcgExecutablePath"
                  class="input"
                  type="text"
                  placeholder="C:/CasparCG/casparcg.exe or D:/casparcg-server"
                  @input="onExecutableInput"
                />
                <BaseButton variant="secondary" icon="folder-open" label="Browse" @click="pickPath('caspar-exe')">Browse</BaseButton>
              </div>
              <p v-if="validationInfo" class="field-hint" :class="validationInfo.isValid ? 'is-ok' : 'is-bad'">
                {{ validationInfo.message }}
              </p>
            </div>

            <dl v-if="detectedCasparDir" class="env-list">
              <div class="env-row"><dt>Installation root</dt><dd class="mono">{{ detectedCasparDir }}</dd></div>
              <div class="env-row"><dt>Config file</dt><dd class="mono">{{ localState.casparConfigPath || (detectedCasparDir + '/casparcg.config') }}</dd></div>
              <div class="env-row"><dt>Media directory</dt><dd class="mono">{{ localState.localMediaPath || (detectedCasparDir + '/media') }}</dd></div>
              <div class="env-row"><dt>Templates directory</dt><dd class="mono">{{ detectedCasparDir }}/template/playout</dd></div>
              <div class="env-row"><dt>Logs directory</dt><dd class="mono">{{ detectedCasparDir }}/log</dd></div>
            </dl>

            <div class="field">
              <label class="field-label" for="caspar-config-name">Config filename</label>
              <input
                id="caspar-config-name"
                v-model="localState.casparcgConfigFilename"
                class="input"
                type="text"
                placeholder="casparcg.config"
                @input="onConfigFilenameInput"
              />
              <p class="field-hint">Lets several channel configurations live in one folder.</p>
            </div>

            <div class="server-actions">
              <BaseButton
                variant="primary"
                icon="play"
                :loading="isStarting"
                :disabled="!isPrimaryInstance || processState === 'starting' || processState === 'operational' || processState === 'external_running'"
                @click="handleStartServerFromSettings"
              >Start Server</BaseButton>
              <BaseButton
                variant="danger"
                icon="stop"
                :loading="isStopping"
                :disabled="!isPrimaryInstance || processState === 'stopped' || processState === 'unconfigured'"
                @click="handleStopServerFromSettings"
              >Stop Server</BaseButton>
              <BaseButton
                variant="secondary"
                icon="refresh"
                :disabled="!isPrimaryInstance || isStarting || isStopping || processState === 'stopped' || processState === 'unconfigured'"
                @click="handleRestartServerFromSettings"
              >Restart Server</BaseButton>
            </div>
          </section>

          <section class="settings-section">
            <h3 class="section-title">Supervision</h3>
            <label class="check-row">
              <input v-model="localState.casparAutoStart" type="checkbox" />
              <span>Start the server when Aether launches</span>
            </label>
            <label class="check-row">
              <input v-model="localState.casparKeepAliveOnExit" type="checkbox" />
              <span>Leave the server running when Aether exits (24/7 continuity)</span>
            </label>
            <label class="check-row">
              <input v-model="localState.casparAutoRelaunchOnCrash" type="checkbox" />
              <span>Relaunch the server after a crash, with crash-loop protection</span>
            </label>
            <label class="check-row">
              <input v-model="localState.autoResumeAfterRestart" type="checkbox" />
              <span>Resume the clip from its crash-time position after a restart</span>
            </label>
          </section>

          <section class="settings-section">
            <h3 class="section-title">Connection</h3>
            <div class="field">
              <label class="field-label" for="osc-port">OSC feedback port</label>
              <input
                id="osc-port"
                v-model.number="localState.casparOscPort"
                class="input"
                :class="{ 'input--invalid': oscPortError }"
                type="number"
                min="1"
                max="65535"
                placeholder="6250"
              />
              <p v-if="oscPortError" class="field-error">{{ oscPortError }}</p>
              <p v-else class="field-hint">Must match the UDP port in CasparCG's &lt;predefined-client&gt; (default 6250).</p>
            </div>
            <dl class="env-list">
              <div class="env-row"><dt>AMCP port</dt><dd class="mono">5250 (fixed)</dd></div>
            </dl>
          </section>

          <section class="settings-section">
            <h3 class="section-title">Timing</h3>
            <div class="field">
              <label class="field-label" for="playout-profile">Playout profile</label>
              <select id="playout-profile" v-model="localState.playoutProfile" class="select">
                <option value="PAL_1080I50">PAL 1080i50 (interlaced)</option>
                <option value="PAL_1080P25">PAL 1080p25 (progressive)</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="transition-frames">Transition length — {{ localState.transitionFrames }} frames</label>
              <input id="transition-frames" v-model.number="localState.transitionFrames" class="range" type="range" min="1" max="10" />
            </div>
            <div class="field">
              <label class="field-label" for="preroll-frames">Pre-roll buffer — {{ localState.prerollFrames }} frames</label>
              <input id="preroll-frames" v-model.number="localState.prerollFrames" class="range" type="range" min="1" max="12" />
            </div>
          </section>
        </div>

        <!-- ============================================== Hardware ==== -->
        <div v-if="activeSection === 'hardware'">
          <section class="settings-section">
            <h3 class="section-title">DeckLink</h3>
            <p class="section-hint">The setup wizard writes these. They are shown here so you can check them without opening it.</p>
            <dl class="env-list">
              <div class="env-row">
                <dt>Program out</dt>
                <dd>{{ localState.decklinkOutputDevice > 0 ? `DeckLink ${localState.decklinkOutputDevice}` : 'Not configured' }}</dd>
              </div>
              <div class="env-row">
                <dt>Output name</dt>
                <dd class="mono">{{ localState.decklinkOutputName || '—' }}</dd>
              </div>
              <div class="env-row">
                <dt>Live input</dt>
                <dd>{{ localState.decklinkInputDevice > 0 ? `DeckLink ${localState.decklinkInputDevice} · ${localState.decklinkInputFormat}` : 'Disabled' }}</dd>
              </div>
              <div class="env-row">
                <dt>Live source name</dt>
                <dd class="mono">{{ localState.liveInputSourceName || '—' }}</dd>
              </div>
            </dl>
          </section>

          <section class="settings-section">
            <h3 class="section-title">Media path</h3>
            <div class="field">
              <label class="field-label" for="media-path">Local media folder</label>
              <div class="input-with-button">
                <input id="media-path" v-model="localState.localMediaPath" class="input" type="text" placeholder="D:/Media" />
                <BaseButton variant="secondary" icon="folder-open" label="Browse" @click="pickPath('media')">Browse</BaseButton>
              </div>
              <p class="field-hint">Where CasparCG looks for clips. Editable here as well as in the wizard.</p>
            </div>
          </section>

          <section class="settings-section">
            <h3 class="section-title">Tools</h3>
            <div class="server-actions">
              <BaseButton variant="primary" @pointerenter="preloadDeckLinkWizard()" @click="showDecklinkWizard = true">
                Open setup wizard
              </BaseButton>
              <BaseButton variant="secondary" @pointerenter="preloadCasparConfigModal()" @click="showCasparConfigurator = true">
                Advanced XML configurator
              </BaseButton>
            </div>
          </section>
        </div>

        <!-- ======================================= Media & ingest ==== -->
        <div v-if="activeSection === 'media'">
          <section class="settings-section">
            <h3 class="section-title">PlayoutTranscode API</h3>
            <div class="field">
              <label class="field-label" for="api-url">API base URL</label>
              <div class="input-with-button">
                <input
                  id="api-url"
                  v-model="localState.ingestorApiBaseUrl"
                  class="input"
                  :class="{ 'input--invalid': apiUrlError }"
                  type="text"
                  placeholder="http://127.0.0.1:4353"
                />
                <BaseButton
                  variant="secondary"
                  :loading="connectionProbe.state === 'testing'"
                  @click="testIngestorConnection"
                >Test connection</BaseButton>
              </div>
              <p v-if="apiUrlError" class="field-error">{{ apiUrlError }}</p>
              <p v-else class="field-hint">Asset metadata, mezzanine validation and virtual subclips come from here.</p>
              <p
                v-if="connectionProbe.state !== 'idle' && connectionProbe.state !== 'testing'"
                class="probe-result"
                :class="`probe-${connectionProbe.state}`"
              >
                <AppIcon :name="connectionProbe.state === 'ok' ? 'check' : 'alert'" :size="14" />
                <span>{{ connectionProbe.message }}</span>
              </p>
            </div>

            <div class="field">
              <label class="field-label" for="api-token">API token</label>
              <div class="input-with-button">
                <input
                  id="api-token"
                  v-model.trim="localState.ingestorApiToken"
                  class="input"
                  :type="showIngestorToken ? 'text' : 'password'"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="Leave empty unless the service sets server.api_token"
                  data-testid="ingestor-api-token"
                />
                <BaseButton variant="secondary" @click="showIngestorToken = !showIngestorToken">
                  {{ showIngestorToken ? 'Hide' : 'Show' }}
                </BaseButton>
              </div>
              <p class="field-hint">
                Needed once the service has a token (<code>PlayoutTranscode gen-token</code>); without it every call but
                the health check is refused. Sent as an <code>X-Api-Token</code> header and never written to logs.
              </p>
            </div>
          </section>

          <section class="settings-section">
            <h3 class="section-title">FFmpeg</h3>
            <div class="field">
              <label class="field-label" for="ffmpeg-path">Binary folder override</label>
              <div class="input-with-button">
                <input id="ffmpeg-path" v-model="localState.ffmpegBinPath" class="input" type="text" placeholder="Requirements/ffmpeg/bin" />
                <BaseButton variant="secondary" icon="folder-open" label="Browse" @click="pickPath('ffmpeg-bin')">Browse</BaseButton>
              </div>
              <p class="field-hint">Leave blank to use Requirements/ffmpeg/bin next to the installation.</p>
            </div>
          </section>

          <section class="settings-section">
            <h3 class="section-title">Recycle Bin</h3>
            <div class="field">
              <label class="field-label" for="purge-schedule">Keep deleted items for</label>
              <select id="purge-schedule" v-model="localState.recycleBinAutoPurge" class="select">
                <option value="disabled">Forever (no automatic purge)</option>
                <option value="1week">1 week</option>
                <option value="2weeks">2 weeks</option>
                <option value="3weeks">3 weeks</option>
                <option value="1month">1 month</option>
              </select>
              <p class="field-hint">Older items are removed from disk and database during background maintenance.</p>
            </div>

            <div class="danger-zone">
              <div>
                <p class="danger-zone-title">Empty the Recycle Bin</p>
                <p class="danger-zone-hint">Deletes every soft-deleted item from storage now. This cannot be undone.</p>
              </div>
              <BaseButton variant="danger" icon="trash" @click="emptyBinFromSettings">Empty now</BaseButton>
            </div>
          </section>
        </div>

        <!-- ========================================= Graphics (CG) ==== -->
        <div v-if="activeSection === 'graphics'">
          <section class="settings-section">
            <h3 class="section-title">CG Studio</h3>
            <p class="section-hint">
              Compliance graphics (layer 32), the station ID bug and the emergency crawl (layer 33) are authored in CG
              Studio. Deploying writes the template and its preset to CasparCG.
            </p>
            <dl class="env-list">
              <div class="env-row"><dt>Badge shape</dt><dd>{{ localState.cgAdvisoryConfig.badgeShape || 'Squircle' }}</dd></div>
              <div class="env-row"><dt>Layer 32 template</dt><dd class="mono">{{ localState.cgExplanationTemplate || 'playout/advisory' }}</dd></div>
              <div class="env-row"><dt>Layer 33 template</dt><dd class="mono">{{ localState.cgCrawlTemplate || 'playout/crawl' }}</dd></div>
            </dl>
            <div class="server-actions">
              <BaseButton variant="primary" @click="launchBrowserStudio">Open CG Studio</BaseButton>
              <BaseButton variant="secondary" :loading="isDeployingTemplates" @click="deployTemplatesFromSettings">
                Deploy templates
              </BaseButton>
              <BaseButton variant="ghost" icon="folder-open" @click="openTemplateDir">Open templates folder</BaseButton>
            </div>
          </section>

          <section class="settings-section">
            <h3 class="section-title">Station logo</h3>
            <label class="check-row">
              <input v-model="localState.cg.stationIdEnabled" type="checkbox" />
              <span>Keep the station ID bug on air</span>
            </label>
            <p class="field-hint">
              When off, the logo layer is cleared on stop. Its artwork and position come from CG Studio.
            </p>
          </section>

          <section class="settings-section">
            <h3 class="section-title">Template identifiers</h3>
            <div class="field">
              <label class="field-label" for="advisory-template">Advisory template (layer 32)</label>
              <div class="input-with-button">
                <input id="advisory-template" v-model="localState.cgExplanationTemplate" class="input" type="text" placeholder="playout/advisory" />
                <BaseButton variant="secondary" icon="folder-open" label="Browse for advisory template" @click="pickPath('cg-advisory-template')" />
              </div>
              <p class="field-hint">Default <code>playout/advisory</code> — the Greek NCRTV rating banner and content warnings.</p>
            </div>
            <div class="field">
              <label class="field-label" for="crawl-template">Crawl template (layer 33)</label>
              <div class="input-with-button">
                <input id="crawl-template" v-model="localState.cgCrawlTemplate" class="input" type="text" placeholder="playout/crawl" />
                <BaseButton variant="secondary" icon="folder-open" label="Browse for crawl template" @click="pickPath('cg-crawl-template')" />
              </div>
              <p class="field-hint">Default <code>playout/crawl</code> — the 50 fps ticker.</p>
            </div>
          </section>
        </div>

        <!-- ====================================== QC & compliance ==== -->
        <div v-if="activeSection === 'qc'">
          <section class="settings-section">
            <h3 class="section-title">Warning sensitivity</h3>
            <p class="section-hint">How much the library and rundown flag before an item is considered fit to air.</p>
            <RadioCardGroup
              v-model="localState.qcSensitivity"
              label="Warning sensitivity"
              stacked
              :options="[
                { value: 'strict', title: 'Strict', description: 'Flags every advisory, including frame-alignment and loudness notes.' },
                { value: 'production', title: 'Production', badge: 'Recommended', description: 'Flags anything that would affect the take; ignores sub-clip alignment notes.' },
                { value: 'lenient', title: 'Lenient', description: 'Flags only faults that would black the output: missing file, unplayable format, zero duration.' }
              ]"
            />
          </section>
        </div>

        <!-- ============================================== Advanced ==== -->
        <div v-if="activeSection === 'advanced'">
          <section class="settings-section">
            <h3 class="section-title">Debug tools</h3>
            <label class="check-row">
              <input v-model="localState.debugMode" type="checkbox" />
              <span>Enable debug tools and diagnostics</span>
            </label>
            <p class="field-hint">
              Turns on the media library's debug panel with the live Ingestor log, the frame-timing (jank) monitor, and
              detailed console logging. Leave it off during a broadcast: the log panel updates reactively.
            </p>
          </section>

          <section class="settings-section">
            <h3 class="section-title">Layout</h3>
            <div class="server-actions">
              <BaseButton variant="secondary" icon="refresh" @click="resetPanelLayout">Reset panel sizes</BaseButton>
            </div>
            <p class="field-hint">Puts the library panel back to its default width.</p>
          </section>
        </div>
      </div>
    </div>

    <template #footer>
      <ModalFooterActions>
        <template #destructive>
          <span v-if="validationErrors.length" class="footer-validation">
            <AppIcon name="alert" :size="14" />
            <span>{{ validationErrors.length }} field needs attention</span>
          </span>
        </template>
        <template #secondary>
          <BaseButton variant="secondary" @click="discardAndClose">Cancel</BaseButton>
        </template>
        <template #primary>
          <BaseButton variant="primary" :disabled="!canSave" :loading="isSaving" @click="saveSettings">
            Save
          </BaseButton>
        </template>
      </ModalFooterActions>
    </template>
  </BaseModal>

  <!-- Sub-modals -->
  <CasparConfigModal
    v-if="showCasparConfigurator"
    :is-open="showCasparConfigurator"
    :initial-path="effectiveCasparConfigPath"
    @update:path="onCasparConfigPathUpdate"
    @close="showCasparConfigurator = false"
  />

  <DeckLinkWizard
    v-if="showDecklinkWizard"
    :is-open="showDecklinkWizard"
    :initial-path="effectiveCasparConfigPath"
    @close="onDecklinkWizardClose"
  />
</template>

<style scoped>
/* The shell (backdrop, header, body scroll, footer) is BaseModal's; buttons,
   inputs and selects are components.css's. What is left is the rail, the
   section rhythm, and the few status badges this dialog owns. */

.settings-layout {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: var(--space-4);
    min-height: 420px;
    /* Give the dialog body a working height so the pane scrolls, not the page. */
    max-height: calc(100vh - 260px);
}

/* --- Left rail (§4.1) --------------------------------------------------- */

.settings-rail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-right: var(--space-3);
    border-right: 1px solid var(--border-subtle);
    overflow-y: auto;
}

.rail-filter {
    position: relative;
    display: flex;
    align-items: center;
    margin-bottom: var(--space-2);
}

.rail-filter-icon {
    position: absolute;
    left: var(--space-2);
    color: var(--text-muted);
    pointer-events: none;
}

.rail-filter-input {
    height: var(--control-h-sm);
    padding-left: calc(var(--space-2) * 2 + 14px);
    font-size: var(--fs-xs);
}

.settings-tab-btn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    transition:
        background-color var(--dur-fast) var(--ease-out),
        color var(--dur-fast) var(--ease-out);
}

.settings-tab-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
}

.settings-tab-btn:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
}

.settings-tab-btn.active {
    background: var(--bg-active);
    color: var(--text-primary);
    border-color: color-mix(in srgb, var(--accent-primary) 35%, transparent);
}

.rail-empty {
    margin: var(--space-2) 0 0;
    font-size: var(--fs-xs);
    color: var(--text-muted);
}

/* --- Content pane ------------------------------------------------------- */

.settings-pane {
    min-width: 0;
    overflow-y: auto;
    padding-right: var(--space-2);
}

.settings-section {
    padding-bottom: var(--space-5);
    margin-bottom: var(--space-5);
    border-bottom: 1px solid var(--border-subtle);
}

.settings-section:last-child {
    margin-bottom: 0;
    border-bottom: none;
}

.section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
}

.section-head-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.section-title {
    margin: 0 0 var(--space-1);
    font-size: var(--fs-md);
    font-weight: 700;
    color: var(--text-primary);
}

.section-hint {
    margin: 0 0 var(--space-3);
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text-secondary);
}

/* --- Fields ------------------------------------------------------------- */

.settings-pane .field {
    margin-bottom: var(--space-3);
}

.settings-pane .field:last-child {
    margin-bottom: 0;
}

.field-hint.is-ok {
    color: var(--status-ready);
}

.field-hint.is-bad {
    color: var(--status-error);
}

.input-with-button {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.input-with-button .input {
    flex: 1 1 auto;
    min-width: 0;
}

.check-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    font-size: var(--fs-sm);
    color: var(--text-primary);
    cursor: pointer;
}

.range {
    width: 100%;
    accent-color: var(--accent-primary);
}

.server-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
}

/* --- Read-only definition lists (replacing the summary "cards") --------- */

.env-list {
    margin: var(--space-2) 0 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-input);
}

.env-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 3px 0;
}

.env-row dt {
    flex-shrink: 0;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
}

.env-row dd {
    margin: 0;
    min-width: 0;
    font-size: var(--fs-xs);
    color: var(--text-primary);
    text-align: right;
    overflow-wrap: anywhere;
}

.mono {
    font-family: var(--font-mono);
}

/* --- Status badges ------------------------------------------------------ */

.instance-role-badge,
.process-state-badge {
    padding: 2px var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-size: var(--fs-xs);
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: capitalize;
    white-space: nowrap;
}

.role-primary,
.state-operational {
    background: color-mix(in srgb, var(--status-ready) 15%, transparent);
    border-color: color-mix(in srgb, var(--status-ready) 40%, transparent);
    color: var(--status-ready);
}

.role-monitor,
.state-external_running {
    background: color-mix(in srgb, var(--accent-purple) 15%, transparent);
    border-color: color-mix(in srgb, var(--accent-purple) 40%, transparent);
    color: var(--accent-purple);
}

.state-starting {
    background: color-mix(in srgb, var(--status-processing) 15%, transparent);
    border-color: color-mix(in srgb, var(--status-processing) 40%, transparent);
    color: var(--status-processing);
}

.state-stopped {
    background: color-mix(in srgb, var(--status-warning) 15%, transparent);
    border-color: color-mix(in srgb, var(--status-warning) 40%, transparent);
    color: var(--status-warning);
}

.state-crashed {
    background: color-mix(in srgb, var(--status-error) 15%, transparent);
    border-color: color-mix(in srgb, var(--status-error) 40%, transparent);
    color: var(--status-error);
}

.state-unconfigured {
    background: color-mix(in srgb, var(--status-offline) 15%, transparent);
    border-color: color-mix(in srgb, var(--status-offline) 40%, transparent);
    color: var(--text-secondary);
}

/* --- Theme swatch (§4.2: a real preview, not a text badge) --------------

   A swatch has to paint its own theme's palette while a *different* theme is
   active, so its three colours cannot be tokens. §5.2 moved them out of this
   stylesheet into `config/themes.ts` and binds them through `:style`: they are
   data about a theme, not a style of this component, and this file is now at
   zero colour literals. */

.theme-swatch {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px;
    border: 1px solid var(--border-medium);
    border-radius: var(--radius-sm);
}

.swatch-chip {
    display: block;
    width: 10px;
    height: 14px;
    border-radius: 2px;
}

.swatch-accent {
    width: 6px;
}

/* --- Connection probe & danger zone ------------------------------------- */

.probe-result {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-2) 0 0;
    font-size: var(--fs-xs);
}

.probe-ok {
    color: var(--status-ready);
}

.probe-warn {
    color: var(--status-warning);
}

.probe-fail {
    color: var(--status-error);
}

.danger-zone {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-top: var(--space-3);
    padding: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--status-error) 25%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--status-error) 8%, transparent);
}

.danger-zone-title {
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-primary);
}

.danger-zone-hint {
    margin: 2px 0 0;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
}

.footer-validation {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--fs-xs);
    color: var(--status-error);
}

code {
    font-family: var(--font-mono);
    font-size: 0.95em;
    padding: 0 3px;
    border-radius: var(--radius-sm);
    background: var(--bg-hover);
}

@media (max-width: 720px) {
    .settings-layout {
        grid-template-columns: 1fr;
    }

    .settings-rail {
        border-right: none;
        border-bottom: 1px solid var(--border-subtle);
        padding-right: 0;
        padding-bottom: var(--space-2);
    }
}
</style>
