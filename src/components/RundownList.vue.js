import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import Sortable from 'sortablejs';
import { useRundownStore } from '../stores/rundown';
import { draggingItem } from '../composables/useDragState';
import { currentPlayoutMs, currentTotalPlayoutMs, getActivePlayoutService, isPlayoutPlaying, registerPlayoutAdvanceListener } from '../services/playout';
import LiveEntryDialog from './LiveEntryDialog.vue';
import PlaylistControls from './PlaylistControls.vue';
import ContextMenu from './ContextMenu.vue';
import { useSettingsStore } from '../stores/settings';
import { toggleCrawlTicker, updateCrawlTickerText } from '../services/caspar';
const store = useRundownStore();
const settings = useSettingsStore();
const rundownListRef = ref(null);
const isDragOver = ref(false);
const showLiveDialog = ref(false);
const dropTargetIndex = ref(null);
const dropTargetSide = ref('before');
const SELECTION_REPEAT_INTERVAL_MS = 85;
let sortableInstance = null;
const durationHydrationInFlight = new Set();
let lastSelectionMoveAt = 0;
const contextMenu = ref({
    show: false,
    x: 0,
    y: 0,
    index: -1,
    item: null
});
const ratingOptions = [
    { id: 'none', label: 'None' },
    { id: 'k', label: 'K' },
    { id: '8', label: '8+' },
    { id: '12', label: '12+' },
    { id: '16', label: '16+' },
    { id: '18', label: '18+' }
];
const indicatorOptions = [
    { id: 'none', label: 'None' },
    { id: 'spot', label: 'Spot' },
    { id: 'telemarketing', label: 'Telemarketing' }
];
const clockNow = ref(Date.now());
let clockTick = null;
const tickClock = () => {
    clockNow.value = Date.now();
};
onMounted(() => {
    clockTick = setInterval(tickClock, 1000);
});
onUnmounted(() => {
    if (clockTick)
        clearInterval(clockTick);
});
const clockStr = computed(() => {
    const date = new Date(clockNow.value);
    return date.toLocaleTimeString('el-GR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
});
const weekdayLabel = (epochMs) => new Date(epochMs).toLocaleDateString('en-GB', { weekday: 'short' }).toLowerCase();
const applyWeekdayAnchor = (epochMs, weekday) => {
    const anchored = new Date(epochMs);
    anchored.setDate(anchored.getDate() - anchored.getDay() + weekday);
    return anchored.getTime();
};
const parseClockAnchor = (timeText, fallbackMs) => {
    const parts = timeText.split(':').map((part) => Number.parseInt(part, 10));
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => Number.isNaN(part))) {
        return fallbackMs;
    }
    const anchor = new Date(fallbackMs);
    anchor.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
    return anchor.getTime();
};
const formatClockTime = (epochMs) => new Date(epochMs).toLocaleTimeString('el-GR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
});
const itemDurationMs = (item) => {
    if (item.type === 'gap')
        return 0;
    if (item.type === 'live')
        return (item.plannedDuration || item.duration || 0) * 1000;
    const totalMs = item.duration_ms || (item.duration ? item.duration * 1000 : 0);
    const inMs = item.trim_in_ms ?? item.inPoint ?? 0;
    const outMs = item.trim_out_ms ?? (item.outPoint > 0 ? item.outPoint : totalMs);
    if (outMs > inMs && inMs >= 0)
        return outMs - inMs;
    return totalMs;
};
const effectiveDurationMs = (item, index) => {
    if (index === store.currentPlayingIndex && currentTotalPlayoutMs.value > 0) {
        return currentTotalPlayoutMs.value;
    }
    return itemDurationMs(item);
};
const currentRemainingMs = computed(() => {
    if (!store.isCurrentPlaylistOnAir || store.currentPlayingIndex < 0)
        return 0;
    const currentItem = store.activeItems[store.currentPlayingIndex];
    if (!currentItem)
        return 0;
    const totalMs = effectiveDurationMs(currentItem, store.currentPlayingIndex);
    if (totalMs <= 0)
        return 0;
    return Math.max(0, totalMs - currentPlayoutMs.value);
});
const nextPlayableVisibleIndex = computed(() => {
    if (!store.isCurrentPlaylistOnAir || store.currentPlayingIndex < 0)
        return -1;
    for (let index = store.currentPlayingIndex + 1; index < store.activeItems.length; index += 1) {
        if (store.activeItems[index]?.type !== 'gap') {
            return index;
        }
    }
    return -1;
});
const isNextUpRow = (index) => index === nextPlayableVisibleIndex.value;
const isNextUpImminent = (index) => isNextUpRow(index) && currentRemainingMs.value > 0 && currentRemainingMs.value <= 10_000;
const scheduledTimes = computed(() => {
    return store.activeItemsETAs.map(eta => ({
        kind: eta.kind,
        text: eta.kind === 'gap' ? eta.label : eta.formatted,
        dayLabel: eta.dayLabel
    }));
});
const calcProgress = (item, index) => {
    if (index !== store.currentPlayingIndex)
        return 0;
    const duration = effectiveDurationMs(item, index);
    if (!duration || duration <= 0)
        return 0;
    const progress = (currentPlayoutMs.value / duration) * 100;
    return Math.max(0, Math.min(100, Math.round(progress * 100) / 100));
};
const hydrateMissingDurations = async () => {
    const candidates = store.activeItems.filter((item) => item.type === 'video'
        && item.path
        && !/^https?:/i.test(item.path)
        && !(item.outPoint > item.inPoint)
        && !(item.duration > 0)
        && !durationHydrationInFlight.has(item.id));
    await Promise.all(candidates.map(async (item) => {
        durationHydrationInFlight.add(item.id);
        try {
            const metadata = await invoke('scan_media', { filepath: item.path });
            const seconds = Number.parseFloat(metadata.duration || '0');
            if (Number.isFinite(seconds) && seconds > 0) {
                store.updateItem(item.id, {
                    duration: seconds,
                    plannedDuration: item.plannedDuration || seconds
                });
            }
        }
        catch (error) {
            console.warn('[Rundown] Failed to hydrate item duration', item.path, error);
        }
        finally {
            durationHydrationInFlight.delete(item.id);
        }
    }));
};
const hydrateSingleItemDuration = async (itemId, filePath) => {
    if (!itemId || !filePath || /^https?:/i.test(filePath))
        return;
    if (durationHydrationInFlight.has(itemId))
        return;
    durationHydrationInFlight.add(itemId);
    try {
        const metadata = await invoke('scan_media', { filepath: filePath });
        const seconds = Number.parseFloat(metadata.duration || '0');
        if (Number.isFinite(seconds) && seconds > 0) {
            store.updateItem(itemId, {
                duration: seconds,
                plannedDuration: seconds
            });
        }
    }
    catch (error) {
        console.warn('[Rundown] Failed to hydrate dropped item duration', filePath, error);
    }
    finally {
        durationHydrationInFlight.delete(itemId);
    }
};
registerPlayoutAdvanceListener((uuid) => {
    store.setOnAirPlayingItemById(uuid);
    if (store.isCurrentPlaylistOnAir && store.currentPlayingIndex >= 0) {
        store.selectedItemId = store.activeItems[store.currentPlayingIndex]?.id || store.selectedItemId;
    }
});
const runPlaylistFrom = async (index) => {
    const payload = store.buildPlaybackPayload(index);
    if (!payload)
        return;
    const service = getActivePlayoutService();
    try {
        if (isPlayoutPlaying.value && store.onAirPlaylistId && store.onAirPlaylistId !== payload.playlistId) {
            await service.stop();
            store.clearOnAirState();
        }
        store.setPlaylistOnAir(payload.playlistId, payload.startVisibleIndex);
        store.selectedItemId = store.activeItems[payload.startVisibleIndex]?.id || null;
        await service.play(payload.items, payload.startIndex);
    }
    catch (error) {
        store.clearOnAirState();
        console.error('[Playback] Failed to start playlist', error);
    }
};
const itemsFingerprint = computed(() => store.activeItems.map((item) => `${item.id}:${item.type}:${item.path}:${item.inPoint}:${item.outPoint}:${item.duration}:${item.plannedDuration}`).join('|'));
watch(itemsFingerprint, () => {
    if (isPlayoutPlaying.value && store.isCurrentPlaylistOnAir) {
        getActivePlayoutService().refreshQueue?.(store.getPlayableItems()).catch((error) => {
            console.error('[Playback] Failed to refresh rundown queue', error);
        });
    }
    hydrateMissingDurations().catch((error) => {
        console.warn('[Rundown] Duration hydration failed', error);
    });
}, { immediate: true });
watch(() => settings.cgCrawlText, () => {
    if (settings.cgCrawlActive) {
        updateCrawlTickerText().catch((err) => {
            console.error('[RundownList] Failed to update crawl text:', err);
        });
    }
});
watch(() => `${store.currentPlayingIndex}:${currentTotalPlayoutMs.value}:${store.isCurrentPlaylistOnAir}`, () => {
    const index = store.currentPlayingIndex;
    if (!store.isCurrentPlaylistOnAir || index < 0 || currentTotalPlayoutMs.value <= 0)
        return;
    const item = store.activeItems[index];
    if (!item || item.type !== 'video' || item.outPoint > item.inPoint || item.duration > 0)
        return;
    const seconds = currentTotalPlayoutMs.value / 1000;
    store.updateItem(item.id, {
        duration: seconds,
        plannedDuration: item.plannedDuration || seconds
    });
});
const stopPlayback = async () => {
    await getActivePlayoutService().stop();
    store.clearOnAirState();
};
const onContextMenu = (event, index, item) => {
    store.selectedItemId = item.id;
    contextMenu.value = { show: true, x: event.clientX, y: event.clientY, index, item };
};
const closeContextMenu = () => {
    contextMenu.value = { ...contextMenu.value, show: false, item: null, index: -1 };
};
const ctxPlayFrom = () => {
    if (contextMenu.value.index !== -1)
        runPlaylistFrom(contextMenu.value.index);
    closeContextMenu();
};
const ctxDuplicate = () => {
    if (contextMenu.value.item)
        store.duplicateItem(contextMenu.value.item.id);
    closeContextMenu();
};
const ctxDelete = () => {
    if (contextMenu.value.item && !isProtectedPlayingRow(contextMenu.value.index)) {
        store.removeItem(contextMenu.value.item.id);
    }
    closeContextMenu();
};
const saveMetadata = async (playoutvueId, updates, localItemId) => {
    if (localItemId) {
        await store.updateItemMetadata(localItemId, playoutvueId, updates);
    }
};
const contentTypeOptions = [
    { id: 'none', label: 'None' },
    { id: 'movie', label: 'Movie' },
    { id: 'show', label: 'Show' },
    { id: 'documentary', label: 'Documentary' },
    { id: 'news', label: 'News' }
];
const ctxSetAgeRating = async (rating) => {
    const item = contextMenu.value.item;
    if (item && item.type !== 'gap') {
        await saveMetadata(item.playoutvueId, { complianceRating: rating }, item.id);
    }
    closeContextMenu();
};
const ctxToggleTP = async () => {
    const item = contextMenu.value.item;
    if (item && item.type !== 'gap') {
        await saveMetadata(item.playoutvueId, { tp_flag: !item.tp_flag }, item.id);
    }
    closeContextMenu();
};
const ctxSetContentType = async (cType) => {
    const item = contextMenu.value.item;
    if (item && item.type !== 'gap') {
        await saveMetadata(item.playoutvueId, { content_type: cType }, item.id);
    }
    closeContextMenu();
};
const ctxSetIndicator = (indicator) => {
    if (contextMenu.value.item && contextMenu.value.item.type !== 'gap') {
        store.updateItem(contextMenu.value.item.id, { libraryIndicator: indicator });
    }
    closeContextMenu();
};
const topActionItems = computed(() => {
    const item = contextMenu.value.item;
    if (!item)
        return [];
    const isDeleteDisabled = isProtectedPlayingRow(contextMenu.value.index);
    return [
        {
            id: 'trim',
            tooltip: 'Trim (Unavailable)',
            action: () => { },
            disabled: true
        },
        {
            id: 'rename',
            tooltip: 'Rename (Unavailable)',
            action: () => { },
            disabled: true
        },
        {
            id: 'purge',
            tooltip: 'Purge (Unavailable)',
            action: () => { },
            disabled: true
        },
        {
            id: 'delete',
            tooltip: isDeleteDisabled ? 'Delete (Protected)' : 'Delete Item',
            action: ctxDelete,
            disabled: isDeleteDisabled
        }
    ];
});
const menuItems = computed(() => {
    const item = contextMenu.value.item;
    if (!item)
        return [];
    const list = [
        {
            type: 'action',
            label: '▶ Play from here',
            action: ctxPlayFrom
        },
        {
            type: 'action',
            label: '⧉ Duplicate',
            action: ctxDuplicate
        }
    ];
    if (item.type !== 'gap') {
        list.push({ type: 'divider' }, {
            type: 'submenu',
            label: 'Age Ratings (Σήματα Καταλληλότητας)',
            children: ratingOptions.map(r => ({
                type: 'action',
                label: r.label,
                checked: item.complianceRating === r.id,
                action: () => ctxSetAgeRating(r.id)
            }))
        }, { type: 'divider' }, {
            type: 'toggle',
            label: item.tp_flag ? '✓ TP (Active)' : '□ TP (None)',
            checked: item.tp_flag,
            action: ctxToggleTP
        }, { type: 'divider' }, {
            type: 'submenu',
            label: 'Categories/Tags',
            children: contentTypeOptions.map(ct => ({
                type: 'action',
                label: ct.label,
                checked: (item.content_type || 'none') === ct.id,
                action: () => ctxSetContentType(ct.id)
            }))
        }, { type: 'divider' }, {
            type: 'submenu',
            label: 'Legacy Tags',
            children: indicatorOptions.map(ind => ({
                type: 'action',
                label: ind.label,
                checked: (item.libraryIndicator || 'none') === ind.id,
                action: () => ctxSetIndicator(ind.id)
            }))
        });
    }
    return list;
});
const ensureSelectedRowVisible = (behavior = 'auto') => {
    const selectedId = store.selectedItemId;
    if (!selectedId || !rundownListRef.value)
        return;
    requestAnimationFrame(() => {
        const row = rundownListRef.value?.querySelector(`.rw-row[data-item-id="${selectedId}"]`);
        row?.scrollIntoView({ block: 'nearest', behavior });
    });
};
const moveSelection = (direction, repeated) => {
    const items = store.activeItems;
    if (!items.length)
        return;
    const currentIndex = store.selectedItemId
        ? items.findIndex((item) => item.id === store.selectedItemId)
        : -1;
    const nextIndex = currentIndex === -1
        ? (direction > 0 ? 0 : items.length - 1)
        : Math.max(0, Math.min(items.length - 1, currentIndex + direction));
    if (nextIndex === currentIndex || !items[nextIndex])
        return;
    store.selectedItemId = items[nextIndex].id;
    ensureSelectedRowVisible(repeated ? 'auto' : 'smooth');
};
const createPlaylistTab = () => {
    store.createPlaylist();
};
const renamePlaylistTab = (playlist) => {
    const value = window.prompt('Rename playlist', playlist.name);
    if (!value)
        return;
    store.renamePlaylist(playlist.id, value);
};
const closePlaylistTab = (playlist) => {
    store.closePlaylist(playlist.id);
};
const handleKey = (event) => {
    const target = event.target;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))
        return;
    const id = store.selectedItemId;
    const items = store.activeItems;
    const index = id ? items.findIndex((item) => item.id === id) : -1;
    if ((event.key === 'Delete' || event.key === 'Backspace') && id) {
        if (index >= 0 && isProtectedPlayingRow(index)) {
            return;
        }
        event.preventDefault();
        store.removeItem(id);
        return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && index !== -1) {
        event.preventDefault();
        runPlaylistFrom(index);
        return;
    }
    if (!event.ctrlKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const now = performance.now();
        if (event.repeat && now - lastSelectionMoveAt < SELECTION_REPEAT_INTERVAL_MS) {
            event.preventDefault();
            return;
        }
        lastSelectionMoveAt = now;
        event.preventDefault();
        moveSelection(event.key === 'ArrowUp' ? -1 : 1, event.repeat);
        return;
    }
    if (event.shiftKey && event.key === 'ArrowDown') {
        event.preventDefault();
        if (index !== -1) {
            store.duplicateItem(id);
            store.selectedItemId = items[index + 1]?.id || id;
        }
        return;
    }
    if (event.ctrlKey) {
        if (index === -1)
            return;
        if (event.key === 'ArrowUp' && index > 0) {
            event.preventDefault();
            store.reorderItems(index, index - 1);
        }
        if (event.key === 'ArrowDown' && index < items.length - 1) {
            event.preventDefault();
            store.reorderItems(index, index + 1);
        }
    }
};
const onDragEnter = (event) => {
    event.preventDefault();
    isDragOver.value = true;
};
const onDragOver = (event) => {
    event.preventDefault();
    if (event.dataTransfer)
        event.dataTransfer.dropEffect = 'copy';
};
const onRowDragOver = (event, index) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer)
        event.dataTransfer.dropEffect = 'copy';
    const target = resolveDropTarget(event, index);
    dropTargetIndex.value = index;
    dropTargetSide.value = target.side;
};
const onRowDrop = async (event, index) => {
    event.preventDefault();
    event.stopPropagation();
    isDragOver.value = false;
    const target = resolveDropTarget(event, index);
    await completeExternalDrop(target.insertIndex);
};
const onDragLeave = (event) => {
    const relatedTarget = event.relatedTarget;
    if (!event.currentTarget?.contains(relatedTarget)) {
        isDragOver.value = false;
        clearDropTarget();
    }
};
const onDrop = async (event) => {
    event.preventDefault();
    isDragOver.value = false;
    if (!draggingItem.value)
        return;
    await completeExternalDrop(dropTargetIndex.value ?? undefined);
};
const typeIcon = (type) => ({ video: '🎬', live: '📹', graphic: '🎨', gap: '⏱' }[type] || '📄');
const typeColor = (type) => ({ video: '#33becc', live: '#e63946', graphic: '#a8dadc', gap: '#df8e1d' }[type] || '#aaa');
const msToClockDisplay = (ms) => {
    if (ms <= 0)
        return '00:00:00';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
};
const msToShortDisplay = (ms) => {
    if (ms <= 0)
        return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
};
const durationLabel = (item, index) => {
    if (item.type === 'gap')
        return 'Ghost marker';
    const durationMs = effectiveDurationMs(item, index);
    if (durationMs > 0)
        return `00:00:00 / ${msToClockDisplay(durationMs)}`;
    if (item.type === 'live')
        return 'LIVE';
    return '00:00:00 / 00:00:00';
};
const activeTimerLabel = (item, index) => {
    if (item.type === 'gap')
        return '';
    if (index !== store.currentPlayingIndex || !isPlayoutPlaying.value || !store.isCurrentPlaylistOnAir)
        return '';
    const totalMs = effectiveDurationMs(item, index);
    if (item.type === 'live' && totalMs <= 0)
        return `${msToClockDisplay(currentPlayoutMs.value)} / LIVE`;
    if (totalMs <= 0)
        return `${msToClockDisplay(currentPlayoutMs.value)} / 00:00:00`;
    return `${msToClockDisplay(currentPlayoutMs.value)} / ${msToClockDisplay(totalMs)}`;
};
const ratingClass = (rating) => `rating-${rating || 'none'}`;
const isProtectedPlayingRow = (index) => store.isCurrentPlaylistOnAir && index === store.currentPlayingIndex;
const ratingToneClass = (rating) => `tone-rating-${rating || 'none'}`;
const indicatorToneClass = (indicator) => `tone-tag-${indicator || 'none'}`;
const indicatorLabel = (indicator) => ({
    spot: 'SPOT',
    telemarketing: 'TMK',
    none: ''
}[indicator || 'none']);
const rowSignals = (item) => {
    const signals = [];
    if (item.complianceRating && item.complianceRating !== 'none') {
        signals.push({
            key: `rating-${item.complianceRating}`,
            className: ratingToneClass(item.complianceRating),
            title: `Compliance rating ${item.complianceRating.toUpperCase()}`
        });
    }
    if (item.libraryIndicator && item.libraryIndicator !== 'none') {
        signals.push({
            key: `tag-${item.libraryIndicator}`,
            className: indicatorToneClass(item.libraryIndicator),
            title: indicatorLabel(item.libraryIndicator)
        });
    }
    return signals;
};
const clearDropTarget = () => {
    dropTargetIndex.value = null;
    dropTargetSide.value = 'before';
};
const resolveDropTarget = (event, index) => {
    const row = event.currentTarget;
    if (!row) {
        return { insertIndex: index, side: 'before' };
    }
    const rect = row.getBoundingClientRect();
    const side = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
    return {
        insertIndex: side === 'after' ? index + 1 : index,
        side
    };
};
const buildDroppedPayload = async () => {
    if (!draggingItem.value)
        return null;
    const payload = { ...draggingItem.value };
    if (payload.type === 'video' && !(payload.duration > 0) && payload.path && !/^https?:/i.test(payload.path)) {
        try {
            const metadata = await invoke('scan_media', { filepath: payload.path });
            const seconds = Number.parseFloat(metadata.duration || '0');
            if (Number.isFinite(seconds) && seconds > 0) {
                payload.duration = seconds;
            }
        }
        catch (error) {
            console.warn('[Rundown] Failed to resolve dropped item duration before insert', payload.path, error);
        }
    }
    return payload;
};
const completeExternalDrop = async (insertIndex) => {
    const payload = await buildDroppedPayload();
    if (!payload)
        return;
    if (typeof insertIndex === 'number') {
        store.insertItemAt(insertIndex, payload);
    }
    else {
        store.addItem(payload);
    }
    const insertedIndex = typeof insertIndex === 'number'
        ? Math.max(0, Math.min(insertIndex, store.activeItems.length - 1))
        : store.activeItems.length - 1;
    const insertedItem = store.activeItems[insertedIndex];
    if (insertedItem && payload.type === 'video' && !(payload.duration > 0) && payload.path && !/^https?:/i.test(payload.path)) {
        hydrateSingleItemDuration(insertedItem.id, payload.path).catch(() => { });
    }
    draggingItem.value = null;
    clearDropTarget();
};
const trimDisplay = (item) => {
    if (item.type === 'gap')
        return item.hardStartTime || 'GAP';
    if (item.type === 'live')
        return 'LIVE';
    const trimIn = item.trim_in_ms !== undefined ? item.trim_in_ms : item.inPoint;
    const trimOut = item.trim_out_ms !== undefined ? item.trim_out_ms : (item.duration_ms && item.outPoint ? item.duration_ms - item.outPoint : 0);
    if (!trimIn && !trimOut)
        return 'FULL';
    const inLabel = trimIn ? msToShortDisplay(trimIn) : '0:00';
    const outLabel = (item.duration_ms && trimOut) ? msToShortDisplay(item.duration_ms - trimOut) : (item.duration && trimOut ? msToShortDisplay(item.duration * 1000 - trimOut) : 'END');
    return `${inLabel}→${outLabel}`;
};
const getDisplayName = (item) => {
    if (item.display_name)
        return item.display_name;
    if (item.current_path) {
        const filename = item.current_path.split(/[/\\]/).pop();
        if (filename && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filename)) {
            return filename;
        }
    }
    if (item.filename && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.filename)) {
        return item.filename;
    }
    return 'Untitled Asset';
};
onMounted(() => {
    hydrateMissingDurations().catch((error) => {
        console.warn('[Rundown] Initial duration hydration failed', error);
    });
    if (rundownListRef.value) {
        sortableInstance = Sortable.create(rundownListRef.value, {
            animation: 200,
            ghostClass: 'rw-ghost',
            handle: '.rw-handle',
            onEnd: (evt) => {
                if (evt.oldIndex !== undefined && evt.newIndex !== undefined && evt.oldIndex !== evt.newIndex) {
                    setTimeout(() => {
                        store.reorderItems(evt.oldIndex, evt.newIndex);
                    }, 200);
                }
            }
        });
    }
    window.addEventListener('keydown', handleKey);
    window.addEventListener('click', closeContextMenu);
});
onUnmounted(() => {
    sortableInstance?.destroy();
    sortableInstance = null;
    window.removeEventListener('keydown', handleKey);
    window.removeEventListener('click', closeContextMenu);
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
/** @type {__VLS_StyleScopedClasses['playlist-tab']} */ ;
/** @type {__VLS_StyleScopedClasses['playlist-tab']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-list']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['drop-target-before']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['drop-target-after']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['drop-target-before']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['drop-target-after']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['drop-target-before']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['drop-target-after']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['drop-target-before']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['drop-target-after']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['drop-target-before']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['drop-target-after']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-line']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-line']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['gap-line']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-name']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-rating-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['rating-k']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-signal']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-rating-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['rating-8']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-signal']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-rating-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['rating-12']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-signal']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-rating-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['rating-16']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-signal']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-rating-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['rating-18']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-signal']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-tag-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-signal']} */ ;
/** @type {__VLS_StyleScopedClasses['tone-tag-spot']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-tag-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-signal']} */ ;
/** @type {__VLS_StyleScopedClasses['tone-tag-telemarketing']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-inout']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-dur']} */ ;
/** @type {__VLS_StyleScopedClasses['row-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-play']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['ct-movie']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['ct-show']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['ct-documentary']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
/** @type {__VLS_StyleScopedClasses['ct-news']} */ ;
/** @type {__VLS_StyleScopedClasses['rw-name']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-age']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-age']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-age']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-age']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-content']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-content']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-content']} */ ;
/** @type {__VLS_StyleScopedClasses['crawl-input']} */ ;
/** @type {__VLS_StyleScopedClasses['crawl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['crawl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['is-active']} */ ;
/** @type {__VLS_StyleScopedClasses['crawl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['crawl-btn-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['crawl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['is-active']} */ ;
/** @type {__VLS_StyleScopedClasses['crawl-btn-dot']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "rundown-wrapper" },
});
/** @type {__VLS_StyleScopedClasses['rundown-wrapper']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "rw-header" },
});
/** @type {__VLS_StyleScopedClasses['rw-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "text-warning" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['text-warning']} */ ;
(__VLS_ctx.store.currentPlaylistName);
if (__VLS_ctx.store.isCurrentPlaylistOnAir) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "playing-badge" },
    });
    /** @type {__VLS_StyleScopedClasses['playing-badge']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "crawl-controls" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['crawl-controls']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    type: "text",
    value: (__VLS_ctx.settings.cgCrawlText),
    placeholder: "Enter news crawl ticker text...",
    ...{ class: "crawl-input" },
    title: "On-Demand Crawl Text (live update on type)",
});
/** @type {__VLS_StyleScopedClasses['crawl-input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.toggleCrawlTicker) },
    ...{ class: "crawl-btn" },
    ...{ class: ({ 'is-active': __VLS_ctx.settings.cgCrawlActive }) },
    title: "Toggle On-Demand Ticker Overlay",
});
/** @type {__VLS_StyleScopedClasses['crawl-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['is-active']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "crawl-btn-dot" },
});
/** @type {__VLS_StyleScopedClasses['crawl-btn-dot']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "clock-display" },
});
/** @type {__VLS_StyleScopedClasses['clock-display']} */ ;
(__VLS_ctx.clockStr);
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.showLiveDialog = true);
            // @ts-ignore
            [store, store, settings, settings, toggleCrawlTicker, clockStr, showLiveDialog,];
        } },
    ...{ class: "icon-action" },
    title: "Add Live Entry",
});
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
if (__VLS_ctx.isPlayoutPlaying) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.stopPlayback) },
        ...{ class: "icon-action btn-stop" },
        title: "Stop",
    });
    /** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-stop']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "playlist-tabs-row" },
});
/** @type {__VLS_StyleScopedClasses['playlist-tabs-row']} */ ;
for (const [playlist] of __VLS_vFor((__VLS_ctx.store.playlists))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.store.activatePlaylist(playlist.id));
                // @ts-ignore
                [store, store, isPlayoutPlaying, stopPlayback,];
            } },
        ...{ onDblclick: (...[$event]) => {
                return (__VLS_ctx.renamePlaylistTab(playlist));
                // @ts-ignore
                [renamePlaylistTab,];
            } },
        key: (playlist.id),
        ...{ class: "playlist-tab" },
        ...{ class: ({ 'is-active': playlist.id === __VLS_ctx.store.activePlaylistId, 'is-onair': playlist.id === __VLS_ctx.store.onAirPlaylistId }) },
    });
    /** @type {__VLS_StyleScopedClasses['playlist-tab']} */ ;
    /** @type {__VLS_StyleScopedClasses['is-active']} */ ;
    /** @type {__VLS_StyleScopedClasses['is-onair']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "playlist-tab-name" },
    });
    /** @type {__VLS_StyleScopedClasses['playlist-tab-name']} */ ;
    (playlist.name);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "playlist-tab-state" },
    });
    /** @type {__VLS_StyleScopedClasses['playlist-tab-state']} */ ;
    (playlist.id === __VLS_ctx.store.onAirPlaylistId ? 'ON AIR' : 'OFFLINE');
    if (__VLS_ctx.store.playlists.length > 1 && playlist.id !== __VLS_ctx.store.onAirPlaylistId) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.store.playlists.length > 1 && playlist.id !== __VLS_ctx.store.onAirPlaylistId))
                        throw 0;
                    return (__VLS_ctx.closePlaylistTab(playlist));
                    // @ts-ignore
                    [store, store, store, store, store, closePlaylistTab,];
                } },
            ...{ class: "playlist-tab-close" },
            title: "Close playlist",
        });
        /** @type {__VLS_StyleScopedClasses['playlist-tab-close']} */ ;
    }
    // @ts-ignore
    [];
}
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.createPlaylistTab) },
    ...{ class: "playlist-add-btn" },
    title: "Create new offline playlist",
});
/** @type {__VLS_StyleScopedClasses['playlist-add-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "rw-cols-label" },
});
/** @type {__VLS_StyleScopedClasses['rw-cols-label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onDragenter: (__VLS_ctx.onDragEnter) },
    ...{ onDragover: (__VLS_ctx.onDragOver) },
    ...{ onDragleave: (__VLS_ctx.onDragLeave) },
    ...{ onDrop: (__VLS_ctx.onDrop) },
    ...{ class: "rw-list custom-scroll" },
    ref: "rundownListRef",
    ...{ class: ({ 'drag-over': __VLS_ctx.isDragOver }) },
});
/** @type {__VLS_StyleScopedClasses['rw-list']} */ ;
/** @type {__VLS_StyleScopedClasses['custom-scroll']} */ ;
/** @type {__VLS_StyleScopedClasses['drag-over']} */ ;
for (const [item, index] of __VLS_vFor((__VLS_ctx.store.activeItems))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.store.selectedItemId = item.id);
                // @ts-ignore
                [store, store, createPlaylistTab, onDragEnter, onDragOver, onDragLeave, onDrop, isDragOver,];
            } },
        ...{ onContextmenu: (...[$event]) => {
                return (__VLS_ctx.onContextMenu($event, index, item));
                // @ts-ignore
                [onContextMenu,];
            } },
        ...{ onDragover: (...[$event]) => {
                return (__VLS_ctx.onRowDragOver($event, index));
                // @ts-ignore
                [onRowDragOver,];
            } },
        ...{ onDrop: (...[$event]) => {
                return (__VLS_ctx.onRowDrop($event, index));
                // @ts-ignore
                [onRowDrop,];
            } },
        key: (item.id),
        ...{ class: "rw-row" },
        'data-item-id': (item.id),
        ...{ class: ({
                'selected': item.id === __VLS_ctx.store.selectedItemId,
                'playing': item.id === __VLS_ctx.store.currentPlayingInstanceId || (index === __VLS_ctx.store.currentPlayingIndex && __VLS_ctx.store.isCurrentPlaylistOnAir),
                'played': __VLS_ctx.store.isCurrentPlaylistOnAir && index < __VLS_ctx.store.currentPlayingIndex,
                'next-up': __VLS_ctx.isNextUpRow(index),
                'next-up-imminent': __VLS_ctx.isNextUpImminent(index),
                'drop-target-before': __VLS_ctx.dropTargetIndex === index && __VLS_ctx.dropTargetSide === 'before',
                'drop-target-after': __VLS_ctx.dropTargetIndex === index && __VLS_ctx.dropTargetSide === 'after',
                'gap-line': item.type === 'gap',
                [__VLS_ctx.ratingClass(item.complianceRating)]: item.complianceRating && item.complianceRating !== 'none',
                'ct-movie': item.content_type === 'movie',
                'ct-show': item.content_type === 'show',
                'ct-documentary': item.content_type === 'documentary',
                'ct-news': item.content_type === 'news'
            }) },
        ...{ style: (item.id === __VLS_ctx.store.currentPlayingInstanceId ? {
                background: `linear-gradient(90deg, rgba(46,204,113,0.22) ${__VLS_ctx.store.playbackProgressPct}%, rgba(46,204,113,0.06) ${__VLS_ctx.store.playbackProgressPct}%)`,
                borderColor: 'rgba(46,204,113,0.4)'
            } : (index === __VLS_ctx.store.currentPlayingIndex && __VLS_ctx.isPlayoutPlaying && __VLS_ctx.store.isCurrentPlaylistOnAir && item.type !== 'live' && item.type !== 'gap' ? {
                background: `linear-gradient(90deg, rgba(230,57,70,0.3) ${__VLS_ctx.calcProgress(item, index)}%, rgba(230,57,70,0.08) ${__VLS_ctx.calcProgress(item, index)}%)`,
                borderColor: 'rgba(230,57,70,0.4)'
            } : {})) },
    });
    /** @type {__VLS_StyleScopedClasses['rw-row']} */ ;
    /** @type {__VLS_StyleScopedClasses['selected']} */ ;
    /** @type {__VLS_StyleScopedClasses['playing']} */ ;
    /** @type {__VLS_StyleScopedClasses['played']} */ ;
    /** @type {__VLS_StyleScopedClasses['next-up']} */ ;
    /** @type {__VLS_StyleScopedClasses['next-up-imminent']} */ ;
    /** @type {__VLS_StyleScopedClasses['drop-target-before']} */ ;
    /** @type {__VLS_StyleScopedClasses['drop-target-after']} */ ;
    /** @type {__VLS_StyleScopedClasses['gap-line']} */ ;
    /** @type {__VLS_StyleScopedClasses['ct-movie']} */ ;
    /** @type {__VLS_StyleScopedClasses['ct-show']} */ ;
    /** @type {__VLS_StyleScopedClasses['ct-documentary']} */ ;
    /** @type {__VLS_StyleScopedClasses['ct-news']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-handle" },
        title: (item.type === 'gap' ? 'Drag to move gap line' : 'Drag to reorder'),
    });
    /** @type {__VLS_StyleScopedClasses['rw-handle']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-num" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-num']} */ ;
    (item.type === 'gap' ? '⏱' : index + 1);
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-signals" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-signals']} */ ;
    for (const [signal] of __VLS_vFor((__VLS_ctx.rowSignals(item)))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            key: (signal.key),
            ...{ class: "rw-signal" },
            ...{ class: (signal.className) },
            title: (signal.title),
        });
        /** @type {__VLS_StyleScopedClasses['rw-signal']} */ ;
        // @ts-ignore
        [store, store, store, store, store, store, store, store, store, store, store, isPlayoutPlaying, isNextUpRow, isNextUpImminent, dropTargetIndex, dropTargetIndex, dropTargetSide, dropTargetSide, ratingClass, calcProgress, calcProgress, rowSignals,];
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-type-icon" },
        ...{ style: ({ color: __VLS_ctx.typeColor(item.type) }) },
    });
    /** @type {__VLS_StyleScopedClasses['rw-type-icon']} */ ;
    (__VLS_ctx.typeIcon(item.type));
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-name" },
        title: (__VLS_ctx.getDisplayName(item)),
    });
    /** @type {__VLS_StyleScopedClasses['rw-name']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "rw-name-text" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-name-text']} */ ;
    (__VLS_ctx.getDisplayName(item));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "rw-meta-badges" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-meta-badges']} */ ;
    if (item.complianceRating && item.complianceRating !== 'none') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "mcr-badge badge-age" },
            ...{ class: (`age-${item.complianceRating}`) },
        });
        /** @type {__VLS_StyleScopedClasses['mcr-badge']} */ ;
        /** @type {__VLS_StyleScopedClasses['badge-age']} */ ;
        (item.complianceRating.toUpperCase());
    }
    if (item.tp_flag) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "mcr-badge badge-tp" },
        });
        /** @type {__VLS_StyleScopedClasses['mcr-badge']} */ ;
        /** @type {__VLS_StyleScopedClasses['badge-tp']} */ ;
    }
    if (item.content_type && item.content_type !== 'none') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "mcr-badge badge-content" },
            ...{ class: (`content-${item.content_type}`) },
        });
        /** @type {__VLS_StyleScopedClasses['mcr-badge']} */ ;
        /** @type {__VLS_StyleScopedClasses['badge-content']} */ ;
        (item.content_type.toUpperCase());
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-rating" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-rating']} */ ;
    if (item.complianceRating && item.complianceRating !== 'none') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "rw-rating-badge" },
            ...{ class: (__VLS_ctx.ratingClass(item.complianceRating)) },
        });
        /** @type {__VLS_StyleScopedClasses['rw-rating-badge']} */ ;
        (item.complianceRating.toUpperCase());
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "rw-rating-empty" },
        });
        /** @type {__VLS_StyleScopedClasses['rw-rating-empty']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-tag" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-tag']} */ ;
    if (item.libraryIndicator && item.libraryIndicator !== 'none') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "rw-tag-badge" },
            ...{ class: (__VLS_ctx.indicatorToneClass(item.libraryIndicator)) },
        });
        /** @type {__VLS_StyleScopedClasses['rw-tag-badge']} */ ;
        (__VLS_ctx.indicatorLabel(item.libraryIndicator));
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "rw-rating-empty" },
        });
        /** @type {__VLS_StyleScopedClasses['rw-rating-empty']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-inout" },
        title: (__VLS_ctx.trimDisplay(item)),
    });
    /** @type {__VLS_StyleScopedClasses['rw-inout']} */ ;
    (__VLS_ctx.trimDisplay(item));
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-dur" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-dur']} */ ;
    if (item.id === __VLS_ctx.store.currentPlayingInstanceId) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ style: {} },
        });
        (__VLS_ctx.store.playbackCountdownStr);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    (__VLS_ctx.activeTimerLabel(item, index) || __VLS_ctx.durationLabel(item, index));
    if (__VLS_ctx.store.activeItemsETAs[index] && __VLS_ctx.store.activeItemsETAs[index].formatted) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "rw-eta-hint" },
        });
        /** @type {__VLS_StyleScopedClasses['rw-eta-hint']} */ ;
        (__VLS_ctx.store.activeItemsETAs[index].formatted);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-day" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-day']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tc-day" },
    });
    /** @type {__VLS_StyleScopedClasses['tc-day']} */ ;
    (__VLS_ctx.scheduledTimes[index]?.dayLabel || '·');
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-at" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-at']} */ ;
    if (__VLS_ctx.scheduledTimes[index]?.kind === 'done') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tc-done" },
        });
        /** @type {__VLS_StyleScopedClasses['tc-done']} */ ;
    }
    else if (__VLS_ctx.scheduledTimes[index]?.kind === 'now') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tc-now" },
        });
        /** @type {__VLS_StyleScopedClasses['tc-now']} */ ;
    }
    else if (__VLS_ctx.scheduledTimes[index]?.kind === 'gap') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tc-gap" },
        });
        /** @type {__VLS_StyleScopedClasses['tc-gap']} */ ;
        (__VLS_ctx.scheduledTimes[index]?.text);
    }
    else if (__VLS_ctx.scheduledTimes[index]?.kind === 'time') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tc-sched" },
        });
        /** @type {__VLS_StyleScopedClasses['tc-sched']} */ ;
        (__VLS_ctx.scheduledTimes[index]?.text);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-actions" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-actions']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.runPlaylistFrom(index));
                // @ts-ignore
                [store, store, store, store, store, ratingClass, typeColor, typeIcon, getDisplayName, getDisplayName, indicatorToneClass, indicatorLabel, trimDisplay, trimDisplay, activeTimerLabel, durationLabel, scheduledTimes, scheduledTimes, scheduledTimes, scheduledTimes, scheduledTimes, scheduledTimes, scheduledTimes, runPlaylistFrom,];
            } },
        ...{ class: "row-btn btn-play" },
        title: (item.type === 'gap' ? 'Play next content after this gap line' : `Play from #${index + 1}`),
    });
    /** @type {__VLS_StyleScopedClasses['row-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-play']} */ ;
    if (!__VLS_ctx.isProtectedPlayingRow(index)) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(!__VLS_ctx.isProtectedPlayingRow(index)))
                        throw 0;
                    return (__VLS_ctx.store.removeItem(item.id));
                    // @ts-ignore
                    [store, isProtectedPlayingRow,];
                } },
            ...{ class: "row-btn row-btn-del" },
            title: "Remove (Del)",
        });
        /** @type {__VLS_StyleScopedClasses['row-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['row-btn-del']} */ ;
    }
    // @ts-ignore
    [];
}
if (__VLS_ctx.store.activeItems.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "rw-empty" },
    });
    /** @type {__VLS_StyleScopedClasses['rw-empty']} */ ;
}
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
if (__VLS_ctx.contextMenu.show) {
    const __VLS_6 = ContextMenu;
    // @ts-ignore
    const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
        ...{ 'onClose': {} },
        x: (__VLS_ctx.contextMenu.x),
        y: (__VLS_ctx.contextMenu.y),
        topActions: (__VLS_ctx.topActionItems),
        items: (__VLS_ctx.menuItems),
    }));
    const __VLS_8 = __VLS_7({
        ...{ 'onClose': {} },
        x: (__VLS_ctx.contextMenu.x),
        y: (__VLS_ctx.contextMenu.y),
        topActions: (__VLS_ctx.topActionItems),
        items: (__VLS_ctx.menuItems),
    }, ...__VLS_functionalComponentArgsRest(__VLS_7));
    let __VLS_11;
    const __VLS_12 = {
        /** @type {typeof __VLS_11.close} */
        onClose: (__VLS_ctx.closeContextMenu),
    };
    var __VLS_9;
    var __VLS_10;
}
// @ts-ignore
[store, contextMenu, contextMenu, contextMenu, topActionItems, menuItems, closeContextMenu,];
var __VLS_3;
const __VLS_13 = PlaylistControls;
// @ts-ignore
const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({}));
const __VLS_15 = __VLS_14({}, ...__VLS_functionalComponentArgsRest(__VLS_14));
if (__VLS_ctx.showLiveDialog) {
    const __VLS_18 = LiveEntryDialog;
    // @ts-ignore
    const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
        ...{ 'onClose': {} },
    }));
    const __VLS_20 = __VLS_19({
        ...{ 'onClose': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_19));
    let __VLS_23;
    const __VLS_24 = {
        /** @type {typeof __VLS_23.close} */
        onClose: (...[$event]) => {
            if (!(__VLS_ctx.showLiveDialog))
                throw 0;
            return (__VLS_ctx.showLiveDialog = false);
            // @ts-ignore
            [showLiveDialog, showLiveDialog,];
        },
    };
    var __VLS_21;
    var __VLS_22;
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
