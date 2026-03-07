<script setup lang="ts">
import { ref, watch } from 'vue';
import MediaLibrary from './components/MediaLibrary.vue';
import RundownList from './components/RundownList.vue';
import MediaInspector from './components/MediaInspector.vue';
import SettingsModal from './components/SettingsModal.vue';
import PreviewMonitor from './components/PreviewMonitor.vue';
import { isObsConnected, ObsService, currentMediaTime, isPlaying, PlaybackService, obs } from './services/obs';
import { useSettingsStore } from './stores/settings';
import { useRundownStore } from './stores/rundown';

const settings = useSettingsStore();
const rundown  = useRundownStore();
const isStreaming  = ref(false);
const isSdiActive  = ref(false);
const showSettings = ref(false);

const leftWidth = ref(260);
const rightWidth = ref(300);
const isResizing = ref<'left'|'right'|null>(null);

const isLightMode = ref(localStorage.getItem('isLightMode') === 'true');
watch(isLightMode, (val) => {
    localStorage.setItem('isLightMode', String(val));
    if (val) document.body.classList.add('light-theme');
    else document.body.classList.remove('light-theme');
}, { immediate: true });

const startResizeLeft = () => { isResizing.value = 'left';  window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp); };
const startResizeRight = () => { isResizing.value = 'right'; window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp); };

const onMouseMove = (e: MouseEvent) => {
    if (isResizing.value === 'left') {
        leftWidth.value = Math.max(200, Math.min(600, e.clientX));
    } else if (isResizing.value === 'right') {
        rightWidth.value = Math.max(250, Math.min(800, window.innerWidth - e.clientX));
    }
};

const onMouseUp = () => {
    isResizing.value = null;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
};

obs.on('StreamStateChanged', (data: any) => { isStreaming.value = data.outputActive; });

const toggleConnection = async () => {
    if (isObsConnected.value) await ObsService.disconnect();
    else await ObsService.connect(settings.obsUrl, settings.obsPassword);
};

const playSelected = async () => {
    const items = rundown.activeItems;
    if (!items.length) return;
    const startIdx = rundown.selectedItemId
        ? Math.max(0, items.findIndex(i => i.id === rundown.selectedItemId))
        : 0;
    await PlaybackService.play(items as any, startIdx);
};

const stopPlayback = () => PlaybackService.stop();

const toggleStream = async () => {
    if (isStreaming.value) await ObsService.stopStream();
    else await ObsService.startStream();
};

const toggleSdi = async () => {
    if (!settings.decklinkOutputName) return;
    if (isSdiActive.value) {
        await ObsService.stopDeckLink(settings.decklinkOutputName);
        isSdiActive.value = false;
    } else {
        await ObsService.startDeckLink(settings.decklinkOutputName);
        isSdiActive.value = true;
    }
};
</script>

<template>
  <main class="app-shell" :style="`--left-w: ${leftWidth}px; --right-w: ${rightWidth}px; cursor: ${isResizing ? 'ew-resize' : 'default'}`">
    
    <aside class="panel panel-library glass-panel"><MediaLibrary /></aside>
    <div class="resizer resizer-left" @mousedown="startResizeLeft"></div>
    
    <section class="panel panel-rundown glass-panel"><RundownList /></section>
    <div class="resizer resizer-right" @mousedown="startResizeRight"></div>
    
    <aside class="panel panel-right">
      <div class="glass-panel panel-preview"><PreviewMonitor /></div>
      <div class="glass-panel panel-inspector"><MediaInspector /></div>
    </aside>

    <!-- Simplified Master Control Bar -->
    <footer class="control-bar glass-panel">

      <!-- Connection -->
      <div class="ctrl-section">
        <div class="status-dot" :class="{ connected: isObsConnected }"></div>
        <span class="ctrl-label">{{ isObsConnected ? 'OBS' : 'OFFLINE' }}</span>
        <button class="ctrl-btn" @click="toggleConnection" style="font-size:0.7rem;">
          {{ isObsConnected ? 'Disconnect' : 'Connect' }}
        </button>
      </div>

      <div class="ctrl-divider"></div>

      <!-- PLAY / STOP — the main call-to-action -->
      <div class="ctrl-section ctrl-play-wrap">
        <button
          v-if="!isPlaying"
          class="ctrl-btn btn-play"
          :disabled="!isObsConnected || !rundown.activeItems.length"
          @click="playSelected"
          title="Play playlist from selected item (or beginning)"
        >
          ▶ PLAY
        </button>
        <button
          v-else
          class="ctrl-btn btn-stop"
          @click="stopPlayback"
          title="Stop playback"
        >
          ■ STOP
        </button>
        
        <button v-if="isObsConnected" class="ctrl-btn btn-live-now" @click="PlaybackService.cutToLive()" title="Cut to Live Scene">
          🔴 LIVE NOW
        </button>
      </div>

      <div class="ctrl-divider"></div>

      <!-- Media Timecode -->
      <div class="ctrl-section">
        <div class="timecode">{{ currentMediaTime }}</div>
      </div>

      <div class="ctrl-divider"></div>

      <!-- Broadcast Stream & SDI -->
      <div class="ctrl-section">
        <div class="status-dot" :class="{ connected: isStreaming }" style="--dot-color:#e63946;"></div>
        <span class="ctrl-label">{{ isStreaming ? 'ON AIR' : 'STANDBY' }}</span>
        <button class="ctrl-btn" :class="{ 'btn-live': isStreaming }" :disabled="!isObsConnected" @click="toggleStream" style="font-size:0.7rem;">
          {{ isStreaming ? '■ Stop' : '● Stream' }}
        </button>

        <button v-if="settings.decklinkOutputName" class="ctrl-btn" :class="{ 'btn-live': isSdiActive }" :disabled="!isObsConnected" @click="toggleSdi" style="font-size:0.7rem; margin-left:12px;">
          {{ isSdiActive ? '■ SDI Stop' : '● SDI OUT' }}
        </button>
      </div>

      <div class="ctrl-divider"></div>

      <button class="ctrl-btn" style="font-size:0.75rem; margin-left:auto; width:40px;" @click="isLightMode = !isLightMode" :title="isLightMode ? 'Switch to Dark Mode' : 'Switch to Light Mode'">
        {{ isLightMode ? '🌙' : '☀️' }}
      </button>

      <button class="ctrl-btn" style="font-size:0.78rem;" @click="showSettings = true">⚙ Settings</button>
    </footer>

    <SettingsModal :is-open="showSettings" @close="showSettings = false" />
  </main>
</template>

<style scoped>
.app-shell {
  display: grid;
  grid-template-columns: var(--left-w) 8px 1fr 8px var(--right-w);
  grid-template-rows: 1fr 58px;
  grid-template-areas: "library r1 rundown r2 right" "ctrl ctrl ctrl ctrl ctrl";
  height: 100vh; gap: 0; padding: 5px; overflow: hidden;
  background: var(--bg-dark,#0d0d0d);
  user-select: none;
}
.panel-library  { grid-area: library; overflow:hidden; }
.panel-rundown  { grid-area: rundown; overflow:hidden; }
.panel-right    { grid-area: right; display:flex; flex-direction:column; gap:8px; overflow:hidden; }
.panel-preview  { flex: 0 0 170px; overflow:hidden; }
.panel-inspector { flex:1; overflow:hidden; }
.control-bar    { grid-area: ctrl; display:flex; align-items:center; gap:8px; padding:0 12px; margin-top:5px; }

.resizer {
  cursor: ew-resize;
  background: transparent;
  width: 100%;
  height: 100%;
  transition: background 0.2s;
}
.resizer:hover, .resizer:active {
  background: rgba(255, 255, 255, 0.1);
}
.resizer-left { grid-area: r1; }
.resizer-right { grid-area: r2; }

.ctrl-section    { display:flex; align-items:center; gap:6px; }
.ctrl-label      { font-size:0.68rem; color:rgba(255,255,255,0.45); letter-spacing:0.5px; white-space:nowrap; }
.ctrl-divider    { width:1px; height:26px; background:rgba(255,255,255,0.1); flex-shrink:0; }
.ctrl-play-wrap  { flex:0 0 auto; }

.ctrl-btn {
  background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12);
  color:var(--text-primary); border-radius:5px; cursor:pointer;
  padding:6px 12px; font-size:0.8rem; font-weight:500; transition:all 0.15s; white-space:nowrap;
}
.ctrl-btn:hover { background:rgba(255,255,255,0.12); }
.ctrl-btn:disabled { opacity:0.35; cursor:not-allowed; }

.btn-play {
  background:#33becc; border-color:#33becc;
  color:#000; font-size:1rem; font-weight:800;
  padding:9px 32px; letter-spacing:2px;
  box-shadow:0 0 16px rgba(51,190,204,0.4);
}
.btn-play:hover:not(:disabled) { background:#45d4e3; box-shadow:0 0 24px rgba(51,190,204,0.7); }

.btn-stop {
  background:#e63946; border-color:#e63946;
  color:#fff; font-size:1rem; font-weight:800;
  padding:9px 32px; letter-spacing:2px;
  box-shadow:0 0 16px rgba(230,57,70,0.4);
  animation:pulse-stop 1.5s ease-in-out infinite;
}
@keyframes pulse-stop {
  0%,100% { box-shadow:0 0 12px rgba(230,57,70,0.4); }
  50%      { box-shadow:0 0 28px rgba(230,57,70,0.8); }
}

.btn-live { background:rgba(230,57,70,0.2); border-color:rgba(230,57,70,0.5); color:#e63946; }

.btn-live-now {
  background:rgba(230,57,70,0.1); border-color:#e63946;
  color:#fff; font-size:0.85rem; font-weight:800;
  padding:8px 16px; letter-spacing:1px; margin-left:8px;
  animation:pulse-live 2s infinite;
}
.btn-live-now:hover { background:rgba(230,57,70,0.3); border-color:#fca5a5; box-shadow:0 0 16px rgba(230,57,70,0.4); }

@keyframes pulse-live {
  0%,100% { box-shadow:0 0 8px rgba(230,57,70,0.2); }
  50% { box-shadow:0 0 16px rgba(230,57,70,0.5); border-color:#fca5a5; }
}

.timecode {
  font-size:1.4rem; font-weight:700; letter-spacing:3px;
  font-variant-numeric:tabular-nums; font-family:'Courier New',monospace;
  color:var(--accent-blue,#33becc);
}
.status-dot {
  width:7px; height:7px; border-radius:50%;
  background:rgba(255,255,255,0.2);
}
.status-dot.connected { background:#4caf50; box-shadow:0 0 6px rgba(76,175,80,0.6); }
</style>
