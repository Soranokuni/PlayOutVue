<script setup lang="ts">
import { computed } from 'vue';
import type { ComplianceRating } from '../stores/rundown';

interface MediaNode {
    name: string;
    path: string;
    type: 'file' | 'folder';
    mediaType?: 'video' | 'live' | 'graphic';
  width?: number;
  height?: number;
  fpsNum?: number;
  fpsDen?: number;
  palCompatible?: boolean;
  defaultComplianceRating?: ComplianceRating;
    duration?: number;
    duration_ms?: number;
    probing?: boolean;
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

  const nodeDurationLabel = computed(() => {
    const seconds = props.node.duration_ms ? props.node.duration_ms / 1000 : (props.node.duration || 0);
    return fmtDur(seconds);
  });

  const nodeStatusLabel = computed(() => {
    if (nodeDurationLabel.value) return nodeDurationLabel.value;
    if (props.node.probing) return 'probing...';
    return '';
  });

const handleDragStart = (e: DragEvent) => {
    if (props.node.type === 'file') emit('dragstart', e, props.node);
};

const formatSpecBadge = (node: MediaNode) => {
  if (node.type !== 'file' || !node.width || !node.height || !node.fpsNum || !node.fpsDen) return '';
  const fps = node.fpsNum / node.fpsDen;
  return `${node.width}×${node.height} · ${Number.isFinite(fps) ? fps.toFixed(fps % 1 === 0 ? 0 : 2) : '0'}fps`;
};

const getVideoBadge = (node: MediaNode) => {
  if (node.type !== 'file' || node.mediaType !== 'video' || !node.width || !node.height || !node.fpsNum || !node.fpsDen) {
    return null;
  }

  const fps = node.fpsNum / node.fpsDen;
  const isNear = (value: number, target: number) => Math.abs(value - target) < 0.05;
  const fpsLabel = Number.isFinite(fps) ? fps.toFixed(Math.abs(fps - Math.round(fps)) < 0.01 ? 0 : 2) : '?';
  const is1080 = (node.width === 1920 || node.width === 1440) && node.height === 1080;
  const is720 = node.width === 1280 && node.height === 720;
  const is576 = node.width === 720 && node.height === 576;
  const isPal = (is1080 || is720 || is576) && (isNear(fps, 25) || isNear(fps, 50));

  if (isPal) {
    return { label: 'PAL', className: 'is-pal' };
  }

  return { label: `${node.height}/${fpsLabel}`, className: 'is-offspec' };
};

const ratingBadgeClass = (rating?: ComplianceRating) => `rating-${rating || 'none'}`;
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
      <span class="lib-text" :class="{ 'is-file': node.type === 'file' }">
        <span class="lib-name" :class="{ 'lib-name-dim': !node.path }">{{ node.name }}</span>
        <span v-if="node.type === 'file' && nodeStatusLabel" class="lib-duration-subline" :class="{ 'is-probing': node.probing && !nodeDurationLabel }">{{ nodeStatusLabel }}</span>
      </span>
      <span v-if="node.defaultComplianceRating && node.defaultComplianceRating !== 'none'" class="lib-badge lib-rating-badge" :class="ratingBadgeClass(node.defaultComplianceRating)">{{ node.defaultComplianceRating.toUpperCase() }}</span>
      <span v-if="getVideoBadge(node)" class="lib-badge" :class="getVideoBadge(node)?.className" :title="formatSpecBadge(node)">{{ getVideoBadge(node)?.label }}</span>
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
  min-height:26px; padding:3px 6px; border-radius:5px; user-select:none;
    border:1px solid transparent; transition:background 0.12s; cursor:pointer;
}
.lib-row:hover { background:rgba(255,255,255,0.06); }
.lib-row[draggable="true"] { cursor:grab; }
.lib-row[draggable="true"]:active { cursor:grabbing; }
.lib-icon { font-size:0.85rem; flex-shrink:0; display:flex; align-items:center; gap:4px; }
.folder-carat { font-size: 0.55rem; color: rgba(255,255,255,0.4); width: 12px; display:inline-block; text-align:center;}
.lib-text { flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; }
.lib-name { font-size:0.7rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.lib-name-dim { color:rgba(255,165,0,0.7); font-size:0.7rem; }
.lib-duration-subline {
  font-size:0.52rem;
  line-height:1.1;
  color:rgba(230,57,70,0.88);
  font-variant-numeric:tabular-nums;
  font-family:monospace;
  margin-top:1px;
}
.lib-duration-subline.is-probing {
  color:rgba(248,180,0,0.86);
  letter-spacing:0.04em;
}
.lib-badge {
  font-size:0.55rem;
  padding:1px 5px;
  border-radius:999px;
  border:1px solid transparent;
  letter-spacing:0.4px;
  flex-shrink:0;
}
.lib-badge.is-pal {
  color:#9ef6cf;
  border-color:rgba(158,246,207,0.35);
  background:rgba(29,185,84,0.15);
}
.lib-badge.is-offspec {
  color:#f8b400;
  border-color:rgba(248,180,0,0.35);
  background:rgba(248,180,0,0.14);
}
.lib-rating-badge.rating-k { color:#9ef6cf; border-color:rgba(158,246,207,0.35); background:rgba(29,185,84,0.15); }
.lib-rating-badge.rating-8 { color:#8cc9ff; border-color:rgba(140,201,255,0.35); background:rgba(42,111,204,0.16); }
.lib-rating-badge.rating-12 { color:#ffbf69; border-color:rgba(255,191,105,0.35); background:rgba(255,153,0,0.16); }
.lib-rating-badge.rating-16 { color:#c8a2ff; border-color:rgba(200,162,255,0.35); background:rgba(128,90,213,0.16); }
.lib-rating-badge.rating-18 { color:#ff8d8d; border-color:rgba(255,141,141,0.35); background:rgba(230,57,70,0.16); }
.children-wrapper { display: flex; flex-direction: column; }
</style>
