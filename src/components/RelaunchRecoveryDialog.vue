<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import BaseModal from './ui/BaseModal.vue';
import BaseButton from './ui/BaseButton.vue';
import AppIcon from './ui/AppIcon.vue';
import {
  relaunchOffer,
  resolveRelaunchOffer,
  pauseRelaunchCountdown,
  type RelaunchOfferAction,
} from '../services/caspar';

/**
 * PlayOut came back (crash, hang, relaunch or UI reload) and nothing of the
 * rundown is playing. services/caspar.ts built a plan from the Rust checkpoint;
 * this shows it with a countdown so an unattended MCR still recovers, and
 * stops the countdown the moment the operator touches the dialog.
 */

const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

watch(
  () => relaunchOffer.value?.deadlineMs ?? null,
  (deadline) => {
    if (ticker) clearInterval(ticker);
    ticker = null;
    if (deadline != null) {
      now.value = Date.now();
      ticker = setInterval(() => { now.value = Date.now(); }, 250);
    }
  },
  { immediate: true }
);
onUnmounted(() => { if (ticker) clearInterval(ticker); });

const view = computed(() => relaunchOffer.value);
const secondsLeft = computed(() => {
  const deadline = view.value?.deadlineMs;
  return deadline == null ? null : Math.max(0, Math.ceil((deadline - now.value) / 1000));
});

const title = computed(() => view.value?.previousSession === 'ui-reload' ? 'PlayOut UI reloaded' : 'PlayOut restarted');

const formatClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const formatDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const formatPosition = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const sessionLine = computed(() => {
  const v = view.value;
  if (!v) return '';
  const how = v.previousSession === 'crashed' ? 'ended unexpectedly' : v.previousSession === 'closed' ? 'was closed' : 'stopped responding';
  return `The last session ${how}; last checkpoint at ${formatClock(v.lostAtMs)}.`;
});

const choose = (entry: RelaunchOfferAction) => {
  void resolveRelaunchOffer(entry.action);
};
</script>

<template>
  <BaseModal
    :open="!!view"
    size="md"
    subtitle="Recovery"
    :title="title"
    :closable="false"
    :dismiss-on-backdrop="false"
  >
    <div
      v-if="view"
      class="relaunch-body"
      @pointermove="pauseRelaunchCountdown()"
      @keydown="pauseRelaunchCountdown()"
    >
      <p class="relaunch-status">
        <AppIcon name="alert" :size="16" />
        <span>
          Channel off air for about <strong>{{ formatDuration(view.offer.offAirMs) }}</strong>.
          {{ sessionLine }}
        </span>
      </p>
      <dl class="relaunch-facts">
        <dt>Was on air</dt>
        <dd>{{ view.wasFilename }} at {{ formatPosition(view.wasPositionMs) }}</dd>
        <dt>Plan</dt>
        <dd>{{ view.actions[0]?.label }} <span class="relaunch-reason">({{ view.offer.reason }})</span></dd>
      </dl>
      <p v-if="view.crashLoop" class="relaunch-warning">
        <AppIcon name="error" :size="14" />
        <span>PlayOut has crashed repeatedly. Automatic restart is paused until it runs cleanly again.</span>
      </p>

      <div class="relaunch-actions">
        <BaseButton
          v-for="(entry, i) in view.actions"
          :key="i"
          :variant="entry.primary ? 'primary' : entry.action.kind === 'hold' ? 'ghost' : 'secondary'"
          @click="choose(entry)"
        >
          {{ entry.label }}<template v-if="entry.primary && secondsLeft != null"> ({{ secondsLeft }} s)</template>
        </BaseButton>
      </div>

      <p class="relaunch-countdown">
        <template v-if="secondsLeft != null">
          Runs by itself in {{ secondsLeft }} s. Move the mouse or press a key to stop the countdown.
        </template>
        <template v-else>Waiting for your choice. The channel stays as it is until then.</template>
      </p>
    </div>
  </BaseModal>
</template>

<style scoped>
.relaunch-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.relaunch-status {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--status-warning) 40%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--status-warning) 10%, transparent);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
}

.relaunch-status :deep(svg) {
  flex: none;
  color: var(--status-warning);
}

.relaunch-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-2) var(--space-4);
  margin: 0;
  font-size: var(--fs-sm);
}

.relaunch-facts dt {
  color: var(--text-secondary);
}

.relaunch-facts dd {
  margin: 0;
  color: var(--text-primary);
  word-break: break-word;
}

.relaunch-reason {
  color: var(--text-secondary);
}

.relaunch-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  color: var(--status-error);
  font-size: var(--fs-xs);
}

.relaunch-actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-2);
}

.relaunch-countdown {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-xs);
}
</style>
