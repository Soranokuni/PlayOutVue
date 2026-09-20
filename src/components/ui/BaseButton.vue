<script setup lang="ts">
import { computed, useSlots } from 'vue';
import AppIcon from './AppIcon.vue';
import type { IconName } from './icons';

/**
 * UI F-12 / perf F-25: the one button.
 *
 * The app had 40+ button class families (`glass-btn` ×64, `icon-action`,
 * `ctrl-btn`, `t-btn`, `pl-btn`, `action-btn`, `toolbar-btn`, `mini-btn`,
 * `row-btn`, `trim-btn`, …) with different paddings, radii, hover treatments
 * and disabled opacities. Styling lives in components.css; this wraps it and
 * adds the two behaviours that were missing everywhere:
 *
 * - `type="button"`, so a button inside a form never submits it by accident.
 * - `loading`, which disables the control and shows a spinner for the duration
 *   of an `await invoke(...)`. Settings' Save / Deploy / Start buttons stayed
 *   live and clickable while their IPC was in flight.
 */
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'icon';
    size?: 'sm' | 'md';
    /** Leading icon. */
    icon?: IconName;
    /** Trailing icon, e.g. a chevron on a menu trigger. */
    iconRight?: IconName;
    disabled?: boolean;
    /** Disables the button and swaps the leading icon for a spinner. */
    loading?: boolean;
    /** Required for an icon-only button; it is the control's accessible name. */
    label?: string;
    title?: string;
  }>(),
  { variant: 'secondary', size: 'md', disabled: false, loading: false, label: '', title: '' }
);

const slots = useSlots();

const classes = computed(() => [
  'btn',
  `btn--${props.variant}`,
  props.size === 'sm' ? 'btn--sm' : null,
]);

const iconSize = computed<12 | 14 | 16>(() => (props.size === 'sm' ? 14 : 16));

// An icon-only control has no text to read, so the label is its name. Warn
// rather than throw: a missing label must not take a broadcast UI down.
const isIconOnly = computed(() => props.variant === 'icon' || !slots.default);

if (import.meta.env.DEV) {
  // Checked once at setup; a control that gains/loses its slot at runtime is
  // not a pattern this app uses.
  if (isIconOnly.value && !props.label && !props.title) {
    console.warn('[BaseButton] icon-only button without `label` — screen readers will announce nothing.');
  }
}
</script>

<template>
  <button
    type="button"
    :class="classes"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    :aria-label="isIconOnly ? label || title || undefined : undefined"
    :title="title || (isIconOnly ? label : '') || undefined"
  >
    <AppIcon v-if="loading" name="processing" :size="iconSize" spin />
    <AppIcon v-else-if="icon" :name="icon" :size="iconSize" />
    <span v-if="$slots.default" class="btn-label"><slot /></span>
    <AppIcon v-if="iconRight && !loading" :name="iconRight" :size="iconSize" />
  </button>
</template>

<style scoped>
.btn-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
