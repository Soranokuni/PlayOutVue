// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  activeDragSession,
  registerRundownDropSurface,
  beginRundownDrag,
  beginLibraryDrag,
  cancelDrag,
  type DropSurface
} from '../useDragSession';
import type { GeometrySnapshot, ActiveDropTarget } from '../../lib/reorderHelper';

describe('useDragSession singleton controller', () => {
  let mockSurface: DropSurface;

  beforeEach(() => {
    cancelDrag();
    mockSurface = {
      getSnapshot: vi.fn((): GeometrySnapshot => ({
        rowRects: [
          { id: 'row-1', top: 100, bottom: 150, height: 50 },
          { id: 'row-2', top: 150, bottom: 200, height: 50 }
        ],
        containerRect: { top: 100, bottom: 300, left: 10, right: 300, width: 290, height: 200 },
        scrollTop: 0
      })),
      getContainerRect: vi.fn(() => new DOMRect(10, 100, 290, 200)),
      commit: vi.fn(async () => {}),
      clearIndicator: vi.fn()
    };
  });

  it('starts in pressing phase without snapshot or target', () => {
    registerRundownDropSurface(mockSurface);
    const event = new PointerEvent('pointerdown', { clientX: 100, clientY: 120, pointerId: 1 });

    beginRundownDrag({
      pointerId: 1,
      event,
      movingItemIds: ['row-1']
    });

    const session = activeDragSession.value;
    expect(session).not.toBeNull();
    expect(session?.phase).toBe('pressing');
    expect(session?.snapshot).toBeNull();
    expect(session?.dropTarget).toEqual({ kind: 'none' });
    expect(mockSurface.getSnapshot).not.toHaveBeenCalled();
  });

  it('enters dragging phase and captures snapshot only when movement >= 5px', () => {
    registerRundownDropSurface(mockSurface);
    const downEvent = new PointerEvent('pointerdown', { clientX: 100, clientY: 120, pointerId: 1 });
    beginRundownDrag({ pointerId: 1, event: downEvent, movingItemIds: ['row-1'] });

    // Move 2px -> stay in pressing
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 122, pointerId: 1 }));
    expect(activeDragSession.value?.phase).toBe('pressing');
    expect(mockSurface.getSnapshot).not.toHaveBeenCalled();

    // Move total 6px -> enter dragging
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 126, pointerId: 1 }));
    expect(activeDragSession.value?.phase).toBe('dragging');
    expect(mockSurface.getSnapshot).toHaveBeenCalledOnce();
  });

  it('cancels drag session on window blur or Escape key', () => {
    registerRundownDropSurface(mockSurface);
    const downEvent = new PointerEvent('pointerdown', { clientX: 100, clientY: 120, pointerId: 1 });
    beginRundownDrag({ pointerId: 1, event: downEvent, movingItemIds: ['row-1'] });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(activeDragSession.value).toBeNull();
    expect(mockSurface.clearIndicator).toHaveBeenCalled();
  });

  it('cancels drag session safely when drop surface unregisters', () => {
    const unregister = registerRundownDropSurface(mockSurface);
    const downEvent = new PointerEvent('pointerdown', { clientX: 100, clientY: 120, pointerId: 1 });
    beginRundownDrag({ pointerId: 1, event: downEvent, movingItemIds: ['row-1'] });

    unregister();
    expect(activeDragSession.value).toBeNull();
  });
});
