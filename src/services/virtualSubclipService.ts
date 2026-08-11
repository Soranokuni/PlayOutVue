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

  // Persistent Path: Backend Transcoder/DB available with non-local asset UUID
  if (assetUuid && !assetUuid.startsWith('local:')) {
    try {
      const response = await invoke<any>('create_ingestor_subclip', {
        uuid: assetUuid,
        display_name: trimmedName,
        trim_in_ms: Math.round(trimInMs),
        trim_out_ms: Math.round(trimOutMs),
        api_base_url_override: null
      });

      const isReady = response?.status === 'ready' || response?.mezzanine_ok === true;

      const subclipItem: RundownItem = {
        id: crypto.randomUUID(),
        playoutvueId: response?.uuid || `subclip-${crypto.randomUUID()}`,
        parentAssetUuid,
        display_name: trimmedName,
        filename: trimmedName,
        path: response?.current_path || item.path,
        displayPath: response?.current_path || item.path,
        shortPath: trimmedName,
        libraryIndicator: 'none',
        duration: durationMs / 1000,
        duration_ms: durationMs,
        seek: trimInMs / 1000,
        length: durationMs / 1000,
        inPoint: trimInMs / 1000,
        outPoint: trimOutMs / 1000,
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
        ingestorStatus: isReady ? 'ready' : 'processing',
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
    duration_ms: durationMs,
    seek: trimInMs / 1000,
    length: durationMs / 1000,
    inPoint: trimInMs / 1000,
    outPoint: trimOutMs / 1000,
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
