<script setup lang="ts">
import { ref, computed } from 'vue';
import { useStorage } from '@vueuse/core';
import { useRundownStore } from '../stores/rundown';
import { invoke } from '@tauri-apps/api/core';
import FileBrowserModal from './FileBrowserModal.vue';

const store = useRundownStore();
const emit = defineEmits(['save', 'load', 'append']);

const isSaving = ref(false);
const isLoading = ref(false);
const statusMessage = ref('Ready');
const statusTone = ref<'info' | 'error'>('info');
const browserMode = ref<'open-file' | 'save-file' | null>(null);
const browserAction = ref<'load' | 'append' | 'save'>('load');
const lastPlaylistDirectory = useStorage('playlist.lastDirectory', 'C:/Playlists');
const suggestedName = computed(() => 'rundown.playout');

const setStatus = (message: string, tone: 'info' | 'error' = 'info') => {
    statusMessage.value = message;
    statusTone.value = tone;
};

// Helper to format total rundown duration
const totalStr = computed(() => {
    const t = store.totalDuration;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    return `${h ? h + 'h ' : ''}${m ? m + 'm ' : ''}${s}s`;
});

const openBrowser = (action: 'load' | 'append' | 'save') => {
    browserAction.value = action;
    browserMode.value = action === 'save' ? 'save-file' : 'open-file';
};

const closeBrowser = () => {
    browserMode.value = null;
};

const savePlaylist = async (path: string) => {
    isSaving.value = true;
    try {
        const name = path.split(/[\\/]/).pop()?.replace(/\.playout$/i, '') || 'Rundown';
        const data = store.serializeRundown(name);
        const json = JSON.stringify(data, null, 2);
        await invoke('save_playlist', { path, json });
        lastPlaylistDirectory.value = path.replace(/[\\/][^\\/]+$/, '');
        setStatus(`Saved playlist to ${path}`);
    } catch (e) {
        setStatus(`Save failed: ${e}`, 'error');
    } finally {
        isSaving.value = false;
    }
};

const loadPlaylist = async (path: string, append = false) => {
    isLoading.value = true;
    try {
        const json = await invoke<string>('load_playlist', { path });
        const data = JSON.parse(json);
        store.deserializeRundown(data, append);
        lastPlaylistDirectory.value = path.replace(/[\\/][^\\/]+$/, '');
        setStatus(`${append ? 'Appended' : 'Loaded'} playlist from ${path}`);
    } catch (e) {
        setStatus(`Load failed: ${e}`, 'error');
    } finally {
        isLoading.value = false;
    }
};

const clearRundown = () => {
    if (!store.activeItems.length) {
        setStatus('Rundown is already empty');
        return;
    }

    if (window.confirm(`Clear ${store.activeItems.length} rundown item${store.activeItems.length === 1 ? '' : 's'}?`)) {
        store.clearRundown();
        setStatus('Cleared rundown');
    }
};

const handleBrowserSelect = async (path: string) => {
    closeBrowser();
    if (browserAction.value === 'save') {
        await savePlaylist(path);
        return;
    }

    await loadPlaylist(path, browserAction.value === 'append');
};
</script>

<template>
  <div class="playlist-bar">
    <div class="pl-info">
      <span class="text-secondary" style="font-size:0.72rem;">{{ store.activeItems.length }} items</span>
      <span class="text-secondary" style="font-size:0.72rem;">{{ totalStr }}</span>
            <span class="pl-status" :class="{ 'is-error': statusTone === 'error' }">{{ statusMessage }}</span>
    </div>
    <div class="pl-buttons">
            <button class="pl-btn" @click="openBrowser('save')" :disabled="isSaving" title="Save Playlist">💾</button>
            <button class="pl-btn" @click="openBrowser('load')" :disabled="isLoading" title="Load Playlist">📂</button>
            <button class="pl-btn" @click="openBrowser('append')" :disabled="isLoading" title="Append Playlist">➕</button>
            <button class="pl-btn btn-danger" @click="clearRundown" title="Clear Rundown">🗑</button>
    </div>

        <FileBrowserModal
            v-if="browserMode"
            :is-open="!!browserMode"
            :title="browserAction === 'save' ? 'Save Playlist' : browserAction === 'append' ? 'Append Playlist' : 'Load Playlist'"
            :description="browserAction === 'save' ? 'Choose a folder and save a .playout playlist.' : 'Browse playlists stored on disk.'"
            :mode="browserMode"
            :start-path="lastPlaylistDirectory"
            :extensions="['playout', 'json']"
            :default-file-name="suggestedName"
            @close="closeBrowser"
            @select="handleBrowserSelect"
        />
  </div>
</template>

<style scoped>
.playlist-bar {
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 8px;
    background: rgba(0,0,0,0.2);
    border-top: 1px solid rgba(255,255,255,0.06);
}
.pl-info { display:flex; gap:12px; }
.pl-status {
    color: var(--text-secondary);
    font-size: 0.72rem;
    max-width: 220px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.pl-status.is-error { color: #fca5a5; }
.pl-buttons { display:flex; gap:4px; }
.pl-btn {
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
    color: var(--text-primary); border-radius:4px; cursor:pointer; padding:4px 8px;
    font-size:0.9rem; transition:0.15s;
}
.pl-btn:hover { background:rgba(255,255,255,0.1); }
.pl-btn:disabled { opacity:0.4; cursor:not-allowed; }
.btn-danger { border-color:rgba(230,57,70,0.3); }
.btn-danger:hover { background:rgba(230,57,70,0.15); }
</style>
