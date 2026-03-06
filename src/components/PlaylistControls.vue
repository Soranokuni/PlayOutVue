<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRundownStore } from '../stores/rundown';
import { invoke } from '@tauri-apps/api/core';

const store = useRundownStore();
const emit = defineEmits(['save', 'load', 'append']);

const isSaving = ref(false);
const isLoading = ref(false);

// Helper to format total rundown duration
const totalStr = computed(() => {
    const t = store.totalDuration;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    return `${h ? h + 'h ' : ''}${m ? m + 'm ' : ''}${s}s`;
});

const savePlaylist = async () => {
    isSaving.value = true;
    try {
        const name = prompt('Playlist name?', 'Rundown') || 'Rundown';
        const data = store.serializeRundown(name);
        const json = JSON.stringify(data, null, 2);
        // Use a simple path prompt for now (Tauri file dialog plugin would be ideal)
        const path = prompt('Save path (e.g. C:/Playlists/show.playout)?', 'C:/Playlists/rundown.playout');
        if (!path) return;
        await invoke('save_playlist', { path, json });
        alert(`✅ Saved to: ${path}`);
    } catch (e) {
        alert(`❌ Save failed: ${e}`);
    } finally {
        isSaving.value = false;
    }
};

const loadPlaylist = async (append = false) => {
    isLoading.value = true;
    try {
        const path = prompt(append ? 'Append from path:' : 'Load from path:', 'C:/Playlists/rundown.playout');
        if (!path) return;
        const json = await invoke<string>('load_playlist', { path });
        const data = JSON.parse(json);
        store.deserializeRundown(data, append);
    } catch (e) {
        alert(`❌ Load failed: ${e}`);
    } finally {
        isLoading.value = false;
    }
};
</script>

<template>
  <div class="playlist-bar">
    <div class="pl-info">
      <span class="text-secondary" style="font-size:0.72rem;">{{ store.activeItems.length }} items</span>
      <span class="text-secondary" style="font-size:0.72rem;">{{ totalStr }}</span>
    </div>
    <div class="pl-buttons">
      <button class="pl-btn" @click="savePlaylist" :disabled="isSaving" title="Save Playlist">💾</button>
      <button class="pl-btn" @click="loadPlaylist(false)" :disabled="isLoading" title="Load Playlist">📂</button>
      <button class="pl-btn" @click="loadPlaylist(true)" :disabled="isLoading" title="Append Playlist">➕</button>
      <button class="pl-btn btn-danger" @click="store.clearRundown()" title="Clear Rundown">🗑</button>
    </div>
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
