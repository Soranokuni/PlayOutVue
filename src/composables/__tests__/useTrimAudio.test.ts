import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ref, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useTrimAudio, AUDITION_MS, AUDITION_HANDOVER_MS } from '../useTrimAudio';
import { useSettingsStore } from '../../stores/settings';

/** WebView2's measured delay between `play()` and sound. */
const START_LATENCY_MS = 100;

/**
 * Just enough of an `<audio>` element: seeks settle on the next microtask, and
 * the media clock only starts moving {@link START_LATENCY_MS} after `play()`,
 * as it does in WebView2.
 */
class FakeAudio extends EventTarget {
  preload = '';
  src = '';
  volume = 1;
  paused = true;
  plays: number[] = [];
  /** Media time actually heard per burst, in ms. */
  heard: number[] = [];
  private time = 0;
  private playedAt = 0;
  private clock() {
    if (this.paused) return this.time;
    return this.time + Math.max(0, Date.now() - this.playedAt - START_LATENCY_MS) / 1000;
  }
  get currentTime() {
    return this.clock();
  }
  set currentTime(value: number) {
    this.time = value;
    this.playedAt = Date.now();
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
  }
  play() {
    this.paused = false;
    this.playedAt = Date.now();
    this.plays.push(this.time);
    return Promise.resolve();
  }
  pause() {
    if (!this.paused) {
      const now = this.clock();
      this.heard.push(Math.round((now - this.time) * 1000));
      this.time = now;
    }
    this.paused = true;
  }
  removeAttribute() {}
  load() {}
}

const pausedVideo = () => ({ paused: true, muted: false, volume: 1 }) as unknown as HTMLVideoElement;

function setup(invokeFn = vi.fn()) {
  const audio = new FakeAudio();
  const videoRef = ref<HTMLVideoElement | null>(pausedVideo());
  const srcRef = ref('http://127.0.0.1:1/?file=a.mp4&t=x');
  const api = useTrimAudio({
    videoRef,
    srcRef,
    createAudio: () => audio as unknown as HTMLAudioElement,
    invokeFn: invokeFn as any,
  });
  return { api, audio, videoRef, srcRef, invokeFn };
}

describe('trimmer audio monitoring', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the persisted volume and mute to the preview', async () => {
    const settings = useSettingsStore();
    const { videoRef } = setup();
    expect(videoRef.value!.muted).toBe(false);
    expect(videoRef.value!.volume).toBeCloseTo(0.8);

    settings.trimmerAudioVolume = 25;
    settings.trimmerAudioMuted = true;
    await nextTick();
    expect(videoRef.value!.volume).toBeCloseTo(0.25);
    expect(videoRef.value!.muted).toBe(true);
  });

  it('raising the volume from the slider unmutes', () => {
    const settings = useSettingsStore();
    settings.trimmerAudioMuted = true;
    const { api } = setup();
    api.setVolume(140);
    expect(settings.trimmerAudioVolume).toBe(100);
    expect(settings.trimmerAudioMuted).toBe(false);
  });

  it('auditions a short burst at the stepped position, then stops', async () => {
    const { api, audio } = setup();
    api.audition(1040);
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.plays).toEqual([1.04]);
    expect(audio.paused).toBe(false);

    await vi.advanceTimersByTimeAsync(START_LATENCY_MS + AUDITION_MS + 50);
    expect(audio.paused).toBe(true);
  });

  it('measures the burst in media time, so start-up latency does not eat it', async () => {
    const { api, audio } = setup();
    api.audition(5000);
    await vi.advanceTimersByTimeAsync(START_LATENCY_MS + AUDITION_MS + 50);
    expect(audio.heard).toHaveLength(1);
    expect(audio.heard[0]).toBeGreaterThanOrEqual(AUDITION_MS);
    expect(audio.heard[0]).toBeLessThan(AUDITION_MS + 40);
  });

  it('coalesces a drag: only the newest position waits behind the burst, which hands over early', async () => {
    const { api, audio } = setup();
    api.audition(1000);
    await vi.advanceTimersByTimeAsync(0);
    api.audition(1100);
    api.audition(1200);
    api.audition(1300);
    await vi.advanceTimersByTimeAsync(START_LATENCY_MS + AUDITION_HANDOVER_MS + 30);
    expect(audio.plays).toEqual([1, 1.3]);
    expect(audio.heard[0]).toBeGreaterThanOrEqual(AUDITION_HANDOVER_MS);
    expect(audio.heard[0]).toBeLessThan(AUDITION_MS);
  });

  it('gives up waiting for a clock that never starts', async () => {
    const { api, audio } = setup();
    audio.play = function () {
      this.paused = false;
      this.plays.push(0);
      return Promise.resolve();
    };
    Object.defineProperty(audio, 'currentTime', { get: () => 0, set: () => queueMicrotask(() => audio.dispatchEvent(new Event('seeked'))) });
    api.audition(0);
    await vi.advanceTimersByTimeAsync(AUDITION_MS + 400 + 50);
    expect(audio.paused).toBe(true);
  });

  it('stays silent when muted, when scrub audio is off, or while the preview plays', async () => {
    const settings = useSettingsStore();
    const { api, audio, videoRef } = setup();

    settings.trimmerAudioMuted = true;
    api.audition(500);
    settings.trimmerAudioMuted = false;
    settings.trimmerScrubAudio = false;
    api.audition(500);
    settings.trimmerScrubAudio = true;
    (videoRef.value as any).paused = false;
    api.audition(500);

    await vi.advanceTimersByTimeAsync(AUDITION_MS * 2);
    expect(audio.plays).toEqual([]);
  });

  it('muting cuts a burst that is already playing', async () => {
    const { api, audio } = setup();
    api.audition(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.paused).toBe(false);
    api.toggleMute();
    expect(audio.paused).toBe(true);
  });

  it('loads the envelope and names a file with no audio', async () => {
    const invokeFn = vi.fn().mockResolvedValueOnce(Uint8Array.from([10, 20, 30, 40]).buffer).mockRejectedValueOnce('no_audio');
    const { api } = setup(invokeFn);

    await api.loadPeaks('D:/media/a.mp4');
    expect(invokeFn).toHaveBeenCalledWith('get_audio_peaks', { path: 'D:/media/a.mp4' });
    expect(api.peaksState.value).toBe('ready');
    expect(api.peaks.value?.steps).toBe(2);

    await api.loadPeaks('D:/media/silent.mov');
    expect(api.peaksState.value).toBe('none');
    expect(api.peaks.value).toBeNull();
  });

  it('reports a failed scan, and never scans a stream URL', async () => {
    const invokeFn = vi.fn().mockRejectedValue('ffmpeg: Invalid data found');
    const { api } = setup(invokeFn);
    await api.loadPeaks('D:/media/broken.mxf');
    expect(api.peaksState.value).toBe('error');
    expect(api.peaksError.value).toContain('Invalid data');

    invokeFn.mockClear();
    await api.loadPeaks('https://example.com/live.m3u8');
    expect(invokeFn).not.toHaveBeenCalled();
    expect(api.peaksState.value).toBe('idle');
  });

  it('drops a slow scan that finishes after the operator moved to another clip', async () => {
    let resolveFirst: (v: ArrayBuffer) => void = () => {};
    const invokeFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(Uint8Array.from([1, 1]).buffer);
    const { api } = setup(invokeFn);

    const first = api.loadPeaks('D:/media/long.mp4');
    await api.loadPeaks('D:/media/short.mp4');
    resolveFirst(Uint8Array.from([9, 9, 9, 9, 9, 9]).buffer);
    await first;
    expect(api.peaks.value?.steps).toBe(1);
  });

  // PERF-PLAN PR D: the trim panel stays mounted, so "closed" has to release
  // what "unmounted" used to.
  it('closing the panel cancels a running scan and drops its late result', async () => {
    let resolveScan: (v: ArrayBuffer) => void = () => {};
    const invokeFn = vi.fn((cmd: string) =>
      cmd === 'get_audio_peaks' ? new Promise((resolve) => (resolveScan = resolve)) : Promise.resolve()
    );
    const { api } = setup(invokeFn);

    const pending = api.loadPeaks('D:/media/long.mp4');
    expect(api.peaksState.value).toBe('loading');
    api.release();
    await Promise.resolve();

    expect(invokeFn).toHaveBeenCalledWith('cancel_audio_peaks');
    expect(api.peaksState.value).toBe('idle');
    resolveScan(Uint8Array.from([9, 9]).buffer);
    await pending;
    expect(api.peaks.value).toBeNull();
    expect(api.peaksState.value).toBe('idle');
  });

  it('closing the panel with no scan running does not call the backend', async () => {
    const invokeFn = vi.fn().mockResolvedValue(Uint8Array.from([1, 1]).buffer);
    const { api } = setup(invokeFn);
    await api.loadPeaks('D:/media/a.mp4');
    invokeFn.mockClear();
    api.release();
    await Promise.resolve();
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it('closing the panel releases the audition stream; the next burst opens a new one', async () => {
    const created: FakeAudio[] = [];
    const videoRef = ref<HTMLVideoElement | null>(pausedVideo());
    const srcRef = ref('http://127.0.0.1:1/?file=a.mp4&t=x');
    const api = useTrimAudio({
      videoRef,
      srcRef,
      createAudio: () => {
        const audio = new FakeAudio();
        created.push(audio);
        return audio as unknown as HTMLAudioElement;
      },
      invokeFn: vi.fn() as any,
    });

    api.audition(1000);
    await vi.advanceTimersByTimeAsync(AUDITION_MS + 400);
    const first = created[0]!;
    const released = vi.spyOn(first, 'removeAttribute');
    api.release();
    expect(released).toHaveBeenCalledWith('src');

    api.audition(2000);
    await vi.advanceTimersByTimeAsync(AUDITION_MS + 400);
    expect(created).toHaveLength(2);
  });

  it('moving to a stream URL while scanning cancels the scan', async () => {
    const invokeFn = vi.fn((cmd: string) =>
      cmd === 'get_audio_peaks' ? new Promise(() => {}) : Promise.resolve()
    );
    const { api } = setup(invokeFn);
    void api.loadPeaks('D:/media/long.mp4');
    await api.loadPeaks('https://example.com/live.m3u8');
    await Promise.resolve();
    expect(invokeFn).toHaveBeenCalledWith('cancel_audio_peaks');
  });
});
