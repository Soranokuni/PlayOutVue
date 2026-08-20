<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import MediaLibrary from './components/MediaLibrary.vue';
import RundownList from './components/RundownList.vue';
import MediaInspector from './components/MediaInspector.vue';
import SettingsModal from './components/SettingsModal.vue';
import CommandPaletteModal from './components/CommandPaletteModal.vue';
import IngestorStatusLight from './components/IngestorStatusLight.vue';
import { activePlayoutCapabilities, activePlayoutLabel, currentPlayoutTime, getActivePlayoutService, isPlayoutConnected, isPlayoutPlaying, isPlayoutLive } from './services/playout';
import { useSettingsStore } from './stores/settings';
import { useRundownStore } from './stores/rundown';
import { useIngestorStatusStore } from './stores/ingestorStatus';
import { useMediaLibraryStore } from './stores/mediaLibrary';
import { useOperatorShortcuts, activeModalName, closeCommandPalette, activeInspectorItem, openInspectorModal, closeInspectorModal } from './composables/useOperatorShortcuts';
import { advanceNext, manualTakeFailure } from './services/caspar';

const settings = useSettingsStore();
const rundown  = useRundownStore();
const isStreaming  = ref(false);
const isSdiActive  = ref(false);
const showSettings = ref(false);
const ingestorStatus = useIngestorStatusStore();
const playoutHalted = ref(false);
let unlistenHeartbeat: (() => void) | null = null;
let unlistenHalted: (() => void) | null = null;

useOperatorShortcuts();

// Performance / Jank Monitor
let jankFrameId: number | null = null;
let lastFrameTime = performance.now();
let frameTimes: number[] = [];
let jankCount = 0;
let lastReportTime = performance.now();

const startJankMonitor = () => {
  if (jankFrameId) return;
  lastFrameTime = performance.now();
  lastReportTime = performance.now();
  frameTimes = [];
  jankCount = 0;

  const runLoop = () => {
    const now = performance.now();
    const delta = now - lastFrameTime;
    lastFrameTime = now;
    frameTimes.push(delta);

    if (delta > 33) {
      jankCount++;
    }

    if (now - lastReportTime >= 5000) {
      const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / (frameTimes.length || 1);
      const fps = 1000 / (avgFrameTime || 1);
      const heapMemory = (performance as any).memory
        ? Math.round((performance as any).memory.usedJSHeapSize / (1024 * 1024))
        : null;
      
      const memoryStr = heapMemory !== null ? `${heapMemory}MB` : 'N/A';
      const logMessage = `FPS: ${fps.toFixed(1)} | Jank frames: ${jankCount} | JS Heap: ${memoryStr}`;
      setTimeout(() => {
        invoke('push_diagnostic_log', {
          level: 'info',
          scope: 'ui-performance',
          message: logMessage
        }).catch(() => {});
      }, 0);

      frameTimes = [];
      jankCount = 0;
      lastReportTime = now;
    }

    jankFrameId = requestAnimationFrame(runLoop);
  };
  jankFrameId = requestAnimationFrame(runLoop);
};

const stopJankMonitor = () => {
  if (jankFrameId) {
    cancelAnimationFrame(jankFrameId);
    jankFrameId = null;
  }
};

watch(
  () => settings.debugMode,
  (enabled) => {
    if (enabled) {
      startJankMonitor();
    } else {
      stopJankMonitor();
    }
  },
  { immediate: true }
);

const footerMetaRef = ref<HTMLElement | null>(null);
const showProductInfo = ref(false);
const showQuickGuide = ref(false);

const APP_NAME = 'PlayOutOS';
const APP_VERSION = '2.0.1';

const appHighlights = [
  'Multi-playlist rundown planning with separate offline prep and on-air control.',
  'CasparCG playout control with safe handoff, live cuts, and timing feedback.',
  'Media library scanning, trim workflow, compliance labels, and spot or telemarketing tagging.',
  'Operator-first rundown editing with drag insert, gap markers, next-up warnings, and persistent selection.'
];

const shortcutGuide = [
  'Enter or Space: play from the selected rundown row.',
  'Delete or Backspace: remove the selected row, except the one currently on air.',
  'Ctrl + Arrow Up or Arrow Down: move the selected row.',
  'Shift + Arrow Down: duplicate the selected row.',
  'Ctrl + I: Inspect selected media clip metadata and QC probing.',
  'F8 in the media library: append the selected library item after the selected rundown row.'
];

const workflowGuide = [
  'Drag media from the library into the rundown to insert exactly where the cyan marker appears.',
  'Double-click a playlist tab to rename it, then keep offline playlists staged until you take them on air.',
  'Use gap lines plus Day and At to plan hard starts without changing the playout queue until playback begins.',
  'Right-click any clip to inspect probe metadata, QC status, and transcode parameters.',
  'Use Settings for connections, media paths, themes, and QC sensitivity modes.'
];

const leftWidth = useStorage('layout.leftWidth', 280);
const isResizing = ref<'left'|null>(null);
let pendingResizeX = 0;
let resizeFrame = 0;

// Theme and Scale watchers
watch(() => settings.theme, (theme) => {
    document.body.classList.remove('light-theme', 'monokai-theme', 'dark-theme');
    if (theme === 'light') document.body.classList.add('light-theme');
    else if (theme === 'monokai') document.body.classList.add('monokai-theme');
    else document.body.classList.add('dark-theme');
}, { immediate: true });

watch(() => settings.uiScale, (scale) => {
    const validScale = scale || 'comfortable';
    document.documentElement.setAttribute('data-ui-scale', validScale);
}, { immediate: true });

watch(
  () => ({
    debugEnabled: settings.debugMode,
    ffmpegBinPath: settings.ffmpegBinPath,
    ingestorApiBaseUrl: settings.ingestorApiBaseUrl
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
    leftWidth.value = Math.max(260, Math.min(600, pendingResizeX));
  }
};

const startResizeLeft = () => {
  isResizing.value = 'left';
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
};

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

const toggleConnection = async () => {
  const service = getActivePlayoutService();
  if (isPlayoutConnected.value) await service.disconnect();
  else await service.connect();
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
  try {
    await getActivePlayoutService().cutToLive?.();
    manualTakeFailure.value = null;
  } catch (err: any) {
    console.error('[Live] Cut to live failed:', err);
    alert(err?.message || String(err));
  }
};

const returnFromLive = async () => {
  try {
    await getActivePlayoutService().returnFromLive?.();
  } catch (err: any) {
    console.error('[Live] Return from live failed:', err);
  }
};

const retryFailedTake = async () => {
  manualTakeFailure.value = null;
  await getActivePlayoutService().take?.();
};

const skipFailedTake = async () => {
  manualTakeFailure.value = null;
  await advanceNext(false);
};
const handleInspectorOpenEvent = (event: any) => {
  openInspectorModal(event.detail);
};

onMounted(async () => {
  window.addEventListener('pointerdown', handleGlobalPointerDown);
  window.addEventListener('playout:open-inspector', handleInspectorOpenEvent);
  try {
    unlistenHeartbeat = await listen('ingestor-heartbeat',
      (event: { payload: { online: boolean; last_seen_at: number; error?: string } }) => {
        const payload = event.payload;
        ingestorStatus.setOnline(payload.online, payload.last_seen_at);
        if (!payload.online && payload.error) {
          ingestorStatus.logWarning('ingestor-heartbeat', `Connection lost: ${payload.error}`);
        }
      }
    );
  } catch (err) {
    console.error('[Heartbeat] Failed to listen to heartbeat events:', err);
  }
  try {
    unlistenHalted = await listen('playout://halted', () => {
      playoutHalted.value = true;
    });
  } catch (err) {
    console.error('[Playout] Failed to listen to playout://halted event:', err);
  }
  if (settings.debugMode) {
    startJankMonitor();
  }

  // Bug 3 Fix 3: Restore connection and playback state on F5 refresh
  if (settings.playoutEngine === 'casparcg') {
    const service = getActivePlayoutService();
    service.connect().catch((error) => {
      console.warn('[Playout] Auto-connect to CasparCG failed:', error);
    });
  }
  rundown.restorePlaybackState();

  if (settings.recycleBinAutoPurge && settings.recycleBinAutoPurge !== 'disabled') {
    const mediaLib = useMediaLibraryStore();
    mediaLib.checkAndTriggerAutoPurge(settings.recycleBinAutoPurge);
  }
});

onUnmounted(() => {
  onMouseUp();
  window.removeEventListener('pointerdown', handleGlobalPointerDown);
  window.removeEventListener('playout:open-inspector', handleInspectorOpenEvent);
  if (unlistenHeartbeat) {
    unlistenHeartbeat();
    unlistenHeartbeat = null;
  }
  if (unlistenHalted) {
    unlistenHalted();
    unlistenHalted = null;
  }
  stopJankMonitor();
});
</script>

<template>
  <main class="app-shell" :style="{
    '--left-w': `${leftWidth}px`,
    cursor: isResizing ? 'ew-resize' : 'default'
  }">
    <!-- Persistent Playout Halted Banner -->
    <div v-if="playoutHalted" class="halt-banner">
      <div class="halt-content">
        <span class="halt-icon">⚠️</span>
        <span class="halt-text">Playout halted after 3 consecutive errors — operator intervention required.</span>
      </div>
      <button class="halt-dismiss-btn" @click="playoutHalted = false">Dismiss</button>
    </div>
    
    <aside class="panel panel-library glass-panel"><MediaLibrary /></aside>
    <div class="resizer resizer-left" title="Drag to resize · double-click to reset" @mousedown="startResizeLeft" @dblclick="leftWidth = 280"></div>
    
    <section class="panel panel-rundown glass-panel"><RundownList /></section>

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
          :disabled="!isPlayoutConnected || !rundown.activeItems.length || rundown.isRundownLocked"
          @click="playSelected"
          :title="rundown.isRundownLocked ? 'Rundown is Locked (Unlock to Play)' : 'Play playlist from selected item (or beginning)'"
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
        
        <button
          v-if="!isPlayoutLive"
          class="ctrl-btn btn-live-now"
          :disabled="!isPlayoutConnected"
          @click="cutToLive"
          title="Cut to Live DeckLink/AMCP Source"
        >
          🔴 CUT TO LIVE
        </button>
        <button
          v-else
          class="ctrl-btn btn-live-active"
          @click="returnFromLive"
          title="Live Broadcast Active — Click to Return to Rundown Playlist"
        >
          🔴 LIVE ON AIR (RETURN TO RUNDOWN)
        </button>
      </div>

      <div v-if="manualTakeFailure" class="take-failure" role="alert">
        <span>TAKE HELD: {{ manualTakeFailure.filename }}</span>
        <button class="ctrl-btn" @click="retryFailedTake">Retry</button>
        <button class="ctrl-btn" @click="skipFailedTake">Skip</button>
        <button class="ctrl-btn btn-live-now" @click="cutToLive">Live</button>
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

      <!-- Rundown Safety Lock Button -->
      <button
        class="ctrl-btn lock-toggle-btn"
        :class="{ 'is-locked': rundown.isRundownLocked }"
        @click="rundown.toggleRundownLock()"
        :title="rundown.isRundownLocked ? 'Rundown Locked: Accidental edits are protected. Click to Unlock.' : 'Rundown Unlocked: Free to edit, reorder, and delete items. Click to Lock.'"
      >
        <span class="lock-icon">{{ rundown.isRundownLocked ? '🔒' : '🔓' }}</span>
        <span class="lock-text">{{ rundown.isRundownLocked ? 'LOCKED' : 'UNLOCKED' }}</span>
      </button>

      <IngestorStatusLight />

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

    <MediaInspector :is-open="activeModalName === 'inspector'" :target-item="activeInspectorItem" @close="closeInspectorModal" />
    <SettingsModal :is-open="showSettings" @close="showSettings = false" />
    <CommandPaletteModal :is-open="activeModalName === 'command-palette'" @close="closeCommandPalette" />
  </main>
</template>

<style scoped>
.app-shell {
  display: grid;
  grid-template-columns: var(--left-w) 8px 1fr;
  grid-template-rows: 1fr calc(58px * var(--ui-scale, 1.15) / 1.15);
  grid-template-areas: "library r1 rundown" "ctrl ctrl ctrl";
  height: 100vh; gap: 0; padding: 5px; overflow: hidden;
  background: var(--bg-primary);
  user-select: none;
}

.ingest-shell-host {
  min-height: 100vh;
}
.panel-library  { grid-area: library; overflow:hidden; }
.panel-rundown  { grid-area: rundown; overflow:hidden; }
.control-bar    { grid-area: ctrl; display:flex; align-items:center; gap:8px; padding:0 12px; margin-top:5px; position:relative; overflow:visible; }

.resizer {
  cursor: ew-resize;
  background: transparent;
  width: 100%;
  height: 100%;
  transition: background 0.2s;
}
.resizer:hover, .resizer:active {
  background: var(--bg-hover);
}
.resizer-left { grid-area: r1; }

.panel-toggle-btn {
  flex:1;
  min-width:0;
  border-radius:8px;
  border:1px solid var(--border-subtle);
  background:var(--bg-hover);
  color:var(--text-secondary);
  padding:6px 10px;
  font-size:0.75rem;
  font-weight:700;
  cursor:pointer;
}

.panel-toggle-btn.is-active {
  color:var(--text-primary);
  border-color:color-mix(in srgb, var(--accent-blue) 40%, transparent);
  background:color-mix(in srgb, var(--accent-blue) 12%, var(--bg-secondary));
}

.ctrl-section    { display:flex; align-items:center; gap:6px; }
.ctrl-label      { font-size:0.72rem; color:var(--text-muted); letter-spacing:0.5px; font-weight:700; white-space:nowrap; }
.ctrl-summary    { min-width:0; }
.ctrl-value      {
  font-size:0.82rem; color:var(--text-primary); font-weight:600; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; max-width:260px;
}
.ctrl-divider    { width:1px; height:26px; background:var(--border-subtle); flex-shrink:0; }
.ctrl-play-wrap  { flex:0 0 auto; }
.take-failure { display:flex; align-items:center; gap:5px; color:var(--accent-red); font-size:0.75rem; font-weight:700; white-space:nowrap; }

.ctrl-btn {
  background:var(--bg-hover); border:1px solid var(--border-medium);
  color:var(--text-primary); border-radius:6px; cursor:pointer;
  padding:6px 14px; font-size:0.82rem; font-weight:600; transition:all 0.15s; white-space:nowrap;
}
.ctrl-btn:hover { background:color-mix(in srgb, var(--accent-blue) 12%, var(--bg-hover)); border-color:var(--border-strong); }
.ctrl-btn:disabled { opacity:0.35; cursor:not-allowed; }
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

.btn-live-active {
  background:#ef4444; border-color:#f87171;
  color:#fff; font-size:0.85rem; font-weight:800;
  padding:8px 16px; letter-spacing:1px; margin-left:8px;
  box-shadow:0 0 20px rgba(239,68,68,0.7);
  animation:pulse-live 1s infinite;
}
.btn-live-active:hover {
  background:#dc2626; border-color:#fca5a5;
  box-shadow:0 0 28px rgba(239,68,68,0.9);
}

.lock-toggle-btn {
  display:flex;
  align-items:center;
  gap:6px;
  font-weight:700;
  font-size:0.75rem;
  padding:5px 12px;
  border-radius:6px;
  transition:all 0.15s;
  user-select:none;
  background:rgba(16,185,129,0.12);
  border:1px solid rgba(16,185,129,0.4);
  color:#10b981;
}
.lock-toggle-btn:hover {
  background:rgba(16,185,129,0.22);
  border-color:rgba(16,185,129,0.6);
}
.lock-toggle-btn.is-locked {
  background:rgba(239,68,68,0.15);
  border-color:rgba(239,68,68,0.5);
  color:#ef4444;
  box-shadow:0 0 10px rgba(239,68,68,0.25);
}
.lock-toggle-btn.is-locked:hover {
  background:rgba(239,68,68,0.25);
  border-color:rgba(239,68,68,0.7);
}

@keyframes pulse-live {
  0%,100% { box-shadow:0 0 8px rgba(230,57,70,0.2); }
  50% { box-shadow:0 0 16px rgba(230,57,70,0.5); border-color:#fca5a5; }
}

.timecode {
  font-size: var(--timecode-font-size, 1.35rem);
  font-weight: 700;
  letter-spacing: 2.5px;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  color: var(--accent-blue);
  text-shadow: 0 0 12px color-mix(in srgb, var(--accent-blue) 35%, transparent);
}
.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--border-strong);
}
.status-dot.connected { background: var(--accent-green); box-shadow: 0 0 8px color-mix(in srgb, var(--accent-green) 60%, transparent); }

.ctrl-meta-dock {
  margin-left: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  position: relative;
}

.ctrl-meta-btn {
  height: var(--btn-h-compact, 30px);
  border-radius: 999px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-hover);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.ctrl-meta-btn:hover,
.ctrl-meta-btn.is-open {
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--accent-blue) 40%, transparent);
  background: color-mix(in srgb, var(--accent-blue) 12%, var(--bg-secondary));
  box-shadow: 0 0 16px color-mix(in srgb, var(--accent-blue) 15%, transparent);
}

.ctrl-meta-brand {
  padding: 0 12px;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ctrl-meta-help {
  width: var(--btn-h-compact, 30px);
  padding: 0;
  font-size: 0.88rem;
  font-weight: 800;
}

.ctrl-meta-popover {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  width: 340px;
  padding: 14px 14px 12px;
  border-radius: 14px;
  border: 1px solid var(--border-medium);
  background: var(--bg-secondary);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(18px);
  z-index: 30;
}

.ctrl-meta-popover-guide {
  width: 380px;
}

.ctrl-meta-heading-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.ctrl-meta-kicker {
  font-size: 0.62rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.ctrl-meta-title {
  margin-top: 4px;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text-primary);
}

.ctrl-meta-copy {
  margin: 10px 0 0;
  font-size: 0.76rem;
  line-height: 1.45;
  color: var(--text-secondary);
}

.ctrl-meta-section-label {
  margin-top: 12px;
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.ctrl-meta-list {
  margin: 10px 0 0;
  padding-left: 16px;
  display: grid;
  gap: 7px;
}

.ctrl-meta-list li {
  font-size: 0.76rem;
  line-height: 1.42;
  color: var(--text-secondary);
}

.ctrl-meta-close {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.9rem;
}

.ctrl-meta-close:hover {
  background: var(--border-medium);
  color: var(--text-primary);
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

.halt-banner {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  background: rgba(230, 57, 70, 0.15);
  border: 1px solid rgba(230, 57, 70, 0.45);
  backdrop-filter: blur(12px);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(230, 57, 70, 0.2), 0 0 1px 1px rgba(230, 57, 70, 0.3) inset;
  color: #fff;
  font-family: Inter, system-ui, sans-serif;
  animation: slideDownFade 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.halt-content {
  display: flex;
  align-items: center;
  gap: 10px;
}

.halt-icon {
  font-size: 1.15rem;
  animation: pulseWarning 1.5s infinite ease-in-out;
}

.halt-text {
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

.halt-dismiss-btn {
  background: rgba(255, 255, 255, 0.12);
  border: none;
  border-radius: 4px;
  color: #fff;
  padding: 6px 12px;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.2s, transform 0.1s;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.halt-dismiss-btn:hover {
  background: rgba(255, 255, 255, 0.22);
}

.halt-dismiss-btn:active {
  transform: scale(0.95);
}

@keyframes slideDownFade {
  from {
    opacity: 0;
    transform: translate(-50%, -20px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

@keyframes pulseWarning {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.15); filter: drop-shadow(0 0 6px rgba(230, 57, 70, 0.8)); }
}
</style>
