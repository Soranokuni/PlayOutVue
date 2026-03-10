<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import { invoke } from '@tauri-apps/api/core';
import MediaLibrary from './components/MediaLibrary.vue';
import RundownList from './components/RundownList.vue';
import MediaInspector from './components/MediaInspector.vue';
import SettingsModal from './components/SettingsModal.vue';
import PreviewMonitor from './components/PreviewMonitor.vue';
import { obs } from './services/obs';
import { activePlayoutCapabilities, activePlayoutLabel, currentPlayoutTime, getActivePlayoutService, isPlayoutConnected, isPlayoutPlaying } from './services/playout';
import { useSettingsStore } from './stores/settings';
import { useRundownStore } from './stores/rundown';

const settings = useSettingsStore();
const rundown  = useRundownStore();
const isStreaming  = ref(false);
const isSdiActive  = ref(false);
const showSettings = ref(false);
const footerMetaRef = ref<HTMLElement | null>(null);
const showProductInfo = ref(false);
const showQuickGuide = ref(false);

const APP_NAME = 'PlayOutOS';
const APP_VERSION = '2.0.1';

const appHighlights = [
  'Multi-playlist rundown planning with separate offline prep and on-air control.',
  'OBS or Caspar playout control with safe handoff, live cuts, and timing feedback.',
  'Media library scanning, trim workflow, compliance labels, and spot or telemarketing tagging.',
  'Operator-first rundown editing with drag insert, gap markers, next-up warnings, and persistent selection.'
];

const shortcutGuide = [
  'Enter or Space: play from the selected rundown row.',
  'Delete or Backspace: remove the selected row, except the one currently on air.',
  'Ctrl + Arrow Up or Arrow Down: move the selected row.',
  'Shift + Arrow Down: duplicate the selected row.',
  'F8 in the media library: append the selected library item after the selected rundown row.'
];

const workflowGuide = [
  'Drag media from the library into the rundown to insert exactly where the cyan marker appears.',
  'Double-click a playlist tab to rename it, then keep offline playlists staged until you take them on air.',
  'Use gap lines plus Day and At to plan hard starts without changing the playout queue until playback begins.',
  'Use the right panel for preview and inspection, and Settings for connections, media paths, and debug controls.'
];

const leftWidth = useStorage('layout.leftWidth', 260);
const rightWidth = useStorage('layout.rightWidth', 300);
const isResizing = ref<'left'|'right'|null>(null);
const isLightMode = useStorage('ui.isLightMode', false);
let pendingResizeX = 0;
let resizeFrame = 0;

watch(isLightMode, (val) => {
    if (val) document.body.classList.add('light-theme');
    else document.body.classList.remove('light-theme');
}, { immediate: true });

watch(
  () => ({
    debugEnabled: settings.debugMode,
    ffmpegBinPath: settings.ffmpegBinPath
  }),
  (runtimeSettings) => {
    invoke('apply_runtime_settings', {
      settings: runtimeSettings
    }).catch((error) => {
      console.warn('[RuntimeSettings] Failed to sync backend runtime settings', error);
    });
  },
  { immediate: true, deep: true }
);

const formatDuration = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return [hours, minutes, remainingSeconds]
    .filter((value, index) => value > 0 || index > 0)
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
};

const rundownSummary = computed(() => {
  const itemCount = rundown.activeItems.length;
  if (!itemCount) return 'No items loaded';
  return `${rundown.currentPlaylistName} · ${itemCount} item${itemCount === 1 ? '' : 's'} · ${formatDuration(rundown.totalDuration)}`;
});

const toggleProductInfo = () => {
  showProductInfo.value = !showProductInfo.value;
  if (showProductInfo.value) showQuickGuide.value = false;
};

const toggleQuickGuide = () => {
  showQuickGuide.value = !showQuickGuide.value;
  if (showQuickGuide.value) showProductInfo.value = false;
};

const closeFooterPanels = () => {
  showProductInfo.value = false;
  showQuickGuide.value = false;
};

const handleGlobalPointerDown = (event: PointerEvent) => {
  const target = event.target as Node | null;
  if (footerMetaRef.value && target && footerMetaRef.value.contains(target)) return;
  closeFooterPanels();
};

const applyResize = () => {
  resizeFrame = 0;
  if (isResizing.value === 'left') {
    leftWidth.value = Math.max(220, Math.min(520, pendingResizeX));
  } else if (isResizing.value === 'right') {
    rightWidth.value = Math.max(280, Math.min(680, window.innerWidth - pendingResizeX));
  }
};

const startResizeLeft = () => { isResizing.value = 'left';  window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp); };
const startResizeRight = () => { isResizing.value = 'right'; window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp); };

const onMouseMove = (e: MouseEvent) => {
  pendingResizeX = e.clientX;
  if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
};

const onMouseUp = () => {
    isResizing.value = null;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
  }
};

const handleStreamStateChanged = (data: any) => {
  isStreaming.value = data.outputActive;
};

const toggleConnection = async () => {
  const service = getActivePlayoutService();
  if (isPlayoutConnected.value) await service.disconnect();
  else await service.connect(settings.obsUrl, settings.obsPassword);
};

const playSelected = async () => {
  const payload = rundown.buildPlaybackPayload();
  if (!payload) return;

  const service = getActivePlayoutService();
  if (isPlayoutPlaying.value && rundown.onAirPlaylistId && rundown.onAirPlaylistId !== payload.playlistId) {
    await service.stop();
    rundown.clearOnAirState();
  }

  rundown.setPlaylistOnAir(payload.playlistId, payload.startVisibleIndex);
  rundown.selectedItemId = rundown.activeItems[payload.startVisibleIndex]?.id || null;
  try {
    await service.play(payload.items as any, payload.startIndex);
  } catch (error) {
    rundown.clearOnAirState();
    throw error;
  }
};

const stopPlayback = async () => {
  await getActivePlayoutService().stop();
  rundown.clearOnAirState();
};

const toggleStream = async () => {
  const service = getActivePlayoutService();
  if (!service.startStream || !service.stopStream) return;
  if (isStreaming.value) await service.stopStream();
  else await service.startStream();
};

const toggleSdi = async () => {
    if (!settings.decklinkOutputName) return;
  const service = getActivePlayoutService();
  if (!service.startDeckLink || !service.stopDeckLink) return;
    if (isSdiActive.value) {
    await service.stopDeckLink(settings.decklinkOutputName);
        isSdiActive.value = false;
    } else {
    await service.startDeckLink(settings.decklinkOutputName);
        isSdiActive.value = true;
    }
};

const cutToLive = async () => {
  await getActivePlayoutService().cutToLive?.();
};

    onMounted(() => {
      obs.on('StreamStateChanged', handleStreamStateChanged);
      window.addEventListener('pointerdown', handleGlobalPointerDown);
    });

    onUnmounted(() => {
      onMouseUp();
      obs.off('StreamStateChanged', handleStreamStateChanged);
      window.removeEventListener('pointerdown', handleGlobalPointerDown);
    });
</script>

<template>
  <main class="app-shell" :style="`--left-w: ${leftWidth}px; --right-w: ${rightWidth}px; cursor: ${isResizing ? 'ew-resize' : 'default'}`">
    
    <aside class="panel panel-library glass-panel"><MediaLibrary /></aside>
    <div class="resizer resizer-left" title="Drag to resize · double-click to reset" @mousedown="startResizeLeft" @dblclick="leftWidth = 260"></div>
    
    <section class="panel panel-rundown glass-panel"><RundownList /></section>
    <div class="resizer resizer-right" title="Drag to resize · double-click to reset" @mousedown="startResizeRight" @dblclick="rightWidth = 300"></div>
    
    <aside class="panel panel-right">
      <div class="glass-panel panel-preview"><PreviewMonitor /></div>
      <div class="glass-panel panel-inspector"><MediaInspector /></div>
    </aside>

    <!-- Simplified Master Control Bar -->
    <footer class="control-bar glass-panel">

      <!-- Connection -->
      <div class="ctrl-section">
        <div class="status-dot" :class="{ connected: isPlayoutConnected }"></div>
        <span class="ctrl-label">{{ isPlayoutConnected ? activePlayoutLabel : 'OFFLINE' }}</span>
        <button class="ctrl-btn" @click="toggleConnection" style="font-size:0.7rem;">
          {{ isPlayoutConnected ? 'Disconnect' : 'Connect' }}
        </button>
      </div>

      <div class="ctrl-divider"></div>

      <!-- PLAY / STOP — the main call-to-action -->
      <div class="ctrl-section ctrl-play-wrap">
        <button
          v-if="!isPlayoutPlaying"
          class="ctrl-btn btn-play"
          :disabled="!isPlayoutConnected || !rundown.activeItems.length"
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
        
        <button v-if="isPlayoutConnected" class="ctrl-btn btn-live-now" @click="cutToLive" title="Cut to Live Source">
          🔴 LIVE NOW
        </button>
      </div>

      <div class="ctrl-divider"></div>

      <!-- Media Timecode -->
      <div class="ctrl-section">
        <div class="timecode">{{ currentPlayoutTime }}</div>
      </div>

      <div class="ctrl-divider"></div>

      <!-- Broadcast Stream & SDI -->
      <div v-if="activePlayoutCapabilities.streaming" class="ctrl-section">
        <div class="status-dot" :class="{ connected: isStreaming }" style="--dot-color:#e63946;"></div>
        <span class="ctrl-label">{{ isStreaming ? 'ON AIR' : 'STANDBY' }}</span>
        <button class="ctrl-btn" :class="{ 'btn-live': isStreaming }" :disabled="!isPlayoutConnected" @click="toggleStream" style="font-size:0.7rem;">
          {{ isStreaming ? '■ Stop' : '● Stream' }}
        </button>

        <button v-if="activePlayoutCapabilities.hardwareOutput && settings.decklinkOutputName" class="ctrl-btn" :class="{ 'btn-live': isSdiActive }" :disabled="!isPlayoutConnected" @click="toggleSdi" style="font-size:0.7rem; margin-left:12px;">
          {{ isSdiActive ? '■ SDI Stop' : '● SDI OUT' }}
        </button>
      </div>

      <div class="ctrl-divider"></div>

      <div class="ctrl-section ctrl-summary">
        <span class="ctrl-label">RUNDOWN</span>
        <span class="ctrl-value">{{ rundownSummary }}</span>
      </div>

      <div class="ctrl-divider"></div>

      <button class="ctrl-btn" style="font-size:0.75rem; margin-left:auto; width:40px;" @click="isLightMode = !isLightMode" :title="isLightMode ? 'Switch to Dark Mode' : 'Switch to Light Mode'">
        {{ isLightMode ? '🌙' : '☀️' }}
      </button>

      <button class="ctrl-btn" style="font-size:0.78rem;" @click="showSettings = true">⚙ Settings</button>

      <div class="ctrl-meta-dock" ref="footerMetaRef">
        <button
          class="ctrl-meta-btn ctrl-meta-brand"
          :class="{ 'is-open': showProductInfo }"
          @click.stop="toggleProductInfo"
          :title="`${APP_NAME} ${APP_VERSION}`"
        >
          {{ APP_NAME }} {{ APP_VERSION }}
        </button>
        <button
          class="ctrl-meta-btn ctrl-meta-help"
          :class="{ 'is-open': showQuickGuide }"
          @click.stop="toggleQuickGuide"
          title="Quick guide"
          aria-label="Quick guide"
        >
          ?
        </button>

        <div v-if="showProductInfo" class="ctrl-meta-popover">
          <div class="ctrl-meta-heading-row">
            <div>
              <div class="ctrl-meta-kicker">System</div>
              <div class="ctrl-meta-title">{{ APP_NAME }} {{ APP_VERSION }}</div>
            </div>
            <button class="ctrl-meta-close" @click.stop="closeFooterPanels" aria-label="Close info">×</button>
          </div>
          <p class="ctrl-meta-copy">Broadcast playout control built for rundown-driven operations and rapid operator decisions.</p>
          <ul class="ctrl-meta-list">
            <li v-for="item in appHighlights" :key="item">{{ item }}</li>
          </ul>
        </div>

        <div v-if="showQuickGuide" class="ctrl-meta-popover ctrl-meta-popover-guide">
          <div class="ctrl-meta-heading-row">
            <div>
              <div class="ctrl-meta-kicker">Quick Guide</div>
              <div class="ctrl-meta-title">Shortcuts and basics</div>
            </div>
            <button class="ctrl-meta-close" @click.stop="closeFooterPanels" aria-label="Close guide">×</button>
          </div>
          <div class="ctrl-meta-section-label">Keyboard shortcuts</div>
          <ul class="ctrl-meta-list">
            <li v-for="item in shortcutGuide" :key="item">{{ item }}</li>
          </ul>
          <div class="ctrl-meta-section-label">Basic workflow</div>
          <ul class="ctrl-meta-list">
            <li v-for="item in workflowGuide" :key="item">{{ item }}</li>
          </ul>
        </div>
      </div>
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
.control-bar    { grid-area: ctrl; display:flex; align-items:center; gap:8px; padding:0 12px; margin-top:5px; position:relative; overflow:visible; }

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
.ctrl-summary    { min-width:0; }
.ctrl-value      {
  font-size:0.78rem; color:var(--text-primary); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; max-width:220px;
}
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

.ctrl-meta-dock {
  margin-left:8px;
  display:flex;
  align-items:center;
  gap:6px;
  position:relative;
}

.ctrl-meta-btn {
  height:30px;
  border-radius:999px;
  border:1px solid rgba(255,255,255,0.12);
  background:rgba(255,255,255,0.04);
  color:rgba(255,255,255,0.62);
  cursor:pointer;
  transition:all 0.15s ease;
}

.ctrl-meta-btn:hover,
.ctrl-meta-btn.is-open {
  color:var(--text-primary);
  border-color:rgba(51,190,204,0.34);
  background:rgba(51,190,204,0.1);
  box-shadow:0 0 16px rgba(51,190,204,0.12);
}

.ctrl-meta-brand {
  padding:0 12px;
  font-size:0.65rem;
  font-weight:700;
  letter-spacing:0.08em;
  text-transform:uppercase;
}

.ctrl-meta-help {
  width:30px;
  padding:0;
  font-size:0.86rem;
  font-weight:800;
}

.ctrl-meta-popover {
  position:absolute;
  right:0;
  bottom:calc(100% + 10px);
  width:340px;
  padding:14px 14px 12px;
  border-radius:14px;
  border:1px solid rgba(255,255,255,0.12);
  background:color-mix(in srgb, var(--bg-secondary) 94%, rgba(7,12,18,0.88));
  box-shadow:0 18px 40px rgba(0,0,0,0.38);
  backdrop-filter:blur(18px);
  z-index:30;
}

.ctrl-meta-popover-guide {
  width:380px;
}

.ctrl-meta-heading-row {
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:10px;
}

.ctrl-meta-kicker {
  font-size:0.58rem;
  font-weight:800;
  letter-spacing:0.12em;
  text-transform:uppercase;
  color:rgba(255,255,255,0.4);
}

.ctrl-meta-title {
  margin-top:4px;
  font-size:0.92rem;
  font-weight:700;
  color:var(--text-primary);
}

.ctrl-meta-copy {
  margin:10px 0 0;
  font-size:0.72rem;
  line-height:1.45;
  color:rgba(255,255,255,0.68);
}

.ctrl-meta-section-label {
  margin-top:12px;
  font-size:0.62rem;
  font-weight:800;
  letter-spacing:0.1em;
  text-transform:uppercase;
  color:rgba(255,255,255,0.46);
}

.ctrl-meta-list {
  margin:10px 0 0;
  padding-left:16px;
  display:grid;
  gap:7px;
}

.ctrl-meta-list li {
  font-size:0.72rem;
  line-height:1.42;
  color:rgba(255,255,255,0.76);
}

.ctrl-meta-close {
  width:24px;
  height:24px;
  border:none;
  border-radius:999px;
  background:rgba(255,255,255,0.06);
  color:rgba(255,255,255,0.56);
  cursor:pointer;
  font-size:0.86rem;
}

.ctrl-meta-close:hover {
  background:rgba(255,255,255,0.12);
  color:var(--text-primary);
}

@media (max-width: 1280px) {
  .control-bar {
    flex-wrap: wrap;
    justify-content: center;
    padding-block: 8px;
  }

  .ctrl-divider {
    display: none;
  }

  .ctrl-value {
    max-width: none;
  }

  .ctrl-meta-dock {
    margin-left:0;
  }

  .ctrl-meta-popover,
  .ctrl-meta-popover-guide {
    right:auto;
    left:0;
    width:min(380px, calc(100vw - 24px));
  }
}
</style>
