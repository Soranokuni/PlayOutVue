import { ref, shallowRef, watch, type Ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';
import { NO_AUDIO, peaksFromBuffer, type AudioPeaks } from '../lib/audioPeaks';

/**
 * Local audio monitoring for the trim panel.
 *
 * The preview `<video>` used to be hard-muted, so an operator cutting on a
 * word had to guess from the picture. This gives them three things:
 *
 * - **Listening.** The preview plays with sound, at a volume and mute state
 *   that persist in settings. It is the WebView's audio, on this machine's
 *   default output device: it never reaches CasparCG or the programme bus.
 * - **Audition while stepping.** When the preview is paused and the operator
 *   steps a frame or drags the playhead, a short burst of the sound at that
 *   position plays, so a word's first syllable can be found frame by frame.
 *   The burst comes from a second, hidden `<audio>` element on the same
 *   stream, so the picture stays on the frame the operator stepped to.
 * - **An envelope.** A peak scan of the file (`get_audio_peaks`) that drives
 *   the timeline waveform and the level meter. It is independent of the
 *   player, so it also works for files the WebView cannot decode.
 */

/** How much sound one audition burst plays: long enough to recognise a phoneme. */
export const AUDITION_MS = 120;
/**
 * While a drag keeps queueing newer positions, a burst hands over after this
 * much, so the sound keeps up with the hand.
 */
export const AUDITION_HANDOVER_MS = 60;
/** A seek that has not settled in this long is played from wherever it is. */
const SEEK_SETTLE_MS = 250;
/**
 * The burst is measured in *media* time, not wall time: WebView2 takes about
 * 100 ms to start an audio element, so a 120 ms wall-clock timer left 20-30 ms
 * of audible sound (measured). This caps the wait if the clock never moves.
 */
const START_LATENCY_CAP_MS = 400;
const POLL_MS = 15;

export type PeaksState = 'idle' | 'loading' | 'ready' | 'none' | 'error';

export interface TrimAudioOptions {
  videoRef: Ref<HTMLVideoElement | null>;
  /** The stream URL both the preview and the audition element play. */
  srcRef: Ref<string>;
  createAudio?: () => HTMLAudioElement;
  invokeFn?: typeof invoke;
}

export function useTrimAudio(options: TrimAudioOptions) {
  const settings = useSettingsStore();
  const call = options.invokeFn ?? invoke;
  const createAudio = options.createAudio ?? (() => new Audio());

  const peaks = shallowRef<AudioPeaks | null>(null);
  const peaksState = ref<PeaksState>('idle');
  const peaksError = ref('');
  let peaksGeneration = 0;

  const volumeFraction = () => Math.max(0, Math.min(100, Number(settings.trimmerAudioVolume) || 0)) / 100;

  const applyToVideo = () => {
    const v = options.videoRef.value;
    if (!v) return;
    v.muted = !!settings.trimmerAudioMuted;
    v.volume = volumeFraction();
  };

  watch(
    [options.videoRef, () => settings.trimmerAudioMuted, () => settings.trimmerAudioVolume],
    applyToVideo,
    { immediate: true }
  );

  const toggleMute = () => {
    settings.trimmerAudioMuted = !settings.trimmerAudioMuted;
    if (settings.trimmerAudioMuted) stopAudition();
  };

  const setVolume = (percent: number) => {
    const next = Math.round(Math.max(0, Math.min(100, Number(percent) || 0)));
    settings.trimmerAudioVolume = next;
    if (next > 0 && settings.trimmerAudioMuted) settings.trimmerAudioMuted = false;
  };

  const toggleScrub = () => {
    settings.trimmerScrubAudio = !settings.trimmerScrubAudio;
    if (!settings.trimmerScrubAudio) stopAudition();
  };

  // ── Peak envelope ─────────────────────────────────────────────────────────
  /** Stop the Rust-side scan. A newer `get_audio_peaks` supersedes it by itself. */
  const cancelScan = () => {
    void Promise.resolve()
      .then(() => call('cancel_audio_peaks'))
      .catch(() => undefined);
  };

  const loadPeaks = async (path: string | undefined) => {
    const generation = ++peaksGeneration;
    const wasScanning = peaksState.value === 'loading';
    peaks.value = null;
    peaksError.value = '';
    if (!path || /^https?:/i.test(path)) {
      peaksState.value = 'idle';
      // A local path would supersede the running scan in Rust; this does not.
      if (wasScanning) cancelScan();
      return;
    }
    peaksState.value = 'loading';
    try {
      const raw = await call<ArrayBuffer | number[]>('get_audio_peaks', { path });
      if (generation !== peaksGeneration) return;
      const decoded = peaksFromBuffer(raw);
      peaks.value = decoded.steps > 0 ? decoded : null;
      peaksState.value = decoded.steps > 0 ? 'ready' : 'none';
    } catch (error) {
      if (generation !== peaksGeneration) return;
      const message = typeof error === 'string' ? error : (error as Error)?.message ?? String(error);
      if (message === NO_AUDIO) {
        peaksState.value = 'none';
      } else {
        peaksState.value = 'error';
        peaksError.value = message;
      }
    }
  };

  // ── Audition bursts ───────────────────────────────────────────────────────
  let auditionEl: HTMLAudioElement | null = null;
  let auditionSrc = '';
  let bursting = false;
  let pendingMs: number | null = null;
  let burstTimer: ReturnType<typeof setTimeout> | null = null;

  const auditionElement = (): HTMLAudioElement | null => {
    const src = options.srcRef.value;
    if (!src) return null;
    if (!auditionEl) {
      auditionEl = createAudio();
      auditionEl.preload = 'auto';
    }
    if (auditionSrc !== src) {
      auditionEl.src = src;
      auditionSrc = src;
    }
    return auditionEl;
  };

  const waitForSeek = (el: HTMLAudioElement) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener('seeked', finish);
        resolve();
      };
      el.addEventListener('seeked', finish);
      setTimeout(finish, SEEK_SETTLE_MS);
    });

  const canAudition = () => {
    const v = options.videoRef.value;
    return !!settings.trimmerScrubAudio && !settings.trimmerAudioMuted && volumeFraction() > 0 && (!v || v.paused);
  };

  const runNextBurst = async () => {
    if (pendingMs == null || !canAudition()) {
      pendingMs = null;
      bursting = false;
      return;
    }
    const el = auditionElement();
    if (!el) {
      pendingMs = null;
      bursting = false;
      return;
    }
    const ms = pendingMs;
    pendingMs = null;
    bursting = true;

    el.volume = volumeFraction();
    el.currentTime = Math.max(0, ms / 1000);
    await waitForSeek(el);
    if (!bursting) return; // stopped while seeking
    const startedAt = el.currentTime;
    const deadline = Date.now() + AUDITION_MS + START_LATENCY_CAP_MS;
    await el.play().catch(() => undefined);
    if (!bursting) return; // stopped while starting

    const poll = () => {
      burstTimer = null;
      if (!bursting) return;
      const heardMs = (el.currentTime - startedAt) * 1000;
      const enough = pendingMs != null ? AUDITION_HANDOVER_MS : AUDITION_MS;
      if (heardMs < enough && Date.now() < deadline) {
        burstTimer = setTimeout(poll, POLL_MS);
        return;
      }
      el.pause();
      bursting = false;
      // A drag keeps queueing positions: chain straight into the latest one,
      // which is what makes a drag sound like tape rather than like clicks.
      if (pendingMs != null) void runNextBurst();
    };
    burstTimer = setTimeout(poll, POLL_MS);
  };

  /** Play a short burst of sound at `ms`. Coalesces: only the newest position waits. */
  const audition = (ms: number) => {
    if (!canAudition() || !Number.isFinite(ms)) return;
    pendingMs = ms;
    if (!bursting) void runNextBurst();
  };

  function stopAudition() {
    pendingMs = null;
    bursting = false;
    if (burstTimer) {
      clearTimeout(burstTimer);
      burstTimer = null;
    }
    auditionEl?.pause();
  }

  /**
   * The panel closed (or unmounted): stop the sound, drop the audition
   * element's stream and abandon a scan still running. The trim panel stays
   * mounted, so doing this only on unmount kept a media-server stream and a
   * decoder alive for the whole session, and a closed panel's ffmpeg kept
   * reading its file to the end.
   */
  const release = () => {
    stopAudition();
    peaksGeneration++;
    if (peaksState.value === 'loading') {
      peaksState.value = 'idle';
      cancelScan();
    }
    if (auditionEl) {
      auditionEl.removeAttribute('src');
      auditionEl.load?.();
    }
    auditionEl = null;
    auditionSrc = '';
  };

  const dispose = release;

  return {
    peaks,
    peaksState,
    peaksError,
    loadPeaks,
    audition,
    stopAudition,
    toggleMute,
    setVolume,
    toggleScrub,
    release,
    dispose,
  };
}
