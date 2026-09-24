<script setup lang="ts">
import { computed, inject } from 'vue';
import type { RundownItem } from '../stores/rundown';
import type { LibraryIndicator } from '../stores/mediaDefaults';
import StatusIndicator from './StatusIndicator.vue';
import AppIcon from './ui/AppIcon.vue';
import DescriptorChips from './ui/DescriptorChips.vue';
import RenderIsland from './ui/RenderIsland.vue';
import { RUNDOWN_LIVE_PROGRESS } from '../lib/rundownLiveProgress';
import type { IconName } from './ui/icons';
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
  /**
   * 0-100 progress for the active row when no `RundownList` provides the live
   * value (tests, standalone use). Inside the list the hairline reads
   * RUNDOWN_LIVE_PROGRESS instead, so the list never re-renders for it.
   */
  progressPct?: number;
  /** 'green' = playing instance, 'red' = current playing index row. */
  progressTone: '' | 'green' | 'red';
  /** playbackCountdownStr when this row is the playing instance, else ''. */
  countdown: string;
  /**
   * §3.2: elapsed on the playing row, '' everywhere else. When it is set the
   * cell reads as two lines -- remaining above, elapsed / total below.
   */
  elapsedLabel: string;
  /** The row's total: `00:04:53` at rest, the compact `00:34` while playing. */
  totalLabel: string;
  dayLabel: string;
  atKind: '' | 'done' | 'now' | 'gap' | 'time';
  atText: string;
  playProtected: boolean;
}>();

/**
 * §3.2: the last ten seconds.
 *
 * The countdown arrives as a formatted string (`-00:22`, `-01:05:03`) rather
 * than a number, and the plan is explicit that no new prop is warranted for
 * this -- read the string. Anything that does not parse is simply not urgent.
 */
const countdownIsImminent = computed(() => {
  const parts = props.countdown.replace('-', '').split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return false;
  const seconds = parts.reduce((acc, n) => acc * 60 + n, 0);
  return seconds <= 10;
});

const emit = defineEmits<{
  (e: 'select', ev: MouseEvent): void;
  (e: 'contextmenu', ev: MouseEvent): void;
  (e: 'dragover', ev: DragEvent): void;
  (e: 'drop', ev: DragEvent): void;
  (e: 'play'): void;
  (e: 'delete'): void;
  (e: 'pointerdown-handle', ev: PointerEvent): void;
}>();



const typeIcon = (type: RundownItem['type']): IconName =>
  ({ video: 'film', live: 'live', graphic: 'graphic', gap: 'gap' } as const)[type] || 'file';
// Resolved through theme tokens so the glyphs stay legible on a white panel.
const typeColor = (type: RundownItem['type']) =>
  ({
    video: 'var(--accent-cyan)',
    live: 'var(--status-onair)',
    graphic: 'var(--accent-purple)',
    gap: 'var(--status-warning)'
  }[type] || 'var(--text-secondary)');

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

const indicatorTitle = (indicator?: LibraryIndicator) => ({
  spot: 'Commercial tag: spot',
  telemarketing: 'Commercial tag: telemarketing',
  none: ''
}[indicator || 'none']);

// §6.1: the content type is a 3px tint bar and a tooltip, not a chip. It used
// to be a full-width row tint that lowered the contrast of `selected` and
// `next-up` underneath it.
const typeLabel = (type: RundownItem['type']) =>
  ({ video: 'Clip', live: 'Live source', graphic: 'Graphic', gap: 'Gap / hard start' }[type] || 'Item');

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

const trimTitle = (item: RundownItem) => {
  if (item.type === 'gap') return item.hardStartTime ? `Hard start ${item.hardStartTime}` : 'Gap';
  if (item.type === 'live') return 'Live source — runs until the next take';
  const display = trimDisplay(item);
  return display === 'FULL' ? 'Plays in full' : `Trimmed: in ${display.replace('→', ', out ')}`;
};

const trimDisplay = (item: RundownItem) => {
  if (item.type === 'gap') return item.hardStartTime ? 'HARD START' : 'GAP';
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
  // §6.2: the rating is expressed by its chip alone now. It used to also drive
  // a 6px inset stripe on the row and a signal bar next to the status dot.
  'ct-movie': props.item.content_type === 'movie',
  'ct-show': props.item.content_type === 'show',
  'ct-documentary': props.item.content_type === 'documentary',
  'ct-news': props.item.content_type === 'news'
}));

/**
 * §3.2 + perf backlog: progress is a hairline, not a repainting background.
 *
 * The row's `background` was a two-stop linear-gradient whose stop position was
 * the progress percentage. The store's progress loop runs on a 250 ms interval,
 * so that gradient forced a full paint of the widest row in the app four times
 * a second, for the whole duration of every clip. It also said the same thing
 * as the tint and the left bar.
 *
 * The tint is now a flat, static colour set by a class, and progress is a 2 px
 * overlay at the row's bottom edge scaled with `transform: scaleX()` -- work
 * the compositor does without touching layout or paint.
 */
const liveProgress = inject(RUNDOWN_LIVE_PROGRESS, null);
// Read only inside the hairline's RenderIsland: the 4-10 Hz updates
// re-render the hairline, not the row.
const progressScale = computed(() => {
  const pct = liveProgress && props.progressTone ? liveProgress[props.progressTone].value : (props.progressPct ?? 0);
  return Math.min(1, Math.max(0, pct / 100));
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
    :data-progress-tone="progressTone || undefined"
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
    <div class="rw-num">
      <AppIcon v-if="item.type === 'gap'" name="gap" :size="14" />
      <template v-else>{{ index + 1 }}</template>
    </div>

    <!-- UI F-18: one status indicator. The row used to carry the dot AND one
         or two "signal bars" AND a 6px rating stripe AND a rating pill — the
         same fact told four times. -->
    <div class="rw-status">
      <StatusIndicator :tone="itemStatusTone" variant="dot" :tooltip="itemTooltip" />
    </div>

    <div class="rw-type-icon" :style="{ color: typeColor(item.type) }" :title="typeLabel(item.type)">
      <AppIcon :name="typeIcon(item.type)" />
    </div>

    <!-- UI F-03: the title is the only flexible column, and carries nothing
         but the title. The flags that used to sit inside it are their own
         column now, so a clip name no longer truncates to "K…". -->
    <div class="rw-name" :title="getDisplayName(item)">
      <span class="rw-name-text">{{ getDisplayName(item) }}</span>
    </div>

    <div class="rw-flags">
      <span
        v-if="item.complianceRating && item.complianceRating !== 'none'"
        data-testid="age-rating-badge"
        class="rw-rating-badge"
        :class="ratingClass(item.complianceRating)"
        :title="`Age rating ${item.complianceRating.toUpperCase()}${item.tp_flag ? ' · product placement' : ''}`"
      >
        {{ item.complianceRating.toUpperCase() }}
        <span v-if="item.tp_flag" class="rw-tp-dot" aria-hidden="true"></span>
      </span>
      <span v-else-if="item.tp_flag" class="rw-tag-badge tone-tp" title="Product placement">TP</span>
      <DescriptorChips class="rw-desc-chips" :ids="item.complianceDescriptors" />

      <span
        v-if="item.libraryIndicator && item.libraryIndicator !== 'none'"
        class="rw-tag-badge"
        :class="indicatorToneClass(item.libraryIndicator)"
        :title="indicatorTitle(item.libraryIndicator)"
      >{{ indicatorLabel(item.libraryIndicator) }}</span>
    </div>

    <div class="rw-inout" :title="trimTitle(item)">{{ trimDisplay(item) }}</div>

    <!-- §3.2: what the operator needs from this cell, in order -- time
         remaining first and largest, elapsed / total underneath as a glance,
         and nothing else. It used to stack three values in 96 px and the At
         column squeezed the word ON AIR in beside them. -->
    <div class="rw-dur">
      <span
        v-if="countdown"
        class="rw-countdown"
        :class="{ 'is-imminent': countdownIsImminent }"
      >{{ countdown }}</span>
      <span v-if="elapsedLabel" class="rw-dur-sub">{{ elapsedLabel }} / {{ totalLabel }}</span>
      <span v-else class="rw-dur-value">{{ totalLabel }}</span>
    </div>

    <div class="rw-at">
      <span v-if="atKind === 'done'" class="tc-done">PLAYED</span>
      <!-- The on-air state is already said by the row tint, the left bar and
           the tab's pill. Here it is a compact mark, not a fourth sentence
           competing with the numbers beside it. -->
      <span v-else-if="atKind === 'now'" class="rw-onair-pill">
        <span class="rw-onair-dot" aria-hidden="true"></span>ON AIR
      </span>
      <span v-else-if="atKind === 'gap'" class="tc-gap">{{ atText }}</span>
      <span v-else-if="atKind === 'time'" class="tc-sched">{{ atText }}</span>
    </div>

    <!-- Row actions -->
    <div class="rw-actions">
      <button
        class="btn btn--icon btn--sm row-btn row-btn-play"
        :disabled="rundown.isRundownLocked"
        :title="rundown.isRundownLocked ? 'Rundown is Locked' : (item.type === 'gap' ? 'Play next content after this gap line' : `Play from #${index+1}`)"
        @click.stop="!rundown.isRundownLocked && emit('play')"
      >
        <AppIcon name="play" :size="12" :stroke-width="2.5" />
      </button>
      <button
        v-if="!playProtected && !rundown.isRundownLocked"
        class="btn btn--icon btn--sm row-btn row-btn-del"
        title="Remove (Del)"
        aria-label="Remove item"
        @click.stop="emit('delete')"
      >
        <AppIcon name="close" :size="12" :stroke-width="2.5" />
      </button>
    </div>

    <RenderIsland v-if="progressTone">
      <div
        class="rw-progress-hairline"
        :style="{ transform: `scaleX(${progressScale})` }"
        aria-hidden="true"
      ></div>
    </RenderIsland>
  </div>
</template>

<style scoped>
.rw-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--rw-col-gap);
  min-height: var(--row-h-rundown, 48px);
  height: var(--row-h-rundown, 48px);
  /* Never narrower than its columns. At a snapped window the columns used to
     spill past the row's box: the play button sat outside the row, the tint
     and the progress hairline stopped short of it. Now the box grows with
     them and the list scrolls the whole row. */
  min-width: min-content;
  padding: 0 var(--space-2);
  margin: var(--space-0) 0;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  cursor: pointer;
  user-select: none;
  transition: background var(--dur-fast), border-color var(--dur-fast), transform var(--dur-fast);
  /* §5.3: a row is its own surface, not the panel it sits in. Every state
     below sets `--rw-row-bg` rather than `background`, so the pinned Actions
     cell can paint exactly the row's colour over an opaque base. */
  --rw-row-bg: var(--surface-row);
  background: var(--rw-row-bg);
}
.rw-row:hover { --rw-row-bg: var(--bg-hover); }
/* §6.2 precedence, top wins:
   1 playing · 2 next-up-imminent · 3 next-up · 4 selected · 5 played ·
   6 content-type (a 3px left bar only) · 7 rating (its chip only).
   The content tints used to be full-row backgrounds that lowered the contrast
   of selected and next-up underneath them, and whose :hover collapsed to one
   blue `!important`.

   The rules that carry that precedence are further down, in one ordered
   block — see "§3.10". */
.rw-row.played   { opacity: var(--opacity-muted); }
.rw-row.next-up-imminent::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  box-shadow: var(--glow-armed);
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
  will-change: opacity;
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
  border-radius: var(--radius-pill);
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
  --rw-row-bg: color-mix(in srgb, var(--accent-orange) 8%, var(--bg-secondary));
}
.rw-row.gap-line .rw-name,
.rw-row.gap-line .rw-dur,
.rw-row.gap-line .rw-inout {
  color: var(--accent-orange);
  font-style: italic;
}

/* --- §3.10 · the row's states, in precedence order ------------------------
 *
 * Every one of these selectors has the same specificity, so the file's order
 * *is* the precedence. That was true before as well; what was missing was
 * saying so. Instead, `.selected` and `.playing` were written above the tints
 * that would otherwise beat them and given four `!important`s to win anyway —
 * which is how the green progress tint became unreachable: an `!important`
 * red always covered it.
 *
 * Weakest first. The one `:not()` is the real relationship — the progress
 * tints do not compete with "playing", they *are* playing, coloured by how far
 * through the clip it is.
 *
 * Flat tints, so the row paints once when it starts playing rather than four
 * times a second for the length of the clip.
 */
.rw-row.selected {
  --rw-row-bg: var(--bg-active);
  border-color: color-mix(in srgb, var(--accent-primary) 45%, transparent);
}

.rw-row.next-up {
  --rw-row-bg: color-mix(in srgb, var(--accent-yellow) 12%, var(--bg-secondary));
  border-color: color-mix(in srgb, var(--accent-yellow) 35%, transparent);
}

.rw-row.playing:not([data-progress-tone]) {
  --rw-row-bg: color-mix(in srgb, var(--accent-red) 12%, var(--bg-secondary));
  border-color: color-mix(in srgb, var(--accent-red) 45%, transparent);
}

.rw-row[data-progress-tone='green'] {
  --rw-row-bg: color-mix(in srgb, var(--status-ready) 12%, var(--bg-secondary));
  border-color: color-mix(in srgb, var(--status-ready) 40%, transparent);
}
.rw-row[data-progress-tone='red'] {
  --rw-row-bg: color-mix(in srgb, var(--status-onair) 16%, var(--bg-secondary));
  border-color: color-mix(in srgb, var(--status-onair) 40%, transparent);
}

.rw-progress-hairline {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  transform-origin: left center;
  border-radius: 0 var(--radius-pill) var(--radius-pill) 0;
  background: var(--status-onair);
  pointer-events: none;
}
.rw-row[data-progress-tone='green'] .rw-progress-hairline {
  background: var(--status-ready);
}

/* The countdown is the one number an operator reads mid-take, so it is the
   largest thing in the cell. It was green on a red row -- a mixed signal about
   the only row that is actually on air. */
.rw-countdown {
  font-size: var(--fs-md);
  line-height: var(--lh-tight);
  font-weight: var(--fw-bold);
  color: var(--status-onair);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

/* Under ten seconds the number changes colour and weight, not size -- a cell
   that reflows at T-10 is the last thing anyone needs mid-take. No animation
   on the digits. */
.rw-countdown.is-imminent {
  color: var(--status-warning);
  font-weight: var(--fw-semibold);
}

/* Elapsed / total: glanced at, not read. */
.rw-dur-sub {
  font-size: var(--fs-xs);
  line-height: var(--lh-tight);
  font-weight: var(--fw-semibold);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}


.rw-handle { color: var(--text-muted); cursor: grab; font-size: var(--fs-lg); width: var(--rw-col-handle); text-align: center; flex-shrink: 0; }
.rw-num     { width: var(--rw-col-num); text-align: center; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--text-secondary); flex-shrink: 0; font-family: var(--font-mono); }
.rw-status { width: var(--rw-col-status); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.rw-signal {
  width: 5px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--border-medium);
  border: 1px solid var(--border-subtle);
}
.rw-type-icon { width: var(--rw-col-type); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
/* F-03: the one flexible column, and the only one allowed to shrink. */
.rw-name    { flex: 1 1 auto; min-width: var(--rw-col-title-min); font-size: var(--fs-lg); font-weight: var(--fw-semibold); letter-spacing: var(--tracking-caps); color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rw-flags   { width: var(--rw-col-flags); display: flex; align-items: center; justify-content: flex-start; gap: var(--space-1); flex-shrink: 0; overflow: hidden; }
.rw-rating-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 34px; padding: var(--space-0) var(--space-2); border-radius: var(--radius-pill);
  font-size: var(--fs-xs); font-weight: var(--fw-semibold); letter-spacing: var(--tracking-caps);
  border: 1px solid var(--border-medium);
  box-shadow: var(--shadow-1);
}
.rw-tag-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-pill);
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps);
  border: 1px solid var(--border-medium);
  text-transform: uppercase;
}
.rw-rating-empty { color: var(--text-muted); font-size: var(--fs-sm); }
.rw-rating-badge.rating-k, .rw-signal.tone-rating-k { color: var(--rating-k); background: color-mix(in srgb, var(--rating-k) 16%, transparent); border-color: color-mix(in srgb, var(--rating-k) 40%, transparent); }
.rw-rating-badge.rating-8, .rw-signal.tone-rating-8 { color: var(--rating-8); background: color-mix(in srgb, var(--rating-8) 16%, transparent); border-color: color-mix(in srgb, var(--rating-8) 40%, transparent); }
.rw-rating-badge.rating-12, .rw-signal.tone-rating-12 { color: var(--rating-12); background: color-mix(in srgb, var(--rating-12) 18%, transparent); border-color: color-mix(in srgb, var(--rating-12) 45%, transparent); }
.rw-rating-badge.rating-16, .rw-signal.tone-rating-16 { color: var(--rating-16); background: color-mix(in srgb, var(--rating-16) 16%, transparent); border-color: color-mix(in srgb, var(--rating-16) 40%, transparent); }
.rw-rating-badge.rating-18, .rw-signal.tone-rating-18 { color: var(--rating-18); background: color-mix(in srgb, var(--rating-18) 18%, transparent); border-color: color-mix(in srgb, var(--rating-18) 45%, transparent); }
.rw-tag-badge.tone-tag-spot, .rw-signal.tone-tag-spot { color: var(--tag-spot); background: color-mix(in srgb, var(--tag-spot) 16%, transparent); border-color: color-mix(in srgb, var(--tag-spot) 40%, transparent); }
.rw-tag-badge.tone-tag-telemarketing, .rw-signal.tone-tag-telemarketing { color: var(--tag-telemarketing); background: color-mix(in srgb, var(--tag-telemarketing) 16%, transparent); border-color: color-mix(in srgb, var(--tag-telemarketing) 40%, transparent); }
/* §3.2: `0:12→0:00` overflowed 86 px at 0.76rem. At the token size it fits,
   and anything longer ellipses with the full `IN … OUT …` in the tooltip
   rather than spilling into the duration column. */
.rw-inout   {
  width: var(--rw-col-trim); text-align: right; flex-shrink: 0;
  font-size: var(--fs-xs); font-weight: var(--fw-semibold); line-height: var(--lh-tight);
  color: var(--text-muted); font-family: var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: var(--tracking-caps);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Both timing columns are right-aligned to the same edge, 12 px apart, so the
   header can no longer read "DURATION AT" as one word. */
.rw-dur     { width: var(--rw-col-dur); display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: var(--space-0); text-align: right; font-size: var(--fs-md); font-weight: var(--fw-semibold); color: var(--text-primary); font-variant-numeric: tabular-nums; flex-shrink: 0; font-family: var(--font-mono); letter-spacing: var(--tracking-caps); }
.rw-at      { width: var(--rw-col-at); display: flex; align-items: center; justify-content: flex-end; gap: var(--space-1); flex-shrink: 0; margin-left: var(--space-2); text-align: right; }
/* Start-aligned: the on-air row has no delete button (it is protected), and
   right-aligned its play button slid 30px out of line with every other row. */
.rw-actions { width: var(--rw-col-actions); display: flex; gap: var(--space-1); flex-shrink: 0; justify-content: flex-start; }
/* Pinned to the list's right edge, so play and delete stay in reach however
   narrow the panel is; once the list scrolls sideways, the rest of the row
   slides under them. The row's own colour over the panel's, so it matches the
   row exactly whether or not anything is underneath. */
.rw-actions {
  position: sticky;
  right: 0;
  z-index: 1;
  background: linear-gradient(var(--rw-row-bg), var(--rw-row-bg)), var(--bg-secondary);
}
/* Overflowing content paints into the list's reserved scrollbar gutter, just
   right of the pinned cell; this extends the cell's surface over it. When the
   row fits, it lies inside the row's own padding in the row's own colour. */
.rw-actions::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  /* Overlaps the cell by 1px: at a fractional display scale the seam
     between them let a hairline of the text underneath through. Exactly as
     wide as the row's right padding: any wider and, when the row fits, it
     painted a square strip past the row's rounded edge and gave the list
     phantom sideways scroll. */
  left: calc(100% - 1px);
  width: calc(var(--space-2) + 1px);
  background: inherit;
  /* Beneath the buttons (the cell is its own stacking context): above them,
     its 1px overlap cut the delete button's right edge and hover border. */
  z-index: -1;
}

/* The delete control appears on hover or keyboard focus, so a 300-row list is
   not 300 delete buttons one mis-click away from the rundown. */
.rw-actions .row-btn-del {
  opacity: 0;
  transition:
    opacity var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.rw-row:hover .row-btn-del,
.rw-row:focus-within .row-btn-del,
.rw-row.selected .row-btn-del {
  opacity: 1;
}

@media (hover: none) {
  /* Touch has no hover, so the control must always be reachable. */
  .rw-actions .row-btn-del { opacity: 1; }
}

.tc-day   { display: inline-block; min-width: 2.2em; font-size: var(--fs-xs); font-weight: var(--fw-bold); text-transform: uppercase; color: var(--text-muted); letter-spacing: var(--tracking-caps); text-align: left; }
.tc-sched { font-size: var(--fs-sm); color: var(--text-secondary); font-variant-numeric: tabular-nums; font-family: var(--font-mono); text-align: left; }
.tc-done  { font-size: var(--fs-xs); color: var(--text-muted); font-weight: var(--fw-semibold); }
.tc-gap   { font-size: var(--fs-sm); color: var(--accent-orange); font-family: var(--font-mono); text-align: left; font-weight: var(--fw-semibold); }
/* §3.2: a mark, not a sentence. The dot reuses the row's existing pulse
   overlay treatment -- opacity only, gated by prefers-reduced-motion. */
.rw-onair-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--status-onair) 16%, transparent);
  color: var(--status-onair);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
  white-space: nowrap;
}
.rw-onair-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
}

/* §7.2: the row's two actions are `.btn--icon.btn--sm` now. What was here was
   the family's rules written out again at a hard 26 px that ignored the
   density setting, at `--radius-sm` instead of `--radius-md`, and on
   `transition: var(--dur-fast)` -- the `transition: all` the rest of the app was audited
   to remove. All that is left is the border the row's buttons need (the family
   draws `--icon` borderless, but these sit on a tinted row and would vanish)
   and the two tones. */
.row-btn {
  flex-shrink: 0;
  border-color: var(--border-medium);
  background: var(--bg-hover);
}
.row-btn:hover:not(:disabled) {
  background: var(--bg-surface-elevated);
  border-color: var(--border-strong);
}
.row-btn-play {
  color: var(--accent-blue);
  border-color: color-mix(in srgb, var(--accent-blue) 35%, transparent);
}
.row-btn-play:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-blue) 18%, transparent);
  color: var(--accent-blue);
}
.row-btn-del:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-red) 18%, transparent);
  border-color: var(--accent-red);
  color: var(--accent-red);
}

.rw-ghost { opacity: var(--opacity-disabled); background: var(--bg-hover); }

/* Content Type subtle row tints */
/* Content type: a 3px bar at the leading edge, never a row tint. Drawn on a
   pseudo-element so it composes with whatever state colour the row carries. */
.rw-row.ct-movie::before,
.rw-row.ct-show::before,
.rw-row.ct-documentary::before,
.rw-row.ct-news::before {
  content: '';
  position: absolute;
  left: 0;
  top: var(--space-2);
  bottom: var(--space-2);
  width: var(--border-accent-w);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  pointer-events: none;
}

.rw-row.ct-movie::before { background: var(--type-movie); }
.rw-row.ct-show::before { background: var(--type-show); }
.rw-row.ct-documentary::before { background: var(--type-documentary); }
.rw-row.ct-news::before { background: var(--type-news); }

/* Badges styling */
.rw-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* The row is `min-width: min-content`, and a title with no break points
     ("Feature_Film_Noir_1958") has its whole length as its min-content, so
     one long name widened every row past the list. Contained, the title
     contributes only its floor, `--rw-col-title-min`, and ellipsises. */
  contain: inline-size;
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
  gap: var(--space-1);
}

.mcr-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  line-height: var(--lh-none);
  text-transform: uppercase;
}

.badge-age.age-k { background: var(--rating-k); color: var(--rating-k-fg); }
.badge-age.age-8 { background: var(--rating-8); color: var(--rating-8-fg); font-weight: var(--fw-bold); }
.badge-age.age-12 { background: var(--rating-12); color: var(--rating-12-fg); font-weight: var(--fw-bold); }
.badge-age.age-16 { background: var(--rating-16); color: var(--rating-16-fg); }
.badge-age.age-18 { background: var(--rating-18); color: var(--rating-18-fg); }

.badge-tp {
  background: var(--rating-tp);
  color: var(--rating-tp-fg);
  border: 1px solid var(--border-medium);
}

.badge-content.content-movie { background: var(--type-movie); color: var(--text-on-danger); }
.badge-content.content-show { background: var(--type-show); color: var(--text-on-accent); }
.badge-content.content-documentary { background: var(--type-documentary); color: var(--text-on-danger); font-weight: var(--fw-semibold); }
.badge-content.content-news { background: var(--type-news); color: var(--text-on-success); }

/* --- §6.1 flags column ---------------------------------------------------- */

/* TP rides the rating chip as a dot rather than taking a chip of its own; it
   only becomes a standalone chip when there is no rating to ride. */
.rw-tp-dot {
  width: 4px;
  height: 4px;
  margin-left: var(--space-0);
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.rw-tag-badge.tone-tp {
  color: var(--rating-tp);
  background: color-mix(in srgb, var(--rating-tp) 16%, transparent);
  border-color: color-mix(in srgb, var(--rating-tp) 40%, transparent);
}

.rw-dur-value {
  line-height: var(--lh-tight);
}

/* --- Responsive column shedding (§6.1) ------------------------------------
   Driven by the rundown list's own width via a container query, so the
   library split width and a snapped window both count -- the same reasoning
   as the control bar (F-01). The steps are where each layout stops fitting,
   measured at Comfortable: the full row needs 784px, then 744 with the
   title's floor at 140 (set in RundownList), 650 without Trim, 604 with
   rating-only flags, 504 without At and 460 with the title's floor at 96.
   Each breakpoint sits 8px early for Large density's wider Actions.
   RundownList sheds the header labels at the same widths. Below 460 the
   list scrolls sideways under the pinned Actions. */
@container rundown (max-width: 752px) {
  .rw-inout { display: none; }
}

@container rundown (max-width: 660px) {
  .rw-flags { width: var(--rw-col-flags-narrow); }
  .rw-flags .rw-tag-badge,
  .rw-flags .rw-desc-chips { display: none; }
}

@container rundown (max-width: 612px) {
  .rw-at { display: none; }
}
</style>
