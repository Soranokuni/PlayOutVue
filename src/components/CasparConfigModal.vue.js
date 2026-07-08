import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
const props = defineProps();
const emit = defineEmits();
const configPath = ref('');
const activeTab = ref('structured');
const loading = ref(false);
const saving = ref(false);
const errorMessage = ref('');
const statusMessage = ref('');
const rawXml = ref('');
const structuredConfig = ref(createDefaultConfig());
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
    if (!openState)
        return;
    initialize().catch((error) => {
        errorMessage.value = formatError(error, 'Failed to load CasparCG configuration');
    });
});
function createDefaultScreen() {
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
function createDefaultAudio() {
    return {
        channelLayout: 'stereo',
        latency: 200
    };
}
function createDefaultDecklink() {
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
function createDefaultChannel() {
    return {
        videoMode: '1080i5000',
        screens: [createDefaultScreen()],
        systemAudio: [createDefaultAudio()],
        decklinks: []
    };
}
function createDefaultConfig() {
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
function toStructuredConfig(config) {
    const channels = Array.isArray(config?.channels?.channels) && config.channels.channels.length
        ? config.channels.channels.map((channel) => ({
            videoMode: channel?.video_mode || '1080i5000',
            screens: Array.isArray(channel?.consumers?.screens) && channel.consumers.screens.length
                ? channel.consumers.screens.map((screen) => ({
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
                ? channel.consumers.system_audio.map((audio) => ({
                    channelLayout: audio?.channel_layout || 'stereo',
                    latency: Number(audio?.latency ?? 200)
                }))
                : [],
            decklinks: Array.isArray(channel?.consumers?.decklinks) && channel.consumers.decklinks.length
                ? channel.consumers.decklinks.map((decklink) => ({
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
function toStructuredPayload(config) {
    const textOrUndefined = (value) => value.trim() || undefined;
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
        const detected = await invoke('find_default_caspar_config');
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
        const result = await invoke('load_caspar_config', {
            path: configPath.value.trim() || null
        });
        configPath.value = result.path;
        emit('update:path', result.path);
        rawXml.value = result.raw_xml;
        structuredConfig.value = toStructuredConfig(result.config);
        statusMessage.value = 'Configuration loaded.';
    }
    catch (error) {
        errorMessage.value = formatError(error, 'Failed to load CasparCG configuration');
    }
    finally {
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
    if (!selection || Array.isArray(selection))
        return;
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
        }
        else {
            const xml = await invoke('save_caspar_config_structured', {
                path: configPath.value,
                config: toStructuredPayload(structuredConfig.value)
            });
            rawXml.value = xml;
        }
        emit('update:path', configPath.value);
        statusMessage.value = 'Configuration saved.';
    }
    catch (error) {
        errorMessage.value = formatError(error, 'Failed to save CasparCG configuration');
    }
    finally {
        saving.value = false;
    }
}
function addChannel() {
    structuredConfig.value.channels.push(createDefaultChannel());
}
function removeChannel(index) {
    structuredConfig.value.channels.splice(index, 1);
    if (!structuredConfig.value.channels.length)
        addChannel();
}
function formatError(error, fallback) {
    return error instanceof Error ? error.message : String(error || fallback);
}
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
/** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
/** @type {__VLS_StyleScopedClasses['section-header']} */ ;
/** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['xml-editor']} */ ;
/** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['status-card']} */ ;
/** @type {__VLS_StyleScopedClasses['status-card']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-card']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-card']} */ ;
/** @type {__VLS_StyleScopedClasses['consumer-group']} */ ;
/** @type {__VLS_StyleScopedClasses['consumer-card']} */ ;
/** @type {__VLS_StyleScopedClasses['consumer-card']} */ ;
/** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['two-col']} */ ;
/** @type {__VLS_StyleScopedClasses['input-with-button']} */ ;
/** @type {__VLS_StyleScopedClasses['section-header']} */ ;
/** @type {__VLS_StyleScopedClasses['channel-card-header']} */ ;
/** @type {__VLS_StyleScopedClasses['consumer-card-header']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-header']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
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
                return (__VLS_ctx.emit('close'));
                // @ts-ignore
                [isOpen, emit,];
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
                return (__VLS_ctx.emit('close'));
                // @ts-ignore
                [emit,];
            } },
        ...{ class: "glass-btn btn-icon" },
    });
    /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-icon']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-body custom-scroll" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-body']} */ ;
    /** @type {__VLS_StyleScopedClasses['custom-scroll']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
        ...{ class: "settings-section compact-gap" },
    });
    /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
    /** @type {__VLS_StyleScopedClasses['compact-gap']} */ ;
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
        ...{ onClick: (__VLS_ctx.loadConfig) },
        ...{ class: "glass-btn" },
        disabled: (__VLS_ctx.loading),
    });
    /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    (__VLS_ctx.loading ? 'Loading…' : 'Reload');
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "hint-text" },
    });
    /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tab-strip" },
    });
    /** @type {__VLS_StyleScopedClasses['tab-strip']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.activeTab = 'structured');
                // @ts-ignore
                [configPath, pickConfigPath, loadConfig, loading, loading, activeTab,];
            } },
        ...{ class: "tab-btn" },
        ...{ class: ({ active: __VLS_ctx.activeTab === 'structured' }) },
    });
    /** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.activeTab = 'raw');
                // @ts-ignore
                [activeTab, activeTab,];
            } },
        ...{ class: "tab-btn" },
        ...{ class: ({ active: __VLS_ctx.activeTab === 'raw' }) },
    });
    /** @type {__VLS_StyleScopedClasses['tab-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
    if (__VLS_ctx.errorMessage) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "status-card error" },
        });
        /** @type {__VLS_StyleScopedClasses['status-card']} */ ;
        /** @type {__VLS_StyleScopedClasses['error']} */ ;
        (__VLS_ctx.errorMessage);
    }
    else if (__VLS_ctx.statusMessage) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "status-card ok" },
        });
        /** @type {__VLS_StyleScopedClasses['status-card']} */ ;
        /** @type {__VLS_StyleScopedClasses['ok']} */ ;
        (__VLS_ctx.statusMessage);
    }
    if (__VLS_ctx.activeTab === 'structured') {
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
            ...{ class: "form-grid two-col" },
        });
        /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
        /** @type {__VLS_StyleScopedClasses['two-col']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            value: (__VLS_ctx.structuredConfig.mediaPath),
            type: "text",
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            value: (__VLS_ctx.structuredConfig.logPath),
            type: "text",
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            value: (__VLS_ctx.structuredConfig.dataPath),
            type: "text",
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            value: (__VLS_ctx.structuredConfig.templatePath),
            type: "text",
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            value: (__VLS_ctx.structuredConfig.fontPath),
            type: "text",
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            value: (__VLS_ctx.structuredConfig.lockClearPhrase),
            type: "text",
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            value: (__VLS_ctx.structuredConfig.logLevel),
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "trace",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "debug",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "info",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "warning",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "error",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "fatal",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group checkbox-inline" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        /** @type {__VLS_StyleScopedClasses['checkbox-inline']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "checkbox",
        });
        (__VLS_ctx.structuredConfig.logAlignColumns);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "number",
            min: "1",
            ...{ class: "glass-input" },
        });
        (__VLS_ctx.structuredConfig.controllerPort);
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            value: (__VLS_ctx.structuredConfig.controllerProtocol),
            type: "text",
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            value: (__VLS_ctx.structuredConfig.mediaServerHost),
            type: "text",
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "number",
            min: "1",
            ...{ class: "glass-input" },
        });
        (__VLS_ctx.structuredConfig.mediaServerPort);
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "number",
            min: "1",
            ...{ class: "glass-input" },
        });
        (__VLS_ctx.structuredConfig.oscDefaultPort);
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "form-group checkbox-inline" },
        });
        /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
        /** @type {__VLS_StyleScopedClasses['checkbox-inline']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "checkbox",
        });
        (__VLS_ctx.structuredConfig.oscDisableSendToAmcpClients);
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "section-header" },
        });
        /** @type {__VLS_StyleScopedClasses['section-header']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.addChannel) },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        for (const [channel, channelIndex] of __VLS_vFor((__VLS_ctx.structuredConfig.channels))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                key: (channelIndex),
                ...{ class: "channel-card" },
            });
            /** @type {__VLS_StyleScopedClasses['channel-card']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "channel-card-header" },
            });
            /** @type {__VLS_StyleScopedClasses['channel-card-header']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
            (channelIndex + 1);
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.isOpen))
                            throw 0;
                        if (!(__VLS_ctx.activeTab === 'structured'))
                            throw 0;
                        return (__VLS_ctx.removeChannel(channelIndex));
                        // @ts-ignore
                        [activeTab, activeTab, errorMessage, errorMessage, statusMessage, statusMessage, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, structuredConfig, addChannel, removeChannel,];
                    } },
                ...{ class: "glass-btn danger" },
            });
            /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['danger']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "form-group" },
            });
            /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
            __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
                list: "caspar-video-modes",
                ...{ class: "glass-input" },
            });
            (channel.videoMode);
            /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "consumer-group" },
            });
            /** @type {__VLS_StyleScopedClasses['consumer-group']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "section-header mini" },
            });
            /** @type {__VLS_StyleScopedClasses['section-header']} */ ;
            /** @type {__VLS_StyleScopedClasses['mini']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({});
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.isOpen))
                            throw 0;
                        if (!(__VLS_ctx.activeTab === 'structured'))
                            throw 0;
                        return (channel.screens.push(__VLS_ctx.createDefaultScreen()));
                        // @ts-ignore
                        [createDefaultScreen,];
                    } },
                ...{ class: "glass-btn" },
            });
            /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
            for (const [screen, screenIndex] of __VLS_vFor((channel.screens))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    key: (`screen-${screenIndex}`),
                    ...{ class: "consumer-card" },
                });
                /** @type {__VLS_StyleScopedClasses['consumer-card']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "consumer-card-header" },
                });
                /** @type {__VLS_StyleScopedClasses['consumer-card-header']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
                (screenIndex + 1);
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!(__VLS_ctx.isOpen))
                                throw 0;
                            if (!(__VLS_ctx.activeTab === 'structured'))
                                throw 0;
                            return (channel.screens.splice(screenIndex, 1));
                            // @ts-ignore
                            [];
                        } },
                    ...{ class: "glass-btn danger" },
                });
                /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
                /** @type {__VLS_StyleScopedClasses['danger']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-grid two-col compact-grid" },
                });
                /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
                /** @type {__VLS_StyleScopedClasses['two-col']} */ ;
                /** @type {__VLS_StyleScopedClasses['compact-grid']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
                    type: "number",
                    min: "1",
                    ...{ class: "glass-input" },
                });
                (screen.device);
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
                    value: (screen.aspectRatio),
                    ...{ class: "glass-input" },
                });
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "default",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "4:3",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "16:9",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
                    value: (screen.stretch),
                    ...{ class: "glass-input" },
                });
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "none",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "fill",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "uniform",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "uniform_to_fill",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
                    value: (screen.colourSpace),
                    ...{ class: "glass-input" },
                });
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "RGB",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "datavideo-full",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "datavideo-limited",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
                    type: "number",
                    ...{ class: "glass-input" },
                });
                (screen.x);
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
                    type: "number",
                    ...{ class: "glass-input" },
                });
                (screen.y);
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
                    type: "number",
                    ...{ class: "glass-input" },
                });
                (screen.width);
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
                    type: "number",
                    ...{ class: "glass-input" },
                });
                (screen.height);
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "toggle-row" },
                });
                /** @type {__VLS_StyleScopedClasses['toggle-row']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "checkbox",
                });
                (screen.windowed);
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "checkbox",
                });
                (screen.keyOnly);
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "checkbox",
                });
                (screen.vsync);
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "checkbox",
                });
                (screen.borderless);
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "checkbox",
                });
                (screen.interactive);
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "checkbox",
                });
                (screen.alwaysOnTop);
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "checkbox",
                });
                (screen.sbsKey);
                // @ts-ignore
                [];
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "consumer-group" },
            });
            /** @type {__VLS_StyleScopedClasses['consumer-group']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "section-header mini" },
            });
            /** @type {__VLS_StyleScopedClasses['section-header']} */ ;
            /** @type {__VLS_StyleScopedClasses['mini']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({});
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.isOpen))
                            throw 0;
                        if (!(__VLS_ctx.activeTab === 'structured'))
                            throw 0;
                        return (channel.systemAudio.push(__VLS_ctx.createDefaultAudio()));
                        // @ts-ignore
                        [createDefaultAudio,];
                    } },
                ...{ class: "glass-btn" },
            });
            /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
            for (const [audio, audioIndex] of __VLS_vFor((channel.systemAudio))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    key: (`audio-${audioIndex}`),
                    ...{ class: "consumer-card" },
                });
                /** @type {__VLS_StyleScopedClasses['consumer-card']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "consumer-card-header" },
                });
                /** @type {__VLS_StyleScopedClasses['consumer-card-header']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
                (audioIndex + 1);
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!(__VLS_ctx.isOpen))
                                throw 0;
                            if (!(__VLS_ctx.activeTab === 'structured'))
                                throw 0;
                            return (channel.systemAudio.splice(audioIndex, 1));
                            // @ts-ignore
                            [];
                        } },
                    ...{ class: "glass-btn danger" },
                });
                /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
                /** @type {__VLS_StyleScopedClasses['danger']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-grid two-col compact-grid" },
                });
                /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
                /** @type {__VLS_StyleScopedClasses['two-col']} */ ;
                /** @type {__VLS_StyleScopedClasses['compact-grid']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
                    value: (audio.channelLayout),
                    ...{ class: "glass-input" },
                });
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "mono",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "stereo",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    value: "matrix",
                });
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
                    type: "number",
                    min: "0",
                    ...{ class: "glass-input" },
                });
                (audio.latency);
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                // @ts-ignore
                [];
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "consumer-group" },
            });
            /** @type {__VLS_StyleScopedClasses['consumer-group']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "section-header mini" },
            });
            /** @type {__VLS_StyleScopedClasses['section-header']} */ ;
            /** @type {__VLS_StyleScopedClasses['mini']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({});
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.isOpen))
                            throw 0;
                        if (!(__VLS_ctx.activeTab === 'structured'))
                            throw 0;
                        return (channel.decklinks.push(__VLS_ctx.createDefaultDecklink()));
                        // @ts-ignore
                        [createDefaultDecklink,];
                    } },
                ...{ class: "glass-btn" },
            });
            /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
            for (const [decklink, decklinkIndex] of __VLS_vFor((channel.decklinks))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    key: (`decklink-${decklinkIndex}`),
                    ...{ class: "consumer-card" },
                });
                /** @type {__VLS_StyleScopedClasses['consumer-card']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "consumer-card-header" },
                });
                /** @type {__VLS_StyleScopedClasses['consumer-card-header']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
                (decklinkIndex + 1);
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!(__VLS_ctx.isOpen))
                                throw 0;
                            if (!(__VLS_ctx.activeTab === 'structured'))
                                throw 0;
                            return (channel.decklinks.splice(decklinkIndex, 1));
                            // @ts-ignore
                            [];
                        } },
                    ...{ class: "glass-btn danger" },
                });
                /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
                /** @type {__VLS_StyleScopedClasses['danger']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-grid two-col compact-grid" },
                });
                /** @type {__VLS_StyleScopedClasses['form-grid']} */ ;
                /** @type {__VLS_StyleScopedClasses['two-col']} */ ;
                /** @type {__VLS_StyleScopedClasses['compact-grid']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
                    type: "number",
                    min: "1",
                    ...{ class: "glass-input" },
                });
                (decklink.device);
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
                    type: "number",
                    min: "1",
                    ...{ class: "glass-input" },
                    placeholder: "optional",
                });
                (decklink.keyDevice);
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "form-group" },
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
                    value: (decklink.latency),
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
                    value: (decklink.keyer),
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
                });
                /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
                    type: "number",
                    min: "1",
                    ...{ class: "glass-input" },
                });
                (decklink.bufferDepth);
                /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "toggle-row" },
                });
                /** @type {__VLS_StyleScopedClasses['toggle-row']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "checkbox",
                });
                (decklink.embeddedAudio);
                __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    type: "checkbox",
                });
                (decklink.keyOnly);
                // @ts-ignore
                [];
            }
            // @ts-ignore
            [];
        }
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "settings-section" },
        });
        /** @type {__VLS_StyleScopedClasses['settings-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "text-secondary section-title" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['section-title']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "hint-text" },
        });
        /** @type {__VLS_StyleScopedClasses['hint-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
            value: (__VLS_ctx.rawXml),
            ...{ class: "xml-editor" },
            spellcheck: "false",
        });
        /** @type {__VLS_StyleScopedClasses['xml-editor']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.datalist, __VLS_intrinsics.datalist)({
        id: "caspar-video-modes",
    });
    for (const [mode] of __VLS_vFor((__VLS_ctx.videoModeOptions))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.option)({
            key: (mode),
            value: (mode),
        });
        // @ts-ignore
        [rawXml, videoModeOptions,];
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "modal-footer" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-footer']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.emit('close'));
                // @ts-ignore
                [emit,];
            } },
        ...{ class: "glass-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.saveCurrent) },
        ...{ class: "glass-btn btn-primary" },
        disabled: (!__VLS_ctx.canSave),
    });
    /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    (__VLS_ctx.saving ? 'Saving…' : 'Save Config');
}
// @ts-ignore
[saveCurrent, canSave, saving,];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
