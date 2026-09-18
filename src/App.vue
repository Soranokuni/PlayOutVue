<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
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
import { persistenceFault, clearPersistenceFault } from './lib/persistenceStorage';
import { frontendFaults, dismissFrontendFault } from './lib/frontendFaults';
import {
  processStatus,
  processState,
  isPrimaryInstance,
  isStarting,
  startCasparServer,
  restartCasparServer,
  initCasparProcessListener,
} from './services/casparProcess';

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

const APP_NAME = 'Aether';
const APP_VERSION = '3.0';

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
    document.body.classList.remove('light-theme', 'monokai-theme', 'dark-theme', 'soft-slate-theme', 'periwinkle-theme');
    if (theme === 'light') document.body.classList.add('light-theme');
    else if (theme === 'monokai') document.body.classList.add('monokai-theme');
    else if (theme === 'soft-slate') document.body.classList.add('soft-slate-theme');
    else if (theme === 'periwinkle') document.body.classList.add('periwinkle-theme');
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
    ingestorApiBaseUrl: settings.ingestorApiBaseUrl,
    ingestorApiToken: settings.ingestorApiToken,
    casparcgExecutablePath: settings.casparcgExecutablePath,
    casparcgConfigFilename: settings.casparcgConfigFilename,
    casparAutoStart: settings.casparAutoStart,
    casparKeepAliveOnExit: settings.casparKeepAliveOnExit,
    casparAutoRelaunchOnCrash: settings.casparAutoRelaunchOnCrash,
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
  const target = event.target as HTMLElement | null;
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

const connectionTone = computed<'ready' | 'processing' | 'error' | 'warning' | 'offline' | 'idle'>(() => {
  if (isPlayoutConnected.value) return 'ready';
  switch (processState.value) {
    case 'unconfigured': return 'error';
    case 'stopped': return 'warning';
    case 'starting': return 'processing';
    case 'external_running': return 'ready';
    case 'disconnected': return 'warning';
    case 'crashed': return 'error';
    case 'operational': return 'ready';
    default: return 'offline';
  }
});

const connectionLabel = computed(() => {
  if (!isPrimaryInstance.value) {
    return isPlayoutConnected.value ? 'MONITOR (CONNECTED)' : 'MONITOR (OFFLINE)';
  }
  if (isPlayoutConnected.value) return 'CONNECTED';
  if (processStatus.value?.circuitBreakerTripped) {
    return 'CRASH LOOP (PAUSED)';
  }
  switch (processState.value) {
    case 'unconfigured': return 'CasparCG not found';
    case 'stopped': return 'CasparCG Stopped';
    case 'starting': return 'Starting CasparCG...';
    case 'external_running': return 'CasparCG Ready (External)';
    case 'crashed': return 'CasparCG Crashed';
    case 'disconnected': return 'CasparCG offline';
    case 'operational': return 'CasparCG Ready';
    default: return 'OFFLINE';
  }
});

const connectionBtnText = computed(() => {
  if (isStarting.value || processState.value === 'starting') return 'Starting...';
  if (isPlayoutConnected.value) return 'Disconnect';
  if (processStatus.value?.circuitBreakerTripped) {
    return 'Relaunch & Reset';
  }
  switch (processState.value) {
    case 'unconfigured': return 'Locate Server';
    case 'stopped': return 'Start and Connect';
    case 'crashed': return 'Relaunch & Resume';
    case 'external_running':
    case 'disconnected':
    case 'operational':
    default:
      return 'Connect';
  }
});

const handleConnectionAction = async () => {
  const service = getActivePlayoutService();
  if (isPlayoutConnected.value) {
    await service.disconnect();
    return;
  }

  if (processStatus.value?.circuitBreakerTripped) {
    try {
      await restartCasparServer();
    } catch (e) {
      console.warn('[ConnectionAction] Failed to reset circuit breaker and relaunch:', e);
    }
    return;
  }

  if (processState.value === 'unconfigured') {
    showSettings.value = true;
    return;
  }

  const isRunning = processStatus.value?.isPortOpen ||
                    processState.value === 'operational' ||
                    processState.value === 'external_running';

  if (!isRunning && (processState.value === 'stopped' || processState.value === 'crashed')) {
    try {
      await startCasparServer();
      await service.connect();
    } catch (e) {
      console.warn('[ConnectionAction] Failed to start and connect:', e);
    }
    return;
  }

  // Connect TCP/AMCP
  try {
    await service.connect();
  } catch (e) {
    console.warn('[ConnectionAction] Connect failed:', e);
  }
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



const isLiveCutArmed = ref(false);
let liveCutArmTimer: ReturnType<typeof setTimeout> | null = null;

const cutToLive = async () => {
  if (!isLiveCutArmed.value) {
    isLiveCutArmed.value = true;
    if (liveCutArmTimer) clearTimeout(liveCutArmTimer);
    liveCutArmTimer = setTimeout(() => {
      isLiveCutArmed.value = false;
      liveCutArmTimer = null;
    }, 3000);
    return;
  }

  if (liveCutArmTimer) {
    clearTimeout(liveCutArmTimer);
    liveCutArmTimer = null;
  }
  isLiveCutArmed.value = false;

  try {
    await getActivePlayoutService().cutToLive?.();
    manualTakeFailure.value = null;
  } catch (err: any) {
    console.error('[Live] Cut to live failed:', err);
    await message(err?.message || String(err), { title: 'Live Cut Failed', kind: 'error' });
  }
};

const formatTabularDuration = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(remainingSeconds).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
};

const nextUpItem = computed(() => rundown.nextPlayableItem);

const nextUpItemTitle = computed(() => {
  if (!nextUpItem.value) return 'End of Rundown';
  const item = nextUpItem.value;
  if (item.display_name) return item.display_name;
  if (item.current_path) {
    const fn = item.current_path.split(/[/\\]/).pop();
    if (fn && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fn)) {
      return fn;
    }
  }
  if (item.filename && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.filename)) {
    return item.filename;
  }
  return 'Untitled Asset';
});

const nextUpItemDuration = computed(() => {
  if (!nextUpItem.value) return '';
  const item = nextUpItem.value;
  if (item.type === 'live') {
    const durSec = item.plannedDuration || item.duration || 0;
    return durSec > 0 ? formatTabularDuration(durSec) : 'LIVE';
  }
  const totalMs = item.duration_ms || (item.duration ? item.duration * 1000 : 0);
  const inMs = item.trim_in_ms ?? item.inPoint ?? 0;
  const outMs = item.trim_out_ms ?? (item.outPoint > 0 ? item.outPoint : totalMs);
  const durSec = (outMs > inMs && inMs >= 0) ? (outMs - inMs) / 1000 : totalMs / 1000;
  return formatTabularDuration(durSec);
});

const isNextUpImminent = computed(() => {
  if (!isPlayoutPlaying.value || !rundown.playbackCountdownStr) return false;
  const cleaned = rundown.playbackCountdownStr.replace(/^-/, '').trim();
  const parts = cleaned.split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return false;
  let totalSecs = 0;
  if (parts.length === 3) {
    totalSecs = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  } else if (parts.length === 2) {
    totalSecs = parts[0]! * 60 + parts[1]!;
  } else {
    return false;
  }
  return totalSecs >= 0 && totalSecs <= 10;
});

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
      (event: { payload: { online: boolean; last_seen_at: number; error?: string; auth_rejected?: boolean } }) => {
        const payload = event.payload;
        ingestorStatus.setOnline(payload.online, payload.last_seen_at);
        ingestorStatus.setAuthRejected(payload.auth_rejected === true);
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

  try {
    await initCasparProcessListener();
  } catch (err) {
    console.warn('[CasparProcess] Listener init failed:', err);
  }

  // Restore connection and playback state on F5 refresh / launch
  if (settings.playoutEngine === 'casparcg') {
    const service = getActivePlayoutService();
    const isRunning = processStatus.value?.isPortOpen ||
                      processState.value === 'operational' ||
                      processState.value === 'external_running';

    if (isRunning) {
      service.connect().catch((error) => {
        console.warn('[Playout] Auto-connect to running CasparCG failed:', error);
      });
    } else if (settings.casparAutoStart || processState.value === 'stopped' || processState.value === 'crashed') {
      startCasparServer()
        .then(() => service.connect())
        .catch((error) => {
          console.warn('[Playout] Auto-start CasparCG failed:', error);
        });
    } else {
      service.connect().catch((error) => {
        console.warn('[Playout] Auto-connect to CasparCG failed:', error);
      });
    }
  }
  rundown.restorePlaybackState();

  if (settings.recycleBinAutoPurge && settings.recycleBinAutoPurge !== 'disabled') {
    const mediaLib = useMediaLibraryStore();
    mediaLib.checkAndTriggerAutoPurge(settings.recycleBinAutoPurge);
  }

  // Hydrate deployed Studio preset into Pinia on application boot
  try {
    const defaultPreset = await invoke<any>('get_studio_default_preset');
    if (defaultPreset) {
      settings.updateCgAdvisoryFromDeployedPreset(defaultPreset);
    }
  } catch (_) {}
});

onUnmounted(() => {
  onMouseUp();
  if (liveCutArmTimer) {
    clearTimeout(liveCutArmTimer);
    liveCutArmTimer = null;
  }
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

    <!-- Audit T1-8: rundown changes are not reaching localStorage -->
    <div v-if="persistenceFault" class="halt-banner persist-banner" role="alert">
      <div class="halt-content">
        <span class="halt-icon">💾</span>
        <span class="halt-text">{{ persistenceFault.message }} Save the rundown to a file now.</span>
      </div>
      <button class="halt-dismiss-btn" @click="clearPersistenceFault()">Dismiss</button>
    </div>

    <!-- Audit T1-12: unhandled frontend faults, non-blocking -->
    <div v-if="frontendFaults.length" class="fault-toasts" aria-live="polite">
      <div v-for="fault in frontendFaults" :key="fault.id" class="fault-toast">
        <span class="fault-source">{{ fault.source }}</span>
        <span class="fault-message">{{ fault.message }}</span>
        <span v-if="fault.count > 1" class="fault-count">×{{ fault.count }}</span>
        <button class="fault-dismiss" title="Dismiss" @click="dismissFrontendFault(fault.id)">✕</button>
      </div>
    </div>
    
    <aside class="panel panel-library glass-panel"><MediaLibrary /></aside>
    <div class="resizer resizer-left" title="Drag to resize · double-click to reset" @mousedown="startResizeLeft" @dblclick="leftWidth = 280"></div>
    
    <section class="panel panel-rundown glass-panel"><RundownList /></section>

    <!-- Simplified Master Control Bar -->
    <footer class="control-bar glass-panel">

      <!-- Connection Indicator & Control in One Field -->
      <div class="ctrl-section">
        <button
          class="ctrl-btn conn-toggle-btn"
          :class="[
            'tone-' + connectionTone,
            { 'is-connected': isPlayoutConnected }
          ]"
          :disabled="isStarting || processState === 'starting'"
          @click="handleConnectionAction"
          :title="isPlayoutConnected ? 'CasparCG Connected · Click to Disconnect' : `CasparCG (${connectionLabel}) · Click to ${connectionBtnText}`"
        >
          <span
            class="status-dot"
            :class="[
              'tone-' + connectionTone,
              { pulse: connectionTone === 'processing' || processState === 'unconfigured' || processState === 'crashed' }
            ]"
          ></span>
          <span class="conn-text">{{ isPlayoutConnected ? 'CONNECTED' : connectionBtnText }}</span>
        </button>
        <span v-if="!isPrimaryInstance" class="monitor-badge" title="Running in secondary Monitor Mode (Read-Only)">MONITOR</span>
      </div>

      <div class="ctrl-divider"></div>

      <!-- PLAY / STOP — the main call-to-action -->
      <div class="ctrl-section ctrl-play-wrap">
        <button
          v-if="!isPlayoutPlaying"
          class="ctrl-btn btn-play"
          :disabled="!isPlayoutConnected || !rundown.activeItems.length || rundown.isRundownLocked || !isPrimaryInstance"
          @click="playSelected"
          :title="!isPrimaryInstance ? 'Disabled in Monitor Mode (Read-Only)' : (rundown.isRundownLocked ? 'Rundown is Locked (Unlock to Play)' : 'Play playlist from selected item (or beginning)')"
        >
          ▶ PLAY
        </button>
        <button
          v-else
          class="ctrl-btn btn-stop"
          :disabled="!isPrimaryInstance"
          @click="stopPlayback"
          title="Stop playback"
        >
          ■ STOP
        </button>
      </div>

      <!-- Spatial Safety Fencing for Studio Routing & CUT TO LIVE -->
      <div class="ctrl-divider barrier-fence-divider"></div>

      <div class="ctrl-section ctrl-routing-fence">
        <span class="routing-fence-label">ROUTING</span>
        <button
          v-if="!isPlayoutLive"
          class="ctrl-btn btn-live-now"
          :class="{ 'btn-live-armed': isLiveCutArmed }"
          :disabled="!isPlayoutConnected || !isPrimaryInstance"
          @click="cutToLive"
          :title="!isLiveCutArmed ? 'Arm Cut to Live (First Click to Arm)' : 'Click Again to Execute Hardware Cut to Live'"
        >
          {{ isLiveCutArmed ? '⚠️ CONFIRM CUT (ARMED)' : '🔴 CUT TO LIVE' }}
        </button>
        <button
          v-else
          class="ctrl-btn btn-live-active"
          :disabled="!isPrimaryInstance"
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

      <!-- Media Timecode & Next Up Telemetry Dock -->
      <div class="ctrl-section ctrl-telemetry-group">
        <div class="timecode">{{ currentPlayoutTime }}</div>
        <div class="ctrl-nextup-dock" :class="{ 'is-imminent': isNextUpImminent }">
          <div class="nextup-header">
            <span class="nextup-kicker">NEXT UP</span>
            <span v-if="isNextUpImminent" class="nextup-imminent-pill">ADVANCE &lt; 10s</span>
          </div>
          <div class="nextup-body">
            <span class="nextup-title" :title="nextUpItemTitle">{{ nextUpItemTitle }}</span>
            <span v-if="nextUpItemDuration" class="nextup-duration-pill">{{ nextUpItemDuration }}</span>
          </div>
        </div>
      </div>

      <div class="ctrl-divider"></div>

      <!-- Broadcast Stream & SDI -->
      <div v-if="activePlayoutCapabilities.streaming" class="ctrl-section">
        <div class="status-dot" :class="{ connected: isStreaming }" style="--dot-color:#e63946;"></div>
        <span class="ctrl-label">{{ isStreaming ? 'ON AIR' : 'STANDBY' }}</span>
        <button class="ctrl-btn" :class="{ 'btn-live': isStreaming }" :disabled="!isPlayoutConnected || !isPrimaryInstance" @click="toggleStream" style="font-size:0.7rem;">
          {{ isStreaming ? '■ Stop' : '● Stream' }}
        </button>

        <button v-if="activePlayoutCapabilities.hardwareOutput && settings.decklinkOutputName" class="ctrl-btn" :class="{ 'btn-live': isSdiActive }" :disabled="!isPlayoutConnected || !isPrimaryInstance" @click="toggleSdi" style="font-size:0.7rem; margin-left:12px;">
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
          :title="`${APP_NAME} ${APP_VERSION} · System Info`"
          aria-label="System Info"
        >
          <svg class="brand-play-icon" viewBox="0 0 24 24" width="13" height="13">
            <path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.04-6.86a1 1 0 0 0 0-1.72L9.5 4.28a1 1 0 0 0-1.5.86z"/>
          </svg>
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
  color:#000; font-size:0.88rem; font-weight:800;
  padding:6px 20px; letter-spacing:1px;
  box-shadow:0 0 12px rgba(51,190,204,0.35);
}
.btn-play:hover:not(:disabled) { background:#45d4e3; box-shadow:0 0 18px rgba(51,190,204,0.6); }

.btn-stop {
  background:#e63946; border-color:#e63946;
  color:#fff; font-size:0.88rem; font-weight:800;
  padding:6px 20px; letter-spacing:1px;
  box-shadow:0 0 12px rgba(230,57,70,0.35);
  animation:pulse-stop 1.5s ease-in-out infinite;
}
@keyframes pulse-stop {
  0%,100% { box-shadow:0 0 12px rgba(230,57,70,0.4); }
  50%      { box-shadow:0 0 28px rgba(230,57,70,0.8); }
}

.btn-live { background:rgba(230,57,70,0.2); border-color:rgba(230,57,70,0.5); color:#e63946; }

.btn-live-now {
  background:rgba(230,57,70,0.1); border-color:#e63946;
  color:#fff; font-size:0.8rem; font-weight:800;
  padding:5px 12px; letter-spacing:0.5px; margin-left:0;
  animation:pulse-live 2s infinite;
}
.btn-live-now:hover { background:rgba(230,57,70,0.3); border-color:#fca5a5; box-shadow:0 0 12px rgba(230,57,70,0.4); }

.btn-live-active {
  background:#ef4444; border-color:#f87171;
  color:#fff; font-size:0.8rem; font-weight:800;
  padding:5px 12px; letter-spacing:0.5px; margin-left:0;
  box-shadow:0 0 16px rgba(239,68,68,0.7);
  animation:pulse-live 1s infinite;
}
.btn-live-active:hover {
  background:#dc2626; border-color:#fca5a5;
  box-shadow:0 0 24px rgba(239,68,68,0.9);
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
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: 2.5px;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  color: var(--accent-blue);
  text-shadow: 0 0 14px color-mix(in srgb, var(--accent-blue) 40%, transparent);
  line-height: 1;
}

.barrier-fence-divider {
  width: 2px !important;
  height: 32px !important;
  background: var(--border-strong, #475569) !important;
  margin: 0 10px !important;
}

.ctrl-routing-fence {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 6px;
  padding: 2px 8px;
  background: rgba(239, 68, 68, 0.06);
}

.routing-fence-label {
  font-size: 0.6rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--accent-red, #ef4444);
  white-space: nowrap;
}

.btn-live-armed {
  background: #d97706 !important;
  border-color: #f59e0b !important;
  color: #fff !important;
  box-shadow: 0 0 16px rgba(217, 119, 6, 0.8) !important;
  animation: pulse-armed 0.6s infinite alternate !important;
}

@keyframes pulse-armed {
  0% { background: #d97706; box-shadow: 0 0 10px #d97706; }
  100% { background: #dc2626; box-shadow: 0 0 25px #dc2626; }
}

.conn-toggle-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.74rem;
  font-weight: 700;
  padding: 5px 11px;
  border-radius: 6px;
  letter-spacing: 0.5px;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}

.conn-toggle-btn.is-connected {
  background: rgba(34, 197, 94, 0.12);
  border: 1px solid rgba(34, 197, 94, 0.4);
  color: #22c55e;
}

.conn-toggle-btn.is-connected:hover {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.5);
  color: #f87171;
}

.conn-toggle-btn:not(.is-connected) {
  background: var(--bg-hover);
  border: 1px solid var(--border-medium);
  color: var(--text-secondary);
}

.conn-toggle-btn:not(.is-connected):hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-blue) 12%, var(--bg-hover));
  border-color: var(--accent-blue);
  color: var(--text-primary);
}

.conn-popover {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  width: 220px;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--border-medium);
  background: var(--bg-secondary);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
  z-index: 40;
}

.conn-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.conn-popover-title {
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--text-primary);
}

.conn-popover-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.85rem;
}

.conn-popover-body {
  font-size: 0.72rem;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.conn-popover-row {
  display: flex;
  justify-content: space-between;
}

.conn-popover-footer {
  display: flex;
  justify-content: flex-end;
}

.ctrl-telemetry-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ctrl-nextup-dock {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--bg-surface-elevated, rgba(0, 0, 0, 0.25));
  border: 1px solid var(--border-subtle);
  min-width: 140px;
  max-width: 195px;
  height: 32px;
  box-sizing: border-box;
  transition: all 0.2s ease;
}

.ctrl-nextup-dock.is-imminent {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.15);
  animation: pulse-imminent 1s infinite alternate;
}

@keyframes pulse-imminent {
  0% { box-shadow: 0 0 6px rgba(245, 158, 11, 0.4); }
  100% { box-shadow: 0 0 16px rgba(245, 158, 11, 0.8); }
}

.nextup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  line-height: 1;
}

.nextup-kicker {
  font-size: 0.55rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

.nextup-imminent-pill {
  font-size: 0.52rem;
  font-weight: 800;
  color: #fff;
  background: #d97706;
  padding: 0 3px;
  border-radius: 2px;
  line-height: 1.2;
  animation: blink 1s step-end infinite;
}

.nextup-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  line-height: 1.2;
}

.nextup-title {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 130px;
}

.nextup-duration-pill {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--accent-blue);
  font-variant-numeric: tabular-nums;
  background: rgba(56, 189, 248, 0.1);
  padding: 0 4px;
  border-radius: 3px;
  white-space: nowrap;
}

.brand-play-icon {
  fill: #c084fc !important;
  filter: drop-shadow(0 0 3px rgba(192, 132, 252, 0.6));
}
.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--border-strong);
  transition: all 0.2s ease;
}
.status-dot.connected,
.status-dot.tone-ready {
  background: var(--accent-green);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent-green) 60%, transparent);
}
.status-dot.tone-warning {
  background: #f59e0b;
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.6);
}
.status-dot.tone-error {
  background: #ef4444;
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.7);
}
.status-dot.tone-processing {
  background: #38bdf8;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.7);
}
.status-dot.tone-idle {
  background: #c084fc;
  box-shadow: 0 0 8px rgba(192, 132, 252, 0.6);
}
.status-dot.pulse {
  animation: status-dot-pulse 1.4s ease-in-out infinite;
}
@keyframes status-dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.85); }
}

.monitor-badge {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(168, 85, 247, 0.2);
  border: 1px solid rgba(168, 85, 247, 0.5);
  color: #c084fc;
}

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
  width: 28px;
  height: 28px;
  min-width: 28px;
  padding: 0;
  border-radius: 50% !important;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(168, 85, 247, 0.15) !important;
  border: 1px solid rgba(168, 85, 247, 0.45) !important;
  color: #c084fc !important;
}

.ctrl-meta-brand:hover,
.ctrl-meta-brand.is-open {
  background: rgba(168, 85, 247, 0.28) !important;
  border-color: rgba(168, 85, 247, 0.75) !important;
  box-shadow: 0 0 12px rgba(168, 85, 247, 0.45) !important;
  color: #d8b4fe !important;
}

.ctrl-meta-brand:hover .brand-play-icon,
.ctrl-meta-brand.is-open .brand-play-icon {
  fill: #d8b4fe !important;
  filter: drop-shadow(0 0 5px rgba(192, 132, 252, 0.8));
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

.persist-banner {
  top: 72px;
  background: rgba(245, 158, 11, 0.16);
  border-color: rgba(245, 158, 11, 0.5);
  box-shadow: 0 8px 32px rgba(245, 158, 11, 0.2);
}

.fault-toasts {
  position: absolute;
  right: 16px;
  bottom: 92px;
  z-index: 9998;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(480px, calc(100vw - 32px));
  pointer-events: none;
}

.fault-toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(230, 57, 70, 0.14);
  border: 1px solid rgba(230, 57, 70, 0.4);
  backdrop-filter: blur(10px);
  color: #fff;
  font-size: 0.8rem;
  font-family: Inter, system-ui, sans-serif;
  pointer-events: auto;
  animation: slideDownFade 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.fault-source {
  font-weight: 700;
  opacity: 0.85;
  text-transform: uppercase;
  font-size: 0.68rem;
  letter-spacing: 0.04em;
}

.fault-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fault-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.fault-dismiss {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
}

.fault-dismiss:hover {
  opacity: 1;
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
