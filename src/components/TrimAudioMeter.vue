<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useSettingsStore } from '../stores/settings';
import {
  codeToDb,
  dbToFraction,
  freshMeterChannel,
  peakCodesBetween,
  stepMeter,
  type AudioPeaks,
  type MeterChannelState,
} from '../lib/audioPeaks';

/**
 * Stereo source-level meter for the trimmer.
 *
 * It reads the file's peak envelope at the preview's position rather than the
 * sound coming out of the speakers, so it shows the clip's own level whatever
 * the monitor volume or mute is set to, and it works while paused: parked on a
 * frame, it shows that frame's level. Scale -60..0 dBFS; the mark at -18 is the
 * EBU R68 alignment level.
 */
const props = defineProps<{
  peaks: AudioPeaks | null;
  video: HTMLVideoElement | null;
  /** One frame, used as the read window while paused. */
  frameMs: number;
}>();

const FLOOR_DB = -60;
const ALIGN_DB = -18;
const HOT_DB = -9;
const TICKS = [-60, -40, -30, -18, -9, 0];

const settings = useSettingsStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const tickMarks = computed(() => TICKS.map((db) => ({ db, pct: dbToFraction(db, FLOOR_DB) * 100 })));

let loop = 0;
let lastNow = 0;
let lastPosMs = -1;
let channels: [MeterChannelState, MeterChannelState] = [freshMeterChannel(), freshMeterChannel()];
let drawn = '';
let palette: { low: string; mid: string; hot: string; track: string } | null = null;

const readPalette = () => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const style = getComputedStyle(canvas);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  palette = {
    low: token('--accent-green', 'currentColor'),
    mid: token('--accent-yellow', 'currentColor'),
    hot: token('--accent-red', 'currentColor'),
    track: token('--border-subtle', 'currentColor'),
  };
  drawn = '';
};

const paint = () => {
  const canvas = canvasRef.value;
  if (!canvas || !palette) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  const key = `${w}x${h}|${channels.map((c) => `${c.db.toFixed(1)}/${c.holdDb.toFixed(1)}`).join('|')}`;
  if (key === drawn) return;
  drawn = key;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  const gap = Math.round(2 * dpr);
  const bar = Math.max(1, Math.floor((h - gap) / 2));
  const xAlign = dbToFraction(ALIGN_DB, FLOOR_DB) * w;
  const xHot = dbToFraction(HOT_DB, FLOOR_DB) * w;

  channels.forEach((state, index) => {
    const y = index * (bar + gap);
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette!.track;
    ctx.fillRect(0, y, w, bar);

    const x = dbToFraction(state.db, FLOOR_DB) * w;
    const segment = (from: number, to: number, color: string) => {
      const end = Math.min(x, to);
      if (end <= from) return;
      ctx.fillStyle = color;
      ctx.fillRect(from, y, end - from, bar);
    };
    segment(0, xAlign, palette!.low);
    segment(xAlign, xHot, palette!.mid);
    segment(xHot, w, palette!.hot);

    const hold = dbToFraction(state.holdDb, FLOOR_DB) * w;
    if (hold > 0) {
      ctx.fillStyle = state.holdDb >= HOT_DB ? palette!.hot : state.holdDb >= ALIGN_DB ? palette!.mid : palette!.low;
      ctx.fillRect(Math.min(w - dpr, hold), y, Math.max(1, Math.round(dpr * 2)), bar);
    }
  });
};

const tick = (now: number) => {
  loop = requestAnimationFrame(tick);
  const dt = lastNow ? now - lastNow : 0;
  lastNow = now;

  let inputs: [number, number] = [-Infinity, -Infinity];
  const v = props.video;
  if (props.peaks && v) {
    const pos = v.currentTime * 1000;
    const playing = !v.paused && !v.ended;
    // Playing: everything that went past since the last frame, so no peak is
    // skipped. Paused (or after a jump): the one frame under the playhead.
    const contiguous = playing && lastPosMs >= 0 && pos >= lastPosMs && pos - lastPosMs < 250;
    const [l, r] = contiguous
      ? peakCodesBetween(props.peaks, lastPosMs, pos)
      : peakCodesBetween(props.peaks, pos, pos + props.frameMs);
    lastPosMs = pos;
    inputs = [codeToDb(l), codeToDb(r)];
  }
  channels = [stepMeter(channels[0], inputs[0], dt), stepMeter(channels[1], inputs[1], dt)];
  paint();
};

watch(() => settings.theme, () => nextTick(readPalette));
watch(() => props.peaks, () => {
  channels = [freshMeterChannel(), freshMeterChannel()];
  lastPosMs = -1;
});

onMounted(() => {
  readPalette();
  loop = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  if (loop) cancelAnimationFrame(loop);
});
</script>

<template>
  <div class="trim-meter" role="img" aria-label="Source audio level, left and right channels">
    <canvas ref="canvasRef" class="trim-meter-bars"></canvas>
    <div class="trim-meter-scale" aria-hidden="true">
      <span
        v-for="t in tickMarks"
        :key="t.db"
        class="trim-meter-tick"
        :class="{ 'is-align': t.db === ALIGN_DB }"
        :style="{ left: t.pct + '%' }"
      >{{ t.db }}</span>
    </div>
  </div>
</template>

<style scoped>
.trim-meter {
  display: flex;
  flex-direction: column;
  gap: var(--space-0);
  min-width: 0;
  flex: 1;
}

.trim-meter-bars {
  width: 100%;
  height: 12px;
  display: block;
  border-radius: var(--radius-sm);
}

.trim-meter-scale {
  position: relative;
  height: 12px;
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.trim-meter-tick {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  line-height: 1;
}

.trim-meter-tick:first-child {
  transform: none;
}

.trim-meter-tick:last-child {
  transform: translateX(-100%);
}

.trim-meter-tick.is-align {
  color: var(--text-secondary);
  font-weight: var(--fw-semibold);
}
</style>
