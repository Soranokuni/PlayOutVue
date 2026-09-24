<script setup lang="ts">
import { computed } from 'vue';
import { GREEK_CONTENT_DESCRIPTORS } from '../../lib/greekCompliance';

/*
 * ΕΣΡ content descriptors (violence, sex, substances, language) as tiny
 * coloured letter chips beside the age chip. Always in the canonical order so
 * the same letter sits in the same place on every row; the full label is the
 * tooltip. Letters come from the descriptor table, not from here.
 */
const props = defineProps<{
    ids?: readonly string[] | null;
}>();

const chips = computed(() => {
    const set = new Set(props.ids ?? []);
    return GREEK_CONTENT_DESCRIPTORS.filter((d) => set.has(d.id));
});
</script>

<template>
  <span v-if="chips.length" class="desc-chips" data-testid="descriptor-chips">
    <span
      v-for="chip in chips"
      :key="chip.id"
      class="desc-chip"
      :class="`desc-${chip.id}`"
      :data-descriptor="chip.id"
      :title="chip.label"
      :aria-label="chip.label"
    >{{ chip.initial }}</span>
  </span>
</template>

<style scoped>
.desc-chips {
  display: inline-flex;
  align-items: center;
  gap: var(--space-0);
  flex-shrink: 0;
}
.desc-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: calc(var(--fs-xs) * 1.5);
  padding: var(--space-0) var(--space-0);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  line-height: var(--lh-none);
  cursor: default;
}
.desc-violence { background: var(--desc-violence); color: var(--desc-violence-fg); }
.desc-sex { background: var(--desc-sex); color: var(--desc-sex-fg); }
.desc-substances { background: var(--desc-substances); color: var(--desc-substances-fg); }
.desc-language { background: var(--desc-language); color: var(--desc-language-fg); }
</style>
