<script setup lang="ts">
import { computed } from 'vue';
import { vTooltip } from '../lib/tooltip';
import { useMediaRootStore } from '../stores/mediaRoot';
import { pickHeadline, type HealthItem } from '../lib/mediaHealth';

/**
 * MEDIA-FALLBACK-HANDOFF: one chip for what the channel falls back on and
 * where its media comes from. The label names the most urgent item; the
 * tooltip lists all of them. Click opens Settings → Media.
 */
const emit = defineEmits<{ (e: 'open', section: string): void }>();

const mediaRoot = useMediaRootStore();

const items = computed<HealthItem[]>(() => {
    const list: HealthItem[] = [];
    const root = mediaRoot.view;
    if (!root.hidden) list.push({ key: 'media-root', tone: root.tone, label: root.label, detail: root.detail, section: 'media' });
    return list;
});

const headline = computed(() => pickHeadline(items.value));
const tooltip = computed(() => items.value.map((item) => item.detail).join('\n'));
</script>

<template>
  <button
    v-if="headline"
    type="button"
    class="btn btn--ghost ctrl-btn media-health-chip"
    :class="`media-health-chip--${headline.tone}`"
    :aria-label="tooltip"
    v-tooltip="tooltip"
    data-testid="media-health-chip"
    @click="emit('open', headline.section)"
  >
    <span class="media-health-dot" :class="`tone-${headline.tone}`"></span>
    <span class="media-health-label">{{ headline.label }}</span>
  </button>
</template>

<style scoped>
.media-health-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
}

.media-health-dot {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--status-offline);
  flex-shrink: 0;
}

.media-health-dot.tone-ready { background: var(--status-ready); }
.media-health-dot.tone-warning { background: var(--status-warning); }
.media-health-dot.tone-error { background: var(--status-error); }
.media-health-dot.tone-processing { background: var(--status-processing); }

.media-health-chip--error .media-health-dot {
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
}

.media-health-label {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
</style>
