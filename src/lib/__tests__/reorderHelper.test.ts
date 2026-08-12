// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { calculatePointerDropTarget, resolvePointerDropTarget, computeIndicatorGeometry, toInsertionTarget, buildRowRectsFromDOM, sameDropTarget, type TargetRowRect } from '../reorderHelper';

describe('PR 6B Pure Reorder Helper & Single Coordinate System', () => {
  const rows: TargetRowRect[] = [
    { id: 'item-1', top: 100, bottom: 140, height: 40 }, // Midpoint 120
    { id: 'item-2', top: 140, bottom: 180, height: 40 }, // Midpoint 160
    { id: 'item-3', top: 180, bottom: 220, height: 40 }, // Midpoint 200
    { id: 'item-4', top: 220, bottom: 280, height: 60 }  // Variable height, Midpoint 250
  ];

  it('calculates before target when pointer clientY is above target row midpoint', () => {
    // Top of item-2 is 140, midpoint is 160. Pointer at 150 (above midpoint)
    const res = calculatePointerDropTarget({
      clientY: 150,
      rows,
      movingItemIds: ['item-1']
    });

    expect(res).toEqual({ kind: 'before', targetItemId: 'item-2' });
  });

  it('calculates after target when pointer clientY is below target row midpoint', () => {
    // Midpoint of item-2 is 160. Pointer at 170 (below midpoint)
    const res = calculatePointerDropTarget({
      clientY: 170,
      rows,
      movingItemIds: ['item-1']
    });

    expect(res).toEqual({ kind: 'after', targetItemId: 'item-2' });
  });

  it('calculates before first item when pointer is above top row', () => {
    const res = calculatePointerDropTarget({
      clientY: 50,
      rows,
      movingItemIds: ['item-3']
    });

    expect(res).toEqual({ kind: 'before', targetItemId: 'item-1' });
  });

  it('calculates append target when pointer is below bottom row or in end zone', () => {
    const res = calculatePointerDropTarget({
      clientY: 300,
      rows,
      movingItemIds: ['item-1'],
      endZoneTop: 290
    });

    expect(res).toEqual({ kind: 'append' });
  });

  it('filters out moving items so destination index is not off-by-one', () => {
    // Moving item-2, pointer over item-3 (top 180, bottom 220, midpoint 200). Pointer at 190 (above midpoint)
    const res = calculatePointerDropTarget({
      clientY: 190,
      rows,
      movingItemIds: ['item-2']
    });

    expect(res).toEqual({ kind: 'before', targetItemId: 'item-3' });
  });

  it('returns no-op when all rows are in moving items list', () => {
    const res = calculatePointerDropTarget({
      clientY: 150,
      rows,
      movingItemIds: ['item-1', 'item-2', 'item-3', 'item-4']
    });

    expect(res).toEqual({ kind: 'no-op', reason: 'all-items-moving' });
  });

  it('respects variable row heights accurately', () => {
    // item-4 height is 60 (220 to 280), midpoint is 250.
    // Pointer at 235 is above midpoint -> before item-4
    const resBefore = calculatePointerDropTarget({
      clientY: 235,
      rows,
      movingItemIds: ['item-1']
    });
    expect(resBefore).toEqual({ kind: 'before', targetItemId: 'item-4' });

    // Pointer at 265 is below midpoint -> after item-4
    const resAfter = calculatePointerDropTarget({
      clientY: 265,
      rows,
      movingItemIds: ['item-1']
    });
    expect(resAfter).toEqual({ kind: 'after', targetItemId: 'item-4' });
  });

  it('maps SemanticDropTarget cleanly to InsertionTarget', () => {
    expect(toInsertionTarget({ kind: 'before', targetItemId: 'item-2' })).toEqual({ kind: 'before', targetItemId: 'item-2' });
    expect(toInsertionTarget({ kind: 'append' })).toEqual({ kind: 'append' });
    expect(toInsertionTarget({ kind: 'no-op', reason: 'same' })).toBeNull();
  });

  it('buildRowRectsFromDOM reads stable data-item-id attributes from DOM containers', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div data-item-id="uuid-alpha"></div>
      <div data-item-id="uuid-beta"></div>
    `;
    const rects = buildRowRectsFromDOM(container);
    expect(rects.length).toBe(2);
    expect(rects[0].id).toBe('uuid-alpha');
    expect(rects[1].id).toBe('uuid-beta');
  });

  it('sameDropTarget correctly evaluates equality of active drop targets', () => {
    const t1 = { kind: 'before' as const, targetItemId: 'item-1' };
    const t2 = { kind: 'before' as const, targetItemId: 'item-1' };
    const t3 = { kind: 'after' as const, targetItemId: 'item-1' };
    const t4 = { kind: 'append' as const };
    const t5 = { kind: 'append' as const };

    expect(sameDropTarget(t1, t2)).toBe(true);
    expect(sameDropTarget(t1, t3)).toBe(false);
    expect(sameDropTarget(t4, t5)).toBe(true);
  });

  it('resolvePointerDropTarget returns kind: none when pointer is outside container horizontal bounds', () => {
    const snapshot = {
      rowRects: rows,
      containerRect: { top: 100, bottom: 300, left: 10, right: 300, width: 290, height: 200 },
      scrollTop: 0
    };

    // Pointer at clientX = 0 (left of container, e.g. over media library sidebar)
    const resLeft = resolvePointerDropTarget({
      clientX: 0,
      clientY: 150,
      snapshot,
      movingItemIds: [],
      source: 'library'
    });
    expect(resLeft).toEqual({ kind: 'none' });

    // Pointer at clientX = 400 (right of container)
    const resRight = resolvePointerDropTarget({
      clientX: 400,
      clientY: 150,
      snapshot,
      movingItemIds: [],
      source: 'library'
    });
    expect(resRight).toEqual({ kind: 'none' });
  });

  it('resolvePointerDropTarget returns kind: none when pointer is outside vertical container bounds', () => {
    const snapshot = {
      rowRects: rows,
      containerRect: { top: 100, bottom: 300, left: 10, right: 300, width: 290, height: 200 },
      scrollTop: 0
    };

    // Pointer above top (clientY = 50)
    const resAbove = resolvePointerDropTarget({
      clientX: 100,
      clientY: 50,
      snapshot,
      movingItemIds: [],
      source: 'library'
    });
    expect(resAbove).toEqual({ kind: 'none' });

    // Pointer below bottom (clientY = 400)
    const resBelow = resolvePointerDropTarget({
      clientX: 100,
      clientY: 400,
      snapshot,
      movingItemIds: [],
      source: 'library'
    });
    expect(resBelow).toEqual({ kind: 'none' });
  });

  it('applies midpoint hysteresis deadband to prevent flickering near midpoint boundary', () => {
    // item-2: top 140, bottom 180, midpoint 160.
    // If previousTarget was 'before' item-2, midpoint shifts by +3 (to 163).
    // Pointer at 161 (just past 160) stays 'before' due to deadband hysteresis!
    const resHysteresis = calculatePointerDropTarget({
      clientY: 161,
      rows,
      movingItemIds: [],
      previousTarget: { kind: 'before', targetItemId: 'item-2' },
      hysteresisPx: 3
    });
    expect(resHysteresis).toEqual({ kind: 'before', targetItemId: 'item-2' });

    // Pointer at 165 (past 163) breaks hysteresis and switches to 'after'
    const resSwitch = calculatePointerDropTarget({
      clientY: 165,
      rows,
      movingItemIds: [],
      previousTarget: { kind: 'before', targetItemId: 'item-2' },
      hysteresisPx: 3
    });
    expect(resSwitch).toEqual({ kind: 'after', targetItemId: 'item-2' });
  });

  it('computes indicator geometry with label and isAppend fields', () => {
    const snapshot = {
      rowRects: [
        { id: 'row-1', top: 100, bottom: 150, height: 50 },
        { id: 'row-2', top: 150, bottom: 200, height: 50 }
      ],
      containerRect: { top: 100, bottom: 300, left: 10, right: 300, width: 290, height: 200 },
      scrollTop: 0
    };

    const beforeGeom = computeIndicatorGeometry({ kind: 'before', targetItemId: 'row-1' }, snapshot);
    expect(beforeGeom).toEqual({ top: 99, left: 18, width: 274, visible: true, label: 'Insert before', isAppend: false });

    const afterGeom = computeIndicatorGeometry({ kind: 'after', targetItemId: 'row-1' }, snapshot);
    expect(afterGeom).toEqual({ top: 149, left: 18, width: 274, visible: true, label: 'Insert after', isAppend: false });

    const appendGeom = computeIndicatorGeometry({ kind: 'append' }, snapshot);
    expect(appendGeom).toEqual({ top: 200, left: 18, width: 274, visible: true, label: 'Append to end', isAppend: true });
  });
});
