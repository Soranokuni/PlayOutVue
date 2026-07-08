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
const activeTab = ref('general');
const selectedWizardLayer = ref('logo');
// Local shadow state so we don't mutate Pinia instantly on every keystroke
const localState = ref({
    localMediaPath: '',
    ffmpegBinPath: '',
    debugMode: false,
    logosPath: '',
    liveInputSourceName: '',
    casparConfigPath: '',
    casparOscPort: 6250,
    playoutProfile: 'PAL_1080I50',
    transitionFrames: 2,
    prerollFrames: 2,
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
    cgCrawlPosition: 'bottom',
    cgCrawlText: '',
    cgCrawlActive: false,
    cgExplanationTemplate: 'playout/explanation'
});
const currentActivePos = computed({
    get: () => {
        if (selectedWizardLayer.value === 'logo')
            return localState.value.cgStationLogoPos;
        if (selectedWizardLayer.value === 'rating')
            return localState.value.cgRatingBadgePos;
        if (selectedWizardLayer.value === 'tp')
            return localState.value.cgTPPos;
        if (selectedWizardLayer.value === 'explanation')
            return localState.value.cgExplanationBannerPos;
        return localState.value.cgCrawlPos;
    },
    set: (val) => {
        if (selectedWizardLayer.value === 'logo')
            localState.value.cgStationLogoPos = val;
        else if (selectedWizardLayer.value === 'rating')
            localState.value.cgRatingBadgePos = val;
        else if (selectedWizardLayer.value === 'tp')
            localState.value.cgTPPos = val;
        else if (selectedWizardLayer.value === 'explanation')
            localState.value.cgExplanationBannerPos = val;
        else
            localState.value.cgCrawlPos = val;
    }
});
// Dragging states
const isDragging = ref(false);
let startX = 0;
let startY = 0;
let startLeft = 0;
let startTop = 0;
const onDragStart = (e, layer) => {
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
const onDragMove = (e) => {
    if (!isDragging.value)
        return;
    const mockScreenEl = document.querySelector('.mock-screen');
    if (!mockScreenEl)
        return;
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
        const listing = await invoke('browse_filesystem', {
            path: targetPath,
            showFiles: true,
            allowedExtensions: ['png', 'jpg', 'jpeg', 'svg', 'webp']
        });
        let foundCount = 0;
        for (const entry of listing.entries) {
            if (entry.entry_type !== 'file')
                continue;
            const lowerName = entry.name.toLowerCase();
            if (lowerName === 'logo.png') {
                localState.value.cg.stationIdPath = entry.path;
                foundCount++;
            }
            else if (lowerName === 'k.png') {
                localState.value.cgRatingKPath = entry.path;
                foundCount++;
            }
            else if (lowerName === '8.png') {
                localState.value.cgRating8Path = entry.path;
                foundCount++;
            }
            else if (lowerName === '12.png') {
                localState.value.cgRating12Path = entry.path;
                foundCount++;
            }
            else if (lowerName === '16.png') {
                localState.value.cgRating16Path = entry.path;
                foundCount++;
            }
            else if (lowerName === '18.png') {
                localState.value.cgRating18Path = entry.path;
                foundCount++;
            }
            else if (lowerName === 'tp.png') {
                localState.value.cgRatingTPPath = entry.path;
                foundCount++;
            }
        }
        alert(`Scanning complete. Found and populated ${foundCount} logo assets inside ${targetPath}.`);
    }
    catch (e) {
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
        invoke('find_default_logos_dir')
            .then((path) => {
            if (path && !localState.value.logosPath) {
                localState.value.logosPath = path;
            }
        })
            .catch(() => { });
    }
});
const saveSettings = async () => {
    settings.updateSettings(localState.value);
    try {
        await invoke('configure_caspar_osc_listener', { port: localState.value.casparOscPort });
    }
    catch { }
    emit('close');
};
const discardAndClose = () => {
    mapLocalState();
    emit('close');
};
const pickPath = async (target) => {
    const isDirectory = target === 'media' || target === 'logos' || target === 'ffmpeg-bin';
    const defaultPath = (() => {
        if (target === 'media')
            return localState.value.localMediaPath;
        if (target === 'ffmpeg-bin')
            return localState.value.ffmpegBinPath;
        if (target === 'logos')
            return localState.value.logosPath;
        if (target === 'cg-logo')
            return localState.value.cg.stationIdPath;
        if (target === 'badge-k')
            return localState.value.cgRatingKPath;
        if (target === 'badge-8')
            return localState.value.cgRating8Path;
        if (target === 'badge-12')
            return localState.value.cgRating12Path;
        if (target === 'badge-16')
            return localState.value.cgRating16Path;
        if (target === 'badge-18')
            return localState.value.cgRating18Path;
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
    if (!selection || Array.isArray(selection))
        return;
    if (target === 'media')
        localState.value.localMediaPath = selection;
    else if (target === 'ffmpeg-bin')
        localState.value.ffmpegBinPath = selection;
    else if (target === 'logos')
        localState.value.logosPath = selection;
    else if (target === 'cg-logo')
        localState.value.cg.stationIdPath = selection;
    else if (target === 'badge-k')
        localState.value.cgRatingKPath = selection;
    else if (target === 'badge-8')
        localState.value.cgRating8Path = selection;
    else if (target === 'badge-12')
        localState.value.cgRating12Path = selection;
    else if (target === 'badge-16')
        localState.value.cgRating16Path = selection;
    else if (target === 'badge-18')
        localState.value.cgRating18Path = selection;
    else if (target === 'badge-tp')
        localState.value.cgRatingTPPath = selection;
};
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['modal-header']} */ ;
/** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
/** @type {__VLS_StyleScopedClasses['form-group']} */ ;
/** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['settings-tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['settings-tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['layer-box']} */ ;
/** @type {__VLS_StyleScopedClasses['layer-box']} */ ;
/** @type {__VLS_StyleScopedClasses['wizard-sliders']} */ ;
let __VLS_0;
/** @ts-ignore @type { | typeof __VLS_components.Teleport | typeof __VLS_components.Teleport} */
Teleport;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    to: "body",
}));
const __VLS_2 = __VLS_1({
    to: "body",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
if (__VLS_ctx.isOpen) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onClick: (__VLS_ctx.discardAndClose) },
        ...{ class: "modal-backdrop" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-backdrop']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "glass-panel modal-content" },
    });
    /** @type {__VLS_StyleScopedClasses['glass-panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['modal-content']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-header" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
        ...{ class: "text-accent" },
    });
    /** @type {__VLS_StyleScopedClasses['text-accent']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.discardAndClose) },
        ...{ class: "glass-btn btn-icon" },
    });
    /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-icon']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "settings-tabs" },
    });
    /** @type {__VLS_StyleScopedClasses['settings-tabs']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.activeTab = 'general');
                // @ts-ignore
                [isOpen, discardAndClose, discardAndClose, activeTab,];
            } },
        ...{ class: "settings-tab-btn" },
        ...{ class: ({ active: __VLS_ctx.activeTab === 'general' }) },
    });
    /** @type {__VLS_StyleScopedClasses['settings-tab-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.activeTab = 'playout');
                // @ts-ignore
                [activeTab, activeTab,];
            } },
        ...{ class: "settings-tab-btn" },
        ...{ class: ({ active: __VLS_ctx.activeTab === 'playout' }) },
    });
    /** @type {__VLS_StyleScopedClasses['settings-tab-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.activeTab = 'cg');
                // @ts-ignore
                [activeTab, activeTab,];
            } },
        ...{ class: "settings-tab-btn" },
        ...{ class: ({ active: __VLS_ctx.activeTab === 'cg' }) },
    });
    /** @type {__VLS_StyleScopedClasses['settings-tab-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-body custom-scroll" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-body']} */ ;
    /** @type {__VLS_StyleScopedClasses['custom-scroll']} */ ;
    if (__VLS_ctx.activeTab === 'general') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "input-with-button" },
        });
        /** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.localMediaPath),
            placeholder: "C:/CasparCG/media",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'general'))
                        throw 0;
                    return (__VLS_ctx.pickPath('media'));
                    // @ts-ignore
                    [activeTab, activeTab, localState, pickPath,];
                } },
            ...{ class: "glass-btn" },
            ...{ style: {} },
            title: "Browse folders",
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "input-with-button" },
        });
        /** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.ffmpegBinPath),
            placeholder: "Requirements/ffmpeg/bin",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'general'))
                        throw 0;
                    return (__VLS_ctx.pickPath('ffmpeg-bin'));
                    // @ts-ignore
                    [localState, pickPath,];
                } },
            ...{ class: "glass-btn" },
            ...{ style: {} },
            title: "Browse FFmpeg bin folder",
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "input-with-button" },
        });
        /** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.logosPath),
            placeholder: "C:/PlayOut/logos",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'general'))
                        throw 0;
                    return (__VLS_ctx.pickPath('logos'));
                    // @ts-ignore
                    [localState, pickPath,];
                } },
            ...{ class: "glass-btn" },
            ...{ style: {} },
            title: "Browse logos folder",
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.ingestorApiBaseUrl),
            placeholder: "http://127.0.0.1:4353",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-grid" },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ style: {} },
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "checkbox",
        });
        (__VLS_ctx.localState.debugMode);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "hint-card" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-card']} */ ;
    }
    if (__VLS_ctx.activeTab === 'playout') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.liveInputSourceName),
            placeholder: "decklink://device/1 or ROUTE 2-10",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-grid" },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "number",
            min: "1",
            max: "65535",
            ...{ class: "glass-input" },
            placeholder: "6250",
        });
        (__VLS_ctx.localState.casparOscPort);
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "hint-card" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-card']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.casparConfigPath),
            placeholder: "C:/CasparCG/casparcg.config",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'playout'))
                        throw 0;
                    return (__VLS_ctx.showDecklinkWizard = true);
                    // @ts-ignore
                    [activeTab, localState, localState, localState, localState, localState, showDecklinkWizard,];
                } },
            ...{ class: "glass-btn btn-primary" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'playout'))
                        throw 0;
                    return (__VLS_ctx.showCasparConfigurator = true);
                    // @ts-ignore
                    [showCasparConfigurator,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-grid" },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.playoutProfile),
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "PAL_1080I50",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "PAL_1080P25",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        (__VLS_ctx.localState.transitionFrames);
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "range",
            min: "1",
            max: "10",
            ...{ style: {} },
        });
        (__VLS_ctx.localState.transitionFrames);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        (__VLS_ctx.localState.prerollFrames);
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "range",
            min: "1",
            max: "12",
            ...{ style: {} },
        });
        (__VLS_ctx.localState.prerollFrames);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "hint-card" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-card']} */ ;
    }
    if (__VLS_ctx.activeTab === 'cg') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.scanLogosFolder) },
            ...{ class: "glass-btn btn-primary" },
            ...{ style: {} },
            title: "Scan subfolder /logos inside local media path",
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-grid" },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "input-with-button" },
        });
        /** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.cg.stationIdPath),
            placeholder: "C:/PlayOut/logos/logo.png",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.pickPath('cg-logo'));
                    // @ts-ignore
                    [activeTab, localState, localState, localState, localState, localState, localState, pickPath, scanLogosFolder,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "input-with-button" },
        });
        /** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.cgRatingTPPath),
            placeholder: "C:/PlayOut/logos/TP.png",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.pickPath('badge-tp'));
                    // @ts-ignore
                    [localState, pickPath,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-grid" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ style: {} },
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "checkbox",
        });
        (__VLS_ctx.localState.cg.stationIdEnabled);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-grid" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "input-with-button" },
        });
        /** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.cgRatingKPath),
            placeholder: "K.png path",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.pickPath('badge-k'));
                    // @ts-ignore
                    [localState, localState, pickPath,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "input-with-button" },
        });
        /** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.cgRating8Path),
            placeholder: "8.png path",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.pickPath('badge-8'));
                    // @ts-ignore
                    [localState, pickPath,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-grid" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "input-with-button" },
        });
        /** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.cgRating12Path),
            placeholder: "12.png path",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.pickPath('badge-12'));
                    // @ts-ignore
                    [localState, pickPath,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "input-with-button" },
        });
        /** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.cgRating16Path),
            placeholder: "16.png path",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.pickPath('badge-16'));
                    // @ts-ignore
                    [localState, pickPath,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-grid" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "input-with-button" },
        });
        /** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.cgRating18Path),
            placeholder: "18.png path",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.pickPath('badge-18'));
                    // @ts-ignore
                    [localState, pickPath,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "wizard-container" },
        });
        /** @type {__VLS_StyleScopedClasses['wizard-container']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "wizard-header" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['wizard-header']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "text-secondary text-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            value: (__VLS_ctx.selectedWizardLayer),
            ...{ class: "glass-input select-layer" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        /** @type {__VLS_StyleScopedClasses['select-layer']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "logo",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "rating",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "tp",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "explanation",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "crawl",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mock-screen" },
        });
        /** @type {__VLS_StyleScopedClasses['mock-screen']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "safe-area-border" },
        });
        /** @type {__VLS_StyleScopedClasses['safe-area-border']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onMousedown: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.onDragStart($event, 'logo'));
                    // @ts-ignore
                    [selectedWizardLayer, onDragStart,];
                } },
            ...{ class: "layer-box logo-box" },
            ...{ class: ({ 'is-selected': __VLS_ctx.selectedWizardLayer === 'logo' }) },
            ...{ style: ({
                    left: __VLS_ctx.localState.cgStationLogoPos.left + '%',
                    top: __VLS_ctx.localState.cgStationLogoPos.top + '%',
                    width: __VLS_ctx.localState.cgStationLogoPos.width + '%',
                    height: __VLS_ctx.localState.cgStationLogoPos.height + '%'
                }) },
        });
        /** @type {__VLS_StyleScopedClasses['layer-box']} */ ;
        /** @type {__VLS_StyleScopedClasses['logo-box']} */ ;
        /** @type {__VLS_StyleScopedClasses['is-selected']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "box-label" },
        });
        /** @type {__VLS_StyleScopedClasses['box-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onMousedown: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.onDragStart($event, 'rating'));
                    // @ts-ignore
                    [localState, localState, localState, localState, selectedWizardLayer, onDragStart,];
                } },
            ...{ class: "layer-box rating-box" },
            ...{ class: ({ 'is-selected': __VLS_ctx.selectedWizardLayer === 'rating' }) },
            ...{ style: ({
                    left: __VLS_ctx.localState.cgRatingBadgePos.left + '%',
                    top: __VLS_ctx.localState.cgRatingBadgePos.top + '%',
                    width: __VLS_ctx.localState.cgRatingBadgePos.width + '%',
                    height: __VLS_ctx.localState.cgRatingBadgePos.height + '%'
                }) },
        });
        /** @type {__VLS_StyleScopedClasses['layer-box']} */ ;
        /** @type {__VLS_StyleScopedClasses['rating-box']} */ ;
        /** @type {__VLS_StyleScopedClasses['is-selected']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "box-label" },
        });
        /** @type {__VLS_StyleScopedClasses['box-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onMousedown: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.onDragStart($event, 'tp'));
                    // @ts-ignore
                    [localState, localState, localState, localState, selectedWizardLayer, onDragStart,];
                } },
            ...{ class: "layer-box tp-box" },
            ...{ class: ({ 'is-selected': __VLS_ctx.selectedWizardLayer === 'tp' }) },
            ...{ style: ({
                    left: __VLS_ctx.localState.cgTPPos.left + '%',
                    top: __VLS_ctx.localState.cgTPPos.top + '%',
                    width: __VLS_ctx.localState.cgTPPos.width + '%',
                    height: __VLS_ctx.localState.cgTPPos.height + '%'
                }) },
        });
        /** @type {__VLS_StyleScopedClasses['layer-box']} */ ;
        /** @type {__VLS_StyleScopedClasses['tp-box']} */ ;
        /** @type {__VLS_StyleScopedClasses['is-selected']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "box-label" },
        });
        /** @type {__VLS_StyleScopedClasses['box-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onMousedown: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.onDragStart($event, 'explanation'));
                    // @ts-ignore
                    [localState, localState, localState, localState, selectedWizardLayer, onDragStart,];
                } },
            ...{ class: "layer-box explanation-box" },
            ...{ class: ({ 'is-selected': __VLS_ctx.selectedWizardLayer === 'explanation' }) },
            ...{ style: ({
                    left: __VLS_ctx.localState.cgExplanationBannerPos.left + '%',
                    top: __VLS_ctx.localState.cgExplanationBannerPos.top + '%',
                    width: __VLS_ctx.localState.cgExplanationBannerPos.width + '%',
                    height: __VLS_ctx.localState.cgExplanationBannerPos.height + '%'
                }) },
        });
        /** @type {__VLS_StyleScopedClasses['layer-box']} */ ;
        /** @type {__VLS_StyleScopedClasses['explanation-box']} */ ;
        /** @type {__VLS_StyleScopedClasses['is-selected']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "box-label" },
        });
        /** @type {__VLS_StyleScopedClasses['box-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onMousedown: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeTab === 'cg'))
                        throw 0;
                    return (__VLS_ctx.onDragStart($event, 'crawl'));
                    // @ts-ignore
                    [localState, localState, localState, localState, selectedWizardLayer, onDragStart,];
                } },
            ...{ class: "layer-box crawl-box" },
            ...{ class: ({ 'is-selected': __VLS_ctx.selectedWizardLayer === 'crawl' }) },
            ...{ style: ({
                    left: __VLS_ctx.localState.cgCrawlPos.left + '%',
                    top: __VLS_ctx.localState.cgCrawlPos.top + '%',
                    width: __VLS_ctx.localState.cgCrawlPos.width + '%',
                    height: __VLS_ctx.localState.cgCrawlPos.height + '%'
                }) },
        });
        /** @type {__VLS_StyleScopedClasses['layer-box']} */ ;
        /** @type {__VLS_StyleScopedClasses['crawl-box']} */ ;
        /** @type {__VLS_StyleScopedClasses['is-selected']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "box-label" },
        });
        /** @type {__VLS_StyleScopedClasses['box-label']} */ ;
        if (__VLS_ctx.currentActivePos) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "wizard-sliders" },
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['wizard-sliders']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
                ...{ class: "text-accent text-sm" },
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['text-accent']} */ ;
            /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
            (__VLS_ctx.selectedWizardLayer);
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "slider-row" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-row']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "slider-label" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-label']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                type: "range",
                min: "0",
                max: "100",
            });
            (__VLS_ctx.currentActivePos.left);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "slider-value" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-value']} */ ;
            (__VLS_ctx.currentActivePos.left);
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "slider-row" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-row']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "slider-label" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-label']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                type: "range",
                min: "0",
                max: "100",
            });
            (__VLS_ctx.currentActivePos.top);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "slider-value" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-value']} */ ;
            (__VLS_ctx.currentActivePos.top);
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "slider-row" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-row']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "slider-label" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-label']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                type: "range",
                min: "1",
                max: "100",
            });
            (__VLS_ctx.currentActivePos.width);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "slider-value" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-value']} */ ;
            (__VLS_ctx.currentActivePos.width);
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "slider-row" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-row']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "slider-label" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-label']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                type: "range",
                min: "1",
                max: "100",
            });
            (__VLS_ctx.currentActivePos.height);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "slider-value" },
            });
            /** @type {__VLS_StyleScopedClasses['slider-value']} */ ;
            (__VLS_ctx.currentActivePos.height);
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "hint-text" },
                ...{ style: {} },
            });
            /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-grid" },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.cgCrawlTemplate),
            placeholder: "playout/crawl",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            value: (__VLS_ctx.localState.cgExplanationTemplate),
            placeholder: "playout/explanation",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-footer" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.discardAndClose) },
        ...{ class: "glass-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.saveSettings) },
        ...{ class: "glass-btn btn-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
}
const __VLS_6 = CasparConfigModal;
// @ts-ignore
const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
    ...{ 'onClose': {} },
    ...{ 'onUpdate:path': {} },
    isOpen: (__VLS_ctx.showCasparConfigurator),
    initialPath: (__VLS_ctx.localState.casparConfigPath),
}));
const __VLS_8 = __VLS_7({
    ...{ 'onClose': {} },
    ...{ 'onUpdate:path': {} },
    isOpen: (__VLS_ctx.showCasparConfigurator),
    initialPath: (__VLS_ctx.localState.casparConfigPath),
}, ...__VLS_functionalComponentArgsRest(__VLS_7));
let __VLS_11;
const __VLS_12 = {
    /** @type {typeof __VLS_11.close} */
    onClose: (...[$event]) => {
        return (__VLS_ctx.showCasparConfigurator = false);
        // @ts-ignore
        [discardAndClose, localState, localState, localState, localState, localState, localState, localState, showCasparConfigurator, showCasparConfigurator, selectedWizardLayer, selectedWizardLayer, currentActivePos, currentActivePos, currentActivePos, currentActivePos, currentActivePos, currentActivePos, currentActivePos, currentActivePos, currentActivePos, saveSettings,];
    },
};
const __VLS_13 = {
    /** @type {typeof __VLS_11.'update:path'} */
    'onUpdate:path': ((value) => { __VLS_ctx.localState.casparConfigPath = value; }),
};
var __VLS_9;
var __VLS_10;
const __VLS_14 = DeckLinkWizard;
// @ts-ignore
const __VLS_15 = __VLS_asFunctionalComponent1(__VLS_14, new __VLS_14({
    ...{ 'onClose': {} },
    isOpen: (__VLS_ctx.showDecklinkWizard),
}));
const __VLS_16 = __VLS_15({
    ...{ 'onClose': {} },
    isOpen: (__VLS_ctx.showDecklinkWizard),
}, ...__VLS_functionalComponentArgsRest(__VLS_15));
let __VLS_19;
const __VLS_20 = {
    /** @type {typeof __VLS_19.close} */
    onClose: (...[$event]) => {
        return (__VLS_ctx.showDecklinkWizard = false);
        // @ts-ignore
        [localState, showDecklinkWizard, showDecklinkWizard,];
    },
};
var __VLS_17;
var __VLS_18;
// @ts-ignore
[];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    emits: {},
    props: {
        isOpen: Boolean
    },
});
export default {};
