import { describe, it, expect, beforeEach } from 'vitest';
import { createGuardedStorage, persistenceFault, clearPersistenceFault } from '../persistenceStorage';

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
