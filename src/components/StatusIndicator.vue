<script setup lang="ts">
import { computed } from 'vue';

export type StatusTone =
  | 'ready'
  | 'processing'
  | 'error'
  | 'warning'
  | 'on-air'
  | 'armed'
  | 'offline'
  | 'unsaved-trim'
  | 'idle';

export type StatusVariant = 'dot' | 'pill' | 'banner';

const props = withDefaults(defineProps<{
  tone?: StatusTone;
  variant?: StatusVariant;
  label?: string;
  sublabel?: string;
  pulse?: boolean;
  tooltip?: string;
}>(), {
  tone: 'idle',
  variant: 'pill',
  label: '',
  sublabel: '',
  pulse: false,
  tooltip: ''
});

const toneClass = computed(() => `tone-${props.tone}`);
const defaultLabel = computed(() => {
  if (props.label) return props.label;
  const map: Record<StatusTone, string> = {
    ready: 'Ready',
    processing: 'Processing',
    error: 'Error',
    warning: 'Warning',
    'on-air': 'ON AIR',
    armed: 'ARMED',
    offline: 'Offline',
    'unsaved-trim': 'Unsaved Trim',
    idle: 'Idle'
  };
  return map[props.tone] || 'Unknown';
});

const tooltipText = computed(() => props.tooltip || defaultLabel.value);

// A11y §10: a bare dot repeated down a 300-row rundown must not be a live
// region -- it is decoration next to the row's own accessible name. Only a
// labelled indicator announces itself.
const isLiveRegion = computed(() => props.variant !== 'dot' || !!props.label);
</script>

<template>
  <div
    class="status-indicator"
    :class="[variant, toneClass, { pulse: pulse || tone === 'processing' || tone === 'on-air' }]"
    :role="isLiveRegion ? 'status' : undefined"
    :aria-label="defaultLabel"
    :title="tooltipText"
  >
    <!-- Dot mode -->
    <template v-if="variant === 'dot'">
      <span class="status-dot" :title="tooltipText"></span>
      <span v-if="label" class="status-label">{{ label }}</span>
    </template>

    <!-- Pill mode -->
    <template v-else-if="variant === 'pill'">
      <span class="status-dot"></span>
      <span class="status-label">{{ defaultLabel }}</span>
    </template>

    <!-- Banner mode -->
    <template v-else-if="variant === 'banner'">
      <span class="status-dot"></span>
      <div class="banner-content">
        <span class="status-title">{{ defaultLabel }}</span>
        <span v-if="sublabel" class="status-sublabel">{{ sublabel }}</span>
      </div>
      <div v-if="$slots.action" class="banner-action">
        <slot name="action" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  line-height: var(--lh-tight);
  user-select: none;
}

/* Tone styles.
   Every tone resolves through a theme token (§3.1) rather than a hex literal,
   so the dots stay legible in the light theme instead of being dark-theme
   colours on a white panel. `armed` here means "cued / next up" (see
   resolveRundownStatusTone), which is why it maps to --status-cued and not to
   --status-armed, the routing fence's about-to-cut orange. */
.tone-ready {
  --tone-color: var(--status-ready);
  --tone-bg: color-mix(in srgb, var(--status-ready) 12%, transparent);
  --tone-border: color-mix(in srgb, var(--status-ready) 30%, transparent);
  color: var(--status-ready);
}

.tone-processing {
  --tone-color: var(--status-processing);
  --tone-bg: color-mix(in srgb, var(--status-processing) 12%, transparent);
  --tone-border: color-mix(in srgb, var(--status-processing) 30%, transparent);
  color: var(--status-processing);
}

.tone-error {
  --tone-color: var(--status-error);
  --tone-bg: color-mix(in srgb, var(--status-error) 12%, transparent);
  --tone-border: color-mix(in srgb, var(--status-error) 30%, transparent);
  color: var(--status-error);
}

.tone-warning {
  --tone-color: var(--status-warning);
  --tone-bg: color-mix(in srgb, var(--status-warning) 12%, transparent);
  --tone-border: color-mix(in srgb, var(--status-warning) 30%, transparent);
  color: var(--status-warning);
}

.tone-on-air {
  --tone-color: var(--status-onair);
  --tone-bg: color-mix(in srgb, var(--status-onair) 20%, transparent);
  --tone-border: color-mix(in srgb, var(--status-onair) 50%, transparent);
  color: var(--status-onair);
}

.tone-armed {
  --tone-color: var(--status-cued);
  --tone-bg: color-mix(in srgb, var(--status-cued) 15%, transparent);
  --tone-border: color-mix(in srgb, var(--status-cued) 40%, transparent);
  color: var(--status-cued);
}

.tone-offline {
  --tone-color: var(--status-offline);
  --tone-bg: color-mix(in srgb, var(--status-offline) 15%, transparent);
  --tone-border: color-mix(in srgb, var(--status-offline) 30%, transparent);
  color: var(--text-secondary);
}

.tone-unsaved-trim {
  --tone-color: var(--status-unsaved);
  --tone-bg: color-mix(in srgb, var(--status-unsaved) 15%, transparent);
  --tone-border: color-mix(in srgb, var(--status-unsaved) 40%, transparent);
  color: var(--status-unsaved);
}

.tone-idle {
  --tone-color: var(--status-offline);
  --tone-bg: color-mix(in srgb, var(--status-offline) 12%, transparent);
  --tone-border: color-mix(in srgb, var(--status-offline) 30%, transparent);
  color: var(--text-secondary);
}

/* Variant styles */
.dot {
  padding: var(--space-0) var(--space-1);
}

.pill {
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-pill);
  background-color: var(--tone-bg);
  border: 1px solid var(--tone-border);
}

.banner {
  display: flex;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--tone-bg);
  border: 1px solid var(--tone-border);
}

/* Dot element */
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--tone-color);
  flex-shrink: 0;
}

.pulse .status-dot {
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
}

.banner-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-0);
}

.status-title {
  font-weight: var(--fw-semibold);
}

.status-sublabel {
  font-size: var(--fs-xs);
  opacity: 0.8;
}

.banner-action {
  margin-left: auto;
}
</style>
