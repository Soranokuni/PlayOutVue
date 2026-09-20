import { ref, onScopeDispose, getCurrentScope } from 'vue';

export interface StudioClockOptions {
  fps?: number;
}

/**
 * Decoupled Time-of-Day studio wall clock providing frame-accurate
 * timecode (HH:MM:SS:FF), completely isolated from Pinia store reactivity
 * cascades.
 *
 * PERF F-18: this used to be a requestAnimationFrame loop, i.e. 60 wake-ups
 * per second (and a compositor kept awake) to advance a display that only
 * changes `fps` times per second. The loop is now a timer aligned to the
 * next frame boundary within the current second (25 wake-ups/s at 25 fps),
 * and it sleeps entirely while the document is hidden, catching up on the
 * next visibility change. The value written to `timecode` is identical.
 */
export function useStudioClock(fpsInput: number = 25) {
  const fps = ref(fpsInput > 0 ? fpsInput : 25);
  const timecode = ref('00:00:00:00');

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastFormatted = '';

  const updateClock = () => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ms = now.getMilliseconds();
    const frame = Math.min(
      fps.value - 1,
      Math.max(0, Math.floor((ms / 1000) * fps.value))
    );
    const framesStr = String(frame).padStart(2, '0');

    const formatted = `${hours}:${minutes}:${seconds}:${framesStr}`;
    if (formatted !== lastFormatted) {
      lastFormatted = formatted;
      timecode.value = formatted;
    }
  };

  const isHidden = () => typeof document !== 'undefined' && document.hidden === true;

  const clearTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  /** Sleep until just after the next frame boundary of the current second. */
  const scheduleNext = () => {
    if (!running || isHidden()) return;
    const periodMs = 1000 / fps.value;
    const withinSecond = Date.now() % 1000;
    const untilBoundary = periodMs - (withinSecond % periodMs);
    // +1 ms guard so a slightly-early wake-up does not land in the same frame.
    const delay = Math.max(1, Math.ceil(untilBoundary) + 1);
    timerId = setTimeout(tick, delay);
  };

  const tick = () => {
    timerId = null;
    updateClock();
    scheduleNext();
  };

  const onVisibilityChange = () => {
    if (!running) return;
    if (isHidden()) {
      clearTimer();
    } else if (timerId === null) {
      updateClock();
      scheduleNext();
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    updateClock();
    scheduleNext();
  };

  const stop = () => {
    running = false;
    clearTimer();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };

  // Immediate first calculation
  updateClock();

  if (typeof window !== 'undefined') {
    start();
  }

  const cleanup = () => {
    stop();
  };

  try {
    if (getCurrentScope()) {
      onScopeDispose(cleanup);
    }
  } catch (_) {
    // If called outside Vue component lifecycle (e.g. standalone test), safe to ignore
  }

  return {
    timecode,
    fps,
    start,
    stop
  };
}
