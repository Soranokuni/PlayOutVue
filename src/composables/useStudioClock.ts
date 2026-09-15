import { ref, onMounted, onUnmounted, onScopeDispose, getCurrentScope } from 'vue';

export interface StudioClockOptions {
  fps?: number;
}

/**
 * Decoupled Time-of-Day studio wall clock providing frame-accurate
 * timecode (HH:MM:SS:FF) driven at high frequency via requestAnimationFrame,
 * completely isolated from Pinia store reactivity cascades.
 */
export function useStudioClock(fpsInput: number = 25) {
  const fps = ref(fpsInput > 0 ? fpsInput : 25);
  const timecode = ref('00:00:00:00');
  const isNtpLocked = ref(true);

  let animFrameId: number | null = null;
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

    if (typeof requestAnimationFrame !== 'undefined') {
      animFrameId = requestAnimationFrame(updateClock);
    }
  };

  const start = () => {
    if (animFrameId === null && typeof requestAnimationFrame !== 'undefined') {
      animFrameId = requestAnimationFrame(updateClock);
    }
  };

  const stop = () => {
    if (animFrameId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
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
    isNtpLocked,
    fps,
    start,
    stop
  };
}
