import type { InsertionTarget } from '../stores/rundown';

export type SemanticDropTarget =
  | { kind: 'before'; targetItemId: string }
  | { kind: 'after'; targetItemId: string }
  | { kind: 'append' }
  | { kind: 'no-op'; reason: string };

export interface TargetRowRect {
  id: string;
  top: number;
  bottom: number;
  height: number;
}

export interface CalculateDropTargetParams {
  clientY: number;
  rows: TargetRowRect[];
  movingItemIds: string[];
  endZoneTop?: number;
}

/**
 * Calculates a semantic drop target purely from pointer clientY and row viewport bounding rects.
 * Uses a single viewport coordinate system (clientY vs rowRect.top/bottom).
 * Filters out moving items to prevent off-by-one destination index calculations.
 * Does not mutate store state.
 */
export function calculatePointerDropTarget(
  params: CalculateDropTargetParams
): SemanticDropTarget {
  const { clientY, rows, movingItemIds, endZoneTop } = params;

  if (!rows || rows.length === 0) {
    return { kind: 'append' };
  }

  const movingSet = new Set(movingItemIds);
  const targetableRows = rows.filter((r) => !movingSet.has(r.id));

  // If all rows are being moved, drop is a no-op
  if (targetableRows.length === 0) {
    return { kind: 'no-op', reason: 'all-items-moving' };
  }

  // Pointer below end zone or below bottom-most row
  if (typeof endZoneTop === 'number' && clientY >= endZoneTop) {
    return { kind: 'append' };
  }

  const firstRow = targetableRows[0];
  if (!firstRow) {
    return { kind: 'append' };
  }

  if (clientY < firstRow.top) {
    return { kind: 'before', targetItemId: firstRow.id };
  }

  const lastRow = targetableRows[targetableRows.length - 1];
  if (!lastRow) {
    return { kind: 'append' };
  }

  if (clientY > lastRow.bottom) {
    return { kind: 'append' };
  }

  // Find target row where clientY is inside
  for (let i = 0; i < targetableRows.length; i++) {
    const row = targetableRows[i];
    if (!row) continue;

    const midpoint = row.top + row.height / 2;
    if (clientY >= row.top && clientY <= row.bottom) {
      if (clientY < midpoint) {
        return { kind: 'before', targetItemId: row.id };
      } else {
        return { kind: 'after', targetItemId: row.id };
      }
    }
  }

  // Fallback for gaps between items: find closest row
  let closestRow = targetableRows[0]!;
  let minDistance = Math.abs(clientY - (closestRow.top + closestRow.height / 2));

  for (let i = 1; i < targetableRows.length; i++) {
    const row = targetableRows[i];
    if (!row) continue;

    const midpoint = row.top + row.height / 2;
    const distance = Math.abs(clientY - midpoint);
    if (distance < minDistance) {
      minDistance = distance;
      closestRow = row;
    }
  }

  const closestMidpoint = closestRow.top + closestRow.height / 2;
  return clientY < closestMidpoint
    ? { kind: 'before', targetItemId: closestRow.id }
    : { kind: 'after', targetItemId: closestRow.id };
}

/**
 * Maps a SemanticDropTarget to InsertionTarget for store.moveRundownItems.
 */
export function toInsertionTarget(target: SemanticDropTarget): InsertionTarget | null {
  if (target.kind === 'no-op') return null;
  if (target.kind === 'append') return { kind: 'append' };
  return { kind: target.kind, targetItemId: target.targetItemId };
}
