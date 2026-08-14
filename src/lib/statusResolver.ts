import type { StatusTone } from '../components/StatusIndicator.vue';
import type { RundownItem } from '../stores/rundown';
import type { LibraryAsset } from '../stores/mediaLibrary';

export interface RundownRowContext {
  playing?: boolean;
  nextUp?: boolean;
  nextUpImminent?: boolean;
  atKind?: '' | 'done' | 'now' | 'gap' | 'time';
}

export type QcSensitivity = 'strict' | 'production' | 'lenient';

/**
 * Checks whether a warning message warrants an orange Warning status indicator
 * under the active QC sensitivity profile.
 *
 * - Strict ("Engineering / Nerd Mode"): Every warning triggers orange, including
 *   harmless advisories like non-keyframe alignment.
 * - Production (Default): Informational advisories like `trim_in_not_keyframe_aligned`
 *   on virtual subclips are treated as info-only (kept in tooltip, but asset stays green/ready).
 *   Real media warnings trigger orange.
 * - Lenient ("Safe Playback"): Only severe warnings that pose a genuine risk to
 *   on-air playback trigger orange.
 */
export function hasActiveWarnings(
  warnings: string[] | undefined | null,
  sensitivity: QcSensitivity = 'production'
): boolean {
  if (!warnings || warnings.length === 0) return false;

  if (sensitivity === 'strict') {
    return warnings.length > 0;
  }

  // Filter out benign advisories
  const activeWarnings = warnings.filter((w) => {
    const lower = w.toLowerCase();
    // 'trim_in_not_keyframe_aligned' is an advisory for subclips, safe on modern engines
    if (lower.includes('trim_in_not_keyframe_aligned') || lower.includes('keyframe_aligned')) {
      return false;
    }
    if (sensitivity === 'lenient') {
      // In lenient mode, ignore minor loudness/GOP variances, only flag critical/fatal warnings
      if (lower.includes('loudness') || lower.includes('gop') || lower.includes('advisory')) {
        return false;
      }
    }
    return true;
  });

  return activeWarnings.length > 0;
}

/**
 * Pure status tone resolver for Rundown items with strict priority hierarchy:
 * 1. on-air
 * 2. armed
 * 3. error
 * 4. offline
 * 5. processing
 * 6. warning (evaluated against qcSensitivity)
 * 7. unsaved-trim
 * 8. ready
 * 9. idle
 */
export function resolveRundownStatusTone(
  item: Partial<RundownItem> | null | undefined,
  ctx?: RundownRowContext,
  sensitivity: QcSensitivity = 'production'
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
  if (hasActiveWarnings(item.warnings, sensitivity)) {
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
 * 4. warning (evaluated against qcSensitivity)
 * 5. ready
 * 6. idle
 */
export function resolveLibraryStatusTone(
  asset: Partial<LibraryAsset> | null | undefined,
  sensitivity: QcSensitivity = 'production'
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

  if (hasActiveWarnings(asset.warnings, sensitivity)) {
    return 'warning';
  }

  if (asset.status === 'ready') {
    return 'ready';
  }

  return 'idle';
}
