// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  activeDragSession,
  registerRundownDropSurface,
  beginRundownDrag,
  beginLibraryDrag,
  cancelDrag,
  didCompletePointerDrag,
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

  it('re-resolves final target on pointerup and commits exact valid target', async () => {
    registerRundownDropSurface(mockSurface);
    const downEvent = new PointerEvent('pointerdown', { clientX: 100, clientY: 120, pointerId: 1 });
    beginLibraryDrag({
      pointerId: 1,
      event: downEvent,
      payload: { filename: 'test.mp4', path: '/test.mp4', shortPath: '', type: 'video', duration: 10, seek: 0, length: 10 }
    });

    // Move >=5px into container bounds (X=100, Y=120 -> row-1 top half = before row-1)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 126, pointerId: 1 }));

    // Pointerup inside container over row-1 top half
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 124, pointerId: 1 }));

    expect(mockSurface.commit).toHaveBeenCalledWith(
      { kind: 'before', targetItemId: 'row-1' },
      expect.anything()
    );
  });

  it('performs zero store mutations if pointerup occurs outside rundown surface', async () => {
    registerRundownDropSurface(mockSurface);
    const downEvent = new PointerEvent('pointerdown', { clientX: 100, clientY: 120, pointerId: 1 });
    beginLibraryDrag({
      pointerId: 1,
      event: downEvent,
      payload: { filename: 'test.mp4', path: '/test.mp4', shortPath: '', type: 'video', duration: 10, seek: 0, length: 10 }
    });

    // Move >=5px into container bounds
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 126, pointerId: 1 }));

    // Pointerup OUTSIDE container bounds (X=500 -> outside left/right)
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 500, clientY: 124, pointerId: 1 }));

    expect(mockSurface.commit).not.toHaveBeenCalled();
    expect(activeDragSession.value).toBeNull();
  });

  it('supports library drag entering rundown then moving back over library and releasing without mutation', async () => {
    registerRundownDropSurface(mockSurface);
    const downEvent = new PointerEvent('pointerdown', { clientX: 50, clientY: 120, pointerId: 1 });
    beginLibraryDrag({
      pointerId: 1,
      event: downEvent,
      payload: { filename: 'test.mp4', path: '/test.mp4', shortPath: '', type: 'video', duration: 10, seek: 0, length: 10 }
    });

    // Move into rundown container (X=100, Y=120)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 120, pointerId: 1 }));
    expect(activeDragSession.value?.phase).toBe('dragging');

    // Move back over library (X=0 -> outside left boundary)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 0, clientY: 120, pointerId: 1 }));

    // Pointerup over library
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 120, pointerId: 1 }));

    expect(mockSurface.commit).not.toHaveBeenCalled();
    expect(activeDragSession.value).toBeNull();
  });

  it('didCompletePointerDrag suppresses exactly one click event following a completed drag', () => {
    registerRundownDropSurface(mockSurface);
    const downEvent = new PointerEvent('pointerdown', { clientX: 100, clientY: 120, pointerId: 1 });
    beginLibraryDrag({
      pointerId: 1,
      event: downEvent,
      payload: { filename: 'test.mp4', path: '/test.mp4', shortPath: '', type: 'video', duration: 10, seek: 0, length: 10 }
    });

    // Before threshold: didCompletePointerDrag is false
    expect(didCompletePointerDrag()).toBe(false);

    // Move >= 5px -> enter dragging
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 126, pointerId: 1 }));

    // After threshold: didCompletePointerDrag is true once, then resets to false
    expect(didCompletePointerDrag()).toBe(true);
    expect(didCompletePointerDrag()).toBe(false);
  });

  it('cancels drag session on unexpected lostpointercapture', () => {
    registerRundownDropSurface(mockSurface);
    const downEvent = new PointerEvent('pointerdown', { clientX: 100, clientY: 120, pointerId: 1 });
    beginRundownDrag({ pointerId: 1, event: downEvent, movingItemIds: ['row-1'] });

    // Move >= 5px
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 126, pointerId: 1 }));
    expect(activeDragSession.value?.phase).toBe('dragging');

    // Unexpected lostpointercapture (expectedCaptureRelease is false)
    window.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1 }));
    expect(activeDragSession.value).toBeNull();
  });
});
