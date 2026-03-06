<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useRundownStore, type RundownItem } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';
import { draggingItem } from '../composables/useDragState';
import { invoke } from '@tauri-apps/api/core';

const store = useRundownStore();
const settings = useSettingsStore();

interface MediaNode {
    name: string;
    path: string;
    type: 'file' | 'folder';
    mediaType?: 'video' | 'live' | 'graphic';
    duration?: number; // seconds
    duration_ms?: number; // from rust DiscoveredMedia
    children?: MediaNode[];
    expanded?: boolean;
}

const tree = ref<MediaNode[]>([]);
const isScanning = ref(false);
const streamUrl = ref('');
const isExtracting = ref(false);

const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'mxf', 'avi', 'webm'];

const buildTree = async (dirPath: string): Promise<MediaNode[]> => {
    const nodes: MediaNode[] = [];
    try {
        // Get files + subdirectories
        const files = await invoke<{ filename: string, path: string, media_type: string, duration: number }[]>(
            'scan_directory', { path: dirPath }
        );
        for (const f of files) {
            nodes.push({ name: f.filename, path: f.path, type: 'file', mediaType: f.media_type as any, duration: f.duration || 0 });
        }
    } catch { /* ignore unreadable dirs */ }
    return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
};

const rescanLibrary = async () => {
    isScanning.value = true;
    tree.value = [];
    try {
        const nodes = await buildTree(settings.localMediaPath || '');
        // Add static items
        nodes.push({ name: 'Live Desk Cam', path: '1', type: 'file', mediaType: 'live' });
        nodes.push({ name: 'External_Network_Stream.m3u8', path: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', type: 'file', mediaType: 'video' });
        tree.value = nodes;
    } catch (e) {
        console.warn('[Library] Scan failed:', e);
        tree.value = [
            { name: '⚠ Set media folder in ⚙️ Settings', path: '', type: 'file', mediaType: 'video' },
            { name: 'Live Desk Cam', path: '1', type: 'file', mediaType: 'live' }
        ];
    } finally {
        isScanning.value = false;
    }
};

watch(() => settings.localMediaPath, rescanLibrary);
onMounted(rescanLibrary);

const addWebStream = async () => {
    if (!streamUrl.value) return;
    isExtracting.value = true;
    try {
        const rawUrl = await invoke<string>('extract_web_stream', { url: streamUrl.value });
        tree.value.push({ name: 'Web Stream', path: rawUrl, type: 'file', mediaType: 'video' });
        streamUrl.value = '';
    } catch (e) { console.error('Stream extraction failed:', e); }
    finally { isExtracting.value = false; }
};

// Drag
const onDragStart = (event: DragEvent, node: MediaNode) => {
    draggingItem.value = {
        filename: node.name,
        path: node.path,
        type: node.mediaType || 'video',
        duration: node.duration || 0, seek: 0, length: 0
    };
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
};

// Double click = add directly
const addItem = (node: MediaNode) => {
    store.addItem({ filename: node.name, path: node.path, type: node.mediaType || 'video', duration: node.duration || 0, seek: 0, length: 0 });
};

const typeIcon = (type?: string) => ({ video: '🎬', live: '📹', graphic: '🎨' }[type || ''] || '📄');

const fmtDur = (sec: number) => {
    if (!sec) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
};
</script>

<template>
  <div class="lib-wrap">
    <!-- Header -->
    <div class="lib-header">
      <span class="text-accent" style="font-size:0.9rem; font-weight:600;">Library</span>
      <button class="icon-action" @click="rescanLibrary" :disabled="isScanning" :title="isScanning ? 'Scanning…' : 'Rescan'">
        {{ isScanning ? '⌛' : '↻' }}
      </button>
    </div>

    <!-- File Tree -->
    <div class="lib-tree custom-scroll">
      <div v-if="isScanning" class="lib-empty">⌛ Scanning…</div>
      <div v-else-if="tree.length === 0" class="lib-empty">📂 No media found.<br><small>Set folder in ⚙️ Settings</small></div>

      <div
        v-for="node in tree"
        :key="node.path || node.name"
        class="lib-row"
        :draggable="node.type === 'file' && !!node.path"
        @dragstart="node.type === 'file' && onDragStart($event, node)"
        @dblclick="node.type === 'file' && addItem(node)"
        :title="node.type === 'file' ? 'Drag or double-click to add' : ''"
      >
        <span class="lib-icon">{{ typeIcon(node.mediaType) }}</span>
        <span class="lib-name" :class="{ 'lib-name-dim': !node.path }" style="flex:1">{{ node.name }}</span>
        <span v-if="node.duration_ms" class="lib-duration">{{ msToTC(node.duration_ms) }}</span>
      </div>
    </div>

    <!-- Web Stream Ingest -->
    <div class="lib-stream-bar">
      <label class="text-secondary" style="font-size:0.7rem; margin-bottom:3px; display:block;">Web Stream (HLS / YouTube)</label>
      <div style="display:flex; gap:6px;">
        <input class="glass-input" v-model="streamUrl" placeholder="https://…" style="flex:1; font-size:0.78rem; padding:4px 8px;">
        <button class="icon-action" @click="addWebStream" :disabled="isExtracting">{{ isExtracting ? '⌛' : '＋' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lib-wrap { height:100%; display:flex; flex-direction:column; overflow:hidden; }
.lib-header {
    display:flex; justify-content:space-between; align-items:center;
    padding:6px 10px; border-bottom:1px solid var(--glass-border); flex-shrink:0;
}
.lib-tree { flex:1; overflow-y:auto; padding:4px; min-height:0; }
.lib-row {
    display:flex; align-items:center; gap:6px;
    height:32px; padding:0 6px; border-radius:5px; cursor:grab; user-select:none;
    border:1px solid transparent; transition:background 0.12s;
}
.lib-row:hover { background:rgba(255,255,255,0.06); }
.lib-row:active { cursor:grabbing; }
.lib-icon { font-size:0.85rem; flex-shrink:0; }
.lib-name { font-size:0.78rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.lib-name-dim { color:rgba(255,165,0,0.7); font-size:0.72rem; }
.lib-duration { font-size:0.68rem; color:var(--text-secondary); font-variant-numeric: tabular-nums; flex-shrink:0; }
.lib-empty { color:rgba(255,255,255,0.25); font-size:0.78rem; text-align:center; padding:20px 10px; line-height:1.6; }
.lib-stream-bar { padding:8px; border-top:1px solid rgba(255,255,255,0.06); flex-shrink:0; }
.glass-input {
    background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.1);
    color:var(--text-primary); border-radius:4px; font-size:0.8rem; padding:5px 8px;
}
.icon-action {
    background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);
    color:var(--text-primary); border-radius:4px; cursor:pointer; padding:4px 8px; font-size:0.82rem; transition:0.15s;
}
.icon-action:hover { background:rgba(255,255,255,0.1); }
.icon-action:disabled { opacity:0.4; cursor:not-allowed; }
</style>
