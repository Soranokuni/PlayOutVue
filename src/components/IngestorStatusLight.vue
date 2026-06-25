<script setup lang="ts">
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
        return `Ingestor online\n${base}\nLast heartbeat: ${seen}`;
    }
    const seen = status.lastSeenAt
        ? new Date(status.lastSeenAt).toLocaleTimeString()
        : 'never';
    return `Ingestor offline\n${base}\nLast seen: ${seen}`;
});
</script>

<template>
  <div class="status-light-wrap" :title="tooltip">
    <span
      class="status-dot"
      :class="{ online: status.isIngestorOnline, offline: !status.isIngestorOnline }"
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
  background: #7f5c58;
  transition: background 0.2s;
}

.status-dot.online {
  background: #10b981;
  box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
  animation: pulse-green 1.6s ease-out infinite;
}

.status-dot.offline {
  background: #ff6b6b;
  box-shadow: 0 0 0 0 rgba(255, 107, 107, 0.4);
}

@keyframes pulse-green {
  0% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
  }
  70% {
    transform: scale(1.05);
    box-shadow: 0 0 0 8px rgba(16, 185, 129, 0);
  }
  100% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
  }
}
</style>
