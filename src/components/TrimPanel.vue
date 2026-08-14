<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRundownStore } from '../stores/rundown';
import { invoke } from '@tauri-apps/api/core';
import { msToTimecode, parseTimecode, snapMsToFrame, getFrameRate, isDropFrameSupported } from '../lib/timecode';
import { activeTrimmerContext } from '../composables/useOperatorShortcuts';
import { createVirtualSubclip } from '../services/virtualSubclipService';
import {
  createTrimDraft,
  setInAt,
  setOutAt,
  nudgeBoundary,
  validateTrim,
  isTrimDirty,
  revertTrim,
  type TrimDraft
} from '../lib/trimController';

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
    fps_num?: number;
    fps_den?: number;
    trim_in_ms?: number;
    trim_out_ms?: number;
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

// ── Timecodes & Frame Rates ───────────────────────────────────────────────────
type SnapMode = 'frame' | 'none' | 'keyframe-preferred' | 'keyframe-only';
const snapMode = ref<SnapMode>('frame');
const tcError = ref('');
const initialInMs = ref(0);
const initialOutMs = ref(0);

const activeRate = computed(() => {
    const fps = item.value?.fps || 25;
    return getFrameRate(undefined, undefined, fps);
});

const isDropFrameAvailable = computed(() => isDropFrameSupported(activeRate.value));

const msToTC = (ms: number): string => {
    if (!Number.isFinite(ms)) return '00:00:00:00';
    return msToTimecode(ms, activeRate.value, isDropFrameAvailable.value);
};

const applyInTC = (e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    const res = parseTimecode(val, activeRate.value, isDropFrameAvailable.value);
    if (res.valid && res.ms !== undefined) {
        tcError.value = '';
        inMs.value = Math.min(res.ms, outMs.value);
        seekTo(inMs.value);
    } else {
        tcError.value = res.error || 'Invalid IN timecode format';
    }
};

const applyOutTC = (e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    const res = parseTimecode(val, activeRate.value, isDropFrameAvailable.value);
    if (res.valid && res.ms !== undefined) {
        tcError.value = '';
        outMs.value = Math.max(res.ms, inMs.value);
    } else {
        tcError.value = res.error || 'Invalid OUT timecode format';
    }
};

const nudgeIn = (deltaFrames: number) => {
    const frameMs = 1000 / (activeRate.value.fpsNum / activeRate.value.fpsDen);
    const target = inMs.value + deltaFrames * frameMs;
    inMs.value = clampMs(snapMsToFrame(target, activeRate.value.fpsNum, activeRate.value.fpsDen));
    if (inMs.value > outMs.value) outMs.value = inMs.value;
};

const nudgeOut = (deltaFrames: number) => {
    const frameMs = 1000 / (activeRate.value.fpsNum / activeRate.value.fpsDen);
    const target = outMs.value + deltaFrames * frameMs;
    outMs.value = clampMs(snapMsToFrame(target, activeRate.value.fpsNum, activeRate.value.fpsDen));
    if (outMs.value < inMs.value) inMs.value = outMs.value;
};

const isDirty = computed(() => inMs.value !== initialInMs.value || outMs.value !== initialOutMs.value);

const revertDraft = () => {
    inMs.value = initialInMs.value;
    outMs.value = initialOutMs.value;
    tcError.value = '';
    trimStatus.value = 'Reverted to initial trim state';
};

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

const trimDraft = computed<TrimDraft>(() =>
  createTrimDraft(
    inMs.value,
    outMs.value,
    totalDurationMs.value,
    item.value?.fps_num,
    item.value?.fps_den,
    item.value?.fps
  )
);

const isTrimDirtyState = computed(() => {
  const baselineIn = item.value?.inPoint !== undefined ? Math.round(item.value.inPoint * 1000) : (item.value?.trim_in_ms ?? 0);
  const baselineOut = item.value?.outPoint !== undefined ? Math.round(item.value.outPoint * 1000) : (item.value?.trim_out_ms ?? (totalDurationMs.value || 0));
  return isTrimDirty(trimDraft.value, { inMs: baselineIn, outMs: baselineOut });
});

const setInPoint = (ms = Math.round(currentVideoMs())) => {
  const updated = setInAt(trimDraft.value, ms);
  inMs.value = updated.inMs;
  if (inMs.value > outMs.value) outMs.value = inMs.value;
  const val = validateTrim(updated);
  trimStatus.value = val.valid ? `IN: ${msToTC(inMs.value)}` : `❌ ${val.errors.join(', ')}`;
};

const setOutPoint = (ms = Math.round(currentVideoMs())) => {
  const updated = setOutAt(trimDraft.value, ms);
  outMs.value = updated.outMs;
  if (outMs.value < inMs.value) inMs.value = outMs.value;
  const val = validateTrim(updated);
  trimStatus.value = val.valid ? `OUT: ${msToTC(outMs.value)}` : `❌ ${val.errors.join(', ')}`;
};

const nudgeMarkerBoundary = (boundary: 'in' | 'out', deltaFrames: number) => {
  const updated = nudgeBoundary(trimDraft.value, boundary, deltaFrames);
  inMs.value = updated.inMs;
  outMs.value = updated.outMs;
  const val = validateTrim(updated);
  trimStatus.value = val.valid
    ? `${boundary.toUpperCase()}: ${msToTC(boundary === 'in' ? inMs.value : outMs.value)}`
    : `❌ ${val.errors.join(', ')}`;
};

const revertTrimToBaseline = () => {
  const baselineIn = item.value?.trim_in_ms ?? 0;
  const baselineOut = item.value?.trim_out_ms ?? (totalDurationMs.value || 0);
  const reverted = revertTrim(trimDraft.value, { inMs: baselineIn, outMs: baselineOut });
  inMs.value = reverted.inMs;
  outMs.value = reverted.outMs;
  trimStatus.value = 'Reverted trim points to baseline.';
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

export type SubclipCapability =
  | { state: 'available'; label: string; reason?: string }
  | { state: 'local-fallback'; label: string; reason: string }
  | { state: 'unavailable'; label: string; reason: string };

const subclipCapability = computed<SubclipCapability>(() => {
  if (!item.value) {
    return { state: 'unavailable', label: '🎬 Save Sub-clip', reason: 'No item selected' };
  }
  if (!item.value.path) {
    return { state: 'unavailable', label: '🎬 Save Sub-clip', reason: 'Missing source path' };
  }
  if (outMs.value > 0 && outMs.value <= inMs.value) {
    return { state: 'unavailable', label: '🎬 Save Sub-clip', reason: 'OUT point must be greater than IN point' };
  }
  if (item.value.uuid && !item.value.uuid.startsWith('local:')) {
    return { state: 'available', label: '🎬 Save Virtual Sub-clip' };
  }
  return {
    state: 'local-fallback',
    label: '🎬 Save Local Sub-clip',
    reason: 'Local asset without server identity. Sub-clip will be stored in playlist only.'
  };
});

const showSubclipModal = ref(false);
const subclipNameInput = ref('');

const openSubclipDialog = () => {
  const currentItem = item.value;
  if (!currentItem) return;
  if (outMs.value > 0 && outMs.value <= inMs.value) {
    trimStatus.value = '❌ OUT point must be greater than IN point.';
    return;
  }
  subclipNameInput.value = `${currentItem.filename} (Sub-clip)`;
  showSubclipModal.value = true;
};

const cancelSubclipDialog = () => {
  showSubclipModal.value = false;
};

const confirmSubclipDialog = async () => {
  const currentItem = item.value;
  if (!currentItem) return;
  const name = subclipNameInput.value.trim();
  if (!name) {
    trimStatus.value = '❌ Display name must not be empty.';
    return;
  }

  showSubclipModal.value = false;
  trimStatus.value = 'Processing sub-clip...';

  const result = await createVirtualSubclip({
    item: currentItem as any,
    displayName: name,
    trimInMs: inMs.value,
    trimOutMs: outMs.value
  });

  if (result.state === 'failed') {
    trimStatus.value = `❌ Sub-clip failed: ${result.error}`;
    return;
  }

  if (result.item) {
    store.addItem(result.item);
    trimStatus.value = result.state === 'persisted' 
      ? '✅ Virtual sub-clip created and persisted successfully!' 
      : '✅ Local virtual sub-clip created (playlist only).';
    emit('saved', { uuid: result.item.playoutvueId, outputPath: result.item.path });
    setTimeout(() => emit('close'), 800);
  }
};

const saveAsSubclip = () => {
  openSubclipDialog();
};
</script>

<template>
  <div v-if="isOpen && item" ref="panelRef" class="modal-backdrop" tabindex="0" style="outline: none;" @click.self="$emit('close')" @keydown.capture="handleKey">
    <div class="glass-panel trim-panel" data-command-scope="trimmer">

      <!-- Header -->
      <div class="trim-header">
        <div class="header-left">
          <div class="clip-title-row">
            <span class="trim-badge">TRIMMER</span>
            <span class="clip-name">{{ item.filename }}</span>
          </div>
          <div class="clip-meta-row">
            <span v-if="viewTrimmed" class="meta-chip meta-chip-active">
              Content: {{ (displayTotalMs/1000).toFixed(1) }}s
            </span>
            <span v-else class="meta-chip">
              Duration: {{ isProbing ? '...' : (displayTotalMs ? (displayTotalMs/1000).toFixed(2)+'s' : '--') }}
            </span>
            <span v-if="viewTrimmed && fullFileDurationMs" class="meta-chip meta-chip-muted">
              Source: {{ (fullFileDurationMs/1000).toFixed(1) }}s
            </span>
            <span class="meta-chip meta-chip-duration">
              Selection: <strong>{{ trimmedDuration }}</strong>
            </span>
          </div>
        </div>

        <div class="header-right">
          <div class="shortcut-hint">
            <span class="key-cap">J</span><span class="key-cap">K</span><span class="key-cap">L</span> shuttle
            <span class="key-sep">•</span>
            <span class="key-cap">I</span> In <span class="key-cap">O</span> Out
            <span class="key-sep">•</span>
            <span class="key-cap">←</span><span class="key-cap">→</span> 1f
            <span class="key-sep">•</span>
            <span class="key-cap">⇧←</span><span class="key-cap">⇧→</span> 10f
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
          <button class="close-btn" @click="$emit('close')" title="Close Trimmer">✕</button>
        </div>
      </div>

      <!-- Two-column: Video + Player Dock | Controls -->
      <div class="trim-body">

        <!-- Left: Video preview & Transport Dock -->
        <div class="player-col">
          <div class="video-container">
            <video v-if="videoSrc" ref="videoRef" :src="videoSrc" class="trim-video"
              muted preload="metadata" @loadedmetadata="onVideoLoaded" @error="onVideoError" @timeupdate="onTimeUpdate" @play="syncPlaybackState" @pause="syncPlaybackState"></video>
            <div v-else-if="item.type === 'live' || item.path?.startsWith('http')" class="video-placeholder">
              <div class="placeholder-icon">{{ item.type === 'live' ? '📹' : '🌐' }}</div>
              <small class="text-secondary">No local preview</small>
            </div>
            <div v-else-if="isGeneratingProxy" class="video-placeholder">
              <div class="placeholder-icon">🎞️</div>
              <small class="text-secondary">Generating proxy preview…</small>
            </div>
            <div v-else-if="previewError" class="video-placeholder">
              <div class="placeholder-icon">⚠</div>
              <small class="text-secondary">{{ previewError }}</small>
            </div>
            <div v-else class="video-placeholder">
              <div class="placeholder-icon">⌛</div>
              <small class="text-secondary">Loading preview…</small>
            </div>
            <div v-if="speed !== 0" class="speed-badge">{{ speed < 0 ? '◀◀' : '▶▶' }} {{ Math.abs(speed) === 2 ? '×4' : '×1' }}</div>
          </div>

          <!-- Transport Dock (Cleanly below video, never covering frames) -->
          <div class="transport-dock">
            <button class="t-btn t-btn-nav" @click="jumpToMarker('start')" title="Start [Home]">⏮</button>
            <button class="t-btn t-btn-step" @click="nudge(-10)" title="Back 10 frames [Shift+Left]">-10f</button>
            <button class="t-btn t-btn-step" @click="nudge(-1)" title="Back 1 frame [Left]">-1f</button>
            <button class="t-btn t-btn-play" :class="{ 'is-playing': isVideoPlaying }" @click="togglePlayback" title="Play / Pause [Space / K]">
              <span class="play-icon">{{ isVideoPlaying ? '⏸' : '▶' }}</span>
              <span class="play-text">{{ isVideoPlaying ? 'PAUSE' : 'PLAY' }}</span>
            </button>
            <button class="t-btn t-btn-step" @click="nudge(1)" title="Forward 1 frame [Right]">+1f</button>
            <button class="t-btn t-btn-step" @click="nudge(10)" title="Forward 10 frames [Shift+Right]">+10f</button>
            <button class="t-btn t-btn-nav" @click="jumpToMarker('end')" title="End [End]">⏭</button>
          </div>
        </div>

        <!-- Right: Controls, Timeline & Timecodes -->
        <div class="ctrl-col">

          <!-- Hero Metrics Bar -->
          <div class="trim-metrics">
            <div class="metric-card metric-card-playhead">
              <div class="metric-header">
                <span class="metric-dot dot-cyan"></span>
                <span class="metric-label">PLAYHEAD POSITION</span>
              </div>
              <strong class="metric-tc tc-cyan">{{ currentTimecode }}</strong>
            </div>
            <div class="metric-card metric-card-duration">
              <div class="metric-header">
                <span class="metric-dot dot-emerald"></span>
                <span class="metric-label">SELECTION DURATION</span>
              </div>
              <strong class="metric-tc tc-emerald">{{ trimmedDuration }}</strong>
            </div>
          </div>

          <!-- Scrub Bar & Timeline -->
          <div class="scrub-area">
            <div class="timeline-container" ref="timelineRef" @mousedown.left="onTimelineMouseDown($event, 'playhead')">
              <div class="tm-track-bg">
                <div class="tm-ticks"></div>
              </div>
              <div class="tm-range" :style="{
                left:  rangeLeftPct+'%',
                width: rangeWidthPct+'%'
              }"></div>
              
              <!-- IN Handle (Emerald) -->
              <div class="tm-handle-wrapper" :style="{ left: inHandlePct+'%' }">
                 <div class="tm-handle tm-handle-in" @mousedown.prevent.stop.left="onTimelineMouseDown($event, 'in')" title="Drag IN point [I]">
                   <span class="handle-bracket">[</span>
                 </div>
              </div>
              
              <!-- OUT Handle (Rose) -->
              <div class="tm-handle-wrapper" :style="{ left: outHandlePct+'%' }">
                 <div class="tm-handle tm-handle-out" @mousedown.prevent.stop.left="onTimelineMouseDown($event, 'out')" title="Drag OUT point [O]">
                   <span class="handle-bracket">]</span>
                 </div>
              </div>

              <!-- Playhead -->
              <div ref="playheadRef" class="tm-playhead" @mousedown.prevent.stop.left="onTimelineMouseDown($event, 'playhead')">
                <div class="tm-playhead-cap"></div>
                <div class="tm-playhead-line"></div>
              </div>
            </div>
            
            <div class="timeline-footer">
              <span class="tc-footer-label">{{ scrubLabelStart }}</span>
              <span class="tc-footer-label">{{ scrubLabelEnd }}</span>
            </div>
          </div>

          <!-- IN / OUT Cards -->
          <div class="tc-grid">
            <!-- IN Point Card -->
            <div class="tc-card tc-card-in">
              <div class="tc-card-header">
                <span class="tc-tag tag-in">[ IN POINT</span>
              </div>
              <input class="tc-input tc-input-in" :value="displayInTC" @change="applyInTC" placeholder="00:00:00:00" spellcheck="false">
              <div class="tc-actions">
                <button class="mini-btn" @click="jumpToMarker('in')" title="Jump to IN point">Cue</button>
                <button class="mini-btn mini-btn-set" @click="setInPoint()" title="Set IN from current playhead [I]">Set [I]</button>
              </div>
            </div>

            <!-- OUT Point Card -->
            <div class="tc-card tc-card-out">
              <div class="tc-card-header">
                <span class="tc-tag tag-out">OUT POINT ]</span>
              </div>
              <input class="tc-input tc-input-out" :value="displayOutTC" @change="applyOutTC" placeholder="00:00:00:00" spellcheck="false">
              <div class="tc-actions">
                <button class="mini-btn" @click="jumpToMarker('out')" title="Jump to OUT point">Cue</button>
                <button class="mini-btn mini-btn-set" @click="setOutPoint()" title="Set OUT from current playhead [O]">Set [O]</button>
              </div>
            </div>
          </div>

          <!-- Actions Bar -->
          <div class="trim-actions">
            <button class="action-btn btn-save" @click="saveNonDestructive">
              <span class="btn-icon">💾</span> Save Trim Points
            </button>
            <button
              class="action-btn btn-subclip"
              :disabled="subclipCapability.state === 'unavailable'"
              :title="subclipCapability.reason"
              @click="saveAsSubclip"
            >
              <span class="btn-icon">✂️</span> {{ subclipCapability.label }}
            </button>
            <button class="action-btn btn-cancel" @click="$emit('close')">Cancel</button>
          </div>
          <div v-if="trimStatus" class="trim-status">{{ trimStatus }}</div>
        </div>
      </div>
    </div>

    <!-- Custom Subclip Name Modal -->
    <div v-if="showSubclipModal" class="subclip-modal-backdrop" @click.self="cancelSubclipDialog">
      <div class="subclip-modal-dialog" role="dialog" aria-modal="true" aria-label="Name Sub-clip">
        <div class="modal-header-row">
          <span class="modal-badge">SUB-CLIP</span>
          <h4 class="modal-title">Create Virtual Sub-clip</h4>
        </div>
        <p class="modal-desc">Enter a display name for the new sub-clip:</p>
        <input
          v-model="subclipNameInput"
          type="text"
          class="subclip-name-input"
          placeholder="Sub-clip name"
          @keydown.enter="confirmSubclipDialog"
          @keydown.esc="cancelSubclipDialog"
        />
        <div class="subclip-modal-actions">
          <button class="action-btn btn-save" @click="confirmSubclipDialog">Create Sub-clip</button>
          <button class="action-btn btn-cancel" @click="cancelSubclipDialog">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(10, 14, 23, 0.88);
  backdrop-filter: blur(12px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10000;
}

.trim-panel {
  width: 1080px;
  max-width: 96vw;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  background: linear-gradient(180deg, #161b26 0%, #0f131a 100%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.8), 0 0 1px rgba(255, 255, 255, 0.2);
}

/* Header */
.trim-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  padding-bottom: 0.85rem;
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.clip-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.trim-badge {
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.clip-name {
  font-size: 0.95rem;
  font-weight: 600;
  color: #f1f5f9;
  letter-spacing: -0.01em;
}

.clip-meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.meta-chip {
  font-size: 0.72rem;
  color: #94a3b8;
  background: rgba(255, 255, 255, 0.04);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.meta-chip-active {
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.1);
  border-color: rgba(56, 189, 248, 0.25);
}

.meta-chip-duration strong {
  color: #10b981;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.shortcut-hint {
  font-size: 0.68rem;
  color: rgba(255, 255, 255, 0.4);
  display: flex;
  align-items: center;
  gap: 4px;
}

.key-cap {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 3px;
  padding: 1px 5px;
  color: #cbd5e1;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 0.65rem;
}

.key-sep {
  color: rgba(255, 255, 255, 0.2);
  margin: 0 2px;
}

.view-toggle-btn {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #cbd5e1;
  font-size: 0.7rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.view-toggle-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.25);
}

.view-toggle-btn.active {
  background: rgba(56, 189, 248, 0.16);
  border-color: rgba(56, 189, 248, 0.4);
  color: #38bdf8;
}

.close-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  font-size: 1rem;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.15s;
}

.close-btn:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

/* Layout Body */
.trim-body {
  display: grid;
  grid-template-columns: 1.15fr 0.95fr;
  gap: 1.25rem;
}

/* Left: Player Dock */
.player-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.video-container {
  aspect-ratio: 16/9;
  max-height: 40vh;
  width: 100%;
  background: #000;
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.8);
}

.trim-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.video-placeholder {
  text-align: center;
  padding: 2rem;
  color: rgba(255, 255, 255, 0.35);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.placeholder-icon {
  font-size: 2rem;
}

.speed-badge {
  position: absolute;
  top: 10px;
  right: 12px;
  background: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(4px);
  color: #f43f5e;
  font-size: 0.75rem;
  font-weight: 800;
  padding: 3px 8px;
  border-radius: 4px;
  letter-spacing: 0.05em;
  border: 1px solid rgba(244, 63, 94, 0.3);
}

/* Transport Bar */
.transport-dock {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.35);
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.t-btn {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: #f1f5f9;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}

.t-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.2);
}

.t-btn-step {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 0.72rem;
  padding: 6px 10px;
}

.t-btn-play {
  background: rgba(56, 189, 248, 0.15);
  border-color: rgba(56, 189, 248, 0.4);
  color: #38bdf8;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
}

.t-btn-play:hover {
  background: rgba(56, 189, 248, 0.25);
  border-color: rgba(56, 189, 248, 0.6);
}

.t-btn-play.is-playing {
  background: rgba(244, 63, 94, 0.15);
  border-color: rgba(244, 63, 94, 0.4);
  color: #f43f5e;
}

.play-icon {
  font-size: 0.85rem;
}

.play-text {
  font-size: 0.75rem;
  letter-spacing: 0.05em;
}

/* Right Column: Controls */
.ctrl-col {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

/* Hero Metrics */
.trim-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.metric-card {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.metric-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.metric-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.dot-cyan { background: #38bdf8; box-shadow: 0 0 6px rgba(56, 189, 248, 0.6); }
.dot-emerald { background: #10b981; box-shadow: 0 0 6px rgba(16, 185, 129, 0.6); }

.metric-label {
  font-size: 0.65rem;
  font-weight: 700;
  color: #94a3b8;
  letter-spacing: 0.06em;
}

.metric-tc {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 1.1rem;
  font-weight: 800;
  letter-spacing: 1px;
}

.tc-cyan { color: #38bdf8; }
.tc-emerald { color: #10b981; }

/* Timeline Scrub Area */
.scrub-area {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 0.85rem 1rem 0.65rem 1rem;
}

.timeline-container {
  position: relative;
  height: 38px;
  background: #0b0f17;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  cursor: pointer;
  margin: 4px 0 8px 0;
  user-select: none;
}

.tm-track-bg {
  position: absolute;
  inset: 0;
  border-radius: 6px;
  overflow: hidden;
}

.tm-ticks {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    90deg,
    transparent,
    transparent 19px,
    rgba(255, 255, 255, 0.04) 20px
  );
}

.tm-range {
  position: absolute;
  top: 0;
  bottom: 0;
  background: linear-gradient(90deg, rgba(16, 185, 129, 0.25) 0%, rgba(56, 189, 248, 0.25) 50%, rgba(244, 63, 94, 0.25) 100%);
  border-top: 2px solid rgba(56, 189, 248, 0.6);
  border-bottom: 2px solid rgba(56, 189, 248, 0.6);
  pointer-events: none;
}

.tm-handle-wrapper {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  z-index: 10;
}

.tm-handle {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 18px;
  border-radius: 4px;
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 900;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.6);
  transform: translateX(-50%);
  transition: transform 0.1s;
}

.tm-handle:hover {
  transform: translateX(-50%) scaleY(1.08);
}

.tm-handle-in {
  background: #10b981;
  color: #064e3b;
  border: 1px solid #34d399;
}

.tm-handle-out {
  background: #f43f5e;
  color: #881337;
  border: 1px solid #fb7185;
}

.handle-bracket {
  font-family: monospace;
  font-size: 13px;
  line-height: 1;
}

/* Playhead */
.tm-playhead {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 14px;
  cursor: ew-resize;
  z-index: 20;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
}

.tm-playhead-cap {
  width: 10px;
  height: 10px;
  background: #ffffff;
  transform: rotate(45deg);
  border-radius: 2px;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.8);
  margin-top: 2px;
}

.tm-playhead-line {
  width: 2px;
  flex: 1;
  background: #ffffff;
  box-shadow: 0 0 4px rgba(255, 255, 255, 0.8);
  pointer-events: none;
}

.timeline-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.tc-footer-label {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.4);
}

/* IN / OUT Cards */
.tc-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.tc-card {
  background: rgba(0, 0, 0, 0.35);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.tc-card-in {
  border-left: 3px solid #10b981;
}

.tc-card-out {
  border-left: 3px solid #f43f5e;
}

.tc-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.tc-tag {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.05em;
}

.tag-in { color: #10b981; }
.tag-out { color: #f43f5e; }

.tc-input {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 2px;
  text-align: center;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.12);
  padding: 6px;
  border-radius: 6px;
  width: 100%;
  box-sizing: border-box;
  transition: all 0.15s;
}

.tc-input-in {
  color: #10b981;
}

.tc-input-in:focus {
  outline: none;
  border-color: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.3);
}

.tc-input-out {
  color: #f43f5e;
}

.tc-input-out:focus {
  outline: none;
  border-color: #f43f5e;
  box-shadow: 0 0 8px rgba(244, 63, 94, 0.3);
}

.tc-actions {
  display: flex;
  gap: 6px;
}

.mini-btn {
  flex: 1;
  padding: 5px 8px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: #cbd5e1;
  cursor: pointer;
  font-size: 0.7rem;
  font-weight: 600;
  transition: all 0.15s;
}

.mini-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}

.mini-btn-set {
  background: rgba(56, 189, 248, 0.1);
  border-color: rgba(56, 189, 248, 0.3);
  color: #38bdf8;
}

.mini-btn-set:hover {
  background: rgba(56, 189, 248, 0.2);
}

/* Actions Footer */
.trim-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.action-btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #f1f5f9;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.btn-save {
  background: rgba(16, 185, 129, 0.15);
  border-color: rgba(16, 185, 129, 0.4);
  color: #10b981;
  flex: 1.2;
}

.btn-save:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.25);
  border-color: rgba(16, 185, 129, 0.6);
}

.btn-subclip {
  background: rgba(56, 189, 248, 0.15);
  border-color: rgba(56, 189, 248, 0.4);
  color: #38bdf8;
  flex: 1.4;
}

.btn-subclip:hover:not(:disabled) {
  background: rgba(56, 189, 248, 0.25);
  border-color: rgba(56, 189, 248, 0.6);
}

.btn-cancel {
  background: rgba(255, 255, 255, 0.05);
  color: #94a3b8;
  flex: 0.8;
}

.trim-status {
  font-size: 0.75rem;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
}

/* Subclip Dialog */
.subclip-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10001;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  display: flex;
  justify-content: center;
  align-items: center;
}

.subclip-modal-dialog {
  width: 440px;
  max-width: 90vw;
  background: #151b26;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.85);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modal-badge {
  font-size: 0.65rem;
  font-weight: 800;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.modal-title {
  margin: 0;
  font-size: 1rem;
  color: #f1f5f9;
  font-weight: 700;
}

.modal-desc {
  color: #94a3b8;
  font-size: 0.8rem;
  margin: 0;
}

.subclip-name-input {
  width: 100%;
  padding: 8px 12px;
  background: #0b0f17;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #f1f5f9;
  font-size: 0.9rem;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}

.subclip-name-input:focus {
  border-color: #38bdf8;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
}

.subclip-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

@media (max-width: 900px) {
  .trim-body,
  .trim-metrics,
  .tc-grid {
    grid-template-columns: 1fr;
  }
}
</style>
