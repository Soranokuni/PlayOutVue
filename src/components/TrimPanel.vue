<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRundownStore } from '../stores/rundown';
import type { ContentType } from '../lib/contentTypes';
import { invoke } from '@tauri-apps/api/core';
import { msToTimecode, parseTimecode, snapMsToFrame, getFrameRate, isDropFrameSupported } from '../lib/timecode';
import { activeTrimmerContext } from '../composables/useOperatorShortcuts';
import { createVirtualSubclip } from '../services/virtualSubclipService';
import { describeErrorMessage } from '../lib/describeError';
import { saveAssetTrim, hasServerIdentity } from '../lib/trimSave';
import AppIcon from './ui/AppIcon.vue';
import TrimWaveform from './TrimWaveform.vue';
import TrimAudioMeter from './TrimAudioMeter.vue';
import { useTrimAudio } from '../composables/useTrimAudio';
import { useSettingsStore } from '../stores/settings';
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
    /** The root asset a virtual sub-clip is cut from. */
    parentAssetUuid?: string;
    virtualSubclip?: boolean;
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
    mezzanine_ok?: boolean;
    total_frames?: number;
    gop_frames?: number;
    keyframe_safe_start_ms?: number;
    complianceRating?: string;
    tp_flag?: boolean;
    content_type?: ContentType;
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

/**
 * Snapshot the item being trimmed.
 *
 * The server identity used to be
 * `props.libraryItem?.uuid || store.selectedItem?.playoutvueId || source.id`,
 * which had two faults:
 *
 *  - when the panel was opened on a *library* row that carried no uuid, it
 *    silently borrowed the uuid of whatever happened to be selected in the
 *    *rundown* -- a different asset;
 *  - failing that it fell back to `source.id`, which for a rundown row is a
 *    client-side `uuidv4()` that is not a server asset id at all. It does not
 *    start with `local:`, so every downstream check ("do we have a server
 *    identity?") said yes, and "Save virtual sub-clip" posted to
 *    `/api/assets/<a-random-uuid>/subclip`.
 *
 * The identity now comes from the same object as the rest of the snapshot, and
 * a row with no server identity is honestly marked `local:` so the sub-clip
 * path takes the local branch instead of guessing.
 */
const lockTrimItem = () => {
  const source = props.libraryItem || store.selectedItem;
  if (!source) {
    activeItem.value = null;
    return;
  }

  const anySource = source as any;
  const serverUuid = anySource.uuid || anySource.playoutvueId || '';
  const hasServerIdentity =
    !!serverUuid && !serverUuid.startsWith('local:') && !serverUuid.startsWith('local-subclip:');

  activeItem.value = {
    id: source.id,
    uuid: hasServerIdentity ? serverUuid : `local:${source.path || source.id}`,
    // A sub-clip of a sub-clip is still a cut of the original asset: chain to
    // the root so the transcoder is asked to trim the file that actually
    // exists, not a virtual row.
    parentAssetUuid: anySource.parentAssetUuid || (hasServerIdentity ? serverUuid : undefined),
    virtualSubclip: anySource.virtualSubclip,
    path: source.path,
    filename: source.filename,
    type: source.type,
    duration: source.duration,
    duration_ms: anySource.duration_ms,
    inPoint: source.inPoint,
    outPoint: source.outPoint,
    trim_in_ms: anySource.trim_in_ms,
    trim_out_ms: anySource.trim_out_ms,
    fps: anySource.fps || 25,
    fps_num: anySource.fps_num,
    fps_den: anySource.fps_den,
    mezzanine_ok: anySource.mezzanine_ok,
    total_frames: anySource.total_frames,
    gop_frames: anySource.gop_frames,
    keyframe_safe_start_ms: anySource.keyframe_safe_start_ms,
    complianceRating: anySource.complianceRating,
    tp_flag: anySource.tp_flag,
    content_type: anySource.content_type,
  };
};

// ── Video preview via local streaming server ──────────────────────────────────
// We get a stream URL from our Rust media_server (zero memory overhead)
const videoRef = ref<HTMLVideoElement | null>(null);
const videoSrc = ref('');
const isVideoPlaying = ref(false);
const previewError = ref('');
/** True when the file itself is gone, as opposed to merely undecodable here. */
const previewSourceMissing = ref(false);

// Local audio monitoring: volume/mute, audition while stepping, and the peak
// envelope behind the waveform and the meter. See `useTrimAudio`.
const settings = useSettingsStore();
const trimAudio = useTrimAudio({ videoRef, srcRef: videoSrc });
const { peaks: audioPeaks, peaksState: audioPeaksState, peaksError: audioPeaksError } = trimAudio;
const audioVolume = computed(() => Number(settings.trimmerAudioVolume) || 0);
const audioSilent = computed(() => !!settings.trimmerAudioMuted || audioVolume.value === 0);
const onVolumeInput = (e: Event) => trimAudio.setVolume(Number((e.target as HTMLInputElement).value));
/** Give the keyboard back to the transport once the slider is let go. */
const releaseSliderFocus = () => nextTick(() => panelRef.value?.focus());

/**
 * Audit F-6 / F-7 — the trimmer's "proxy".
 *
 * There has never been a proxy. `get_media_preview_url` was identical to
 * `get_media_url`: both return the same streaming URL for the same original
 * file. The panel nonetheless carried a whole fallback machine around it --
 * a `previewMode`, an `isGeneratingProxy` spinner reading "Generating proxy
 * preview…", a `proxyAttemptedPath` and an unconditional 2.5 s timer that
 * flipped into "proxy" mode whenever `<video>` had not reported metadata yet.
 *
 * The result was that any preview failure -- above all a file that is simply
 * not on disk any more, which is what the stale-rundown bug (F-0) produced by
 * the dozen -- was reported to the operator as a proxy problem. They were told
 * the app was generating something, then that the proxy had failed, when the
 * truth was "this path does not exist".
 *
 * The machinery is gone. The preview now states which of the two things is
 * actually wrong: the file is missing, or the embedded player cannot decode
 * this codec (and in that case says plainly that trimming still works, because
 * the IN/OUT math runs through ffprobe on the Rust side, not through
 * `<video>`).
 */
const loadVideoSrc = async (path: string | undefined) => {
    videoSrc.value = '';
    previewError.value = '';
    previewSourceMissing.value = false;
    if (!path || item.value?.type === 'live' || path.startsWith('http')) return;

    // Name the right object: a missing file is a missing file, and the
    // operator gets told so before the player has a chance to blame itself.
    try {
        const existence = await invoke<Record<string, boolean>>('verify_paths_exist', { paths: [path] });
        if (existence[path] === false) {
            previewSourceMissing.value = true;
            previewError.value = `File not found on disk: ${path}`;
            return;
        }
    } catch (error) {
        console.warn('[TrimPanel] existence check unavailable', error);
    }

    try {
        videoSrc.value = await invoke<string>('get_media_url', { path });
    } catch (e) {
        console.warn('[TrimPanel] failed to get streaming URL:', e);
        previewError.value = describeErrorMessage(e, 'Could not open a preview stream for this file.');
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
/**
 * §8: the status line used to prefix itself with a cross or a tick. A glyph
 * inside a sentence is unthemeable, is not announced as a state by a screen
 * reader, and does not translate. The state is a sibling ref instead, and the
 * line renders it as colour plus an icon in its own slot.
 */
const trimStatusTone = ref<'info' | 'error' | 'success'>('info');

const setTrimStatus = (text: string, tone: 'info' | 'error' | 'success' = 'info') => {
  trimStatus.value = text;
  trimStatusTone.value = tone;
};
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

/**
 * C-5: the registry's file duration bounds a server asset's OUT. `<video>` and
 * `scan_media` can report a longer end, which the transcoder rejects.
 */
const registryDurationMs = computed(() => {
  const ms = item.value?.duration_ms;
  return hasServerIdentity(item.value?.uuid) && ms && ms > 0 ? ms : 0;
});
const outBoundMs = (ms: number) => (registryDurationMs.value > 0 ? Math.min(ms, registryDurationMs.value) : ms);
const clampMs = (ms: number) => Math.max(0, Math.min(ms, outBoundMs(totalDurationMs.value || ms)));
const isLocalFilePath = (path?: string) => !!path && !/^https?:/i.test(path);

// ── Seek video ────────────────────────────────────────────────────────────────
const timelineRef = ref<HTMLElement | null>(null);
const playheadRef = ref<HTMLElement | null>(null);
const playbackTime = ref(0);
const draggingTimelineItem = ref<'in' | 'out' | 'playhead' | null>(null);

let pendingSeekMs: number | null = null;
/** The pending seek was asked for by the operator, so they should hear it. */
let pendingAudition = false;
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
  const audition = pendingAudition;
  pendingSeekMs = null;
  pendingAudition = false;
  v.currentTime = clamped / 1000;
  syncPlaybackDisplay(clamped, true);
  if (audition && v.paused) trimAudio.audition(clamped);
};

const queueSeek = (ms: number, forceReactive = false, audition = false) => {
  const clamped = clampMs(ms);
  syncPlaybackDisplay(clamped, forceReactive);
  pendingSeekMs = clamped;
  pendingAudition = pendingAudition || audition;
  if (!seekAnimationFrame) {
    seekAnimationFrame = requestAnimationFrame(flushPendingSeek);
  }
};

const seekTo = (ms: number, forceReactive = true, audition = false) => {
  queueSeek(ms, forceReactive, audition);
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

// ── Playback loop ────────────────────────────────────────────────────────────
// With sound on, where playback stops is something the operator *hears*.
// `timeupdate` fires about four times a second, so stopping at OUT from it
// overran by up to 250 ms of audio past the cut -- sound that will not be on
// air. The loop checks every animation frame instead, and also moves the
// playhead smoothly rather than in quarter-second jumps.
let playLoopFrame = 0;
/** Where the current playback must stop, or null to play on. */
let stopAtMs: number | null = null;
/**
 * `playRange` chose `stopAtMs` itself. Media events are queued, so the `pause`
 * and `play` events from its own pause/play pair arrive after it returns; the
 * flag stops them overwriting its stop point.
 */
let rangeArmed = false;

const playLoop = () => {
  playLoopFrame = 0;
  const v = videoRef.value;
  if (!v || v.paused || v.ended) return;
  const ms = v.currentTime * 1000;
  if (stopAtMs != null && ms >= stopAtMs) {
    const at = stopAtMs;
    stopAtMs = null;
    v.pause();
    v.currentTime = at / 1000;
    speed.value = 0;
    syncPlaybackDisplay(at, true);
    syncPlaybackState();
    return;
  }
  syncPlaybackDisplay(ms);
  playLoopFrame = requestAnimationFrame(playLoop);
};

const onVideoPlay = () => {
  trimAudio.stopAudition();
  const v = videoRef.value;
  // Playback that starts before OUT stops at OUT. Starting past OUT plays on,
  // so the operator can listen to what the cut throws away.
  if (rangeArmed) {
    rangeArmed = false;
  } else {
    stopAtMs = v && outMs.value > inMs.value && v.currentTime * 1000 < outMs.value - FRAME_MS.value / 2
      ? outMs.value
      : null;
  }
  syncPlaybackState();
  if (!playLoopFrame) playLoopFrame = requestAnimationFrame(playLoop);
};

const onVideoPause = () => {
  syncPlaybackState();
};

/** Play `[fromMs, toMs)` and stop exactly at `toMs`. */
const playRange = async (fromMs: number, toMs: number) => {
  const v = videoRef.value;
  if (!v || toMs <= fromMs) return;
  if (pendingSeekMs != null) flushPendingSeek();
  if (!v.paused) v.pause();
  const from = clampMs(fromMs);
  v.currentTime = from / 1000;
  syncPlaybackDisplay(from, true);
  stopAtMs = clampMs(toMs);
  rangeArmed = true;
  speed.value = 1;
  v.playbackRate = 1;
  await v.play().catch(() => { rangeArmed = false; });
  syncPlaybackState();
};

/** Hear the cut as it will air: from IN to OUT. */
const playSelection = () => playRange(inMs.value, outMs.value > inMs.value ? outMs.value : totalDurationMs.value);
/** Hear the lead-up to the OUT point, stopping on it. */
const OUT_PREROLL_MS = 3000;
const playToOut = () => playRange(Math.max(inMs.value, outMs.value - OUT_PREROLL_MS), outMs.value);

// ── Timeline Scrubbing state ──────────────────────────────────────────────────
const onTimeUpdate = () => {
  const v = videoRef.value;
  if (!v) return;
  // While playing, the loop owns the display and the OUT stop.
  if (v.paused) syncPlaybackDisplay(v.currentTime * 1000);
  syncPlaybackState();
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
    queueSeek(inMs.value, false, true);
    } else if (draggingTimelineItem.value === 'out') {
        outMs.value = Math.max(ms, inMs.value);
    queueSeek(outMs.value, false, true);
    } else if (draggingTimelineItem.value === 'playhead') {
    queueSeek(ms, false, true);
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
    const v = videoRef.value;
    if (!v || isNaN(v.duration)) return;
    if (!Number.isFinite(v.duration) || v.videoWidth <= 0) {
      previewError.value = undecodableMessage();
      videoSrc.value = '';
      return;
    }
    const dur = v.duration * 1000;
    if (dur > 0) {
        fullFileDurationMs.value = dur;
        totalDurationMs.value = dur;
        inMs.value = Math.max(0, Math.min(inMs.value, dur));
        if (outMs.value === 0 || outMs.value > outBoundMs(dur)) outMs.value = outBoundMs(dur);
      // Seek the preview to the IN point so the visible frame matches the
      // IN timecode (no auto viewTrimmed flip — trimmed view is opt-in).
      seekTo(inMs.value || 0, true);
    }
};

const undecodableMessage = () => {
  const ext = (item.value?.path || '').split('.').pop()?.toUpperCase() || 'this format';
  return `The embedded player cannot decode ${ext}. Trimming still works: the IN/OUT timecodes, the frame math and the sub-clip are computed by ffprobe, not by this preview.`;
};

const onVideoError = () => {
  // Audit F-6: no proxy fallback. Either the file is gone (already reported by
  // `loadVideoSrc`) or WebView2 cannot decode it. Say which.
  if (previewSourceMissing.value) return;
  previewError.value = undecodableMessage();
  videoSrc.value = '';
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
            if (outMs.value === 0 || outMs.value > outBoundMs(dur)) outMs.value = outBoundMs(dur);
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
  setTrimStatus('');
  speed.value = 0;
  isVideoPlaying.value = false;
  pendingSeekMs = null;
  nextTick(() => {
    syncPlaybackDisplay(inMs.value, true);
    panelRef.value?.focus();
  });
  loadVideoSrc(val.path);
  probeDuration();
  trimAudio.loadPeaks(isLocalFilePath(val.path) && val.type !== 'live' ? val.path : undefined);
    }
    if (!open) {
        if (videoRef.value) videoRef.value.pause();
        trimAudio.release();
        stopAtMs = null;
        rangeArmed = false;
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
    setTrimStatus('Reverted to initial trim state');
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
  val.valid ? setTrimStatus(`IN: ${msToTC(inMs.value)}`) : setTrimStatus(val.errors.join(', '), 'error');
};

const setOutPoint = (ms = Math.round(currentVideoMs())) => {
  const updated = setOutAt(trimDraft.value, ms);
  outMs.value = updated.outMs;
  if (outMs.value < inMs.value) inMs.value = outMs.value;
  const val = validateTrim(updated);
  val.valid ? setTrimStatus(`OUT: ${msToTC(outMs.value)}`) : setTrimStatus(val.errors.join(', '), 'error');
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
  setTrimStatus('Reverted trim points to baseline.');
};

const jumpToMarker = (marker: 'start' | 'in' | 'out' | 'end') => {
  if (marker === 'start') return seekTo(0, true, true);
  if (marker === 'in') return seekTo(inMs.value, true, true);
  if (marker === 'out') return seekTo(outMs.value, true, true);
  seekTo(totalDurationMs.value);
};


// ── Keyboard shortcuts ────────────────────────────────────────────────────────
const currentVideoMs = () => lastKnownPlaybackMs || ((videoRef.value?.currentTime ?? 0) * 1000);
const nudge = (frames: number) => {
  seekTo(currentVideoMs() + frames * FRAME_MS.value, true, true);
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
    case 'm': e.preventDefault(); trimAudio.toggleMute(); break;
    case 'p': e.preventDefault(); if (e.shiftKey) playToOut(); else playSelection(); break;
    }
};
onMounted(()  => {
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
});
onUnmounted(() => {
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
  if (seekAnimationFrame) cancelAnimationFrame(seekAnimationFrame);
  if (playLoopFrame) cancelAnimationFrame(playLoopFrame);
  trimAudio.dispose();
});

// ── Save / Trim ───────────────────────────────────────────────────────────────
const saveNonDestructive = () => {
    if (!item.value) return;
    if (outMs.value > 0 && outMs.value <= inMs.value) {
      setTrimStatus('OUT point must be greater than IN point.', 'error');
      return;
    }

    const saveTask = async () => {
      if (!item.value) return;
      // C-5: the transcoder first, the rundown only once it accepted.
      const saved = await saveAssetTrim(item.value, inMs.value, outMs.value, {
        invoke: (cmd, args) => invoke(cmd, args),
        applyToRundown: (identifier, savedIn, savedOut) => store.updateAssetTrim(identifier, savedIn, savedOut),
      });
      outMs.value = saved.outMs;

      setTrimStatus(saved.clamped ? 'Trim saved. OUT set to the end of the file.' : 'Trim saved.', 'success');

      if (item.value?.path) {
        emit('saved', { uuid: item.value.uuid, outputPath: item.value.path });
      }
      setTimeout(() => emit('close'), 600);
    };

    saveTask().catch((error) => {
      setTrimStatus(describeErrorMessage(error, 'The trim could not be applied.'), 'error');
    });
};

export type SubclipCapability =
  | { state: 'available'; label: string; reason?: string }
  | { state: 'local-fallback'; label: string; reason: string }
  | { state: 'unavailable'; label: string; reason: string };

const subclipCapability = computed<SubclipCapability>(() => {
  if (!item.value) {
    return { state: 'unavailable', label: 'Save sub-clip', reason: 'No item selected' };
  }
  if (!item.value.path) {
    return { state: 'unavailable', label: 'Save sub-clip', reason: 'Missing source path' };
  }
  if (outMs.value > 0 && outMs.value <= inMs.value) {
    return { state: 'unavailable', label: 'Save sub-clip', reason: 'OUT point must be greater than IN point' };
  }
  if (item.value.uuid && !item.value.uuid.startsWith('local:')) {
    return { state: 'available', label: 'Save virtual sub-clip' };
  }
  return {
    state: 'local-fallback',
    label: 'Save local sub-clip',
    reason: 'Local asset without server identity. Sub-clip will be stored in playlist only.'
  };
});

const showSubclipModal = ref(false);
const subclipNameInput = ref('');

const openSubclipDialog = () => {
  const currentItem = item.value;
  if (!currentItem) return;
  if (outMs.value > 0 && outMs.value <= inMs.value) {
    setTrimStatus('OUT point must be greater than IN point.', 'error');
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
    setTrimStatus('Display name must not be empty.', 'error');
    return;
  }

  showSubclipModal.value = false;
  setTrimStatus('Processing sub-clip…');

  const result = await createVirtualSubclip({
    item: currentItem as any,
    displayName: name,
    trimInMs: inMs.value,
    trimOutMs: outMs.value
  });

  if (result.state === 'failed') {
    setTrimStatus(`Sub-clip failed: ${result.error}`, 'error');
    return;
  }

  if (result.item) {
    store.addItem(result.item);
    setTrimStatus(
      result.state === 'persisted'
        ? 'Virtual sub-clip created and saved.'
        : 'Local virtual sub-clip created (playlist only).',
      'success'
    );
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
            <span class="key-sep">•</span>
            <span class="key-cap">P</span> Play
            <span class="key-sep">•</span>
            <span class="key-cap">M</span> Mute
          </div>
          <button
            v-if="hasTrimRange"
            class="view-toggle-btn"
            :class="{ active: viewTrimmed }"
            @click="toggleViewTrimmed"
            :title="viewTrimmed ? 'Show Full File' : 'Show Trimmed Range'"
          >
            <AppIcon :name="viewTrimmed ? 'scissors' : 'film'" :size="14" />
        <span>{{ viewTrimmed ? 'Trimmed' : 'Full file' }}</span>
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
              preload="metadata" @loadedmetadata="onVideoLoaded" @error="onVideoError" @timeupdate="onTimeUpdate" @play="onVideoPlay" @pause="onVideoPause"></video>
            <div v-else-if="item.type === 'live' || item.path?.startsWith('http')" class="video-placeholder">
              <div class="placeholder-icon"><AppIcon :name="item.type === 'live' ? 'live' : 'graphic'" :size="24" /></div>
              <small class="text-secondary">No local preview</small>
            </div>
            <div v-else-if="previewError" class="video-placeholder" :class="{ 'is-missing': previewSourceMissing }">
              <div class="placeholder-icon"><AppIcon name="alert" :size="24" /></div>
              <small class="text-secondary">{{ previewError }}</small>
            </div>
            <div v-else class="video-placeholder">
              <div class="placeholder-icon">⌛</div>
              <small class="text-secondary">Loading preview…</small>
            </div>
            <div v-if="speed !== 0" class="speed-badge">
          <AppIcon :name="speed < 0 ? 'rewind' : 'fast-forward'" :size="12" />
          <span>{{ Math.abs(speed) === 2 ? '×4' : '×1' }}</span>
        </div>
          </div>

          <!-- Transport Dock (Cleanly below video, never covering frames) -->
          <div class="transport-dock">
            <button class="t-btn t-btn-nav" @click="jumpToMarker('start')" title="Start [Home]">⏮</button>
            <button class="t-btn t-btn-step" @click="nudge(-10)" title="Back 10 frames [Shift+Left]">-10f</button>
            <button class="t-btn t-btn-step" @click="nudge(-1)" title="Back 1 frame [Left]">-1f</button>
            <button class="t-btn t-btn-play" :class="{ 'is-playing': isVideoPlaying }" @click="togglePlayback" title="Play / Pause [Space / K]">
              <span class="play-icon"><AppIcon :name="isVideoPlaying ? 'pause' : 'play'" /></span>
              <span class="play-text">{{ isVideoPlaying ? 'PAUSE' : 'PLAY' }}</span>
            </button>
            <button class="t-btn t-btn-step" @click="nudge(1)" title="Forward 1 frame [Right]">+1f</button>
            <button class="t-btn t-btn-step" @click="nudge(10)" title="Forward 10 frames [Shift+Right]">+10f</button>
            <button class="t-btn t-btn-nav" @click="jumpToMarker('end')" title="End [End]">⏭</button>
          </div>

          <!-- Local audio monitoring (this machine's output, never the programme bus) -->
          <div class="audio-strip" :class="{ 'is-silent': audioSilent }">
            <button
              class="btn btn--icon btn--sm audio-mute"
              :aria-pressed="audioSilent"
              :title="audioSilent ? 'Unmute preview audio [M]' : 'Mute preview audio [M]'"
              @click="trimAudio.toggleMute()"
            >
              <AppIcon :name="audioSilent ? 'volume-off' : 'volume'" :size="14" />
            </button>
            <input
              class="audio-volume"
              type="range"
              min="0"
              max="100"
              step="1"
              :value="audioVolume"
              aria-label="Preview volume"
              :title="`Preview volume ${audioVolume}%`"
              @input="onVolumeInput"
              @change="releaseSliderFocus"
            >
            <TrimAudioMeter
              v-if="audioPeaksState === 'ready'"
              :peaks="audioPeaks"
              :video="videoRef"
              :frame-ms="FRAME_MS"
            />
            <span v-else class="audio-note" :class="`is-${audioPeaksState}`" :title="audioPeaksError || undefined">
              {{ audioPeaksState === 'loading' ? 'Scanning audio…'
                : audioPeaksState === 'none' ? 'No audio track'
                : audioPeaksState === 'error' ? 'Audio scan failed'
                : 'No level for this source' }}
            </span>
            <button
              class="btn btn--ghost btn--sm audio-scrub"
              :class="{ 'is-on': settings.trimmerScrubAudio }"
              :aria-pressed="!!settings.trimmerScrubAudio"
              title="Play a short burst of sound when stepping frames or dragging while paused"
              @click="trimAudio.toggleScrub()"
            >Scrub audio</button>
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
            <div class="timeline-container" :class="{ 'has-waveform': !!audioPeaks }" ref="timelineRef" @mousedown.left="onTimelineMouseDown($event, 'playhead')">
              <div class="tm-track-bg">
                <div class="tm-ticks"></div>
                <TrimWaveform
                  v-if="audioPeaks"
                  :peaks="audioPeaks"
                  :start-ms="scrubOffsetMs"
                  :end-ms="scrubOffsetMs + scrubDurationMs"
                  :in-ms="inMs"
                  :out-ms="outMs"
                />
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
                <button class="mini-btn" @click="playSelection" title="Play from IN, stop at OUT [P]">Play</button>
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
                <button class="mini-btn" @click="playToOut" title="Play the 3 s before OUT, stop on it [Shift+P]">Play to</button>
                <button class="mini-btn mini-btn-set" @click="setOutPoint()" title="Set OUT from current playhead [O]">Set [O]</button>
              </div>
            </div>
          </div>

          <!-- Actions Bar -->
          <div class="trim-actions">
            <button class="action-btn btn-save" @click="saveNonDestructive">
              <AppIcon name="save" :size="14" /> Save Trim Points
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
          <div v-if="trimStatus" class="trim-status" :class="`is-${trimStatusTone}`" role="status">
            <AppIcon
              v-if="trimStatusTone !== 'info'"
              :name="trimStatusTone === 'error' ? 'error' : 'check'"
              :size="12"
            />
            <span>{{ trimStatus }}</span>
          </div>
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
  background: var(--backdrop);
  backdrop-filter: blur(8px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: var(--z-modal);
}

.trim-panel {
  width: 1080px;
  max-width: 96vw;
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  background: var(--bg-secondary);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-3);
}

/* Header */
.trim-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: var(--space-4);
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.clip-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.trim-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent-blue) 15%, transparent);
  color: var(--accent-blue);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 35%, transparent);
}

.clip-name {
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  color: var(--text-primary);
  letter-spacing: var(--tracking-tight);
}

.clip-meta-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.meta-chip {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
}

.meta-chip-active {
  color: var(--accent-blue);
  background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent-blue) 30%, transparent);
}

.meta-chip-duration strong {
  color: var(--accent-green);
  font-family: var(--font-mono);
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.shortcut-hint {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
}

.key-cap {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  padding: var(--space-0) var(--space-2);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}

.key-sep {
  color: var(--text-muted);
  margin: 0 var(--space-0);
}

.view-toggle-btn {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-medium);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.view-toggle-btn:hover {
  background: var(--bg-surface-elevated);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.view-toggle-btn.active {
  background: color-mix(in srgb, var(--accent-blue) 16%, transparent);
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--fs-xl);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.close-btn:hover {
  background: color-mix(in srgb, var(--accent-red) 15%, transparent);
  color: var(--accent-red);
}

/* Layout Body */
.trim-body {
  display: grid;
  grid-template-columns: 1.15fr 0.95fr;
  gap: var(--space-5);
}

/* Left: Player Dock */
.player-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.video-container {
  aspect-ratio: 16/9;
  max-height: 40vh;
  width: 100%;
  background: #000; /* video letterbox, not theme */
  position: relative;
  border-radius: var(--radius-lg);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-medium);
  box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.8); /* video vignette */
}

.trim-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.video-placeholder {
  text-align: center;
  padding: var(--space-8);
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.placeholder-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.speed-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  position: absolute;
  top: 10px;
  right: 12px;
  background: var(--bg-surface);
  backdrop-filter: blur(4px);
  color: var(--accent-red);
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  letter-spacing: var(--tracking-caps);
  border: 1px solid color-mix(in srgb, var(--accent-red) 40%, transparent);
}

/* Transport Bar */
.transport-dock {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  background: var(--bg-tertiary);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
}

.audio-strip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--bg-tertiary);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
}

.audio-volume {
  width: 88px;
  flex: none;
  accent-color: var(--accent-primary);
}

.audio-strip.is-silent .audio-volume {
  opacity: 0.5;
}

.audio-note {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.audio-note.is-error {
  color: var(--accent-red);
}

.audio-scrub {
  flex: none;
}

.audio-scrub.is-on {
  color: var(--accent-primary);
  border-color: color-mix(in srgb, var(--accent-primary) 45%, transparent);
}

.t-btn {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-medium);
  background: var(--bg-hover);
  color: var(--text-primary);
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
  user-select: none;
}

.t-btn:hover {
  background: var(--bg-surface-elevated);
  border-color: var(--border-strong);
}

.t-btn-step {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  padding: var(--space-2) var(--space-3);
}

.t-btn-play {
  background: color-mix(in srgb, var(--accent-blue) 15%, transparent);
  border-color: var(--accent-blue);
  color: var(--accent-blue);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
}

.t-btn-play:hover {
  background: color-mix(in srgb, var(--accent-blue) 25%, transparent);
}

.t-btn-play.is-playing {
  background: color-mix(in srgb, var(--accent-red) 15%, transparent);
  border-color: var(--accent-red);
  color: var(--accent-red);
}

.play-icon {
  display: inline-flex;
  align-items: center;
}

.play-text {
  font-size: var(--fs-sm);
  letter-spacing: var(--tracking-caps);
}

/* Right Column: Controls */
.ctrl-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Hero Metrics */
.trim-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.metric-card {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-2) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.metric-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.metric-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.dot-cyan { background: var(--accent-blue); }
.dot-emerald { background: var(--accent-green); }

.metric-label {
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  color: var(--text-muted);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}

.metric-tc {
  font-family: var(--font-mono);
  font-size: var(--fs-xl);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
}

.tc-cyan { color: var(--accent-blue); }
.tc-emerald { color: var(--accent-green); }

/* Timeline Scrub Area */
.scrub-area {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-4) var(--space-4) var(--space-3) var(--space-4);
}

.timeline-container {
  position: relative;
  height: 40px;
  background: var(--bg-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-medium);
  cursor: pointer;
  margin: var(--space-1) 0 var(--space-2) 0;
  user-select: none;
}

.timeline-container.has-waveform {
  height: 64px;
}

.tm-track-bg {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-md);
  overflow: hidden;
}

.tm-ticks {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    90deg,
    transparent,
    transparent 19px,
    var(--border-subtle) 20px
  );
}

.tm-range {
  position: absolute;
  top: 0;
  bottom: 0;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent-green) 25%, transparent) 0%, color-mix(in srgb, var(--accent-blue) 25%, transparent) 50%, color-mix(in srgb, var(--accent-red) 25%, transparent) 100%);
  border-top: 2px solid var(--accent-blue);
  border-bottom: 2px solid var(--accent-blue);
  pointer-events: none;
}

.tm-handle-wrapper {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  /* §3.9: local stacking inside the scrubber. 1 is the waveform, 2 the
     handles' rail, 3 a handle the operator is dragging. */
  z-index: 2;
}

.tm-handle {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 18px;
  border-radius: var(--radius-sm);
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: var(--fw-bold);
  box-shadow: var(--shadow-2);
  transform: translateX(-50%);
  transition: transform var(--dur-fast);
}

.tm-handle:hover {
  transform: translateX(-50%) scaleY(1.08);
}

.tm-handle-in {
  background: var(--accent-green);
  color: var(--text-on-accent);
  border: 1px solid var(--accent-green);
}

.tm-handle-out {
  background: var(--accent-red);
  color: var(--text-on-accent);
  border: 1px solid var(--accent-red);
}

.handle-bracket {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  line-height: var(--lh-none);
}

/* Playhead */
.tm-playhead {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 14px;
  cursor: ew-resize;
  z-index: 3;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
}

.tm-playhead-cap {
  width: 10px;
  height: 10px;
  background: var(--text-primary);
  transform: rotate(45deg);
  border-radius: var(--radius-sm);
  margin-top: var(--space-0);
}

.tm-playhead-line {
  width: 2px;
  flex: 1;
  background: var(--text-primary);
  pointer-events: none;
}

.timeline-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.tc-footer-label {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}

/* IN / OUT Cards */
.tc-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.tc-card {
  background: var(--bg-tertiary);
  border-radius: var(--radius-lg);
  padding: var(--space-2) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border: 1px solid var(--border-subtle);
}

.tc-card-in {
  border-left: 3px solid var(--accent-green);
}

.tc-card-out {
  border-left: 3px solid var(--accent-red);
}

.tc-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.tc-tag {
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps);
}

.tag-in { color: var(--accent-green); }
.tag-out { color: var(--accent-red); }

.tc-input {
  font-family: var(--font-mono);
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps);
  text-align: center;
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  padding: var(--space-2);
  border-radius: var(--radius-md);
  width: 100%;
  box-sizing: border-box;
  transition: border-color var(--dur-fast) var(--ease-out);
}

.tc-input-in {
  color: var(--accent-green);
}

.tc-input-in:focus {
  outline: none;
  border-color: var(--accent-green);
  box-shadow: var(--focus-ring);
}

.tc-input-out {
  color: var(--accent-red);
}

.tc-input-out:focus {
  outline: none;
  border-color: var(--accent-red);
  box-shadow: var(--focus-ring);
}

.tc-actions {
  display: flex;
  gap: var(--space-2);
}

.mini-btn {
  flex: 1;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-medium);
  background: var(--bg-hover);
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.mini-btn:hover {
  background: var(--bg-surface-elevated);
  border-color: var(--border-strong);
}

.mini-btn-set {
  background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent-blue) 35%, transparent);
  color: var(--accent-blue);
}

.mini-btn-set:hover {
  background: color-mix(in srgb, var(--accent-blue) 22%, transparent);
}

/* Actions Footer */
.trim-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.action-btn {
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-medium);
  background: var(--bg-hover);
  color: var(--text-primary);
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}

.action-btn:hover {
  background: var(--bg-surface-elevated);
  border-color: var(--border-strong);
}

.action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.btn-save {
  background: color-mix(in srgb, var(--accent-green) 15%, transparent);
  border-color: var(--accent-green);
  color: var(--accent-green);
  flex: 1.2;
}

.btn-save:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-green) 25%, transparent);
}

.btn-subclip {
  background: color-mix(in srgb, var(--accent-blue) 15%, transparent);
  border-color: var(--accent-blue);
  color: var(--accent-blue);
  flex: 1.4;
}

.btn-subclip:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-blue) 25%, transparent);
}

.btn-cancel {
  background: var(--bg-hover);
  color: var(--text-secondary);
  flex: 0.8;
}

.trim-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-sm);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-medium);
  color: var(--text-primary);
}

/* The state that used to be a glyph inside the sentence. */
.trim-status.is-error {
  border-color: color-mix(in srgb, var(--status-error) 55%, transparent);
  background: color-mix(in srgb, var(--status-error) 12%, var(--bg-tertiary));
  color: var(--status-error);
  font-weight: var(--fw-bold);
}

.trim-status.is-success {
  border-color: color-mix(in srgb, var(--status-ready) 50%, transparent);
  background: color-mix(in srgb, var(--status-ready) 10%, var(--bg-tertiary));
  color: var(--status-ready);
  font-weight: var(--fw-bold);
}

/* Subclip Dialog */
.subclip-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal-nested);
  background: var(--backdrop);
  backdrop-filter: blur(8px);
  display: flex;
  justify-content: center;
  align-items: center;
}

.subclip-modal-dialog {
  width: 440px;
  max-width: 90vw;
  background: var(--bg-secondary);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  box-shadow: var(--shadow-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.modal-header-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.modal-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent-blue) 15%, transparent);
  color: var(--accent-blue);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 35%, transparent);
}

.modal-title {
  margin: 0;
  font-size: var(--fs-lg);
  color: var(--text-primary);
  font-weight: var(--fw-bold);
}

.modal-desc {
  color: var(--text-secondary);
  font-size: var(--fs-md);
  margin: 0;
}

.subclip-name-input {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-md);
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--dur-fast);
}

.subclip-name-input:focus {
  border-color: var(--accent-primary);
  box-shadow: var(--focus-ring);
}

.subclip-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

@media (max-width: 900px) {
  .trim-body,
  .trim-metrics,
  .tc-grid {
    grid-template-columns: 1fr;
  }
}
</style>
