<script setup lang="ts">
/**
 * UI F-11: enforces one footer button order across every dialog.
 *
 * Settings put Save to the *left* of Cancel while the wizard, folder picker and
 * configurator put the primary on the right — so the same muscle memory saved
 * in one dialog and cancelled in another.
 *
 * The order is: destructive far left, then a spacer, then secondary, then
 * primary at the right edge, nearest the thumb.
 */
</script>

<template>
  <div class="footer-actions">
    <div v-if="$slots.destructive" class="footer-destructive"><slot name="destructive" /></div>
    <div class="footer-spacer" />
    <slot name="secondary" />
    <slot name="primary" />
  </div>
</template>

<style scoped>
.footer-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

.footer-spacer {
  flex: 1 1 auto;
}

.footer-destructive {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
</style>
