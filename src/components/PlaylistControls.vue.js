import { computed, ref, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useRundownStore } from '../stores/rundown';
const store = useRundownStore();
const isSaving = ref(false);
const isLoading = ref(false);
const statusMessage = ref('Ready');
const statusTone = ref('info');
const lastPlaylistDirectory = useStorage('playlist.lastDirectory', 'C:/Playlists');
const startFromDraft = ref('');
const weekdayOptions = [
    { value: 1, label: 'Mon' },
    { value: 2, label: 'Tue' },
    { value: 3, label: 'Wed' },
    { value: 4, label: 'Thu' },
    { value: 5, label: 'Fri' },
    { value: 6, label: 'Sat' },
    { value: 0, label: 'Sun' }
];
const suggestedName = computed(() => `${store.currentPlaylistName || 'rundown'}.plx`);
const playlistStateLabel = computed(() => (store.isCurrentPlaylistOnAir ? 'ON AIR' : 'OFFLINE'));
const totalStr = computed(() => {
    const total = store.totalDuration;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds}s`;
});
const weekdayProxy = computed({
    get: () => String(store.currentPlaylistStartWeekday),
    set: (value) => {
        const nextWeekday = Number.parseInt(value, 10);
        store.currentPlaylistStartWeekday = Number.isFinite(nextWeekday) ? nextWeekday : new Date().getDay();
        const weekdayLabel = weekdayOptions.find((option) => option.value === store.currentPlaylistStartWeekday)?.label || 'Day';
        setStatus(`Offline timing anchored to ${weekdayLabel}`);
    }
});
const setStatus = (message, tone = 'info') => {
    statusMessage.value = message;
    statusTone.value = tone;
};
watch(() => [store.activePlaylistId, store.currentPlaylistStartFrom], () => {
    startFromDraft.value = store.currentPlaylistStartFrom;
}, { immediate: true });
const commitStartFrom = () => {
    const previousValue = store.currentPlaylistStartFrom;
    store.currentPlaylistStartFrom = startFromDraft.value;
    startFromDraft.value = store.currentPlaylistStartFrom;
    if (!store.currentPlaylistStartFrom) {
        setStatus('Offline timing anchor cleared');
        return;
    }
    if (store.currentPlaylistStartFrom !== previousValue || startFromDraft.value !== previousValue) {
        setStatus(`Offline timing starts at ${store.currentPlaylistStartFrom}`);
    }
};
const joinDialogPath = (base, fileName) => {
    if (!base)
        return fileName;
    const separator = /[\\/]$/.test(base) ? '' : '/';
    return `${base}${separator}${fileName}`;
};
const ensurePlaylistExtension = (path) => (/\.(plx|playout|json)$/i.test(path) ? path : `${path}.plx`);
const parseLegacyPathList = (raw, fallbackName) => {
    const toFilename = (filepath) => {
        const normalized = filepath.replace(/\\/g, '/');
        return normalized.split('/').pop() || filepath;
    };
    const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => !!line && !line.startsWith('#') && !line.startsWith(';'));
    return {
        version: '1.1',
        name: fallbackName,
        created: Date.now(),
        items: lines.map((path) => ({
            type: 'video',
            path,
            shortPath: path,
            filename: toFilename(path),
            libraryIndicator: 'none',
            duration: 0,
            seek: 0,
            length: 0,
            inPoint: 0,
            outPoint: 0,
            plannedDuration: 0,
            note: '',
            complianceRating: 'none',
            complianceDescriptors: [],
            complianceText: ''
        }))
    };
};
const parsePlaylistPayload = (raw, path) => {
    try {
        return JSON.parse(raw);
    }
    catch {
        const fallbackName = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Imported';
        return parseLegacyPathList(raw, fallbackName);
    }
};
const savePlaylist = async (path) => {
    isSaving.value = true;
    try {
        const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || store.currentPlaylistName || 'Rundown';
        const data = store.serializeRundown(name);
        const json = JSON.stringify(data);
        await invoke('save_playlist', { path, json });
        lastPlaylistDirectory.value = path.replace(/[\\/][^\\/]+$/, '');
        setStatus(`Saved ${store.currentPlaylistName} to ${path}`);
    }
    catch (error) {
        setStatus(`Save failed: ${error}`, 'error');
    }
    finally {
        isSaving.value = false;
    }
};
const loadPlaylist = async (path, append = false) => {
    isLoading.value = true;
    try {
        const json = await invoke('load_playlist', { path });
        const data = parsePlaylistPayload(json, path);
        store.deserializeRundown(data, append);
        lastPlaylistDirectory.value = path.replace(/[\\/][^\\/]+$/, '');
        setStatus(`${append ? 'Appended' : 'Loaded'} playlist from ${path}`);
    }
    catch (error) {
        setStatus(`Load failed: ${error}`, 'error');
    }
    finally {
        isLoading.value = false;
    }
};
const clearRundown = () => {
    if (!store.activeItems.length) {
        setStatus('Playlist is already empty');
        return;
    }
    const confirmed = window.confirm(`Clear ${store.activeItems.length} item${store.activeItems.length === 1 ? '' : 's'} from ${store.currentPlaylistName}?`);
    if (!confirmed)
        return;
    store.clearRundown();
    setStatus(`Cleared ${store.currentPlaylistName}`);
};
const addGapLine = () => {
    if (!store.canScheduleCurrentPlaylist) {
        setStatus('Gap lines are only available on offline playlists.', 'error');
        return;
    }
    const suggested = store.currentPlaylistStartFrom || '16:00';
    const value = window.prompt('Insert gap line at time (HH:MM or HH:MM:SS)', suggested);
    if (!value)
        return;
    const inserted = store.addGapMarker(value);
    if (!inserted) {
        setStatus('Use a valid time like 16:45 or 16:45:00.', 'error');
        return;
    }
    setStatus(`Inserted gap line at ${value}`);
};
const pickPlaylistPath = async (action) => {
    if (action === 'save') {
        const selection = await save({
            title: 'Save Playlist',
            defaultPath: joinDialogPath(lastPlaylistDirectory.value, suggestedName.value),
            filters: [{ name: 'PlayOut Optimized Playlist', extensions: ['plx'] }]
        });
        if (!selection)
            return;
        await savePlaylist(ensurePlaylistExtension(selection));
        return;
    }
    const selection = await open({
        title: action === 'append' ? 'Append Playlist' : 'Load Playlist',
        multiple: false,
        defaultPath: lastPlaylistDirectory.value || undefined,
        filters: [{ name: 'PlayOut Playlists', extensions: ['plx', 'playout', 'json', 'txt', 'lst'] }]
    });
    if (!selection || Array.isArray(selection))
        return;
    await loadPlaylist(selection, action === 'append');
};
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['pl-status']} */ ;
/** @type {__VLS_StyleScopedClasses['pl-planning']} */ ;
/** @type {__VLS_StyleScopedClasses['pl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['pl-day-select']} */ ;
/** @type {__VLS_StyleScopedClasses['pl-time-input']} */ ;
/** @type {__VLS_StyleScopedClasses['pl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-danger']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "playlist-bar" },
});
/** @type {__VLS_StyleScopedClasses['playlist-bar']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "pl-info" },
});
/** @type {__VLS_StyleScopedClasses['pl-info']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "text-secondary" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
(__VLS_ctx.store.currentPlaylistName);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "text-secondary" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
(__VLS_ctx.playlistStateLabel);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "text-secondary" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
(__VLS_ctx.store.activeItems.length);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "text-secondary" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
(__VLS_ctx.totalStr);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "pl-status" },
    ...{ class: ({ 'is-error': __VLS_ctx.statusTone === 'error' }) },
});
/** @type {__VLS_StyleScopedClasses['pl-status']} */ ;
/** @type {__VLS_StyleScopedClasses['is-error']} */ ;
(__VLS_ctx.statusMessage);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "pl-planning" },
    ...{ class: ({ 'is-disabled': !__VLS_ctx.store.canScheduleCurrentPlaylist }) },
});
/** @type {__VLS_StyleScopedClasses['pl-planning']} */ ;
/** @type {__VLS_StyleScopedClasses['is-disabled']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
    value: (__VLS_ctx.weekdayProxy),
    ...{ class: "pl-day-select" },
    disabled: (!__VLS_ctx.store.canScheduleCurrentPlaylist),
    title: "Offline start day",
});
/** @type {__VLS_StyleScopedClasses['pl-day-select']} */ ;
for (const [option] of __VLS_vFor((__VLS_ctx.weekdayOptions))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
        key: (option.value),
        value: (String(option.value)),
    });
    (option.label);
    // @ts-ignore
    [store, store, store, store, playlistStateLabel, totalStr, statusTone, statusMessage, weekdayProxy, weekdayOptions,];
}
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
    ...{ class: "pl-label" },
});
/** @type {__VLS_StyleScopedClasses['pl-label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
    ...{ onBlur: (__VLS_ctx.commitStartFrom) },
    ...{ onKeydown: (__VLS_ctx.commitStartFrom) },
    value: (__VLS_ctx.startFromDraft),
    ...{ class: "pl-time-input" },
    type: "text",
    inputmode: "numeric",
    placeholder: "HH:MM[:SS]",
    maxlength: "8",
    disabled: (!__VLS_ctx.store.canScheduleCurrentPlaylist),
});
/** @type {__VLS_StyleScopedClasses['pl-time-input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.addGapLine) },
    ...{ class: "pl-btn" },
    disabled: (!__VLS_ctx.store.canScheduleCurrentPlaylist),
    title: "Insert offline gap line",
});
/** @type {__VLS_StyleScopedClasses['pl-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "pl-buttons" },
});
/** @type {__VLS_StyleScopedClasses['pl-buttons']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.pickPlaylistPath('save'));
            // @ts-ignore
            [store, store, commitStartFrom, commitStartFrom, startFromDraft, addGapLine, pickPlaylistPath,];
        } },
    ...{ class: "pl-btn" },
    disabled: (__VLS_ctx.isSaving),
    title: "Save Playlist",
});
/** @type {__VLS_StyleScopedClasses['pl-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.pickPlaylistPath('load'));
            // @ts-ignore
            [pickPlaylistPath, isSaving,];
        } },
    ...{ class: "pl-btn" },
    disabled: (__VLS_ctx.isLoading),
    title: "Load Playlist",
});
/** @type {__VLS_StyleScopedClasses['pl-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.pickPlaylistPath('append'));
            // @ts-ignore
            [pickPlaylistPath, isLoading,];
        } },
    ...{ class: "pl-btn" },
    disabled: (__VLS_ctx.isLoading),
    title: "Append Playlist",
});
/** @type {__VLS_StyleScopedClasses['pl-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.clearRundown) },
    ...{ class: "pl-btn btn-danger" },
    title: "Clear Rundown",
});
/** @type {__VLS_StyleScopedClasses['pl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-danger']} */ ;
// @ts-ignore
[isLoading, clearRundown,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
