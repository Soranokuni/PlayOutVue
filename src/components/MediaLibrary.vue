<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useRundownStore } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';
import { draggingItem } from '../composables/useDragState';
import { invoke } from '@tauri-apps/api/core';
import MediaTreeNode from './MediaTreeNode.vue';
import TrimPanel from './TrimPanel.vue';

const store = useRundownStore();
const settings = useSettingsStore();

const showTrimPanel = ref(false);
const trimLibraryItem = ref<{ path: string, filename: string, type: string, duration?: number } | null>(null);

interface MediaNode {
    name: string;
    path: string;
    type: 'file' | 'folder';
    mediaType?: 'video' | 'live' | 'graphic';
    duration?: number;
    duration_ms?: number;
    children?: MediaNode[];
    expanded?: boolean;
}

const tree = ref<MediaNode[]>([]);
const isScanning = ref(false);
const streamUrl = ref('');
const isExtracting = ref(false);

const contextMenu = ref({
    show: false, x: 0, y: 0, node: null as MediaNode | null
});

const buildTree = async (dirPath: string): Promise<MediaNode[]> => {
    const rootNodes: MediaNode[] = [];
    try {
        const files = await invoke<{ filename: string, path: string, media_type: string, duration: number, duration_ms?: number }[]>(
            'scan_directory', { path: dirPath }
        );

        const normalizedDir = dirPath.replace(/\\/g, '/');

        for (const f of files) {
            const normalizedFilePath = f.path.replace(/\\/g, '/');
            let relPath = normalizedFilePath;
            
            if (normalizedFilePath.startsWith(normalizedDir)) {
                relPath = normalizedFilePath.substring(normalizedDir.length);
            }
            if (relPath.startsWith('/')) relPath = relPath.substring(1);

            const parts = relPath.split('/');
            let currentLevel = rootNodes;
            
            for (let i = 0; i < parts.length; i++) {
                const partName = parts[i];
                const isFile = i === parts.length - 1;
                
                if (isFile) {
                    currentLevel.push({
                        name: f.filename || partName || '',
                        path: f.path || '',
                        type: 'file',
                        mediaType: f.media_type as any,
                        duration: f.duration || 0,
                        duration_ms: f.duration_ms || (f.duration ? f.duration * 1000 : 0)
                    });
                } else {
                    let folder = currentLevel.find((n: MediaNode) => n.type === 'folder' && n.name === partName);
                    if (!folder) {
                        folder = {
                            name: partName || 'Folder',
                            path: '',
                            type: 'folder',
                            children: [],
                            expanded: false
                        };
                        currentLevel.push(folder);
                    }
                    if (!folder.children) folder.children = [];
                    currentLevel = folder.children as MediaNode[];
                }
            }
        }
        
        const sortNodes = (nodes: MediaNode[]) => {
            nodes.sort((a, b) => {
                if (!a || !b) return 0;
                if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
                return (a.name || '').localeCompare(b.name || '');
            });
            nodes.forEach((n: MediaNode) => {
                if (n && n.children) sortNodes(n.children as MediaNode[]);
            });
        };
        sortNodes(rootNodes);

    } catch (e) {
        console.warn('[Library] buildTree scan failed:', e);
    }
    return rootNodes;
};

const rescanLibrary = async () => {
    isScanning.value = true;
    tree.value = [];
    try {
        const nodes = await buildTree(settings.localMediaPath || '');
        nodes.push({ name: 'Live Desk Cam', path: '1', type: 'file', mediaType: 'live' });
        nodes.push({ name: 'External_Network_Stream.m3u8', path: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', type: 'file', mediaType: 'video' });
        tree.value = nodes;
    } catch (e) {
        console.warn('[Library] rescanLibrary failed:', e);
        tree.value = [
            { name: '⚠ Set media folder in ⚙️ Settings', path: '', type: 'file', mediaType: 'video' },
            { name: 'Live Desk Cam', path: '1', type: 'file', mediaType: 'live' }
        ];
    } finally {
        isScanning.value = false;
    }
};

watch(() => settings.localMediaPath, rescanLibrary);

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

const onDragStart = (event: DragEvent, node: MediaNode) => {
    draggingItem.value = {
        filename: node.name,
        path: node.path,
        type: node.mediaType || 'video',
        duration: node.duration || 0, seek: 0, length: 0
    };
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
};

const addItem = (node: MediaNode) => {
    store.addItem({ filename: node.name, path: node.path, type: node.mediaType || 'video', duration: node.duration || 0, seek: 0, length: 0 });
};

// --- Context Menu Options ---
const onContextMenu = (event: MouseEvent, node: MediaNode) => {
    if (node.type !== 'file' || !node.path) return;
    contextMenu.value = { show: true, x: event.clientX, y: event.clientY, node };
};

const closeContextMenu = () => {
    contextMenu.value.show = false;
};

const openTrimPanel = () => {
    if (contextMenu.value.node) {
        trimLibraryItem.value = {
            path: contextMenu.value.node.path,
            filename: contextMenu.value.node.name,
            type: contextMenu.value.node.mediaType || 'video',
            duration: contextMenu.value.node.duration || 0
        };
        showTrimPanel.value = true;
    }
    closeContextMenu();
};

const appendNode = () => {
    if (contextMenu.value.node) addItem(contextMenu.value.node);
    closeContextMenu();
};

const insertNode = () => {
    if (contextMenu.value.node) {
        const item = {
            filename: contextMenu.value.node.name,
            path: contextMenu.value.node.path,
            type: contextMenu.value.node.mediaType || 'video',
            duration: contextMenu.value.node.duration || 0,
            seek: 0, length: 0
        };
        if (store.selectedItemId) {
            const idx = store.activeItems.findIndex((i: any) => i.id === store.selectedItemId);
            if (idx >= 0) {
                const uuid = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
                const completeItem = { ...item, id: uuid } as any;
                store.activeItems.splice(idx + 1, 0, completeItem);
                closeContextMenu();
                return;
            }
        }
        store.addItem(item);
    }
    closeContextMenu();
};

onMounted(() => {
    rescanLibrary();
    window.addEventListener('click', closeContextMenu);
});
onUnmounted(() => {
    window.removeEventListener('click', closeContextMenu);
});
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
    <div class="lib-tree custom-scroll" @contextmenu.prevent>
      <div v-if="isScanning" class="lib-empty">⌛ Scanning…</div>
      <div v-else-if="tree.length === 0" class="lib-empty">📂 No media found.<br><small>Set folder in ⚙️ Settings</small></div>

      <MediaTreeNode
        v-for="node in tree"
        :key="node.path || node.name"
        :node="node"
        @dragstart="onDragStart"
        @dblclick="addItem"
        @contextmenu="onContextMenu"
      />
    </div>

    <!-- Web Stream Ingest -->
    <div class="lib-stream-bar">
      <label class="text-secondary" style="font-size:0.7rem; margin-bottom:3px; display:block;">Web Stream (HLS / YouTube)</label>
      <div style="display:flex; gap:6px;">
        <input class="glass-input" v-model="streamUrl" placeholder="https://…" style="flex:1; font-size:0.78rem; padding:4px 8px;">
        <button class="icon-action" @click="addWebStream" :disabled="isExtracting">{{ isExtracting ? '⌛' : '＋' }}</button>
      </div>
    </div>

    <!-- Custom Context Menu -->
    <Teleport to="body">
      <div v-if="contextMenu.show" class="context-menu" :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }">
        <div class="menu-item" @click.stop="appendNode">Append to Rundown</div>
        <div class="menu-item" @click.stop="insertNode">Insert After Selected</div>
        <div class="menu-divider"></div>
        <div class="menu-item" @click.stop="openTrimPanel">✂️ Trim & Extract...</div>
        <div class="menu-divider"></div>
        <div class="menu-item" @click.stop="closeContextMenu">Cancel</div>
      </div>
    </Teleport>

    <!-- Trim Panel Modal -->
    <Teleport to="body">
      <TrimPanel 
        :is-open="showTrimPanel" 
        :library-item="trimLibraryItem"
        @close="showTrimPanel = false; trimLibraryItem = null" 
      />
    </Teleport>
  </div>
</template>

<style scoped>
.lib-wrap { height:100%; display:flex; flex-direction:column; overflow:hidden; position: relative; }
.lib-header {
    display:flex; justify-content:space-between; align-items:center;
    padding:6px 10px; border-bottom:1px solid var(--glass-border); flex-shrink:0;
}
.lib-tree { flex:1; overflow-y:auto; padding:4px; min-height:0; }
.lib-empty { color:rgba(255,255,255,0.25); font-size:0.78rem; text-align:center; padding:20px 10px; line-height:1.6; }
.lib-stream-bar { padding:8px; border-top:1px solid rgba(255,255,255,0.06); flex-shrink:0; }
.glass-input {
    background:var(--bg-tertiary); border:1px solid var(--glass-border);
    color:var(--text-primary); border-radius:4px; font-size:0.8rem; padding:5px 8px;
}
.icon-action {
    background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);
    color:var(--text-primary); border-radius:4px; cursor:pointer; padding:4px 8px; font-size:0.82rem; transition:0.15s;
}
.icon-action:hover { background:rgba(255,255,255,0.1); }
.icon-action:disabled { opacity:0.4; cursor:not-allowed; }

/* Context Menu */
.context-menu {
    position: fixed;
    background: var(--bg-secondary);
    border: 1px solid var(--glass-border);
    border-radius: 6px;
    padding: 4px 0;
    min-width: 160px;
    z-index: 9999;
    box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    backdrop-filter: blur(10px);
}
.menu-item {
    padding: 6px 12px;
    font-size: 0.8rem;
    color: var(--text-primary);
    cursor: pointer;
    transition: background 0.1s;
}
.menu-item:hover {
    background: rgba(51, 190, 204, 0.2);
    color: #33becc;
}
.menu-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.1);
    margin: 4px 0;
}
</style>
