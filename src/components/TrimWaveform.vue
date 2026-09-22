<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { columnCodes, codeToDb, dbToFraction, PEAK_CHANNELS, type AudioPeaks } from '../lib/audioPeaks';

/**
 * The trimmer timeline's stereo waveform: left channel above the centre line,
 * right below, on a dB scale so the start of a quiet word is as visible as a
 * loud one. Drawn under the IN/OUT handles, which stay the interactive layer;
 * the canvas takes no pointer events.
 */
const props = defineProps<{
  peaks: AudioPeaks | null;
  /** The visible window, in file milliseconds. */
  startMs: number;
  endMs: number;
  inMs: number;
  outMs: number;
}>();

const settings = useSettingsStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
let observer: ResizeObserver | null = null;
let frame = 0;

const draw = () => {
  frame = 0;
  const canvas = canvasRef.value;
  if (!canvas) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const pxWidth = Math.max(1, Math.round(width * dpr));
  const pxHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pxWidth) canvas.width = pxWidth;
  if (canvas.height !== pxHeight) canvas.height = pxHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, pxWidth, pxHeight);
  if (!props.peaks || props.endMs <= props.startMs) return;

  const style = getComputedStyle(canvas);
  const color = style.getPropertyValue('--text-secondary').trim() || 'currentColor';
  const columns = pxWidth;
  const codes = columnCodes(props.peaks, props.startMs, props.endMs, columns);
  const mid = pxHeight / 2;
  const half = mid - dpr;
  const span = props.endMs - props.startMs;
  const hasRange = props.outMs > props.inMs;

  ctx.fillStyle = color;
  for (let col = 0; col < columns; col++) {
    const atMs = props.startMs + ((col + 0.5) / columns) * span;
    const inside = !hasRange || (atMs >= props.inMs && atMs <= props.outMs);
    ctx.globalAlpha = inside ? 0.9 : 0.4;
    const up = dbToFraction(codeToDb(codes[col * PEAK_CHANNELS] ?? 0)) * half;
    const down = dbToFraction(codeToDb(codes[col * PEAK_CHANNELS + 1] ?? 0)) * half;
    if (up > 0) ctx.fillRect(col, mid - up, 1, up);
    if (down > 0) ctx.fillRect(col, mid, 1, down);
  }
  ctx.globalAlpha = 0.5;
  ctx.fillRect(0, Math.floor(mid), columns, Math.max(1, Math.round(dpr / 2)));
  ctx.globalAlpha = 1;
};

const schedule = () => {
  if (!frame) frame = requestAnimationFrame(draw);
};

watch(() => [props.peaks, props.startMs, props.endMs, props.inMs, props.outMs], schedule);
// A theme swap changes the tokens under the canvas; wait for the new ones.
watch(() => settings.theme, () => nextTick(schedule));

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && canvasRef.value) {
    observer = new ResizeObserver(schedule);
    observer.observe(canvasRef.value);
  }
  schedule();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (frame) cancelAnimationFrame(frame);
});
</script>

<template>
  <canvas ref="canvasRef" class="trim-waveform" aria-hidden="true"></canvas>
</template>

<style scoped>
.trim-waveform {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
