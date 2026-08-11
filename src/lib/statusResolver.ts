import type { StatusTone } from '../components/StatusIndicator.vue';
import type { RundownItem } from '../stores/rundown';
import type { LibraryAsset } from '../stores/mediaLibrary';

export interface RundownRowContext {
  playing?: boolean;
  nextUp?: boolean;
  nextUpImminent?: boolean;
  atKind?: '' | 'done' | 'now' | 'gap' | 'time';
}

/**
 * Pure status tone resolver for Rundown items with strict priority hierarchy:
 * 1. on-air
 * 2. armed
 * 3. error
 * 4. offline
 * 5. processing
 * 6. warning
 * 7. unsaved-trim
 * 8. ready
 * 9. idle
 */
export function resolveRundownStatusTone(
  item: Partial<RundownItem> | null | undefined,
  ctx?: RundownRowContext
): StatusTone {
  if (!item) return 'idle';

  // 1. On-air
  if (ctx?.playing || ctx?.atKind === 'now') {
    return 'on-air';
  }

  // 2. Armed
  if (ctx?.nextUp || ctx?.nextUpImminent) {
    return 'armed';
  }

  // 3. Error
  if (item.ingestorStatus === 'error') {
    return 'error';
  }

  // 4. Offline
  if (item.ingestorStatus === 'missing' || !item.path) {
    return 'offline';
  }

  // 5. Processing
  if (item.ingestorStatus === 'processing') {
    return 'processing';
  }

  // 6. Warning
  if (item.warnings && item.warnings.length > 0) {
    return 'warning';
  }

  // 7. Unsaved Trim / Local Subclip
  if (item.virtualSubclip && item.persistenceState === 'local-only') {
    return 'unsaved-trim';
  }

  // 8. Ready
  if (item.ingestorStatus === 'ready') {
    return 'ready';
  }

  return 'idle';
}

/**
 * Pure status tone resolver for Media Library assets with strict priority hierarchy:
 * 1. error
 * 2. offline
 * 3. processing
 * 4. warning
 * 5. ready
 * 6. idle
 */
export function resolveLibraryStatusTone(
  asset: Partial<LibraryAsset> | null | undefined
): StatusTone {
  if (!asset) return 'idle';

  if (asset.status === 'error') {
    return 'error';
  }

  if (asset.status === 'missing' || !asset.current_path) {
    return 'offline';
  }

  if (asset.status === 'processing' || asset.probing) {
    return 'processing';
  }

  if (asset.warnings && asset.warnings.length > 0) {
    return 'warning';
  }

  if (asset.status === 'ready') {
    return 'ready';
  }

  return 'idle';
}
