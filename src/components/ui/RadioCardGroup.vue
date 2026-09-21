<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * UI §3.2 / F-22: the one radio-card group.
 *
 * Settings had eleven copies of `.qc-radio-card`: a clickable `div` wrapped
 * around a real `<input type="radio">`. The keyboard reached the hidden radio
 * rather than the card, so the focus ring landed on something invisible, and
 * the visible radio dot duplicated the card's own selected state.
 *
 * This is a real `role="radiogroup"` with roving tabindex and arrow-key
 * navigation: Tab enters the group at the checked option, arrows move and
 * select, Home/End jump to the ends.
 */
export interface RadioCardOption<T extends string = string> {
  value: T;
  /** The card's heading — what the option is. */
  title: string;
  /** One line: what choosing it does, in operational terms. */
  description?: string;
  /** Short badge, e.g. "115% (recommended)". */
  badge?: string;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: string;
  options: RadioCardOption[];
  /** Names the group for screen readers. */
  label: string;
  /** Lay the cards out in a single column instead of a grid. */
  stacked?: boolean;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

const cardRefs = ref<HTMLElement[]>([]);

const enabledIndexes = computed(() =>
  props.options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0)
);

const select = (option: RadioCardOption) => {
  if (option.disabled) return;
  emit('update:modelValue', option.value);
};

const focusIndex = (index: number) => {
  const el = cardRefs.value[index];
  if (!el) return;
  el.focus();
  const option = props.options[index];
  if (option) select(option);
};

const onKeyDown = (event: KeyboardEvent, index: number) => {
  const order = enabledIndexes.value;
  const position = order.indexOf(index);
  if (position === -1) return;

  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      event.preventDefault();
      focusIndex(order[(position + 1) % order.length]!);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      event.preventDefault();
      focusIndex(order[(position - 1 + order.length) % order.length]!);
      break;
    case 'Home':
      event.preventDefault();
      focusIndex(order[0]!);
      break;
    case 'End':
      event.preventDefault();
      focusIndex(order[order.length - 1]!);
      break;
    case ' ':
      // Space selects, which is the native radio behaviour. Enter is left
      // alone: the operator keyboard contract reserves it.
      event.preventDefault();
      select(props.options[index]!);
      break;
    default:
      break;
  }
};

/** Roving tabindex: only the checked card (or the first) is in the tab order. */
const tabIndexFor = (option: RadioCardOption, index: number) => {
  if (option.disabled) return -1;
  if (props.modelValue === option.value) return 0;
  const checkedExists = props.options.some((o) => o.value === props.modelValue && !o.disabled);
  if (checkedExists) return -1;
  return index === enabledIndexes.value[0] ? 0 : -1;
};
</script>

<template>
  <div class="radio-card-group" :class="{ 'is-stacked': stacked }" role="radiogroup" :aria-label="label">
    <div
      v-for="(option, index) in options"
      :key="option.value"
      :ref="(el) => { if (el) cardRefs[index] = el as HTMLElement; }"
      class="radio-card"
      :class="{ 'is-selected': modelValue === option.value, 'is-disabled': option.disabled }"
      role="radio"
      :aria-checked="modelValue === option.value"
      :aria-disabled="option.disabled || undefined"
      :tabindex="tabIndexFor(option, index)"
      @click="select(option)"
      @keydown="onKeyDown($event, index)"
    >
      <div class="radio-card-head">
        <slot name="preview" :option="option" />
        <span v-if="option.badge" class="radio-card-badge">{{ option.badge }}</span>
      </div>
      <p class="radio-card-title">{{ option.title }}</p>
      <p v-if="option.description" class="radio-card-desc">{{ option.description }}</p>
    </div>
  </div>
</template>

<style scoped>
.radio-card-group {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-2);
}

.radio-card-group.is-stacked {
  grid-template-columns: 1fr;
}

.radio-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  background: var(--bg-hover);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out);
}

.radio-card:hover:not(.is-disabled) {
  border-color: var(--border-strong);
}

.radio-card:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.radio-card.is-selected {
  border-color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-hover));
}

.radio-card.is-disabled {
  opacity: var(--opacity-disabled);
  cursor: not-allowed;
}

.radio-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: var(--space-5);
}

.radio-card-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--text-muted);
}

.radio-card.is-selected .radio-card-badge {
  color: var(--accent-primary);
}

.radio-card-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}

.radio-card-desc {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-body);
  color: var(--text-muted);
}
</style>
