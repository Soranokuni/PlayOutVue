import { ref } from 'vue';

/**
 * UI F-23 / §3.2: the shared toast queue.
 *
 * Settings used to close silently on Save, so an operator had no way to tell a
 * save from a mis-click on Cancel. `message()` from plugin-dialog is the wrong
 * tool for a success: it is modal, so it interrupts the thing the operator just
 * finished doing.
 *
 * Toasts are for confirmations and non-blocking notices only. A failure that
 * needs a decision still goes through `ask()`; a failure tied to one field
 * belongs at that field (see `describeError`).
 */
export type ToastTone = 'success' | 'info' | 'warning' | 'error';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** Optional detail, shown smaller under the message. */
  detail?: string;
}

const DEFAULT_TIMEOUT_MS = 4000;
/** Errors linger: an operator may be looking at the rundown when one lands. */
const ERROR_TIMEOUT_MS = 8000;

export const toasts = ref<Toast[]>([]);

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

export function showToast(message: string, tone: ToastTone = 'success', detail?: string): number {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, tone, message, detail }];

  const timeout = tone === 'error' ? ERROR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  timers.set(
    id,
    setTimeout(() => dismissToast(id), timeout)
  );

  return id;
}

/** @internal Test-only. */
export function clearToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  toasts.value = [];
}
