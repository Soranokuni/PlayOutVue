<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import { dismissToast, runToastAction, toasts, type ToastTone } from '../../lib/toasts';
import type { IconName } from './icons';

/**
 * UI §3.2: the single toast host, mounted once from App.vue.
 *
 * `aria-live="polite"` per §10 — a confirmation must not interrupt whatever a
 * screen-reader user is already reading. The halt banner keeps `assertive`;
 * clocks and timecodes stay silent.
 */
const ICONS: Record<ToastTone, IconName> = {
  success: 'check',
  info: 'info',
  warning: 'alert',
  error: 'error',
};
</script>

<template>
  <Teleport to="body">
    <div class="toast-host" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="toast in toasts" :key="toast.id" class="toast" :class="`tone-${toast.tone}`">
          <AppIcon class="toast-icon" :name="ICONS[toast.tone]" :size="16" />
          <div class="toast-text">
            <p class="toast-message">{{ toast.message }}</p>
            <p v-if="toast.detail" class="toast-detail">{{ toast.detail }}</p>
          </div>
          <button
            v-if="toast.action"
            type="button"
            class="btn btn--ghost btn--sm toast-action"
            @click="runToastAction(toast.id)"
          >
            <AppIcon name="undo" :size="14" />
            <span>{{ toast.action.label }}</span>
          </button>
          <button
            type="button"
            class="btn btn--icon btn--sm toast-dismiss"
            aria-label="Dismiss"
            @click="dismissToast(toast.id)"
          >
            <AppIcon name="close" :size="14" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* The host itself must never swallow clicks meant for the control bar. */
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 260px;
  max-width: 380px;
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 1px solid var(--border-medium);
  border-left: 3px solid var(--toast-accent, var(--border-strong));
  border-radius: var(--radius-md);
  background: var(--bg-surface-elevated);
  box-shadow: var(--shadow-2);
  pointer-events: auto;
}

.tone-success {
  --toast-accent: var(--status-ready);
}
.tone-info {
  --toast-accent: var(--accent-primary);
}
.tone-warning {
  --toast-accent: var(--status-warning);
}
.tone-error {
  --toast-accent: var(--status-error);
}

.toast-icon {
  margin-top: 1px;
  color: var(--toast-accent);
}

.toast-text {
  flex: 1 1 auto;
  min-width: 0;
}

.toast-message {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.toast-detail {
  margin: 2px 0 0;
  font-size: var(--fs-xs);
  line-height: 1.4;
  color: var(--text-secondary);
}

.toast-dismiss {
  flex-shrink: 0;
}

/* §5.2: one action, in the toast's own tone, so Undo reads as part of the
   statement rather than as a second notification. */
.toast-action {
  flex-shrink: 0;
  color: var(--toast-accent);
  font-weight: 700;
}
.toast-action:hover:not(:disabled) {
  color: var(--toast-accent);
  background: color-mix(in srgb, var(--toast-accent) 14%, transparent);
}

/* PERF: transform and opacity only. */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
}
</style>
