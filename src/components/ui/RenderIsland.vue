<script setup lang="ts">
/**
 * Renders its default slot inside its own render effect.
 *
 * A slot is compiled into a function that runs during the child's render, so
 * reactive values read inside `<RenderIsland>…</RenderIsland>` are tracked by
 * this component, not by the parent whose template contains them. Wrap a value
 * that changes many times a second (the studio clock, the playout timecode, a
 * progress hairline) and only the island re-renders; the large parent template
 * around it does not.
 *
 * The island adds no element of its own, and slot content keeps the parent's
 * scoped styles, so wrapping markup changes neither the DOM nor the CSS.
 */
</script>

<template>
  <slot />
</template>
