<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { useRundownStore, type ComplianceRating, type RundownItem, type RundownPlaylist, type InsertionTarget } from '../stores/rundown';
import type { LibraryIndicator } from '../stores/mediaDefaults';
import { draggingItem } from '../composables/useDragState';
import { registerRundownDropSurface, beginRundownDrag, indicatorGeometry, activeDragSession, refreshGeometrySnapshot, type DropSurface, type DragSession } from '../composables/useDragSession';
import { currentPlayoutMs, currentTotalPlayoutMs, getActivePlayoutService, isPlayoutPlaying, registerPlayoutAdvanceListener } from '../services/playout';
import LiveEntryDialog from './LiveEntryDialog.vue';
import PlaylistControls from './PlaylistControls.vue';
import ContextMenu, { type MenuItem, type TopAction } from './ContextMenu.vue';
import RundownRow from './RundownRow.vue';
import { useSettingsStore } from '../stores/settings';
import { toggleCrawlTicker, updateCrawlTickerText } from '../services/caspar';
import { formatClockTime } from '../utils/timeFormat';
import { activeScope } from '../composables/useOperatorShortcuts';
import { buildRowRectsFromDOM, calculatePointerDropTarget, toInsertionTarget, sameDropTarget, type TargetRowRect, type SemanticDropTarget, type ActiveDropTarget, type GeometrySnapshot } from '../lib/reorderHelper';

const store = useRundownStore();
const settings = useSettingsStore();

const rundownListRef = ref<HTMLElement | null>(null);
const focusList = () => rundownListRef.value?.focus({ preventScroll: true });

const isDragOver = ref(false);
const showLiveDialog = ref(false);
const activeDropTarget = ref<ActiveDropTarget>({ kind: 'none' });

const indicatorTarget = computed(() => {
  const target = activeDropTarget.value;
  if (target.kind === 'none') return null;
  if (target.kind === 'append') {
    return { index: store.activeItems.length, side: 'after' as const };
  }
  const idx = store.activeItems.findIndex(item => item.id === target.targetItemId);
  if (idx < 0) return null;
  return {
    index: target.kind === 'after' ? idx + 1 : idx,
    side: target.kind
  };
});
let scrollListenerActive = false;
let resizeObserver: ResizeObserver | null = null;
const durationHydrationInFlight = new Set<string>();
let crawlDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let structuralDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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

const clockStr = computed(() => formatClockTime(store.clockMs));

const itemDurationMs = (item: RundownItem): number => {
  if (item.type === 'gap') return 0;
  if (item.type === 'live') return (item.plannedDuration || item.duration || 0) * 1000;
  const totalMs = item.duration_ms || (item.duration ? item.duration * 1000 : 0);
  const inMs = item.trim_in_ms ?? item.inPoint ?? 0;
  const outMs = item.trim_out_ms ?? (item.outPoint > 0 ? item.outPoint : totalMs);
  if (outMs > inMs && inMs >= 0) return outMs - inMs;
  return totalMs;
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
  return store.activeItemsETAs.map((eta, index) => ({
    kind: eta.kind,
    text: eta.kind === 'gap' ? eta.label : 
          (eta.kind === 'now' ? store.nowDisplayTime : eta.formatted),
    dayLabel: eta.kind === 'now' ? store.nowDisplayDay : eta.dayLabel
  }));
});

const lockedPlayingDurationMs = ref(0);

watch(
  () => store.currentPlayingIndex,
  (newIndex) => {
    if (newIndex < 0) { lockedPlayingDurationMs.value = 0; return; }
    const item = store.activeItems[newIndex];
    if (item) lockedPlayingDurationMs.value = itemDurationMs(item);
  },
  { immediate: true }
);

const calcProgress = (item: RundownItem, index: number) => {
  if (index !== store.currentPlayingIndex) return 0;
  const locked = lockedPlayingDurationMs.value;
  const duration = locked > 0 ? locked : itemDurationMs(item);
  if (!duration || duration <= 0) return 0;
  return Math.max(0, Math.min(100, (currentPlayoutMs.value / duration) * 100));
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

registerPlayoutAdvanceListener((uuid) => {
  store.setOnAirPlayingItemById(uuid);
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

const structuralFingerprint = computed(() =>
  store.activeItems.map((item) =>
    `${item.id}:${item.type}:${item.path}:${item.inPoint}:${item.outPoint}:${item.playoutvueId ?? ''}`
  ).join('|')
);

const durationFingerprint = computed(() =>
  store.activeItems.map((item) =>
    `${item.id}:${item.duration}:${item.duration_ms ?? 0}`
  ).join('|')
);

watch(
  structuralFingerprint,
  () => {
    if (structuralDebounceTimer) clearTimeout(structuralDebounceTimer);
    structuralDebounceTimer = setTimeout(() => {
      if (isPlayoutPlaying.value && store.isCurrentPlaylistOnAir) {
        getActivePlayoutService().refreshQueue?.(store.getPlayableItems() as any).catch((error) => {
          console.error('[Playback] Failed to refresh rundown queue', error);
        });
      }
    }, 150);
  },
  { immediate: true }
);

watch(
  durationFingerprint,
  () => {
    hydrateMissingDurations().catch((error) => {
      console.warn('[Rundown] Duration hydration failed', error);
    });
  },
  { immediate: true }
);

watch(
  () => settings.cgCrawlText,
  () => {
  if (crawlDebounceTimer) clearTimeout(crawlDebounceTimer);
  if (structuralDebounceTimer) clearTimeout(structuralDebounceTimer);
    crawlDebounceTimer = setTimeout(() => {
      if (settings.cgCrawlActive) {
        updateCrawlTickerText().catch((err) => {
          console.error('[RundownList] Failed to update crawl text:', err);
        });
      }
    }, 300);
  }
);

watch(
  () => store.currentPlayingIndex,
  (newIndex) => {
    if (newIndex < 0 || !store.isCurrentPlaylistOnAir) return;
    const item = store.activeItems[newIndex];
    if (!item || item.type !== 'video' || item.outPoint > item.inPoint || item.duration > 0 || (item.duration_ms ?? 0) > 0) return;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      if (currentTotalPlayoutMs.value > 0) {
        clearInterval(interval);
        const seconds = currentTotalPlayoutMs.value / 1000;
        store.updateItem(item.id, {
          duration: seconds,
          plannedDuration: item.plannedDuration || seconds
        });
      } else if (attempts > 40) {
        clearInterval(interval);
      }
    }, 500);
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

const ctxDelete = async () => {
  if (contextMenu.value.item && !isProtectedPlayingRow(contextMenu.value.index)) {
    const confirmed = await ask(
      `Delete "${getDisplayName(contextMenu.value.item)}" from ${store.currentPlaylistName}?`,
      { title: 'Delete Item', kind: 'warning' }
    );
    if (!confirmed) { closeContextMenu(); return; }
    store.removeItem(contextMenu.value.item.id);
  }
  closeContextMenu();
};

const saveMetadata = async (playoutvueId: string | undefined, updates: { complianceRating?: ComplianceRating; tp_flag?: boolean; content_type?: 'movie' | 'show' | 'documentary' | 'news' | 'none' }, localItemId?: string) => {
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
] as const;

const ctxSetAgeRating = async (rating: ComplianceRating) => {
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

const ctxSetContentType = async (cType: 'movie' | 'show' | 'documentary' | 'news' | 'none') => {
  const item = contextMenu.value.item;
  if (item && item.type !== 'gap') {
    await saveMetadata(item.playoutvueId, { content_type: cType }, item.id);
  }
  closeContextMenu();
};

const ctxSetIndicator = (indicator: LibraryIndicator) => {
  if (contextMenu.value.item && contextMenu.value.item.type !== 'gap') {
    store.updateItem(contextMenu.value.item.id, { libraryIndicator: indicator });
  }
  closeContextMenu();
};

const topActionItems = computed<TopAction[]>(() => {
  const item = contextMenu.value.item;
  if (!item) return [];

  const isDeleteDisabled = isProtectedPlayingRow(contextMenu.value.index);
  
  return [
    {
      id: 'trim',
      tooltip: 'Trim (Unavailable)',
      action: () => {},
      disabled: true
    },
    {
      id: 'rename',
      tooltip: 'Rename (Unavailable)',
      action: () => {},
      disabled: true
    },
    {
      id: 'purge',
      tooltip: 'Purge (Unavailable)',
      action: () => {},
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

const menuItems = computed<MenuItem[]>(() => {
  const item = contextMenu.value.item;
  if (!item) return [];
  
  const list: MenuItem[] = [
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
    list.push(
      { type: 'divider' },
      {
        type: 'submenu',
        label: 'Age Ratings (Σήματα Καταλληλότητας)',
        children: ratingOptions.map(r => ({
          type: 'action',
          label: r.label,
          checked: item.complianceRating === r.id,
          action: () => ctxSetAgeRating(r.id)
        }))
      },
      { type: 'divider' },
      {
        type: 'toggle',
        label: item.tp_flag ? '✓ TP (Active)' : '□ TP (None)',
        checked: item.tp_flag,
        action: ctxToggleTP
      },
      { type: 'divider' },
      {
        type: 'submenu',
        label: 'Categories/Tags',
        children: contentTypeOptions.map(ct => ({
          type: 'action',
          label: ct.label,
          checked: (item.content_type || 'none') === ct.id,
          action: () => ctxSetContentType(ct.id)
        }))
      },
      { type: 'divider' },
      {
        type: 'submenu',
        label: 'Legacy Tags',
        children: indicatorOptions.map(ind => ({
          type: 'action',
          label: ind.label,
          checked: (item.libraryIndicator || 'none') === ind.id,
          action: () => ctxSetIndicator(ind.id)
        }))
      }
    );
  }
  
  return list;
});


let scrollFrame: number | null = null;

function scheduleSelectedRowReveal() {
  if (scrollFrame !== null) {
    cancelAnimationFrame(scrollFrame);
  }

  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;

    nextTick(() => {
      const selectedId = store.selectedItemId;
      if (!selectedId) return;

      const row = rundownListRef.value?.querySelector<HTMLElement>(
        `[data-item-id="${CSS.escape(selectedId)}"]`
      );

      row?.scrollIntoView({
        block: 'nearest',
        behavior: 'auto',
      });
    });
  });
}

watch(
  () => store.selectedItemId,
  () => {
    scheduleSelectedRowReveal();
  },
  { immediate: true }
);

const moveSelectionDelta = (delta: number) => {
  const items = store.activeItems;
  if (!items.length) return;

  const currentIndex = store.selectedItemId
    ? items.findIndex((item) => item.id === store.selectedItemId)
    : -1;

  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = delta > 0 ? 0 : items.length - 1;
  } else {
    nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + delta));
  }

  if (!items[nextIndex]) return;

  store.selectedItemId = items[nextIndex]!.id;
};

const moveSelection = (direction: -1 | 1) => {
  moveSelectionDelta(direction);
};

const createPlaylistTab = () => {
  store.createPlaylist();
};

const renamePlaylistTab = (playlist: RundownPlaylist) => {
  const value = window.prompt('Rename playlist', playlist.name);
  if (!value) return;
  store.renamePlaylist(playlist.id, value);
};

const closePlaylistTab = async (playlist: RundownPlaylist) => {
  if (playlist.items.length > 0) {
    const confirmed = await ask(
      `Close playlist "${playlist.name}" with ${playlist.items.length} item${playlist.items.length === 1 ? '' : 's'}?`,
      { title: 'Close Playlist', kind: 'warning' }
    );
    if (!confirmed) return;
  }
  store.closePlaylist(playlist.id);
};

const msToClockDisplay = (ms: number) => {
  if (ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const durationLabel = (item: RundownItem, index: number) => {
  if (item.type === 'gap') return 'Ghost marker';
  const durationMs = effectiveDurationMs(item, index);
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

const isProtectedPlayingRow = (index: number) => store.isCurrentPlaylistOnAir && index === store.currentPlayingIndex;

const deleteRowItem = async (item: RundownItem, index: number) => {
  if (isProtectedPlayingRow(index)) return;
  const confirmed = await ask(
    `Delete "${getDisplayName(item)}" from ${store.currentPlaylistName}?`,
    { title: 'Delete Item', kind: 'warning' }
  );
  if (confirmed) store.removeItem(item.id);
};

// Per-row values for <RundownRow> props. Each helper is also listed in the
// v-memo array below, so a row only re-renders when its own values change.
const rowIsSelected = (item: RundownItem) => item.id === store.selectedItemId;
const rowIsPlaying = (item: RundownItem, index: number) =>
  item.id === store.currentPlayingInstanceId || (index === store.currentPlayingIndex && store.isCurrentPlaylistOnAir);
const rowIsPlayed = (index: number) => store.isCurrentPlaylistOnAir && index < store.currentPlayingIndex;
const rowProgressTone = (item: RundownItem, index: number): '' | 'green' | 'red' => {
  if (item.id === store.currentPlayingInstanceId) return 'green';
  if (index === store.currentPlayingIndex && isPlayoutPlaying.value && store.isCurrentPlaylistOnAir && item.type !== 'live' && item.type !== 'gap') return 'red';
  return '';
};
const rowProgressPct = (item: RundownItem, index: number): number => {
  const tone = rowProgressTone(item, index);
  if (tone === 'green') return store.playbackProgressPct;
  if (tone === 'red') return calcProgress(item, index);
  return 0;
};
const rowCountdown = (item: RundownItem) => (item.id === store.currentPlayingInstanceId ? store.playbackCountdownStr : '');
const rowTimerLabel = (item: RundownItem, index: number) => activeTimerLabel(item, index) || durationLabel(item, index);
const rowEtaHint = (index: number) => store.activeItemsETAs[index]?.formatted || '';
const rowDayLabel = (index: number) => scheduledTimes.value[index]?.dayLabel || '·';
const rowAtKind = (index: number): '' | 'done' | 'now' | 'gap' | 'time' =>
  (scheduledTimes.value[index]?.kind as 'done' | 'now' | 'gap' | 'time' | undefined) || '';
const rowAtText = (index: number) => {
  const eta = scheduledTimes.value[index];
  return eta && (eta.kind === 'gap' || eta.kind === 'time') ? eta.text || '' : '';
};
const rowPlayProtected = (index: number) => isProtectedPlayingRow(index);

const onRowSelect = (item: RundownItem, event?: MouseEvent) => {
  store.selectItem(item.id, { multi: event?.ctrlKey || event?.metaKey, range: event?.shiftKey });
  focusList();
};

const indicatorStyle = computed(() => {
  const geom = indicatorGeometry.value;
  if (!geom || !geom.visible) return null;
  return {
    top: `${geom.top}px`,
    left: `${geom.left}px`,
    width: `${geom.width}px`
  };
});

const indicatorLabel = computed(() => indicatorGeometry.value?.label || '');
const indicatorIsAppend = computed(() => indicatorGeometry.value?.isAppend || false);

let activeResizeObserver: ResizeObserver | null = null;

function detachDragObservers() {
  if (rundownListRef.value) {
    rundownListRef.value.removeEventListener('scroll', refreshGeometrySnapshot);
  }
  if (activeResizeObserver) {
    activeResizeObserver.disconnect();
    activeResizeObserver = null;
  }
}

function attachDragObservers() {
  detachDragObservers();
  if (rundownListRef.value) {
    rundownListRef.value.addEventListener('scroll', refreshGeometrySnapshot, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      activeResizeObserver = new ResizeObserver(() => {
        refreshGeometrySnapshot();
      });
      activeResizeObserver.observe(rundownListRef.value);
    }
  }
}

watch(
  () => activeDragSession.value?.phase,
  (phase) => {
    if (phase === 'dragging') {
      attachDragObservers();
    } else {
      detachDragObservers();
    }
  }
);

const getDisplayName = (item: RundownItem) => {
  if (item.display_name) return item.display_name;
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

const onRowHandlePointerDown = (event: PointerEvent, item: RundownItem) => {
  if (event.button !== 0) return;
  const selected = store.selectedItemIds.length > 0
    ? store.selectedItemIds
    : (store.selectedItemId ? [store.selectedItemId] : []);

  const movingItemIds = selected.includes(item.id)
    ? store.activeItems.filter(i => selected.includes(i.id)).map(i => i.id)
    : [item.id];

  beginRundownDrag({
    pointerId: event.pointerId,
    event,
    movingItemIds
  });
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

// Fallback HTML5 drop handler strictly for external OS file drops
const onExternalFileDrop = async (event: DragEvent) => {
  event.preventDefault();
  event.stopPropagation();
  isDragOver.value = false;

  if (draggingItem.value) return; // Ignore internal drags here

  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file && (file as any).path) {
      store.addItem({
        filename: file.name,
        path: (file as any).path,
        shortPath: '',
        libraryIndicator: undefined as any,
        type: 'video',
        duration: 0,
        seek: 0,
        length: 0
      });
    }
  }
};

let unregisterSurface: (() => void) | null = null;

watch(
  () => store.activeItems.length,
  () => {
    refreshGeometrySnapshot();
  }
);

onMounted(() => {
  hydrateMissingDurations().catch((error) => {
    console.warn('[Rundown] Initial duration hydration failed', error);
  });
  window.addEventListener('click', closeContextMenu);

  unregisterSurface = registerRundownDropSurface({
    getSnapshot() {
      const containerRect = rundownListRef.value
        ? rundownListRef.value.getBoundingClientRect()
        : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };

      const endZoneEl = rundownListRef.value?.querySelector('.rundown-end-drop-zone');
      const endZoneRect = endZoneEl ? endZoneEl.getBoundingClientRect() : undefined;

      return {
        rowRects: buildRowRectsFromDOM(rundownListRef.value),
        containerRect,
        endZoneRect,
        scrollTop: rundownListRef.value?.scrollTop || 0
      };
    },
    getContainerRect() {
      return rundownListRef.value
        ? rundownListRef.value.getBoundingClientRect()
        : new DOMRect();
    },
    async commit(target: ActiveDropTarget, session: DragSession) {
      if (target.kind === 'none') return;
      const insertionTarget = (target.kind === 'before' || target.kind === 'after')
        ? { kind: target.kind, targetItemId: target.targetItemId }
        : { kind: 'append' as const };

      if (session.source === 'library' && session.libraryPayload) {
        const payload = session.libraryPayload;
        const insertedIds = store.insertLibraryItems({
          items: [payload as any],
          target: insertionTarget
        });
        const firstId = insertedIds[0];
        if (firstId && payload.type === 'video' && !(payload.duration > 0) && payload.path && !/^https?:/i.test(payload.path)) {
          hydrateSingleItemDuration(firstId, payload.path).catch(() => {});
        }
      } else if (session.source === 'rundown') {
        if (session.movingItemIds.length > 0) {
          store.moveRundownItems({
            itemIds: session.movingItemIds,
            target: insertionTarget
          });
        }
      }
    },
    clearIndicator() {
      // Handled reactively
    }
  });
});

onUnmounted(() => {
  detachDragObservers();
  if (unregisterSurface) {
    unregisterSurface();
    unregisterSurface = null;
  }
  if (scrollFrame !== null) {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
  }
  if (crawlDebounceTimer) clearTimeout(crawlDebounceTimer);
  window.removeEventListener('click', closeContextMenu);
});

</script>

<template>
  <div class="rundown-wrapper">
    <!-- Header with clock -->
    <div class="rw-header">
      <div style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
        <h2 class="text-warning" style="margin:0; font-size:0.9rem;">{{ store.currentPlaylistName }}</h2>
        <span v-if="store.isCurrentPlaylistOnAir" class="playing-badge">▶ ON AIR</span>
      </div>

      <!-- On-Demand Crawl Ticker Input/Toggle in Header -->
      <div class="crawl-controls" style="display:flex; align-items:center; gap:8px; flex:1; max-width:400px; margin:0 15px;">
        <input 
          type="text" 
          v-model="settings.cgCrawlText" 
          placeholder="Enter news crawl ticker text..." 
          class="crawl-input"
          title="On-Demand Crawl Text (live update on type)"
        />
        <button 
          class="crawl-btn" 
          :class="{ 'is-active': settings.cgCrawlActive }"
          @click="toggleCrawlTicker"
          title="Toggle On-Demand Ticker Overlay"
        >
          <span class="crawl-btn-dot"></span>
          ON-DEMAND CRAWL
        </button>
      </div>

      <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
        <span class="clock-display">{{ clockStr }}</span>
        <button class="icon-action" @click="showLiveDialog = true" title="Add Live Entry">📹 Live</button>
        <button v-if="isPlayoutPlaying" class="icon-action btn-stop" @click="stopPlayback" title="Stop">■ Stop</button>
      </div>
    </div>

    <!-- Trim Duration Warning Banner -->
    <div v-if="store.lastTrimWarning" class="trim-warning-banner" role="status">
      <span class="tw-icon">⚠️</span>
      <span class="tw-msg">
        Duration updated for <strong>{{ store.lastTrimWarning.filename }}</strong>: 
        Playlist total time adjusted by 
        <span :class="store.lastTrimWarning.deltaSeconds >= 0 ? 'tw-pos' : 'tw-neg'">
          {{ store.lastTrimWarning.deltaSeconds >= 0 ? '+' : '' }}{{ store.lastTrimWarning.deltaSeconds.toFixed(1) }}s
        </span>.
      </span>
      <button class="tw-dismiss" @click="store.dismissTrimWarning()" title="Dismiss warning">×</button>
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
      data-command-scope="rundown"
      role="listbox"
      aria-multiselectable="true"
      tabindex="0"
      aria-label="Playlist rundown"
      :class="{ 'drag-over': isDragOver }"
      @focus="activeScope = 'rundown'"
      @click="focusList"
      @dragover.prevent
      @drop.prevent="onExternalFileDrop"
    >
      <div
        v-for="(item, index) in store.activeItems"
        :key="item.id"
        class="rw-row-container"
        :data-item-id="item.id"
        v-memo="[
          item,
          index,
          rowIsSelected(item),
          rowIsPlaying(item, index),
          rowIsPlayed(index),
          isNextUpRow(index),
          isNextUpImminent(index),
          rowProgressPct(item, index),
          rowProgressTone(item, index),
          rowCountdown(item),
          rowTimerLabel(item, index),
          rowEtaHint(index),
          rowDayLabel(index),
          rowAtKind(index),
          rowAtText(index),
          rowPlayProtected(index)
        ]"
      >
        <RundownRow
          :item="item"
          :index="index"
          :selected="rowIsSelected(item)"
          :playing="rowIsPlaying(item, index)"
          :played="rowIsPlayed(index)"
          :next-up="isNextUpRow(index)"
          :next-up-imminent="isNextUpImminent(index)"
          :progress-pct="rowProgressPct(item, index)"
          :progress-tone="rowProgressTone(item, index)"
          :countdown="rowCountdown(item)"
          :timer-label="rowTimerLabel(item, index)"
          :eta-hint="rowEtaHint(index)"
          :day-label="rowDayLabel(index)"
          :at-kind="rowAtKind(index)"
          :at-text="rowAtText(index)"
          :play-protected="rowPlayProtected(index)"
          @select="onRowSelect(item, $event)"
          @contextmenu="onContextMenu($event, index, item)"
          @pointerdown-handle="onRowHandlePointerDown($event, item)"
          @play="runPlaylistFrom(index)"
          @delete="deleteRowItem(item, index)"
        />
      </div>

      <!-- End Drop Zone -->
      <div
        class="rundown-end-drop-zone"
        :class="{ 'is-active': activeDragSession?.dropTarget.kind === 'append' }"
        data-drop-position="end"
        aria-hidden="true"
      >
        <div class="end-drop-indicator-line"></div>
        <span class="end-drop-badge">Append to end</span>
      </div>

      <div v-if="store.activeItems.length === 0" class="rw-empty">
        Drop media here or click 📹 Live
      </div>
    </div>

    <!-- Fixed Overlay Drop Indicator -->
    <Teleport to="body">
      <div
        v-if="indicatorStyle"
        class="rw-fixed-drop-indicator"
        :class="{ 'is-append': indicatorIsAppend }"
        :style="indicatorStyle"
        aria-hidden="true"
      >
        <div class="rw-indicator-line"></div>
        <div class="rw-indicator-dot"></div>
        <span class="rw-indicator-badge">{{ indicatorLabel }}</span>
      </div>
    </Teleport>

    <!-- Custom Context Menu for Rundown -->
    <Teleport to="body">
      <ContextMenu
        v-if="contextMenu.show"
        :x="contextMenu.x"
        :y="contextMenu.y"
        :top-actions="topActionItems"
        :items="menuItems"
        @close="closeContextMenu"
      />
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
.trim-warning-banner {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; font-size: 0.78rem; color: #fef08a;
  background: linear-gradient(90deg, rgba(234, 179, 8, 0.25) 0%, rgba(202, 138, 4, 0.15) 100%);
  border-bottom: 1px solid rgba(234, 179, 8, 0.4);
  flex-shrink: 0; animation: fadeIn 0.2s ease-out;
}
.tw-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tw-pos { color: #4ade80; font-weight: 700; }
.tw-neg { color: #f87171; font-weight: 700; }
.tw-dismiss {
  background: transparent; border: none; color: #fef08a;
  font-size: 1.1rem; cursor: pointer; padding: 0 4px; border-radius: 3px;
  line-height: 1;
}
.tw-dismiss:hover { background: rgba(255, 255, 255, 0.15); }
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
.rw-list { flex:1; overflow-y:auto; padding:6px 5px 10px; min-height:0; transition:background 0.15s; contain:strict; }
.rw-list.drag-over { background:rgba(51,190,204,0.04); outline:2px dashed rgba(51,190,204,0.3); outline-offset:-3px; border-radius:6px; }

/* Sortable ghost clone of the row host wrapper (rows themselves style in RundownRow.vue). */
.rw-ghost { opacity:0.3; background:rgba(255,255,255,0.06); }

.rw-empty {
  display:flex; align-items:center; justify-content:center;
  height:80px; color:var(--text-secondary); font-size:0.78rem;
  border:2px dashed var(--glass-border); border-radius:6px; margin:4px;
  opacity: 0.5;
}

/* On-Demand Crawl Styling */
.crawl-input {
  flex: 1;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--glass-border);
  color: var(--text-primary);
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 0.8rem;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
  min-width: 120px;
}
.crawl-input:focus {
  border-color: var(--accent-blue);
  box-shadow: 0 0 8px rgba(51, 190, 204, 0.2);
}
.crawl-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.3s ease;
  white-space: nowrap;
}
.crawl-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}
.crawl-btn.is-active {
  background: rgba(230, 57, 70, 0.15);
  border-color: rgba(230, 57, 70, 0.5);
  color: #ff4d5a;
  box-shadow: 0 0 12px rgba(230, 57, 70, 0.3);
  text-shadow: 0 0 8px rgba(230, 57, 70, 0.5);
}
.crawl-btn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-secondary);
  transition: all 0.3s ease;
}
.crawl-btn:hover .crawl-btn-dot {
  background: var(--text-primary);
}
.crawl-btn.is-active .crawl-btn-dot {
  background: #ff4d5a;
  box-shadow: 0 0 8px #ff4d5a;
  animation: pulse-dot 1.2s infinite;
}
@keyframes pulse-dot {
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.4); opacity: 0.6; }
  100% { transform: scale(1); opacity: 1; }
}

.rw-list:focus-visible {
  outline: 2px solid #00e5ff;
  outline-offset: -2px;
}

.rundown-end-drop-zone {
  position: relative;
  height: 40px;
  margin: 6px 4px 12px 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed rgba(52, 64, 82, 0.6);
  border-radius: 6px;
  color: #64748b;
  font-size: 0.75rem;
  font-weight: 600;
  transition: all 0.15s ease;
  user-select: none;
}

.rundown-end-drop-zone.is-active {
  border-color: #00e5ff;
  background-color: rgba(0, 229, 255, 0.12);
  color: #00e5ff;
}

.end-drop-indicator-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: #00e5ff;
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.8);
  display: none;
}

.rundown-end-drop-zone.is-active .end-drop-indicator-line {
  display: block;
}

.rw-fixed-drop-indicator {
  position: fixed;
  pointer-events: none;
  user-select: none;
  z-index: 9999;
  height: 0;
  transition: none;
}
.rw-indicator-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: rgba(51, 190, 204, 0.9);
  box-shadow: 0 0 8px rgba(51, 190, 204, 0.6);
}
.rw-indicator-dot {
  position: absolute;
  top: -4px;
  left: -2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(51, 190, 204, 1);
  box-shadow: 0 0 6px rgba(51, 190, 204, 0.8);
}
.rw-indicator-badge {
  position: absolute;
  top: -10px;
  right: 0;
  background: #33becc;
  color: #0b0f19;
  font-size: 0.68rem;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  pointer-events: none;
  user-select: none;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
  white-space: nowrap;
}
.rw-fixed-drop-indicator.is-append .rw-indicator-badge {
  background: #00e5ff;
}
</style>
