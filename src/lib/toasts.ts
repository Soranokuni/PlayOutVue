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

/**
 * Round 3 §5.2: a toast may carry exactly one action.
 *
 * This exists for Undo. A destructive action that can be taken back within a
 * few seconds needs no modal at all -- the modal asks a question the operator
 * cannot yet answer ("did I mean that?"), where Undo answers it after the
 * fact, from the thing they can now see is gone.
 *
 * One action only, and it dismisses the toast: a toast is not a menu.
 */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** Optional detail, shown smaller under the message. */
  detail?: string;
  action?: ToastAction;
}

const DEFAULT_TIMEOUT_MS = 4000;
/** Errors linger: an operator may be looking at the rundown when one lands. */
const ERROR_TIMEOUT_MS = 8000;

export const toasts = ref<Toast[]>([]);

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Runs a toast's action and dismisses it. Nothing happens if it has none. */
export function runToastAction(id: number): void {
  const toast = toasts.value.find((t) => t.id === id);
  if (!toast?.action) return;
  dismissToast(id);
  toast.action.run();
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

export interface ToastOptions {
  detail?: string;
  action?: ToastAction;
  /** Overrides the tone's default lifetime. An Undo needs longer than 4 s. */
  timeoutMs?: number;
}

export function showToast(
  message: string,
  tone: ToastTone = 'success',
  detailOrOptions?: string | ToastOptions
): number {
  const options: ToastOptions =
    typeof detailOrOptions === 'string' ? { detail: detailOrOptions } : detailOrOptions ?? {};
  const { detail, action, timeoutMs } = options;

  const id = nextId++;
  toasts.value = [...toasts.value, { id, tone, message, detail, action }];

  const timeout = timeoutMs ?? (tone === 'error' ? ERROR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
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
