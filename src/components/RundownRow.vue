<script setup lang="ts">
import { computed } from 'vue';
import type { RundownItem } from '../stores/rundown';
import type { LibraryIndicator } from '../stores/mediaDefaults';
import StatusIndicator from './StatusIndicator.vue';
import { resolveRundownStatusTone } from '../lib/statusResolver';

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
  dropBefore: boolean;
  dropAfter: boolean;
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
const itemStatusTone = computed(() =>
  resolveRundownStatusTone(props.item, {
    playing: props.playing,
    nextUp: props.nextUp,
    nextUpImminent: props.nextUpImminent,
    atKind: props.atKind
  })
);
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
    <div class="rw-handle" :title="item.type === 'gap' ? 'Drag to move gap line' : 'Drag to reorder'">⋮⋮</div>
    <div class="rw-num">{{ item.type === 'gap' ? '⏱' : index + 1 }}</div>
    <div class="rw-signals">
      <StatusIndicator :tone="itemStatusTone" variant="dot" />
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
      <button class="row-btn btn-play" :title="item.type === 'gap' ? 'Play next content after this gap line' : `Play from #${index+1}`" @click.stop="emit('play')">▶</button>
      <button v-if="!playProtected" class="row-btn row-btn-del" title="Remove (Del)" @click.stop="emit('delete')">✕</button>
    </div>
  </div>
</template>

<style scoped>
.rw-row {
  position:relative;
  display:flex; align-items:center; gap:4px;
  min-height:40px; padding:0 6px;
  margin:3px 0;
  border-radius:6px; border:1px solid transparent;
  cursor:pointer; user-select:none; transition:background 0.12s, border-color 0.12s, transform 0.12s;
}
.rw-row:hover { background:rgba(255,255,255,0.04); }
.rw-row.selected { background:rgba(51,190,204,0.08); border-color:rgba(51,190,204,0.3); }
.rw-row.playing  { background:rgba(230,57,70,0.08); border-color:rgba(230,57,70,0.4); }
.rw-row.played   { opacity:0.45; }
.rw-row.next-up {
  background:rgba(248,180,0,0.08);
  border-color:rgba(248,180,0,0.22);
}
.rw-row.next-up-imminent {
  animation:nextUpPulse 1s ease-in-out infinite;
}
.rw-row.drop-target-before,
.rw-row.drop-target-after {
  border-color:rgba(51,190,204,0.36);
}
.rw-row.drop-target-before {
  transform:translateY(12px);
}
.rw-row.drop-target-after {
  transform:translateY(-12px);
}
.rw-row.drop-target-before::before,
.rw-row.drop-target-after::after {
  content:'';
  position:absolute;
  left:10px;
  right:10px;
  height:0;
  border-top:2px solid rgba(51,190,204,0.82);
  box-shadow:0 0 0 1px rgba(51,190,204,0.18), 0 0 14px rgba(51,190,204,0.18);
  pointer-events:none;
}
.rw-row.drop-target-before::before {
  top:-8px;
}
.rw-row.drop-target-after::after {
  bottom:-8px;
}
.rw-row.drop-target-before::after,
.rw-row.drop-target-after::before {
  content:'';
  position:absolute;
  left:10px;
  width:10px;
  height:10px;
  border-radius:999px;
  background:rgba(51,190,204,0.96);
  box-shadow:0 0 0 2px rgba(10,14,22,0.86), 0 0 10px rgba(51,190,204,0.28);
  pointer-events:none;
}
.rw-row.drop-target-before::after {
  top:-13px;
}
.rw-row.drop-target-after::before {
  bottom:-13px;
}
.rw-row.gap-line {
  border-style:dashed;
  border-color:rgba(223,142,29,0.26);
  background:rgba(223,142,29,0.08);
}
.rw-row.gap-line .rw-name,
.rw-row.gap-line .rw-dur,
.rw-row.gap-line .rw-inout {
  color:rgba(223,142,29,0.92);
  font-style:italic;
}
.rw-row.rating-k { box-shadow: inset 6px 0 0 rgba(101,194,83,0.82); }
.rw-row.rating-8 { box-shadow: inset 6px 0 0 rgba(119,217,89,0.88); }
.rw-row.rating-12 { box-shadow: inset 6px 0 0 rgba(255,166,77,0.88); }
.rw-row.rating-16 { box-shadow: inset 6px 0 0 rgba(164,112,255,0.88); }
.rw-row.rating-18 { box-shadow: inset 6px 0 0 rgba(230,57,70,0.95); }
@keyframes nextUpPulse {
  0%, 100% { background:rgba(248,180,0,0.08); box-shadow:0 0 0 0 rgba(248,180,0,0); }
  50% { background:rgba(248,180,0,0.18); box-shadow:0 0 0 1px rgba(248,180,0,0.28), 0 0 16px rgba(248,180,0,0.16); }
}

.rw-handle { color:rgba(255,255,255,0.2); cursor:grab; font-size:0.8rem; width:18px; text-align:center; flex-shrink:0; }
.rw-num     { width:20px; text-align:center; font-size:0.72rem; color:rgba(255,255,255,0.34); flex-shrink:0; }
.rw-signals { width:18px; display:flex; align-items:center; gap:3px; flex-shrink:0; }
.rw-signal {
  width:5px;
  height:17px;
  border-radius:999px;
  background:rgba(255,255,255,0.12);
  border:1px solid rgba(255,255,255,0.1);
}
.rw-type-icon { width:18px; font-size:0.92rem; text-align:center; flex-shrink:0; }
.rw-name    { flex:1; font-size:0.77rem; font-weight:600; letter-spacing:0.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.rw-rating  { width:46px; text-align:center; flex-shrink:0; }
.rw-tag     { width:58px; text-align:center; flex-shrink:0; }
.rw-rating-badge {
  display:inline-flex; align-items:center; justify-content:center;
  min-width:32px; padding:4px 8px; border-radius:999px;
  font-size:0.59rem; font-weight:800; letter-spacing:0.1em;
  border:1px solid rgba(255,255,255,0.14);
  box-shadow:0 0 0 1px rgba(255,255,255,0.04);
}
.rw-tag-badge {
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-width:40px;
  padding:4px 8px;
  border-radius:999px;
  font-size:0.55rem;
  font-weight:900;
  letter-spacing:0.11em;
  border:1px solid rgba(255,255,255,0.14);
  text-transform:uppercase;
}
.rw-rating-empty { color:rgba(255,255,255,0.16); font-size:0.7rem; }
.rw-rating-badge.rating-k, .rw-signal.tone-rating-k { color:#c8f7b6; background:rgba(101,194,83,0.22); border-color:rgba(101,194,83,0.38); }
.rw-rating-badge.rating-8, .rw-signal.tone-rating-8 { color:#d7ffbf; background:rgba(119,217,89,0.24); border-color:rgba(119,217,89,0.42); }
.rw-rating-badge.rating-12, .rw-signal.tone-rating-12 { color:#ffd188; background:rgba(255,166,77,0.22); border-color:rgba(255,166,77,0.38); }
.rw-rating-badge.rating-16, .rw-signal.tone-rating-16 { color:#e2c4ff; background:rgba(164,112,255,0.22); border-color:rgba(164,112,255,0.38); }
.rw-rating-badge.rating-18, .rw-signal.tone-rating-18 { color:#ffb0b0; background:rgba(230,57,70,0.24); border-color:rgba(230,57,70,0.4); }
.rw-tag-badge.tone-tag-spot, .rw-signal.tone-tag-spot { color:#ffd5a6; background:rgba(224,134,43,0.22); border-color:rgba(224,134,43,0.4); }
.rw-tag-badge.tone-tag-telemarketing, .rw-signal.tone-tag-telemarketing { color:#efc8ff; background:rgba(149,76,233,0.24); border-color:rgba(149,76,233,0.42); }
.rw-inout   {
  width:78px; text-align:center; flex-shrink:0;
  font-size:0.63rem; color:rgba(255,255,255,0.46); font-variant-numeric:tabular-nums; letter-spacing:0.03em;
}
.rw-dur     { width:168px; text-align:right; font-size:0.72rem; color:rgba(255,255,255,0.62); font-variant-numeric:tabular-nums; flex-shrink:0; font-family:monospace; letter-spacing:0.02em; }
.rw-day     { width:42px; display:flex; align-items:center; justify-content:flex-start; flex-shrink:0; }
.rw-at      { width:60px; display:flex; align-items:center; justify-content:flex-start; gap:4px; flex-shrink:0; }
.rw-actions { width:62px; display:flex; gap:2px; flex-shrink:0; justify-content:flex-end; }

.tc-day   { display:inline-block; min-width:2.2em; font-size:0.58rem; font-weight:700; text-transform:uppercase; color:rgba(255,255,255,0.4); letter-spacing:0.08em; text-align:left; }
.tc-sched { font-size:0.69rem; color:rgba(255,255,255,0.5); font-variant-numeric:tabular-nums; font-family:monospace; text-align:left; }
.tc-done  { font-size:0.7rem; color:rgba(255,255,255,0.2); }
.tc-gap   { font-size:0.66rem; color:#df8e1d; font-family:monospace; text-align:left; }
.tc-now {
  font-size:0.69rem;
  color:#e63946;
  font-weight:700;
  letter-spacing:0.5px;
}

.row-btn {
  background:transparent; border:1px solid rgba(255,255,255,0.1); color:rgba(255,255,255,0.45);
  border-radius:3px; cursor:pointer; width:20px; height:24px; font-size:0.74rem;
  display:flex; align-items:center; justify-content:center; transition:0.12s; padding:0;
}
.row-btn:hover { background:rgba(255,255,255,0.1); color:#fff; }
.btn-play { color:rgba(51,190,204,0.8); border-color:rgba(51,190,204,0.25); }
.btn-play:hover { background:rgba(51,190,204,0.15); color:#33becc; }
.row-btn-del:hover { background:rgba(230,57,70,0.15); border-color:rgba(230,57,70,0.4); color:#e63946; }

.rw-ghost { opacity:0.3; background:rgba(255,255,255,0.06); }

/* Content Type subtle row tints */
.rw-row.ct-movie {
  background: color-mix(in srgb, var(--accent-blue, #3498db) 6%, transparent);
}
.rw-row.ct-show {
  background: color-mix(in srgb, #9b59b6 6%, transparent);
}
.rw-row.ct-documentary {
  background: color-mix(in srgb, #f39c12 6%, transparent);
}
.rw-row.ct-news {
  background: color-mix(in srgb, #1abc9c 6%, transparent);
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
  font-size: 0.62rem;
  font-weight: 800;
  padding: 1px 4px;
  border-radius: 3px;
  line-height: 1;
  text-transform: uppercase;
}

.badge-age.age-k { background: #2ecc71; color: #fff; }
.badge-age.age-8 { background: #f1c40f; color: #000; }
.badge-age.age-12 { background: #e67e22; color: #fff; }
.badge-age.age-16 { background: #d35400; color: #fff; }
.badge-age.age-18 { background: #c0392b; color: #fff; }

.badge-tp {
  background: #e74c3c;
  color: #fff;
  border: 1px solid #c0392b;
}

.badge-content.content-movie { background: #3498db; color: #fff; }
.badge-content.content-show { background: #9b59b6; color: #fff; }
.badge-content.content-documentary { background: #f39c12; color: #000; }
.badge-content.content-news { background: #1abc9c; color: #fff; }

.rw-eta-hint {
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.35);
  margin-left: 5px;
}
</style>
