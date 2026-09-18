import { defineAsyncComponent, type AsyncComponentLoader, type Component } from 'vue';

type LoaderResult = Awaited<ReturnType<AsyncComponentLoader>>;
import { recordFrontendFault } from './frontendFaults';

/**
 * PERF F-14: rarely-opened modals (Settings, wizards, pickers, recycle bin)
 * are split out of the startup bundle and fetched on first open.
 *
 * Reliability notes for an on-air client:
 * - the chunk lives next to the app on the local disk, so a failure is a
 *   corrupted install rather than a network blip; we still retry a few times
 *   before surfacing a frontend fault instead of silently rendering nothing;
 * - `preload()` lets the opening button warm the chunk on pointer-enter so
 *   the click itself never waits on I/O;
 * - the wrapper carries the original component `name` so test stubs and
 *   devtools keep addressing it by that name.
 */
export interface LazyComponentHandle {
  component: Component;
  preload: () => Promise<void>;
}

const MAX_ATTEMPTS = 3;

export function lazyComponent(
  name: string,
  loader: AsyncComponentLoader,
): LazyComponentHandle {
  let pending: Promise<LoaderResult> | null = null;

  const load = (): Promise<LoaderResult> => {
    if (pending) return pending;
    const attempt = loader().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    pending = attempt;
    return attempt;
  };

  const component = defineAsyncComponent({
    loader: load,
    onError(error, retry, fail, attempts) {
      if (attempts < MAX_ATTEMPTS) {
        setTimeout(retry, 150 * attempts);
        return;
      }
      recordFrontendFault(
        'lazy-component',
        `Failed to load ${name} after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`,
      );
      fail();
    },
  }) as Component & { name?: string };

  component.name = name;

  return {
    component,
    preload: () => load().then(() => undefined, () => undefined),
  };
}
