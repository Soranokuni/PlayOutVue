import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRundownStore } from '../stores/rundown';
import { invoke } from '@tauri-apps/api/core';
const store = useRundownStore();
const props = defineProps();
const emit = defineEmits();
const activeItem = ref(null);
const item = computed(() => activeItem.value);
const panelRef = ref(null);
const lockTrimItem = () => {
    const source = props.libraryItem || store.selectedItem;
    activeItem.value = source ? {
        id: source.id,
        uuid: (props.libraryItem?.uuid) || (store.selectedItem?.playoutvueId) || source.id,
        path: source.path,
        filename: source.filename,
        type: source.type,
        duration: source.duration,
        inPoint: source.inPoint,
        outPoint: source.outPoint
    } : null;
};
// ── Video preview via local streaming server ──────────────────────────────────
// We get a stream URL from our Rust media_server (zero memory overhead)
const videoRef = ref(null);
const videoSrc = ref('');
const isVideoPlaying = ref(false);
const isGeneratingProxy = ref(false);
const previewError = ref('');
const previewMode = ref('source');
const proxyAttemptedPath = ref('');
let previewFallbackTimer = null;
const clearPreviewFallbackTimer = () => {
    if (!previewFallbackTimer)
        return;
    clearTimeout(previewFallbackTimer);
    previewFallbackTimer = null;
};
const loadProxyPreview = async (path, reason) => {
    if (!path || item.value?.type === 'live' || path.startsWith('http'))
        return;
    if (proxyAttemptedPath.value === path)
        return;
    proxyAttemptedPath.value = path;
    previewMode.value = 'proxy';
    isGeneratingProxy.value = true;
    previewError.value = '';
    videoSrc.value = '';
    clearPreviewFallbackTimer();
    try {
        videoSrc.value = await invoke('get_media_preview_url', { inputPath: path });
    }
    catch (error) {
        previewError.value = `Preview proxy failed: ${error}`;
    }
    finally {
        isGeneratingProxy.value = false;
    }
};
const loadVideoSrc = async (path) => {
    clearPreviewFallbackTimer();
    videoSrc.value = '';
    previewError.value = '';
    isGeneratingProxy.value = false;
    previewMode.value = 'source';
    proxyAttemptedPath.value = '';
    if (!path || item.value?.type === 'live' || path.startsWith('http'))
        return;
    try {
        videoSrc.value = await invoke('get_media_url', { path });
        previewFallbackTimer = setTimeout(() => {
            loadProxyPreview(path, 'metadata timeout').catch(() => { });
        }, 2500);
    }
    catch (e) {
        console.warn('[TrimPanel] failed to get streaming URL:', e);
        await loadProxyPreview(path, 'source url failure');
    }
};
// ── State ────────────────────────────────────────────────────────────────────
const inMs = ref(0);
const outMs = ref(0);
const totalDurationMs = ref(0);
const isProbing = ref(false);
const isTrimming = ref(false);
const isSmartTrimming = ref(false);
const trimStatus = ref('');
const speed = ref(0); // for JKL display badge
const FRAME_MS = 40; // 25fps
const PLAYHEAD_UI_INTERVAL_MS = 120;
const clampMs = (ms) => Math.max(0, Math.min(ms, totalDurationMs.value || ms));
const isLocalFilePath = (path) => !!path && !/^https?:/i.test(path);
// ── Seek video ────────────────────────────────────────────────────────────────
const timelineRef = ref(null);
const playheadRef = ref(null);
const playbackTime = ref(0);
const draggingTimelineItem = ref(null);
let pendingSeekMs = null;
let seekAnimationFrame = 0;
let lastPlaybackUiUpdateAt = 0;
let lastKnownPlaybackMs = 0;
const updatePlayheadPosition = (ms) => {
    const clamped = clampMs(ms);
    lastKnownPlaybackMs = clamped;
    if (playheadRef.value) {
        const left = totalDurationMs.value > 0 ? (clamped / totalDurationMs.value) * 100 : 0;
        playheadRef.value.style.left = `${left}%`;
    }
};
const syncPlaybackDisplay = (ms, forceReactive = false) => {
    const clamped = clampMs(ms);
    updatePlayheadPosition(clamped);
    const now = performance.now();
    if (forceReactive || now - lastPlaybackUiUpdateAt >= PLAYHEAD_UI_INTERVAL_MS) {
        playbackTime.value = clamped;
        lastPlaybackUiUpdateAt = now;
    }
};
const flushPendingSeek = () => {
    seekAnimationFrame = 0;
    const v = videoRef.value;
    if (!v || pendingSeekMs == null)
        return;
    const clamped = clampMs(pendingSeekMs);
    pendingSeekMs = null;
    v.currentTime = clamped / 1000;
    syncPlaybackDisplay(clamped, true);
};
const queueSeek = (ms, forceReactive = false) => {
    const clamped = clampMs(ms);
    syncPlaybackDisplay(clamped, forceReactive);
    pendingSeekMs = clamped;
    if (!seekAnimationFrame) {
        seekAnimationFrame = requestAnimationFrame(flushPendingSeek);
    }
};
const seekTo = (ms, forceReactive = true) => {
    queueSeek(ms, forceReactive);
};
const syncPlaybackState = () => {
    isVideoPlaying.value = !!videoRef.value && !videoRef.value.paused && !videoRef.value.ended;
};
const togglePlayback = async () => {
    const v = videoRef.value;
    if (!v)
        return;
    if (v.paused) {
        speed.value = 1;
        v.playbackRate = 1;
        await v.play().catch(() => { });
    }
    else {
        speed.value = 0;
        v.pause();
    }
    syncPlaybackState();
};
// ── Timeline Scrubbing state ──────────────────────────────────────────────────
const onTimeUpdate = () => {
    if (videoRef.value) {
        const currentMs = videoRef.value.currentTime * 1000;
        if (outMs.value > inMs.value && currentMs > outMs.value) {
            seekTo(outMs.value);
            videoRef.value.pause();
            syncPlaybackDisplay(outMs.value, true);
        }
        else {
            syncPlaybackDisplay(currentMs);
        }
        syncPlaybackState();
    }
};
const getMsFromEvent = (e) => {
    if (!timelineRef.value || totalDurationMs.value <= 0)
        return 0;
    const rect = timelineRef.value.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const percentage = x / rect.width;
    return Math.round(percentage * totalDurationMs.value);
};
const onTimelineMouseDown = (e, target) => {
    draggingTimelineItem.value = target;
    handleTimelineDrag(e);
};
const handleTimelineDrag = (e) => {
    if (!draggingTimelineItem.value)
        return;
    const ms = getMsFromEvent(e);
    if (draggingTimelineItem.value === 'in') {
        inMs.value = Math.min(ms, outMs.value);
        queueSeek(inMs.value);
    }
    else if (draggingTimelineItem.value === 'out') {
        outMs.value = Math.max(ms, inMs.value);
        queueSeek(outMs.value);
    }
    else if (draggingTimelineItem.value === 'playhead') {
        queueSeek(ms);
    }
};
const onWindowMouseMove = (e) => {
    if (draggingTimelineItem.value)
        handleTimelineDrag(e);
};
const onWindowMouseUp = () => {
    if (pendingSeekMs != null) {
        syncPlaybackDisplay(pendingSeekMs, true);
        flushPendingSeek();
    }
    draggingTimelineItem.value = null;
};
// ── Duration from <video> metadata ────────────────────────────────────────────
const onVideoLoaded = () => {
    clearPreviewFallbackTimer();
    const v = videoRef.value;
    if (!v || isNaN(v.duration))
        return;
    if (!Number.isFinite(v.duration) || v.videoWidth <= 0) {
        loadProxyPreview(item.value?.path, 'undecodable source').catch(() => { });
        return;
    }
    const dur = v.duration * 1000;
    if (dur > 0) {
        totalDurationMs.value = dur;
        if (outMs.value === 0 || outMs.value > dur)
            outMs.value = dur;
        syncPlaybackDisplay(inMs.value || 0, true);
    }
};
const onVideoError = () => {
    if (previewMode.value === 'proxy') {
        previewError.value = 'Preview is not available for this file in the embedded player.';
        return;
    }
    loadProxyPreview(item.value?.path, 'video decode error').catch(() => { });
};
// ── Probe via ffprobe (fallback for formats browser can't decode) ─────────────
const probeDuration = async () => {
    if (!item.value?.path || item.value.type === 'live')
        return;
    isProbing.value = true;
    try {
        const meta = await invoke('scan_media', { filepath: item.value.path });
        const dur = parseFloat(meta.duration) * 1000;
        if (dur > 0 && totalDurationMs.value === 0) {
            totalDurationMs.value = dur;
            if (outMs.value === 0)
                outMs.value = dur;
            syncPlaybackDisplay(inMs.value || 0, true);
        }
    }
    catch { }
    finally {
        isProbing.value = false;
    }
};
// ── Hydrate when panel opens ──────────────────────────────────────────────────
watch(() => props.isOpen, (open) => {
    if (open) {
        lockTrimItem();
    }
    else {
        activeItem.value = null;
    }
}, { immediate: true });
watch([item, () => props.isOpen], ([val, open]) => {
    if (val && open) {
        inMs.value = val.inPoint || 0;
        outMs.value = val.outPoint || (val.duration && val.duration > 0 ? val.duration * 1000 : 0);
        totalDurationMs.value = val.duration && val.duration > 0 ? val.duration * 1000 : 0;
        trimStatus.value = '';
        speed.value = 0;
        isVideoPlaying.value = false;
        pendingSeekMs = null;
        nextTick(() => {
            syncPlaybackDisplay(inMs.value, true);
            panelRef.value?.focus();
        });
        loadVideoSrc(val.path);
        probeDuration();
    }
    if (!open) {
        clearPreviewFallbackTimer();
        if (videoRef.value)
            videoRef.value.pause();
        videoSrc.value = '';
    }
}, { immediate: true });
// ── Timecodes ─────────────────────────────────────────────────────────────────
const msToTC = (ms) => {
    if (!Number.isFinite(ms))
        return '00:00:00:00';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const f = Math.floor((ms % 1000) / 40);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
};
const tcToMs = (tc) => {
    const p = tc.split(':').map(Number);
    if (p.length < 3 || p.slice(0, p.length).some(isNaN))
        return -1;
    const [h = 0, m = 0, s = 0, f = 0] = p;
    if (p.length === 4)
        return (h * 3600 + m * 60 + s) * 1000 + f * 40;
    return (h * 3600 + m * 60 + s) * 1000;
};
const applyInTC = (e) => { const v = tcToMs(e.target.value); if (v >= 0) {
    inMs.value = v;
    seekTo(v);
} };
const applyOutTC = (e) => { const v = tcToMs(e.target.value); if (v >= 0)
    outMs.value = v; };
const trimmedDuration = computed(() => {
    const d = outMs.value - inMs.value;
    return d > 0 ? `${(d / 1000).toFixed(1)}s  (${msToTC(d)})` : '–';
});
const currentTimecode = computed(() => msToTC(playbackTime.value));
const setInPoint = (ms = Math.round(currentVideoMs())) => {
    inMs.value = clampMs(ms);
    if (inMs.value > outMs.value)
        outMs.value = inMs.value;
    trimStatus.value = `IN: ${msToTC(inMs.value)}`;
};
const setOutPoint = (ms = Math.round(currentVideoMs())) => {
    outMs.value = clampMs(ms);
    if (outMs.value < inMs.value)
        inMs.value = outMs.value;
    trimStatus.value = `OUT: ${msToTC(outMs.value)}`;
};
const jumpToMarker = (marker) => {
    if (marker === 'start')
        return seekTo(0);
    if (marker === 'in')
        return seekTo(inMs.value);
    if (marker === 'out')
        return seekTo(outMs.value);
    seekTo(totalDurationMs.value);
};
// ── Keyboard shortcuts ────────────────────────────────────────────────────────
const currentVideoMs = () => lastKnownPlaybackMs || ((videoRef.value?.currentTime ?? 0) * 1000);
const nudge = (frames) => {
    seekTo(currentVideoMs() + frames * FRAME_MS);
};
const applySpeed = (s) => {
    const v = videoRef.value;
    if (!v)
        return;
    speed.value = s;
    if (s === 0) {
        v.pause();
        syncPlaybackState();
        return;
    }
    v.playbackRate = Math.abs(s) === 2 ? 4 : 1;
    if (s > 0)
        v.play().catch(() => { });
    else
        v.pause();
    syncPlaybackState();
};
const handleKey = (e) => {
    if (!props.isOpen)
        return;
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea')
        return;
    if (e.ctrlKey && e.key.toLowerCase() === 's' && !props.libraryItem) {
        e.preventDefault();
        saveNonDestructive();
        return;
    }
    switch (e.key) {
        case ' ':
            e.preventDefault();
            togglePlayback();
            return;
        case 'Home':
            e.preventDefault();
            jumpToMarker('start');
            return;
        case 'End':
            e.preventDefault();
            jumpToMarker('end');
            return;
        case '[':
            e.preventDefault();
            setInPoint();
            return;
        case ']':
            e.preventDefault();
            setOutPoint();
            return;
        case ',':
            e.preventDefault();
            nudge(-1);
            return;
        case '.':
            e.preventDefault();
            nudge(1);
            return;
        case 'PageUp':
            e.preventDefault();
            nudge(-25);
            return;
        case 'PageDown':
            e.preventDefault();
            nudge(25);
            return;
        case 'ArrowLeft':
            e.preventDefault();
            nudge(e.shiftKey ? -10 : -1);
            return;
        case 'ArrowRight':
            e.preventDefault();
            nudge(e.shiftKey ? 10 : 1);
            return;
        case 'Escape':
            e.preventDefault();
            emit('close');
            return;
    }
    switch (e.key.toLowerCase()) {
        case 'j':
            e.preventDefault();
            applySpeed(speed.value === -2 ? 0 : (speed.value === 0 ? -1 : -2));
            break;
        case 'k':
            e.preventDefault();
            applySpeed(0);
            break;
        case 'l':
            e.preventDefault();
            applySpeed(speed.value === 2 ? 0 : (speed.value === 0 ? 1 : 2));
            break;
        case 'i':
            e.preventDefault();
            setInPoint();
            break;
        case 'o':
            e.preventDefault();
            setOutPoint();
            break;
    }
};
onMounted(() => {
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
});
onUnmounted(() => {
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
    clearPreviewFallbackTimer();
    if (seekAnimationFrame)
        cancelAnimationFrame(seekAnimationFrame);
});
// ── Save / Trim ───────────────────────────────────────────────────────────────
const saveNonDestructive = () => {
    if (!item.value)
        return;
    if (outMs.value > 0 && outMs.value <= inMs.value) {
        trimStatus.value = '❌ OUT point must be greater than IN point.';
        return;
    }
    const saveTask = async () => {
        if (item.value?.id) {
            store.updateItem(item.value.id, {
                inPoint: inMs.value,
                outPoint: outMs.value,
                trim_in_ms: inMs.value,
                trim_out_ms: outMs.value
            });
        }
        if (item.value?.uuid && !item.value.uuid.startsWith('local:')) {
            await invoke('update_ingestor_trim', {
                uuid: item.value.uuid,
                trim_in_ms: Math.round(inMs.value),
                trim_out_ms: Math.round(outMs.value),
                api_base_url_override: null
            });
        }
        else if (isLocalFilePath(item.value?.path)) {
            await invoke('save_media_trim_profile', {
                path: item.value.path,
                inMs: Math.round(inMs.value),
                outMs: Math.round(outMs.value)
            });
        }
        trimStatus.value = '✅ Trim saved.';
        if (item.value?.path) {
            emit('saved', { uuid: item.value.uuid, outputPath: item.value.path });
        }
        setTimeout(() => emit('close'), 600);
    };
    saveTask().catch((error) => {
        trimStatus.value = `❌ ${error}`;
    });
};
const saveAsSubclip = () => {
    const currentItem = item.value;
    if (!currentItem)
        return;
    if (outMs.value > 0 && outMs.value <= inMs.value) {
        trimStatus.value = '❌ OUT point must be greater than IN point.';
        return;
    }
    const defaultName = `${currentItem.filename} (Sub-clip)`;
    const newName = window.prompt("Enter a name for the new virtual sub-clip:", defaultName);
    if (newName === null) {
        return;
    }
    const trimmedName = newName.trim();
    if (!trimmedName) {
        trimStatus.value = '❌ Display name must not be empty.';
        return;
    }
    if (currentItem.uuid && !currentItem.uuid.startsWith('local:')) {
        const saveTask = async () => {
            trimStatus.value = 'Creating virtual sub-clip...';
            const response = await invoke('create_ingestor_subclip', {
                uuid: currentItem.uuid,
                display_name: trimmedName,
                trim_in_ms: Math.round(inMs.value),
                trim_out_ms: Math.round(outMs.value),
                api_base_url_override: null
            });
            trimStatus.value = '✅ Virtual sub-clip created successfully!';
            emit('saved', { uuid: response.uuid, outputPath: response.current_path });
            setTimeout(() => emit('close'), 1000);
        };
        saveTask().catch((error) => {
            trimStatus.value = `❌ Failed to create sub-clip: ${error}`;
        });
    }
    else {
        trimStatus.value = '❌ Sub-clipping is only supported for server-side managed assets.';
    }
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
/** @type {__VLS_StyleScopedClasses['shortcut-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-card']} */ ;
/** @type {__VLS_StyleScopedClasses['tm-playhead']} */ ;
/** @type {__VLS_StyleScopedClasses['tc-input']} */ ;
/** @type {__VLS_StyleScopedClasses['trim-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['trim-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['trim-body']} */ ;
/** @type {__VLS_StyleScopedClasses['trim-metrics']} */ ;
/** @type {__VLS_StyleScopedClasses['tc-grid']} */ ;
if (__VLS_ctx.isOpen && __VLS_ctx.item) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.$emit('close'));
                // @ts-ignore
                [isOpen, item, $emit,];
            } },
        ...{ onKeydown: (__VLS_ctx.handleKey) },
        ref: "panelRef",
        ...{ class: "modal-backdrop" },
        tabindex: "0",
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['modal-backdrop']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "glass-panel trim-panel" },
    });
    /** @type {__VLS_StyleScopedClasses['glass-panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['trim-panel']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "trim-header" },
    });
    /** @type {__VLS_StyleScopedClasses['trim-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "text-accent" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['text-accent']} */ ;
    (__VLS_ctx.item.filename);
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "text-secondary" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    (__VLS_ctx.isProbing ? '⌛' : (__VLS_ctx.totalDurationMs ? (__VLS_ctx.totalDurationMs / 1000).toFixed(2) + 's' : 'type timecodes'));
    __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({
        ...{ style: {} },
    });
    (__VLS_ctx.trimmedDuration);
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "shortcut-hint" },
    });
    /** @type {__VLS_StyleScopedClasses['shortcut-hint']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.$emit('close'));
                // @ts-ignore
                [item, $emit, handleKey, isProbing, totalDurationMs, totalDurationMs, trimmedDuration,];
            } },
        ...{ class: "icon-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "trim-body" },
    });
    /** @type {__VLS_StyleScopedClasses['trim-body']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "video-col" },
    });
    /** @type {__VLS_StyleScopedClasses['video-col']} */ ;
    if (__VLS_ctx.videoSrc) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.video, __VLS_intrinsics.video)({
            ...{ onLoadedmetadata: (__VLS_ctx.onVideoLoaded) },
            ...{ onError: (__VLS_ctx.onVideoError) },
            ...{ onTimeupdate: (__VLS_ctx.onTimeUpdate) },
            ...{ onPlay: (__VLS_ctx.syncPlaybackState) },
            ...{ onPause: (__VLS_ctx.syncPlaybackState) },
            ref: "videoRef",
            src: (__VLS_ctx.videoSrc),
            ...{ class: "trim-video" },
            muted: true,
            preload: "metadata",
        });
        /** @type {__VLS_StyleScopedClasses['trim-video']} */ ;
    }
    else if (__VLS_ctx.item.type === 'live' || __VLS_ctx.item.path?.startsWith('http')) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "video-placeholder" },
        });
        /** @type {__VLS_StyleScopedClasses['video-placeholder']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ style: {} },
        });
        (__VLS_ctx.item.type === 'live' ? '📹' : '🌐');
        __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
            ...{ class: "text-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    }
    else if (__VLS_ctx.isGeneratingProxy) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "video-placeholder" },
        });
        /** @type {__VLS_StyleScopedClasses['video-placeholder']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ style: {} },
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
            ...{ class: "text-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    }
    else if (__VLS_ctx.previewError) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "video-placeholder" },
        });
        /** @type {__VLS_StyleScopedClasses['video-placeholder']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ style: {} },
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
            ...{ class: "text-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        (__VLS_ctx.previewError);
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "video-placeholder" },
        });
        /** @type {__VLS_StyleScopedClasses['video-placeholder']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ style: {} },
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
            ...{ class: "text-secondary" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    }
    if (__VLS_ctx.speed !== 0) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "speed-badge" },
        });
        /** @type {__VLS_StyleScopedClasses['speed-badge']} */ ;
        (__VLS_ctx.speed < 0 ? '◀◀' : '▶▶');
        (Math.abs(__VLS_ctx.speed) === 2 ? '×4' : '×1');
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "transport-bar" },
    });
    /** @type {__VLS_StyleScopedClasses['transport-bar']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.jumpToMarker('start'));
                // @ts-ignore
                [item, item, item, videoSrc, videoSrc, onVideoLoaded, onVideoError, onTimeUpdate, syncPlaybackState, syncPlaybackState, isGeneratingProxy, previewError, previewError, speed, speed, speed, jumpToMarker,];
            } },
        ...{ class: "transport-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['transport-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.nudge(-10));
                // @ts-ignore
                [nudge,];
            } },
        ...{ class: "transport-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['transport-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.nudge(-1));
                // @ts-ignore
                [nudge,];
            } },
        ...{ class: "transport-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['transport-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.togglePlayback) },
        ...{ class: "transport-btn transport-btn-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['transport-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['transport-btn-primary']} */ ;
    (__VLS_ctx.isVideoPlaying ? '⏸ Pause' : '▶ Play');
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.nudge(1));
                // @ts-ignore
                [nudge, togglePlayback, isVideoPlaying,];
            } },
        ...{ class: "transport-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['transport-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.nudge(10));
                // @ts-ignore
                [nudge,];
            } },
        ...{ class: "transport-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['transport-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.jumpToMarker('end'));
                // @ts-ignore
                [jumpToMarker,];
            } },
        ...{ class: "transport-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['transport-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ctrl-col" },
    });
    /** @type {__VLS_StyleScopedClasses['ctrl-col']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "trim-metrics" },
    });
    /** @type {__VLS_StyleScopedClasses['trim-metrics']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "metric-card" },
    });
    /** @type {__VLS_StyleScopedClasses['metric-card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "metric-label" },
    });
    /** @type {__VLS_StyleScopedClasses['metric-label']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
    (__VLS_ctx.currentTimecode);
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "metric-card" },
    });
    /** @type {__VLS_StyleScopedClasses['metric-card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "metric-label" },
    });
    /** @type {__VLS_StyleScopedClasses['metric-label']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
    (__VLS_ctx.trimmedDuration);
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "scrub-area" },
    });
    /** @type {__VLS_StyleScopedClasses['scrub-area']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onMousedown: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.onTimelineMouseDown($event, 'playhead'));
                // @ts-ignore
                [trimmedDuration, currentTimecode, onTimelineMouseDown,];
            } },
        ...{ class: "unified-timeline" },
        ref: "timelineRef",
    });
    /** @type {__VLS_StyleScopedClasses['unified-timeline']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tm-bg" },
    });
    /** @type {__VLS_StyleScopedClasses['tm-bg']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tm-range" },
        ...{ style: ({
                left: __VLS_ctx.totalDurationMs ? (__VLS_ctx.inMs / __VLS_ctx.totalDurationMs * 100) + '%' : '0%',
                width: __VLS_ctx.totalDurationMs ? Math.max(0, (__VLS_ctx.outMs - __VLS_ctx.inMs) / __VLS_ctx.totalDurationMs * 100) + '%' : '100%'
            }) },
    });
    /** @type {__VLS_StyleScopedClasses['tm-range']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tm-handle-wrapper" },
        ...{ style: ({ left: __VLS_ctx.totalDurationMs ? (__VLS_ctx.inMs / __VLS_ctx.totalDurationMs * 100) + '%' : '0%' }) },
    });
    /** @type {__VLS_StyleScopedClasses['tm-handle-wrapper']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onMousedown: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.onTimelineMouseDown($event, 'in'));
                // @ts-ignore
                [totalDurationMs, totalDurationMs, totalDurationMs, totalDurationMs, totalDurationMs, totalDurationMs, onTimelineMouseDown, inMs, inMs, inMs, outMs,];
            } },
        ...{ class: "tm-handle tm-handle-in" },
    });
    /** @type {__VLS_StyleScopedClasses['tm-handle']} */ ;
    /** @type {__VLS_StyleScopedClasses['tm-handle-in']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tm-handle-wrapper" },
        ...{ style: ({ left: __VLS_ctx.totalDurationMs ? (__VLS_ctx.outMs / __VLS_ctx.totalDurationMs * 100) + '%' : '100%' }) },
    });
    /** @type {__VLS_StyleScopedClasses['tm-handle-wrapper']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onMousedown: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.onTimelineMouseDown($event, 'out'));
                // @ts-ignore
                [totalDurationMs, totalDurationMs, onTimelineMouseDown, outMs,];
            } },
        ...{ class: "tm-handle tm-handle-out" },
    });
    /** @type {__VLS_StyleScopedClasses['tm-handle']} */ ;
    /** @type {__VLS_StyleScopedClasses['tm-handle-out']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onMousedown: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.onTimelineMouseDown($event, 'playhead'));
                // @ts-ignore
                [onTimelineMouseDown,];
            } },
        ref: "playheadRef",
        ...{ class: "tm-playhead" },
    });
    /** @type {__VLS_StyleScopedClasses['tm-playhead']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tm-playhead-line" },
    });
    /** @type {__VLS_StyleScopedClasses['tm-playhead-line']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ style: {} },
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "text-secondary" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "text-secondary" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    (__VLS_ctx.msToTC(__VLS_ctx.totalDurationMs));
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tc-grid" },
    });
    /** @type {__VLS_StyleScopedClasses['tc-grid']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tc-group" },
    });
    /** @type {__VLS_StyleScopedClasses['tc-group']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "text-secondary" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
        ...{ onChange: (__VLS_ctx.applyInTC) },
        ...{ class: "tc-input" },
        value: (__VLS_ctx.msToTC(__VLS_ctx.inMs)),
        placeholder: "00:00:00:00",
        spellcheck: "false",
    });
    /** @type {__VLS_StyleScopedClasses['tc-input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tc-actions" },
    });
    /** @type {__VLS_StyleScopedClasses['tc-actions']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.jumpToMarker('in'));
                // @ts-ignore
                [totalDurationMs, jumpToMarker, inMs, msToTC, msToTC, applyInTC,];
            } },
        ...{ class: "mini-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['mini-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.setInPoint());
                // @ts-ignore
                [setInPoint,];
            } },
        ...{ class: "mini-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['mini-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tc-group" },
    });
    /** @type {__VLS_StyleScopedClasses['tc-group']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "text-secondary" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
        ...{ onChange: (__VLS_ctx.applyOutTC) },
        ...{ class: "tc-input" },
        value: (__VLS_ctx.msToTC(__VLS_ctx.outMs)),
        placeholder: "00:00:00:00",
        spellcheck: "false",
    });
    /** @type {__VLS_StyleScopedClasses['tc-input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tc-actions" },
    });
    /** @type {__VLS_StyleScopedClasses['tc-actions']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.jumpToMarker('out'));
                // @ts-ignore
                [jumpToMarker, outMs, msToTC, applyOutTC,];
            } },
        ...{ class: "mini-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['mini-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.setOutPoint());
                // @ts-ignore
                [setOutPoint,];
            } },
        ...{ class: "mini-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['mini-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "trim-actions" },
    });
    /** @type {__VLS_StyleScopedClasses['trim-actions']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.saveNonDestructive) },
        ...{ class: "trim-btn btn-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['trim-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    if (__VLS_ctx.item && __VLS_ctx.item.uuid && !__VLS_ctx.item.uuid.startsWith('local:')) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.saveAsSubclip) },
            ...{ class: "trim-btn btn-accurate" },
        });
        /** @type {__VLS_StyleScopedClasses['trim-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-accurate']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen && __VLS_ctx.item))
                    throw 0;
                return (__VLS_ctx.$emit('close'));
                // @ts-ignore
                [item, item, item, $emit, saveNonDestructive, saveAsSubclip,];
            } },
        ...{ class: "trim-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['trim-btn']} */ ;
    if (__VLS_ctx.trimStatus) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "trim-status" },
        });
        /** @type {__VLS_StyleScopedClasses['trim-status']} */ ;
        (__VLS_ctx.trimStatus);
    }
}
// @ts-ignore
[trimStatus, trimStatus,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
