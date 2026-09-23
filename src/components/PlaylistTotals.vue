<script setup lang="ts">
import { computed } from 'vue';
import { useRundownStore } from '../stores/rundown';
import { usePlaylistFile } from '../composables/usePlaylistFile';
import { vTooltip } from '../lib/tooltip';

/**
 * The rundown header's subtitle: "10 items · 5h 21m 53s", the same line the
 * library header carries under its title. It used to sit in a strip of its
 * own under the tabs, which on the on-air playlist held nothing else but a
 * sentence saying the schedule controls were not there. Its own component so
 * a duration change re-renders this line, not the header around it.
 */

const store = useRundownStore();
const { statusMessage, statusTone } = usePlaylistFile();

const itemCountLabel = computed(() => {
    const count = store.activeItems.length;
    return `${count} item${count === 1 ? '' : 's'}`;
});

const totalLabel = computed(() => {
    const total = store.totalDuration;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds}s`;
});

const timingNote = computed(() =>
    store.canScheduleCurrentPlaylist
        ? 'Total running time of this playlist'
        : 'Timing follows the transport while this playlist is on air.'
);
</script>

<template>
  <span class="pl-totals" data-testid="playlist-totals">
    <span class="pl-totals-figures" v-tooltip="timingNote">
      {{ itemCountLabel }} · <span class="pl-total tabular-nums">{{ totalLabel }}</span>
    </span>
    <span v-if="statusMessage" class="pl-status" :class="{ 'is-error': statusTone === 'error' }">· {{ statusMessage }}</span>
  </span>
</template>

<style scoped>
.pl-totals {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-tight);
  color: var(--text-secondary);
  white-space: nowrap;
}

.pl-totals-figures {
  flex-shrink: 0;
}

.pl-total {
  font-variant-numeric: tabular-nums;
}

.pl-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pl-status.is-error {
  color: var(--status-error);
  font-weight: var(--fw-bold);
}
</style>
