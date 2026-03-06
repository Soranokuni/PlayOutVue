<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { obs, isObsConnected } from '../services/obs';

const previewSrc = ref<string | null>(null);
const isCapturing = ref(false);
const lastError = ref('');
let pollInterval: ReturnType<typeof setInterval> | null = null;

const captureFrame = async () => {
    if (!isObsConnected.value || isCapturing.value) return;
    isCapturing.value = true;
    try {
        // GetVideoMixSnapshot captures the live Program output — no source name needed.
        // This is the correct OBS WebSocket v5 API for program monitoring.
        const { imageData } = await (obs as any).call('GetVideoMixSnapshot', {
            videoMixType: 'OBS_WEBSOCKET_VIDEO_MIX_TYPE_PROGRAM',
            imageFormat: 'jpeg',
            imageWidth: 480,
            imageHeight: 270,
            imageCompressionQuality: 75
        });
        previewSrc.value = imageData;
        lastError.value = '';
    } catch (e: any) {
        // If GetVideoMixSnapshot not supported, fall back to GetSourceScreenshot on the current scene
        if (!lastError.value) {
            try {
                const sceneResp = await (obs as any).call('GetCurrentProgramScene');
                const sceneName = sceneResp?.currentProgramSceneName || sceneResp?.sceneName;
                if (sceneName) {
                    const { imageData } = await (obs as any).call('GetSourceScreenshot', {
                        sourceName: sceneName,
                        imageFormat: 'jpeg',
                        imageWidth: 480,
                        imageHeight: 270,
                        imageCompressionQuality: 75
                    });
                    previewSrc.value = imageData;
                    lastError.value = '';
                }
            } catch {
                lastError.value = e?.message || String(e);
            }
        }
    } finally {
        isCapturing.value = false;
    }
};

onMounted(() => {
    pollInterval = setInterval(captureFrame, 200); // 5fps - gentle on OBS
});

onUnmounted(() => {
    if (pollInterval) clearInterval(pollInterval);
});
</script>

<template>
  <div class="preview-monitor">
    <div class="monitor-header">
      <span class="badge-program">● PROGRAM</span>
      <span class="text-secondary" style="font-size:0.68rem;">
        {{ isObsConnected ? (previewSrc ? 'Live' : 'Waiting…') : 'Not connected' }}
      </span>
    </div>
    <div class="monitor-frame">
      <img v-if="previewSrc" :src="previewSrc" class="monitor-image" alt="OBS Program Output">
      <div v-else class="monitor-placeholder">
        <div v-if="!isObsConnected">⬤ NOT CONNECTED</div>
        <div v-else-if="lastError" style="font-size:0.65rem; color:rgba(255,100,100,0.6); max-width:180px; text-align:center;">{{ lastError }}</div>
        <div v-else>⌛ Awaiting OBS…</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-monitor { display:flex;flex-direction:column;height:100%;background:#000;border-radius:8px;overflow:hidden; }
.monitor-header { display:flex;justify-content:space-between;align-items:center;padding:4px 10px;background:rgba(0,0,0,0.6);border-bottom:1px solid rgba(255,255,255,0.08); }
.badge-program { color:#e63946;font-size:0.72rem;font-weight:700;letter-spacing:1px;text-transform:uppercase; }
.monitor-frame { flex:1;display:flex;align-items:center;justify-content:center;background:#0a0a0a;min-height:0; }
.monitor-image { width:100%;height:100%;object-fit:contain;display:block; }
.monitor-placeholder { color:rgba(255,255,255,0.2);font-size:0.78rem;text-align:center;letter-spacing:0.5px; }
</style>
