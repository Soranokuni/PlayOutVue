import { ref } from 'vue';

/**
 * Audit T1-12 follow-up: the global error handlers in main.ts log every
 * unhandled fault to the console and the Rust diagnostics log, but the
 * operator saw nothing. This ref feeds a non-blocking toast in App.vue.
 * Faults collapse by message so a repeating error shows one toast with a
 * counter instead of a stream.
 */
export interface FrontendFault {
  id: number;
  source: string;
  message: string;
  count: number;
  at: number;
}

export const frontendFaults = ref<FrontendFault[]>([]);

const MAX_VISIBLE_FAULTS = 4;
let nextId = 1;

/** Record a fault for the operator toast. Safe to call from anywhere. */
export function recordFrontendFault(source: string, message: string): void {
  const firstLine = message.split('\n')[0]?.trim() || 'Unknown error';
  const existing = frontendFaults.value.find((f) => f.source === source && f.message === firstLine);
  if (existing) {
    existing.count += 1;
    existing.at = Date.now();
    return;
  }
  frontendFaults.value.push({ id: nextId++, source, message: firstLine, count: 1, at: Date.now() });
  if (frontendFaults.value.length > MAX_VISIBLE_FAULTS) {
    frontendFaults.value.splice(0, frontendFaults.value.length - MAX_VISIBLE_FAULTS);
  }
}

export function dismissFrontendFault(id: number): void {
  frontendFaults.value = frontendFaults.value.filter((f) => f.id !== id);
}

export function clearFrontendFaults(): void {
  frontendFaults.value = [];
}
