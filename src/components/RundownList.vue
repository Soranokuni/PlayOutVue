<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import Sortable from 'sortablejs';
import { useRundownStore, type ComplianceRating, type RundownItem, type RundownPlaylist } from '../stores/rundown';
import type { LibraryIndicator } from '../stores/mediaDefaults';
import { draggingItem } from '../composables/useDragState';
import { playStartTime } from '../services/obs';
import { currentPlayoutMs, currentTotalPlayoutMs, getActivePlayoutService, isPlayoutPlaying, registerPlayoutAdvanceListener } from '../services/playout';
import LiveEntryDialog from './LiveEntryDialog.vue';
import PlaylistControls from './PlaylistControls.vue';

const store = useRundownStore();
const rundownListRef = ref<HTMLElement | null>(null);
const isDragOver = ref(false);
const showLiveDialog = ref(false);
const dropTargetIndex = ref<number | null>(null);
const dropTargetSide = ref<'before' | 'after'>('before');
const SELECTION_REPEAT_INTERVAL_MS = 85;
let sortableInstance: Sortable | null = null;
const durationHydrationInFlight = new Set<string>();
let lastSelectionMoveAt = 0;

const contextMenu = ref({
  show: false,
  x: 0,
  y: 0,
  index: -1,
  item: null as RundownItem | null
});

const ratingOptions: Array<{ id: ComplianceRating; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'k', label: 'K' },
  { id: '8', label: '8+' },
  { id: '12', label: '12+' },
  { id: '16', label: '16+' },
  { id: '18', label: '18+' }
];

const indicatorOptions: Array<{ id: LibraryIndicator; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'spot', label: 'Spot' },
  { id: 'telemarketing', label: 'Telemarketing' }
];

const clockNow = ref(Date.now());
let clockTick: ReturnType<typeof setInterval> | null = null;

const tickClock = () => {
  clockNow.value = Date.now();
};

onMounted(() => {
  clockTick = setInterval(tickClock, 1000);
});

onUnmounted(() => {
  if (clockTick) clearInterval(clockTick);
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

const weekdayLabel = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString('en-GB', { weekday: 'short' }).toLowerCase();

const applyWeekdayAnchor = (epochMs: number, weekday: number) => {
  const anchored = new Date(epochMs);
  anchored.setDate(anchored.getDate() - anchored.getDay() + weekday);
  return anchored.getTime();
};

const parseClockAnchor = (timeText: string, fallbackMs: number) => {
  const parts = timeText.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => Number.isNaN(part))) {
    return fallbackMs;
  }

  const anchor = new Date(fallbackMs);
  anchor.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
  return anchor.getTime();
};

const formatClockTime = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString('el-GR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

const itemDurationMs = (item: RundownItem): number => {
  if (item.type === 'gap') return 0;
  if (item.type === 'live') return (item.plannedDuration || item.duration || 0) * 1000;
  if (item.outPoint > item.inPoint) return item.outPoint - item.inPoint;
  return (item.plannedDuration || item.duration || 0) * 1000;
};

const effectiveDurationMs = (item: RundownItem, index: number): number => {
  if (index === store.currentPlayingIndex && currentTotalPlayoutMs.value > 0) {
    return currentTotalPlayoutMs.value;
  }
  return itemDurationMs(item);
};

const currentRemainingMs = computed(() => {
  if (!store.isCurrentPlaylistOnAir || store.currentPlayingIndex < 0) return 0;
  const currentItem = store.activeItems[store.currentPlayingIndex];
  if (!currentItem) return 0;
  const totalMs = effectiveDurationMs(currentItem, store.currentPlayingIndex);
  if (totalMs <= 0) return 0;
  return Math.max(0, totalMs - currentPlayoutMs.value);
});

const nextPlayableVisibleIndex = computed(() => {
  if (!store.isCurrentPlaylistOnAir || store.currentPlayingIndex < 0) return -1;
  for (let index = store.currentPlayingIndex + 1; index < store.activeItems.length; index += 1) {
    if (store.activeItems[index]?.type !== 'gap') {
      return index;
    }
  }
  return -1;
});

const isNextUpRow = (index: number) => index === nextPlayableVisibleIndex.value;
const isNextUpImminent = (index: number) => isNextUpRow(index) && currentRemainingMs.value > 0 && currentRemainingMs.value <= 10_000;

const scheduledTimes = computed(() => {
  const playlist = store.currentPlaylist;
  if (!playlist) return [];
  const playingCurrentPlaylist = store.isCurrentPlaylistOnAir && store.currentPlayingIndex >= 0;
  const startVisibleIndex = playingCurrentPlaylist ? Math.max(0, playlist.playStartVisibleIndex) : 0;
  let accumulatedTime = playingCurrentPlaylist
    ? playStartTime.value
    : (playlist.startFromTime
      ? applyWeekdayAnchor(parseClockAnchor(playlist.startFromTime, clockNow.value), playlist.startFromWeekday)
      : clockNow.value);

  return store.activeItems.map((item, index) => {
    if (item.type === 'gap') {
      const gapLabel = item.hardStartTime || item.filename.replace(/^Start @\s*/, '');
      if (!playingCurrentPlaylist && gapLabel) {
        accumulatedTime = parseClockAnchor(gapLabel, accumulatedTime);
      }
      return { kind: 'gap', text: gapLabel || 'Gap line', dayLabel: weekdayLabel(accumulatedTime) };
    }

    if (playingCurrentPlaylist && index < startVisibleIndex) return { kind: 'skip' };
    if (playingCurrentPlaylist && index < store.currentPlayingIndex) {
      accumulatedTime += itemDurationMs(item);
      return { kind: 'done' };
    }
    if (playingCurrentPlaylist && index === store.currentPlayingIndex) {
      accumulatedTime += itemDurationMs(item);
      return { kind: 'now', dayLabel: weekdayLabel(clockNow.value) };
    }

    const nextStart = accumulatedTime;
    accumulatedTime += itemDurationMs(item);
    return { kind: 'time', text: formatClockTime(nextStart), dayLabel: weekdayLabel(nextStart) };
  });
});

const calcProgress = (item: RundownItem) => {
  const activeIndex = store.activeItems.findIndex((candidate) => candidate.id === item.id);
  const duration = effectiveDurationMs(item, activeIndex);
  if (!duration || duration <= 0) return 0;
  const progress = (currentPlayoutMs.value / duration) * 100;
  return Math.max(0, Math.min(100, Math.round(progress * 100) / 100));
};

const hydrateMissingDurations = async () => {
  const candidates = store.activeItems.filter((item) =>
    item.type === 'video'
    && item.path
    && !/^https?:/i.test(item.path)
    && !(item.outPoint > item.inPoint)
    && !(item.duration > 0)
    && !durationHydrationInFlight.has(item.id)
  );

  await Promise.all(candidates.map(async (item) => {
    durationHydrationInFlight.add(item.id);
    try {
      const metadata = await invoke<{ duration: string }>('scan_media', { filepath: item.path });
      const seconds = Number.parseFloat(metadata.duration || '0');
      if (Number.isFinite(seconds) && seconds > 0) {
        store.updateItem(item.id, {
          duration: seconds,
          plannedDuration: item.plannedDuration || seconds
        });
      }
    } catch (error) {
      console.warn('[Rundown] Failed to hydrate item duration', item.path, error);
    } finally {
      durationHydrationInFlight.delete(item.id);
    }
  }));
};

const hydrateSingleItemDuration = async (itemId: string, filePath: string) => {
  if (!itemId || !filePath || /^https?:/i.test(filePath)) return;
  if (durationHydrationInFlight.has(itemId)) return;

  durationHydrationInFlight.add(itemId);
  try {
    const metadata = await invoke<{ duration: string }>('scan_media', { filepath: filePath });
    const seconds = Number.parseFloat(metadata.duration || '0');
    if (Number.isFinite(seconds) && seconds > 0) {
      store.updateItem(itemId, {
        duration: seconds,
        plannedDuration: seconds
      });
    }
  } catch (error) {
    console.warn('[Rundown] Failed to hydrate dropped item duration', filePath, error);
  } finally {
    durationHydrationInFlight.delete(itemId);
  }
};

registerPlayoutAdvanceListener((index) => {
  store.setOnAirPlayingIndex(index);
  if (store.isCurrentPlaylistOnAir && store.currentPlayingIndex >= 0) {
    store.selectedItemId = store.activeItems[store.currentPlayingIndex]?.id || store.selectedItemId;
  }
});

const runPlaylistFrom = async (index: number) => {
  const payload = store.buildPlaybackPayload(index);
  if (!payload) return;

  const service = getActivePlayoutService();
  try {
    if (isPlayoutPlaying.value && store.onAirPlaylistId && store.onAirPlaylistId !== payload.playlistId) {
      await service.stop();
      store.clearOnAirState();
    }

    store.setPlaylistOnAir(payload.playlistId, payload.startVisibleIndex);
    store.selectedItemId = store.activeItems[payload.startVisibleIndex]?.id || null;
    await service.play(payload.items as any, payload.startIndex);
  } catch (error) {
    store.clearOnAirState();
    console.error('[Playback] Failed to start playlist', error);
  }
};

watch(
  () => store.activeItems.map((item) => `${item.id}:${item.type}:${item.path}:${item.inPoint}:${item.outPoint}:${item.plannedDuration}`).join('|'),
  () => {
    if (!isPlayoutPlaying.value || !store.isCurrentPlaylistOnAir) return;
    getActivePlayoutService().refreshQueue?.(store.getPlayableItems() as any).catch((error) => {
      console.error('[Playback] Failed to refresh rundown queue', error);
    });
  }
);

watch(
  () => store.activeItems.map((item) => `${item.id}:${item.type}:${item.path}:${item.duration}:${item.outPoint}:${item.inPoint}`).join('|'),
  () => {
    hydrateMissingDurations().catch((error) => {
      console.warn('[Rundown] Duration hydration failed', error);
    });
  },
  { immediate: true }
);

watch(
  () => `${store.currentPlayingIndex}:${currentTotalPlayoutMs.value}:${store.isCurrentPlaylistOnAir}`,
  () => {
    const index = store.currentPlayingIndex;
    if (!store.isCurrentPlaylistOnAir || index < 0 || currentTotalPlayoutMs.value <= 0) return;
    const item = store.activeItems[index];
    if (!item || item.type !== 'video' || item.outPoint > item.inPoint || item.duration > 0) return;
    const seconds = currentTotalPlayoutMs.value / 1000;
    store.updateItem(item.id, {
      duration: seconds,
      plannedDuration: item.plannedDuration || seconds
    });
  }
);

const stopPlayback = async () => {
  await getActivePlayoutService().stop();
  store.clearOnAirState();
};

const onContextMenu = (event: MouseEvent, index: number, item: RundownItem) => {
  store.selectedItemId = item.id;
  contextMenu.value = { show: true, x: event.clientX, y: event.clientY, index, item };
};

const closeContextMenu = () => {
  contextMenu.value = { ...contextMenu.value, show: false, item: null, index: -1 };
};

const ctxPlayFrom = () => {
  if (contextMenu.value.index !== -1) runPlaylistFrom(contextMenu.value.index);
  closeContextMenu();
};

const ctxDuplicate = () => {
  if (contextMenu.value.item) store.duplicateItem(contextMenu.value.item.id);
  closeContextMenu();
};

const ctxDelete = () => {
  if (contextMenu.value.item && !isProtectedPlayingRow(contextMenu.value.index)) {
    store.removeItem(contextMenu.value.item.id);
  }
  closeContextMenu();
};

const ctxSetRating = (rating: ComplianceRating) => {
  if (contextMenu.value.item && contextMenu.value.item.type !== 'gap') {
    store.updateItem(contextMenu.value.item.id, { complianceRating: rating });
  }
  closeContextMenu();
};

const ctxSetIndicator = (indicator: LibraryIndicator) => {
  if (contextMenu.value.item && contextMenu.value.item.type !== 'gap') {
    store.updateItem(contextMenu.value.item.id, { libraryIndicator: indicator });
  }
  closeContextMenu();
};

const ensureSelectedRowVisible = (behavior: ScrollBehavior = 'auto') => {
  const selectedId = store.selectedItemId;
  if (!selectedId || !rundownListRef.value) return;

  requestAnimationFrame(() => {
    const row = rundownListRef.value?.querySelector<HTMLElement>(`.rw-row[data-item-id="${selectedId}"]`);
    row?.scrollIntoView({ block: 'nearest', behavior });
  });
};

const moveSelection = (direction: -1 | 1, repeated: boolean) => {
  const items = store.activeItems;
  if (!items.length) return;

  const currentIndex = store.selectedItemId
    ? items.findIndex((item) => item.id === store.selectedItemId)
    : -1;

  const nextIndex = currentIndex === -1
    ? (direction > 0 ? 0 : items.length - 1)
    : Math.max(0, Math.min(items.length - 1, currentIndex + direction));

  if (nextIndex === currentIndex || !items[nextIndex]) return;

  store.selectedItemId = items[nextIndex].id;
  ensureSelectedRowVisible(repeated ? 'auto' : 'smooth');
};

const createPlaylistTab = () => {
  store.createPlaylist();
};

const renamePlaylistTab = (playlist: RundownPlaylist) => {
  const value = window.prompt('Rename playlist', playlist.name);
  if (!value) return;
  store.renamePlaylist(playlist.id, value);
};

const closePlaylistTab = (playlist: RundownPlaylist) => {
  store.closePlaylist(playlist.id);
};

const handleKey = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;

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
      store.duplicateItem(id!);
      store.selectedItemId = items[index + 1]?.id || id;
    }
    return;
  }

  if (event.ctrlKey) {
    if (index === -1) return;
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

const onDragEnter = (event: DragEvent) => {
  event.preventDefault();
  isDragOver.value = true;
};

const onDragOver = (event: DragEvent) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
};

const onRowDragOver = (event: DragEvent, index: number) => {
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  const target = resolveDropTarget(event, index);
  dropTargetIndex.value = index;
  dropTargetSide.value = target.side;
};

const onRowDrop = async (event: DragEvent, index: number) => {
  event.preventDefault();
  event.stopPropagation();
  isDragOver.value = false;
  const target = resolveDropTarget(event, index);
  await completeExternalDrop(target.insertIndex);
};

const onDragLeave = (event: DragEvent) => {
  const relatedTarget = event.relatedTarget as Node | null;
  if (!(event.currentTarget as HTMLElement)?.contains(relatedTarget)) {
    isDragOver.value = false;
    clearDropTarget();
  }
};

const onDrop = async (event: DragEvent) => {
  event.preventDefault();
  isDragOver.value = false;
  if (!draggingItem.value) return;
  await completeExternalDrop(dropTargetIndex.value ?? undefined);
};

const typeIcon = (type: RundownItem['type']) => ({ video: '🎬', live: '📹', graphic: '🎨', gap: '⏱' }[type] || '📄');
const typeColor = (type: RundownItem['type']) => ({ video: '#33becc', live: '#e63946', graphic: '#a8dadc', gap: '#df8e1d' }[type] || '#aaa');

const msToClockDisplay = (ms: number) => {
  if (ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const msToShortDisplay = (ms: number) => {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

const durationLabel = (item: RundownItem) => {
  if (item.type === 'gap') return 'Ghost marker';
  const durationMs = effectiveDurationMs(item, store.activeItems.findIndex((candidate) => candidate.id === item.id));
  if (durationMs > 0) return `00:00:00 / ${msToClockDisplay(durationMs)}`;
  if (item.type === 'live') return 'LIVE';
  return '00:00:00 / 00:00:00';
};

const activeTimerLabel = (item: RundownItem, index: number) => {
  if (item.type === 'gap') return '';
  if (index !== store.currentPlayingIndex || !isPlayoutPlaying.value || !store.isCurrentPlaylistOnAir) return '';
  const totalMs = effectiveDurationMs(item, index);
  if (item.type === 'live' && totalMs <= 0) return `${msToClockDisplay(currentPlayoutMs.value)} / LIVE`;
  if (totalMs <= 0) return `${msToClockDisplay(currentPlayoutMs.value)} / 00:00:00`;
  return `${msToClockDisplay(currentPlayoutMs.value)} / ${msToClockDisplay(totalMs)}`;
};

const ratingClass = (rating: string) => `rating-${rating || 'none'}`;

const isProtectedPlayingRow = (index: number) => store.isCurrentPlaylistOnAir && index === store.currentPlayingIndex;

const ratingToneClass = (rating: RundownItem['complianceRating']) => `tone-rating-${rating || 'none'}`;
const indicatorToneClass = (indicator?: LibraryIndicator) => `tone-tag-${indicator || 'none'}`;
const indicatorLabel = (indicator?: LibraryIndicator) => ({
  spot: 'SPOT',
  telemarketing: 'TMK',
  none: ''
}[indicator || 'none']);

const rowSignals = (item: RundownItem) => {
  const signals: Array<{ key: string; className: string; title: string }> = [];
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

const resolveDropTarget = (event: DragEvent, index: number) => {
  const row = event.currentTarget as HTMLElement | null;
  if (!row) {
    return { insertIndex: index, side: 'before' as const };
  }
  const rect = row.getBoundingClientRect();
  const side = event.clientY > rect.top + rect.height / 2 ? 'after' as const : 'before' as const;
  return {
    insertIndex: side === 'after' ? index + 1 : index,
    side
  };
};

const buildDroppedPayload = async () => {
  if (!draggingItem.value) return null;
  const payload = { ...draggingItem.value };
  if (payload.type === 'video' && !(payload.duration > 0) && payload.path && !/^https?:/i.test(payload.path)) {
    try {
      const metadata = await invoke<{ duration: string }>('scan_media', { filepath: payload.path });
      const seconds = Number.parseFloat(metadata.duration || '0');
      if (Number.isFinite(seconds) && seconds > 0) {
        payload.duration = seconds;
      }
    } catch (error) {
      console.warn('[Rundown] Failed to resolve dropped item duration before insert', payload.path, error);
    }
  }
  return payload;
};

const completeExternalDrop = async (insertIndex?: number) => {
  const payload = await buildDroppedPayload();
  if (!payload) return;

  if (typeof insertIndex === 'number') {
    store.insertItemAt(insertIndex, payload as any);
  } else {
    store.addItem(payload as any);
  }

  const insertedIndex = typeof insertIndex === 'number'
    ? Math.max(0, Math.min(insertIndex, store.activeItems.length - 1))
    : store.activeItems.length - 1;
  const insertedItem = store.activeItems[insertedIndex];
  if (insertedItem && payload.type === 'video' && !(payload.duration > 0) && payload.path && !/^https?:/i.test(payload.path)) {
    hydrateSingleItemDuration(insertedItem.id, payload.path).catch(() => {});
  }

  draggingItem.value = null;
  clearDropTarget();
};

const trimDisplay = (item: RundownItem) => {
  if (item.type === 'gap') return item.hardStartTime || 'GAP';
  if (item.type === 'live') return 'LIVE';
  if (!item.inPoint && !item.outPoint) return 'FULL';
  const inLabel = item.inPoint ? msToShortDisplay(item.inPoint) : '0:00';
  const outLabel = item.outPoint ? msToShortDisplay(item.outPoint) : 'END';
  return `${inLabel}→${outLabel}`;
};

onMounted(() => {
  hydrateMissingDurations().catch((error) => {
    console.warn('[Rundown] Initial duration hydration failed', error);
  });

  if (rundownListRef.value) {
    sortableInstance = Sortable.create(rundownListRef.value, {
      animation: 120,
      ghostClass: 'rw-ghost',
      handle: '.rw-handle',
      onEnd: (evt) => {
        if (evt.oldIndex !== undefined && evt.newIndex !== undefined && evt.oldIndex !== evt.newIndex) {
          store.reorderItems(evt.oldIndex, evt.newIndex);
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
</script>

<template>
  <div class="rundown-wrapper">
    <!-- Header with clock -->
    <div class="rw-header">
      <div style="display:flex; align-items:center; gap:10px;">
        <h2 class="text-warning" style="margin:0; font-size:0.9rem;">{{ store.currentPlaylistName }}</h2>
        <span v-if="store.isCurrentPlaylistOnAir" class="playing-badge">▶ ON AIR</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="clock-display">{{ clockStr }}</span>
        <button class="icon-action" @click="showLiveDialog = true" title="Add Live Entry">📹 Live</button>
        <button v-if="isPlayoutPlaying" class="icon-action btn-stop" @click="stopPlayback" title="Stop">■ Stop</button>
      </div>
    </div>

    <div class="playlist-tabs-row">
      <button
        v-for="playlist in store.playlists"
        :key="playlist.id"
        class="playlist-tab"
        :class="{ 'is-active': playlist.id === store.activePlaylistId, 'is-onair': playlist.id === store.onAirPlaylistId }"
        @click="store.activatePlaylist(playlist.id)"
        @dblclick.stop="renamePlaylistTab(playlist as RundownPlaylist)"
      >
        <span class="playlist-tab-name">{{ playlist.name }}</span>
        <span class="playlist-tab-state">{{ playlist.id === store.onAirPlaylistId ? 'ON AIR' : 'OFFLINE' }}</span>
        <button
          v-if="store.playlists.length > 1 && playlist.id !== store.onAirPlaylistId"
          class="playlist-tab-close"
          @click.stop="closePlaylistTab(playlist as RundownPlaylist)"
          title="Close playlist"
        >
          ×
        </button>
      </button>
      <button class="playlist-add-btn" @click="createPlaylistTab" title="Create new offline playlist">+</button>
    </div>

    <!-- Column labels -->
    <div class="rw-cols-label">
      <span style="width:18px;"></span>
      <span style="width:20px; text-align:center;">#</span>
      <span style="width:18px;"></span>
      <span style="width:18px;"></span>
      <span style="flex:1;">File / Source</span>
      <span style="width:46px; text-align:center;">Rate</span>
      <span style="width:58px; text-align:center;">Tag</span>
      <span style="width:78px; text-align:center;">IN→OUT</span>
      <span style="width:168px; text-align:right;">Time</span>
      <span style="width:42px; text-align:center;">Day</span>
      <span style="width:60px; text-align:center;">At</span>
      <span style="width:62px; text-align:center;">Actions</span>
    </div>

    <!-- List -->
    <div
      class="rw-list custom-scroll"
      ref="rundownListRef"
      :class="{ 'drag-over': isDragOver }"
      @dragenter.prevent="onDragEnter"
      @dragover.prevent="onDragOver"
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
    >
      <div
        v-for="(item, index) in store.activeItems"
        :key="item.id"
        class="rw-row"
        :data-item-id="item.id"
        :class="{
          'selected': item.id === store.selectedItemId,
          'playing': index === store.currentPlayingIndex && store.isCurrentPlaylistOnAir,
          'played': store.isCurrentPlaylistOnAir && index < store.currentPlayingIndex,
          'next-up': isNextUpRow(index),
          'next-up-imminent': isNextUpImminent(index),
          'drop-target-before': dropTargetIndex === index && dropTargetSide === 'before',
          'drop-target-after': dropTargetIndex === index && dropTargetSide === 'after',
          'gap-line': item.type === 'gap',
          [ratingClass(item.complianceRating)]: item.complianceRating && item.complianceRating !== 'none'
        }"
        :style="index === store.currentPlayingIndex && isPlayoutPlaying && store.isCurrentPlaylistOnAir && item.type !== 'live' && item.type !== 'gap' ? {
            background: `linear-gradient(90deg, rgba(230,57,70,0.3) ${calcProgress(item)}%, rgba(230,57,70,0.08) ${calcProgress(item)}%)`,
            borderColor: 'rgba(230,57,70,0.4)'
        } : {}"
        @click="store.selectedItemId = item.id"
        @contextmenu.prevent="onContextMenu($event, index, item)"
        @dragover="onRowDragOver($event, index)"
        @drop="onRowDrop($event, index)"
      >
        <div class="rw-handle" :title="item.type === 'gap' ? 'Drag to move gap line' : 'Drag to reorder'">⋮⋮</div>
        <div class="rw-num">{{ item.type === 'gap' ? '⏱' : index + 1 }}</div>
        <div class="rw-signals">
          <span v-for="signal in rowSignals(item)" :key="signal.key" class="rw-signal" :class="signal.className" :title="signal.title"></span>
        </div>
        <div class="rw-type-icon" :style="{ color: typeColor(item.type) }">{{ typeIcon(item.type) }}</div>
        <div class="rw-name" :title="item.filename">{{ item.filename }}</div>
        <div class="rw-rating">
          <span v-if="item.complianceRating && item.complianceRating !== 'none'" class="rw-rating-badge" :class="ratingClass(item.complianceRating)">{{ item.complianceRating.toUpperCase() }}</span>
          <span v-else class="rw-rating-empty">·</span>
        </div>
        <div class="rw-tag">
          <span v-if="item.libraryIndicator && item.libraryIndicator !== 'none'" class="rw-tag-badge" :class="indicatorToneClass(item.libraryIndicator)">{{ indicatorLabel(item.libraryIndicator) }}</span>
          <span v-else class="rw-rating-empty">·</span>
        </div>
        <div class="rw-inout" :title="trimDisplay(item)">{{ trimDisplay(item) }}</div>

        <!-- Duration -->
        <div class="rw-dur">{{ activeTimerLabel(item, index) || durationLabel(item) }}</div>

        <div class="rw-day">
          <span class="tc-day">{{ scheduledTimes[index]?.dayLabel || '·' }}</span>
        </div>

        <div class="rw-at">
          <span v-if="scheduledTimes[index]?.kind === 'skip'" class="tc-done">–</span>
          <span v-else-if="scheduledTimes[index]?.kind === 'done'" class="tc-done">✓</span>
          <span v-else-if="scheduledTimes[index]?.kind === 'now'" class="tc-live">NOW</span>
          <span v-else-if="scheduledTimes[index]?.kind === 'gap'" class="tc-gap">{{ scheduledTimes[index]?.text }}</span>
          <span v-else-if="scheduledTimes[index]?.kind === 'time'" class="tc-sched">{{ scheduledTimes[index]?.text }}</span>
        </div>

        <!-- Row actions -->
        <div class="rw-actions">
          <button class="row-btn btn-play" :title="item.type === 'gap' ? 'Play next content after this gap line' : `Play from #${index+1}`" @click.stop="runPlaylistFrom(index)">▶</button>
          <button v-if="!isProtectedPlayingRow(index)" class="row-btn row-btn-del" title="Remove (Del)" @click.stop="store.removeItem(item.id)">✕</button>
        </div>
      </div>

      <div v-if="store.activeItems.length === 0" class="rw-empty">
        Drop media here or click 📹 Live
      </div>
    </div>

    <!-- Custom Context Menu for Rundown -->
    <Teleport to="body">
      <div v-if="contextMenu.show" class="context-menu" :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }">
        <div class="menu-item" @click.stop="ctxPlayFrom">▶ Play from here</div>
        <div class="menu-item" @click.stop="ctxDuplicate">⧉ Duplicate</div>
        <template v-if="contextMenu.item && contextMenu.item.type !== 'gap'">
          <div class="menu-divider"></div>
          <div class="menu-label">Rating</div>
          <div v-for="rating in ratingOptions" :key="`rating-${rating.id}`" class="menu-item" @click.stop="ctxSetRating(rating.id)">
            {{ contextMenu.item.complianceRating === rating.id ? '✓ ' : '' }}{{ rating.label }}
          </div>
          <div class="menu-divider"></div>
          <div class="menu-label">Tag</div>
          <div v-for="indicator in indicatorOptions" :key="`indicator-${indicator.id}`" class="menu-item" @click.stop="ctxSetIndicator(indicator.id)">
            {{ (contextMenu.item.libraryIndicator || 'none') === indicator.id ? '✓ ' : '' }}{{ indicator.label }}
          </div>
        </template>
        <div class="menu-divider"></div>
        <div v-if="!isProtectedPlayingRow(contextMenu.index)" class="menu-item menu-item-danger" @click.stop="ctxDelete">✕ Delete</div>
      </div>
    </Teleport>

    <PlaylistControls />

    <LiveEntryDialog v-if="showLiveDialog" @close="showLiveDialog = false" />
  </div>
</template>

<style scoped>
.rundown-wrapper { height:100%; display:flex; flex-direction:column; overflow:hidden; position:relative; }
.rw-header {
  padding:8px 12px; border-bottom:1px solid var(--glass-border);
  background: var(--bg-secondary);
  display:flex; justify-content:space-between; align-items:center; flex-shrink:0;
}
.clock-display {
  font-family:'Courier New',monospace; font-size:1.2rem; font-weight:700;
  letter-spacing:1.5px; color:var(--text-primary); text-shadow:0 0 10px var(--glass-border);
}
.playing-badge {
  background:rgba(230,57,70,0.2); border:1px solid rgba(230,57,70,0.5);
  color:#e63946; font-size:0.65rem; font-weight:700; letter-spacing:1px;
  padding:2px 6px; border-radius:3px; animation:blink 1.2s step-end infinite;
}
@keyframes blink { 50% { opacity:0.4; } }
.icon-action {
  background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12);
  color:var(--text-primary); border-radius:4px; padding:3px 7px; cursor:pointer; font-size:0.72rem;
}
.icon-action:hover { background:rgba(255,255,255,0.1); }
.btn-stop { border-color:rgba(230,57,70,0.4); color:#e63946; }

.playlist-tabs-row {
  display:flex;
  gap:6px;
  padding:8px 8px 6px;
  border-bottom:1px solid var(--glass-border);
  background:color-mix(in srgb, var(--bg-secondary) 92%, transparent);
  overflow-x:auto;
  flex-shrink:0;
}
.playlist-tab {
  display:flex;
  align-items:center;
  gap:8px;
  padding:7px 10px;
  border-radius:10px;
  border:1px solid var(--glass-border);
  background:color-mix(in srgb, var(--bg-tertiary) 78%, transparent);
  color:var(--text-primary);
  cursor:pointer;
  flex-shrink:0;
  min-width:140px;
}
.playlist-tab.is-active {
  border-color:color-mix(in srgb, var(--accent-blue) 40%, transparent);
  background:color-mix(in srgb, var(--accent-blue) 12%, var(--bg-secondary));
}
.playlist-tab.is-onair {
  border-color:rgba(230,57,70,0.45);
  box-shadow:0 0 0 1px rgba(230,57,70,0.14), 0 0 16px rgba(230,57,70,0.14);
  animation:pulseOnAir 1.5s ease-in-out infinite;
}
@keyframes pulseOnAir {
  0%, 100% { transform:translateY(0); box-shadow:0 0 0 1px rgba(230,57,70,0.14), 0 0 10px rgba(230,57,70,0.10); }
  50% { transform:translateY(-1px); box-shadow:0 0 0 1px rgba(230,57,70,0.22), 0 0 18px rgba(230,57,70,0.18); }
}
.playlist-tab-name {
  font-size:0.76rem;
  font-weight:700;
  max-width:150px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.playlist-tab-state {
  font-size:0.58rem;
  letter-spacing:0.08em;
  color:var(--text-secondary);
}
.playlist-tab-close {
  margin-left:auto;
  background:transparent;
  border:none;
  color:var(--text-secondary);
  cursor:pointer;
  font-size:0.85rem;
  line-height:1;
}
.playlist-add-btn {
  width:34px;
  border-radius:10px;
  border:1px dashed color-mix(in srgb, var(--accent-blue) 40%, transparent);
  background:color-mix(in srgb, var(--accent-blue) 8%, transparent);
  color:var(--accent-blue);
  font-size:1rem;
  font-weight:700;
  cursor:pointer;
  flex-shrink:0;
}

.rw-cols-label {
  display:flex; align-items:center; gap:4px; padding:4px 8px;
  font-size:0.6rem; letter-spacing:0.08em; color:rgba(255,255,255,0.3);
  border-bottom:1px solid rgba(255,255,255,0.05); flex-shrink:0;
}
.rw-list { flex:1; overflow-y:auto; padding:6px 5px 10px; min-height:0; transition:background 0.15s; }
.rw-list.drag-over { background:rgba(51,190,204,0.04); outline:2px dashed rgba(51,190,204,0.3); outline-offset:-3px; border-radius:6px; }

.rw-row {
  position:relative;
  display:flex; align-items:center; gap:4px;
  min-height:40px; padding:0 6px;
  margin:3px 0;
  border-radius:6px; border:1px solid transparent;
  contain:layout style paint;
  content-visibility:auto;
  contain-intrinsic-size:40px;
  cursor:pointer; user-select:none; transition:background 0.12s, border-color 0.12s, transform 0.12s, margin 0.12s;
}
.rw-row:hover { background:rgba(255,255,255,0.04); }
.rw-row.selected { background:rgba(51,190,204,0.08); border-color:rgba(51,190,204,0.3); }
.rw-row.playing  { background:rgba(230,57,70,0.08); border-color:rgba(230,57,70,0.4); }
.rw-row.played   { opacity:0.45; }
.rw-row.next-up {
  background:rgba(248,180,0,0.08);
  border-color:rgba(248,180,0,0.22);
}
.rw-row.next-up-imminent {
  animation:nextUpPulse 1s ease-in-out infinite;
}
.rw-row.drop-target-before,
.rw-row.drop-target-after {
  border-color:rgba(51,190,204,0.36);
}
.rw-row.drop-target-before {
  margin-top:12px;
}
.rw-row.drop-target-after {
  margin-bottom:12px;
}
.rw-row.drop-target-before::before,
.rw-row.drop-target-after::after {
  content:'';
  position:absolute;
  left:10px;
  right:10px;
  height:0;
  border-top:2px solid rgba(51,190,204,0.82);
  box-shadow:0 0 0 1px rgba(51,190,204,0.18), 0 0 14px rgba(51,190,204,0.18);
  pointer-events:none;
}
.rw-row.drop-target-before::before {
  top:-8px;
}
.rw-row.drop-target-after::after {
  bottom:-8px;
}
.rw-row.drop-target-before::after,
.rw-row.drop-target-after::before {
  content:'';
  position:absolute;
  left:10px;
  width:10px;
  height:10px;
  border-radius:999px;
  background:rgba(51,190,204,0.96);
  box-shadow:0 0 0 2px rgba(10,14,22,0.86), 0 0 10px rgba(51,190,204,0.28);
  pointer-events:none;
}
.rw-row.drop-target-before::after {
  top:-13px;
}
.rw-row.drop-target-after::before {
  bottom:-13px;
}
.rw-row.gap-line {
  border-style:dashed;
  border-color:rgba(223,142,29,0.26);
  background:rgba(223,142,29,0.08);
}
.rw-row.gap-line .rw-name,
.rw-row.gap-line .rw-dur,
.rw-row.gap-line .rw-inout {
  color:rgba(223,142,29,0.92);
  font-style:italic;
}
.rw-row.rating-k { box-shadow: inset 6px 0 0 rgba(101,194,83,0.82); }
.rw-row.rating-8 { box-shadow: inset 6px 0 0 rgba(119,217,89,0.88); }
.rw-row.rating-12 { box-shadow: inset 6px 0 0 rgba(255,166,77,0.88); }
.rw-row.rating-16 { box-shadow: inset 6px 0 0 rgba(164,112,255,0.88); }
.rw-row.rating-18 { box-shadow: inset 6px 0 0 rgba(230,57,70,0.95); }
@keyframes nextUpPulse {
  0%, 100% { background:rgba(248,180,0,0.08); box-shadow:0 0 0 0 rgba(248,180,0,0); }
  50% { background:rgba(248,180,0,0.18); box-shadow:0 0 0 1px rgba(248,180,0,0.28), 0 0 16px rgba(248,180,0,0.16); }
}

.rw-handle { color:rgba(255,255,255,0.2); cursor:grab; font-size:0.8rem; width:18px; text-align:center; flex-shrink:0; }
.rw-num     { width:20px; text-align:center; font-size:0.72rem; color:rgba(255,255,255,0.34); flex-shrink:0; }
.rw-signals { width:18px; display:flex; align-items:center; gap:3px; flex-shrink:0; }
.rw-signal {
  width:5px;
  height:17px;
  border-radius:999px;
  background:rgba(255,255,255,0.12);
  border:1px solid rgba(255,255,255,0.1);
}
.rw-type-icon { width:18px; font-size:0.92rem; text-align:center; flex-shrink:0; }
.rw-name    { flex:1; font-size:0.77rem; font-weight:600; letter-spacing:0.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.rw-rating  { width:46px; text-align:center; flex-shrink:0; }
.rw-tag     { width:58px; text-align:center; flex-shrink:0; }
.rw-rating-badge {
  display:inline-flex; align-items:center; justify-content:center;
  min-width:32px; padding:4px 8px; border-radius:999px;
  font-size:0.59rem; font-weight:800; letter-spacing:0.1em;
  border:1px solid rgba(255,255,255,0.14);
  box-shadow:0 0 0 1px rgba(255,255,255,0.04);
}
.rw-tag-badge {
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-width:40px;
  padding:4px 8px;
  border-radius:999px;
  font-size:0.55rem;
  font-weight:900;
  letter-spacing:0.11em;
  border:1px solid rgba(255,255,255,0.14);
  text-transform:uppercase;
}
.rw-rating-empty { color:rgba(255,255,255,0.16); font-size:0.7rem; }
.rw-rating-badge.rating-k, .rw-signal.tone-rating-k { color:#c8f7b6; background:rgba(101,194,83,0.22); border-color:rgba(101,194,83,0.38); }
.rw-rating-badge.rating-8, .rw-signal.tone-rating-8 { color:#d7ffbf; background:rgba(119,217,89,0.24); border-color:rgba(119,217,89,0.42); }
.rw-rating-badge.rating-12, .rw-signal.tone-rating-12 { color:#ffd188; background:rgba(255,166,77,0.22); border-color:rgba(255,166,77,0.38); }
.rw-rating-badge.rating-16, .rw-signal.tone-rating-16 { color:#e2c4ff; background:rgba(164,112,255,0.22); border-color:rgba(164,112,255,0.38); }
.rw-rating-badge.rating-18, .rw-signal.tone-rating-18 { color:#ffb0b0; background:rgba(230,57,70,0.24); border-color:rgba(230,57,70,0.4); }
.rw-tag-badge.tone-tag-spot, .rw-signal.tone-tag-spot { color:#ffd5a6; background:rgba(224,134,43,0.22); border-color:rgba(224,134,43,0.4); }
.rw-tag-badge.tone-tag-telemarketing, .rw-signal.tone-tag-telemarketing { color:#efc8ff; background:rgba(149,76,233,0.24); border-color:rgba(149,76,233,0.42); }
.rw-inout   {
  width:78px; text-align:center; flex-shrink:0;
  font-size:0.63rem; color:rgba(255,255,255,0.46); font-variant-numeric:tabular-nums; letter-spacing:0.03em;
}
.rw-dur     { width:168px; text-align:right; font-size:0.72rem; color:rgba(255,255,255,0.62); font-variant-numeric:tabular-nums; flex-shrink:0; font-family:monospace; letter-spacing:0.02em; }
.rw-day     { width:42px; display:flex; align-items:center; justify-content:flex-start; flex-shrink:0; }
.rw-at      { width:60px; display:flex; align-items:center; justify-content:flex-start; gap:4px; flex-shrink:0; }
.rw-actions { width:62px; display:flex; gap:2px; flex-shrink:0; justify-content:flex-end; }

.tc-day   { display:inline-block; min-width:2.2em; font-size:0.58rem; font-weight:700; text-transform:uppercase; color:rgba(255,255,255,0.4); letter-spacing:0.08em; text-align:left; }
.tc-sched { font-size:0.69rem; color:rgba(255,255,255,0.5); font-variant-numeric:tabular-nums; font-family:monospace; text-align:left; }
.tc-live  { font-size:0.69rem; color:#e63946; font-weight:700; letter-spacing:0.5px; }
.tc-done  { font-size:0.7rem; color:rgba(255,255,255,0.2); }
.tc-gap   { font-size:0.66rem; color:#df8e1d; font-family:monospace; text-align:left; }

.row-btn {
  background:transparent; border:1px solid rgba(255,255,255,0.1); color:rgba(255,255,255,0.45);
  border-radius:3px; cursor:pointer; width:20px; height:24px; font-size:0.74rem;
  display:flex; align-items:center; justify-content:center; transition:0.12s; padding:0;
}
.row-btn:hover { background:rgba(255,255,255,0.1); color:#fff; }
.btn-play { color:rgba(51,190,204,0.8); border-color:rgba(51,190,204,0.25); }
.btn-play:hover { background:rgba(51,190,204,0.15); color:#33becc; }
.row-btn-del:hover { background:rgba(230,57,70,0.15); border-color:rgba(230,57,70,0.4); color:#e63946; }

.rw-empty {
  display:flex; align-items:center; justify-content:center;
  height:80px; color:var(--text-secondary); font-size:0.78rem;
  border:2px dashed var(--glass-border); border-radius:6px; margin:4px;
  opacity: 0.5;
}
.rw-ghost { opacity:0.3; background:rgba(255,255,255,0.06); }

/* Context Menu */
.context-menu {
    position: absolute;
    background: var(--bg-secondary);
    border: 1px solid var(--glass-border);
    border-radius: 6px;
    padding: 4px 0;
    min-width: 160px;
    z-index: 9999;
    box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    backdrop-filter: blur(10px);
}
.menu-item {
    padding: 6px 12px;
    font-size: 0.8rem;
    color: var(--text-primary);
    cursor: pointer;
    transition: background 0.1s;
}
.menu-label {
  padding: 6px 12px 4px;
  font-size: 0.62rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.42);
}
.menu-item:hover {
    background: rgba(51, 190, 204, 0.2);
    color: #33becc;
}
.menu-item-danger:hover {
    background: rgba(230, 57, 70, 0.2);
    color: #e63946;
}
.menu-divider {
    height: 1px;
    background: var(--glass-border);
    margin: 4px 0;
}
</style>
