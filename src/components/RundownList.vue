<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRundownStore } from '../stores/rundown';
import { draggingItem } from '../composables/useDragState';
import { PlaybackService, isPlaying, obs, playStartTime, playStartIndex } from '../services/obs';
import Sortable from 'sortablejs';
import TrimPanel from './TrimPanel.vue';
import LiveEntryDialog from './LiveEntryDialog.vue';
import PlaylistControls from './PlaylistControls.vue';

const store = useRundownStore();
const rundownListRef = ref<HTMLElement | null>(null);
const isDragOver = ref(false);
const showTrimPanel = ref(false);
const showLiveDialog = ref(false);

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
    if (item.outPoint > 0 && item.outPoint > item.inPoint) return item.outPoint - item.inPoint;
    return (item.duration > 0 ? item.duration * 1000 : 60000);
};

// Correct schedule: every item's start time is playStartTime + sum of durations
// of all items from playStartIndex up to (but not including) that item.
// Items before playStartIndex are marked as skipped.
const scheduledTimes = computed(() => {
    const playing = store.currentPlayingIndex >= 0;
    const sIdx = playing ? playStartIndex.value : 0;
    const base  = playing ? playStartTime.value  : clockNow.value;

    return store.activeItems.map((item, idx) => {
        if (playing && idx < sIdx)                        return { kind: 'skip' };
        if (playing && idx < store.currentPlayingIndex)   return { kind: 'done' };
        if (playing && idx === store.currentPlayingIndex)  return { kind: 'now' };
        // Compute offset: sum durations from sIdx to idx (exclusive)
        let acc = 0;
        for (let j = sIdx; j < idx; j++) acc += itemDurationMs(store.activeItems[j]);
        const d = new Date(base + acc);
        return { kind: 'time', text: d.toLocaleTimeString('el-GR', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false }) };
    });
});


// ── Playback ─────────────────────────────────────────────────────────────────
PlaybackService.onAdvance((index) => {
    store.currentPlayingIndex = index;
    store.selectedItemId = store.activeItems[index]?.id || null;
});

const playFrom = async (index: number) => {
    store.currentPlayingIndex = index;
    await PlaybackService.play(store.activeItems as any, index);
};

const stopPlayback = async () => {
    await PlaybackService.stop();
    store.currentPlayingIndex = -1;
};

// ── Duplicate (Shift+Down) ────────────────────────────────────────────────────
const openTrim = (id: string) => {
    store.selectedItemId = id;
    showTrimPanel.value = true;
};

onMounted(() => {
    // SortableJS for internal reordering
    if (rundownListRef.value) {
        Sortable.create(rundownListRef.value, {
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
});

onUnmounted(() => {
    window.removeEventListener('keydown', handleKey);
});

const handleKey = (e: KeyboardEvent) => {
    const id = store.selectedItemId;
    const items = store.activeItems;
    const idx = id ? items.findIndex(i => i.id === id) : -1;

    if (e.shiftKey && e.key === 'ArrowDown') {
        // Duplicate selected item, insert below
        e.preventDefault();
        if (idx !== -1) {
            store.duplicateItem(id!);
            // Select the new duplicate (idx + 1)
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
const onDrop = (e: DragEvent) => {
    e.preventDefault(); isDragOver.value = false;
    if (draggingItem.value) { store.addItem(draggingItem.value); draggingItem.value = null; }
};

const typeIcon  = (t: string) => ({ video: '🎬', live: '📹', graphic: '🎨' }[t] || '📄');
const typeColor = (t: string) => ({ video: '#33becc', live: '#e63946', graphic: '#a8dadc' }[t] || '#aaa');

const msToDisplay = (ms: number) => {
    if (!ms) return '--:--';
    const m = Math.floor(ms / 60000);
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2,'0');
    return `${m}:${s}`;
};
</script>

<template>
  <div class="rundown-wrapper">
    <!-- Header with clock -->
    <div class="rw-header">
      <div style="display:flex; align-items:center; gap:10px;">
        <h2 class="text-warning" style="margin:0; font-size:0.9rem;">Rundown</h2>
        <span v-if="isPlaying" class="playing-badge">▶ ON AIR</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="clock-display">{{ clockStr }}</span>
        <button class="icon-action" @click="showLiveDialog = true" title="Add Live Entry">📹 Live</button>
        <button v-if="isPlaying" class="icon-action btn-stop" @click="stopPlayback" title="Stop">■ Stop</button>
      </div>
    </div>

    <!-- Column labels -->
    <div class="rw-cols-label">
      <span style="width:18px;"></span>
      <span style="width:20px; text-align:center;">#</span>
      <span style="width:18px;"></span>
      <span style="flex:1;">File / Source</span>
      <span style="width:70px; text-align:center;">IN→OUT</span>
      <span style="width:52px; text-align:right;">Dur</span>
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
          'played': index < store.currentPlayingIndex
        }"
        @click="store.selectedItemId = item.id"
        @dblclick="openTrim(item.id)"
        @dragover.prevent
        @drop.prevent
      >
        <div class="rw-handle" title="Drag to reorder">⋮⋮</div>
        <div class="rw-num">{{ index + 1 }}</div>
        <div class="rw-type-icon" :style="{ color: typeColor(item.type) }">{{ typeIcon(item.type) }}</div>
        <div class="rw-name" :title="item.filename">{{ item.filename }}</div>

        <!-- IN→OUT badge -->
        <div class="rw-inout">
          <span v-if="item.inPoint || item.outPoint" class="tc-badge">
            {{ msToDisplay(item.inPoint) }}→{{ msToDisplay(item.outPoint) }}
          </span>
          <span v-else class="tc-empty">full</span>
        </div>

        <!-- Duration -->
        <div class="rw-dur">
          {{ itemDurationMs(item) > 0 ? msToDisplay(itemDurationMs(item)) : '∞' }}
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
          <button class="row-btn" title="Trim IN/OUT" @click.stop="openTrim(item.id)">✂</button>
          <button class="row-btn row-btn-del" title="Remove (Del)" @click.stop="store.removeItem(item.id)">✕</button>
        </div>
      </div>

      <div v-if="store.activeItems.length === 0" class="rw-empty">
        Drop media here or click 📹 Live
      </div>
    </div>

    <PlaylistControls />

    <TrimPanel :is-open="showTrimPanel" @close="showTrimPanel = false" />
    <LiveEntryDialog v-if="showLiveDialog" @close="showLiveDialog = false" />
  </div>
</template>

<style scoped>
.rundown-wrapper { height:100%; display:flex; flex-direction:column; overflow:hidden; }
.rw-header {
  padding:5px 10px; border-bottom:1px solid var(--glass-border);
  display:flex; justify-content:space-between; align-items:center; flex-shrink:0;
}
.clock-display {
  font-family:'Courier New',monospace; font-size:0.9rem; font-weight:700;
  letter-spacing:2px; color:var(--accent-blue,#33becc);
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

.rw-handle { color:rgba(255,255,255,0.2); cursor:grab; font-size:0.75rem; width:18px; text-align:center; flex-shrink:0; }
.rw-num     { width:20px; text-align:center; font-size:0.67rem; color:rgba(255,255,255,0.3); flex-shrink:0; }
.rw-type-icon { width:18px; font-size:0.85rem; text-align:center; flex-shrink:0; }
.rw-name    { flex:1; font-size:0.78rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.rw-inout   { width:70px; text-align:center; flex-shrink:0; }
.rw-dur     { width:52px; text-align:right; font-size:0.68rem; color:rgba(255,255,255,0.4); font-variant-numeric:tabular-nums; flex-shrink:0; }
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
  height:80px; color:rgba(255,255,255,0.18); font-size:0.78rem;
  border:2px dashed rgba(255,255,255,0.06); border-radius:6px; margin:4px;
}
.rw-ghost { opacity:0.3; background:rgba(255,255,255,0.06); }
</style>
