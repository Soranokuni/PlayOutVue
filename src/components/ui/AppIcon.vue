<script setup lang="ts">
import { computed } from 'vue';
import { ICONS, type IconName } from './icons';

/**
 * UI F-10: the single icon primitive, replacing 224 emoji.
 *
 * Draws in `currentColor`, so an icon inherits the colour of the control it
 * sits in and follows the theme for free. It is `aria-hidden` by default: an
 * icon next to a label is decoration, and an icon-only control must carry its
 * own `aria-label` on the button (§10), not on the glyph. Pass `title` only
 * when the icon genuinely is the accessible name.
 */
const props = withDefaults(
  defineProps<{
    name: IconName;
    /**
     * Rendered size in px, from a fixed scale: 12 for dense row buttons, 14 for
     * chips and menus, 16 for rows and toolbars, 20 for banners, 24 for empty
     * states. Anything else is a design decision that belongs in this list.
     */
    size?: 12 | 14 | 16 | 20 | 24;
    /** Stroke width; 2 is Lucide's default, 2.5 reads better below 16px. */
    strokeWidth?: number;
    /** Accessible name. Supplying it also drops `aria-hidden`. */
    title?: string;
    /** Continuous rotation, for the processing spinner. */
    spin?: boolean;
  }>(),
  { size: 16, strokeWidth: 2, title: '', spin: false }
);

// `v-html` is safe here and only here: the markup comes from the frozen ICONS
// map in this directory, never from a store, a file path or anything an
// operator or the Ingestor can influence.
const markup = computed(() => ICONS[props.name] ?? '');
</script>

<template>
  <svg
    class="app-icon"
    :class="{ 'is-spinning': spin }"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="title ? undefined : 'true'"
    :role="title ? 'img' : undefined"
    :aria-label="title || undefined"
    v-html="markup"
  />
</template>

<style scoped>
.app-icon {
  flex-shrink: 0;
  display: block;
  /* Sits on the text baseline rather than the line box, so an icon beside a
     label lines up with it instead of riding high. */
  vertical-align: -0.125em;
}

/* PERF: transform-only, so the spinner never leaves the compositor. */
.is-spinning {
  animation: spin var(--dur-spin) linear infinite;
  will-change: transform;
}
</style>
