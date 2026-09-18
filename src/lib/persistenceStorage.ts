import { ref } from 'vue';
import type { StorageLike } from 'pinia-plugin-persistedstate';

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

  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const batch = Array.from(pending.entries());
    pending.clear();
    for (const [key, value] of batch) writeNow(key, value);
  };

  if (debounceMs > 0) {
    flushables.add(flush);
    installLifecycleHooks();
  }

  return {
    getItem(key: string): string | null {
      const queued = pending.get(key);
      if (queued !== undefined) return queued;
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
      pending.set(key, value);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    flush,
  };
}
