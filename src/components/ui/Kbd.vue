<script setup lang="ts">
/**
 * UI §3.2: the one key cap, replacing `.key-cap`, `.palette-esc-kbd` and bare
 * `<kbd>` styling. Renders a real `<kbd>` so the shortcut is announced as a
 * key, not as prose.
 */
</script>

<template>
  <kbd class="kbd"><slot /></kbd>
</template>

<style scoped>
.kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.5em;
  padding: 1px var(--space-1);
  border: 1px solid var(--border-medium);
  border-bottom-width: 2px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}
</style>
