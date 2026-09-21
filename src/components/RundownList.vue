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
import { usePlaylistFile } from '../composables/usePlaylistFile';
import ContextMenu, { type MenuItem, type MenuTone, type TopAction } from './ContextMenu.vue';
import { commercialTagBadge, commercialTagTone, contentTypeTone, ratingBadge, ratingTone } from '../lib/menuTones';
import AppIcon from './ui/AppIcon.vue';
import { vTooltip } from '../lib/tooltip';
import type { IconName } from './ui/icons';
import RundownRow from './RundownRow.vue';
import { useSettingsStore } from '../stores/settings';
import { toggleCrawlTicker, updateCrawlTickerText } from '../services/caspar';
import { formatClockTime } from '../utils/timeFormat';
import { useStudioClock } from '../composables/useStudioClock';
import { activeScope } from '../composables/useOperatorShortcuts';
import { buildRowRectsFromDOM, calculatePointerDropTarget, toInsertionTarget, sameDropTarget, type TargetRowRect, type SemanticDropTarget, type ActiveDropTarget, type GeometrySnapshot } from '../lib/reorderHelper';
import { GREEK_COMPLIANCE_PRESETS, GREEK_CONTENT_DESCRIPTORS, buildGreekAdvisoryText, parseDescriptorsFromText, type GreekCompliancePreset, type ContentDescriptorId } from '../lib/greekCompliance';
import EmptyState from './ui/EmptyState.vue';
import BaseButton from './ui/BaseButton.vue';
import DangerConfirm from './ui/DangerConfirm.vue';
import { showToast } from '../lib/toasts';

const store = useRundownStore();
const settings = useSettingsStore();

const rundownListRef = ref<HTMLElement | null>(null);
const focusList = () => rundownListRef.value?.focus({ preventScroll: true });

const isDragOver = ref(false);
const showLiveDialog = ref(false);

// §6.3: the header overflow that now owns Save / Load / Append / Clear.
const showPlaylistMenu = ref(false);
const {
  isSaving: isSavingPlaylist,
  isLoading: isLoadingPlaylist,
  pickPlaylistPath,
  clearRundown: clearPlaylistFile,
} = usePlaylistFile();

const runPlaylistFileAction = (action: 'save' | 'load' | 'append') => {
  showPlaylistMenu.value = false;
  void pickPlaylistPath(action);
};

const closePlaylistMenu = () => {
  showPlaylistMenu.value = false;
};

/**
 * §5.4: the registry's three playlist commands only announce themselves; the
 * dialogs and the store writes live here, beside the buttons that do the same
 * thing, so there is one implementation of each verb rather than two.
 */
const onPlaylistFileShortcut = (event: Event) => {
  const action = (event as CustomEvent<{ action: 'save' | 'load' | 'append' }>).detail?.action;
  if (action) runPlaylistFileAction(action);
};

/**
 * Escape disarms before anything else sees the key, but only while something
 * is armed -- otherwise it would swallow the Escape that clears the rundown
 * selection.
 */
const onDeleteArmEscape = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || !deleteArmedPlaylistId.value) return;
  event.preventDefault();
  event.stopPropagation();
  disarmDelete();
};

const runClearRundown = () => {
  showPlaylistMenu.value = false;
  void clearPlaylistFile();
};

/* ---------------------------------------------------------------------------
   §5.2 — Delete playlist, armed.

   The three file buttons came back to the header because the operator uses
   them constantly; Delete is new, because there was no delete-playlist control
   at all -- only the tab's `x` and "Clear playlist…" in the overflow, which do
   two different things under names that sound alike.

   Delete follows the pattern the operator already knows from CUT TO LIVE:
   click to arm, click to confirm, auto-disarm. The arm state is what makes it
   fool-proof -- not the dialog. A modal alone is dismissed by reflex, and its
   OK button is where the eyes land. Arming instead marks the *target*: the tab
   is struck through and outlined in red and the list behind it goes red, so
   what the operator is looking at when they click the second time is the thing
   that will go.
   --------------------------------------------------------------------------- */

/** How long the armed state stays live, in ms. */
const DELETE_ARM_MS = 4000;

const deleteArmedPlaylistId = ref<string | null>(null);
const deleteArmRemaining = ref(0);
let deleteArmTimer: ReturnType<typeof setTimeout> | null = null;
let deleteArmTick: ReturnType<typeof setInterval> | null = null;

/** 0 … 1, for the conic-gradient sweep. Same treatment as the live cut. */
const deleteArmProgress = computed(() =>
  deleteArmRemaining.value > 0 ? deleteArmRemaining.value / DELETE_ARM_MS : 0
);

const isDeleteArmed = computed(
  () => !!deleteArmedPlaylistId.value && deleteArmedPlaylistId.value === store.activePlaylistId
);

const disarmDelete = () => {
  if (deleteArmTimer) {
    clearTimeout(deleteArmTimer);
    deleteArmTimer = null;
  }
  if (deleteArmTick) {
    clearInterval(deleteArmTick);
    deleteArmTick = null;
  }
  deleteArmRemaining.value = 0;
  deleteArmedPlaylistId.value = null;
};

/**
 * Why the control is off, in the operator's words, or '' when it is live.
 * A disabled control that cannot say why is the defect this round set out to
 * remove from the library toolbar; it is not going to be reintroduced here.
 */
const deleteDisabledReason = computed(() => {
  if (store.activePlaylistId === store.onAirPlaylistId) {
    return "Can't delete the ON AIR playlist — stop playout or switch tabs";
  }
  if (store.playlists.length <= 1) {
    return "Can't delete the last playlist — clear its items instead";
  }
  return '';
});

const activePlaylistItemCount = computed(
  () => store.playlists.find((playlist) => playlist.id === store.activePlaylistId)?.items.length ?? 0
);

const deleteArmLabel = computed(() => {
  const count = activePlaylistItemCount.value;
  return `Delete "${store.currentPlaylistName}" · ${count} item${count === 1 ? '' : 's'} — click again`;
});

const pendingDeleteConfirm = ref(false);

const performDeletePlaylist = (playlistId: string) => {
  const removed = store.closePlaylist(playlistId);
  if (!removed) return;
  const count = removed.playlist.items.length;
  showToast(`Deleted "${removed.playlist.name}" · ${count} item${count === 1 ? '' : 's'}`, 'warning', {
    action: {
      label: 'Undo',
      run: () => {
        store.restorePlaylist(removed.playlist, removed.index);
      },
    },
    timeoutMs: 10000,
  });
};

const requestDeletePlaylist = () => {
  if (deleteDisabledReason.value) return;
  const playlistId = store.activePlaylistId;
  if (!playlistId) return;

  // First click: arm, and let the operator see what they are pointing at.
  if (!isDeleteArmed.value) {
    disarmDelete();
    deleteArmedPlaylistId.value = playlistId;
    const armedAt = Date.now();
    deleteArmRemaining.value = DELETE_ARM_MS;
    // Ticked on a timer rather than rAF: ten repaints a second, not sixty.
    deleteArmTick = setInterval(() => {
      deleteArmRemaining.value = Math.max(0, DELETE_ARM_MS - (Date.now() - armedAt));
    }, 100);
    deleteArmTimer = setTimeout(disarmDelete, DELETE_ARM_MS);
    return;
  }

  // Second click inside the window.
  disarmDelete();
  if (activePlaylistItemCount.value === 0) {
    performDeletePlaylist(playlistId);
    return;
  }
  pendingDeleteConfirm.value = true;
};

const confirmDeletePlaylist = () => {
  pendingDeleteConfirm.value = false;
  const playlistId = store.activePlaylistId;
  if (playlistId) performDeletePlaylist(playlistId);
};

// Switching tabs, clicking elsewhere or pressing Escape all mean "not that
// one". Disarming is silent -- an operator who changed their mind does not
// need to be told they changed their mind.
watch(() => store.activePlaylistId, disarmDelete);
const activeDropTarget = ref<ActiveDropTarget>({ kind: 'none' });

const indicatorTarget = computed(() => {
  const target = activeDropTarget.value;
  if (target.kind === 'none') return null;
  if (target.kind === 'append') {
    return { index: store.activeItems.length, side: 'after' as const };
  }
  const idx = store.indexOfActiveItem(target.targetItemId);
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

const { timecode: studioClockTimecode } = useStudioClock();
const showGraphicsDrawer = ref(false);
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
  if (store.isRundownLocked) return;
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

const ctxInspect = () => {
  if (contextMenu.value.item) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('playout:open-inspector', { detail: contextMenu.value.item }));
    }
  }
  closeContextMenu();
};

const ctxPlayFrom = () => {
  if (store.isRundownLocked) {
    closeContextMenu();
    return;
  }
  if (contextMenu.value.index !== -1) runPlaylistFrom(contextMenu.value.index);
  closeContextMenu();
};

const ctxDuplicate = () => {
  if (store.isRundownLocked) {
    closeContextMenu();
    return;
  }
  if (contextMenu.value.item) store.duplicateItem(contextMenu.value.item.id);
  closeContextMenu();
};

const ctxDelete = async () => {
  if (store.isRundownLocked) {
    closeContextMenu();
    return;
  }
  const item = contextMenu.value.item;
  const index = contextMenu.value.index;
  closeContextMenu();
  if (item && !isProtectedPlayingRow(index)) {
    const confirmed = await ask(
      `Delete "${getDisplayName(item)}" from ${store.currentPlaylistName}?`,
      { title: 'Delete Item', kind: 'warning' }
    );
    if (!confirmed) {
      await nextTick();
      focusList();
      return;
    }

    const itemIndex = store.indexOfActiveItem(item.id);
    const targetIndex = itemIndex >= 0 ? itemIndex : index;
    const remaining = store.activeItems.filter(i => i.id !== item.id);
    store.removeItem(item.id);
    if (remaining.length > 0) {
      const nextIndex = Math.max(0, Math.min(targetIndex, remaining.length - 1));
      const nextItem = remaining[nextIndex];
      if (nextItem) store.selectItem(nextItem.id);
    }
    await nextTick();
    focusList();
    return;
  }
};

const saveMetadata = async (
  playoutvueId: string | undefined,
  updates: {
    complianceRating?: ComplianceRating;
    complianceDescriptors?: ContentDescriptorId[];
    complianceText?: string;
    timeline?: Array<{ start: number; end: number; text: string }>;
    tp_flag?: boolean;
    content_type?: 'movie' | 'show' | 'documentary' | 'news' | 'none';
  },
  localItemId?: string
) => {
  if (store.isRundownLocked) return;
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

interface AgeRatingOption {
  id: ComplianceRating;
  label: string;
  logoOnly?: boolean;
  /** Distinguishes "with explanation" from "badge only" in the menu (F-10). */
  icon?: IconName;
}

const ageRatingOptions: AgeRatingOption[] = [
  { id: 'k', label: 'Κ — Κατάλληλο για όλους (με επεξήγηση)', icon: 'radio-on' as const },
  { id: '8', label: '8 — Κατάλληλο άνω των 8 (με επεξήγηση)', icon: 'radio-on' as const },
  { id: '12', label: '12 — Κατάλληλο άνω των 12 (με επεξήγηση)', icon: 'radio-on' as const },
  { id: '16', label: '16 — Κατάλληλο άνω των 16 (με επεξήγηση)', icon: 'radio-on' as const },
  { id: '18', label: '18 — Κατάλληλο άνω των 18 (με επεξήγηση)', icon: 'radio-on' as const },
  { id: 'k', label: 'Κ — Μόνο Σήμα (χωρίς επεξήγηση)', logoOnly: true, icon: 'tag' as const },
  { id: '8', label: '8 — Μόνο Σήμα (χωρίς επεξήγηση)', logoOnly: true, icon: 'tag' as const },
  { id: '12', label: '12 — Μόνο Σήμα (χωρίς επεξήγηση)', logoOnly: true, icon: 'tag' as const },
  { id: '16', label: '16 — Μόνο Σήμα (χωρίς επεξήγηση)', logoOnly: true, icon: 'tag' as const },
  { id: '18', label: '18 — Μόνο Σήμα (χωρίς επεξήγηση)', logoOnly: true, icon: 'tag' as const },
  { id: 'none', label: 'Χωρίς Σήμανση (none)', icon: 'close' as const }
];

const ctxSetAgeRating = async (opt: AgeRatingOption) => {
  const item = contextMenu.value.item;
  if (item && item.type !== 'gap') {
    const isLogoOnly = !!opt.logoOnly;
    const currentText = item.complianceText || '';
    const newText = isLogoOnly ? '__LOGO_ONLY__' : (currentText === '__LOGO_ONLY__' ? '' : currentText);
    await saveMetadata(
      item.playoutvueId,
      {
        complianceRating: opt.id,
        complianceText: newText
      },
      item.id
    );
  }
  closeContextMenu();
};

const ctxToggleDescriptor = async (descriptorId: ContentDescriptorId) => {
  const item = contextMenu.value.item;
  if (item && item.type !== 'gap') {
    const currentDescriptors: ContentDescriptorId[] = Array.isArray(item.complianceDescriptors)
      ? [...(item.complianceDescriptors as ContentDescriptorId[])]
      : [];
    const idx = currentDescriptors.indexOf(descriptorId);
    if (idx >= 0) {
      currentDescriptors.splice(idx, 1);
    } else {
      currentDescriptors.push(descriptorId);
    }
    const newText = buildGreekAdvisoryText(currentDescriptors);
    await saveMetadata(
      item.playoutvueId,
      {
        complianceDescriptors: currentDescriptors,
        complianceText: newText,
        timeline: newText ? [{ start: 0, end: 30000, text: newText }] : []
      },
      item.id
    );
  }
  closeContextMenu();
};

const ctxClearDescriptors = async () => {
  const item = contextMenu.value.item;
  if (item && item.type !== 'gap') {
    await saveMetadata(
      item.playoutvueId,
      {
        complianceDescriptors: [],
        complianceText: '',
        timeline: []
      },
      item.id
    );
  }
  closeContextMenu();
};

const ctxApplyCompliancePreset = async (preset: GreekCompliancePreset) => {
  const item = contextMenu.value.item;
  if (item && item.type !== 'gap') {
    await saveMetadata(
      item.playoutvueId,
      {
        complianceRating: preset.ageRating,
        complianceDescriptors: parseDescriptorsFromText(preset.advisoryText),
        complianceText: preset.advisoryText,
        timeline: preset.advisoryText ? [{ start: 0, end: (preset.displayDurationSec || 30) * 1000, text: preset.advisoryText }] : []
      },
      item.id
    );
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

  const isDeleteDisabled = isProtectedPlayingRow(contextMenu.value.index) || store.isRundownLocked;
  
  // UI F-05: trim / rename / purge were permanently disabled stubs on every
  // rundown row -- three dead controls above the only live one. A top action
  // that can never apply to this node type is not rendered at all.
  return [
    {
      id: 'delete',
      tone: 'danger',
      tooltip: store.isRundownLocked ? 'Rundown Locked' : (isDeleteDisabled ? 'Delete (Protected)' : 'Delete Item'),
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
      type: 'label',
      label: 'Clip'
    },
    {
      type: 'action',
      icon: 'inspect',
      tone: 'accent',
      label: 'Inspect clip',
      shortcut: 'Ctrl+I',
      action: ctxInspect
    },
    {
      // Green is "go" on a broadcast desk, and this is the only row in the
      // menu that puts something on air.
      type: 'action',
      icon: 'play',
      tone: 'success',
      label: 'Play from here',
      disabled: store.isRundownLocked,
      action: ctxPlayFrom
    },
    {
      type: 'action',
      icon: 'copy',
      label: 'Duplicate',
      disabled: store.isRundownLocked,
      action: ctxDuplicate
    }
  ];
  
  if (item.type !== 'gap') {
    const currentRating = item.complianceRating || 'none';
    const descriptorCount = Array.isArray(item.complianceDescriptors) ? item.complianceDescriptors.length : 0;
    const currentType = item.content_type || 'none';
    const currentTag = item.libraryIndicator || 'none';

    list.push(
      { type: 'divider' },
      { type: 'label', label: 'Compliance' },
      {
        // The submenu parent wears the clip's *current* rating, so the menu
        // answers "what is this rated" before it is even opened.
        type: 'submenu',
        id: 'compliance-rating',
        icon: 'shield',
        tone: ratingTone(currentRating),
        badge: ratingBadge(currentRating),
        label: 'Σήματα καταλληλότητας (age rating)',
        children: ageRatingOptions.map(r => {
          const itemRating = item.complianceRating || 'none';
          const itemIsLogoOnly = item.complianceText === '__LOGO_ONLY__';
          let isChecked = false;
          if (r.id === 'none') {
            isChecked = itemRating === 'none';
          } else if (r.logoOnly) {
            isChecked = itemRating === r.id && itemIsLogoOnly;
          } else {
            isChecked = itemRating === r.id && !itemIsLogoOnly;
          }
          return {
            type: 'action' as const,
            label: r.label,
            icon: r.icon,
            tone: ratingTone(r.id),
            badge: r.id === 'none' ? undefined : ratingBadge(r.id),
            checked: isChecked,
            action: () => ctxSetAgeRating(r)
          };
        })
      },
      {
        type: 'submenu',
        id: 'compliance-descriptors',
        icon: 'alert',
        tone: descriptorCount > 0 ? 'warning' : 'neutral',
        badge: descriptorCount > 0 ? String(descriptorCount) : undefined,
        label: 'Προειδοποιήσεις περιεχομένου (content warnings)',
        children: [
          ...GREEK_CONTENT_DESCRIPTORS.map(d => {
            const isChecked = Array.isArray(item.complianceDescriptors) && item.complianceDescriptors.includes(d.id);
            return {
              type: 'action' as const,
              icon: (isChecked ? 'square-check' : 'square') as IconName,
              tone: (isChecked ? 'warning' : 'neutral') as MenuTone,
              label: d.label,
              checked: isChecked,
              action: () => ctxToggleDescriptor(d.id)
            };
          }),
          {
            type: 'action' as const,
            icon: 'broom' as IconName,
            tone: 'danger' as MenuTone,
            label: 'Καθαρισμός προειδοποιήσεων',
            disabled: !item.complianceDescriptors || item.complianceDescriptors.length === 0,
            action: ctxClearDescriptors
          }
        ]
      },
      {
        type: 'toggle',
        icon: item.tp_flag ? 'square-check' : 'square',
        tone: item.tp_flag ? 'rating-tp' : 'neutral',
        badge: item.tp_flag ? 'TP' : undefined,
        label: 'Προβολή προϊόντος (product placement, TP)',
        checked: item.tp_flag,
        action: ctxToggleTP
      },
      { type: 'divider' },
      { type: 'label', label: 'Classification' },
      {
        type: 'submenu',
        id: 'content-type',
        icon: 'layers',
        tone: contentTypeTone(currentType),
        label: 'Content type',
        children: contentTypeOptions.map(ct => ({
          type: 'action',
          icon: ((item.content_type || 'none') === ct.id ? 'radio-on' : 'radio-off') as IconName,
          tone: contentTypeTone(ct.id),
          label: ct.label,
          checked: (item.content_type || 'none') === ct.id,
          action: () => ctxSetContentType(ct.id)
        }))
      },
      {
        type: 'submenu',
        id: 'commercial-tag',
        icon: 'tag',
        tone: commercialTagTone(currentTag),
        badge: commercialTagBadge(currentTag),
        label: 'Commercial tag',
        children: indicatorOptions.map(ind => ({
          type: 'action',
          icon: ((item.libraryIndicator || 'none') === ind.id ? 'radio-on' : 'radio-off') as IconName,
          tone: commercialTagTone(ind.id),
          badge: commercialTagBadge(ind.id),
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

const editingPlaylistId = ref<string | null>(null);
const editingPlaylistName = ref('');

/**
 * §5.1: the two rare actions the overflow keeps, now that Load / Append / Save
 * live in the header. Rename reuses the tab's own inline editor rather than
 * opening a dialog for a one-field change.
 */
const startRenameActivePlaylist = () => {
  showPlaylistMenu.value = false;
  const playlist = store.playlists.find((p) => p.id === store.activePlaylistId);
  if (playlist) void startRenamePlaylistTab(playlist as RundownPlaylist);
};

const duplicateActivePlaylist = () => {
  showPlaylistMenu.value = false;
  const source = store.playlists.find((p) => p.id === store.activePlaylistId);
  if (!source) return;
  const sourceItems = [...source.items];
  store.createPlaylist(`${source.name} copy`);
  for (const item of sourceItems) {
    // `addItem` mints a fresh instance id; the draft carries everything else.
    const { id: _id, ...draft } = item;
    store.addItem(draft as Parameters<typeof store.addItem>[0]);
  }
};

const startRenamePlaylistTab = async (playlist: RundownPlaylist) => {
  editingPlaylistId.value = playlist.id;
  editingPlaylistName.value = playlist.name;
  await nextTick();
  const input = document.querySelector<HTMLInputElement>('.tab-rename-input');
  input?.focus();
  input?.select();
};

const commitRenamePlaylistTab = () => {
  if (editingPlaylistId.value && editingPlaylistName.value.trim()) {
    store.renamePlaylist(editingPlaylistId.value, editingPlaylistName.value.trim());
  }
  editingPlaylistId.value = null;
};

/**
 * §5.3: the tab `x` is Close, and it now appears only on an empty tab -- an
 * empty tab needs no ceremony. A tab with items is deleted through the header
 * control, so there is one destructive path rather than two wearing different
 * confirmations.
 */
const closePlaylistTab = (playlist: RundownPlaylist) => {
  if (playlist.items.length > 0) return;
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
  // §9 / §6.2: a gap row states its hard start; "Ghost marker" told the
  // operator nothing. A row that is not playing shows its total only -- the
  // leading `00:00:00 /` was noise on 299 of 300 rows.
  if (item.type === 'gap') return item.hardStartTime ? `Hard start ${item.hardStartTime}` : 'Gap';
  const durationMs = effectiveDurationMs(item, index);
  if (item.type === 'live') return durationMs > 0 ? `LIVE ${msToClockDisplay(durationMs)}` : 'LIVE';
  if (durationMs > 0) return msToClockDisplay(durationMs);
  return '—';
};

/**
 * §3.2: the second line of the on-air timing cell.
 *
 * It used to be one string, `00:00:12 / 00:00:34`, stacked under the countdown
 * in a 96 px column -- three values in a cell the operator reads one of. The
 * hours are dropped below an hour, which is every clip, so the pair fits the
 * column at `--fs-xs` and the countdown above it can be the size it deserves.
 */
const msToCompactDisplay = (ms: number) => {
  if (ms <= 0) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
};

const rowElapsedLabel = (item: RundownItem, index: number) => {
  if (item.type === 'gap') return '';
  if (index !== store.currentPlayingIndex || !isPlayoutPlaying.value || !store.isCurrentPlaylistOnAir) return '';
  return msToCompactDisplay(currentPlayoutMs.value);
};

const rowTotalLabel = (item: RundownItem, index: number) => {
  // At rest the row shows its full total, exactly as before.
  if (!rowElapsedLabel(item, index)) return durationLabel(item, index);
  const totalMs = effectiveDurationMs(item, index);
  if (item.type === 'live' && totalMs <= 0) return 'LIVE';
  return msToCompactDisplay(totalMs);
};

const isProtectedPlayingRow = (index: number) => store.isCurrentPlaylistOnAir && index === store.currentPlayingIndex;

const deleteRowItem = async (item: RundownItem, index: number) => {
  if (store.isRundownLocked || isProtectedPlayingRow(index)) return;
  const confirmed = await ask(
    `Delete "${getDisplayName(item)}" from ${store.currentPlaylistName}?`,
    { title: 'Delete Item', kind: 'warning' }
  );
  if (!confirmed) {
    await nextTick();
    focusList();
    return;
  }

  const itemIndex = store.indexOfActiveItem(item.id);
  const targetIndex = itemIndex >= 0 ? itemIndex : index;
  const remaining = store.activeItems.filter(i => i.id !== item.id);
  store.removeItem(item.id);
  if (remaining.length > 0) {
    const nextIndex = Math.max(0, Math.min(targetIndex, remaining.length - 1));
    const nextItem = remaining[nextIndex];
    if (nextItem) store.selectItem(nextItem.id);
  }
  await nextTick();
  focusList();
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
const rowDayLabel = (index: number) => scheduledTimes.value[index]?.dayLabel || '·';
const rowAtKind = (index: number): '' | 'done' | 'now' | 'gap' | 'time' =>
  (scheduledTimes.value[index]?.kind as 'done' | 'now' | 'gap' | 'time' | undefined) || '';
const rowAtText = (index: number) => {
  const eta = scheduledTimes.value[index];
  return eta && (eta.kind === 'gap' || eta.kind === 'time') ? eta.text || '' : '';
};
const rowPlayProtected = (index: number) => isProtectedPlayingRow(index);

/**
 * §6.1: true on the first row of each scheduled day, so the list can draw one
 * separator instead of repeating the weekday in every row.
 */
const dayBreakBefore = (index: number) => {
  const day = scheduledTimes.value[index]?.dayLabel;
  if (!day || day === '·') return false;
  if (index === 0) return true;
  return scheduledTimes.value[index - 1]?.dayLabel !== day;
};


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
  if (event.button !== 0 || store.isRundownLocked) return;
  const selected = store.selectedItemIds.length > 0
    ? store.selectedItemIds
    : (store.selectedItemId ? [store.selectedItemId] : []);

  // PERF F-04: Set lookups instead of O(n*m) includes() per item.
  const selectedSet = new Set(selected);
  const movingItemIds = selectedSet.has(item.id)
    ? store.activeItems.filter(i => selectedSet.has(i.id)).map(i => i.id)
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
  window.addEventListener('click', closePlaylistMenu);
  window.addEventListener('click', disarmDelete);
  window.addEventListener('playout:playlist-file', onPlaylistFileShortcut as EventListener);
  window.addEventListener('keydown', onDeleteArmEscape, true);

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
      if (target.kind === 'none' || store.isRundownLocked) return;
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
  window.removeEventListener('click', closePlaylistMenu);
  window.removeEventListener('click', disarmDelete);
  window.removeEventListener('playout:playlist-file', onPlaylistFileShortcut as EventListener);
  window.removeEventListener('keydown', onDeleteArmEscape, true);
  disarmDelete();
});

</script>

<template>
  <div class="rundown-wrapper">
    <!-- Header with clock -->
    <div class="rw-header">
      <div class="rw-header-title">
        <h2 class="text-warning rw-header-name">{{ store.currentPlaylistName }}</h2>
        <span v-if="store.isCurrentPlaylistOnAir" class="playing-badge"><AppIcon name="play" :size="12" /> ON AIR</span>
      </div>

      <div class="rw-header-spacer"></div>

      <div class="rw-header-actions">
        <!-- Graphics Ticker Drawer Toggle Button -->
        <BaseButton
          class="rw-ticker-toggle-btn"
          variant="ghost"
          size="sm"
          icon="ticker"
          :class="{ 'is-active': showGraphicsDrawer || settings.cgCrawlActive }"
          v-tooltip="'Toggle the on-demand ticker and graphics drawer'"
          @click="showGraphicsDrawer = !showGraphicsDrawer"
        >
          Ticker
          <span v-if="settings.cgCrawlActive" class="crawl-active-dot" title="Crawl is on air"></span>
        </BaseButton>

<!-- UI F-14: the NTP lock dot was hard-coded to "synchronized" and
             nothing could ever turn it off, so it claimed a clock-sync state the
             app does not observe. Dropped until a real source exists. -->
        <div class="studio-clock-wrap" v-tooltip="'Studio wall clock (system time)'">
          <span class="clock-display">{{ studioClockTimecode }}</span>
        </div>

        <BaseButton
          variant="ghost"
          size="sm"
          icon="live"
          v-tooltip="'Insert a live item or studio block into the rundown'"
          @click="showLiveDialog = true"
        >
          Live block
        </BaseButton>
        <BaseButton
          v-if="isPlayoutPlaying"
          class="btn-stop"
          variant="ghost"
          size="sm"
          icon="stop"
          title="Stop"
          @click="stopPlayback"
        >
          Stop
        </BaseButton>

        <!-- §5.1: Load / Append / Save come back out of the overflow. §6.3
             filed them as "used once a session"; the owner uses them
             constantly, and an action used constantly does not belong two
             clicks deep. The overflow keeps what is genuinely rare. -->
        <div class="rw-file-group" role="group" aria-label="Playlist file">
          <BaseButton
            variant="icon"
            size="sm"
            icon="folder-open"
            label="Load playlist"
            v-tooltip="{ text: 'Load playlist…', shortcut: 'Ctrl+O' }"
            :loading="isLoadingPlaylist"
            @click="runPlaylistFileAction('load')"
          />
          <BaseButton
            variant="icon"
            size="sm"
            icon="file-plus"
            label="Append playlist"
            v-tooltip="{ text: 'Append playlist…', shortcut: 'Ctrl+Shift+O' }"
            :loading="isLoadingPlaylist"
            @click="runPlaylistFileAction('append')"
          />
          <BaseButton
            variant="icon"
            size="sm"
            icon="save"
            label="Save playlist"
            v-tooltip="{ text: 'Save playlist…', shortcut: 'Ctrl+S' }"
            :loading="isSavingPlaylist"
            @click="runPlaylistFileAction('save')"
          />
        </div>

        <span class="rw-header-divider" aria-hidden="true"></span>

        <!-- §5.2: two-stage arm. Armed, the control states its target rather
             than asking a yes/no question about an abstraction. -->
        <BaseButton
          class="rw-delete-btn"
          :class="{ 'is-armed': isDeleteArmed }"
          :variant="isDeleteArmed ? 'danger' : 'icon'"
          size="sm"
          icon="trash"
          :disabled="!!deleteDisabledReason"
          :label="isDeleteArmed ? deleteArmLabel : 'Delete playlist'"
          v-tooltip="deleteDisabledReason || (isDeleteArmed ? deleteArmLabel : 'Delete playlist')"
          data-testid="rundown-delete-playlist"
          @click.stop="requestDeletePlaylist"
        >
          <template v-if="isDeleteArmed">
            <span class="rw-delete-arm-label">{{ deleteArmLabel }}</span>
            <span
              class="arm-ring"
              aria-hidden="true"
              :style="{ '--arm-progress': deleteArmProgress }"
            ></span>
          </template>
        </BaseButton>

        <div class="rw-overflow-wrap">
          <BaseButton
            class="rw-overflow-trigger"
            :class="{ 'is-open': showPlaylistMenu }"
            variant="icon"
            size="sm"
            icon="more-vertical"
            label="More playlist actions"
            v-tooltip="showPlaylistMenu ? 'Close playlist menu' : 'More playlist actions'"
            :aria-expanded="showPlaylistMenu"
            data-testid="rundown-overflow"
            @click.stop="showPlaylistMenu = !showPlaylistMenu"
          />
          <div v-if="showPlaylistMenu" class="rw-overflow-menu popover-surface" role="menu" @click.stop>
            <button class="rw-overflow-item popover-item" role="menuitem" @click="startRenameActivePlaylist">
              <AppIcon class="rw-overflow-icon tone-accent" name="rename" :size="14" />
              <span>Rename playlist…</span>
            </button>
            <button class="rw-overflow-item popover-item" role="menuitem" @click="duplicateActivePlaylist">
              <AppIcon class="rw-overflow-icon tone-accent" name="copy" :size="14" />
              <span>Duplicate playlist</span>
            </button>
            <div class="popover-divider" role="separator" />
            <button class="rw-overflow-item popover-item popover-item--danger" role="menuitem" @click="runClearRundown">
              <AppIcon class="rw-overflow-icon" name="broom" :size="14" />
              <span>Clear all items…</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Collapsible Secondary Graphics Drawer -->
    <div v-if="showGraphicsDrawer" class="rw-graphics-drawer">
      <div class="graphics-drawer-content">
        <span class="graphics-drawer-badge"><AppIcon name="ticker" :size="12" /> TICKER</span>
        <input 
          type="text" 
          v-model="settings.cgCrawlText" 
          placeholder="Enter news crawl ticker text..." 
          class="crawl-input glass-input"
          title="On-Demand Crawl Text (live update on type)"
          autofocus
        />
        <button 
          class="btn btn--sm crawl-btn"
          :class="{ 'is-active': settings.cgCrawlActive }"
          @click="toggleCrawlTicker"
          title="Toggle On-Demand Ticker Overlay"
        >
          <span class="crawl-btn-dot"></span>
          {{ settings.cgCrawlActive ? 'CRAWL ON AIR' : 'START CRAWL' }}
        </button>
        <button class="drawer-close-btn" @click="showGraphicsDrawer = false" title="Close ticker drawer" aria-label="Close ticker drawer">
          <AppIcon name="close" :size="14" />
        </button>
      </div>
    </div>

    <!-- Trim Duration Warning Banner -->
    <div v-if="store.lastTrimWarning" class="trim-warning-banner" role="status">
      <AppIcon class="tw-icon" name="alert" :size="16" />
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
        :class="{
          'is-active': playlist.id === store.activePlaylistId,
          'is-onair': playlist.id === store.onAirPlaylistId,
          'is-delete-target': playlist.id === deleteArmedPlaylistId,
        }"
        @click="store.activatePlaylist(playlist.id)"
        @dblclick.stop="startRenamePlaylistTab(playlist as RundownPlaylist)"
      >
        <input
          v-if="editingPlaylistId === playlist.id"
          v-model="editingPlaylistName"
          class="tab-rename-input"
          @click.stop
          @blur="commitRenamePlaylistTab"
          @keydown.enter.stop.prevent="commitRenamePlaylistTab"
          @keydown.esc.stop.prevent="editingPlaylistId = null"
          autofocus
        />
        <span v-else class="playlist-tab-name">{{ playlist.name }}</span>
        <!-- §6.3: "OFFLINE" on every tab was noise — offline is the normal
             state. Only the exception gets a word; the rest get their count. -->
        <span v-if="playlist.id === store.onAirPlaylistId" class="playlist-tab-state">ON AIR</span>
        <span v-else-if="playlist.id === deleteArmedPlaylistId" class="playlist-tab-state is-deleting">DELETING</span>
        <span v-else class="playlist-tab-count tabular-nums">{{ playlist.items.length }}</span>
        <!-- §5.3: Close, on an empty tab only. A tab with items goes through
             the header's Delete, so there is one destructive path. -->
        <span
          v-if="store.playlists.length > 1 && playlist.id !== store.onAirPlaylistId && playlist.items.length === 0"
          class="playlist-tab-close"
          role="button"
          tabindex="-1"
          :aria-label="`Close ${playlist.name}`"
          title="Close playlist"
          @click.stop="closePlaylistTab(playlist as RundownPlaylist)"
        >
          <AppIcon name="close" :size="12" :stroke-width="2.5" />
        </span>
      </button>
      <button class="playlist-add-btn" @click="createPlaylistTab" v-tooltip="'Create new offline playlist'" aria-label="Create new offline playlist">
        <AppIcon name="plus" :size="14" />
      </button>
    </div>

    <!-- §6.3: the schedule row belongs with the tabs it describes, not stranded
         at the bottom of the panel below the rundown it does not control. -->
    <PlaylistControls />

    <!-- List. The column header is its first child, sticky: §2.2 -- outside
         the list it was a different box with a different padding and, once the
         list overflowed, a different width. -->
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
      <!-- Column labels -->
      <div class="rw-cols-label" aria-hidden="true">
        <span class="col-handle"></span>
        <span class="col-num">#</span>
        <span class="col-status"></span>
        <span class="col-type"></span>
        <span class="col-title">Title</span>
        <span class="col-flags">Flags</span>
        <span class="col-trim">Trim</span>
        <span class="col-dur">Duration</span>
        <span class="col-at">At</span>
        <span class="col-actions">Actions</span>
      </div>

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
          rowElapsedLabel(item, index),
          rowTotalLabel(item, index),
          rowDayLabel(index),
          rowAtKind(index),
          rowAtText(index),
          rowPlayProtected(index),
          dayBreakBefore(index)
        ]"
      >
        <!-- §6.1: a day separator instead of repeating the weekday on all 300
             rows. Rendered only where the schedule crosses into a new day, and
             inside the memoized container so `v-memo` stays on the `v-for`
             element (Vue ignores it anywhere else). -->
        <div v-if="dayBreakBefore(index)" class="rw-day-separator" role="presentation">
          <span>{{ rowDayLabel(index) }}</span>
        </div>
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
          :elapsed-label="rowElapsedLabel(item, index)"
          :total-label="rowTotalLabel(item, index)"
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
        <span class="end-drop-badge">Add to end</span>
      </div>

      <!-- §5.2: the third cue. The tab says which one, this says what will
           happen to the thing the operator is actually looking at. -->
      <div v-if="isDeleteArmed" class="rw-delete-overlay" aria-hidden="true">
        <span class="rw-delete-overlay-label">This playlist will be deleted</span>
      </div>

      <EmptyState
        v-if="store.activeItems.length === 0"
        class="rw-empty"
        icon="film"
        title="Nothing scheduled"
        hint="Drag media from the library, or add a live block."
      />
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

    <!-- §5.2: the only modal in the flow, and only for a playlist with items
         in it. The two-click arm already stops an accidental single click; the
         dialog is for the case where losing the work would actually matter. -->
    <DangerConfirm
      :open="pendingDeleteConfirm"
      :title="`Delete &quot;${store.currentPlaylistName}&quot;?`"
      :message="`${activePlaylistItemCount} item${activePlaylistItemCount === 1 ? '' : 's'} will be removed from this tab.`"
      warning="You can undo for 10 seconds."
      confirm-label="Delete playlist"
      :nested="false"
      @confirm="confirmDeletePlaylist"
      @cancel="pendingDeleteConfirm = false"
    />

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

    <LiveEntryDialog v-if="showLiveDialog" @close="showLiveDialog = false" />
  </div>
</template>

<style scoped>
.rundown-wrapper { height:100%; display:flex; flex-direction:column; overflow:hidden; position:relative; }
.rw-header-title,
.rw-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.rw-header-name {
  margin: 0;
  font-size: var(--fs-lg);
}

.rw-header-spacer {
  flex: 1;
}

.rw-header {
  height: var(--panel-header-h);
  padding: 0 var(--space-3); border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-panel-header);
  box-shadow: var(--shadow-highlight);
  display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
}
.trim-warning-banner {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); font-size: var(--fs-md); color: var(--accent-yellow);
  background: color-mix(in srgb, var(--accent-yellow) 15%, var(--bg-secondary));
  border-bottom: 1px solid color-mix(in srgb, var(--accent-yellow) 35%, transparent);
  flex-shrink: 0;
}
.tw-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tw-pos { color: var(--accent-green); font-weight: var(--fw-bold); }
.tw-neg { color: var(--accent-red); font-weight: var(--fw-bold); }
.tw-dismiss {
  background: transparent; border: none; color: var(--accent-yellow);
  font-size: var(--fs-xl); cursor: pointer; padding: 0 var(--space-1); border-radius: var(--radius-sm);
  line-height: var(--lh-none);
}
.tw-dismiss:hover { background: var(--bg-hover); }
.studio-clock-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--bg-surface-elevated);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-medium);
}
.clock-display {
  font-family: var(--font-mono); font-size: var(--fs-tc); font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps); color: var(--text-primary); text-shadow: 0 0 10px var(--glass-border);
  font-variant-numeric: tabular-nums;
}
.rw-ticker-toggle-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.rw-ticker-toggle-btn.is-active {
  background: color-mix(in srgb, var(--accent-blue) 20%, transparent);
  color: var(--text-primary);
}
.rw-graphics-drawer {
  display: flex;
  align-items: center;
  background: var(--bg-surface-elevated);
  border-bottom: 1px solid var(--border-medium);
  padding: var(--space-2) var(--space-3);
}
.graphics-drawer-content {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
}
.graphics-drawer-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
  color: var(--accent-blue);
  white-space: nowrap;
}
.drawer-close-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--fs-xl);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
}
.drawer-close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.tab-rename-input {
  background: var(--bg-surface);
  border: 1px solid var(--accent-blue);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--fs-md);
  font-weight: var(--fw-bold);
  padding: var(--space-0) var(--space-1);
  outline: none;
  max-width: 130px;
}
.playing-badge {
  background: color-mix(in srgb, var(--accent-red) 18%, transparent); border: 1px solid color-mix(in srgb, var(--accent-red) 50%, transparent);
  color: var(--accent-red); font-size: var(--fs-xs); font-weight: var(--fw-semibold); letter-spacing: var(--tracking-caps);
  padding: var(--space-0) var(--space-2); border-radius: var(--radius-sm);
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
}
/* §2.1: the second `.icon-action` definition is gone -- it had a different
   radius, padding and hover from the library's, for controls that sit four
   inches apart on the same screen. Everything in this header is a BaseButton. */
.btn-stop { color: var(--accent-red); }
.btn-stop:hover:not(:disabled) { color: var(--accent-red); background: color-mix(in srgb, var(--accent-red) 14%, transparent); }

/* §5.1: the three file actions read as one control with three parts, because
   that is what they are -- the same file, three verbs. */
.rw-file-group {
  display: inline-flex;
  align-items: center;
  gap: var(--space-0);
  padding: var(--space-0);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-hover);
}

.rw-header-divider {
  width: 1px;
  align-self: stretch;
  margin: var(--space-0);
  background: var(--border-subtle);
}

/* §5.2: at rest the trash is a quiet icon -- a resting red trash icon is
   noise, and the operator learns to stop seeing it. Red arrives on hover, and
   on arming the control becomes a labelled pill that states its target. */
.rw-delete-btn:hover:not(:disabled) {
  color: var(--status-error);
  background: color-mix(in srgb, var(--status-error) 14%, transparent);
}
.rw-delete-btn.is-armed {
  position: relative;
  width: auto;
  padding: 0 var(--space-3);
  overflow: visible;
}
.rw-delete-arm-label {
  white-space: nowrap;
  font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps);
}
/* The same conic sweep the live cut uses, so "armed" looks like one thing in
   this app rather than two. Compositor-only: a custom property feeding a
   gradient angle, ticked ten times a second. */
.rw-delete-btn .arm-ring {
  position: absolute;
  inset: calc(var(--space-0) * -1);
  border-radius: inherit;
  pointer-events: none;
  background: conic-gradient(var(--status-error) calc(var(--arm-progress, 0) * 360deg), transparent 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), black calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), black calc(100% - 2px));
  opacity: 0.9;
}
/* §6.3: the header overflow. Same visual language as the library's actions
   dropdown so the two "⋮" menus in the app are one pattern, not two. */
.rw-overflow-wrap {
  position: relative;
}
.rw-overflow-trigger.is-open {
  background: var(--bg-surface-elevated);
  color: var(--text-primary);
}
/* Everything but position comes from `.popover-surface` / `.popover-item`. */
.rw-overflow-menu {
  position: absolute;
  top: calc(100% + var(--space-1));
  right: 0;
  min-width: 190px;
  display: flex;
  flex-direction: column;
  gap: var(--space-0);
  z-index: var(--z-popover);
}
.rw-overflow-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
}
.rw-overflow-icon.tone-accent {
  color: var(--accent-blue);
}
.popover-item--danger .rw-overflow-icon {
  color: var(--status-error);
}

.playlist-tabs-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--panel-toolbar-h);
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-panel-header);
  box-shadow: var(--shadow-highlight);
  overflow-x: auto;
  flex-shrink: 0;
}
.playlist-tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  background: var(--bg-hover);
  color: var(--text-primary);
  cursor: pointer;
  flex-shrink: 0;
  min-width: 140px;
  /* PERF F-23: explicit list; `all` also animated width/padding on label changes. */
  transition: background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.playlist-tab:hover {
  background: var(--bg-surface-elevated);
  border-color: var(--border-medium);
}
.playlist-tab.is-active {
  border-color: color-mix(in srgb, var(--accent-primary) 45%, transparent);
  background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-secondary));
}

/* §7.4: the active tab's 2 px underline. It is one element per tab rather than
   one that slides between them -- the tabs are a scrolling flex row of
   variable width, so a single sliding element would need its position measured
   and rewritten on every rename, count change and scroll. Same look, and the
   transition is on `transform` so it still costs only the compositor. */
.playlist-tab::before {
  content: '';
  position: absolute;
  left: var(--space-3);
  right: var(--space-3);
  bottom: 2px;
  height: 2px;
  border-radius: var(--radius-pill);
  background: var(--accent-primary);
  transform: scaleX(0);
  transform-origin: center;
  transition: transform var(--dur-base) var(--ease-out);
  pointer-events: none;
}
.playlist-tab.is-active::before {
  transform: scaleX(1);
}
.playlist-tab.is-onair::before {
  background: var(--status-onair);
}
.playlist-tab.is-onair {
  position: relative;
  border-color: var(--status-onair);
}
/* PERF F-06: the glow used to be a box-shadow keyframe on the tab itself,
   which repaints the tab every frame for the whole on-air session. The tab
   now only animates transform (compositor) and the peak glow lives on an
   overlay whose opacity pulses (compositor). Same rest/peak look. */
.playlist-tab.is-onair::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  box-shadow: var(--glow-onair);
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
  will-change: opacity;
}
.playlist-tab-name {
  font-size: var(--fs-md);
  font-weight: var(--fw-bold);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* §6.3: the on-air tab is the only one that says anything; it says the one
   word that matters, as a filled pill rather than a grey caption. */
/* §5.2: the armed target. The operator's eyes are on the tab strip when they
   click the second time, so this is where the answer to "which one?" has to
   be -- not on an OK button in a dialog. */
.playlist-tab.is-delete-target {
  border-color: var(--status-error);
  box-shadow: 0 0 0 1px var(--status-error);
  background: var(--danger-tint-strong);
}
.playlist-tab.is-delete-target .playlist-tab-name {
  text-decoration: line-through;
  opacity: 0.6;
}
.playlist-tab-state.is-deleting {
  background: var(--status-error);
  color: var(--text-on-danger);
}

.playlist-tab-state {
  margin-left: auto;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
  color: var(--text-on-danger);
  background: var(--status-onair);
  border-radius: var(--radius-pill);
  padding: var(--space-0) var(--space-2);
  line-height: var(--lh-body);
}
.playlist-tab-count {
  margin-left: auto;
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  min-width: 14px;
  text-align: right;
}
/* §6.3: the close affordance appears on hover or keyboard focus. A permanent
   × on every tab is a permanent invitation to close the wrong playlist. */
.playlist-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out);
}
.playlist-tab:hover .playlist-tab-close,
.playlist-tab:focus-within .playlist-tab-close {
  opacity: 1;
}
.playlist-tab-close:hover {
  color: var(--status-error);
  background: color-mix(in srgb, var(--status-error) 16%, transparent);
}
.playlist-add-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  border-radius: var(--radius-lg);
  border: 1px dashed color-mix(in srgb, var(--accent-blue) 40%, transparent);
  background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
  color: var(--accent-blue);
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.playlist-add-btn:hover {
  background: color-mix(in srgb, var(--accent-blue) 18%, transparent);
  border-color: var(--accent-blue);
}

/* §2.2 — the column template, defined once.
 *
 * The header strip and the rows used to carry their own copies of these ten
 * widths, in two files, and the two had already diverged: Actions was 56px in
 * the header against `2 x --control-h-sm + 4` in the row, which is 64 at
 * comfortable density. `.rw-row` inherits these through the panel, so there is
 * one place to change a column and no way for the two halves to disagree. */
.rundown-wrapper {
  --rw-col-handle: 18px;
  --rw-col-num: 22px;
  /* §4: the status dot and the type icon are one 20px cell each, so the title
     starts at the same x whether or not either is present. */
  --rw-col-status: 20px;
  --rw-col-type: 20px;
  --rw-col-title-min: 180px;
  --rw-col-flags: 88px;
  --rw-col-flags-narrow: 26px;
  --rw-col-trim: 86px;
  --rw-col-dur: 112px;
  --rw-col-at: 84px;
  --rw-col-actions: calc(var(--control-h-sm) * 2 + var(--space-1));
  --rw-col-gap: var(--space-2);
  /* The list's horizontal padding: the one inset between the panel edge and a
     row, and now also between the panel edge and the header. */
  --rw-list-inset: var(--space-2);
}

.rw-cols-label {
  position: sticky;
  top: 0;
  /* Above the rows that scroll under it, and above the delete overlay, which
     is itself sticky at the top of this list. */
  z-index: 3;
  display: flex;
  align-items: center;
  gap: var(--rw-col-gap);
  /* A row's box, to the pixel: the same transparent border and the same
     padding, so every label sits over its own column. */
  border: 1px solid transparent;
  border-bottom-color: var(--border-subtle);
  padding: var(--space-1) var(--space-2);
  margin-bottom: var(--space-2);
  background: var(--bg-tertiary);
  flex-shrink: 0;
}
.rw-list {
  flex: 1;
  overflow-y: auto;
  /* A stable gutter means the rows do not shift sideways the moment the list
     grows past the panel, which is the one time an operator is reading it. */
  scrollbar-gutter: stable;
  padding: 0 var(--rw-list-inset) var(--space-3);
  min-height: 0;
  transition: background var(--dur-fast);
  contain: strict;
  position: relative;
}

/* §5.2: the third cue, over the thing that will actually be lost. Opacity only
   (perf), no pointer events, and it never intercepts a click. */
.rw-delete-overlay {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 0;
  pointer-events: none;
}
.rw-delete-overlay::before {
  content: '';
  position: absolute;
  inset: 0 calc(var(--space-1) * -1) auto;
  height: 100vh;
  background: var(--danger-tint);
  pointer-events: none;
}
.rw-delete-overlay-label {
  position: relative;
  margin-top: var(--space-4);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  border: 1px solid var(--status-error);
  background: var(--surface-panel);
  color: var(--status-error);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.rw-list.drag-over { background: color-mix(in srgb, var(--accent-cyan) 6%, transparent); outline: 2px dashed var(--accent-cyan); outline-offset: -3px; border-radius: var(--radius-md); }

/* Sortable ghost clone of the row host wrapper */
.rw-ghost { opacity: 0.3; background: var(--bg-hover); }

/* §7.7: `EmptyState` landed here in §6.3 but kept the old dashed box's
   styling on top of it, so the one shared empty state looked like a dropzone
   in this panel and like an empty state everywhere else. The class stays as a
   layout hook; the box is gone. */
.rw-empty {
  margin: var(--space-4) var(--space-1);
}

/* On-Demand Crawl Styling */
.crawl-input {
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  color: var(--text-primary);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--fs-md);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out);
  min-width: 120px;
}
.crawl-input:focus {
  border-color: var(--accent-primary);
  box-shadow: var(--focus-ring);
}
/* §7.2: surface, border, radius, hover, focus, press and disabled come from
   `.btn`. What is genuinely this control's own is its on-air tone and the
   status dot beside the label. */
.crawl-btn {
  gap: var(--space-2);
  font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.crawl-btn.is-active {
  background: color-mix(in srgb, var(--accent-red) 16%, transparent);
  border-color: var(--accent-red);
  color: var(--accent-red);
  box-shadow: var(--glow-onair);
}
.crawl-btn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: background-color var(--dur-fast) var(--ease-out);
}
.crawl-btn:hover .crawl-btn-dot {
  background: var(--text-primary);
}
.crawl-btn.is-active .crawl-btn-dot {
  background: var(--accent-red);
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
}

.rw-list:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  outline-offset: -2px;
}

.rundown-end-drop-zone {
  position: relative;
  height: 44px;
  margin: var(--space-2) var(--space-1) var(--space-3) var(--space-1);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-muted);
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  transition: border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  user-select: none;
}

.rundown-end-drop-zone.is-active {
  border-color: var(--accent-cyan);
  background-color: color-mix(in srgb, var(--accent-cyan) 12%, transparent);
  color: var(--accent-cyan);
}

.end-drop-indicator-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--accent-cyan);
  box-shadow: 0 0 8px var(--accent-cyan);
  display: none;
}

.rundown-end-drop-zone.is-active .end-drop-indicator-line {
  display: block;
}

.rw-fixed-drop-indicator {
  position: fixed;
  pointer-events: none;
  user-select: none;
  z-index: var(--z-drawer);
  height: 0;
  transition: none;
}
.rw-indicator-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent-cyan);
  box-shadow: 0 0 8px var(--accent-cyan);
}
.rw-indicator-dot {
  position: absolute;
  top: -4px;
  left: -2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent-cyan);
  box-shadow: 0 0 6px var(--accent-cyan);
}
.rw-indicator-badge {
  position: absolute;
  top: -10px;
  right: 0;
  background: var(--accent-cyan);
  color: var(--text-inverse);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  pointer-events: none;
  user-select: none;
  box-shadow: var(--shadow-1);
  white-space: nowrap;
}
.rw-fixed-drop-indicator.is-append .rw-indicator-badge {
  background: var(--accent-blue);
}
/* The crawl indicator is a dot, so it is drawn rather than typed. */
.crawl-active-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-onair);
  display: inline-block;
  flex-shrink: 0;
}
/* --- §6.1 column header ---------------------------------------------------
   Widths mirror RundownRow's. Labels are single words and never wrap. */
.rw-cols-label > span {
  white-space: nowrap;
  overflow: hidden;
}

.rw-cols-label .col-handle { width: var(--rw-col-handle); flex-shrink: 0; }
.rw-cols-label .col-num { width: var(--rw-col-num); text-align: center; flex-shrink: 0; }
.rw-cols-label .col-status { width: var(--rw-col-status); flex-shrink: 0; }
.rw-cols-label .col-type { width: var(--rw-col-type); flex-shrink: 0; }
.rw-cols-label .col-title { flex: 1 1 auto; min-width: var(--rw-col-title-min); }
.rw-cols-label .col-flags { width: var(--rw-col-flags); flex-shrink: 0; }
/* §4: the Trim column's content is right-aligned, so its label is too. */
.rw-cols-label .col-trim { width: var(--rw-col-trim); text-align: right; flex-shrink: 0; }
/* §3.2: both timing columns right-aligned to the same edge with a 12 px
   gutter between them. Right-aligned "DURATION" followed by left-aligned "AT"
   6 px away read as one word, "DURATIONAT". */
.rw-cols-label .col-dur { width: var(--rw-col-dur); text-align: right; flex-shrink: 0; }
.rw-cols-label .col-at { width: var(--rw-col-at); text-align: right; flex-shrink: 0; margin-left: var(--space-2); }
.rw-cols-label .col-actions { width: var(--rw-col-actions); text-align: right; flex-shrink: 0; }

/* One container for both, now that the header lives inside the list: two
   containers 8px apart shed their columns at two different window widths. */
.rw-list {
  container: rundown / inline-size;
}

@container rundown (max-width: 620px) {
  .rw-cols-label .col-trim { display: none; }
}

@container rundown (max-width: 520px) {
  .rw-cols-label .col-flags { width: var(--rw-col-flags-narrow); }
}

/* --- Day separator -------------------------------------------------------- */
.rw-day-separator {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) var(--space-1) var(--space-1);
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--text-muted);
}

.rw-day-separator::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--border-subtle);
}
</style>
