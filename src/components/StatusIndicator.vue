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
}>(), {
  tone: 'idle',
  variant: 'pill',
  label: '',
  sublabel: '',
  pulse: false
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
</script>

<template>
  <div
    class="status-indicator"
    :class="[variant, toneClass, { pulse: pulse || tone === 'processing' || tone === 'on-air' }]"
    role="status"
    :aria-label="defaultLabel"
  >
    <!-- Dot mode -->
    <template v-if="variant === 'dot'">
      <span class="status-dot" :title="defaultLabel"></span>
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
  gap: 6px;
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.2;
  user-select: none;
}

/* Tone styles */
.tone-ready {
  --status-color: #22c55e;
  --status-bg: rgba(34, 197, 94, 0.12);
  --status-border: rgba(34, 197, 94, 0.3);
  color: #4ade80;
}

.tone-processing {
  --status-color: #f59e0b;
  --status-bg: rgba(245, 158, 11, 0.12);
  --status-border: rgba(245, 158, 11, 0.3);
  color: #fbbf24;
}

.tone-error {
  --status-color: #f43f5e;
  --status-bg: rgba(244, 63, 94, 0.12);
  --status-border: rgba(244, 63, 94, 0.3);
  color: #fb7185;
}

.tone-warning {
  --status-color: #f97316;
  --status-bg: rgba(249, 115, 22, 0.12);
  --status-border: rgba(249, 115, 22, 0.3);
  color: #fdba74;
}

.tone-on-air {
  --status-color: #ef4444;
  --status-bg: rgba(239, 68, 68, 0.2);
  --status-border: rgba(239, 68, 68, 0.5);
  color: #f87171;
}

.tone-armed {
  --status-color: #06b6d4;
  --status-bg: rgba(6, 182, 212, 0.15);
  --status-border: rgba(6, 182, 212, 0.4);
  color: #38bdf8;
}

.tone-offline {
  --status-color: #64748b;
  --status-bg: rgba(100, 116, 139, 0.15);
  --status-border: rgba(100, 116, 139, 0.3);
  color: #94a3b8;
}

.tone-unsaved-trim {
  --status-color: #a855f7;
  --status-bg: rgba(168, 85, 247, 0.15);
  --status-border: rgba(168, 85, 247, 0.4);
  color: #c084fc;
}

.tone-idle {
  --status-color: #64748b;
  --status-bg: rgba(100, 116, 139, 0.12);
  --status-border: rgba(100, 116, 139, 0.3);
  color: #94a3b8;
}

/* Variant styles */
.dot {
  padding: 2px 4px;
}

.pill {
  padding: 3px 8px;
  border-radius: 9999px;
  background-color: var(--status-bg);
  border: 1px solid var(--status-border);
}

.banner {
  display: flex;
  width: 100%;
  padding: 8px 12px;
  border-radius: 6px;
  background-color: var(--status-bg);
  border: 1px solid var(--status-border);
}

/* Dot element */
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--status-color);
  flex-shrink: 0;
}

.pulse .status-dot {
  animation: status-pulse 1.8s infinite ease-in-out;
}

@keyframes status-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.4);
    opacity: 1;
  }
  70% {
    box-shadow: 0 0 0 6px rgba(255, 255, 255, 0);
    opacity: 0.6;
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255, 255, 255, 0);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pulse .status-dot,
  .status-dot {
    animation: none !important;
  }
}

.banner-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.status-title {
  font-weight: 600;
}

.status-sublabel {
  font-size: 0.7rem;
  opacity: 0.8;
}

.banner-action {
  margin-left: auto;
}
</style>
