<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useRundownStore } from '../stores/rundown';
import { draggingItem } from '../composables/useDragState';
import { playStartTime, playStartIndex } from '../services/obs';
import { currentPlayoutMs, currentTotalPlayoutMs, getActivePlayoutService, isPlayoutPlaying, registerPlayoutAdvanceListener } from '../services/playout';
import Sortable from 'sortablejs';
import LiveEntryDialog from './LiveEntryDialog.vue';
import PlaylistControls from './PlaylistControls.vue';

const store = useRundownStore();
const rundownListRef = ref<HTMLElement | null>(null);
const isDragOver = ref(false);
const showLiveDialog = ref(false);
let sortableInstance: Sortable | null = null;
const durationHydrationInFlight = new Set<string>();

const contextMenu = ref({
    show: false, x: 0, y: 0, index: -1, item: null as any
});

// ── Real-time wall clock ──────────────────────────────────────────────────────
const clockNow = ref(Date.now());
let clockTick: ReturnType<typeof setInterval> | null = null;
onMounted(() => { clockTick = setInterval(() => { clockNow.value = Date.now(); }, 1000); });
onUnmounted(() => { if (clockTick) clearInterval(clockTick); });

const clockStr = computed(() => {
    const d = new Date(clockNow.value);
    return d.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
});

const itemDurationMs = (item: any): number => {
  if (item.type === 'live') return (item.plannedDuration || item.duration || 0) * 1000;
  if (item.outPoint > item.inPoint) return item.outPoint - item.inPoint;
  return (item.plannedDuration || item.duration || 0) * 1000;
};

const effectiveDurationMs = (item: any, index: number): number => {
  if (index === store.currentPlayingIndex && currentTotalPlayoutMs.value > 0) {
    return currentTotalPlayoutMs.value;
  }
  return itemDurationMs(item);
};

const formatClockTime = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

// Scheduled times logic
const scheduledTimes = computed(() => {
    const playing = store.currentPlayingIndex >= 0;
    const sIdx = playing ? playStartIndex.value : 0;
    const base  = playing ? playStartTime.value  : clockNow.value;
  let accumulatedTime = base;

    return store.activeItems.map((item, idx) => {
    if (playing && idx < sIdx) return { kind: 'skip' };
    if (playing && idx < store.currentPlayingIndex) {
      accumulatedTime += itemDurationMs(item);
      return { kind: 'done' };
    }
    if (playing && idx === store.currentPlayingIndex) {
      accumulatedTime += itemDurationMs(item);
      return { kind: 'now' };
    }

    const nextStart = accumulatedTime;
    accumulatedTime += itemDurationMs(item);
    return { kind: 'time', text: formatClockTime(nextStart) };
    });
});

const calcProgress = (item: any) => {
  const activeIndex = store.activeItems.findIndex((candidate: any) => candidate.id === item.id);
  const dur = effectiveDurationMs(item, activeIndex);
    if (!dur || dur <= 0) return 0;
    const p = (currentPlayoutMs.value / dur) * 100;
    return Math.max(0, Math.min(100, Math.round(p * 100) / 100)); // smooth visual
};

const hydrateMissingDurations = async () => {
  const candidates = store.activeItems.filter((item: any) =>
    item.type === 'video' &&
    item.path &&
    !/^https?:/i.test(item.path) &&
    !(item.outPoint > item.inPoint) &&
    !(item.duration > 0) &&
    !durationHydrationInFlight.has(item.id)
  );

  await Promise.all(candidates.map(async (item: any) => {
    durationHydrationInFlight.add(item.id);
    try {
      const meta = await invoke<{ duration: string }>('scan_media', { filepath: item.path });
      const seconds = Number.parseFloat(meta.duration || '0');
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
    const meta = await invoke<{ duration: string }>('scan_media', { filepath: filePath });
    const seconds = Number.parseFloat(meta.duration || '0');
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

// ── Playback ─────────────────────────────────────────────────────────────────
registerPlayoutAdvanceListener((index) => {
    store.currentPlayingIndex = index;
    store.selectedItemId = index >= 0 ? store.activeItems[index]?.id || null : null;
});

const playFrom = async (index: number) => {
    store.currentPlayingIndex = index;
    await getActivePlayoutService().play(store.activeItems as any, index);
};

watch(
  () => store.activeItems.map((item) => `${item.id}:${item.path}:${item.inPoint}:${item.outPoint}:${item.plannedDuration}`).join('|'),
  () => {
    if (!isPlayoutPlaying.value) return;
    getActivePlayoutService().refreshQueue?.(store.activeItems as any).catch((error) => {
      console.error('[Playback] Failed to refresh rundown queue', error);
    });
  }
);

watch(
  () => store.activeItems.map((item) => `${item.id}:${item.path}:${item.duration}:${item.outPoint}:${item.inPoint}`).join('|'),
  () => {
    hydrateMissingDurations().catch((error) => {
      console.warn('[Rundown] Duration hydration failed', error);
    });
  },
  { immediate: true }
);

watch(
  () => `${store.currentPlayingIndex}:${currentTotalPlayoutMs.value}`,
  () => {
    const index = store.currentPlayingIndex;
    if (index < 0 || currentTotalPlayoutMs.value <= 0) return;
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
    store.currentPlayingIndex = -1;
};

// ── Context Menu ─────────────────────────────────────────────────────────────
const onContextMenu = (event: MouseEvent, index: number, item: any) => {
    store.selectedItemId = item.id;
    contextMenu.value = { show: true, x: event.clientX, y: event.clientY, index, item };
};
const closeContextMenu = () => {
    contextMenu.value.show = false;
};
const ctxPlayFrom = () => {
    if (contextMenu.value.index !== -1) playFrom(contextMenu.value.index);
    closeContextMenu();
};
const ctxDuplicate = () => {
    if (contextMenu.value.item) store.duplicateItem(contextMenu.value.item.id);
    closeContextMenu();
};
const ctxDelete = () => {
    if (contextMenu.value.item) store.removeItem(contextMenu.value.item.id);
    closeContextMenu();
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

const handleKey = (e: KeyboardEvent) => {
  const target = e.target as HTMLElement | null;
  if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;

    const id = store.selectedItemId;
    const items = store.activeItems;
    const idx = id ? items.findIndex((i: any) => i.id === id) : -1;

  if ((e.key === 'Delete' || e.key === 'Backspace') && id) {
    e.preventDefault();
    store.removeItem(id);
    return;
  }

  if ((e.key === 'Enter' || e.key === ' ') && idx !== -1) {
    e.preventDefault();
    playFrom(idx);
    return;
  }

    if (e.shiftKey && e.key === 'ArrowDown') {
        e.preventDefault();
        if (idx !== -1) {
            store.duplicateItem(id!);
            store.selectedItemId = items[idx + 1]?.id || id;
        }
        return;
    }

    if (e.ctrlKey) {
        if (idx === -1) return;
        if (e.key === 'ArrowUp' && idx > 0) { e.preventDefault(); store.reorderItems(idx, idx - 1); }
        if (e.key === 'ArrowDown' && idx < items.length - 1) { e.preventDefault(); store.reorderItems(idx, idx + 1); }
    }
};

// ── Drop zone ──────────────────────────────────────────────────────────────
const onDragEnter = (e: DragEvent) => { e.preventDefault(); isDragOver.value = true; };
const onDragOver  = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
const onDragLeave = (e: DragEvent) => {
    const rel = e.relatedTarget as Node | null;
    if (!(e.currentTarget as HTMLElement)?.contains(rel)) isDragOver.value = false;
};
const onDrop = async (e: DragEvent) => {
    e.preventDefault(); isDragOver.value = false;
    if (draggingItem.value) {
      const payload = { ...draggingItem.value };
      if (payload.type === 'video' && !(payload.duration > 0) && payload.path && !/^https?:/i.test(payload.path)) {
        try {
          const meta = await invoke<{ duration: string }>('scan_media', { filepath: payload.path });
          const seconds = Number.parseFloat(meta.duration || '0');
          if (Number.isFinite(seconds) && seconds > 0) {
            payload.duration = seconds;
          }
        } catch (error) {
          console.warn('[Rundown] Failed to resolve dropped item duration before insert', payload.path, error);
        }
      }
      store.addItem(payload);
      const addedItem = store.activeItems[store.activeItems.length - 1];
      if (addedItem && payload.type === 'video' && !(payload.duration > 0) && payload.path && !/^https?:/i.test(payload.path)) {
        hydrateSingleItemDuration(addedItem.id, payload.path).catch(() => {});
      }
      draggingItem.value = null;
    }
};

const typeIcon  = (t: string) => ({ video: '🎬', live: '📹', graphic: '🎨' }[t] || '📄');
const typeColor = (t: string) => ({ video: '#33becc', live: '#e63946', graphic: '#a8dadc' }[t] || '#aaa');

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

const durationLabel = (item: any) => {
  const durationMs = effectiveDurationMs(item, store.activeItems.findIndex((candidate: any) => candidate.id === item.id));
  if (durationMs > 0) return `00:00:00 / ${msToClockDisplay(durationMs)}`;
  if (item.type === 'live') return 'LIVE';
  return '00:00:00 / 00:00:00';
};

const activeTimerLabel = (item: any, index: number) => {
  if (index !== store.currentPlayingIndex || !isPlayoutPlaying.value) return '';
  const totalMs = effectiveDurationMs(item, index);
  if (item.type === 'live' && totalMs <= 0) return `${msToClockDisplay(currentPlayoutMs.value)} / LIVE`;
  if (totalMs <= 0) return `${msToClockDisplay(currentPlayoutMs.value)} / 00:00:00`;
  return `${msToClockDisplay(currentPlayoutMs.value)} / ${msToClockDisplay(totalMs)}`;
};

const ratingClass = (rating: string) => `rating-${rating || 'none'}`;

const trimDisplay = (item: any) => {
  if (item.type === 'live') return 'LIVE';
  if (!item.inPoint && !item.outPoint) return 'FULL';
  const inLabel = item.inPoint ? msToShortDisplay(item.inPoint) : '0:00';
  const outLabel = item.outPoint ? msToShortDisplay(item.outPoint) : 'END';
  return `${inLabel}→${outLabel}`;
};
</script>

<template>
  <div class="rundown-wrapper">
    <!-- Header with clock -->
    <div class="rw-header">
      <div style="display:flex; align-items:center; gap:10px;">
        <h2 class="text-warning" style="margin:0; font-size:0.9rem;">Rundown</h2>
        <span v-if="isPlayoutPlaying" class="playing-badge">▶ ON AIR</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="clock-display">{{ clockStr }}</span>
        <button class="icon-action" @click="showLiveDialog = true" title="Add Live Entry">📹 Live</button>
        <button v-if="isPlayoutPlaying" class="icon-action btn-stop" @click="stopPlayback" title="Stop">■ Stop</button>
      </div>
    </div>

    <!-- Column labels -->
    <div class="rw-cols-label">
      <span style="width:18px;"></span>
      <span style="width:20px; text-align:center;">#</span>
      <span style="width:18px;"></span>
      <span style="flex:1;">File / Source</span>
      <span style="width:46px; text-align:center;">Rate</span>
      <span style="width:70px; text-align:center;">IN→OUT</span>
      <span style="width:168px; text-align:right;">Time</span>
      <span style="width:58px; text-align:center;">At</span>
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
        :class="{
          'selected': item.id === store.selectedItemId,
          'playing': index === store.currentPlayingIndex,
          'played': index < store.currentPlayingIndex,
          [ratingClass(item.complianceRating)]: item.complianceRating && item.complianceRating !== 'none'
        }"
        :style="index === store.currentPlayingIndex && isPlayoutPlaying && item.type !== 'live' ? {
            background: `linear-gradient(90deg, rgba(230,57,70,0.3) ${calcProgress(item)}%, rgba(230,57,70,0.08) ${calcProgress(item)}%)`,
            borderColor: 'rgba(230,57,70,0.4)'
        } : {}"
        @click="store.selectedItemId = item.id"
        @contextmenu.prevent="onContextMenu($event, index, item)"
        @dragover.prevent
        @drop.prevent
      >
        <div class="rw-handle" title="Drag to reorder">⋮⋮</div>
        <div class="rw-num">{{ index + 1 }}</div>
        <div class="rw-type-icon" :style="{ color: typeColor(item.type) }">{{ typeIcon(item.type) }}</div>
        <div class="rw-name" :title="item.filename">{{ item.filename }}</div>
        <div class="rw-rating">
          <span v-if="item.complianceRating && item.complianceRating !== 'none'" class="rw-rating-badge" :class="ratingClass(item.complianceRating)">{{ item.complianceRating.toUpperCase() }}</span>
          <span v-else class="rw-rating-empty">·</span>
        </div>
        <div class="rw-inout" :title="trimDisplay(item)">{{ trimDisplay(item) }}</div>

        <!-- Duration -->
        <div class="rw-dur">
          {{ activeTimerLabel(item, index) || durationLabel(item) }}
        </div>

          <div class="rw-at">
            <span v-if="scheduledTimes[index]?.kind === 'skip'" class="tc-done">–</span>
            <span v-else-if="scheduledTimes[index]?.kind === 'done'" class="tc-done">✓</span>
            <span v-else-if="scheduledTimes[index]?.kind === 'now'" class="tc-live">NOW</span>
            <span v-else-if="scheduledTimes[index]?.kind === 'time'" class="tc-sched">{{ scheduledTimes[index]?.text }}</span>
          </div>

        <!-- Row actions -->
        <div class="rw-actions">
          <button class="row-btn btn-play" :title="`Play from #${index+1}`" @click.stop="playFrom(index)">▶</button>
          <button class="row-btn row-btn-del" title="Remove (Del)" @click.stop="store.removeItem(item.id)">✕</button>
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
        <div class="menu-divider"></div>
        <div class="menu-item menu-item-danger" @click.stop="ctxDelete">✕ Delete</div>
      </div>
    </Teleport>

    <PlaylistControls />

    <LiveEntryDialog v-if="showLiveDialog" @close="showLiveDialog = false" />
  </div>
</template>

<style scoped>
.rundown-wrapper { height:100%; display:flex; flex-direction:column; overflow:hidden; position:relative; }
.rw-header {
  padding:5px 10px; border-bottom:1px solid var(--glass-border);
  background: var(--bg-secondary);
  display:flex; justify-content:space-between; align-items:center; flex-shrink:0;
}
.clock-display {
  font-family:'Courier New',monospace; font-size:1.3rem; font-weight:700;
  letter-spacing:2px; color:var(--text-primary); text-shadow:0 0 10px var(--glass-border);
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

.rw-cols-label {
  display:flex; align-items:center; gap:3px; padding:2px 6px;
  font-size:0.62rem; letter-spacing:0.5px; color:rgba(255,255,255,0.28);
  border-bottom:1px solid rgba(255,255,255,0.05); flex-shrink:0;
}
.rw-list { flex:1; overflow-y:auto; padding:2px 3px; min-height:0; transition:background 0.15s; }
.rw-list.drag-over { background:rgba(51,190,204,0.04); outline:2px dashed rgba(51,190,204,0.3); outline-offset:-3px; border-radius:6px; }

.rw-row {
  display:flex; align-items:center; gap:3px;
  height:36px; padding:0 3px;
  border-radius:4px; border:1px solid transparent;
  cursor:pointer; user-select:none; transition:background 0.12s;
}
.rw-row:hover { background:rgba(255,255,255,0.04); }
.rw-row.selected { background:rgba(51,190,204,0.08); border-color:rgba(51,190,204,0.3); }
.rw-row.playing  { background:rgba(230,57,70,0.08); border-color:rgba(230,57,70,0.4); }
.rw-row.played   { opacity:0.45; }
.rw-row.rating-k { box-shadow: inset 6px 0 0 rgba(29,185,84,0.85); }
.rw-row.rating-8 { box-shadow: inset 6px 0 0 rgba(42,111,204,0.9); }
.rw-row.rating-12 { box-shadow: inset 6px 0 0 rgba(255,153,0,0.9); }
.rw-row.rating-16 { box-shadow: inset 6px 0 0 rgba(128,90,213,0.9); }
.rw-row.rating-18 { box-shadow: inset 6px 0 0 rgba(230,57,70,0.95); }

.rw-handle { color:rgba(255,255,255,0.2); cursor:grab; font-size:0.75rem; width:18px; text-align:center; flex-shrink:0; }
.rw-num     { width:20px; text-align:center; font-size:0.67rem; color:rgba(255,255,255,0.3); flex-shrink:0; }
.rw-type-icon { width:18px; font-size:0.85rem; text-align:center; flex-shrink:0; }
.rw-name    { flex:1; font-size:0.78rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.rw-rating  { width:46px; text-align:center; flex-shrink:0; }
.rw-rating-badge {
  display:inline-flex; align-items:center; justify-content:center;
  min-width:30px; padding:3px 7px; border-radius:999px;
  font-size:0.62rem; font-weight:800; letter-spacing:0.08em;
  border:1px solid rgba(255,255,255,0.14);
}
.rw-rating-empty { color:rgba(255,255,255,0.16); font-size:0.7rem; }
.rw-rating-badge.rating-k { color:#9ef6cf; background:rgba(29,185,84,0.16); border-color:rgba(158,246,207,0.28); }
.rw-rating-badge.rating-8 { color:#8cc9ff; background:rgba(42,111,204,0.16); border-color:rgba(140,201,255,0.28); }
.rw-rating-badge.rating-12 { color:#ffbf69; background:rgba(255,153,0,0.16); border-color:rgba(255,191,105,0.28); }
.rw-rating-badge.rating-16 { color:#d0b7ff; background:rgba(128,90,213,0.16); border-color:rgba(208,183,255,0.28); }
.rw-rating-badge.rating-18 { color:#ff9c9c; background:rgba(230,57,70,0.18); border-color:rgba(255,156,156,0.28); }
.rw-inout   {
  width:70px; text-align:center; flex-shrink:0;
  font-size:0.6rem; color:rgba(255,255,255,0.42); font-variant-numeric:tabular-nums;
}
.rw-dur     { width:168px; text-align:right; font-size:0.68rem; color:rgba(255,255,255,0.56); font-variant-numeric:tabular-nums; flex-shrink:0; font-family:monospace; }
.rw-at      { width:58px; text-align:center; flex-shrink:0; }
.rw-actions { width:62px; display:flex; gap:2px; flex-shrink:0; justify-content:flex-end; }

.tc-badge { font-size:0.55rem; color:rgba(51,190,204,0.75); font-family:monospace; }
.tc-empty { font-size:0.6rem; color:rgba(255,255,255,0.18); }
.tc-sched { font-size:0.65rem; color:rgba(255,255,255,0.45); font-variant-numeric:tabular-nums; font-family:monospace; }
.tc-live  { font-size:0.65rem; color:#e63946; font-weight:700; letter-spacing:0.5px; }
.tc-done  { font-size:0.7rem; color:rgba(255,255,255,0.2); }

.row-btn {
  background:transparent; border:1px solid rgba(255,255,255,0.1); color:rgba(255,255,255,0.45);
  border-radius:3px; cursor:pointer; width:18px; height:22px; font-size:0.68rem;
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
