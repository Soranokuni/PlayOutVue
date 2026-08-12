import { shallowRef, ref } from 'vue';
import type { ActiveDropTarget, GeometrySnapshot, IndicatorGeometry } from '../lib/reorderHelper';
import { resolvePointerDropTarget, computeIndicatorGeometry, sameDropTarget } from '../lib/reorderHelper';
import type { DragPayload } from './useDragState';

export type DragSourceKind = 'rundown' | 'library';
export type DragPhase = 'idle' | 'pressing' | 'dragging' | 'committing' | 'cancelled';

export interface DropSurface {
  getSnapshot(): GeometrySnapshot;
  getContainerRect(): DOMRect;
  commit(target: ActiveDropTarget, session: DragSession): Promise<void>;
  clearIndicator(): void;
}

export interface DragSession {
  pointerId: number;
  source: DragSourceKind;
  phase: DragPhase;
  movingItemIds: string[];
  libraryPayload?: DragPayload;
  libraryDropOutside?: (point: { clientX: number; clientY: number }) => Promise<boolean> | boolean;
  originPoint: { x: number; y: number };
  currentPoint: { x: number; y: number };
  snapshot: GeometrySnapshot | null;
  dropTarget: ActiveDropTarget;
  layoutVersion: number;
  targetElement?: HTMLElement | null;
  expectedCaptureRelease?: boolean;
}

export const activeDragSession = shallowRef<DragSession | null>(null);
export const indicatorGeometry = ref<IndicatorGeometry | null>(null);

let registeredSurface: DropSurface | null = null;
let indicatorFrame: number | null = null;
let latestPointerPoint: { x: number; y: number } | null = null;
let suppressNextClick = false;

export function didCompletePointerDrag(): boolean {
  const result = suppressNextClick;
  suppressNextClick = false;
  return result;
}

export function registerRundownDropSurface(surface: DropSurface): () => void {
  registeredSurface = surface;
  return () => {
    if (registeredSurface === surface) {
      registeredSurface = null;
      cancelDrag();
    }
  };
}

function updateIndicatorVisuals() {
  const session = activeDragSession.value;
  if (!session || session.phase !== 'dragging' || session.dropTarget.kind === 'none') {
    indicatorGeometry.value = null;
    return;
  }
  indicatorGeometry.value = computeIndicatorGeometry(session.dropTarget, session.snapshot);
}

function scheduleTargetResolution() {
  if (indicatorFrame !== null) return;

  indicatorFrame = requestAnimationFrame(() => {
    indicatorFrame = null;
    const session = activeDragSession.value;
    const point = latestPointerPoint;
    latestPointerPoint = null;
    if (!session || session.phase !== 'dragging' || !point) return;

    if (!session.snapshot && registeredSurface) {
      session.snapshot = registeredSurface.getSnapshot();
    }

    const nextTarget = resolvePointerDropTarget({
      clientX: point.x,
      clientY: point.y,
      snapshot: session.snapshot,
      movingItemIds: session.movingItemIds,
      source: session.source,
      previousTarget: session.dropTarget
    });

    if (!sameDropTarget(session.dropTarget, nextTarget)) {
      session.dropTarget = nextTarget;
      // Trigger shallowRef update
      activeDragSession.value = { ...session };
    }

    updateIndicatorVisuals();
  });
}

function handleWindowPointerMove(event: PointerEvent) {
  const session = activeDragSession.value;
  if (!session || (session.phase !== 'pressing' && session.phase !== 'dragging')) return;
  if (session.pointerId !== event.pointerId) return;

  session.currentPoint = { x: event.clientX, y: event.clientY };

  if (session.phase === 'pressing') {
    const dist = Math.hypot(session.currentPoint.x - session.originPoint.x, session.currentPoint.y - session.originPoint.y);
    if (dist >= 5) {
      session.phase = 'dragging';
      suppressNextClick = true;
      if (session.targetElement && typeof session.targetElement.setPointerCapture === 'function') {
        try {
          session.targetElement.setPointerCapture(session.pointerId);
        } catch {
          // Ignore pointer capture failures on detached elements
        }
      }
      if (registeredSurface) {
        session.snapshot = registeredSurface.getSnapshot();
      }
      activeDragSession.value = { ...session };
      latestPointerPoint = { ...session.currentPoint };
      scheduleTargetResolution();
    }
    return;
  }

  if (session.phase === 'dragging') {
    latestPointerPoint = { x: event.clientX, y: event.clientY };
    scheduleTargetResolution();
  }
}

async function handleWindowPointerUp(event: PointerEvent) {
  const session = activeDragSession.value;
  if (!session) return;
  if (session.pointerId !== event.pointerId) return;

  let didCommit = false;

  if (session.phase === 'dragging' && registeredSurface) {
    session.currentPoint = { x: event.clientX, y: event.clientY };
    const snapshot = registeredSurface.getSnapshot();
    session.snapshot = snapshot;

    const finalTarget = resolvePointerDropTarget({
      clientX: event.clientX,
      clientY: event.clientY,
      snapshot,
      movingItemIds: session.movingItemIds,
      source: session.source,
      previousTarget: session.dropTarget
    });

    session.dropTarget = finalTarget;
    session.phase = 'committing';
    activeDragSession.value = { ...session };

    if (finalTarget.kind !== 'none') {
      didCommit = true;
      try {
        await registeredSurface.commit(finalTarget, session);
      } catch (err) {
        console.error('[DragSession] Commit failed:', err);
      }
    } else if (session.source === 'library' && session.libraryDropOutside) {
      try {
        didCommit = await session.libraryDropOutside({
          clientX: event.clientX,
          clientY: event.clientY
        });
      } catch (err) {
        console.error('[DragSession] Library drop fallback failed:', err);
      }
    }
  }

  cancelDrag();
  if (didCommit) {
    suppressNextClick = true;
  }
}

function handleWindowPointerCancel(event: PointerEvent) {
  const session = activeDragSession.value;
  if (session && session.pointerId === event.pointerId) {
    cancelDrag();
  }
}

function handleLostPointerCapture(event: PointerEvent) {
  const session = activeDragSession.value;
  if (!session || session.pointerId !== event.pointerId) return;
  if (session.expectedCaptureRelease) return;
  if (session.phase === 'pressing' || session.phase === 'dragging') {
    cancelDrag();
  }
}

function handleWindowBlur() {
  if (activeDragSession.value) {
    cancelDrag();
  }
}

function handleWindowKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && activeDragSession.value) {
    cancelDrag();
  }
}

function removeWindowListeners() {
  if (typeof window === 'undefined') return;
  window.removeEventListener('pointermove', handleWindowPointerMove);
  window.removeEventListener('pointerup', handleWindowPointerUp);
  window.removeEventListener('pointercancel', handleWindowPointerCancel);
  window.removeEventListener('lostpointercapture', handleLostPointerCapture);
  window.removeEventListener('blur', handleWindowBlur);
  window.removeEventListener('keydown', handleWindowKeyDown);
}

function attachWindowListeners() {
  if (typeof window === 'undefined') return;
  removeWindowListeners();
  window.addEventListener('pointermove', handleWindowPointerMove);
  window.addEventListener('pointerup', handleWindowPointerUp);
  window.addEventListener('pointercancel', handleWindowPointerCancel);
  window.addEventListener('lostpointercapture', handleLostPointerCapture);
  window.addEventListener('blur', handleWindowBlur);
  window.addEventListener('keydown', handleWindowKeyDown);
}

function resolveTargetElement(event: PointerEvent): HTMLElement | null {
  if (event.currentTarget instanceof HTMLElement) return event.currentTarget;
  if (event.target instanceof HTMLElement) return event.target;
  return null;
}

export function beginRundownDrag(params: {
  pointerId: number;
  event: PointerEvent;
  movingItemIds: string[];
}): void {
  if (params.event.button !== 0) return;

  if (activeDragSession.value) {
    cancelDrag();
  }

  const targetElement = resolveTargetElement(params.event);

  const session: DragSession = {
    pointerId: params.pointerId,
    source: 'rundown',
    phase: 'pressing',
    movingItemIds: params.movingItemIds,
    originPoint: { x: params.event.clientX, y: params.event.clientY },
    currentPoint: { x: params.event.clientX, y: params.event.clientY },
    snapshot: null,
    dropTarget: { kind: 'none' },
    layoutVersion: 0,
    targetElement,
    expectedCaptureRelease: false
  };

  activeDragSession.value = session;
  attachWindowListeners();
}

export function beginLibraryDrag(params: {
  pointerId: number;
  event: PointerEvent;
  payload: DragPayload;
  onDropOutside?: (point: { clientX: number; clientY: number }) => Promise<boolean> | boolean;
}): void {
  if (params.event.button !== 0) return;

  if (activeDragSession.value) {
    cancelDrag();
  }

  const targetElement = resolveTargetElement(params.event);

  const session: DragSession = {
    pointerId: params.pointerId,
    source: 'library',
    phase: 'pressing',
    movingItemIds: [],
    libraryPayload: params.payload,
    libraryDropOutside: params.onDropOutside,
    originPoint: { x: params.event.clientX, y: params.event.clientY },
    currentPoint: { x: params.event.clientX, y: params.event.clientY },
    snapshot: null,
    dropTarget: { kind: 'none' },
    layoutVersion: 0,
    targetElement,
    expectedCaptureRelease: false
  };

  activeDragSession.value = session;
  attachWindowListeners();
}

export function refreshGeometrySnapshot(): void {
  const session = activeDragSession.value;
  if (!session || !registeredSurface) return;
  session.snapshot = registeredSurface.getSnapshot();
  session.layoutVersion++;
  activeDragSession.value = { ...session };
  if (session.phase === 'dragging') {
    latestPointerPoint = { ...session.currentPoint };
    scheduleTargetResolution();
  }
}

export function cancelDrag(): void {
  if (indicatorFrame !== null) {
    cancelAnimationFrame(indicatorFrame);
    indicatorFrame = null;
  }
  latestPointerPoint = null;

  const session = activeDragSession.value;
  if (session && session.targetElement) {
    session.expectedCaptureRelease = true;
    if (typeof session.targetElement.releasePointerCapture === 'function') {
      try {
        if (typeof session.targetElement.hasPointerCapture === 'function') {
          if (session.targetElement.hasPointerCapture(session.pointerId)) {
            session.targetElement.releasePointerCapture(session.pointerId);
          }
        } else {
          session.targetElement.releasePointerCapture(session.pointerId);
        }
      } catch {
        // Ignore release errors
      }
    }
  }

  removeWindowListeners();

  if (activeDragSession.value) {
    activeDragSession.value = { ...activeDragSession.value, phase: 'cancelled' };
  }
  indicatorGeometry.value = null;
  registeredSurface?.clearIndicator();
  activeDragSession.value = null;
  suppressNextClick = false;
}
