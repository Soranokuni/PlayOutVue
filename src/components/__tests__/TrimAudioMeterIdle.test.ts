// @vitest-environment happy-dom
/**
 * PERF-PLAN PR D: the trimmer's level meter ran a 60 Hz animation loop for as
 * long as the panel was open, even parked on a frame with nothing moving. It
 * now stops once the bars have settled and wakes on playback or a seek.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import TrimAudioMeter from '../TrimAudioMeter.vue';
import { peaksFromBuffer } from '../../lib/audioPeaks';

class FakeVideo extends EventTarget {
  currentTime = 1;
  paused = true;
  ended = false;
}

describe('TrimAudioMeter idles when parked', () => {
  let frames = 0;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    frames = 0;
    const raf = window.requestAnimationFrame.bind(window);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames += 1;
      return raf(cb);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stops the loop on a still frame and restarts it on a seek', async () => {
    const video = new FakeVideo();
    const peaks = peaksFromBuffer(new Uint8Array(400).fill(180).buffer);
    const wrapper = mount(TrimAudioMeter, {
      props: { peaks, video: video as unknown as HTMLVideoElement, frameMs: 40 }
    });

    // Long enough for the bars to rise and the peak hold to catch up.
    await vi.advanceTimersByTimeAsync(3_000);
    const settledAt = frames;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frames).toBe(settledAt);

    video.currentTime = 2;
    video.dispatchEvent(new Event('seeked'));
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toBeGreaterThan(settledAt);

    wrapper.unmount();
  });

  it('keeps running while the preview plays', async () => {
    const video = new FakeVideo();
    video.paused = false;
    const peaks = peaksFromBuffer(new Uint8Array(400).fill(180).buffer);
    const wrapper = mount(TrimAudioMeter, {
      props: { peaks, video: video as unknown as HTMLVideoElement, frameMs: 40 }
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const before = frames;
    await vi.advanceTimersByTimeAsync(500);
    expect(frames).toBeGreaterThan(before);
    wrapper.unmount();
  });
});
