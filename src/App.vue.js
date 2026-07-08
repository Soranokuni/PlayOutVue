import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import MediaLibrary from './components/MediaLibrary.vue';
import RundownList from './components/RundownList.vue';
import MediaInspector from './components/MediaInspector.vue';
import SettingsModal from './components/SettingsModal.vue';
import PreviewMonitor from './components/PreviewMonitor.vue';
import IngestorStatusLight from './components/IngestorStatusLight.vue';
import ClientDiagnosticsLog from './components/ClientDiagnosticsLog.vue';
import { activePlayoutCapabilities, activePlayoutLabel, currentPlayoutTime, getActivePlayoutService, isPlayoutConnected, isPlayoutPlaying } from './services/playout';
import { useSettingsStore } from './stores/settings';
import { useRundownStore } from './stores/rundown';
import { useIngestorStatusStore } from './stores/ingestorStatus';
const settings = useSettingsStore();
const rundown = useRundownStore();
const isStreaming = ref(false);
const isSdiActive = ref(false);
const showSettings = ref(false);
const showDiagnostics = ref(false);
const ingestorStatus = useIngestorStatusStore();
const playoutHalted = ref(false);
let unlistenHeartbeat = null;
let unlistenHalted = null;
// Performance / Jank Monitor
let jankFrameId = null;
let lastFrameTime = performance.now();
let frameTimes = [];
let jankCount = 0;
let lastReportTime = performance.now();
const startJankMonitor = () => {
    if (jankFrameId)
        return;
    lastFrameTime = performance.now();
    lastReportTime = performance.now();
    frameTimes = [];
    jankCount = 0;
    const runLoop = () => {
        const now = performance.now();
        const delta = now - lastFrameTime;
        lastFrameTime = now;
        frameTimes.push(delta);
        // a delta > 33ms is a dropped frame (jank)
        if (delta > 33) {
            jankCount++;
        }
        if (now - lastReportTime >= 5000) {
            const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
            const fps = 1000 / avgFrameTime;
            const heapMemory = performance.memory
                ? Math.round(performance.memory.usedJSHeapSize / (1024 * 1024))
                : null;
            const memoryStr = heapMemory !== null ? `${heapMemory}MB` : 'N/A';
            const logMessage = `FPS: ${fps.toFixed(1)} | Jank frames: ${jankCount} | JS Heap: ${memoryStr}`;
            setTimeout(() => {
                invoke('push_diagnostic_log', {
                    level: 'info',
                    scope: 'ui-performance',
                    message: logMessage
                }).catch(() => { });
            }, 0);
            frameTimes = [];
            jankCount = 0;
            lastReportTime = now;
        }
        jankFrameId = requestAnimationFrame(runLoop);
    };
    jankFrameId = requestAnimationFrame(runLoop);
};
const stopJankMonitor = () => {
    if (jankFrameId) {
        cancelAnimationFrame(jankFrameId);
        jankFrameId = null;
    }
};
watch(() => settings.debugMode, (enabled) => {
    if (enabled) {
        startJankMonitor();
    }
    else {
        stopJankMonitor();
    }
}, { immediate: true });
const footerMetaRef = ref(null);
const showProductInfo = ref(false);
const showQuickGuide = ref(false);
const APP_NAME = 'PlayOutOS';
const APP_VERSION = '2.0.1';
const appHighlights = [
    'Multi-playlist rundown planning with separate offline prep and on-air control.',
    'CasparCG playout control with safe handoff, live cuts, and timing feedback.',
    'Media library scanning, trim workflow, compliance labels, and spot or telemarketing tagging.',
    'Operator-first rundown editing with drag insert, gap markers, next-up warnings, and persistent selection.'
];
const shortcutGuide = [
    'Enter or Space: play from the selected rundown row.',
    'Delete or Backspace: remove the selected row, except the one currently on air.',
    'Ctrl + Arrow Up or Arrow Down: move the selected row.',
    'Shift + Arrow Down: duplicate the selected row.',
    'F8 in the media library: append the selected library item after the selected rundown row.'
];
const workflowGuide = [
    'Drag media from the library into the rundown to insert exactly where the cyan marker appears.',
    'Double-click a playlist tab to rename it, then keep offline playlists staged until you take them on air.',
    'Use gap lines plus Day and At to plan hard starts without changing the playout queue until playback begins.',
    'Use the right panel for preview and inspection, and Settings for connections, media paths, and debug controls.'
];
const leftWidth = useStorage('layout.leftWidth', 260);
const rightWidth = useStorage('layout.rightWidth', 240);
const showRightPanel = useStorage('layout.rightPanelVisible', false);
const rightPanelTab = useStorage('layout.rightPanelTab', 'preview');
const isResizing = ref(null);
const isLightMode = useStorage('ui.isLightMode', false);
let pendingResizeX = 0;
let resizeFrame = 0;
watch(isLightMode, (val) => {
    if (val)
        document.body.classList.add('light-theme');
    else
        document.body.classList.remove('light-theme');
}, { immediate: true });
watch(() => ({
    debugEnabled: settings.debugMode,
    ffmpegBinPath: settings.ffmpegBinPath,
    ingestorApiBaseUrl: settings.ingestorApiBaseUrl
}), (runtimeSettings) => {
    invoke('apply_runtime_settings', {
        settings: runtimeSettings
    }).catch((error) => {
        console.warn('[RuntimeSettings] Failed to sync backend runtime settings', error);
    });
}, { immediate: true, deep: true });
const formatDuration = (seconds) => {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainingSeconds = total % 60;
    return [hours, minutes, remainingSeconds]
        .filter((value, index) => value > 0 || index > 0)
        .map((value) => String(value).padStart(2, '0'))
        .join(':');
};
const rundownSummary = computed(() => {
    const itemCount = rundown.activeItems.length;
    if (!itemCount)
        return 'No items loaded';
    return `${rundown.currentPlaylistName} · ${itemCount} item${itemCount === 1 ? '' : 's'} · ${formatDuration(rundown.totalDuration)}`;
});
const toggleProductInfo = () => {
    showProductInfo.value = !showProductInfo.value;
    if (showProductInfo.value)
        showQuickGuide.value = false;
};
const toggleQuickGuide = () => {
    showQuickGuide.value = !showQuickGuide.value;
    if (showQuickGuide.value)
        showProductInfo.value = false;
};
const closeFooterPanels = () => {
    showProductInfo.value = false;
    showQuickGuide.value = false;
};
const handleGlobalPointerDown = (event) => {
    const target = event.target;
    if (footerMetaRef.value && target && footerMetaRef.value.contains(target))
        return;
    closeFooterPanels();
};
const applyResize = () => {
    resizeFrame = 0;
    if (isResizing.value === 'left') {
        leftWidth.value = Math.max(220, Math.min(520, pendingResizeX));
    }
    else if (isResizing.value === 'right') {
        rightWidth.value = Math.max(220, Math.min(520, window.innerWidth - pendingResizeX));
    }
};
const startResizeLeft = () => { isResizing.value = 'left'; window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp); };
const startResizeRight = () => { isResizing.value = 'right'; window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp); };
const onMouseMove = (e) => {
    pendingResizeX = e.clientX;
    if (!resizeFrame)
        resizeFrame = requestAnimationFrame(applyResize);
};
const onMouseUp = () => {
    isResizing.value = null;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    if (resizeFrame) {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
    }
};
const toggleConnection = async () => {
    const service = getActivePlayoutService();
    if (isPlayoutConnected.value)
        await service.disconnect();
    else
        await service.connect();
};
const playSelected = async () => {
    const payload = rundown.buildPlaybackPayload();
    if (!payload)
        return;
    const service = getActivePlayoutService();
    if (isPlayoutPlaying.value && rundown.onAirPlaylistId && rundown.onAirPlaylistId !== payload.playlistId) {
        await service.stop();
        rundown.clearOnAirState();
    }
    rundown.setPlaylistOnAir(payload.playlistId, payload.startVisibleIndex);
    rundown.selectedItemId = rundown.activeItems[payload.startVisibleIndex]?.id || null;
    try {
        await service.play(payload.items, payload.startIndex);
    }
    catch (error) {
        rundown.clearOnAirState();
        throw error;
    }
};
const stopPlayback = async () => {
    await getActivePlayoutService().stop();
    rundown.clearOnAirState();
};
const toggleStream = async () => {
    const service = getActivePlayoutService();
    if (!service.startStream || !service.stopStream)
        return;
    if (isStreaming.value)
        await service.stopStream();
    else
        await service.startStream();
};
const toggleSdi = async () => {
    if (!settings.decklinkOutputName)
        return;
    const service = getActivePlayoutService();
    if (!service.startDeckLink || !service.stopDeckLink)
        return;
    if (isSdiActive.value) {
        await service.stopDeckLink(settings.decklinkOutputName);
        isSdiActive.value = false;
    }
    else {
        await service.startDeckLink(settings.decklinkOutputName);
        isSdiActive.value = true;
    }
};
const cutToLive = async () => {
    await getActivePlayoutService().cutToLive?.();
};
onMounted(async () => {
    window.addEventListener('pointerdown', handleGlobalPointerDown);
    try {
        unlistenHeartbeat = await listen('ingestor-heartbeat', (event) => {
            const payload = event.payload;
            ingestorStatus.setOnline(payload.online, payload.last_seen_at);
            if (!payload.online && payload.error) {
                ingestorStatus.logWarning('ingestor-heartbeat', `Connection lost: ${payload.error}`);
            }
        });
    }
    catch (err) {
        console.error('[Heartbeat] Failed to listen to heartbeat events:', err);
    }
    try {
        unlistenHalted = await listen('playout://halted', () => {
            playoutHalted.value = true;
        });
    }
    catch (err) {
        console.error('[Playout] Failed to listen to playout://halted event:', err);
    }
    if (settings.debugMode) {
        startJankMonitor();
    }
    // Bug 3 Fix 3: Restore connection and playback state on F5 refresh
    if (settings.playoutEngine === 'casparcg') {
        const service = getActivePlayoutService();
        service.connect().catch((error) => {
            console.warn('[Playout] Auto-connect to CasparCG failed:', error);
        });
    }
    rundown.restorePlaybackState();
});
onUnmounted(() => {
    onMouseUp();
    window.removeEventListener('pointerdown', handleGlobalPointerDown);
    if (unlistenHeartbeat) {
        unlistenHeartbeat();
        unlistenHeartbeat = null;
    }
    if (unlistenHalted) {
        unlistenHalted();
        unlistenHalted = null;
    }
    stopJankMonitor();
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['resizer']} */ ;
/** @type {__VLS_StyleScopedClasses['resizer']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-toggle-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-play']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-live-now']} */ ;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-meta-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-meta-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-meta-list']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-meta-close']} */ ;
/** @type {__VLS_StyleScopedClasses['control-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-divider']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-value']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-meta-dock']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-meta-popover']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-meta-popover-guide']} */ ;
/** @type {__VLS_StyleScopedClasses['halt-dismiss-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['halt-dismiss-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.main, __VLS_intrinsics.main)({
    ...{ class: "app-shell" },
    ...{ style: ({
            '--left-w': `${__VLS_ctx.leftWidth}px`,
            '--right-w': __VLS_ctx.showRightPanel ? `${__VLS_ctx.rightWidth}px` : '0px',
            '--right-resizer-w': __VLS_ctx.showRightPanel ? '8px' : '0px',
            cursor: __VLS_ctx.isResizing ? 'ew-resize' : 'default'
        }) },
});
/** @type {__VLS_StyleScopedClasses['app-shell']} */ ;
if (__VLS_ctx.playoutHalted) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "halt-banner" },
    });
    /** @type {__VLS_StyleScopedClasses['halt-banner']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "halt-content" },
    });
    /** @type {__VLS_StyleScopedClasses['halt-content']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "halt-icon" },
    });
    /** @type {__VLS_StyleScopedClasses['halt-icon']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "halt-text" },
    });
    /** @type {__VLS_StyleScopedClasses['halt-text']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.playoutHalted))
                    throw 0;
                return (__VLS_ctx.playoutHalted = false);
                // @ts-ignore
                [leftWidth, showRightPanel, showRightPanel, rightWidth, isResizing, playoutHalted, playoutHalted,];
            } },
        ...{ class: "halt-dismiss-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['halt-dismiss-btn']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.aside, __VLS_intrinsics.aside)({
    ...{ class: "panel panel-library glass-panel" },
});
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-library']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-panel']} */ ;
const __VLS_0 = MediaLibrary;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({}));
const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onMousedown: (__VLS_ctx.startResizeLeft) },
    ...{ onDblclick: (...[$event]) => {
            return (__VLS_ctx.leftWidth = 260);
            // @ts-ignore
            [leftWidth, startResizeLeft,];
        } },
    ...{ class: "resizer resizer-left" },
    title: "Drag to resize · double-click to reset",
});
/** @type {__VLS_StyleScopedClasses['resizer']} */ ;
/** @type {__VLS_StyleScopedClasses['resizer-left']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "panel panel-rundown glass-panel" },
});
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-rundown']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-panel']} */ ;
const __VLS_5 = RundownList;
// @ts-ignore
const __VLS_6 = __VLS_asFunctionalComponent1(__VLS_5, new __VLS_5({}));
const __VLS_7 = __VLS_6({}, ...__VLS_functionalComponentArgsRest(__VLS_6));
if (__VLS_ctx.showRightPanel) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onMousedown: (__VLS_ctx.startResizeRight) },
        ...{ onDblclick: (...[$event]) => {
                if (!(__VLS_ctx.showRightPanel))
                    throw 0;
                return (__VLS_ctx.rightWidth = 240);
                // @ts-ignore
                [showRightPanel, rightWidth, startResizeRight,];
            } },
        ...{ class: "resizer resizer-right" },
        title: "Drag to resize · double-click to reset",
    });
    /** @type {__VLS_StyleScopedClasses['resizer']} */ ;
    /** @type {__VLS_StyleScopedClasses['resizer-right']} */ ;
}
if (__VLS_ctx.showRightPanel) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.aside, __VLS_intrinsics.aside)({
        ...{ class: "panel panel-right glass-panel" },
    });
    /** @type {__VLS_StyleScopedClasses['panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['panel-right']} */ ;
    /** @type {__VLS_StyleScopedClasses['glass-panel']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "panel-right-header" },
    });
    /** @type {__VLS_StyleScopedClasses['panel-right-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showRightPanel))
                    throw 0;
                return (__VLS_ctx.rightPanelTab = 'preview');
                // @ts-ignore
                [showRightPanel, rightPanelTab,];
            } },
        ...{ class: "panel-toggle-btn" },
        ...{ class: ({ 'is-active': __VLS_ctx.rightPanelTab === 'preview' }) },
    });
    /** @type {__VLS_StyleScopedClasses['panel-toggle-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['is-active']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showRightPanel))
                    throw 0;
                return (__VLS_ctx.rightPanelTab = 'inspector');
                // @ts-ignore
                [rightPanelTab, rightPanelTab,];
            } },
        ...{ class: "panel-toggle-btn" },
        ...{ class: ({ 'is-active': __VLS_ctx.rightPanelTab === 'inspector' }) },
    });
    /** @type {__VLS_StyleScopedClasses['panel-toggle-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['is-active']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "panel-right-body" },
    });
    /** @type {__VLS_StyleScopedClasses['panel-right-body']} */ ;
    if (__VLS_ctx.rightPanelTab === 'preview') {
        const __VLS_10 = PreviewMonitor;
        // @ts-ignore
        const __VLS_11 = __VLS_asFunctionalComponent1(__VLS_10, new __VLS_10({}));
        const __VLS_12 = __VLS_11({}, ...__VLS_functionalComponentArgsRest(__VLS_11));
    }
    else {
        const __VLS_15 = MediaInspector;
        // @ts-ignore
        const __VLS_16 = __VLS_asFunctionalComponent1(__VLS_15, new __VLS_15({}));
        const __VLS_17 = __VLS_16({}, ...__VLS_functionalComponentArgsRest(__VLS_16));
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.footer, __VLS_intrinsics.footer)({
    ...{ class: "control-bar glass-panel" },
});
/** @type {__VLS_StyleScopedClasses['control-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-panel']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ctrl-section" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-section']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "status-dot" },
    ...{ class: ({ connected: __VLS_ctx.isPlayoutConnected }) },
});
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['connected']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "ctrl-label" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-label']} */ ;
(__VLS_ctx.isPlayoutConnected ? __VLS_ctx.activePlayoutLabel : 'OFFLINE');
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.toggleConnection) },
    ...{ class: "ctrl-btn" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
(__VLS_ctx.isPlayoutConnected ? 'Disconnect' : 'Connect');
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ctrl-divider" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-divider']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ctrl-section ctrl-play-wrap" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-section']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-play-wrap']} */ ;
if (!__VLS_ctx.isPlayoutPlaying) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.playSelected) },
        ...{ class: "ctrl-btn btn-play" },
        disabled: (!__VLS_ctx.isPlayoutConnected || !__VLS_ctx.rundown.activeItems.length),
        title: "Play playlist from selected item (or beginning)",
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-play']} */ ;
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.stopPlayback) },
        ...{ class: "ctrl-btn btn-stop" },
        title: "Stop playback",
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-stop']} */ ;
}
if (__VLS_ctx.isPlayoutConnected) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.cutToLive) },
        ...{ class: "ctrl-btn btn-live-now" },
        title: "Cut to Live Source",
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-live-now']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ctrl-divider" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-divider']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ctrl-section" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-section']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "timecode" },
});
/** @type {__VLS_StyleScopedClasses['timecode']} */ ;
(__VLS_ctx.currentPlayoutTime);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ctrl-divider" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-divider']} */ ;
if (__VLS_ctx.activePlayoutCapabilities.streaming) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-section" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-section']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "status-dot" },
        ...{ class: ({ connected: __VLS_ctx.isStreaming }) },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
    /** @type {__VLS_StyleScopedClasses['connected']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "ctrl-label" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-label']} */ ;
    (__VLS_ctx.isStreaming ? 'ON AIR' : 'STANDBY');
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.toggleStream) },
        ...{ class: "ctrl-btn" },
        ...{ class: ({ 'btn-live': __VLS_ctx.isStreaming }) },
        disabled: (!__VLS_ctx.isPlayoutConnected),
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-live']} */ ;
    (__VLS_ctx.isStreaming ? '■ Stop' : '● Stream');
    if (__VLS_ctx.activePlayoutCapabilities.hardwareOutput && __VLS_ctx.settings.decklinkOutputName) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.toggleSdi) },
            ...{ class: "ctrl-btn" },
            ...{ class: ({ 'btn-live': __VLS_ctx.isSdiActive }) },
            disabled: (!__VLS_ctx.isPlayoutConnected),
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-live']} */ ;
        (__VLS_ctx.isSdiActive ? '■ SDI Stop' : '● SDI OUT');
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ctrl-divider" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-divider']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ctrl-section ctrl-summary" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-section']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-summary']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "ctrl-label" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "ctrl-value" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-value']} */ ;
(__VLS_ctx.rundownSummary);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ctrl-divider" },
});
/** @type {__VLS_StyleScopedClasses['ctrl-divider']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.isLightMode = !__VLS_ctx.isLightMode);
            // @ts-ignore
            [rightPanelTab, rightPanelTab, isPlayoutConnected, isPlayoutConnected, isPlayoutConnected, isPlayoutConnected, isPlayoutConnected, isPlayoutConnected, isPlayoutConnected, activePlayoutLabel, toggleConnection, isPlayoutPlaying, playSelected, rundown, stopPlayback, cutToLive, currentPlayoutTime, activePlayoutCapabilities, activePlayoutCapabilities, isStreaming, isStreaming, isStreaming, isStreaming, toggleStream, settings, toggleSdi, isSdiActive, isSdiActive, rundownSummary, isLightMode, isLightMode,];
        } },
    ...{ class: "ctrl-btn" },
    ...{ style: {} },
    title: (__VLS_ctx.isLightMode ? 'Switch to Dark Mode' : 'Switch to Light Mode'),
});
/** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
(__VLS_ctx.isLightMode ? '🌙' : '☀️');
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.showRightPanel = !__VLS_ctx.showRightPanel);
            // @ts-ignore
            [showRightPanel, showRightPanel, isLightMode, isLightMode,];
        } },
    ...{ class: "ctrl-btn" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
(__VLS_ctx.showRightPanel ? 'Hide Side' : 'Show Side');
const __VLS_20 = IngestorStatusLight;
// @ts-ignore
const __VLS_21 = __VLS_asFunctionalComponent1(__VLS_20, new __VLS_20({}));
const __VLS_22 = __VLS_21({}, ...__VLS_functionalComponentArgsRest(__VLS_21));
if (__VLS_ctx.settings.debugMode) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.settings.debugMode))
                    throw 0;
                return (__VLS_ctx.showDiagnostics = !__VLS_ctx.showDiagnostics);
                // @ts-ignore
                [showRightPanel, settings, showDiagnostics, showDiagnostics,];
            } },
        ...{ class: "ctrl-btn" },
        ...{ style: {} },
        ...{ class: ({ active: __VLS_ctx.showDiagnostics }) },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.showSettings = true);
            // @ts-ignore
            [showDiagnostics, showSettings,];
        } },
    ...{ class: "ctrl-btn" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['ctrl-btn']} */ ;
if (__VLS_ctx.settings.debugMode) {
    const __VLS_25 = ClientDiagnosticsLog || ClientDiagnosticsLog;
    // @ts-ignore
    const __VLS_26 = __VLS_asFunctionalComponent1(__VLS_25, new __VLS_25({
        modelValue: (__VLS_ctx.showDiagnostics),
    }));
    const __VLS_27 = __VLS_26({
        modelValue: (__VLS_ctx.showDiagnostics),
    }, ...__VLS_functionalComponentArgsRest(__VLS_26));
    const { default: __VLS_30 } = __VLS_28.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ style: {} },
    });
    // @ts-ignore
    [settings, showDiagnostics,];
    var __VLS_28;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ctrl-meta-dock" },
    ref: "footerMetaRef",
});
/** @type {__VLS_StyleScopedClasses['ctrl-meta-dock']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.toggleProductInfo) },
    ...{ class: "ctrl-meta-btn ctrl-meta-brand" },
    ...{ class: ({ 'is-open': __VLS_ctx.showProductInfo }) },
    title: (`${__VLS_ctx.APP_NAME} ${__VLS_ctx.APP_VERSION}`),
});
/** @type {__VLS_StyleScopedClasses['ctrl-meta-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-meta-brand']} */ ;
/** @type {__VLS_StyleScopedClasses['is-open']} */ ;
(__VLS_ctx.APP_NAME);
(__VLS_ctx.APP_VERSION);
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.toggleQuickGuide) },
    ...{ class: "ctrl-meta-btn ctrl-meta-help" },
    ...{ class: ({ 'is-open': __VLS_ctx.showQuickGuide }) },
    title: "Quick guide",
    'aria-label': "Quick guide",
});
/** @type {__VLS_StyleScopedClasses['ctrl-meta-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['ctrl-meta-help']} */ ;
/** @type {__VLS_StyleScopedClasses['is-open']} */ ;
if (__VLS_ctx.showProductInfo) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-meta-popover" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-popover']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-meta-heading-row" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-heading-row']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-meta-kicker" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-kicker']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-meta-title" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-title']} */ ;
    (__VLS_ctx.APP_NAME);
    (__VLS_ctx.APP_VERSION);
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.closeFooterPanels) },
        ...{ class: "ctrl-meta-close" },
        'aria-label': "Close info",
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-close']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "ctrl-meta-copy" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-copy']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
        ...{ class: "ctrl-meta-list" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-list']} */ ;
    for (const [item] of __VLS_vFor((__VLS_ctx.appHighlights))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
            key: (item),
        });
        (item);
        // @ts-ignore
        [toggleProductInfo, showProductInfo, showProductInfo, APP_NAME, APP_NAME, APP_NAME, APP_VERSION, APP_VERSION, APP_VERSION, toggleQuickGuide, showQuickGuide, closeFooterPanels, appHighlights,];
    }
}
if (__VLS_ctx.showQuickGuide) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-meta-popover ctrl-meta-popover-guide" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-popover']} */ ;
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-popover-guide']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-meta-heading-row" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-heading-row']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-meta-kicker" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-kicker']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-meta-title" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-title']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.closeFooterPanels) },
        ...{ class: "ctrl-meta-close" },
        'aria-label': "Close guide",
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-close']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-meta-section-label" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-section-label']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
        ...{ class: "ctrl-meta-list" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-list']} */ ;
    for (const [item] of __VLS_vFor((__VLS_ctx.shortcutGuide))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
            key: (item),
        });
        (item);
        // @ts-ignore
        [showQuickGuide, closeFooterPanels, shortcutGuide,];
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-meta-section-label" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-section-label']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
        ...{ class: "ctrl-meta-list" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-meta-list']} */ ;
    for (const [item] of __VLS_vFor((__VLS_ctx.workflowGuide))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
            key: (item),
        });
        (item);
        // @ts-ignore
        [workflowGuide,];
    }
}
const __VLS_31 = SettingsModal;
// @ts-ignore
const __VLS_32 = __VLS_asFunctionalComponent1(__VLS_31, new __VLS_31({
    ...{ 'onClose': {} },
    isOpen: (__VLS_ctx.showSettings),
}));
const __VLS_33 = __VLS_32({
    ...{ 'onClose': {} },
    isOpen: (__VLS_ctx.showSettings),
}, ...__VLS_functionalComponentArgsRest(__VLS_32));
let __VLS_36;
const __VLS_37 = {
    /** @type {typeof __VLS_36.close} */
    onClose: (...[$event]) => {
        return (__VLS_ctx.showSettings = false);
        // @ts-ignore
        [showSettings, showSettings,];
    },
};
var __VLS_34;
var __VLS_35;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
