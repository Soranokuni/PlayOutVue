// @vitest-environment happy-dom
/**
 * PERF-PLAN PR A: values that change many times a second (the studio clock,
 * the playback position, the progress loop) must re-render only the leaf that
 * shows them, never the whole rundown list.
 *
 * `subTree` is replaced every time a component re-renders, so an unchanged
 * `subTree` proves the list template did not run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import RundownList from '../RundownList.vue';
import { useRundownStore } from '../../stores/rundown';
import { currentCasparMs, isCasparPlaying } from '../../services/caspar';

describe('RundownList tick isolation', () => {
  let store: ReturnType<typeof useRundownStore>;
  let wrapper: VueWrapper | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    store = useRundownStore();
    document.body.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      store.addItem({ filename: `Clip ${i}`, type: 'video', path: `/clip-${i}.mp4`, duration: 60, duration_ms: 60_000 });
    }
    store.setPlaylistOnAir(store.currentPlaylist.id, 1);
    isCasparPlaying.value = true;
    currentCasparMs.value = 0;
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    isCasparPlaying.value = false;
    currentCasparMs.value = 0;
    vi.useRealTimers();
  });

  const mountList = () =>
    mount(RundownList, { global: { stubs: { ContextMenu: true, StatusIndicator: true } } });

  const listSubTree = (w: VueWrapper) => w.vm.$.subTree;

  it('the studio clock updates without re-rendering the list', async () => {
    wrapper = mountList();
    await nextTick();
    const clock = wrapper.get('.clock-display');
    const before = clock.text();
    const tree = listSubTree(wrapper);

    // Under a second, so only the 25 fps studio clock fires, not the 1 Hz
    // store clock (which legitimately re-renders the ETA column).
    await vi.advanceTimersByTimeAsync(400);

    expect(clock.text()).not.toBe(before);
    expect(listSubTree(wrapper)).toBe(tree);
  });

  it('sub-second playback ticks and progress updates do not re-render the list', async () => {
    wrapper = mountList();
    currentCasparMs.value = 5_000;
    await nextTick();
    const tree = listSubTree(wrapper);
    const hairline = () => wrapper!.get('[data-progress-tone] .rw-progress-hairline').attributes('style');

    // Ten ticks inside the same displayed second, like the 10 Hz OSC tick.
    for (let i = 1; i <= 9; i++) {
      currentCasparMs.value = 5_000 + i * 100;
      await nextTick();
    }
    store.playbackProgressPct = 42;
    await nextTick();

    expect(hairline()).toContain('scaleX(0.42)');
    expect(listSubTree(wrapper)).toBe(tree);
  });

  it('the elapsed label still advances once a second', async () => {
    wrapper = mountList();
    await nextTick();
    currentCasparMs.value = 12_000;
    await nextTick();
    expect(wrapper.get('[data-progress-tone] .rw-dur-sub').text()).toContain('00:12');
  });
});
