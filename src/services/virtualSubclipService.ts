import { invoke } from '@tauri-apps/api/core';
import type { RundownItem } from '../stores/rundown';

export interface VirtualSubclipRequestItem {
  id?: string;
  uuid?: string;
  playoutvueId?: string;
  parentAssetUuid?: string;
  path: string;
  filename?: string;
  display_name?: string;
  type?: any;
  duration_ms?: number;
  fps?: number;
  fps_num?: number;
  fps_den?: number;
  complianceRating?: any;
  tp_flag?: boolean;
  content_type?: 'movie' | 'show' | 'documentary' | 'news' | 'none';
}

export interface VirtualSubclipRequest {
  item: VirtualSubclipRequestItem;
  displayName: string;
  trimInMs: number;
  trimOutMs: number;
}

export interface VirtualSubclipResult {
  state: 'persisted' | 'local-only' | 'failed';
  item?: RundownItem;
  error?: string;
}

/**
 * Service to process virtual subclip requests via Tauri IPC/API or local fallback.
 * Does not mutate global Pinia store state directly; returns a typed VirtualSubclipResult.
 */
export async function createVirtualSubclip(
  request: VirtualSubclipRequest
): Promise<VirtualSubclipResult> {
  const { item, displayName, trimInMs, trimOutMs } = request;

  if (!item) {
    return { state: 'failed', error: 'No item specified for sub-clip creation.' };
  }

  if (!item.path) {
    return { state: 'failed', error: 'Source path is missing.' };
  }

  if (trimInMs < 0) {
    return { state: 'failed', error: 'IN point cannot be negative.' };
  }

  if (trimOutMs <= trimInMs) {
    return { state: 'failed', error: 'OUT point must be greater than IN point.' };
  }

  if (typeof item.duration_ms === 'number' && item.duration_ms > 0 && trimOutMs > item.duration_ms) {
    return { state: 'failed', error: 'OUT point exceeds source duration.' };
  }

  const trimmedName = displayName.trim();
  if (!trimmedName) {
    return { state: 'failed', error: 'Display name must not be empty.' };
  }

  const parentAssetUuid = item.parentAssetUuid || item.uuid || item.playoutvueId;
  if (!parentAssetUuid) {
    return {
      state: 'failed',
      error: 'Cannot create subclip because the parent asset identity is missing.'
    };
  }

  const durationMs = Math.max(1, trimOutMs - trimInMs);
  const assetUuid = item.uuid || item.playoutvueId;

  // Persistent Path: Backend Transcoder/DB available with non-local asset UUID.
  // A `local-subclip:` id is a client-only row and has no server counterpart,
  // so it takes the local branch too.
  if (assetUuid && !assetUuid.startsWith('local:') && !assetUuid.startsWith('local-subclip:')) {
    try {
      const response = await invoke<any>('create_ingestor_subclip', {
        uuid: assetUuid,
        display_name: trimmedName,
        trim_in_ms: Math.round(trimInMs),
        trim_out_ms: Math.round(trimOutMs),
        api_base_url_override: null
      });

      // Audit E-7 / F-8: the sub-clip row used to be built entirely from the
      // values the client had *asked* for, and the server's response was read
      // only for `uuid` and `current_path`. That threw away the four things
      // that make a virtual sub-clip correct:
      //
      //   - `trim_in_ms` / `trim_out_ms`: `POST /subclip` snaps the IN point to
      //     a keyframe and returns where it actually landed. Ignoring that left
      //     the rundown computing a SEEK and a LENGTH from numbers the server
      //     had already overruled;
      //   - `keyframe_safe_start_ms` and the frame geometry, without which the
      //     trim panel cannot re-trim this row;
      //   - `warnings`, which is how the server says *that* it snapped, or that
      //     the requested window was adjusted;
      //   - `duration_ms`, which for a virtual sub-clip is the PHYSICAL file's
      //     duration (the sub-clip shares its parent's file). Writing the
      //     trimmed length there made the row disagree with the same sub-clip
      //     added from the library, and made a later re-trim clamp against a
      //     duration that was not the file's.
      //
      // Everything the server asserts is now adopted verbatim; the requested
      // values are only a fallback for fields it did not answer with.
      const serverTrimIn = typeof response?.trim_in_ms === 'number'
        ? Math.max(0, response.trim_in_ms)
        : Math.round(trimInMs);
      const serverTrimOutRaw = typeof response?.trim_out_ms === 'number' ? response.trim_out_ms : 0;
      const serverTrimOut = serverTrimOutRaw > serverTrimIn
        ? serverTrimOutRaw
        : Math.round(trimOutMs);
      const effectiveMs = Math.max(1, serverTrimOut - serverTrimIn);
      // The physical file behind the sub-clip, not the trimmed range.
      const fileDurationMs = typeof response?.duration_ms === 'number' && response.duration_ms > 0
        ? response.duration_ms
        : (item.duration_ms || serverTrimOut);

      const warnings: string[] = Array.isArray(response?.warnings) ? response.warnings : [];
      const isReady = response?.status === 'ready';

      const subclipItem: RundownItem = {
        id: crypto.randomUUID(),
        playoutvueId: response?.uuid || `subclip-${crypto.randomUUID()}`,
        parentAssetUuid,
        display_name: response?.display_name || trimmedName,
        filename: response?.display_name || trimmedName,
        path: response?.current_path || item.path,
        displayPath: response?.current_path || item.path,
        current_path: response?.current_path || item.path,
        virtual_folder: response?.virtual_folder || '',
        shortPath: trimmedName,
        libraryIndicator: 'none',
        duration: effectiveMs / 1000,
        duration_ms: fileDurationMs,
        seek: serverTrimIn / 1000,
        length: effectiveMs / 1000,
        inPoint: serverTrimIn,
        outPoint: serverTrimOut,
        plannedDuration: effectiveMs / 1000,
        type: item.type || 'video',
        trim_in_ms: serverTrimIn,
        trim_out_ms: serverTrimOut,
        fps: response?.fps ?? item.fps,
        fps_num: response?.fps_num ?? item.fps_num,
        fps_den: response?.fps_den ?? item.fps_den,
        mezzanine_ok: response?.mezzanine_ok,
        total_frames: response?.total_frames,
        gop_frames: response?.gop_frames,
        keyframe_safe_start_ms: response?.keyframe_safe_start_ms,
        warnings,
        complianceRating: item.complianceRating || 'none',
        complianceDescriptors: [],
        complianceText: '',
        ingestorStatus: isReady ? 'ready' : (response?.status === 'error' ? 'error' : 'processing'),
        tp_flag: item.tp_flag,
        content_type: item.content_type,
        note: '',
        virtualSubclip: true,
        persistenceState: 'persisted'
      };

      return { state: 'persisted', item: subclipItem };
    } catch (err) {
      // Return typed failure without falling back silently if backend IPC was expected
      return {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // Local Fallback Path: Client-only local subclip for development or local assets
  const localSubclipItem: RundownItem = {
    id: crypto.randomUUID(),
    playoutvueId: `local-subclip:${crypto.randomUUID()}`,
    parentAssetUuid,
    display_name: trimmedName,
    filename: trimmedName,
    path: item.path,
    displayPath: item.path,
    shortPath: trimmedName,
    libraryIndicator: 'none',
    duration: durationMs / 1000,
    // The physical file, not the trimmed range: a virtual sub-clip shares its
    // parent's file, and the trim panel re-trims against the whole of it.
    duration_ms: item.duration_ms && item.duration_ms > 0 ? item.duration_ms : trimOutMs,
    seek: trimInMs / 1000,
    length: durationMs / 1000,
    // `inPoint`/`outPoint` are milliseconds everywhere else in the rundown
    // (`makeItem`, `updateItem`, `totalDuration`). This branch wrote seconds,
    // so a local sub-clip came back with an IN point 1000x too small and a
    // planned duration that did not match its own trims.
    inPoint: Math.round(trimInMs),
    outPoint: Math.round(trimOutMs),
    plannedDuration: durationMs / 1000,
    type: item.type || 'video',
    trim_in_ms: Math.round(trimInMs),
    trim_out_ms: Math.round(trimOutMs),
    fps: item.fps,
    fps_num: item.fps_num,
    fps_den: item.fps_den,
    complianceRating: item.complianceRating || 'none',
    complianceDescriptors: [],
    complianceText: '',
    ingestorStatus: 'idle',
    tp_flag: item.tp_flag,
    content_type: item.content_type,
    note: '',
    virtualSubclip: true,
    persistenceState: 'local-only'
  };

  return { state: 'local-only', item: localSubclipItem };
}
