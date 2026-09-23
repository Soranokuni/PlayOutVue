import { ref } from 'vue';
import type { Serializer, StorageLike } from 'pinia-plugin-persistedstate';

/**
 * Audit T1-8: pinia-plugin-persistedstate swallows `setItem` failures unless
 * `debug` is on, so once the ~5 MB localStorage quota is hit every later
 * change is silently lost and the next launch restores a stale rundown.
 *
 * This wrapper surfaces the fault reactively (for an operator banner) and to
 * the console/diagnostics, while never throwing into the store mutation path.
 *
 * PERF F-08: `localStorage.setItem` is synchronous on the main thread and the
 * rundown store serialises every playlist on every structural mutation. With
 * `debounceMs > 0` writes are coalesced per key (trailing edge) and flushed
 * on `pagehide` / `beforeunload` / tab-hidden, so a burst of mutations (drag,
 * multi-delete, paste) costs one serialisation instead of one per step.
 * Reads see pending writes (read-your-writes), and the fault banner path is
 * unchanged. The default stays synchronous; callers opt in per store.
 */
export interface PersistenceFault {
  key: string;
  message: string;
  at: number;
}

export interface GuardedStorageOptions {
  /** Trailing debounce for writes, in ms. `0` (default) writes synchronously. */
  debounceMs?: number;
}

export interface GuardedStorage extends StorageLike {
  /** Write every pending value now. Safe to call at any time. */
  flush(): void;
  /**
   * Queue a value that is produced only when it is written (debounce end,
   * flush, or a read of the pending key). Without a debounce it is produced
   * and written at once.
   */
  setItemLazy(key: string, produce: () => string): void;
}

export const persistenceFault = ref<PersistenceFault | null>(null);

export function clearPersistenceFault(): void {
  persistenceFault.value = null;
}

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; code?: number };
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014;
}

const flushables = new Set<() => void>();
let lifecycleHooksInstalled = false;

function flushAll(): void {
  flushables.forEach((flush) => flush());
}

function installLifecycleHooks(): void {
  if (lifecycleHooksInstalled || typeof window === 'undefined') return;
  lifecycleHooksInstalled = true;
  window.addEventListener('pagehide', flushAll);
  window.addEventListener('beforeunload', flushAll);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAll();
    });
  }
}

/** Flush every debounced guarded storage created so far. */
export function flushPersistence(): void {
  flushAll();
}

export function createGuardedStorage(base?: StorageLike, options: GuardedStorageOptions = {}): GuardedStorage {
  const debounceMs = Math.max(0, options.debounceMs ?? 0);

  const resolveBase = (): StorageLike | null => {
    if (base) return base;
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      return null;
    }
  };

  const writeNow = (key: string, value: string): void => {
    const storage = resolveBase();
    if (!storage) return;
    try {
      storage.setItem(key, value);
      if (persistenceFault.value?.key === key) persistenceFault.value = null;
    } catch (error) {
      const message = isQuotaError(error)
        ? `Local storage quota exceeded while saving "${key}" (${Math.round(value.length / 1024)} KB). Changes are NOT being persisted.`
        : `Failed to persist "${key}": ${error instanceof Error ? error.message : String(error)}`;
      persistenceFault.value = { key, message, at: Date.now() };
      console.error('[Persistence]', message);
    }
  };

  const pending = new Map<string, string | (() => string)>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Produce a lazy value; a failure is reported like a failed write. */
  const resolveValue = (key: string, value: string | (() => string)): string | null => {
    if (typeof value === 'string') return value;
    try {
      return value();
    } catch (error) {
      const message = `Failed to serialise "${key}": ${error instanceof Error ? error.message : String(error)}`;
      persistenceFault.value = { key, message, at: Date.now() };
      console.error('[Persistence]', message);
      return null;
    }
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const batch = Array.from(pending.entries());
    pending.clear();
    for (const [key, value] of batch) {
      const resolved = resolveValue(key, value);
      if (resolved !== null) writeNow(key, resolved);
    }
  };

  const queue = (key: string, value: string | (() => string)): void => {
    pending.set(key, value);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  if (debounceMs > 0) {
    flushables.add(flush);
    installLifecycleHooks();
  }

  return {
    getItem(key: string): string | null {
      const queued = pending.get(key);
      if (queued !== undefined) return resolveValue(key, queued);
      try {
        return resolveBase()?.getItem(key) ?? null;
      } catch (error) {
        console.error('[Persistence] getItem failed', key, error);
        return null;
      }
    },
    setItem(key: string, value: string): void {
      if (debounceMs === 0) {
        writeNow(key, value);
        return;
      }
      queue(key, value);
    },
    setItemLazy(key: string, produce: () => string): void {
      if (debounceMs === 0) {
        const resolved = resolveValue(key, produce);
        if (resolved !== null) writeNow(key, resolved);
        return;
      }
      queue(key, produce);
    },
    flush,
  };
}

const DEFERRED_JSON = '\u0000deferred-json';

/**
 * PERF-PLAN PR B: a debounced storage whose JSON is built when it is written.
 *
 * pinia-plugin-persistedstate serialises the picked state on every store
 * change and only then hands the string to `setItem`, so a debounced storage
 * still paid a full `JSON.stringify` of every playlist per change (a
 * selection move, an arrow key held down). This pair defers it: the
 * serializer only remembers the state it was given and returns a token, and
 * the storage turns the token into a lazy write of the latest state. A burst
 * of changes costs one stringify, at flush time, of the newest state; the
 * pagehide / unload / hidden flush still writes it synchronously.
 *
 * Use one pair per store key.
 */
export function createDeferredJsonPersistence(
  base?: StorageLike,
  options: GuardedStorageOptions = {}
): { storage: GuardedStorage; serializer: Serializer } {
  const guarded = createGuardedStorage(base, options);
  let latest: unknown;
  return {
    serializer: {
      serialize: (value) => {
        latest = value;
        return DEFERRED_JSON;
      },
      deserialize: (raw) => JSON.parse(raw)
    },
    storage: {
      getItem: (key) => guarded.getItem(key),
      setItem: (key, value) => {
        if (value === DEFERRED_JSON) guarded.setItemLazy(key, () => JSON.stringify(latest));
        else guarded.setItem(key, value);
      },
      setItemLazy: (key, produce) => guarded.setItemLazy(key, produce),
      flush: () => guarded.flush()
    }
  };
}
