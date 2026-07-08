import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../stores/settings';
const props = defineProps();
const emit = defineEmits();
const settings = useSettingsStore();
const configPath = ref('');
const configLoaded = ref(false);
const configSummary = ref(null);
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
const outputLatency = ref('normal');
const outputKeyer = ref('external');
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
    if (activeStep.value === 1)
        return configLoaded.value && !!configPath.value.trim() && !errorMessage.value;
    if (activeStep.value === 2)
        return outputDevice.value >= 1 && outputDevice.value <= 8;
    if (activeStep.value === 3)
        return !hasLiveInput.value || (inputDevice.value >= 1 && inputDevice.value <= 8 && inputDevice.value !== outputDevice.value);
    if (activeStep.value === 4)
        return !!videoMode.value.trim();
    return true;
});
const stepTitle = computed(() => {
    const titles = {
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
    if (!hasLiveInput.value)
        return null;
    return `Input DeckLink ${inputDevice.value} → Channel 1 → Output DeckLink ${outputDevice.value}`;
});
const changesList = computed(() => {
    const changes = [];
    changes.push(`Config file: ${configPath.value}`);
    changes.push(`Channel 1 video mode: ${videoMode.value}`);
    changes.push(`Output: DeckLink ${outputDevice.value} (audio: ${outputEmbeddedAudio.value ? 'embedded' : 'system'}, buffer: ${outputBufferDepth.value}, latency: ${outputLatency.value}, keyer: ${outputKeyer.value})`);
    if (outputKeyDevice.value > 0) {
        changes.push(`Key output: DeckLink ${outputKeyDevice.value}`);
    }
    if (hasLiveInput.value) {
        changes.push(`Live input: DeckLink ${inputDevice.value} (rebroadcast to DeckLink ${outputDevice.value})`);
    }
    else {
        changes.push('Live input: disabled');
    }
    return changes;
});
const loadConfig = async (path) => {
    loading.value = true;
    errorMessage.value = '';
    statusMessage.value = '';
    try {
        const result = await invoke('load_caspar_config', {
            path: path || configPath.value.trim() || null,
        });
        configPath.value = result.path;
        configLoaded.value = true;
        const cfg = result.config;
        const decklinkDevices = [];
        let vidMode = '1080i5000';
        let channelCount = 0;
        if (cfg.channels?.channels && Array.isArray(cfg.channels.channels)) {
            channelCount = cfg.channels.channels.length;
            const ch1 = cfg.channels.channels[0];
            if (ch1) {
                vidMode = ch1.video_mode || vidMode;
                if (ch1.consumers?.decklinks && Array.isArray(ch1.consumers.decklinks)) {
                    for (const dl of ch1.consumers.decklinks) {
                        if (dl.device)
                            decklinkDevices.push(Number(dl.device));
                        if (dl.buffer_depth)
                            outputBufferDepth.value = Number(dl.buffer_depth);
                        if (dl.latency)
                            outputLatency.value = dl.latency;
                        if (dl.keyer)
                            outputKeyer.value = dl.keyer;
                        if (dl.embedded_audio !== undefined)
                            outputEmbeddedAudio.value = !!dl.embedded_audio;
                        if (dl.key_device)
                            outputKeyDevice.value = Number(dl.key_device);
                    }
                }
            }
        }
        if (decklinkDevices.length > 0) {
            outputDevice.value = decklinkDevices[0];
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
    }
    catch (error) {
        errorMessage.value = String(error || 'Failed to load configuration');
    }
    finally {
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
    if (!selection || Array.isArray(selection))
        return;
    configPath.value = selection;
    await loadConfig(selection);
};
const testConnection = async () => {
    testing.value = true;
    errorMessage.value = '';
    testResult.value = '';
    try {
        const result = await invoke('caspar_test_connection');
        testResult.value = `Connected: ${result.split('\n')[0] || 'OK'}`;
    }
    catch (error) {
        testResult.value = '';
        errorMessage.value = `Connection test failed: ${String(error)}`;
    }
    finally {
        testing.value = false;
    }
};
const applyConfig = async () => {
    applying.value = true;
    errorMessage.value = '';
    statusMessage.value = '';
    try {
        const result = await invoke('apply_caspar_decklink_config', {
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
        });
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
    }
    catch (error) {
        errorMessage.value = String(error || 'Failed to apply configuration');
    }
    finally {
        applying.value = false;
    }
};
const goToStep = (step) => {
    if (step < 1 || step > totalSteps)
        return;
    if (step > activeStep.value && !canGoNext.value)
        return;
    activeStep.value = step;
    errorMessage.value = '';
    statusMessage.value = '';
};
const goNext = () => goToStep(activeStep.value + 1);
const goPrev = () => goToStep(activeStep.value - 1);
watch(() => props.isOpen, (open) => {
    if (open) {
        activeStep.value = 1;
        errorMessage.value = '';
        statusMessage.value = '';
        testResult.value = '';
        configLoaded.value = false;
        configSummary.value = null;
        const storedOutput = settings.decklinkOutputDevice;
        if (storedOutput > 0)
            outputDevice.value = storedOutput;
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
        }
        else {
            invoke('find_default_caspar_config')
                .then((path) => {
                if (path) {
                    configPath.value = path;
                    loadConfig();
                }
            })
                .catch(() => { });
        }
    }
});
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
/** @type {__VLS_StyleScopedClasses['step-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['step-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['step-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['form-group']} */ ;
/** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-apply']} */ ;
/** @type {__VLS_StyleScopedClasses['status']} */ ;
/** @type {__VLS_StyleScopedClasses['status']} */ ;
/** @type {__VLS_StyleScopedClasses['ok']} */ ;
/** @type {__VLS_StyleScopedClasses['status']} */ ;
/** @type {__VLS_StyleScopedClasses['status']} */ ;
/** @type {__VLS_StyleScopedClasses['summary-row']} */ ;
/** @type {__VLS_StyleScopedClasses['review-list']} */ ;
/** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['two-col']} */ ;
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
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.$emit('close'));
                // @ts-ignore
                [isOpen, $emit,];
            } },
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
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
        ...{ class: "text-accent" },
    });
    /** @type {__VLS_StyleScopedClasses['text-accent']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "subtitle" },
    });
    /** @type {__VLS_StyleScopedClasses['subtitle']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.$emit('close'));
                // @ts-ignore
                [$emit,];
            } },
        ...{ class: "glass-btn btn-icon" },
        disabled: (__VLS_ctx.applying),
    });
    /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-icon']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "step-indicator" },
    });
    /** @type {__VLS_StyleScopedClasses['step-indicator']} */ ;
    for (const [step] of __VLS_vFor((__VLS_ctx.totalSteps))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    return (__VLS_ctx.goToStep(step));
                    // @ts-ignore
                    [applying, totalSteps, goToStep,];
                } },
            key: (step),
            ...{ class: "step-dot" },
            ...{ class: ({
                    active: step === __VLS_ctx.activeStep,
                    completed: step < __VLS_ctx.activeStep,
                }) },
            disabled: (step > __VLS_ctx.activeStep && !__VLS_ctx.canGoNext),
        });
        /** @type {__VLS_StyleScopedClasses['step-dot']} */ ;
        /** @type {__VLS_StyleScopedClasses['active']} */ ;
        /** @type {__VLS_StyleScopedClasses['completed']} */ ;
        (step);
        // @ts-ignore
        [activeStep, activeStep, activeStep, canGoNext,];
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-body custom-scroll" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-body']} */ ;
    /** @type {__VLS_StyleScopedClasses['custom-scroll']} */ ;
    if (__VLS_ctx.errorMessage) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "status error" },
        });
        /** @type {__VLS_StyleScopedClasses['status']} */ ;
        /** @type {__VLS_StyleScopedClasses['error']} */ ;
        (__VLS_ctx.errorMessage);
    }
    else if (__VLS_ctx.statusMessage) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "status ok" },
        });
        /** @type {__VLS_StyleScopedClasses['status']} */ ;
        /** @type {__VLS_StyleScopedClasses['ok']} */ ;
        (__VLS_ctx.statusMessage);
    }
    if (__VLS_ctx.activeStep === 1) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "wizard-section" },
        });
        /** @type {__VLS_StyleScopedClasses['wizard-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "section-title" },
        });
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
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            value: (__VLS_ctx.configPath),
            type: "text",
            ...{ class: "glass-input" },
            placeholder: "C:/CasparCG/casparcg.config",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.pickConfigPath) },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    if (!(__VLS_ctx.activeStep === 1))
                        throw 0;
                    return (__VLS_ctx.loadConfig());
                    // @ts-ignore
                    [activeStep, errorMessage, errorMessage, statusMessage, statusMessage, configPath, pickConfigPath, loadConfig,];
                } },
            ...{ class: "glass-btn" },
            disabled: (__VLS_ctx.loading || !__VLS_ctx.configPath.trim()),
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        (__VLS_ctx.loading ? 'Loading…' : 'Load');
        if (__VLS_ctx.configSummary) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "summary-card" },
            });
            /** @type {__VLS_StyleScopedClasses['summary-card']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "summary-row" },
            });
            /** @type {__VLS_StyleScopedClasses['summary-row']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
            (__VLS_ctx.configSummary.path);
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "summary-row" },
            });
            /** @type {__VLS_StyleScopedClasses['summary-row']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
            (__VLS_ctx.configSummary.channelCount);
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "summary-row" },
            });
            /** @type {__VLS_StyleScopedClasses['summary-row']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
            (__VLS_ctx.configSummary.videoMode);
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "summary-row" },
            });
            /** @type {__VLS_StyleScopedClasses['summary-row']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
            if (__VLS_ctx.configSummary.decklinkDevices.length) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
                (__VLS_ctx.configSummary.decklinkDevices.map(d => `Device ${d}`).join(', '));
            }
            else {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "text-muted" },
                });
                /** @type {__VLS_StyleScopedClasses['text-muted']} */ ;
            }
        }
    }
    if (__VLS_ctx.activeStep === 2) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "wizard-section" },
        });
        /** @type {__VLS_StyleScopedClasses['wizard-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "hint" },
        });
        /** @type {__VLS_StyleScopedClasses['hint']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-grid two-col" },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        /** @type {__VLS_StyleScopedClasses['two-col']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            value: (__VLS_ctx.outputDevice),
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        for (const [d] of __VLS_vFor((__VLS_ctx.deviceOptions))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                key: (d),
                value: (d),
            });
            (d);
            // @ts-ignore
            [activeStep, configPath, loading, loading, configSummary, configSummary, configSummary, configSummary, configSummary, configSummary, outputDevice, deviceOptions,];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            value: (__VLS_ctx.outputKeyDevice),
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: (0),
        });
        for (const [d] of __VLS_vFor((__VLS_ctx.deviceOptions))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                key: ('k' + d),
                value: (d),
            });
            (d);
            // @ts-ignore
            [deviceOptions, outputKeyDevice,];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            value: (__VLS_ctx.outputBufferDepth),
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        for (const [b] of __VLS_vFor((__VLS_ctx.bufferOptions))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                key: (b),
                value: (b),
            });
            (b);
            // @ts-ignore
            [outputBufferDepth, bufferOptions,];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            value: (__VLS_ctx.outputLatency),
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "normal",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "low",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "default",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            value: (__VLS_ctx.outputKeyer),
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "external",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "external_separate_device",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "internal",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "default",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ style: {} },
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "checkbox",
        });
        (__VLS_ctx.outputEmbeddedAudio);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
    }
    if (__VLS_ctx.activeStep === 3) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "wizard-section" },
        });
        /** @type {__VLS_StyleScopedClasses['wizard-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "hint" },
        });
        /** @type {__VLS_StyleScopedClasses['hint']} */ ;
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
        (__VLS_ctx.hasLiveInput);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        if (__VLS_ctx.hasLiveInput) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "form-group" },
            });
            /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
            __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
                value: (__VLS_ctx.inputDevice),
                ...{ class: "glass-input" },
            });
            /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
            for (const [d] of __VLS_vFor((__VLS_ctx.deviceOptions))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    key: (d),
                    value: (d),
                });
                (d);
                // @ts-ignore
                [activeStep, deviceOptions, outputLatency, outputKeyer, outputEmbeddedAudio, hasLiveInput, hasLiveInput, inputDevice,];
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "hint-text" },
            });
            /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
            if (__VLS_ctx.inputDevice === __VLS_ctx.outputDevice) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "status error" },
                });
                /** @type {__VLS_StyleScopedClasses['status']} */ ;
                /** @type {__VLS_StyleScopedClasses['error']} */ ;
                (__VLS_ctx.outputDevice);
            }
            else if (__VLS_ctx.routingSummary) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "routing-card" },
                });
                /** @type {__VLS_StyleScopedClasses['routing-card']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "routing-row" },
                });
                /** @type {__VLS_StyleScopedClasses['routing-row']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "routing-label" },
                });
                /** @type {__VLS_StyleScopedClasses['routing-label']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "routing-path" },
                });
                /** @type {__VLS_StyleScopedClasses['routing-path']} */ ;
                (__VLS_ctx.routingSummary);
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "routing-row" },
                });
                /** @type {__VLS_StyleScopedClasses['routing-row']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "routing-label" },
                });
                /** @type {__VLS_StyleScopedClasses['routing-label']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({
                    ...{ class: "routing-cmd" },
                });
                /** @type {__VLS_StyleScopedClasses['routing-cmd']} */ ;
                (__VLS_ctx.inputDevice);
            }
        }
    }
    if (__VLS_ctx.activeStep === 4) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "wizard-section" },
        });
        /** @type {__VLS_StyleScopedClasses['wizard-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "hint" },
        });
        /** @type {__VLS_StyleScopedClasses['hint']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            value: (__VLS_ctx.videoMode),
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        for (const [opt] of __VLS_vFor((__VLS_ctx.videoModeOptions))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                key: (opt.value),
                value: (opt.value),
            });
            (opt.label);
            // @ts-ignore
            [activeStep, outputDevice, outputDevice, inputDevice, inputDevice, routingSummary, routingSummary, videoMode, videoModeOptions,];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        (__VLS_ctx.videoMode.startsWith('1080i') ? 'interlaced PAL' : __VLS_ctx.videoMode.startsWith('2160') ? '4K' : 'progressive scan');
        if (__VLS_ctx.videoMode !== '1080i5000' && __VLS_ctx.settings.playoutProfile !== 'PAL_1080I50') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "status warn" },
            });
            /** @type {__VLS_StyleScopedClasses['status']} */ ;
            /** @type {__VLS_StyleScopedClasses['warn']} */ ;
            (__VLS_ctx.videoMode);
            (__VLS_ctx.settings.playoutProfile);
        }
    }
    if (__VLS_ctx.activeStep === 5) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "wizard-section" },
        });
        /** @type {__VLS_StyleScopedClasses['wizard-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "review-card" },
        });
        /** @type {__VLS_StyleScopedClasses['review-card']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "review-header" },
        });
        /** @type {__VLS_StyleScopedClasses['review-header']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
            ...{ class: "review-list" },
        });
        /** @type {__VLS_StyleScopedClasses['review-list']} */ ;
        for (const [change, i] of __VLS_vFor((__VLS_ctx.changesList))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                key: (i),
            });
            (change);
            // @ts-ignore
            [activeStep, videoMode, videoMode, videoMode, videoMode, settings, settings, changesList,];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.testConnection) },
            ...{ class: "glass-btn btn-test" },
            disabled: (__VLS_ctx.testing),
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-test']} */ ;
        (__VLS_ctx.testing ? 'Testing…' : 'Test CasparCG Connection');
        if (__VLS_ctx.testResult) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "status ok inline" },
            });
            /** @type {__VLS_StyleScopedClasses['status']} */ ;
            /** @type {__VLS_StyleScopedClasses['ok']} */ ;
            /** @type {__VLS_StyleScopedClasses['inline']} */ ;
            (__VLS_ctx.testResult);
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "warn-card" },
        });
        /** @type {__VLS_StyleScopedClasses['warn-card']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-footer" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
    if (__VLS_ctx.activeStep > 1) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.goPrev) },
            ...{ class: "glass-btn" },
            disabled: (__VLS_ctx.applying),
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "footer-spacer" },
    });
    /** @type {__VLS_StyleScopedClasses['footer-spacer']} */ ;
    if (__VLS_ctx.activeStep < __VLS_ctx.totalSteps) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.goNext) },
            ...{ class: "glass-btn btn-primary" },
            disabled: (!__VLS_ctx.canGoNext),
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    }
    if (__VLS_ctx.activeStep === __VLS_ctx.totalSteps) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.applyConfig) },
            ...{ class: "glass-btn btn-apply" },
            disabled: (__VLS_ctx.applying || !!__VLS_ctx.errorMessage),
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-apply']} */ ;
        (__VLS_ctx.applying ? 'Applying…' : 'Apply & Save');
    }
}
// @ts-ignore
[applying, applying, applying, totalSteps, totalSteps, activeStep, activeStep, activeStep, canGoNext, errorMessage, testConnection, testing, testing, testResult, testResult, goPrev, goNext, applyConfig,];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
