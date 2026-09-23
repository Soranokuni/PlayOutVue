// @vitest-environment happy-dom
/**
 * PERF-PLAN PR D: dragging IN or OUT only changes which waveform bars are
 * dimmed. The envelope walk (`columnCodes`, every peak step in view) is reused
 * until the view, the canvas size or the peaks change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

const columnCodes = vi.hoisted(() => ({ spy: null as null | ReturnType<typeof vi.fn> }));

vi.mock('../../lib/audioPeaks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/audioPeaks')>();
  columnCodes.spy = vi.fn(actual.columnCodes);
  return { ...actual, columnCodes: columnCodes.spy };
});

import TrimWaveform from '../TrimWaveform.vue';
import { peaksFromBuffer } from '../../lib/audioPeaks';

const fakeContext = () => ({
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  fillStyle: '',
  globalAlpha: 1
});

describe('TrimWaveform reuses its envelope across IN/OUT drags', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext() as any);
    columnCodes.spy!.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('walks the envelope once for a drag, and again when the view changes', async () => {
    const peaks = peaksFromBuffer(new Uint8Array(2_000).fill(150).buffer);
    const wrapper = mount(TrimWaveform, {
      props: { peaks, startMs: 0, endMs: 10_000, inMs: 0, outMs: 10_000 }
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(columnCodes.spy).toHaveBeenCalledTimes(1);

    for (let inMs = 100; inMs <= 2_000; inMs += 100) {
      await wrapper.setProps({ inMs });
      await nextTick();
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(columnCodes.spy).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ startMs: 1_000 });
    await vi.advanceTimersByTimeAsync(20);
    expect(columnCodes.spy).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
