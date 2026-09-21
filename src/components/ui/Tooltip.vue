<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import Kbd from './Kbd.vue';
import { activeTooltip, hideTooltip, placeTooltip, setTooltipPlacement } from '../../lib/tooltip';

/**
 * Round 3 §7.3: the single tooltip host.
 *
 * Mounted once, beside `ToastHost`. It renders whatever `v-tooltip` has put
 * into `activeTooltip` — never more than one at a time, so there is exactly
 * one element in the document no matter how many controls are decorated.
 *
 * It renders off-screen for one frame to measure itself, then places itself
 * with `placeTooltip`. `pointer-events: none` means it can never eat a click
 * meant for the control it is describing.
 */

const elRef = ref<HTMLElement | null>(null);

const measureAndPlace = async () => {
  const tip = activeTooltip.value;
  if (!tip) return;
  await nextTick();
  const el = elRef.value;
  if (!el || activeTooltip.value?.id !== tip.id) return;
  const anchor = tip.anchor.getBoundingClientRect();
  const self = el.getBoundingClientRect();
  setTooltipPlacement(
    tip.id,
    placeTooltip(
      { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height },
      { width: self.width, height: self.height },
      { width: window.innerWidth, height: window.innerHeight }
    )
  );
};

watch(() => activeTooltip.value?.id, () => void measureAndPlace());

// Anything that moves the anchor out from under the tooltip dismisses it —
// the library and rundown are both scrolling panes, and the control bar
// re-flows its whole ladder on resize.
const onDismiss = () => hideTooltip();
const onKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || !activeTooltip.value) return;
  // Not `preventDefault`: Escape must still reach the modal or the selection
  // underneath. Dismissing the tooltip is not the operator's whole intent.
  hideTooltip();
};

onMounted(() => {
  window.addEventListener('scroll', onDismiss, true);
  window.addEventListener('resize', onDismiss);
  window.addEventListener('blur', onDismiss);
  window.addEventListener('keydown', onKeyDown, true);
});

onUnmounted(() => {
  window.removeEventListener('scroll', onDismiss, true);
  window.removeEventListener('resize', onDismiss);
  window.removeEventListener('blur', onDismiss);
  window.removeEventListener('keydown', onKeyDown, true);
  hideTooltip();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="activeTooltip"
      :id="activeTooltip.id"
      ref="elRef"
      class="tooltip popover-surface"
      role="tooltip"
      :data-side="activeTooltip.placement?.side ?? 'bottom'"
      :style="
        activeTooltip.placement
          ? { left: activeTooltip.placement.left + 'px', top: activeTooltip.placement.top + 'px' }
          : { left: '0px', top: '0px', visibility: 'hidden' }
      "
    >
      <span class="tooltip-text">{{ activeTooltip.text }}</span>
      <Kbd v-if="activeTooltip.shortcut" class="tooltip-kbd">{{ activeTooltip.shortcut }}</Kbd>
    </div>
  </Teleport>
</template>

<style scoped>
.tooltip {
  position: fixed;
  z-index: var(--z-banner);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 280px;
  padding: 4px var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--fs-xs);
  line-height: 1.4;
  color: var(--text-primary);
  /* It describes a control; it must never be the thing the pointer hits. */
  pointer-events: none;
}

.tooltip-text {
  min-width: 0;
  /* The Ingestor light's tooltip is three lines (state, URL, last seen). The
     native `title` honoured its newlines; so does this. */
  white-space: pre-line;
}

.tooltip-kbd {
  flex-shrink: 0;
}
</style>
