import type { InsertionTarget } from '../stores/rundown';

export type ActiveDropTarget =
  | { kind: 'before'; targetItemId: string }
  | { kind: 'after'; targetItemId: string }
  | { kind: 'append' }
  | { kind: 'none' };

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
  previousTarget?: ActiveDropTarget;
  hysteresisPx?: number;
}

/**
 * Checks deep equality of two ActiveDropTarget objects.
 */
export function sameDropTarget(a: ActiveDropTarget, b: ActiveDropTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'before' || a.kind === 'after') {
    return (b.kind === 'before' || b.kind === 'after') && a.targetItemId === b.targetItemId;
  }
  return true;
}

/**
 * Queries DOM element containers with `data-item-id` attribute within container element.
 * Reads stable item UUID from `data-item-id` rather than assuming array index.
 */
export function buildRowRectsFromDOM(container: HTMLElement | null): TargetRowRect[] {
  if (!container) return [];
  const elements = container.querySelectorAll<HTMLElement>('[data-item-id]');
  const rects: TargetRowRect[] = [];
  elements.forEach((el) => {
    const id = el.getAttribute('data-item-id');
    if (id) {
      const rect = el.getBoundingClientRect();
      rects.push({
        id,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height
      });
    }
  });
  return rects;
}

/**
 * Calculates a semantic drop target purely from pointer clientY and row viewport bounding rects.
 * Uses a single viewport coordinate system (clientY vs rowRect.top/bottom).
 * Filters out moving items to prevent off-by-one destination index calculations.
 * Supports a small hysteresis deadband to prevent flickering on midpoint boundaries.
 */
export function calculatePointerDropTarget(
  params: CalculateDropTargetParams
): SemanticDropTarget {
  const { clientY, rows, movingItemIds, endZoneTop, previousTarget, hysteresisPx = 3 } = params;

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

    let midpoint = row.top + row.height / 2;

    // Apply hysteresis deadband if resting near midpoint of previous target row
    if (
      previousTarget &&
      (previousTarget.kind === 'before' || previousTarget.kind === 'after') &&
      previousTarget.targetItemId === row.id
    ) {
      if (previousTarget.kind === 'before') {
        midpoint += hysteresisPx;
      } else {
        midpoint -= hysteresisPx;
      }
    }

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

export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface GeometrySnapshot {
  rowRects: TargetRowRect[];
  containerRect: RectLike;
  endZoneRect?: RectLike;
  scrollTop: number;
}

export interface ResolvePointerDropTargetParams {
  clientY: number;
  snapshot: GeometrySnapshot | null;
  movingItemIds: string[];
  source: 'rundown' | 'library';
  previousTarget?: ActiveDropTarget;
}

export function resolvePointerDropTarget(params: ResolvePointerDropTargetParams): ActiveDropTarget {
  const { clientY, snapshot, movingItemIds, source, previousTarget } = params;
  if (!snapshot || !snapshot.rowRects || snapshot.rowRects.length === 0) {
    return { kind: 'append' };
  }

  const endZoneTop = snapshot.endZoneRect ? snapshot.endZoneRect.top : undefined;
  const semantic = calculatePointerDropTarget({
    clientY,
    rows: snapshot.rowRects,
    movingItemIds: source === 'library' ? [] : movingItemIds,
    endZoneTop,
    previousTarget
  });

  if (semantic.kind === 'before' || semantic.kind === 'after') {
    return { kind: semantic.kind, targetItemId: semantic.targetItemId };
  }
  if (semantic.kind === 'append') {
    return { kind: 'append' };
  }
  return { kind: 'none' };
}

export interface IndicatorGeometry {
  top: number;
  left: number;
  width: number;
  visible: boolean;
}

export function computeIndicatorGeometry(
  target: ActiveDropTarget,
  snapshot: GeometrySnapshot | null
): IndicatorGeometry | null {
  if (!snapshot || target.kind === 'none') return null;

  const left = snapshot.containerRect.left + 8;
  const width = snapshot.containerRect.width - 16;

  if (target.kind === 'append') {
    const lastRow = snapshot.rowRects.length > 0 ? snapshot.rowRects[snapshot.rowRects.length - 1] : undefined;
    const top = snapshot.endZoneRect
      ? snapshot.endZoneRect.top
      : (lastRow ? lastRow.bottom : snapshot.containerRect.bottom - 40);
    return { top, left, width, visible: true };
  }

  const row = snapshot.rowRects.find(r => r.id === target.targetItemId);
  if (!row) return null;

  const top = target.kind === 'before' ? row.top - 1 : row.bottom - 1;
  return { top, left, width, visible: true };
}

