import { ref } from 'vue';
import type { StorageLike } from 'pinia-plugin-persistedstate';

/**
 * Audit T1-8: pinia-plugin-persistedstate swallows `setItem` failures unless
 * `debug` is on, so once the ~5 MB localStorage quota is hit every later
 * change is silently lost and the next launch restores a stale rundown.
 *
 * This wrapper surfaces the fault reactively (for an operator banner) and to
 * the console/diagnostics, while never throwing into the store mutation path.
 */
export interface PersistenceFault {
  key: string;
  message: string;
  at: number;
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

export function createGuardedStorage(base?: StorageLike): StorageLike {
  const resolveBase = (): StorageLike | null => {
    if (base) return base;
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      return null;
    }
  };

  return {
    getItem(key: string): string | null {
      try {
        return resolveBase()?.getItem(key) ?? null;
      } catch (error) {
        console.error('[Persistence] getItem failed', key, error);
        return null;
      }
    },
    setItem(key: string, value: string): void {
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
    },
  };
}
