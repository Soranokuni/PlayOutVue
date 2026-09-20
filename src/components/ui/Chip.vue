<script setup lang="ts">
import { computed } from 'vue';

/**
 * UI F-12 / §5.4: the one chip.
 *
 * Replaces `.mcr-badge`, `.rw-rating-badge`, `.qc-badge`, `.pl-state-pill`,
 * `.meta-chip`, `.badge-age`, `.badge-content` and friends. `tone` selects a
 * token pair, so an "18" chip is the same red with the same foreground
 * wherever it is drawn and in whichever theme.
 */
export type ChipTone =
  | 'neutral'
  | 'accent'
  | 'ready'
  | 'warning'
  | 'error'
  | 'onair'
  | 'cued'
  | 'rating-k'
  | 'rating-8'
  | 'rating-12'
  | 'rating-16'
  | 'rating-18'
  | 'rating-tp'
  | 'tag-spot'
  | 'tag-telemarketing';

const props = withDefaults(
  defineProps<{
    tone?: ChipTone;
    /** `solid` fills with the tone; `soft` tints it; `outline` is a dashed hint. */
    variant?: 'solid' | 'soft' | 'outline';
    compact?: boolean;
    title?: string;
  }>(),
  { tone: 'neutral', variant: 'soft', compact: false, title: '' }
);

const classes = computed(() => [
  'chip',
  `chip--${props.variant}`,
  `tone-${props.tone}`,
  props.compact ? 'chip--compact' : null,
]);
</script>

<template>
  <span :class="classes" :title="title || undefined"><slot /></span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  /* Never below the text floor (§10). */
  font-size: var(--fs-xs);
  font-weight: 700;
  line-height: 1.25;
  white-space: nowrap;
}

.chip--compact {
  padding: 1px 5px;
  letter-spacing: 0.02em;
}

/* Each tone names one colour; the variants decide how it is applied. */
.tone-neutral {
  --chip-color: var(--text-secondary);
  --chip-fg: var(--text-primary);
}
.tone-accent {
  --chip-color: var(--accent-blue);
  --chip-fg: var(--text-on-accent);
}
.tone-ready {
  --chip-color: var(--status-ready);
  --chip-fg: var(--text-on-success);
}
.tone-warning {
  --chip-color: var(--status-warning);
  --chip-fg: var(--text-on-warning);
}
.tone-error {
  --chip-color: var(--status-error);
  --chip-fg: var(--text-on-danger);
}
.tone-onair {
  --chip-color: var(--status-onair);
  --chip-fg: var(--text-on-danger);
}
.tone-cued {
  --chip-color: var(--status-cued);
  --chip-fg: var(--text-on-accent);
}
.tone-rating-k {
  --chip-color: var(--rating-k);
  --chip-fg: var(--rating-k-fg);
}
.tone-rating-8 {
  --chip-color: var(--rating-8);
  --chip-fg: var(--rating-8-fg);
}
.tone-rating-12 {
  --chip-color: var(--rating-12);
  --chip-fg: var(--rating-12-fg);
}
.tone-rating-16 {
  --chip-color: var(--rating-16);
  --chip-fg: var(--rating-16-fg);
}
.tone-rating-18 {
  --chip-color: var(--rating-18);
  --chip-fg: var(--rating-18-fg);
}
.tone-rating-tp {
  --chip-color: var(--rating-tp);
  --chip-fg: var(--rating-tp-fg);
}
.tone-tag-spot {
  --chip-color: var(--tag-spot);
  --chip-fg: var(--text-on-danger);
}
.tone-tag-telemarketing {
  --chip-color: var(--tag-telemarketing);
  --chip-fg: var(--text-on-danger);
}

.chip--solid {
  background: var(--chip-color);
  border-color: var(--chip-color);
  color: var(--chip-fg);
}

.chip--soft {
  background: color-mix(in srgb, var(--chip-color) 16%, transparent);
  border-color: color-mix(in srgb, var(--chip-color) 40%, transparent);
  color: var(--chip-color);
}

/* "Unrated" and other absent-value hints. */
.chip--outline {
  background: transparent;
  border: 1px dashed var(--border-strong);
  color: var(--text-secondary);
  font-weight: 600;
}
</style>
