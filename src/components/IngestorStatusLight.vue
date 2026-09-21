<script setup lang="ts">
import { vTooltip } from '../lib/tooltip';
import { computed } from 'vue';
import { useIngestorStatusStore } from '../stores/ingestorStatus';
import { useSettingsStore } from '../stores/settings';

const status = useIngestorStatusStore();
const settings = useSettingsStore();

const tooltip = computed(() => {
    const base = settings.ingestorApiBaseUrl || 'http://127.0.0.1:4353';
    if (status.isIngestorOnline) {
        const seen = status.lastSeenAt
            ? new Date(status.lastSeenAt).toLocaleTimeString()
            : 'unknown';
        if (status.isAuthRejected) {
            return `Ingestor reachable but rejecting the API token (HTTP 401)\n${base}\nSet the token under Settings > PlayoutTranscode Ingestor API\nLast heartbeat: ${seen}`;
        }
        return `Ingestor online\n${base}\nLast heartbeat: ${seen}`;
    }
    const seen = status.lastSeenAt
        ? new Date(status.lastSeenAt).toLocaleTimeString()
        : 'never';
    return `Ingestor offline\n${base}\nLast seen: ${seen}`;
});
</script>

<template>
  <div class="status-light-wrap" v-tooltip="tooltip">
    <span
      class="status-dot"
      :class="{
        online: status.isIngestorOnline && !status.isAuthRejected,
        'auth-rejected': status.isAuthRejected,
        offline: !status.isIngestorOnline
      }"
    ></span>
  </div>
</template>

<style scoped>
.status-light-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  position: relative;
  cursor: help;
  flex-shrink: 0;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--status-offline);
  transition: background var(--dur-base);
}

.status-dot.online {
  background: var(--status-ready);
}

.status-dot.offline {
  background: var(--status-error);
}

/* Reachable, but every authenticated call is answered 401. */
.status-dot.auth-rejected {
  background: var(--status-warning);
}

/* PERF: this dot sits in the always-visible control bar. The ping used to
   animate `box-shadow`, repainting it every frame for the whole session. The
   expanding ring is now a sibling overlay whose opacity and transform animate
   on the compositor instead. */
.status-dot::after {
  content: '';
  position: absolute;
  inset: 50% auto auto 50%;
  width: var(--space-2);
  height: var(--space-2);
  margin: calc(var(--space-1) * -1) 0 0 calc(var(--space-1) * -1);
  border-radius: 50%;
  border: 2px solid currentColor;
  color: inherit;
  pointer-events: none;
  opacity: 0;
}

.status-dot.online::after {
  color: var(--status-ready);
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
}

.status-dot.auth-rejected::after {
  color: var(--status-warning);
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
}

</style>
