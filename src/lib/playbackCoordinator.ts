/**
 * Pure TypeScript PlaybackCoordinator Reducer Module.
 * Independent of Vue reactivity and Tauri IPC dependencies.
 *
 * Implements identity-led playback authority (immutable UUIDs), dual-ID fencing
 * (takeId + playbackInstanceId), generation bumping, cancellation tokens, and
 * conditional automatic advance logic.
 */

import { v4 as uuidv4 } from 'uuid';

export type PlaybackSource = 'manual' | 'auto' | 'recovery';

export type PlaybackMode =
  | 'idle'
  | 'preparing'
  | 'armed'
  | 'taking'
  | 'playing'
  | 'paused'
  | 'recovering'
  | 'failed'
  | 'stopped';

export type TakeRequest = {
  targetItemId: string;
  rundownRevision: number;
  source: PlaybackSource;
  expectedGeneration?: number;
};

export type PlaybackIntent = {
  takeId: string;
  playGeneration: number;
  targetItemId: string;
  rundownRevisionAtIntent: number;
  source: PlaybackSource;
  createdAtEpochMs: number;
};

export type ConfirmedPlayback = PlaybackIntent & {
  playbackInstanceId: string;
  confirmedAtEpochMs: number;
  channel: number;
  layer: number;
};

export type PlaybackCommand = {
  takeId: string;
  generation: number;
  targetItemId: string;
  targetIndexAtDispatch: number;
  rundownRevision: number;
  source: PlaybackSource;
};

export type RundownItemRef = {
  id: string;
  enabled?: boolean;
  ingestorStatus?: string;
  isMarker?: boolean;
};

export class PlaybackCoordinator {
  public playGeneration = 0;
  public rundownRevision = 0;
  public selectedItemId: string | null = null;
  public onAirItemId: string | null = null;
  public armedItemId: string | null = null;
  public autoCandidateItemId: string | null = null;
  public mode: PlaybackMode = 'idle';

  public activeIntent: PlaybackIntent | null = null;
  public confirmedPlayback: ConfirmedPlayback | null = null;

  private activeAbortController: AbortController | null = null;

  constructor(initialRevision = 0) {
    this.rundownRevision = initialRevision;
  }

  public setRundownRevision(revision: number): void {
    const changed = this.rundownRevision !== revision;
    this.rundownRevision = revision;
    if (changed && this.armedItemId !== null) {
      this.invalidateArming('rundown revision changed');
    }
  }

  public setSelectedItem(itemId: string | null): void {
    this.selectedItemId = itemId;
  }

  /**
   * Synchronously initiate a take.
   * Increments playGeneration, generates a unique takeId, cancels any pending async operations,
   * resolves the target item strictly by UUID, and transitions mode to 'taking'.
   */
    public initiateTake(
    request: TakeRequest,
    currentRundownItems: RundownItemRef[]
  ): { intent: PlaybackIntent; command: PlaybackCommand; abortSignal: AbortSignal } | null {
    // Resolve item strictly by immutable UUID
    const targetIdx = currentRundownItems.findIndex((i) => i.id === request.targetItemId);
    if (targetIdx < 0) {
      return null; // Target UUID not found in current rundown
    }

    const item = currentRundownItems[targetIdx];
    if (!item || item.enabled === false || item.ingestorStatus === 'error' || item.isMarker === true) {
      return null; // Item disabled, corrupt, or non-playout marker
    }

    // Cancel prior generation tasks
    if (this.activeAbortController) {
      this.activeAbortController.abort('Superseded by new take intent');
    }
    this.activeAbortController = new AbortController();

    // Increment monotonic playGeneration & generate unique takeId
    this.playGeneration += 1;
    const takeId = uuidv4();
    const now = Date.now();

    const intent: PlaybackIntent = {
      takeId,
      playGeneration: this.playGeneration,
      targetItemId: request.targetItemId,
      rundownRevisionAtIntent: request.rundownRevision,
      source: request.source,
      createdAtEpochMs: now,
    };

    const command: PlaybackCommand = {
      takeId,
      generation: this.playGeneration,
      targetItemId: request.targetItemId,
      targetIndexAtDispatch: targetIdx, // Diagnostic metadata ONLY
      rundownRevision: request.rundownRevision,
      source: request.source,
    };

    this.activeIntent = intent;
    this.mode = 'taking';
    this.armedItemId = null; // Clear preloaded item on manual/auto take

    return {
      intent,
      command,
      abortSignal: this.activeAbortController.signal,
    };
  }

  /**
   * Confirm an AMCP PLAY response for a specific takeId and generation.
   * If stale (takeId or generation does not match current active intent), returns null.
   */
  public confirmTake(
    takeId: string,
    generation: number,
    confirmedChannel: number,
    confirmedLayer: number,
    currentRundownItems: RundownItemRef[]
  ): ConfirmedPlayback | null {
    if (!this.activeIntent) return null;
    if (this.activeIntent.takeId !== takeId || this.playGeneration !== generation) {
      return null; // Stale ACK rejected
    }

    const playbackInstanceId = uuidv4();
    const now = Date.now();

    const confirmed: ConfirmedPlayback = {
      ...this.activeIntent,
      playbackInstanceId,
      confirmedAtEpochMs: now,
      channel: confirmedChannel,
      layer: confirmedLayer,
    };

    this.confirmedPlayback = confirmed;
    this.onAirItemId = confirmed.targetItemId;
    this.mode = 'playing';

    // Pre-calculate next eligible auto candidate by UUID
    this.autoCandidateItemId = this.nextEligibleItemId(this.onAirItemId, currentRundownItems);

    return confirmed;
  }

  /**
   * Find the next playable UUID from the rundown, skipping disabled, failed, or marker items.
   */
  public nextEligibleItemId(currentOnAirId: string | null, items: RundownItemRef[]): string | null {
    if (!currentOnAirId || items.length === 0) return null;

    const currentIdx = items.findIndex((i) => i.id === currentOnAirId);
    if (currentIdx < 0) return null;

    for (let i = currentIdx + 1; i < items.length; i++) {
      const candidate = items[i];
      if (candidate && candidate.enabled !== false && candidate.ingestorStatus !== 'error' && candidate.isMarker !== true) {
        return candidate.id;
      }
    }

    return null;
  }

  /**
   * Evaluate whether an incoming EOF or tick event should trigger an automatic advance.
   * Returns target UUID to auto-take if valid, or null if event is stale or unverified.
   */
  public evaluateAutoAdvance(
    event: {
      generation: number;
      takeId?: string;
      playbackInstanceId: string;
      itemId: string;
    },
    currentRundownItems: RundownItemRef[]
  ): string | null {
    if (
      event.generation === this.playGeneration &&
      this.confirmedPlayback !== null &&
      event.playbackInstanceId === this.confirmedPlayback.playbackInstanceId &&
      event.itemId === this.onAirItemId &&
      this.mode === 'playing'
    ) {
      return this.nextEligibleItemId(this.onAirItemId, currentRundownItems);
    }

    return null; // Stale or invalid auto-advance event rejected
  }

  /**
   * Arm next item following successful LOADBG confirmation.
   */
  public armNextItem(itemId: string, generation: number): boolean {
    if (generation === this.playGeneration && this.mode === 'playing') {
      this.armedItemId = itemId;
      return true;
    }
    return false;
  }

  /**
   * Invalidate armed item state (e.g. trim edit, rundown reorder, path change).
   */
  public invalidateArming(reason: string): void {
    this.armedItemId = null;
  }

  /**
   * Emergency stop or manual stop.
   */
  public stop(reason: string): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort(`Stopped: ${reason}`);
      this.activeAbortController = null;
    }
    this.playGeneration += 1;
    this.activeIntent = null;
    this.confirmedPlayback = null;
    this.onAirItemId = null;
    this.armedItemId = null;
    this.autoCandidateItemId = null;
    this.mode = 'stopped';
  }
}
