<script setup lang="ts">
import { vTooltip } from '../lib/tooltip';
import { computed, ref, watch } from 'vue';
import { useRundownStore } from '../stores/rundown';
import { usePlaylistFile } from '../composables/usePlaylistFile';
import AppIcon from './ui/AppIcon.vue';
import BaseButton from './ui/BaseButton.vue';

/**
 * UI/UX plan §6.3 — this used to be a second header: it repeated the playlist
 * name, its ON AIR/OFFLINE pill and the item count that the tab and the rundown
 * header already show, and it owned the four file buttons. The file actions
 * moved to the header overflow (`usePlaylistFile`); what is left is the one
 * thing that lives nowhere else — when an offline playlist is scheduled to
 * start — plus the total it adds up to.
 */

const store = useRundownStore();
const { statusMessage, statusTone, setStatus } = usePlaylistFile();

const startFromDraft = ref('');

const weekdayOptions = [
    { value: 1, label: 'Mon' },
    { value: 2, label: 'Tue' },
    { value: 3, label: 'Wed' },
    { value: 4, label: 'Thu' },
    { value: 5, label: 'Fri' },
    { value: 6, label: 'Sat' },
    { value: 0, label: 'Sun' }
];

const totalStr = computed(() => {
    const total = store.totalDuration;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds}s`;
});

const itemCountLabel = computed(() => {
    const count = store.activeItems.length;
    return `${count} item${count === 1 ? '' : 's'}`;
});

const weekdayProxy = computed({
    get: () => String(store.currentPlaylistStartWeekday),
    set: (value: string) => {
        const nextWeekday = Number.parseInt(value, 10);
        store.currentPlaylistStartWeekday = Number.isFinite(nextWeekday) ? nextWeekday : new Date().getDay();
        const weekdayLabel = weekdayOptions.find((option) => option.value === store.currentPlaylistStartWeekday)?.label || 'Day';
        setStatus(`Offline timing anchored to ${weekdayLabel}`);
    }
});

watch(
    () => [store.activePlaylistId, store.currentPlaylistStartFrom],
    () => {
        startFromDraft.value = store.currentPlaylistStartFrom;
    },
    { immediate: true }
);

const commitStartFrom = () => {
    const previousValue = store.currentPlaylistStartFrom;
    store.currentPlaylistStartFrom = startFromDraft.value;
    startFromDraft.value = store.currentPlaylistStartFrom;

    if (!store.currentPlaylistStartFrom) {
        setStatus('Offline timing anchor cleared');
        return;
    }

    if (store.currentPlaylistStartFrom !== previousValue || startFromDraft.value !== previousValue) {
        setStatus(`Offline timing starts at ${store.currentPlaylistStartFrom}`);
    }
};

// Audit T1-11: `window.prompt` is a browser dialog (forbidden by AGENTS.md
// §5 and unreliable inside WebView2). The gap time is entered inline instead.
const showGapInput = ref(false);
const gapTimeDraft = ref('');

const addGapLine = () => {
    if (!store.canScheduleCurrentPlaylist) {
        setStatus('Gap lines are only available on offline playlists.', 'error');
        return;
    }
    gapTimeDraft.value = store.currentPlaylistStartFrom || '16:00';
    showGapInput.value = true;
};

const cancelGapLine = () => {
    showGapInput.value = false;
    gapTimeDraft.value = '';
};

const commitGapLine = () => {
    const value = gapTimeDraft.value.trim();
    if (!value) {
        cancelGapLine();
        return;
    }
    const inserted = store.addGapMarker(value);
    if (!inserted) {
        setStatus('Use a valid time like 16:45 or 16:45:00.', 'error');
        return;
    }
    setStatus(`Inserted gap line at ${value}`);
    cancelGapLine();
};
</script>

<template>
  <div class="playlist-bar" :class="{ 'is-onair': !store.canScheduleCurrentPlaylist }">
    <!-- §6.3: the schedule controls are meaningless on the on-air playlist,
         which takes its timing from the transport, so they are not rendered
         there at all rather than rendered greyed out. -->
    <div v-if="store.canScheduleCurrentPlaylist" class="pl-schedule">
      <span class="pl-label">Starts</span>
      <select v-model="weekdayProxy" class="pl-day-select" v-tooltip="'Offline start day'" aria-label="Offline start day">
        <option v-for="option in weekdayOptions" :key="option.value" :value="String(option.value)">{{ option.label }}</option>
      </select>
      <input
        v-model="startFromDraft"
        class="pl-time-input"
        type="text"
        inputmode="numeric"
        placeholder="HH:MM[:SS]"
        maxlength="8"
        aria-label="Offline start time"
        @blur="commitStartFrom"
        @keydown.enter.prevent="commitStartFrom"
      >
      <BaseButton
        v-if="!showGapInput"
        variant="secondary"
        size="sm"
        class="pl-btn"
        icon="gap"
        label="Insert a hard start line"
        v-tooltip="'Insert a hard start line'"
        @click="addGapLine"
      >
        <span class="pl-btn-text">Hard start</span>
      </BaseButton>
      <template v-else>
        <input
          v-model="gapTimeDraft"
          class="pl-time-input pl-input--gap"
          type="text"
          inputmode="numeric"
          placeholder="HH:MM[:SS]"
          maxlength="8"
          aria-label="Hard start time"
          autofocus
          @keydown.enter.prevent="commitGapLine"
          @keydown.esc.prevent="cancelGapLine"
        >
        <BaseButton
          variant="secondary"
          size="sm"
          class="pl-btn is-confirm"
          icon="check"
          label="Insert the hard start line at this time"
          v-tooltip="'Insert the hard start line at this time'"
          @click="commitGapLine"
        />
        <BaseButton
          variant="secondary"
          size="sm"
          class="pl-btn"
          icon="close"
          label="Cancel"
          v-tooltip="'Cancel'"
          @click="cancelGapLine"
        />
      </template>
    </div>
    <div v-else class="pl-onair-note">
      <AppIcon name="clock" :size="12" />
      <span>Timing follows the transport while this playlist is on air.</span>
    </div>

    <div class="pl-spacer" />

    <div class="pl-totals">
      <span v-if="statusMessage" class="pl-status" :class="{ 'is-error': statusTone === 'error' }">{{ statusMessage }}</span>
      <span class="pl-meta-text">{{ itemCountLabel }}</span>
      <span class="pl-meta-text pl-total tabular-nums">{{ totalStr }}</span>
    </div>
  </div>
</template>

<style scoped>
.playlist-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-3);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-subtle);
  pointer-events: auto;
  position: relative;
  z-index: var(--z-panel);
  flex-shrink: 0;
  min-height: 32px;
}

.pl-schedule {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.pl-spacer {
  flex: 1;
  min-width: var(--space-2);
}

.pl-totals {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.pl-onair-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}

.pl-meta-text {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}

.pl-total {
  font-family: var(--font-mono);
  color: var(--text-secondary);
  font-weight: var(--fw-semibold);
}

.pl-status {
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  max-width: 320px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pl-status.is-error {
  color: var(--status-error);
  font-weight: var(--fw-bold);
}

.pl-label {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  text-transform: uppercase;
  font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps);
}

.pl-day-select,
.pl-time-input {
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  padding: var(--space-0) var(--space-2);
  font-size: var(--fs-sm);
  height: var(--control-h-sm);
}

.pl-day-select:focus,
.pl-time-input:focus {
  border-color: var(--accent-blue);
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-blue) 28%, transparent);
}

.pl-day-select {
  min-width: 62px;
}

.pl-time-input {
  width: 108px;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}

/* §7.2: a `BaseButton` now. Its surface, border, radius, height, hover, focus,
   press and disabled all come from `.btn--secondary.btn--sm`; what is left is
   the tighter gap this dense strip wants and the confirm tone. */
.pl-btn {
  gap: var(--space-1);
}

.pl-btn.is-confirm {
  color: var(--status-ready);
  border-color: color-mix(in srgb, var(--status-ready) 45%, transparent);
}

@media (max-width: 1280px) {
  .pl-btn-text {
    display: none;
  }
}
</style>
