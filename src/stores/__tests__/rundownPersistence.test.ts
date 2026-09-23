// @vitest-environment happy-dom
/**
 * PERF-PLAN PR B: the rundown store persists durable operator state only, and
 * only when it changes.
 *
 * The playback progress loop (4 Hz) and the wall clock (1 Hz) used to be store
 * state, so every write fired the persist plugin, which stringified every
 * playlist before its debounce. They are getters now, and the JSON is built at
 * flush time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { useRundownStore } from '../rundown';
import { flushPersistence } from '../../lib/persistenceStorage';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));

const installPinia = () => {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({}).use(pinia);
  setActivePinia(pinia);
  return pinia;
};

/** Serialisations of the persisted rundown (the only JSON with `playlists`). */
const rundownSerialisations = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter(([value]) => !!value && typeof value === 'object' && 'playlists' in (value as object));

const saved = () => JSON.parse(localStorage.getItem('rundown') || 'null');

describe('PERF-PLAN PR B · rundown persistence', () => {
  let stringify: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    installPinia();
    stringify = vi.spyOn(JSON, 'stringify');
  });

  afterEach(() => {
    useRundownStore().stopPlaybackProgressTimer();
    flushPersistence();
    stringify.mockRestore();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('the progress loop and the wall clock do not persist the rundown', async () => {
    const store = useRundownStore();
    store.addItem({ filename: 'Clip', type: 'video', path: '/clip.mp4', duration: 60, duration_ms: 60_000 });
    store.setPlaylistOnAir(store.currentPlaylist.id, 0);
    store.startPlaybackProgressTimer(store.currentPlayingInstanceId!, 60_000);
    await vi.advanceTimersByTimeAsync(300);
    stringify.mockClear();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(store.playbackProgressPct).toBeGreaterThan(4);
    expect(rundownSerialisations(stringify)).toHaveLength(0);
  });

  it('a burst of selection moves writes once, with the last selection', async () => {
    const store = useRundownStore();
    for (let i = 0; i < 5; i++) {
      store.addItem({ filename: `Clip ${i}`, type: 'video', path: `/clip-${i}.mp4`, duration: 60 });
    }
    await vi.advanceTimersByTimeAsync(300);
    stringify.mockClear();

    const ids = store.activeItems.map((item) => item.id);
    for (const id of [...ids, ...ids]) {
      store.selectItem(id);
      await nextTick();
    }
    expect(rundownSerialisations(stringify)).toHaveLength(0);
    expect(saved().playlists[0].selectedItemId).not.toBe(ids[ids.length - 1]);

    await vi.advanceTimersByTimeAsync(250);
    expect(rundownSerialisations(stringify)).toHaveLength(1);
    expect(saved().playlists[0].selectedItemId).toBe(ids[ids.length - 1]);
  });

  it('a new session restores what was persisted', async () => {
    const store = useRundownStore();
    store.addItem({ filename: 'Kept', type: 'video', path: '/kept.mp4', duration: 60 });
    store.setPlaylistOnAir(store.currentPlaylist.id, 0);
    const instanceId = store.currentPlayingInstanceId;
    await nextTick();
    flushPersistence();

    installPinia();
    const restored = useRundownStore();
    expect(restored.activeItems.map((item) => item.filename)).toEqual(['Kept']);
    expect(restored.currentPlayingInstanceId).toBe(instanceId);
  });
});

describe('PERF-PLAN PR B · ETAs ignore selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('moving the selection does not rebuild every ETA', () => {
    const store = useRundownStore();
    for (let i = 0; i < 3; i++) {
      store.addItem({ filename: `Clip ${i}`, type: 'video', path: `/clip-${i}.mp4`, duration: 60 });
    }
    const before = store.activeItemsETAs;
    store.selectItem(store.activeItems[2]!.id);
    store.selectItem(store.activeItems[0]!.id);
    expect(store.selectedItemId).toBe(store.activeItems[0]!.id);
    expect(store.activeItemsETAs).toBe(before);
  });

  it('a start-time change still rebuilds them', () => {
    const store = useRundownStore();
    store.addItem({ filename: 'Clip', type: 'video', path: '/clip.mp4', duration: 60 });
    const before = store.activeItemsETAs;
    store.currentPlaylistStartFrom = '06:00:00';
    expect(store.activeItemsETAs).not.toBe(before);
    expect(store.activeItemsETAs[0]!.formatted).toBe('06:00:00');
  });
});
