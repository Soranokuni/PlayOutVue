<script setup lang="ts">
import { computed, ref } from 'vue';
import { useIngestorStatusStore } from '../stores/ingestorStatus';

const props = defineProps<{ modelValue?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();

const status = useIngestorStatusStore();
const localOpen = ref(props.modelValue ?? false);
const isOpen = computed({
    get: () => props.modelValue ?? localOpen.value,
    set: (value) => {
        localOpen.value = value;
        emit('update:modelValue', value);
    }
});

const formatTime = (timestamp: number) => {
    if (!timestamp) return '--:--:--';
    return new Date(timestamp).toLocaleTimeString([], {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
};

const clear = () => status.clearLog();
const toggle = () => { isOpen.value = !isOpen.value; };
const close = () => { isOpen.value = false; };
</script>

<template>
  <div class="diagnostics-wrap">
    <Transition name="slide">
      <div v-if="isOpen" class="diagnostics-panel glass-panel custom-scroll">
        <div class="diagnostics-header">
          <span class="diagnostics-title">Client Diagnostics</span>
          <div class="diagnostics-actions">
            <button class="icon-action" :disabled="!status.logEntries.length" @click="clear">Clear</button>
            <button class="icon-action" @click="close">Close</button>
          </div>
        </div>

        <div v-if="!status.logEntries.length" class="diagnostics-empty">
          No diagnostic messages yet.
        </div>
        <div v-else class="diagnostics-list">
          <div
            v-for="entry in status.logEntries.slice().reverse()"
            :key="entry.timestamp + entry.scope + entry.message"
            class="diagnostics-row"
            :class="`level-${entry.level}`"
          >
            <span class="diag-time">{{ formatTime(entry.timestamp) }}</span>
            <span class="diag-level">{{ entry.level.toUpperCase() }}</span>
            <span class="diag-scope">{{ entry.scope }}</span>
            <span class="diag-message">{{ entry.message }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </div>

  <!-- toggle button exposed for callers that don't use v-model -->
  <button
    v-if="!$slots.default"
    class="diagnostics-toggle"
    :class="{ active: isOpen }"
    @click="toggle"
    title="Toggle client diagnostics"
  >
    🛰 Diagnostics
  </button>
</template>

<style scoped>
.diagnostics-wrap {
  position: relative;
  z-index: 30;
}

.diagnostics-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  width: 520px;
  max-width: calc(100vw - 24px);
  max-height: 280px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-secondary) 94%, rgba(7, 12, 18, 0.88));
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(18px);
  border: 1px solid var(--glass-border);
}

.diagnostics-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.diagnostics-title {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.05em;
}

.diagnostics-actions {
  display: flex;
  gap: 6px;
}

.diagnostics-empty {
  color: var(--text-secondary);
  font-size: 0.75rem;
  padding: 12px;
  text-align: center;
}

.diagnostics-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
}

.diagnostics-row {
  display: grid;
  grid-template-columns: 58px 46px 84px 1fr;
  gap: 6px;
  padding: 5px 6px;
  border-radius: 4px;
  font-size: 0.7rem;
  align-items: flex-start;
}

.diagnostics-row:nth-child(odd) {
  background: rgba(255, 255, 255, 0.03);
}

.diag-time {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.diag-level {
  font-weight: 700;
  letter-spacing: 0.04em;
}

.level-warn .diag-level {
  color: #f4a261;
}

.level-error .diag-level {
  color: #e76f51;
}

.diag-scope {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diag-message {
  color: var(--text-primary);
  word-break: break-word;
}

.icon-action {
  background: color-mix(in srgb, var(--bg-tertiary) 84%, transparent);
  border: 1px solid var(--glass-border);
  color: var(--text-primary);
  border-radius: 4px;
  cursor: pointer;
  padding: 3px 8px;
  font-size: 0.72rem;
  transition: 0.15s;
}

.icon-action:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-blue) 10%, var(--bg-tertiary));
}

.icon-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.diagnostics-toggle {
  background: transparent;
  border: 1px solid transparent;
  color: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  font-size: 0.72rem;
  padding: 4px 8px;
  border-radius: 4px;
  transition: 0.15s;
}

.diagnostics-toggle:hover,
.diagnostics-toggle.active {
  color: var(--accent-blue);
  background: rgba(51, 190, 204, 0.08);
  border-color: rgba(51, 190, 204, 0.2);
}

.slide-enter-active,
.slide-leave-active {
  transition: transform 0.18s ease, opacity 0.18s ease;
}

.slide-enter-from,
.slide-leave-to {
  transform: translateY(10px);
  opacity: 0;
}
</style>
