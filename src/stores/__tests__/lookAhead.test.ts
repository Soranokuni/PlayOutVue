import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { issueLabel, mergeIssues, selectLookAheadRows, type LookAheadCandidate } from '../../lib/lookAhead';
import { resetAdvertisedMediaRoot, setAdvertisedMediaRoot } from '../../lib/mediaRootContext';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const UUID = '0b9f6a3e-6f0c-4c1e-9a55-1f2d3c4b5a69';

function clip(id: string, over: Partial<LookAheadCandidate> = {}): LookAheadCandidate {
  return { id, type: 'video', path: `D:/Mezz/videos/${id}.mp4`, playoutvueId: UUID, ingestorStatus: 'ready', ...over };
}

describe('look-ahead row selection', () => {
  const items = [clip('a'), clip('b'), { id: 'gap', type: 'gap' }, clip('c'), clip('d', { ingestorStatus: 'error' }), clip('e'), clip('f')];
  const starts = [NOW, NOW + 5 * MIN, NOW + 10 * MIN, NOW + 10 * MIN, NOW + 15 * MIN, NOW + 20 * MIN, NOW + 40 * MIN];

  it('takes the next clip rows after the on-air one, within the window', () => {
    const rows = selectLookAheadRows(items, starts, 0, NOW, 5, 30, true);
    expect(rows.map((r) => r.id)).toEqual(['b', 'c', 'e']);
    expect(rows[1]!.startsAtMs).toBe(NOW + 10 * MIN);
  });

  it('stops at the row limit', () => {
    expect(selectLookAheadRows(items, starts, -1, NOW, 2, 120, true).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('checks only local rows while the transcoder root is unknown', () => {
    const mixed = [clip('reg'), clip('loc', { playoutvueId: 'local:abc', path: 'C:/clips/loc.mov' })];
    expect(selectLookAheadRows(mixed, [NOW, NOW], -1, NOW, 5, 30, false).map((r) => r.id)).toEqual(['loc']);
  });
});

describe('issue merging', () => {
  const rows = [
    { id: 'b', path: 'x', playoutvueId: UUID, startsAtMs: NOW + 5 * MIN },
    { id: 'c', path: 'y', playoutvueId: UUID, startsAtMs: NOW + 10 * MIN },
  ];

  it('adds failures, drops fixed rows and keeps unchecked ones', () => {
    const first = mergeIssues({}, rows, [
      { id: 'b', checked: true, ok: false, reason: 'missing', localPath: null },
      { id: 'c', checked: true, ok: true, reason: null, localPath: null },
    ], NOW);
    expect(Object.keys(first)).toEqual(['b']);
    expect(first.b!.startsAtMs).toBe(NOW + 5 * MIN);

    const second = mergeIssues(first, rows, [
      { id: 'b', checked: false, ok: true, reason: null, localPath: null },
      { id: 'c', checked: true, ok: false, reason: 'short', localPath: null },
    ], NOW + 30_000);
    expect(second.b).toEqual(first.b);
    expect(second.c!.seenAtMs).toBe(NOW + 30_000);

    const third = mergeIssues(second, rows, [
      { id: 'b', checked: true, ok: true, reason: null, localPath: null },
    ], NOW + 60_000);
    expect(third).toEqual({});
  });

  it('labels the issue with the local clock time of the cut', () => {
    const at = new Date(2026, 9, 16, 14, 32, 10).getTime();
    expect(issueLabel({ reason: 'x', startsAtMs: at, seenAtMs: at })).toBe('will fail at 14:32');
  });
});

describe('look-ahead store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    invokeMock.mockReset();
    resetAdvertisedMediaRoot();
  });

  it('sends the due rows to the Rust pre-flight and records the problems', async () => {
    const { useRundownStore } = await import('../rundown');
    const { useSettingsStore } = await import('../settings');
    const { useLookAheadStore } = await import('../lookAhead');
    const rundown = useRundownStore();
    useSettingsStore().updateSettings({ localMediaPath: 'E:/Mezz', lookAheadRows: 5, lookAheadMinutes: 30 });
    setAdvertisedMediaRoot('D:/Mezz');
    const items = [clip('a'), clip('b')];
    vi.spyOn(rundown, 'activeItems', 'get').mockReturnValue(items as any);
    vi.spyOn(rundown, 'activeItemsETAs', 'get').mockReturnValue([{ epochMs: NOW }, { epochMs: NOW + 5 * MIN }] as any);
    invokeMock.mockResolvedValueOnce([
      { id: 'a', checked: true, ok: true, reason: null, localPath: null },
      { id: 'b', checked: true, ok: false, reason: 'missing', localPath: null },
    ]);
    const store = useLookAheadStore();
    await store.run(NOW);
    expect(invokeMock).toHaveBeenCalledWith('preflight_rows', {
      rows: [
        { id: 'a', path: 'D:/Mezz/videos/a.mp4', playoutvueId: UUID },
        { id: 'b', path: 'D:/Mezz/videos/b.mp4', playoutvueId: UUID },
      ],
      mediaRoot: 'E:/Mezz',
      advertisedRoot: 'D:/Mezz',
    });
    expect(store.issueFor('b')?.reason).toBe('missing');
    expect(store.issueFor('a')).toBeNull();
  });

  it('keeps the last issues when the pre-flight itself fails', async () => {
    const { useRundownStore } = await import('../rundown');
    const { useLookAheadStore } = await import('../lookAhead');
    const rundown = useRundownStore();
    setAdvertisedMediaRoot('D:/Mezz');
    vi.spyOn(rundown, 'activeItems', 'get').mockReturnValue([clip('a')] as any);
    vi.spyOn(rundown, 'activeItemsETAs', 'get').mockReturnValue([{ epochMs: NOW }] as any);
    const store = useLookAheadStore();
    store.issues = { a: { reason: 'missing', startsAtMs: NOW, seenAtMs: NOW } };
    invokeMock.mockRejectedValueOnce(new Error('Pre-flight did not finish within 10 s'));
    await store.run(NOW);
    expect(store.issueFor('a')?.reason).toBe('missing');
    expect(store.lastError).toMatch(/did not finish/);
  });

  it('Skip flags the row error and Hold makes it not ready', async () => {
    const { useRundownStore } = await import('../rundown');
    const { useLookAheadStore } = await import('../lookAhead');
    const rundown = useRundownStore();
    const update = vi.spyOn(rundown, 'updateItem').mockImplementation(() => {});
    const store = useLookAheadStore();
    store.skip('b');
    store.hold('c');
    expect(update).toHaveBeenCalledWith('b', { ingestorStatus: 'error' });
    expect(update).toHaveBeenCalledWith('c', { ingestorStatus: 'missing' });
  });
});
