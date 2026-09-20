<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import type { IconName } from './icons';

/**
 * UI F-23: the one empty state.
 *
 * The app had six, all different: the library gave setup advice decorated with
 * emoji, the rundown drew a dashed box, and only the Recycle Bin had a real
 * one. An empty state says what is missing and what to do about it — nothing
 * more.
 */
withDefaults(
  defineProps<{
    icon?: IconName;
    title: string;
    /** One sentence: the next action, in the operator's terms. */
    hint?: string;
    compact?: boolean;
  }>(),
  { hint: '', compact: false }
);
</script>

<template>
  <div class="empty-state" :class="{ 'is-compact': compact }">
    <AppIcon v-if="icon" class="empty-icon" :name="icon" :size="compact ? 20 : 24" />
    <p class="empty-title">{{ title }}</p>
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
    <div v-if="$slots.action" class="empty-action"><slot name="action" /></div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--text-secondary);
}

.empty-state.is-compact {
  padding: var(--space-4) var(--space-3);
  gap: var(--space-1);
}

.empty-icon {
  color: var(--text-muted);
}

.empty-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.empty-hint {
  margin: 0;
  max-width: 40ch;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-muted);
}

.empty-action {
  margin-top: var(--space-2);
}
</style>
