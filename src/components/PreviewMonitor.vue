<script setup lang="ts">
import { ref } from 'vue';
import { activePlayoutCapabilities, activePlayoutLabel, isPlayoutConnected } from '../services/playout';

const previewSrc = ref<string | null>(null);
const lastError = ref('');
</script>

<template>
  <div class="preview-monitor">
    <div class="monitor-header">
      <span class="badge-program">● PROGRAM</span>
      <span class="text-secondary" style="font-size:0.68rem;">
        {{ activePlayoutCapabilities.preview ? (isPlayoutConnected ? (previewSrc ? 'Live' : 'Waiting…') : 'Not connected') : activePlayoutLabel + ' preview unavailable' }}
      </span>
    </div>
    <div class="monitor-frame">
      <img v-if="previewSrc" :src="previewSrc" class="monitor-image" alt="Playout Program Output">
      <div v-else class="monitor-placeholder">
        <div>⬤ PREVIEW NOT AVAILABLE</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-monitor { display:flex;flex-direction:column;height:100%;background:#000;border-radius:8px;overflow:hidden; }
.monitor-header { display:flex;justify-content:space-between;align-items:center;padding:4px 10px;background:var(--bg-secondary);border-bottom:1px solid var(--glass-border); }
.badge-program { color:#e63946;font-size:0.72rem;font-weight:700;letter-spacing:1px;text-transform:uppercase; }
.monitor-frame { flex:1;display:flex;align-items:center;justify-content:center;background:#0a0a0a;min-height:0; }
.monitor-image { width:100%;height:100%;object-fit:contain;display:block; }
.monitor-placeholder { color:rgba(255,255,255,0.2);font-size:0.78rem;text-align:center;letter-spacing:0.5px; }
</style>
