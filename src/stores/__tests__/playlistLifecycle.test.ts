// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRundownStore } from '../rundown';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));

/**
 * Round 3 §5.2 — closing a playlist has to be undoable.
 *
 * `closePlaylist` returned a bare `true`, which left the caller holding
 * nothing to put back: the only way to recover a closed playlist was to build
 * it again by hand. It now returns the record it removed and the index it came
 * from, and `restorePlaylist` puts that pair back where it was — so the tab
 * strip after an Undo looks exactly as it did before, rather than growing a
 * new tab on the end.
 */
describe('Round 3 §5.2 · Playlist close and restore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('returns the removed record and its index', () => {
    const store = useRundownStore();
    store.createPlaylist('Second');
    store.createPlaylist('Third');
    const targetId = store.playlists[1]!.id;

    const removed = store.closePlaylist(targetId);

    expect(removed).not.toBeNull();
    expect(removed!.index).toBe(1);
    expect(removed!.playlist.id).toBe(targetId);
    expect(store.playlists.map((p) => p.id)).not.toContain(targetId);
  });

  it('refuses the last playlist and the on-air playlist', () => {
    const store = useRundownStore();
    expect(store.closePlaylist(store.activePlaylistId)).toBeNull();

    store.createPlaylist('Second');
    const onAirId = store.playlists[0]!.id;
    store.onAirPlaylistId = onAirId;
    expect(store.closePlaylist(onAirId)).toBeNull();
    expect(store.playlists).toHaveLength(2);
  });

  it('puts a closed playlist back at the same index and activates it', () => {
    const store = useRundownStore();
    store.createPlaylist('Second');
    store.createPlaylist('Third');
    const targetId = store.playlists[1]!.id;

    const removed = store.closePlaylist(targetId)!;
    expect(store.activePlaylistId).not.toBe(targetId);

    expect(store.restorePlaylist(removed.playlist, removed.index)).toBe(true);

    expect(store.playlists.map((p) => p.id)[1]).toBe(targetId);
    expect(store.playlists).toHaveLength(3);
    expect(store.activePlaylistId).toBe(targetId);
  });

  it('keeps the items that were on the restored playlist', () => {
    const store = useRundownStore();
    store.createPlaylist('Second');
    store.addItem({ name: 'Clip 1', type: 'video', path: '/media/1.mp4', duration: 10 });
    const targetId = store.activePlaylistId;
    expect(store.activeItems).toHaveLength(1);

    const removed = store.closePlaylist(targetId)!;
    store.restorePlaylist(removed.playlist, removed.index);

    expect(store.activePlaylistId).toBe(targetId);
    expect(store.activeItems.map((i) => i.name)).toEqual(['Clip 1']);
  });

  it('will not restore a playlist that is already back', () => {
    const store = useRundownStore();
    store.createPlaylist('Second');
    const targetId = store.activePlaylistId;

    const removed = store.closePlaylist(targetId)!;
    expect(store.restorePlaylist(removed.playlist, removed.index)).toBe(true);
    expect(store.restorePlaylist(removed.playlist, removed.index)).toBe(false);
    expect(store.playlists).toHaveLength(2);
  });
});
