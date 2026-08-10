<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRundownStore } from '../stores/rundown';
import { invoke } from '@tauri-apps/api/core';

export interface LibraryTrimItem {
    id?: string;
    uuid?: string;
    path: string;
    filename: string;
    type: string;
    duration?: number;
    duration_ms?: number;
    inPoint?: number;
    outPoint?: number;
    fps?: number;
}

const store = useRundownStore();
const props = defineProps<{ 
    isOpen: boolean,
    libraryItem?: LibraryTrimItem | null
}>();
const emit  = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', payload: { uuid?: string; outputPath: string }): void;
}>();

const activeItem = ref<LibraryTrimItem | null>(null);
const item = computed(() => activeItem.value);
const panelRef = ref<HTMLElement | null>(null);

const lockTrimItem = () => {
  const source = props.libraryItem || store.selectedItem;
  activeItem.value = source ? {
    id: source.id,
    uuid: (props.libraryItem?.uuid) || (store.selectedItem?.playoutvueId) || source.id,
    path: source.path,
    filename: source.filename,
    type: source.type,
    duration: source.duration,
    duration_ms: (source as any).duration_ms,
    inPoint: source.inPoint,
    outPoint: source.outPoint,
    fps: (source as any).fps || 25
  } : null;
};

// ── Video preview via local streaming server ──────────────────────────────────
// We get a stream URL from our Rust media_server (zero memory overhead)
const videoRef = ref<HTMLVideoElement | null>(null);
const videoSrc = ref('');
const isVideoPlaying = ref(false);
const isGeneratingProxy = ref(false);
const previewError = ref('');
const previewMode = ref<'source' | 'proxy'>('source');
const proxyAttemptedPath = ref('');
let previewFallbackTimer: ReturnType<typeof setTimeout> | null = null;

const clearPreviewFallbackTimer = () => {
  if (!previewFallbackTimer) return;
  clearTimeout(previewFallbackTimer);
  previewFallbackTimer = null;
};

const loadProxyPreview = async (path: string | undefined, reason: string) => {
  if (!path || item.value?.type === 'live' || path.startsWith('http')) return;
  if (proxyAttemptedPath.value === path) return;

  proxyAttemptedPath.value = path;
  previewMode.value = 'proxy';
  isGeneratingProxy.value = true;
  previewError.value = '';
  videoSrc.value = '';
  clearPreviewFallbackTimer();

  try {
    videoSrc.value = await invoke<string>('get_media_preview_url', { inputPath: path });
  } catch (error) {
    previewError.value = `Preview proxy failed: ${error}`;
  } finally {
    isGeneratingProxy.value = false;
  }
};

const loadVideoSrc = async (path: string | undefined) => {
    clearPreviewFallbackTimer();
    videoSrc.value = '';
    previewError.value = '';
    isGeneratingProxy.value = false;
    previewMode.value = 'source';
    proxyAttemptedPath.value = '';
    if (!path || item.value?.type === 'live' || path.startsWith('http')) return;
    try {
        videoSrc.value = await invoke<string>('get_media_url', { path });
        previewFallbackTimer = setTimeout(() => {
          loadProxyPreview(path, 'metadata timeout').catch(() => {});
        }, 2500);
    } catch (e) {
        console.warn('[TrimPanel] failed to get streaming URL:', e);
        await loadProxyPreview(path, 'source url failure');
    }
};

// ── State ────────────────────────────────────────────────────────────────────
const inMs   = ref(0);
const outMs  = ref(0);
const totalDurationMs = ref(0);
const fullFileDurationMs = ref(0);
const viewTrimmed = ref(false);
const isProbing  = ref(false);
const isTrimming = ref(false);
const isSmartTrimming = ref(false);
const trimStatus = ref('');
const speed = ref(0); // for JKL display badge
const FRAME_MS = computed(() => {
    const fps = item.value?.fps && item.value.fps > 0 ? item.value.fps : 25;
    return 1000 / fps;
});
const PLAYHEAD_UI_INTERVAL_MS = 120;

const scrubDurationMs = computed(() => viewTrimmed.value ? Math.max(0, outMs.value - inMs.value) : totalDurationMs.value);
const scrubOffsetMs = computed(() => viewTrimmed.value ? inMs.value : 0);
const displayTotalMs = computed(() => viewTrimmed.value ? Math.max(0, outMs.value - inMs.value) : totalDurationMs.value);

const scrubToAbsolute = (scrubMs: number) => scrubMs + scrubOffsetMs.value;
const absoluteToScrub = (absMs: number) => Math.max(0, absMs - scrubOffsetMs.value);

const clampMs = (ms: number) => Math.max(0, Math.min(ms, totalDurationMs.value || ms));
const isLocalFilePath = (path?: string) => !!path && !/^https?:/i.test(path);

// ── Seek video ────────────────────────────────────────────────────────────────
const timelineRef = ref<HTMLElement | null>(null);
const playheadRef = ref<HTMLElement | null>(null);
const playbackTime = ref(0);
const draggingTimelineItem = ref<'in' | 'out' | 'playhead' | null>(null);

let pendingSeekMs: number | null = null;
let seekAnimationFrame = 0;
let lastPlaybackUiUpdateAt = 0;
let lastKnownPlaybackMs = 0;

const updatePlayheadPosition = (ms: number) => {
  const clamped = clampMs(ms);
  lastKnownPlaybackMs = clamped;
  if (playheadRef.value) {
    const scrubMs = absoluteToScrub(clamped);
    const total = scrubDurationMs.value;
    const left = total > 0 ? (scrubMs / total) * 100 : 0;
    playheadRef.value.style.left = `${left}%`;
  }
};

const syncPlaybackDisplay = (ms: number, forceReactive = false) => {
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
  if (!v || pendingSeekMs == null) return;

  const clamped = clampMs(pendingSeekMs);
  pendingSeekMs = null;
  v.currentTime = clamped / 1000;
  syncPlaybackDisplay(clamped, true);
};

const queueSeek = (ms: number, forceReactive = false) => {
  const clamped = clampMs(ms);
  syncPlaybackDisplay(clamped, forceReactive);
  pendingSeekMs = clamped;
  if (!seekAnimationFrame) {
    seekAnimationFrame = requestAnimationFrame(flushPendingSeek);
  }
};

const seekTo = (ms: number, forceReactive = true) => {
  queueSeek(ms, forceReactive);
};

const syncPlaybackState = () => {
  isVideoPlaying.value = !!videoRef.value && !videoRef.value.paused && !videoRef.value.ended;
};

const togglePlayback = async () => {
  const v = videoRef.value;
  if (!v) return;
  if (v.paused) {
    speed.value = 1;
    v.playbackRate = 1;
    await v.play().catch(() => {});
  } else {
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
    } else {
      syncPlaybackDisplay(currentMs);
    }
    syncPlaybackState();
  }
};

const getMsFromEvent = (e: MouseEvent) => {
    if (!timelineRef.value || scrubDurationMs.value <= 0) return 0;
    const rect = timelineRef.value.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const percentage = x / rect.width;
    return Math.round(scrubToAbsolute(percentage * scrubDurationMs.value));
};

const onTimelineMouseDown = (e: MouseEvent, target: 'in' | 'out' | 'playhead') => {
    draggingTimelineItem.value = target;
    handleTimelineDrag(e);
};

const handleTimelineDrag = (e: MouseEvent) => {
    if (!draggingTimelineItem.value) return;
    const ms = getMsFromEvent(e);
    if (draggingTimelineItem.value === 'in') {
        inMs.value = Math.min(ms, outMs.value);
    queueSeek(inMs.value);
    } else if (draggingTimelineItem.value === 'out') {
        outMs.value = Math.max(ms, inMs.value);
    queueSeek(outMs.value);
    } else if (draggingTimelineItem.value === 'playhead') {
    queueSeek(ms);
    }
};

const onWindowMouseMove = (e: MouseEvent) => {
    if (draggingTimelineItem.value) handleTimelineDrag(e);
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
    if (!v || isNaN(v.duration)) return;
    if (!Number.isFinite(v.duration) || v.videoWidth <= 0) {
      loadProxyPreview(item.value?.path, 'undecodable source').catch(() => {});
      return;
    }
    const dur = v.duration * 1000;
    if (dur > 0) {
        fullFileDurationMs.value = dur;
        totalDurationMs.value = dur;
        inMs.value = Math.max(0, Math.min(inMs.value, dur));
        if (outMs.value === 0 || outMs.value > dur) outMs.value = dur;
      // Seek the preview to the IN point so the visible frame matches the
      // IN timecode (no auto viewTrimmed flip — trimmed view is opt-in).
      seekTo(inMs.value || 0, true);
    }
};

const onVideoError = () => {
  if (previewMode.value === 'proxy') {
    previewError.value = 'Preview is not available for this file in the embedded player.';
    return;
  }
  loadProxyPreview(item.value?.path, 'video decode error').catch(() => {});
};

// ── Probe via ffprobe (fallback for formats browser can't decode) ─────────────
const probeDuration = async () => {
    if (!item.value?.path || item.value.type === 'live') return;
    isProbing.value = true;
    try {
        const meta = await invoke<{ duration: string }>('scan_media', { filepath: item.value.path });
        const dur  = parseFloat(meta.duration) * 1000;
        if (dur > 0) {
            totalDurationMs.value = dur;
            if (outMs.value === 0 || outMs.value > dur) outMs.value = dur;
          syncPlaybackDisplay(inMs.value || 0, true);
        }
    } catch { }
    finally { isProbing.value = false; }
};

// ── Hydrate when panel opens ──────────────────────────────────────────────────
watch(() => props.isOpen, (open) => {
  if (open) {
    lockTrimItem();
  } else {
    activeItem.value = null;
  }
}, { immediate: true });

watch([item, () => props.isOpen], ([val, open]) => {
  if (val && open) {
    const fileDurationMs = (val as any).duration_ms && (val as any).duration_ms > 0
      ? (val as any).duration_ms
      : (val.duration && val.duration > 0 ? val.duration * 1000 : 0);
    inMs.value  = val.inPoint  || 0;
    outMs.value = val.outPoint || fileDurationMs;
    totalDurationMs.value = fileDurationMs;
    viewTrimmed.value = false;
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
        if (videoRef.value) videoRef.value.pause();
        videoSrc.value = '';
    }
}, { immediate: true });

// ── Timecodes ─────────────────────────────────────────────────────────────────
const msToTC = (ms: number): string => {
    if (!Number.isFinite(ms)) return '00:00:00:00';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const f = Math.floor((ms % 1000) / FRAME_MS.value);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(f).padStart(2,'0')}`;
};
const tcToMs = (tc: string): number => {
    const p = tc.split(':').map(Number);
    if (p.length < 3 || p.slice(0, p.length).some(isNaN)) return -1;
    const [h=0, m=0, s=0, f=0] = p;
    if (p.length === 4) return (h*3600 + m*60 + s)*1000 + f*FRAME_MS.value;
    return (h*3600 + m*60 + s)*1000;
};
const applyInTC  = (e: Event) => { const v = tcToMs((e.target as HTMLInputElement).value); if (v >= 0) { inMs.value  = Math.min(v, outMs.value); seekTo(inMs.value); } };
const applyOutTC = (e: Event) => { const v = tcToMs((e.target as HTMLInputElement).value); if (v >= 0) outMs.value = Math.max(v, inMs.value); };
const trimmedDuration = computed(() => {
    const d = outMs.value - inMs.value;
    return d > 0 ? `${(d/1000).toFixed(1)}s  (${msToTC(d)})` : '–';
});
const currentTimecode = computed(() => msToTC(playbackTime.value));

const hasTrimRange = computed(() => outMs.value > 0 && inMs.value >= 0 && outMs.value > inMs.value && outMs.value < totalDurationMs.value + 1000);
const inHandlePct = computed(() => {
  const total = scrubDurationMs.value;
  if (total <= 0) return 0;
  return (absoluteToScrub(inMs.value) / total) * 100;
});
const outHandlePct = computed(() => {
  const total = scrubDurationMs.value;
  if (total <= 0) return 100;
  return (absoluteToScrub(outMs.value) / total) * 100;
});
const rangeLeftPct = computed(() => inHandlePct.value);
const rangeWidthPct = computed(() => Math.max(0, outHandlePct.value - inHandlePct.value));
const scrubLabelStart = computed(() => msToTC(scrubOffsetMs.value));
const scrubLabelEnd = computed(() => msToTC(scrubOffsetMs.value + scrubDurationMs.value));
const displayInTC = computed(() => msToTC(inMs.value));
const displayOutTC = computed(() => msToTC(outMs.value));

const toggleViewTrimmed = () => {
  viewTrimmed.value = !viewTrimmed.value;
  if (viewTrimmed.value) {
    seekTo(inMs.value);
  }
};

const setInPoint = (ms = Math.round(currentVideoMs())) => {
  inMs.value = clampMs(ms);
  if (inMs.value > outMs.value) outMs.value = inMs.value;
  trimStatus.value = `IN: ${msToTC(inMs.value)}`;
};

const setOutPoint = (ms = Math.round(currentVideoMs())) => {
  outMs.value = clampMs(ms);
  if (outMs.value < inMs.value) inMs.value = outMs.value;
  trimStatus.value = `OUT: ${msToTC(outMs.value)}`;
};

const jumpToMarker = (marker: 'start' | 'in' | 'out' | 'end') => {
  if (marker === 'start') return seekTo(0);
  if (marker === 'in') return seekTo(inMs.value);
  if (marker === 'out') return seekTo(outMs.value);
  seekTo(totalDurationMs.value);
};

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
const currentVideoMs = () => lastKnownPlaybackMs || ((videoRef.value?.currentTime ?? 0) * 1000);
const nudge = (frames: number) => {
  seekTo(currentVideoMs() + frames * FRAME_MS.value);
};
const applySpeed = (s: number) => {
    const v = videoRef.value; if (!v) return;
    speed.value = s;
  if (s === 0) { v.pause(); syncPlaybackState(); return; }
    v.playbackRate = Math.abs(s) === 2 ? 4 : 1;
  if (s > 0) v.play().catch(() => {});
  else v.pause();
  syncPlaybackState();
};
const handleKey = (e: KeyboardEvent) => {
    if (!props.isOpen) return;
    const tag = (e.target as HTMLElement).tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
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
    case 'j': e.preventDefault(); applySpeed(speed.value === -2 ? 0 : (speed.value === 0 ? -1 : -2)); break;
    case 'k': e.preventDefault(); applySpeed(0); break;
    case 'l': e.preventDefault(); applySpeed(speed.value === 2 ? 0 : (speed.value === 0 ? 1 : 2)); break;
    case 'i': e.preventDefault(); setInPoint(); break;
    case 'o': e.preventDefault(); setOutPoint(); break;
    }
};
onMounted(()  => {
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
});
onUnmounted(() => {
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
  clearPreviewFallbackTimer();
  if (seekAnimationFrame) cancelAnimationFrame(seekAnimationFrame);
});

// ── Save / Trim ───────────────────────────────────────────────────────────────
const saveNonDestructive = () => {
    if (!item.value) return;
    if (outMs.value > 0 && outMs.value <= inMs.value) {
      trimStatus.value = '❌ OUT point must be greater than IN point.';
      return;
    }

    const saveTask = async () => {
      if (item.value) {
        store.updateAssetTrim(
          { id: item.value.id, uuid: item.value.uuid, path: item.value.path },
          inMs.value,
          outMs.value
        );
      }

      if (item.value?.uuid && !item.value.uuid.startsWith('local:')) {
        await invoke('update_ingestor_trim', {
          uuid: item.value.uuid,
          trim_in_ms: Math.round(inMs.value),
          trim_out_ms: Math.round(outMs.value),
          api_base_url_override: null
        });
      } else if (isLocalFilePath(item.value?.path)) {
        await invoke('save_media_trim_profile', {
          path: item.value!.path,
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
    if (!currentItem) return;
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
        const response = await invoke<any>('create_ingestor_subclip', {
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
    } else {
      trimStatus.value = '❌ Sub-clipping is only supported for server-side managed assets.';
    }
};
</script>

<template>
  <div v-if="isOpen && item" ref="panelRef" class="modal-backdrop" tabindex="0" style="outline: none;" @click.self="$emit('close')" @keydown.capture="handleKey">
    <div class="glass-panel trim-panel">

      <!-- Header -->
      <div class="trim-header">
        <div>
          <div class="text-accent" style="font-size:0.88rem;font-weight:600;">✂️ {{ item.filename }}</div>
          <div class="text-secondary" style="font-size:0.68rem;">
            <span v-if="viewTrimmed" style="color:var(--accent-blue,#33becc)">
              Content: {{ (displayTotalMs/1000).toFixed(1) }}s
            </span>
            <span v-else>
              Total: {{ isProbing ? '⌛' : (displayTotalMs ? (displayTotalMs/1000).toFixed(2)+'s' : 'type timecodes') }}
            </span>
            <span v-if="viewTrimmed && fullFileDurationMs" style="opacity:0.55">
              &nbsp;|&nbsp;Full: {{ (fullFileDurationMs/1000).toFixed(1) }}s
            </span>
            &nbsp;|&nbsp; Selection: <strong style="color:var(--accent-blue,#33becc)">{{ trimmedDuration }}</strong>
          </div>
        </div>
        <div class="shortcut-hint">
          <span>J</span>rewind &nbsp;<span>K</span>pause &nbsp;<span>L</span>fwd &nbsp;
          <span>I</span>set IN &nbsp;<span>O</span>set OUT &nbsp;<span>← →</span>1fr &nbsp;<span>⇧← →</span>10fr
        </div>
        <button
          v-if="hasTrimRange"
          class="view-toggle-btn"
          :class="{ active: viewTrimmed }"
          @click="toggleViewTrimmed"
          :title="viewTrimmed ? 'Show Full File' : 'Show Trimmed Range'"
        >
          {{ viewTrimmed ? '🔍 Trimmed' : '📁 Full File' }}
        </button>
        <button class="icon-btn" @click="$emit('close')">✕</button>
      </div>

      <!-- Two-column: Video | Controls -->
      <div class="trim-body">

        <!-- Left: Video preview -->
        <div class="video-col">
          <video v-if="videoSrc" ref="videoRef" :src="videoSrc" class="trim-video"
            muted preload="metadata" @loadedmetadata="onVideoLoaded" @error="onVideoError" @timeupdate="onTimeUpdate" @play="syncPlaybackState" @pause="syncPlaybackState"></video>
          <div v-else-if="item.type === 'live' || item.path?.startsWith('http')" class="video-placeholder">
            <div style="font-size:2rem;">{{ item.type === 'live' ? '📹' : '🌐' }}</div>
            <small class="text-secondary">No local preview</small>
          </div>
          <div v-else-if="isGeneratingProxy" class="video-placeholder">
            <div style="font-size:1.5rem;">🎞️</div>
            <small class="text-secondary">Generating proxy preview for large or unsupported media…</small>
          </div>
          <div v-else-if="previewError" class="video-placeholder">
            <div style="font-size:1.5rem;">⚠</div>
            <small class="text-secondary">{{ previewError }}</small>
          </div>
          <div v-else class="video-placeholder">
            <div style="font-size:1.5rem;">⌛</div>
            <small class="text-secondary">Loading preview…</small>
          </div>
          <div v-if="speed !== 0" class="speed-badge">{{ speed < 0 ? '◀◀' : '▶▶' }} {{ Math.abs(speed) === 2 ? '×4' : '×1' }}</div>

          <div class="transport-bar">
            <button class="transport-btn" @click="jumpToMarker('start')">⏮</button>
            <button class="transport-btn" @click="nudge(-10)">-10f</button>
            <button class="transport-btn" @click="nudge(-1)">-1f</button>
            <button class="transport-btn transport-btn-primary" @click="togglePlayback">{{ isVideoPlaying ? '⏸ Pause' : '▶ Play' }}</button>
            <button class="transport-btn" @click="nudge(1)">+1f</button>
            <button class="transport-btn" @click="nudge(10)">+10f</button>
            <button class="transport-btn" @click="jumpToMarker('end')">⏭</button>
          </div>
        </div>

        <!-- Right: Controls -->
        <div class="ctrl-col">

          <div class="trim-metrics">
            <div class="metric-card">
              <span class="metric-label">Current</span>
              <strong>{{ currentTimecode }}</strong>
            </div>
            <div class="metric-card">
              <span class="metric-label">In → Out</span>
              <strong>{{ trimmedDuration }}</strong>
            </div>
          </div>

          <!-- Scrub bar -->
          <div class="scrub-area">
            <div class="unified-timeline" ref="timelineRef" @mousedown.left="onTimelineMouseDown($event, 'playhead')">
              <div class="tm-bg"></div>
              <div class="tm-range" :style="{
                left:  rangeLeftPct+'%',
                width: rangeWidthPct+'%'
              }"></div>
              
              <div class="tm-handle-wrapper" :style="{ left: inHandlePct+'%' }" >
                 <div class="tm-handle tm-handle-in" @mousedown.prevent.stop.left="onTimelineMouseDown($event, 'in')">◂</div>
              </div>
              
              <div class="tm-handle-wrapper" :style="{ left: outHandlePct+'%' }">
                 <div class="tm-handle tm-handle-out" @mousedown.prevent.stop.left="onTimelineMouseDown($event, 'out')">▸</div>
              </div>

                <div ref="playheadRef" class="tm-playhead" @mousedown.prevent.stop.left="onTimelineMouseDown($event, 'playhead')">
                 <div class="tm-playhead-line"></div>
              </div>
            </div>
            
            <div style="display:flex;justify-content:space-between;margin-top:8px;">
              <span class="text-secondary" style="font-size:0.6rem;">{{ scrubLabelStart }}</span>
              <span class="text-secondary" style="font-size:0.6rem;">{{ scrubLabelEnd }}</span>
            </div>
          </div>

          <!-- IN / OUT slots -->
          <div class="tc-grid">
            <div class="tc-group">
              <label class="text-secondary" style="font-size:0.68rem;">IN POINT</label>
              <input class="tc-input" :value="displayInTC" @change="applyInTC" placeholder="00:00:00:00" spellcheck="false">
              <div class="tc-actions">
                <button class="mini-btn" @click="jumpToMarker('in')">Cue</button>
                <button class="mini-btn" @click="setInPoint()">Set from playhead</button>
              </div>
            </div>
            <div class="tc-group">
              <label class="text-secondary" style="font-size:0.68rem;">OUT POINT</label>
              <input class="tc-input" :value="displayOutTC" @change="applyOutTC" placeholder="00:00:00:00" spellcheck="false">
              <div class="tc-actions">
                <button class="mini-btn" @click="jumpToMarker('out')">Cue</button>
                <button class="mini-btn" @click="setOutPoint()">Set from playhead</button>
              </div>
            </div>
          </div>

          <!-- Non-destructive save (Only for Rundown Items) -->
          <div class="trim-actions">
            <button class="trim-btn btn-primary" @click="saveNonDestructive">
              💾 Save Trim Points
            </button>
            <button v-if="item && item.uuid && !item.uuid.startsWith('local:')" class="trim-btn btn-accurate" @click="saveAsSubclip">
              🎬 Save as Virtual Sub-clip
            </button>
            <button class="trim-btn" @click="$emit('close')">Cancel</button>
          </div>
          <div v-if="trimStatus" class="trim-status">{{ trimStatus }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop { position:fixed;inset:0;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);display:flex;justify-content:center;align-items:center;z-index:10000; }
.trim-panel { width:1040px;max-width:96vw;padding:1rem;display:flex;flex-direction:column;gap:0.85rem;background:var(--bg-secondary,#1B1B1B);border:1px solid rgba(255,255,255,0.1);border-radius:12px;box-shadow:0 30px 60px rgba(0,0,0,0.8); }
.trim-header { display:flex;justify-content:space-between;align-items:flex-start;gap:12px; }
.icon-btn { background:transparent;border:none;color:var(--text-secondary);cursor:pointer;font-size:1rem;padding:4px;flex-shrink:0; }
.shortcut-hint { font-size:0.62rem;color:rgba(255,255,255,0.3);display:flex;align-items:center;flex-wrap:wrap;gap:2px;flex:1;justify-content:center; }
.shortcut-hint span { background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:3px;padding:1px 5px;color:rgba(255,255,255,0.6);font-family:monospace;font-size:0.65rem; }
.trim-body { display:grid;grid-template-columns:1.15fr 0.95fr;gap:1rem; }
.video-col { aspect-ratio: 16/9; max-height: 40vh; width: 100%; height: auto; background: #000; position: relative; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.trim-video { width: 100%; height: 100%; object-fit: contain; display: block; }
.video-placeholder { text-align:center;padding:2rem;color:rgba(255,255,255,0.25); }
.speed-badge { position:absolute;bottom:6px;right:8px;background:rgba(0,0,0,0.7);color:#e63946;font-size:0.72rem;font-weight:700;padding:2px 7px;border-radius:3px;letter-spacing:1px; }
.transport-bar {
  position:absolute;
  left:10px;
  right:10px;
  bottom:10px;
  display:flex;
  gap:6px;
  justify-content:center;
  flex-wrap:wrap;
}
.transport-btn {
  padding:7px 10px;
  border-radius:8px;
  border:1px solid rgba(255,255,255,0.15);
  background:rgba(0,0,0,0.6);
  color:#fff;
  cursor:pointer;
}
.transport-btn-primary {
  background:rgba(51,190,204,0.22);
  border-color:rgba(51,190,204,0.45);
}
.ctrl-col { display:flex;flex-direction:column;gap:0.7rem; }
.trim-metrics { display:grid;grid-template-columns:1fr 1fr;gap:0.7rem; }
.metric-card {
  border:1px solid rgba(255,255,255,0.08);
  background:rgba(255,255,255,0.04);
  border-radius:8px;
  padding:10px 12px;
  display:flex;
  flex-direction:column;
  gap:4px;
}
.metric-card strong { color:var(--text-primary); font-family:'Courier New',monospace; font-size:0.9rem; }
.metric-label { font-size:0.7rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.08em; }
.scrub-area { background:rgba(0,0,0,0.3);border-radius:6px;padding:0.7rem; }

.unified-timeline { position:relative;height:30px;background:rgba(255,255,255,0.03);border-radius:4px;cursor:pointer;margin-top:10px;margin-bottom:5px; }
.tm-bg { position:absolute;top:50%;transform:translateY(-50%);left:0;right:0;height:10px;background:rgba(0,0,0,0.4);border-radius:4px;pointer-events:none; }
.tm-range { position:absolute;top:50%;transform:translateY(-50%);height:10px;background:rgba(51,190,204,0.3);border-radius:4px;pointer-events:none; }
.tm-handle-wrapper { position:absolute;top:0;bottom:0;width:0;z-index:10; }
.tm-handle { position:absolute;top:-5px;bottom:-5px;width:14px;border-radius:3px;cursor:ew-resize;display:flex;align-items:center;justify-content:center;color:#000;font-size:10px;font-weight:bold;box-shadow:0 0 4px rgba(0,0,0,0.5);transform:translateX(-50%); }
.tm-handle-in { background:var(--accent-blue,#33becc); }
.tm-handle-out { background:#e63946; }
.tm-playhead { position:absolute;top:-8px;bottom:-8px;width:12px;cursor:ew-resize;z-index:20;transform:translateX(-50%);display:flex;justify-content:center; }
.tm-playhead::before { content:'';position:absolute;top:0;width:8px;height:8px;background:#fff;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,0.5); }
.tm-playhead-line { width:2px;height:100%;background:#fff;opacity:0.8;pointer-events:none; }

.tc-grid { display:grid;grid-template-columns:1fr 1fr;gap:0.7rem; }
.tc-group { display:flex;flex-direction:column;gap:3px; }
.tc-input { font-family:'Courier New',monospace;font-size:1rem;font-weight:700;letter-spacing:3px;text-align:center;background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.12);color:var(--accent-blue,#33becc);padding:7px;border-radius:6px;width:100%;transition:border-color 0.15s; }
.tc-input:focus { outline:none;border-color:rgba(51,190,204,0.6); }
.tc-actions { display:flex; gap:6px; }
.mini-btn {
  flex:1;
  padding:6px 8px;
  border-radius:6px;
  border:1px solid rgba(255,255,255,0.12);
  background:rgba(255,255,255,0.04);
  color:var(--text-primary);
  cursor:pointer;
  font-size:0.72rem;
}
.trim-actions { display:flex;gap:0.6rem; }
.trim-btn { padding:7px 12px;border-radius:5px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:var(--text-primary);cursor:pointer;transition:0.15s;font-size:0.82rem; }
.trim-btn:hover { background:rgba(255,255,255,0.1); }
.trim-btn:disabled { opacity:0.4;cursor:not-allowed; }
.btn-primary  { background:rgba(51,190,204,0.15);border-color:rgba(51,190,204,0.4);color:var(--accent-blue,#33becc); }
.btn-danger   { background:rgba(230,57,70,0.12);border-color:rgba(230,57,70,0.4);color:#e63946; }
.btn-accurate { background:rgba(255,165,0,0.1);border-color:rgba(255,165,0,0.35);color:#ffa500; }
.section-divider { border-top:1px solid rgba(255,255,255,0.07);text-align:center; }
.warning-badge { background:rgba(255,165,0,0.07);border:1px solid rgba(255,165,0,0.22);color:#ffa500;border-radius:4px;padding:3px 8px;font-size:0.68rem; }
.trim-status { font-size:0.78rem;padding:4px 8px;background:rgba(0,0,0,0.3);border-radius:4px; }

.view-toggle-btn {
  padding:3px 8px;
  border-radius:5px;
  border:1px solid rgba(255,255,255,0.14);
  background:rgba(255,255,255,0.04);
  color:var(--text-secondary);
  font-size:0.64rem;
  font-weight:600;
  cursor:pointer;
  transition:0.15s;
  white-space:nowrap;
}
.view-toggle-btn:hover { background:rgba(255,255,255,0.1); color:var(--text-primary); }
.view-toggle-btn.active {
  background:rgba(51,190,204,0.14);
  border-color:rgba(51,190,204,0.4);
  color:var(--accent-blue,#33becc);
}

@media (max-width: 900px) {
  .trim-body,
  .trim-metrics,
  .tc-grid {
    grid-template-columns: 1fr;
  }
}
</style>
