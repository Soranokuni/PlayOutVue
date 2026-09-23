import type { ComputedRef, InjectionKey } from 'vue';

/**
 * Progress (0-100) of the on-air row, per progress tone, provided by
 * `RundownList` and read only by the row whose `progressTone` is set.
 *
 * The values change 4-10 times a second. Passing them as row props made the
 * list template read them, so the whole list re-rendered on every playback
 * tick to update one hairline. Read through this key inside the row's
 * `RenderIsland`, only that hairline re-renders.
 */
export interface RundownLiveProgress {
  /** The playing instance: the store's wall-clock progress loop. */
  green: ComputedRef<number>;
  /** The current playing index while playout runs: OSC position / duration. */
  red: ComputedRef<number>;
}

export const RUNDOWN_LIVE_PROGRESS: InjectionKey<RundownLiveProgress> = Symbol('rundown-live-progress');
