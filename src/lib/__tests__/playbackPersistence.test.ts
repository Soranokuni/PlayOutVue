import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  savePlaybackState,
  loadPlaybackState,
  clearPlaybackState,
  __resetPlaybackPersistenceCache,
} from '../playbackPersistence';

class FakeStorage {
  data = new Map<string, string>();
  setCalls = 0;
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.setCalls += 1;
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }
  clear() {
    this.data.clear();
  }
}

const SNAPSHOT_KEY = 'playout_playbackSnapshot';

describe('PERF F-09 · single-key playback snapshot', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
    vi.stubGlobal('localStorage', storage);
    __resetPlaybackPersistenceCache();
  });

  it('writes exactly one key per save and round-trips every field', () => {
    savePlaybackState('uuid-1', 1000, 60_000, {
      itemId: 'item-1',
      playlistId: 'pl-1',
      path: 'C:/media/clip.mxf',
      trimInMs: 250,
      trimOutMs: 50_000,
      positionMs: 1234,
      updatedAt: 2000,
      paused: true,
      channelOutputRateHz: 50,
    });

    expect(storage.setCalls).toBe(1);
    expect(Array.from(storage.data.keys())).toEqual([SNAPSHOT_KEY]);

    __resetPlaybackPersistenceCache();
    expect(loadPlaybackState()).toEqual({
      version: 2,
      uuid: 'uuid-1',
      startTimestamp: 1000,
      durationMs: 60_000,
      itemId: 'item-1',
      playlistId: 'pl-1',
      path: 'C:/media/clip.mxf',
      trimInMs: 250,
      trimOutMs: 50_000,
      positionMs: 1234,
      updatedAt: 2000,
      paused: true,
      channelOutputRateHz: 50,
    });
  });

  it('keeps previously saved extras when a later save omits them (legacy merge semantics)', () => {
    savePlaybackState('uuid-1', 1000, 60_000, { itemId: 'item-1', path: 'C:/a.mxf', paused: false });
    savePlaybackState('uuid-1', 1000, 60_000, { positionMs: 5000, updatedAt: 6000 });

    const state = loadPlaybackState();
    expect(state?.itemId).toBe('item-1');
    expect(state?.path).toBe('C:/a.mxf');
    expect(state?.positionMs).toBe(5000);
    expect(state?.updatedAt).toBe(6000);
    expect(state?.paused).toBe(false);
  });

  it('defaults positionMs/updatedAt/paused the same way the per-key layout did', () => {
    savePlaybackState('uuid-2', 4242, 10_000);
    __resetPlaybackPersistenceCache();
    const state = loadPlaybackState();
    expect(state?.positionMs).toBe(0);
    expect(state?.updatedAt).toBe(4242);
    expect(state?.paused).toBe(false);
    expect(state?.channelOutputRateHz).toBeUndefined();
  });

  it('migrates a legacy per-key snapshot into the blob and removes the old keys', () => {
    storage.data.set('playout_activePlayingUuid', 'legacy-uuid');
    storage.data.set('playout_playbackStartTimestamp', '111');
    storage.data.set('playout_playbackDurationMs', '222');
    storage.data.set('playout_resumeItemId', 'legacy-item');
    storage.data.set('playout_resumePath', 'D:/legacy.mxf');
    storage.data.set('playout_resumeTrimInMs', '5');
    storage.data.set('playout_resumePositionMs', '77');
    storage.data.set('playout_resumePaused', 'true');
    storage.data.set('playout_resumeChannelOutputRateHz', '25');
    storage.data.set('playout_playbackSnapshotVersion', '2');

    const state = loadPlaybackState();
    expect(state).toMatchObject({
      uuid: 'legacy-uuid',
      startTimestamp: 111,
      durationMs: 222,
      itemId: 'legacy-item',
      path: 'D:/legacy.mxf',
      trimInMs: 5,
      positionMs: 77,
      paused: true,
      channelOutputRateHz: 25,
      version: 2,
    });
    expect(storage.data.has(SNAPSHOT_KEY)).toBe(true);
    expect(storage.data.has('playout_activePlayingUuid')).toBe(false);
    expect(storage.data.has('playout_resumePath')).toBe(false);
  });

  it('clear removes the blob and any legacy keys', () => {
    storage.data.set('playout_activePlayingUuid', 'x');
    savePlaybackState('uuid-3', 1, 2);
    clearPlaybackState();
    expect(storage.data.size).toBe(0);
    expect(loadPlaybackState()).toBeNull();
  });

  it('ignores a corrupt blob instead of throwing', () => {
    storage.data.set(SNAPSHOT_KEY, '{not json');
    expect(loadPlaybackState()).toBeNull();
    storage.data.set(SNAPSHOT_KEY, JSON.stringify({ uuid: '', startTimestamp: 1, durationMs: 2 }));
    __resetPlaybackPersistenceCache();
    expect(loadPlaybackState()).toBeNull();
  });
});
