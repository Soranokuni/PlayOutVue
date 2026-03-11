<script setup lang="ts">
import { computed } from 'vue';
import type { LibraryIndicator } from '../stores/mediaDefaults';
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
  displayAspectRatio?: string;
  fieldOrder?: string;
  palCompatible?: boolean;
  defaultComplianceRating?: ComplianceRating;
  libraryIndicator?: LibraryIndicator;
  duration?: number;
  duration_ms?: number;
  probing?: boolean;
  showTechnicalMeta?: boolean;
  children?: MediaNode[];
  expanded?: boolean;
}

interface Badge {
  key: string;
  label: string;
  className: string;
  title?: string;
}

const props = defineProps<{
  node: MediaNode;
  depth?: number;
  selectedPath?: string;
}>();

const emit = defineEmits<{
  (e: 'dragstart', event: DragEvent, node: MediaNode): void;
  (e: 'dblclick', node: MediaNode): void;
  (e: 'contextmenu', event: MouseEvent, node: MediaNode): void;
  (e: 'select', node: MediaNode): void;
}>();

const currentDepth = computed(() => props.depth || 0);

const toggleFolder = () => {
  if (props.node.type === 'folder') {
    props.node.expanded = !props.node.expanded;
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
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const parseFrameRate = (node: MediaNode) => {
  if (!node.fpsNum || !node.fpsDen) return 0;
  return node.fpsNum / node.fpsDen;
};

const isNear = (value: number, target: number) => Math.abs(value - target) < 0.05;

const formatSpecBadge = (node: MediaNode) => {
  if (node.type !== 'file' || !node.width || !node.height || !node.fpsNum || !node.fpsDen) return '';
  const fps = parseFrameRate(node);
  const fpsLabel = Number.isFinite(fps) ? fps.toFixed(Math.abs(fps - Math.round(fps)) < 0.01 ? 0 : 2) : '?';
  return `${node.width}×${node.height} · ${fpsLabel}fps`;
};

const normalizeAspect = (value?: string) => {
  const normalized = (value || '').trim().replace('/', ':');
  if (!normalized || normalized === '0:1') return '';
  return normalized;
};

const getResolutionBadge = (node: MediaNode): Badge | null => {
  if (node.type !== 'file' || node.mediaType !== 'video' || !node.width || !node.height) return null;
  const suffix = node.fieldOrder && node.fieldOrder !== 'progressive' ? 'i' : 'p';
  const vertical = node.height;
  const label = vertical >= 1080 ? `1080${suffix}`
    : vertical >= 720 ? `720${suffix}`
    : vertical >= 576 ? `576${suffix}`
    : vertical >= 480 ? `480${suffix}`
    : `${vertical}${suffix}`;
  return { key: 'resolution', label, className: 'is-tech', title: formatSpecBadge(node) };
};

const getAspectBadge = (node: MediaNode): Badge | null => {
  if (node.type !== 'file' || node.mediaType !== 'video') return null;
  const dar = normalizeAspect(node.displayAspectRatio);
  if (dar === '16:9') {
    return { key: 'aspect', label: 'Widescreen', className: 'is-tech', title: 'Display aspect ratio 16:9' };
  }
  if (dar === '4:3') {
    return { key: 'aspect', label: '4:3', className: 'is-tech', title: 'Display aspect ratio 4:3' };
  }
  if (dar) {
    return { key: 'aspect', label: dar, className: 'is-tech', title: `Display aspect ratio ${dar}` };
  }

  if (!node.width || !node.height) return null;
  const aspect = node.width / node.height;
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  if (Math.abs(aspect - 16 / 9) < 0.05) {
    return { key: 'aspect', label: 'Widescreen', className: 'is-tech', title: 'Display aspect ratio near 16:9' };
  }
  if (Math.abs(aspect - 4 / 3) < 0.05) {
    return { key: 'aspect', label: '4:3', className: 'is-tech', title: 'Display aspect ratio near 4:3' };
  }
  return null;
};

const getPalBadge = (node: MediaNode): Badge | null => {
  if (node.type !== 'file' || node.mediaType !== 'video') return null;
  if (node.palCompatible) {
    return { key: 'pal', label: 'PAL', className: 'is-pal', title: formatSpecBadge(node) };
  }
  const fps = parseFrameRate(node);
  if (node.width && node.height && fps > 0) {
    const isPalFps = isNear(fps, 25) || isNear(fps, 50);
    if (isPalFps && (node.height === 1080 || node.height === 720 || node.height === 576)) {
      return { key: 'pal', label: 'PAL', className: 'is-pal', title: formatSpecBadge(node) };
    }
  }
  return null;
};

const indicatorBadge = computed<Badge | null>(() => {
  if (props.node.libraryIndicator === 'spot') {
    return { key: 'indicator', label: 'Spot', className: 'is-spot', title: 'Library tag: spot' };
  }
  if (props.node.libraryIndicator === 'telemarketing') {
    return { key: 'indicator', label: 'Telemarketing', className: 'is-telemarketing', title: 'Library tag: telemarketing' };
  }
  return null;
});

const ratingBadge = computed<Badge | null>(() => {
  if (!props.node.defaultComplianceRating || props.node.defaultComplianceRating === 'none') return null;
  return {
    key: 'rating',
    label: props.node.defaultComplianceRating.toUpperCase(),
    className: `lib-rating-badge rating-${props.node.defaultComplianceRating}`,
    title: `Default rating ${props.node.defaultComplianceRating.toUpperCase()}`
  };
});

const nodeDurationLabel = computed(() => {
  const seconds = props.node.duration_ms ? props.node.duration_ms / 1000 : (props.node.duration || 0);
  return fmtDur(seconds);
});

const nodeStatusLabel = computed(() => {
  if (nodeDurationLabel.value) return nodeDurationLabel.value;
  if (props.node.probing) return 'PROBING';
  return '';
});

const alwaysVisibleBadges = computed(() => {
  const badges: Badge[] = [];
  if (indicatorBadge.value) badges.push(indicatorBadge.value);
  if (ratingBadge.value) badges.push(ratingBadge.value);

  return badges.slice(0, 2);
});

const technicalBadges = computed(() => {
  const badges: Badge[] = [];

  for (const badge of [getPalBadge(props.node), getResolutionBadge(props.node), getAspectBadge(props.node)]) {
    if (!badge) continue;
    if (badges.some((existing) => existing.key === badge.key || existing.label === badge.label)) continue;
    badges.push(badge);
  }

  return badges.slice(0, 3);
});

const isSelected = computed(() => props.node.type === 'file' && !!props.selectedPath && props.selectedPath === props.node.path);
const canToggleTechnicalMeta = computed(() => props.node.type === 'file' && technicalBadges.value.length > 0);
const hasTechnicalComplianceIssue = computed(() => {
  if (props.node.type !== 'file' || props.node.mediaType !== 'video') return false;
  if (!props.node.width || !props.node.height || !props.node.fpsNum || !props.node.fpsDen) return false;
  return !props.node.palCompatible;
});

const toggleTechnicalMeta = () => {
  if (!canToggleTechnicalMeta.value) return;
  props.node.showTechnicalMeta = !props.node.showTechnicalMeta;
};

const handleRowClick = () => {
  if (props.node.type === 'folder') {
    toggleFolder();
    return;
  }
  emit('select', props.node);
};

const handleDragStart = (event: DragEvent) => {
  if (props.node.type === 'file') emit('dragstart', event, props.node);
};
</script>

<template>
  <div class="tree-node-wrapper">
    <div
      v-memo="[
        node.path,
        node.expanded,
        node.probing,
        node.duration_ms,
        node.duration,
        node.defaultComplianceRating,
        node.libraryIndicator,
        node.showTechnicalMeta,
        selectedPath
      ]"
      class="lib-row"
      :class="{ 'is-folder': node.type === 'folder', 'is-selected': isSelected }"
      :style="{ paddingLeft: (currentDepth * 12 + 6) + 'px' }"
      :draggable="node.type === 'file' && !!node.path"
      @dragstart="handleDragStart"
      @dblclick="node.type === 'file' ? emit('dblclick', node) : toggleFolder()"
      @click="handleRowClick"
      @contextmenu.prevent="emit('contextmenu', $event, node)"
      :title="node.type === 'file' ? 'Drag or double-click to add' : 'Click to toggle'"
    >
      <span class="lib-icon" style="margin-right:0px;">
        <span v-if="node.type === 'folder'" class="folder-carat">{{ node.expanded ? '▼' : '▶' }}</span>
        {{ typeIcon(node.mediaType, node.type === 'folder', node.expanded) }}
      </span>
      <span class="lib-text" :class="{ 'is-file': node.type === 'file' }">
        <span class="lib-name" :class="{ 'lib-name-dim': !node.path }">{{ node.name }}</span>
        <span v-if="node.type === 'file' && alwaysVisibleBadges.length" class="lib-badge-row">
          <span
            v-for="badge in alwaysVisibleBadges"
            :key="badge.key + badge.label"
            class="lib-badge"
            :class="badge.className"
            :title="badge.title"
          >
            {{ badge.label }}
          </span>
        </span>
        <span v-if="node.type === 'file' && node.showTechnicalMeta && technicalBadges.length" class="lib-badge-row lib-badge-row-specs">
          <span
            v-for="badge in technicalBadges"
            :key="`tech-${badge.key}-${badge.label}`"
            class="lib-badge"
            :class="badge.className"
            :title="badge.title"
          >
            {{ badge.label }}
          </span>
        </span>
      </span>
      <button
        v-if="canToggleTechnicalMeta"
        class="lib-meta-toggle"
        :class="{ 'is-open': node.showTechnicalMeta, 'is-alert': hasTechnicalComplianceIssue }"
        :title="node.showTechnicalMeta ? 'Hide technical metadata' : 'Show technical metadata'"
        @click.stop="toggleTechnicalMeta"
      >
        ⚙
      </button>
      <span v-if="node.type === 'file' && nodeStatusLabel" class="lib-time-pill" :class="{ 'is-probing': node.probing && !nodeDurationLabel }">
        {{ nodeStatusLabel }}
      </span>
    </div>
    
    <div v-if="node.type === 'folder' && node.expanded" class="children-wrapper">
      <MediaTreeNode
        v-for="child in node.children"
        :key="child.path || child.name"
        :node="child"
        :depth="currentDepth + 1"
        :selected-path="selectedPath"
        @dragstart="(e, n) => emit('dragstart', e, n)"
        @dblclick="(n) => emit('dblclick', n)"
        @contextmenu="(e, n) => emit('contextmenu', e, n)"
        @select="(n) => emit('select', n)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-node-wrapper {
  display: flex;
  flex-direction: column;
  content-visibility: auto;
  contain-intrinsic-size: 34px;
}
.lib-row {
  display:flex;
  align-items:center;
  gap:8px;
  min-height:34px;
  padding:5px 8px;
  border-radius:8px;
  user-select:none;
  border:1px solid transparent;
  transition:background 0.12s, border-color 0.12s;
  cursor:pointer;
}
.lib-row:hover {
  background:color-mix(in srgb, var(--accent-blue) 10%, transparent);
  border-color:color-mix(in srgb, var(--accent-blue) 18%, transparent);
}
.lib-row.is-selected {
  background:color-mix(in srgb, var(--accent-blue) 14%, transparent);
  border-color:color-mix(in srgb, var(--accent-blue) 34%, transparent);
  box-shadow:0 0 0 1px color-mix(in srgb, var(--accent-blue) 22%, transparent);
}
.lib-row[draggable="true"] { cursor:grab; }
.lib-row[draggable="true"]:active { cursor:grabbing; }
.lib-icon { font-size:0.85rem; flex-shrink:0; display:flex; align-items:center; gap:4px; }
.folder-carat { font-size: 0.55rem; color: var(--text-secondary); width: 12px; display:inline-block; text-align:center;}
.lib-text { flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; }
.lib-name { font-size:0.76rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; font-weight:600; }
.lib-name-dim { color:color-mix(in srgb, var(--accent-yellow) 72%, var(--text-secondary)); font-size:0.76rem; }
.lib-badge-row {
  display:flex;
  flex-wrap:wrap;
  gap:4px;
  margin-top:3px;
}
.lib-badge-row-specs {
  margin-top:4px;
}
.lib-meta-toggle {
  width:26px;
  height:26px;
  border-radius:999px;
  border:1px solid var(--glass-border);
  background:color-mix(in srgb, var(--bg-tertiary) 82%, transparent);
  color:var(--text-secondary);
  cursor:pointer;
  display:flex;
  align-items:center;
  justify-content:center;
  flex-shrink:0;
  transition:background 0.12s, color 0.12s, border-color 0.12s;
}
.lib-meta-toggle:hover {
  background:color-mix(in srgb, var(--accent-blue) 10%, var(--bg-tertiary));
  color:var(--accent-blue);
}
.lib-meta-toggle.is-open {
  color:var(--accent-blue);
  border-color:color-mix(in srgb, var(--accent-blue) 32%, transparent);
}
.lib-meta-toggle.is-alert {
  color:var(--accent-red);
  border-color:color-mix(in srgb, var(--accent-red) 34%, transparent);
  background:color-mix(in srgb, var(--accent-red) 10%, var(--bg-tertiary));
}
.lib-time-pill {
  font-size:0.72rem;
  line-height:1;
  padding:6px 8px;
  border-radius:999px;
  background:color-mix(in srgb, var(--accent-red) 12%, var(--bg-secondary));
  border:1px solid color-mix(in srgb, var(--accent-red) 26%, transparent);
  color:var(--text-primary);
  font-variant-numeric:tabular-nums;
  font-family:'Courier New', monospace;
  font-weight:700;
  letter-spacing:0.04em;
  flex-shrink:0;
}
.lib-time-pill.is-probing {
  color:color-mix(in srgb, var(--accent-yellow) 72%, var(--text-primary));
  background:color-mix(in srgb, var(--accent-yellow) 14%, var(--bg-secondary));
  border-color:color-mix(in srgb, var(--accent-yellow) 32%, transparent);
}
.lib-badge {
  font-size:0.57rem;
  padding:2px 6px;
  border-radius:999px;
  border:1px solid transparent;
  letter-spacing:0.05em;
  flex-shrink:0;
}
.lib-badge.is-pal {
  color:#9ef6cf;
  border-color:rgba(158,246,207,0.35);
  background:rgba(29,185,84,0.15);
}
.lib-badge.is-tech {
  color:color-mix(in srgb, var(--accent-blue) 76%, var(--text-primary));
  border-color:color-mix(in srgb, var(--accent-blue) 30%, transparent);
  background:color-mix(in srgb, var(--accent-blue) 12%, var(--bg-secondary));
}
.lib-badge.is-spot {
  color:#f2c185;
  border-color:rgba(242, 193, 133, 0.34);
  background:rgba(212, 139, 61, 0.16);
}
.lib-badge.is-telemarketing {
  color:#f2a7b7;
  border-color:rgba(242, 167, 183, 0.34);
  background:rgba(196, 64, 108, 0.16);
}
.lib-rating-badge.rating-k { color:#9ef6cf; border-color:rgba(158,246,207,0.35); background:rgba(29,185,84,0.15); }
.lib-rating-badge.rating-8 { color:#8cc9ff; border-color:rgba(140,201,255,0.35); background:rgba(42,111,204,0.16); }
.lib-rating-badge.rating-12 { color:#ffbf69; border-color:rgba(255,191,105,0.35); background:rgba(255,153,0,0.16); }
.lib-rating-badge.rating-16 { color:#c8a2ff; border-color:rgba(200,162,255,0.35); background:rgba(128,90,213,0.16); }
.lib-rating-badge.rating-18 { color:#ff8d8d; border-color:rgba(255,141,141,0.35); background:rgba(230,57,70,0.16); }
.children-wrapper { display: flex; flex-direction: column; }
</style>
