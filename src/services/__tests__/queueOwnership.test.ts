import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
}));

import { setActivePinia, createPinia } from 'pinia';
import {
  casparPlayoutService,
  queueContainsKey,
  __playoutQueueTestHooks as hooks,
} from '../caspar';
import { useRundownStore } from '../../stores/rundown';

const item = (id: string) =>
  ({
    id,
    playoutvueId: id,
    type: 'video',
    filename: `${id}.mp4`,
    path: `D:/media/${id}.mp4`,
    duration_ms: 10_000,
    trim_in_ms: 0,
    trim_out_ms: 10_000,
  }) as any;

describe('T0-3 · playout queue ownership guard (service)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    hooks.setState([], null, false);
  });

  it('queueContainsKey matches by item id only', () => {
    const items = [item('a'), item('b')];
    expect(queueContainsKey(items, 'a')).toBe(true);
    expect(queueContainsKey(items, 'z')).toBe(false);
    expect(queueContainsKey(items, null)).toBe(false);
  });

  it('keeps the on-air queue when a foreign playlist is pushed while playing', async () => {
    const onAir = [item('a'), item('b'), item('c')];
    hooks.setState(onAir, 'b', true);

    const foreign = [item('x'), item('y')];
    await casparPlayoutService.refreshQueue!(foreign);

    expect(hooks.getQueuedItems().map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(hooks.getCurrentKey()).toBe('b');
  });

  it('adopts an edited queue that still contains the on-air item', async () => {
    hooks.setState([item('a'), item('b'), item('c')], 'b', true);

    const reordered = [item('c'), item('b'), item('a'), item('d')];
    await casparPlayoutService.refreshQueue!(reordered);

    expect(hooks.getQueuedItems().map((i) => i.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('accepts any queue when nothing is on air', async () => {
    hooks.setState([item('a')], null, false);
    await casparPlayoutService.refreshQueue!([item('x'), item('y')]);
    expect(hooks.getQueuedItems().map((i) => i.id)).toEqual(['x', 'y']);
  });
});

describe('T0-3 · store never pushes an offline playlist to the on-air queue', () => {
  let store: ReturnType<typeof useRundownStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useRundownStore();
  });

  it('syncPlayoutQueue refuses a playlist that is not on air', () => {
    const onAirId = store.playlists[0]!.id;
    const offlineId = store.createPlaylist('Offline B');
    store.playlists[0]!.items = [item('a'), item('b')];
    store.setPlaylistOnAir(onAirId, 0);

    const spy = vi.spyOn(casparPlayoutService, 'refreshQueue' as any).mockResolvedValue(undefined);

    expect(store.syncPlayoutQueue(offlineId)).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    expect(store.syncPlayoutQueue(onAirId)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('syncPlayoutQueue forwards any playlist when nothing is on air', () => {
    const someId = store.createPlaylist('Preview');
    const spy = vi.spyOn(casparPlayoutService, 'refreshQueue' as any).mockResolvedValue(undefined);
    expect(store.onAirPlaylistId).toBeNull();
    expect(store.syncPlayoutQueue(someId)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
