<script setup lang="ts">
import { computed } from 'vue';
import type { RundownItem } from '../stores/rundown';
import type { LibraryIndicator } from '../stores/mediaDefaults';
import StatusIndicator from './StatusIndicator.vue';
import { resolveRundownStatusTone } from '../lib/statusResolver';

import { useRundownStore } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';

const rundown = useRundownStore();

// Extracted from RundownList.vue so each row re-renders only when ITS props
// change (plan §2.2). All reactive values are passed as props from the parent
// (which applies v-memo by value); everything here is a pure function of
// `item` + props so the child render cost is zero for untouched rows.
const props = defineProps<{
  item: RundownItem;
  index: number;
  selected: boolean;
  playing: boolean;
  played: boolean;
  nextUp: boolean;
  nextUpImminent: boolean;
  dropBefore?: boolean;
  dropAfter?: boolean;
  /** 0-100 gradient progress for the active row. */
  progressPct: number;
  /** 'green' = playing instance, 'red' = current playing index row. */
  progressTone: '' | 'green' | 'red';
  /** playbackCountdownStr when this row is the playing instance, else ''. */
  countdown: string;
  /** activeTimerLabel || durationLabel ('' renders nothing extra). */
  timerLabel: string;
  etaHint: string;
  dayLabel: string;
  atKind: '' | 'done' | 'now' | 'gap' | 'time';
  atText: string;
  playProtected: boolean;
}>();

const emit = defineEmits<{
  (e: 'select', ev: MouseEvent): void;
  (e: 'contextmenu', ev: MouseEvent): void;
  (e: 'dragover', ev: DragEvent): void;
  (e: 'drop', ev: DragEvent): void;
  (e: 'play'): void;
  (e: 'delete'): void;
  (e: 'pointerdown-handle', ev: PointerEvent): void;
}>();




const typeIcon = (type: RundownItem['type']) => ({ video: '🎬', live: '📹', graphic: '🎨', gap: '⏱' }[type] || '📄');
const typeColor = (type: RundownItem['type']) => ({ video: '#33becc', live: '#e63946', graphic: '#a8dadc', gap: '#df8e1d' }[type] || '#aaa');

const msToClockDisplay = (ms: number) => {
  if (ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const msToShortDisplay = (ms: number) => {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

const ratingClass = (rating: string) => `rating-${rating || 'none'}`;
const ratingToneClass = (rating: RundownItem['complianceRating']) => `tone-rating-${rating || 'none'}`;
const indicatorToneClass = (indicator?: LibraryIndicator) => `tone-tag-${indicator || 'none'}`;
const indicatorLabel = (indicator?: LibraryIndicator) => ({
  spot: 'SPOT',
  telemarketing: 'TMK',
  none: ''
}[indicator || 'none']);

const rowSignals = (item: RundownItem) => {
  const signals: Array<{ key: string; className: string; title: string }> = [];
  if (item.complianceRating && item.complianceRating !== 'none') {
    signals.push({
      key: `rating-${item.complianceRating}`,
      className: ratingToneClass(item.complianceRating),
      title: `Compliance rating ${item.complianceRating.toUpperCase()}`
    });
  }
  if (item.libraryIndicator && item.libraryIndicator !== 'none') {
    signals.push({
      key: `tag-${item.libraryIndicator}`,
      className: indicatorToneClass(item.libraryIndicator),
      title: indicatorLabel(item.libraryIndicator)
    });
  }
  return signals;
};

const getDisplayName = (item: RundownItem) => {
  if (item.display_name) return item.display_name;
  if (item.current_path) {
    const filename = item.current_path.split(/[/\\]/).pop();
    if (filename && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filename)) {
      return filename;
    }
  }
  if (item.filename && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.filename)) {
    return item.filename;
  }
  return 'Untitled Asset';
};

const trimDisplay = (item: RundownItem) => {
  if (item.type === 'gap') return item.hardStartTime || 'GAP';
  if (item.type === 'live') return 'LIVE';
  const trimIn = item.trim_in_ms !== undefined ? item.trim_in_ms : item.inPoint;
  const trimOut = item.trim_out_ms !== undefined ? item.trim_out_ms : (item.duration_ms && item.outPoint ? item.duration_ms - item.outPoint : 0);
  if (!trimIn && !trimOut) return 'FULL';
  const inLabel = trimIn ? msToShortDisplay(trimIn) : '0:00';
  const outLabel = (item.duration_ms && trimOut) ? msToShortDisplay(item.duration_ms - trimOut) : (item.duration && trimOut ? msToShortDisplay(item.duration * 1000 - trimOut) : 'END');
  return `${inLabel}→${outLabel}`;
};

const rowClass = computed(() => ({
  'selected': props.selected,
  'playing': props.playing,
  'played': props.played,
  'next-up': props.nextUp,
  'next-up-imminent': props.nextUpImminent,
  'drop-target-before': props.dropBefore,
  'drop-target-after': props.dropAfter,
  'gap-line': props.item.type === 'gap',
  [ratingClass(props.item.complianceRating)]: props.item.complianceRating && props.item.complianceRating !== 'none',
  'ct-movie': props.item.content_type === 'movie',
  'ct-show': props.item.content_type === 'show',
  'ct-documentary': props.item.content_type === 'documentary',
  'ct-news': props.item.content_type === 'news'
}));

const rowStyle = computed(() => {
  if (props.progressTone === 'green') {
    return {
      background: `linear-gradient(90deg, rgba(46,204,113,0.22) ${props.progressPct}%, rgba(46,204,113,0.06) ${props.progressPct}%)`,
      borderColor: 'rgba(46,204,113,0.4)'
    };
  }
  if (props.progressTone === 'red') {
    return {
      background: `linear-gradient(90deg, rgba(230,57,70,0.3) ${props.progressPct}%, rgba(230,57,70,0.08) ${props.progressPct}%)`,
      borderColor: 'rgba(230,57,70,0.4)'
    };
  }
  return {};
});
const settings = useSettingsStore();
const itemStatusTone = computed(() =>
  resolveRundownStatusTone(props.item, {
    playing: props.playing,
    nextUp: props.nextUp,
    nextUpImminent: props.nextUpImminent,
    atKind: props.atKind
  }, settings.qcSensitivity)
);

const itemTooltip = computed(() => {
  if (props.item.warnings && props.item.warnings.length > 0) {
    return `Warning:\n• ${props.item.warnings.join('\n• ')}`;
  }
  return undefined;
});
</script>

<template>
  <div
    class="rw-row"
    role="option"
    :aria-selected="selected"
    :data-item-id="item.id"
    :class="rowClass"
    :style="rowStyle"
    @click="emit('select', $event)"
    @contextmenu.prevent="emit('contextmenu', $event)"
    @dragover="emit('dragover', $event)"
    @drop="emit('drop', $event)"
  >
    <div
      class="rw-handle"
      :title="item.type === 'gap' ? 'Drag to move gap line' : 'Drag to reorder'"
      @pointerdown="emit('pointerdown-handle', $event)"
    >⋮⋮</div>
    <div class="rw-num">{{ item.type === 'gap' ? '⏱' : index + 1 }}</div>
    <div class="rw-signals">
      <StatusIndicator :tone="itemStatusTone" variant="dot" :tooltip="itemTooltip" />
      <span v-for="signal in rowSignals(item)" :key="signal.key" class="rw-signal" :class="signal.className" :title="signal.title"></span>
    </div>
    <div class="rw-type-icon" :style="{ color: typeColor(item.type) }">{{ typeIcon(item.type) }}</div>
    <div class="rw-name" :title="getDisplayName(item)">
      <span class="rw-name-text">{{ getDisplayName(item) }}</span>
      <span class="rw-meta-badges">
        <span v-if="item.tp_flag" class="mcr-badge badge-tp">TP</span>
        <span v-if="item.content_type && item.content_type !== 'none'" class="mcr-badge badge-content" :class="`content-${item.content_type}`">
          {{ item.content_type.toUpperCase() }}
        </span>
      </span>
    </div>
    <div class="rw-rating">
      <span v-if="item.complianceRating && item.complianceRating !== 'none'" data-testid="age-rating-badge" class="rw-rating-badge" :class="ratingClass(item.complianceRating)">{{ item.complianceRating.toUpperCase() }}</span>
      <span v-else class="rw-rating-empty">·</span>
    </div>
    <div class="rw-tag">
      <span v-if="item.libraryIndicator && item.libraryIndicator !== 'none'" class="rw-tag-badge" :class="indicatorToneClass(item.libraryIndicator)">{{ indicatorLabel(item.libraryIndicator) }}</span>
      <span v-else class="rw-rating-empty">·</span>
    </div>
    <div class="rw-inout" :title="trimDisplay(item)">{{ trimDisplay(item) }}</div>

    <!-- Duration -->
    <div class="rw-dur">
      <span v-if="countdown" style="color:#2ecc71; font-weight:bold; margin-right:8px; font-family:monospace;">
        {{ countdown }}
      </span>
      <span>{{ timerLabel }}</span>
      <span v-if="etaHint" class="rw-eta-hint">
        ({{ etaHint }})
      </span>
    </div>

    <div class="rw-day">
      <span class="tc-day">{{ dayLabel }}</span>
    </div>

    <div class="rw-at">
      <span v-if="atKind === 'done'" class="tc-done">PLAYED</span>
      <span v-else-if="atKind === 'now'" class="tc-now">ON AIR</span>
      <span v-else-if="atKind === 'gap'" class="tc-gap">{{ atText }}</span>
      <span v-else-if="atKind === 'time'" class="tc-sched">{{ atText }}</span>
    </div>

    <!-- Row actions -->
    <div class="rw-actions">
      <button
        class="row-btn btn-play"
        :disabled="rundown.isRundownLocked"
        :title="rundown.isRundownLocked ? 'Rundown is Locked' : (item.type === 'gap' ? 'Play next content after this gap line' : `Play from #${index+1}`)"
        @click.stop="!rundown.isRundownLocked && emit('play')"
      >▶</button>
      <button v-if="!playProtected && !rundown.isRundownLocked" class="row-btn row-btn-del" title="Remove (Del)" @click.stop="emit('delete')">✕</button>
    </div>
  </div>
</template>

<style scoped>
.rw-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: var(--row-h-rundown, 48px);
  height: var(--row-h-rundown, 48px);
  padding: 0 8px;
  margin: 3px 0;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s, border-color 0.12s, transform 0.12s;
  background: var(--bg-secondary);
}
.rw-row:hover { background: var(--bg-hover); }
.rw-row.selected {
  background: var(--bg-active) !important;
  border-color: color-mix(in srgb, var(--accent-blue) 45%, transparent) !important;
}
.rw-row.playing  {
  background: color-mix(in srgb, var(--accent-red) 12%, var(--bg-secondary)) !important;
  border-color: color-mix(in srgb, var(--accent-red) 45%, transparent) !important;
}
.rw-row.played   { opacity: 0.5; }
.rw-row.next-up {
  background: color-mix(in srgb, var(--accent-yellow) 12%, var(--bg-secondary));
  border-color: color-mix(in srgb, var(--accent-yellow) 35%, transparent);
}
.rw-row.next-up-imminent {
  animation: nextUpPulse 1s ease-in-out infinite;
}
.rw-row.drop-target-before,
.rw-row.drop-target-after {
  border-color: var(--accent-cyan);
}
.rw-row.drop-target-before::before,
.rw-row.drop-target-after::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  height: 0;
  border-top: 2px solid var(--accent-cyan);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-cyan) 30%, transparent), 0 0 14px var(--accent-cyan);
  pointer-events: none;
}
.rw-row.drop-target-before::before {
  top: -2px;
}
.rw-row.drop-target-after::after {
  bottom: -2px;
}
.rw-row.drop-target-before::after,
.rw-row.drop-target-after::before {
  content: '';
  position: absolute;
  left: 6px;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--accent-cyan);
  box-shadow: 0 0 0 2px var(--bg-primary), 0 0 10px var(--accent-cyan);
  pointer-events: none;
}
.rw-row.drop-target-before::after {
  top: -6px;
}
.rw-row.drop-target-after::before {
  bottom: -6px;
}
.rw-row.gap-line {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--accent-orange) 45%, transparent);
  background: color-mix(in srgb, var(--accent-orange) 8%, var(--bg-secondary));
}
.rw-row.gap-line .rw-name,
.rw-row.gap-line .rw-dur,
.rw-row.gap-line .rw-inout {
  color: var(--accent-orange);
  font-style: italic;
}
.rw-row.rating-k { box-shadow: inset 6px 0 0 rgba(16, 185, 129, 0.85); }
.rw-row.rating-8 { box-shadow: inset 6px 0 0 rgba(6, 182, 212, 0.88); }
.rw-row.rating-12 { box-shadow: inset 6px 0 0 rgba(234, 179, 8, 0.88); }
.rw-row.rating-16 { box-shadow: inset 6px 0 0 rgba(249, 115, 22, 0.88); }
.rw-row.rating-18 { box-shadow: inset 6px 0 0 rgba(239, 68, 68, 0.95); }

@keyframes nextUpPulse {
  0%, 100% { background: color-mix(in srgb, var(--accent-yellow) 10%, var(--bg-secondary)); box-shadow: 0 0 0 0 transparent; }
  50% { background: color-mix(in srgb, var(--accent-yellow) 22%, var(--bg-secondary)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-yellow) 40%, transparent), 0 0 16px color-mix(in srgb, var(--accent-yellow) 25%, transparent); }
}

.rw-handle { color: var(--text-muted); cursor: grab; font-size: 0.92rem; width: 18px; text-align: center; flex-shrink: 0; }
.rw-num     { width: 22px; text-align: center; font-size: 0.78rem; font-weight: 700; color: var(--text-secondary); flex-shrink: 0; font-family: var(--font-mono); }
.rw-signals { width: 20px; display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
.rw-signal {
  width: 5px;
  height: 18px;
  border-radius: 999px;
  background: var(--border-medium);
  border: 1px solid var(--border-subtle);
}
.rw-type-icon { width: 20px; font-size: 1.05rem; text-align: center; flex-shrink: 0; }
.rw-name    { flex: 1; font-size: 0.92rem; font-weight: 600; letter-spacing: 0.01em; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.rw-rating  { width: 50px; text-align: center; flex-shrink: 0; }
.rw-tag     { width: 62px; text-align: center; flex-shrink: 0; }
.rw-rating-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 34px; padding: 3px 8px; border-radius: 999px;
  font-size: 0.65rem; font-weight: 800; letter-spacing: 0.08em;
  border: 1px solid var(--border-medium);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.rw-tag-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 0.62rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  border: 1px solid var(--border-medium);
  text-transform: uppercase;
}
.rw-rating-empty { color: var(--text-muted); font-size: 0.8rem; }
.rw-rating-badge.rating-k, .rw-signal.tone-rating-k { color: #10b981; background: rgba(16, 185, 129, 0.16); border-color: rgba(16, 185, 129, 0.4); }
.rw-rating-badge.rating-8, .rw-signal.tone-rating-8 { color: #06b6d4; background: rgba(6, 182, 212, 0.16); border-color: rgba(6, 182, 212, 0.4); }
.rw-rating-badge.rating-12, .rw-signal.tone-rating-12 { color: #d97706; background: rgba(234, 179, 8, 0.18); border-color: rgba(234, 179, 8, 0.45); }
.rw-rating-badge.rating-16, .rw-signal.tone-rating-16 { color: #ea580c; background: rgba(249, 115, 22, 0.16); border-color: rgba(249, 115, 22, 0.4); }
.rw-rating-badge.rating-18, .rw-signal.tone-rating-18 { color: #dc2626; background: rgba(239, 68, 68, 0.18); border-color: rgba(239, 68, 68, 0.45); }
.rw-tag-badge.tone-tag-spot, .rw-signal.tone-tag-spot { color: #ea580c; background: rgba(234, 88, 12, 0.16); border-color: rgba(234, 88, 12, 0.4); }
.rw-tag-badge.tone-tag-telemarketing, .rw-signal.tone-tag-telemarketing { color: #9333ea; background: rgba(147, 51, 234, 0.16); border-color: rgba(147, 51, 234, 0.4); }
.rw-inout   {
  width: 86px; text-align: center; flex-shrink: 0;
  font-size: 0.76rem; color: var(--text-secondary); font-family: var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
}
.rw-dur     { width: 176px; text-align: right; font-size: 0.86rem; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; flex-shrink: 0; font-family: var(--font-mono); letter-spacing: 0.02em; }
.rw-day     { width: 44px; display: flex; align-items: center; justify-content: flex-start; flex-shrink: 0; }
.rw-at      { width: 68px; display: flex; align-items: center; justify-content: flex-start; gap: 4px; flex-shrink: 0; }
.rw-actions { width: 68px; display: flex; gap: 4px; flex-shrink: 0; justify-content: flex-end; }

.tc-day   { display: inline-block; min-width: 2.2em; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.08em; text-align: left; }
.tc-sched { font-size: 0.78rem; color: var(--text-secondary); font-variant-numeric: tabular-nums; font-family: var(--font-mono); text-align: left; }
.tc-done  { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; }
.tc-gap   { font-size: 0.76rem; color: var(--accent-orange); font-family: var(--font-mono); text-align: left; font-weight: 600; }
.tc-now {
  font-size: 0.78rem;
  color: var(--accent-red);
  font-weight: 800;
  letter-spacing: 0.5px;
}

.row-btn {
  background: var(--bg-hover); border: 1px solid var(--border-medium); color: var(--text-secondary);
  border-radius: 4px; cursor: pointer; width: 26px; height: 26px; font-size: 0.8rem;
  display: flex; align-items: center; justify-content: center; transition: 0.12s; padding: 0;
}
.row-btn:hover { background: var(--bg-surface-elevated); color: var(--text-primary); border-color: var(--border-strong); }
.btn-play { color: var(--accent-blue); border-color: color-mix(in srgb, var(--accent-blue) 35%, transparent); }
.btn-play:hover { background: color-mix(in srgb, var(--accent-blue) 18%, transparent); color: var(--accent-blue); }
.row-btn-del:hover { background: color-mix(in srgb, var(--accent-red) 18%, transparent); border-color: var(--accent-red); color: var(--accent-red); }

.rw-ghost { opacity: 0.3; background: var(--bg-hover); }

/* Content Type subtle row tints */
.rw-row.ct-movie {
  background: color-mix(in srgb, var(--accent-blue) 6%, var(--bg-secondary));
}
.rw-row.ct-show {
  background: color-mix(in srgb, var(--accent-purple) 6%, var(--bg-secondary));
}
.rw-row.ct-documentary {
  background: color-mix(in srgb, var(--accent-yellow) 6%, var(--bg-secondary));
}
.rw-row.ct-news {
  background: color-mix(in srgb, var(--accent-green) 6%, var(--bg-secondary));
}

.rw-row.ct-movie:hover,
.rw-row.ct-show:hover,
.rw-row.ct-documentary:hover,
.rw-row.ct-news:hover {
  background: color-mix(in srgb, var(--accent-blue) 12%, var(--bg-secondary)) !important;
}

/* Badges styling */
.rw-name {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rw-name-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.rw-meta-badges {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mcr-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 800;
  padding: 2px 5px;
  border-radius: 3px;
  line-height: 1;
  text-transform: uppercase;
}

.badge-age.age-k { background: #10b981; color: #fff; }
.badge-age.age-8 { background: #06b6d4; color: #000; font-weight: 900; }
.badge-age.age-12 { background: #eab308; color: #000; font-weight: 900; }
.badge-age.age-16 { background: #f97316; color: #fff; }
.badge-age.age-18 { background: #ef4444; color: #fff; }

.badge-tp {
  background: #ec4899;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.badge-content.content-movie { background: #3b82f6; color: #fff; }
.badge-content.content-show { background: #8b5cf6; color: #fff; }
.badge-content.content-documentary { background: #f59e0b; color: #000; font-weight: 800; }
.badge-content.content-news { background: #14b8a6; color: #fff; }

.rw-eta-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-left: 5px;
}
</style>
