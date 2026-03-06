<script setup lang="ts">
import { computed } from 'vue';

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

const props = defineProps<{
    node: MediaNode;
    depth?: number;
}>();

const emit = defineEmits<{
    (e: 'dragstart', event: DragEvent, node: MediaNode): void;
    (e: 'dblclick', node: MediaNode): void;
    (e: 'contextmenu', event: MouseEvent, node: MediaNode): void;
}>();

const currentDepth = computed(() => props.depth || 0);

const toggleFolder = () => {
    if (props.node.type === 'folder') {
        const n = props.node;
        n.expanded = !n.expanded;
    }
};

const typeIcon = (type?: string, isFolder?: boolean, expanded?: boolean) => {
    if (isFolder) return expanded ? '📂' : '📁';
    return { video: '🎬', live: '📹', graphic: '🎨' }[type || ''] || '📄';
};

const fmtDur = (sec: number) => {
    if (!sec) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
};

const handleDragStart = (e: DragEvent) => {
    if (props.node.type === 'file') emit('dragstart', e, props.node);
};
</script>

<template>
  <div class="tree-node-wrapper">
    <div
      class="lib-row"
      :class="{ 'is-folder': node.type === 'folder' }"
      :style="{ paddingLeft: (currentDepth * 12 + 6) + 'px' }"
      :draggable="node.type === 'file' && !!node.path"
      @dragstart="handleDragStart"
      @dblclick="node.type === 'file' ? emit('dblclick', node) : toggleFolder()"
      @click="node.type === 'folder' && toggleFolder()"
      @contextmenu.prevent="emit('contextmenu', $event, node)"
      :title="node.type === 'file' ? 'Drag or double-click to add' : 'Click to toggle'"
    >
      <span class="lib-icon" style="margin-right:0px;">
        <span v-if="node.type === 'folder'" class="folder-carat">{{ node.expanded ? '▼' : '▶' }}</span>
        {{ typeIcon(node.mediaType, node.type === 'folder', node.expanded) }}
      </span>
      <span class="lib-name" :class="{ 'lib-name-dim': !node.path }" style="flex:1">{{ node.name }}</span>
      <span v-if="node.duration_ms" class="lib-duration">{{ fmtDur(node.duration_ms / 1000) }}</span>
      <span v-else-if="node.type === 'file' && node.duration" class="lib-duration">{{ fmtDur(node.duration) }}</span>
    </div>
    
    <div v-if="node.type === 'folder' && node.expanded" class="children-wrapper">
      <MediaTreeNode
        v-for="child in node.children"
        :key="child.path || child.name"
        :node="child"
        :depth="currentDepth + 1"
        @dragstart="(e, n) => emit('dragstart', e, n)"
        @dblclick="(n) => emit('dblclick', n)"
        @contextmenu="(e, n) => emit('contextmenu', e, n)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-node-wrapper { display: flex; flex-direction: column; }
.lib-row {
    display:flex; align-items:center; gap:6px;
    height:32px; padding:0 6px; border-radius:5px; user-select:none;
    border:1px solid transparent; transition:background 0.12s; cursor:pointer;
}
.lib-row:hover { background:rgba(255,255,255,0.06); }
.lib-row[draggable="true"] { cursor:grab; }
.lib-row[draggable="true"]:active { cursor:grabbing; }
.lib-icon { font-size:0.85rem; flex-shrink:0; display:flex; align-items:center; gap:4px; }
.folder-carat { font-size: 0.55rem; color: rgba(255,255,255,0.4); width: 12px; display:inline-block; text-align:center;}
.lib-name { font-size:0.78rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.lib-name-dim { color:rgba(255,165,0,0.7); font-size:0.72rem; }
.lib-duration { font-size:0.68rem; color:var(--text-secondary); font-variant-numeric: tabular-nums; flex-shrink:0; }
.children-wrapper { display: flex; flex-direction: column; }
</style>
