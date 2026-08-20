<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useRundownStore, type PlaylistFile, type AnyPlaylistFile } from '../stores/rundown';

const store = useRundownStore();

const isSaving = ref(false);
const isLoading = ref(false);
const statusMessage = ref('Ready');
const statusTone = ref<'info' | 'error'>('info');
const lastPlaylistDirectory = useStorage('playlist.lastDirectory', 'C:/Playlists');
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

const suggestedName = computed(() => `${store.currentPlaylistName || 'rundown'}.plx`);
const playlistStateLabel = computed(() => (store.isCurrentPlaylistOnAir ? 'ON AIR' : 'OFFLINE'));

const totalStr = computed(() => {
    const total = store.totalDuration;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds}s`;
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

const setStatus = (message: string, tone: 'info' | 'error' = 'info') => {
    statusMessage.value = message;
    statusTone.value = tone;
};

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

const joinDialogPath = (base: string, fileName: string) => {
    if (!base) return fileName;
    const separator = /[\\/]$/.test(base) ? '' : '/';
    return `${base}${separator}${fileName}`;
};

const ensurePlaylistExtension = (path: string) => (
    /\.(plx|playout|json)$/i.test(path) ? path : `${path}.plx`
);

const parseLegacyPathList = (raw: string, fallbackName: string): PlaylistFile => {
    const toFilename = (filepath: string) => {
        const normalized = filepath.replace(/\\/g, '/');
        return normalized.split('/').pop() || filepath;
    };

    const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => !!line && !line.startsWith('#') && !line.startsWith(';'));

    return {
        version: '1.1',
        name: fallbackName,
        created: Date.now(),
        items: lines.map((path) => ({
            type: 'video',
            path,
            shortPath: path,
            filename: toFilename(path),
            libraryIndicator: 'none',
            duration: 0,
            seek: 0,
            length: 0,
            inPoint: 0,
            outPoint: 0,
            plannedDuration: 0,
            note: '',
            complianceRating: 'none',
            complianceDescriptors: [],
            complianceText: ''
        }))
    };
};

const parsePlaylistPayload = (raw: string, path: string): AnyPlaylistFile => {
    try {
        return JSON.parse(raw) as AnyPlaylistFile;
    } catch {
        const fallbackName = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Imported';
        return parseLegacyPathList(raw, fallbackName);
    }
};

const savePlaylist = async (path: string) => {
    isSaving.value = true;
    try {
        const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || store.currentPlaylistName || 'Rundown';
        const data = store.serializeRundown(name);
        const json = JSON.stringify(data);
        await invoke('save_playlist', { path, json });
        lastPlaylistDirectory.value = path.replace(/[\\/][^\\/]+$/, '');
        setStatus(`Saved ${store.currentPlaylistName} to ${path}`);
    } catch (error) {
        setStatus(`Save failed: ${error}`, 'error');
    } finally {
        isSaving.value = false;
    }
};

const loadPlaylist = async (path: string, append = false) => {
    isLoading.value = true;
    try {
        const json = await invoke<string>('load_playlist', { path });
        const data = parsePlaylistPayload(json, path);
        store.deserializeRundown(data, append);
        lastPlaylistDirectory.value = path.replace(/[\\/][^\\/]+$/, '');
        setStatus(`${append ? 'Appended' : 'Loaded'} playlist from ${path}`);
    } catch (error) {
        setStatus(`Load failed: ${error}`, 'error');
    } finally {
        isLoading.value = false;
    }
};

const clearRundown = async () => {
    if (!store.activeItems.length) {
        setStatus('Playlist is already empty');
        return;
    }

    const confirmed = await ask(
        `Clear ${store.activeItems.length} item${store.activeItems.length === 1 ? '' : 's'} from ${store.currentPlaylistName}?`,
        { title: 'Clear Playlist', kind: 'warning' }
    );
    if (!confirmed) return;

    store.clearRundown();
    setStatus(`Cleared ${store.currentPlaylistName}`);
};

const addGapLine = () => {
    if (!store.canScheduleCurrentPlaylist) {
        setStatus('Gap lines are only available on offline playlists.', 'error');
        return;
    }

    const suggested = store.currentPlaylistStartFrom || '16:00';
    const value = window.prompt('Insert gap line at time (HH:MM or HH:MM:SS)', suggested);
    if (!value) return;

    const inserted = store.addGapMarker(value);
    if (!inserted) {
        setStatus('Use a valid time like 16:45 or 16:45:00.', 'error');
        return;
    }

    setStatus(`Inserted gap line at ${value}`);
};

const pickPlaylistPath = async (action: 'save' | 'load' | 'append') => {
    if (action === 'save') {
        const selection = await save({
            title: 'Save Playlist',
            defaultPath: joinDialogPath(lastPlaylistDirectory.value, suggestedName.value),
            filters: [{ name: 'PlayOut Optimized Playlist', extensions: ['plx'] }]
        });

        if (!selection) return;
        await savePlaylist(ensurePlaylistExtension(selection));
        return;
    }

    const selection = await open({
        title: action === 'append' ? 'Append Playlist' : 'Load Playlist',
        multiple: false,
        defaultPath: lastPlaylistDirectory.value || undefined,
        filters: [{ name: 'PlayOut Playlists', extensions: ['plx', 'playout', 'json', 'txt', 'lst'] }]
    });

    if (!selection || Array.isArray(selection)) return;
    await loadPlaylist(selection, action === 'append');
};
</script>

<template>
  <div class="playlist-bar">
    <div class="pl-info">
      <span class="pl-name">{{ store.currentPlaylistName }}</span>
      <span class="pl-state-pill" :class="{ 'is-onair': store.isCurrentPlaylistOnAir }">{{ playlistStateLabel }}</span>
      <span class="pl-meta-text">{{ store.activeItems.length }} items</span>
      <span class="pl-meta-text tabular-nums">{{ totalStr }}</span>
      <span class="pl-status" :class="{ 'is-error': statusTone === 'error' }">{{ statusMessage }}</span>
    </div>

    <div class="pl-planning" :class="{ 'is-disabled': !store.canScheduleCurrentPlaylist }">
      <select v-model="weekdayProxy" class="pl-day-select" :disabled="!store.canScheduleCurrentPlaylist" title="Offline start day">
        <option v-for="option in weekdayOptions" :key="option.value" :value="String(option.value)">{{ option.label }}</option>
      </select>
      <label class="pl-label">Start</label>
      <input
        v-model="startFromDraft"
        class="pl-time-input"
        type="text"
        inputmode="numeric"
        placeholder="HH:MM[:SS]"
        maxlength="8"
        :disabled="!store.canScheduleCurrentPlaylist"
        @blur="commitStartFrom"
        @keydown.enter.prevent="commitStartFrom"
      >
      <button class="pl-btn" @click="addGapLine" :disabled="!store.canScheduleCurrentPlaylist" title="Insert offline gap line">⏱</button>
    </div>

    <div class="pl-buttons">
      <button class="pl-btn" @click="pickPlaylistPath('save')" :disabled="isSaving" title="Save Playlist">💾</button>
      <button class="pl-btn" @click="pickPlaylistPath('load')" :disabled="isLoading" title="Load Playlist">📂</button>
      <button class="pl-btn" @click="pickPlaylistPath('append')" :disabled="isLoading" title="Append Playlist">➕</button>
      <button class="pl-btn btn-danger" @click="clearRundown" title="Clear Rundown">🗑</button>
    </div>
  </div>
</template>

<style scoped>
.playlist-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-subtle);
  pointer-events: auto;
  position: relative;
  z-index: 10;
  flex-shrink: 0;
}

.pl-info {
  display: flex;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
}

.pl-name {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text-primary);
}

.pl-state-pill {
  font-size: 0.64rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-hover);
  border: 1px solid var(--border-medium);
  color: var(--text-secondary);
}

.pl-state-pill.is-onair {
  background: color-mix(in srgb, var(--accent-red) 18%, transparent);
  border-color: var(--accent-red);
  color: var(--accent-red);
}

.pl-meta-text {
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.pl-status {
  color: var(--text-muted);
  font-size: 0.76rem;
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pl-status.is-error {
  color: var(--accent-red);
  font-weight: 700;
}

.pl-planning {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.pl-planning.is-disabled {
  opacity: 0.55;
}

.pl-label {
  font-size: 0.72rem;
  color: var(--text-muted);
  text-transform: uppercase;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.pl-day-select,
.pl-time-input {
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  color: var(--text-primary);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 0.82rem;
}

.pl-day-select:focus,
.pl-time-input:focus {
  border-color: var(--accent-blue);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent-blue) 25%, transparent);
}

.pl-buttons {
  display: flex;
  gap: 4px;
}

.pl-btn {
  background: var(--bg-hover);
  border: 1px solid var(--border-medium);
  color: var(--text-primary);
  border-radius: 6px;
  cursor: pointer;
  padding: 4px 10px;
  font-size: 0.92rem;
  transition: 0.15s;
}

.pl-btn:hover {
  background: var(--bg-surface-elevated);
  border-color: var(--border-strong);
}

.pl-day-select {
  min-width: 68px;
}

.pl-time-input {
  width: 96px;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}

.pl-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.btn-danger {
  border-color: color-mix(in srgb, var(--accent-red) 40%, transparent);
  color: var(--accent-red);
}

.btn-danger:hover {
  background: color-mix(in srgb, var(--accent-red) 16%, transparent);
  border-color: var(--accent-red);
}
</style>
