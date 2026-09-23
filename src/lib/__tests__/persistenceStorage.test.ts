import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGuardedStorage, createDeferredJsonPersistence, persistenceFault, clearPersistenceFault, flushPersistence } from '../persistenceStorage';

class FakeStorage {
  data = new Map<string, string>();
  failNext: Error | null = null;
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

describe('T1-8 · guarded persistence storage', () => {
  beforeEach(() => clearPersistenceFault());

  it('passes reads and writes through', () => {
    const base = new FakeStorage();
    const storage = createGuardedStorage(base);
    storage.setItem('rundown', '{"a":1}');
    expect(storage.getItem('rundown')).toBe('{"a":1}');
    expect(persistenceFault.value).toBeNull();
  });

  it('surfaces a quota error instead of throwing and clears it on the next success', () => {
    const base = new FakeStorage();
    const storage = createGuardedStorage(base);
    const quota = new Error('quota');
    quota.name = 'QuotaExceededError';
    base.failNext = quota;

    expect(() => storage.setItem('rundown', 'x'.repeat(2048))).not.toThrow();
    expect(persistenceFault.value?.key).toBe('rundown');
    expect(persistenceFault.value?.message).toMatch(/quota exceeded/i);
    expect(persistenceFault.value?.message).toContain('NOT being persisted');

    storage.setItem('rundown', 'ok');
    expect(persistenceFault.value).toBeNull();
  });

  it('reports non-quota failures with their message', () => {
    const base = new FakeStorage();
    const storage = createGuardedStorage(base);
    base.failNext = new Error('disk on fire');
    storage.setItem('settings', 'v');
    expect(persistenceFault.value?.message).toContain('disk on fire');
  });
});

describe('PERF F-08 · debounced guarded storage', () => {
  beforeEach(() => {
    clearPersistenceFault();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst of writes to one setItem and keeps read-your-writes', () => {
    const base = new FakeStorage();
    let writes = 0;
    const origSet = base.setItem.bind(base);
    base.setItem = (k: string, v: string) => { writes += 1; origSet(k, v); };
    const storage = createGuardedStorage(base, { debounceMs: 250 });

    storage.setItem('rundown', '1');
    storage.setItem('rundown', '2');
    storage.setItem('rundown', '3');
    expect(writes).toBe(0);
    expect(storage.getItem('rundown')).toBe('3');
    expect(base.getItem('rundown')).toBeNull();

    vi.advanceTimersByTime(249);
    expect(writes).toBe(0);
    vi.advanceTimersByTime(1);
    expect(writes).toBe(1);
    expect(base.getItem('rundown')).toBe('3');
  });

  it('flush() and flushPersistence() write pending values immediately', () => {
    const base = new FakeStorage();
    const storage = createGuardedStorage(base, { debounceMs: 250 });
    storage.setItem('rundown', 'a');
    storage.flush();
    expect(base.getItem('rundown')).toBe('a');

    storage.setItem('rundown', 'b');
    flushPersistence();
    expect(base.getItem('rundown')).toBe('b');
    vi.advanceTimersByTime(1000);
    expect(base.getItem('rundown')).toBe('b');
  });

  it('still surfaces quota faults from the deferred write', () => {
    const base = new FakeStorage();
    const storage = createGuardedStorage(base, { debounceMs: 100 });
    const quota = new Error('quota');
    quota.name = 'QuotaExceededError';
    base.failNext = quota;
    storage.setItem('rundown', 'x');
    expect(persistenceFault.value).toBeNull();
    vi.advanceTimersByTime(100);
    expect(persistenceFault.value?.key).toBe('rundown');
  });

  it('debounceMs 0 behaves synchronously (default)', () => {
    const base = new FakeStorage();
    const storage = createGuardedStorage(base, { debounceMs: 0 });
    storage.setItem('k', 'v');
    expect(base.getItem('k')).toBe('v');
  });
});

describe('PERF-PLAN PR B · deferred JSON persistence', () => {
  beforeEach(() => {
    clearPersistenceFault();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stringifies once, at flush, the latest state of a burst', () => {
    const base = new FakeStorage();
    const { storage, serializer } = createDeferredJsonPersistence(base, { debounceMs: 250 });
    const stringify = vi.spyOn(JSON, 'stringify');

    for (let i = 1; i <= 20; i++) storage.setItem('rundown', serializer.serialize({ step: i }));
    expect(stringify).not.toHaveBeenCalled();
    expect(base.getItem('rundown')).toBeNull();

    vi.advanceTimersByTime(250);
    expect(stringify).toHaveBeenCalledTimes(1);
    expect(base.getItem('rundown')).toBe('{"step":20}');
    stringify.mockRestore();
  });

  it('reads a pending value back as JSON and round-trips through the serializer', () => {
    const base = new FakeStorage();
    const { storage, serializer } = createDeferredJsonPersistence(base, { debounceMs: 250 });
    storage.setItem('rundown', serializer.serialize({ a: [1, 2] }));
    const raw = storage.getItem('rundown');
    expect(raw).toBe('{"a":[1,2]}');
    expect(serializer.deserialize(raw as string)).toEqual({ a: [1, 2] });
  });

  it('writes synchronously on flushPersistence (pagehide / unload / hidden)', () => {
    const base = new FakeStorage();
    const { storage, serializer } = createDeferredJsonPersistence(base, { debounceMs: 250 });
    storage.setItem('rundown', serializer.serialize({ onAir: true }));
    flushPersistence();
    expect(base.getItem('rundown')).toBe('{"onAir":true}');
  });

  it('reports a state that cannot be serialised instead of throwing from the timer', () => {
    const base = new FakeStorage();
    const { storage, serializer } = createDeferredJsonPersistence(base, { debounceMs: 250 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    storage.setItem('rundown', serializer.serialize(cyclic));
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    expect(persistenceFault.value?.key).toBe('rundown');
    expect(base.getItem('rundown')).toBeNull();
  });

  it('passes a plain string through untouched', () => {
    const base = new FakeStorage();
    const { storage } = createDeferredJsonPersistence(base, { debounceMs: 0 });
    storage.setItem('k', 'v');
    expect(base.getItem('k')).toBe('v');
  });
});
