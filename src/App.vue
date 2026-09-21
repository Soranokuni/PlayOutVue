<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import MediaLibrary from './components/MediaLibrary.vue';
import RundownList from './components/RundownList.vue';
import MediaInspector from './components/MediaInspector.vue';
import { lazyComponent } from './lib/lazyComponent';
import { fitToWidth, MAX_FIT_STEP } from './lib/fitToWidth';
import CommandPaletteModal from './components/CommandPaletteModal.vue';
// PERF F-14: Settings is 1.8k lines and opened rarely; load it on demand and
// mount it only while open so its watchers/listeners do not run at startup.
const { component: SettingsModal, preload: preloadSettingsModal } = lazyComponent(
  'SettingsModal',
  () => import('./components/SettingsModal.vue'),
);
import IngestorStatusLight from './components/IngestorStatusLight.vue';
import AppIcon from './components/ui/AppIcon.vue';
import ToastHost from './components/ui/ToastHost.vue';
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

/* ---------------------------------------------------------------------------
   Round 3 §4 — the control bar fits itself.

   UI F-01 stopped the bar wrapping (the wrapped second row fell outside the
   fixed 58 px grid row, so Settings and Lock were unreachable at the app's own
   1100 px minimum). It replaced wrapping with three tiers chosen from fixed
   pixel thresholds, 980 and 1180.

   A threshold is a guess about how wide the content happens to be, and it is
   wrong the moment anything it guessed about changes: the density scale, the
   theme's font, the engine button's label, the next-up title, whether TAKE
   HELD is up, how far the operator dragged the library split. Between the
   thresholds, content that did not fit was clipped by the shell's `overflow`,
   silently.

   So the bar stops guessing. After every resize it asks one question -- does
   my content fit? -- and if not it sheds the least important thing and asks
   again. The ladder is in `data-step` on the footer; the loop is in
   `lib/fitToWidth.ts` so it can be tested without a layout engine.
   --------------------------------------------------------------------------- */
const controlBarRef = ref<HTMLElement | null>(null);
const controlBarStep = ref(0);
let controlBarObserver: ResizeObserver | null = null;

const fitControlBar = () => {
  const el = controlBarRef.value;
  if (!el) return;
  // An element with no layout (happy-dom, or a bar not yet in the grid) reports
  // zero for everything; walking the ladder on that would collapse the bar for
  // no reason.
  if (!el.clientWidth) return;

  const available = el.clientWidth;
  const previous = controlBarStep.value;

  // Measure each rung by actually standing on it. Reads and writes interleave,
  // so this is a synchronous layout thrash -- bounded at MAX_FIT_STEP + 1
  // iterations, and only on resize, which is the one moment layout is already
  // being recomputed.
  const naturalWidths: number[] = [];
  for (let step = 0; step <= MAX_FIT_STEP; step += 1) {
    el.dataset.step = String(step);
    naturalWidths.push(el.scrollWidth);
    if (naturalWidths[step]! <= available + 1) break;
  }
  // Rungs we never stood on cannot be wider than the last one we measured.
  while (naturalWidths.length <= MAX_FIT_STEP) {
    naturalWidths.push(naturalWidths[naturalWidths.length - 1] ?? 0);
  }

  const next = fitToWidth({ naturalWidths, available });
  el.dataset.step = String(next);
  if (next !== previous) controlBarStep.value = next;
};

const startControlBarObserver = () => {
  const el = controlBarRef.value;
  if (!el) return;

  if (typeof ResizeObserver !== 'undefined') {
    controlBarObserver = new ResizeObserver(() => fitControlBar());
    controlBarObserver.observe(el);
  }

  // The first measurement at mount can land before the grid has laid out, and
  // if the bar's box never changes afterwards no observation follows to correct
  // it -- the bar would stay collapsed at a width that fits everything.
  // Measure again after a frame, and keep a window listener as a fallback for
  // environments where ResizeObserver does not deliver.
  fitControlBar();
  requestAnimationFrame(fitControlBar);
  window.addEventListener('resize', fitControlBar);
};

const stopControlBarObserver = () => {
  controlBarObserver?.disconnect();
  controlBarObserver = null;
  window.removeEventListener('resize', fitControlBar);
};

/** At the last rung the utilities fold into one popover. */
const showControlBarMore = ref(false);
const isControlBarCollapsed = computed(() => controlBarStep.value >= MAX_FIT_STEP);

watch(isControlBarCollapsed, (collapsed) => {
  if (!collapsed) showControlBarMore.value = false;
});

const toggleControlBarMore = () => {
  showProductInfo.value = false;
  showQuickGuide.value = false;
  showControlBarMore.value = !showControlBarMore.value;
};

const APP_NAME = 'Aether';
const APP_VERSION = '3.0';

const appHighlights = [
  'Multi-playlist rundown planning with separate offline prep and on-air control.',
  'CasparCG playout control with safe handoff, live cuts, and timing feedback.',
  'Media library scanning, trim workflow, compliance labels, and spot or telemarketing tagging.',
  'Operator-first rundown editing with drag insert, gap markers, next-up warnings, and persistent selection.'
];

// These are checked against useOperatorShortcuts: a guide that promises a key
// nothing binds is how Ctrl+I went unbound for as long as it did (F-04). The
// first line used to claim Enter or Space plays the selected row -- the
// operator keyboard contract (§5) deliberately ignores both so a stray press
// can never put something on air.
const shortcutGuide = [
  'Enter and Space never take a row on air — use the PLAY button or the row play control.',
  'Delete or Backspace: remove the selected row, except the one currently on air.',
  'Ctrl + Arrow Up or Arrow Down: move the selected row.',
  'Shift + Arrow Down: duplicate the selected row.',
  'Ctrl + I: inspect the selected clip — metadata and QC.',
  'Ctrl + K: open the command palette.',
  'Ctrl + S: save the playlist; Ctrl + O loads one, Ctrl + Shift + O appends one.',
  'F8 in the media library: add the selected item to the end of the rundown (Shift + F8 inserts after the selection).'
];

const workflowGuide = [
  'Drag media from the library into the rundown to insert exactly where the cyan marker appears.',
  'Double-click a playlist tab to rename it, then keep offline playlists staged until you take them on air.',
  'Use gap lines plus Day and At to plan hard starts without changing the playout queue until playback begins.',
  'Right-click any clip to inspect probe metadata, QC status, and transcode parameters.',
  'Use Settings for connections, media paths, themes, and QC sensitivity modes.'
];

// §5.1: 320px default (min 280, max 640). At 280 there were five chrome bars
// before the first asset and names truncated at ~8 characters.
const LIBRARY_WIDTH_DEFAULT = 320;
const leftWidth = useStorage('layout.leftWidth', LIBRARY_WIDTH_DEFAULT);
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
  showControlBarMore.value = false;
};

const handleGlobalPointerDown = (event: PointerEvent) => {
  const target = event.target as HTMLElement | null;
  if (footerMetaRef.value && target && footerMetaRef.value.contains(target)) return;
  // §4.2 step 5: the More popover dismisses the same way the meta popovers do.
  if (target?.closest('.ctrl-more-wrap')) return;
  closeFooterPanels();
};

const applyResize = () => {
  resizeFrame = 0;
  if (isResizing.value === 'left') {
    leftWidth.value = Math.max(280, Math.min(640, pendingResizeX));
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

/**
 * §7 / §9: a short state for the status readout. The long sentences below stay
 * as the tooltip; the bar shows two or three words.
 */
const connectionShortState = computed(() => {
  if (!isPrimaryInstance.value) return isPlayoutConnected.value ? 'Monitor' : 'Monitor · offline';
  if (isPlayoutConnected.value) return 'Connected';
  if (processStatus.value?.circuitBreakerTripped) return 'Crash loop';
  switch (processState.value) {
    case 'unconfigured': return 'Not found';
    case 'stopped': return 'Stopped';
    case 'starting': return 'Starting…';
    case 'external_running': return 'Ready';
    case 'crashed': return 'Crashed';
    case 'disconnected': return 'Offline';
    case 'operational': return 'Ready';
    default: return 'Offline';
  }
});

/** The verb, which is now a separate control from the state above. */
const connectionActionLabel = computed(() => {
  if (isStarting.value || processState.value === 'starting') return 'Starting…';
  if (isPlayoutConnected.value) return 'Disconnect';
  if (processStatus.value?.circuitBreakerTripped) return 'Relaunch';
  switch (processState.value) {
    case 'unconfigured': return 'Browse…';
    case 'stopped': return 'Start';
    case 'crashed': return 'Relaunch';
    default: return 'Connect';
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

/** How long the second click stays live, in ms. */
const LIVE_CUT_ARM_MS = 3000;

/**
 * §7: the arm window is drawn as a ring that empties over the three seconds,
 * so the operator can see how long they have. Ticked on a timer rather than
 * rAF: one repaint every 100ms, not sixty.
 */
const liveCutArmRemaining = ref(0);
let liveCutArmTick: ReturnType<typeof setInterval> | null = null;

const stopArmCountdown = () => {
  if (liveCutArmTick) {
    clearInterval(liveCutArmTick);
    liveCutArmTick = null;
  }
  liveCutArmRemaining.value = 0;
};

/** 0 … 1, for the conic-gradient sweep. */
const liveCutArmProgress = computed(() =>
  liveCutArmRemaining.value > 0 ? liveCutArmRemaining.value / LIVE_CUT_ARM_MS : 0
);

const disarmLiveCut = () => {
  if (liveCutArmTimer) {
    clearTimeout(liveCutArmTimer);
    liveCutArmTimer = null;
  }
  isLiveCutArmed.value = false;
  stopArmCountdown();
};

const cutToLive = async () => {
  if (!isLiveCutArmed.value) {
    isLiveCutArmed.value = true;
    if (liveCutArmTimer) clearTimeout(liveCutArmTimer);

    const armedAt = Date.now();
    liveCutArmRemaining.value = LIVE_CUT_ARM_MS;
    stopArmCountdown();
    liveCutArmTick = setInterval(() => {
      liveCutArmRemaining.value = Math.max(0, LIVE_CUT_ARM_MS - (Date.now() - armedAt));
    }, 100);

    liveCutArmTimer = setTimeout(() => {
      isLiveCutArmed.value = false;
      liveCutArmTimer = null;
      stopArmCountdown();
    }, LIVE_CUT_ARM_MS);
    return;
  }

  disarmLiveCut();

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

/**
 * A ResizeObserver only fires when the *box* changes. Everything below changes
 * how much the bar's content wants, without changing the box by a pixel -- so
 * each one has to ask the bar to re-fit itself, or the bar keeps a step that
 * was right for the previous label.
 */
watch(
  () => [
    connectionActionLabel.value,
    isLiveCutArmed.value,
    isPlayoutLive.value,
    !!manualTakeFailure.value,
    nextUpItemTitle.value,
    settings.uiScale,
  ],
  () => void nextTick(fitControlBar)
);

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

const revealWindow = () => {
  // PERF F-16: the window is created hidden (tauri.conf.json `visible: false`)
  // so the operator never sees a white unstyled frame. Reveal after Vue's first
  // DOM commit; Rust also reveals it after a timeout as a fail-safe.
  invoke('frontend_ready').catch(() => { /* dev server / tests */ });
  if (settings.debugMode) {
    invoke('push_diagnostic_log', {
      level: 'info',
      scope: 'frontend:startup',
      message: `App mounted ${Math.round(performance.now())} ms after navigation start`,
    }).catch(() => {});
  }
};

onMounted(async () => {
  window.addEventListener('pointerdown', handleGlobalPointerDown);
  window.addEventListener('playout:open-inspector', handleInspectorOpenEvent);
  startControlBarObserver();
  revealWindow();
  if (settings.debugMode) {
    startJankMonitor();
  }

  // PERF F-17: independent listeners and IPC start concurrently instead of
  // one `await` after another. The Studio preset hydration is fired first and
  // consumed last; it is not on the connect path.
  const studioPresetPromise = invoke<any>('get_studio_default_preset').catch(() => null);
  const [heartbeatUnlisten, haltedUnlisten] = await Promise.all([
    listen('ingestor-heartbeat',
      (event: { payload: { online: boolean; last_seen_at: number; error?: string; auth_rejected?: boolean } }) => {
        const payload = event.payload;
        ingestorStatus.setOnline(payload.online, payload.last_seen_at);
        ingestorStatus.setAuthRejected(payload.auth_rejected === true);
        if (!payload.online && payload.error) {
          ingestorStatus.logWarning('ingestor-heartbeat', `Connection lost: ${payload.error}`);
        }
      }
    ).catch((err) => {
      console.error('[Heartbeat] Failed to listen to heartbeat events:', err);
      return null;
    }),
    listen('playout://halted', () => {
      playoutHalted.value = true;
    }).catch((err) => {
      console.error('[Playout] Failed to listen to playout://halted event:', err);
      return null;
    }),
    initCasparProcessListener().catch((err) => {
      console.warn('[CasparProcess] Listener init failed:', err);
    }),
  ]);
  unlistenHeartbeat = heartbeatUnlisten;
  unlistenHalted = haltedUnlisten;

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
  const defaultPreset = await studioPresetPromise;
  if (defaultPreset) {
    settings.updateCgAdvisoryFromDeployedPreset(defaultPreset);
  }
});

onUnmounted(() => {
  onMouseUp();
  disarmLiveCut();
  window.removeEventListener('pointerdown', handleGlobalPointerDown);
  window.removeEventListener('playout:open-inspector', handleInspectorOpenEvent);
  stopControlBarObserver();
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
    <!-- §10: playout halting is the one thing that must interrupt whatever a
         screen-reader user is reading, so this is `assertive`. Toasts stay
         `polite`; clocks and timecodes announce nothing. -->
    <div v-if="playoutHalted" class="halt-banner" role="alert" aria-live="assertive">
      <div class="halt-content">
        <AppIcon class="halt-icon" name="alert" :size="20" />
        <span class="halt-text">Playout halted after 3 consecutive errors — operator intervention required.</span>
      </div>
      <button class="halt-dismiss-btn" @click="playoutHalted = false">Dismiss</button>
    </div>

    <!-- Audit T1-8: rundown changes are not reaching localStorage -->
    <div v-if="persistenceFault" class="halt-banner persist-banner" role="alert">
      <div class="halt-content">
        <AppIcon class="halt-icon" name="save" :size="20" />
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
        <button class="fault-dismiss" title="Dismiss" aria-label="Dismiss fault" @click="dismissFrontendFault(fault.id)">
          <AppIcon name="close" :size="14" />
        </button>
      </div>
    </div>
    
    <aside class="panel panel-library glass-panel"><MediaLibrary /></aside>
    <div class="resizer resizer-left" title="Drag to resize · double-click to reset" @mousedown="startResizeLeft" @dblclick="leftWidth = LIBRARY_WIDTH_DEFAULT"></div>
    
    <section class="panel panel-rundown glass-panel"><RundownList /></section>

    <!-- Simplified Master Control Bar -->
    <footer class="control-bar" ref="controlBarRef" :data-step="controlBarStep">

      <!-- §7 group 1: engine. The status says what is true; the button next
           to it says what will happen. They used to be one control whose label
           flipped between the two. -->
      <div class="ctrl-section ctrl-engine">
        <span class="conn-status" :title="connectionLabel">
          <span
            class="status-dot"
            :class="[
              'tone-' + connectionTone,
              { pulse: connectionTone === 'processing' || processState === 'unconfigured' || processState === 'crashed' }
            ]"
          ></span>
          <span class="conn-text">{{ connectionShortState }}</span>
        </span>
        <button
          class="ctrl-btn conn-action-btn"
          :disabled="isStarting || processState === 'starting'"
          :title="`${connectionActionLabel} — CasparCG: ${connectionLabel}`"
          :aria-label="connectionActionLabel"
          @click="handleConnectionAction"
        >
          <AppIcon class="ctrl-btn-glyph" name="zap" :size="14" />
          <span class="ctrl-btn-label">{{ connectionActionLabel }}</span>
        </button>
        <span v-if="!isPrimaryInstance" class="monitor-badge" title="Running in secondary monitor mode (read-only)">MONITOR</span>
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
          <AppIcon name="play" :size="16" :stroke-width="2.5" />
          <span>PLAY</span>
        </button>
        <button
          v-else
          class="ctrl-btn btn-stop"
          :disabled="!isPrimaryInstance"
          @click="stopPlayback"
          title="Stop playback"
        >
          <AppIcon name="stop" :size="16" :stroke-width="2.5" />
          <span>STOP</span>
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
          :title="!isLiveCutArmed ? 'Arm the cut to live — a second click executes it' : 'Click again to cut to live'"
        >
          <!-- §7: the 3s arm window had no visible countdown. The ring
               empties over those three seconds so the operator can see how
               long the second click stays live. -->
          <span
            v-if="isLiveCutArmed"
            class="arm-ring"
            aria-hidden="true"
            :style="{ '--arm-progress': liveCutArmProgress }"
          ></span>
          <AppIcon class="ctrl-btn-glyph" :name="isLiveCutArmed ? 'alert' : 'live'" :size="14" :stroke-width="2.5" />
          <span class="ctrl-btn-label">{{ isLiveCutArmed ? 'CONFIRM CUT (ARMED)' : 'CUT TO LIVE' }}</span>
          <span class="ctrl-btn-label-short" aria-hidden="true">{{ isLiveCutArmed ? 'CONFIRM' : 'LIVE' }}</span>
        </button>
        <button
          v-else
          class="ctrl-btn btn-live-active"
          :disabled="!isPrimaryInstance"
          @click="returnFromLive"
          title="Live Broadcast Active — Click to Return to Rundown Playlist"
        >
          <AppIcon class="ctrl-btn-glyph" name="live" :size="14" :stroke-width="2.5" />
          <span class="ctrl-btn-label">LIVE ON AIR (RETURN TO RUNDOWN)</span>
          <span class="ctrl-btn-label-short" aria-hidden="true">LIVE ON AIR</span>
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
        <div class="status-dot" :class="{ connected: isStreaming }"></div>
        <span class="ctrl-label">{{ isStreaming ? 'ON AIR' : 'STANDBY' }}</span>
        <button class="ctrl-btn" :class="{ 'btn-live': isStreaming }" :disabled="!isPlayoutConnected || !isPrimaryInstance" @click="toggleStream" style="font-size:var(--fs-xs);">
          <AppIcon :name="isStreaming ? 'stop' : 'live'" :size="14" />
          <span>{{ isStreaming ? 'Stop' : 'Stream' }}</span>
        </button>

        <button v-if="activePlayoutCapabilities.hardwareOutput && settings.decklinkOutputName" class="ctrl-btn" :class="{ 'btn-live': isSdiActive }" :disabled="!isPlayoutConnected || !isPrimaryInstance" @click="toggleSdi" style="font-size:var(--fs-xs); margin-left:12px;">
          <AppIcon :name="isSdiActive ? 'stop' : 'live'" :size="14" />
          <span>{{ isSdiActive ? 'SDI Stop' : 'SDI OUT' }}</span>
        </button>
      </div>

      <div v-if="activePlayoutCapabilities.streaming" class="ctrl-divider"></div>

      <!-- §4.2 steps 2 and 5: the utilities. They lose their words first and
           fold into one popover last, so the bar shrinks to
           `[status] [PLAY] | [LIVE] [timecode] [NEXT UP] [⋯]` -- about 640 px,
           far below the window's own 1100 px minimum. Nothing is ever clipped
           and nothing is ever unreachable. -->
      <div class="ctrl-utilities">
        <!-- Rundown Safety Lock Button -->
        <button
          class="ctrl-btn lock-toggle-btn"
          :class="{ 'is-locked': rundown.isRundownLocked }"
          :aria-pressed="rundown.isRundownLocked"
          @click="rundown.toggleRundownLock()"
          :title="rundown.isRundownLocked ? 'Rundown Locked: Accidental edits are protected. Click to Unlock.' : 'Rundown Unlocked: Free to edit, reorder, and delete items. Click to Lock.'"
        >
          <AppIcon class="lock-icon" :name="rundown.isRundownLocked ? 'lock' : 'unlock'" :size="14" />
          <span class="lock-text">{{ rundown.isRundownLocked ? 'LOCKED' : 'UNLOCKED' }}</span>
        </button>

        <span class="ctrl-section ctrl-ingest" :title="ingestorStatus.isIngestorOnline ? 'Ingestor reachable' : 'Ingestor unreachable'">
          <IngestorStatusLight />
          <span class="ctrl-label">INGEST</span>
        </span>

        <button
          class="ctrl-btn ctrl-settings-btn"
          aria-label="Settings"
          title="Settings"
          @pointerenter="preloadSettingsModal()"
          @focus="preloadSettingsModal()"
          @click="showSettings = true"
        >
          <AppIcon class="ctrl-btn-glyph" name="settings" :size="16" />
          <span class="ctrl-btn-label">Settings</span>
        </button>
      </div>

      <!-- The last rung. The trigger is only in the flow once the utilities
           have left it, so it costs nothing at any wider step. -->
      <div v-if="isControlBarCollapsed" class="ctrl-more-wrap">
        <button
          class="ctrl-btn ctrl-more-btn"
          :class="{ 'is-open': showControlBarMore }"
          aria-label="More controls"
          title="More controls"
          :aria-expanded="showControlBarMore"
          data-testid="control-bar-more"
          @click.stop="toggleControlBarMore"
        >
          <AppIcon class="ctrl-btn-glyph" name="more-horizontal" :size="16" />
        </button>
        <div v-if="showControlBarMore" class="ctrl-more-menu popover-surface" role="menu" @click.stop>
          <button class="popover-item" role="menuitem" @click="rundown.toggleRundownLock()">
            <AppIcon :name="rundown.isRundownLocked ? 'lock' : 'unlock'" :size="14" />
            <span>Rundown</span>
            <span class="popover-item-badge">{{ rundown.isRundownLocked ? 'LOCKED' : 'UNLOCKED' }}</span>
          </button>
          <div class="popover-divider" role="separator" />
          <div class="popover-item is-static">
            <IngestorStatusLight />
            <span>Ingestor</span>
            <span class="popover-item-badge">{{ ingestorStatus.isIngestorOnline ? 'ONLINE' : 'OFFLINE' }}</span>
          </div>
          <div class="popover-divider" role="separator" />
          <button
            class="popover-item"
            role="menuitem"
            @pointerenter="preloadSettingsModal()"
            @click="showControlBarMore = false; showSettings = true"
          >
            <AppIcon name="settings" :size="14" />
            <span>Settings…</span>
          </button>
          <button class="popover-item" role="menuitem" @click="showControlBarMore = false; toggleQuickGuide()">
            <AppIcon name="help" :size="14" />
            <span>Quick guide</span>
          </button>
          <button class="popover-item" role="menuitem" @click="showControlBarMore = false; toggleProductInfo()">
            <AppIcon name="info" :size="14" />
            <span>About {{ APP_NAME }}</span>
          </button>
        </div>
      </div>

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
    <SettingsModal v-if="showSettings" :is-open="showSettings" @close="showSettings = false" />
    <CommandPaletteModal :is-open="activeModalName === 'command-palette'" @close="closeCommandPalette" />

    <!-- UI §3.2: one toast host for the whole app. -->
    <ToastHost />
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
/* UI F-01: `flex-wrap: nowrap` is load-bearing. The shell's `ctrl` grid row is
   a fixed 58px and the shell is `overflow: hidden`, so any wrapped second row
   is clipped out of reach. Collapse tiers below shed content instead. */
.control-bar {
  grid-area: ctrl;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  margin-top: 5px;
  position: relative;
  min-width: 0;
  overflow: visible;
  /* §7.1: the bar is a header strip, not a pane of glass over nothing. The
     `backdrop-filter` that `.glass-panel` applied cost a full-viewport blur
     every frame for a surface with the page background behind it. */
  background: var(--surface-panel-header);
  border-top: 1px solid var(--border-medium);
  box-shadow: inset 0 1px 0 var(--highlight-top);
}

.ctrl-btn-glyph { flex-shrink:0; }
.ctrl-btn-label-short { display:none; }

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
  font-size:var(--fs-xs);
  font-weight:700;
  cursor:pointer;
}

.panel-toggle-btn.is-active {
  color:var(--text-primary);
  border-color:color-mix(in srgb, var(--accent-blue) 40%, transparent);
  background:color-mix(in srgb, var(--accent-blue) 12%, var(--bg-secondary));
}

.ctrl-section    { display:flex; align-items:center; gap:6px; }
.ctrl-label      { font-size:var(--fs-xs); color:var(--text-muted); letter-spacing:0.5px; font-weight:700; white-space:nowrap; }
.ctrl-ingest { display:inline-flex; align-items:center; gap:4px; }
.ctrl-ingest .ctrl-label { font-size: var(--fs-xs); }
.ctrl-value      {
  font-size:var(--fs-md); color:var(--text-primary); font-weight:600; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; max-width:260px;
}
.ctrl-divider    { width:1px; height:26px; background:var(--border-subtle); flex-shrink:0; }
.ctrl-play-wrap  { flex:0 0 auto; }
.take-failure { display:flex; align-items:center; gap:5px; color:var(--accent-red); font-size:var(--fs-xs); font-weight:700; white-space:nowrap; }

.ctrl-btn {
  background:var(--bg-hover); border:1px solid var(--border-medium);
  color:var(--text-primary); border-radius:6px; cursor:pointer;
  padding:6px 14px; font-size:var(--fs-sm); font-weight:600; white-space:nowrap;
  display:inline-flex; align-items:center; gap:6px;
  /* PERF: explicit property list, never `all`. */
  transition:background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ctrl-btn:hover:not(:disabled) { background:color-mix(in srgb, var(--accent-blue) 12%, var(--bg-hover)); border-color:var(--border-strong); }
.ctrl-btn:disabled { opacity:0.35; cursor:not-allowed; }

.btn-play {
  background:var(--accent-cyan); border-color:var(--accent-cyan);
  color:var(--text-on-accent); font-size:var(--fs-md); font-weight:800;
  padding:6px 20px; letter-spacing:1px;
  box-shadow:0 0 12px color-mix(in srgb, var(--accent-cyan) 35%, transparent);
}
.btn-play:hover:not(:disabled) {
  background:color-mix(in srgb, var(--accent-cyan) 88%, var(--text-primary));
  border-color:color-mix(in srgb, var(--accent-cyan) 88%, var(--text-primary));
  box-shadow:0 0 18px color-mix(in srgb, var(--accent-cyan) 60%, transparent);
}

.btn-stop {
  position: relative;
  background:var(--status-onair); border-color:var(--status-onair);
  color:var(--text-on-danger); font-size:var(--fs-md); font-weight:800;
  padding:6px 20px; letter-spacing:1px;
  box-shadow:0 0 12px color-mix(in srgb, var(--status-onair) 40%, transparent);
}
/* PERF F-22: STOP is visible for the whole playing session; its glow pulse
   used to repaint the button every frame (box-shadow keyframe). The peak
   glow now sits on an overlay whose opacity pulses on the compositor. */
.btn-stop::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  box-shadow: 0 0 28px color-mix(in srgb, var(--status-onair) 80%, transparent);
  animation: pulse-stop 1.5s ease-in-out infinite;
  will-change: opacity;
}
@keyframes pulse-stop {
  0%,100% { opacity: 0; }
  50%      { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .btn-stop::after,
  .btn-live-now,
  .btn-live-active,
  .btn-live-armed,
  .ctrl-nextup-dock.is-imminent,
  .nextup-header,
  .status-dot.pulse,
  .halt-icon {
    animation: none !important;
  }
  .btn-stop::after { opacity: 0.5; }
}

.btn-live {
  background:color-mix(in srgb, var(--status-onair) 20%, transparent);
  border-color:color-mix(in srgb, var(--status-onair) 50%, transparent);
  color:var(--status-onair);
}

/* UI F-02: the resting CUT TO LIVE pill is a tint, so its label must be the
   status colour, not white — white on a 10% tint was unreadable in the light
   theme. Only the filled armed/active states carry --text-on-danger. */
.btn-live-now {
  position:relative;
  background:color-mix(in srgb, var(--status-onair) 12%, var(--bg-hover));
  border-color:var(--status-onair);
  color:var(--status-onair); font-size:var(--fs-sm); font-weight:800;
  padding:5px 12px; letter-spacing:0.5px; margin-left:0;
}
/* PERF: the pill is on screen for the whole session, so the breathing glow
   lives on an overlay whose opacity animates on the compositor rather than a
   box-shadow keyframe that repaints the button every frame. */
.btn-live-now::after {
  content:'';
  position:absolute;
  inset:0;
  border-radius:inherit;
  pointer-events:none;
  box-shadow:0 0 16px color-mix(in srgb, var(--status-onair) 50%, transparent);
  animation:pulse-live-glow 2s ease-in-out infinite;
  will-change:opacity;
}
.btn-live-now:hover:not(:disabled) {
  background:color-mix(in srgb, var(--status-onair) 26%, var(--bg-hover));
  border-color:var(--status-onair);
}

.btn-live-active {
  position:relative;
  background:var(--status-onair); border-color:var(--status-onair);
  color:var(--text-on-danger); font-size:var(--fs-sm); font-weight:800;
  padding:5px 12px; letter-spacing:0.5px; margin-left:0;
}
.btn-live-active::after {
  content:'';
  position:absolute;
  inset:0;
  border-radius:inherit;
  pointer-events:none;
  box-shadow:0 0 24px color-mix(in srgb, var(--status-onair) 90%, transparent);
  animation:pulse-live-glow 1s ease-in-out infinite;
  will-change:opacity;
}
.btn-live-active:hover:not(:disabled) {
  background:color-mix(in srgb, var(--status-onair) 85%, var(--text-primary));
}

@keyframes pulse-live-glow {
  0%,100% { opacity:0.25; }
  50%     { opacity:1; }
}

.lock-toggle-btn {
  display:flex;
  align-items:center;
  gap:6px;
  font-weight:700;
  font-size:var(--fs-xs);
  padding:5px 12px;
  border-radius:6px;
  transition:all 0.15s;
  user-select:none;
  background:color-mix(in srgb, var(--status-ready) 12%, transparent);
  border:1px solid color-mix(in srgb, var(--status-ready) 40%, transparent);
  color:var(--status-ready);
}
.lock-toggle-btn:hover:not(:disabled) {
  background:color-mix(in srgb, var(--status-ready) 22%, transparent);
  border-color:color-mix(in srgb, var(--status-ready) 60%, transparent);
}
.lock-toggle-btn.is-locked {
  background:color-mix(in srgb, var(--status-error) 15%, transparent);
  border-color:color-mix(in srgb, var(--status-error) 50%, transparent);
  color:var(--status-error);
}
.lock-toggle-btn.is-locked:hover:not(:disabled) {
  background:color-mix(in srgb, var(--status-error) 25%, transparent);
  border-color:color-mix(in srgb, var(--status-error) 70%, transparent);
}

/* §7.1: the timecode sits in a well, so the one number that is read from
   across the room has an edge of its own rather than floating on the strip. */
.timecode {
  font-size: var(--fs-tc-hero);
  font-weight: 700;
  letter-spacing: 2.5px;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  color: var(--accent-blue);
  text-shadow: 0 0 14px color-mix(in srgb, var(--accent-blue) 40%, transparent);
  line-height: 1;
  padding: 4px var(--space-3);
  border-radius: var(--radius-md);
  background: var(--surface-inset);
  box-shadow: var(--shadow-inset);
}

/* A heavier rule than .ctrl-divider: specificity, not !important. */
.control-bar .ctrl-divider.barrier-fence-divider {
  width: 2px;
  height: 32px;
  background: var(--border-strong);
  margin: 0 10px;
}

.ctrl-routing-fence {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid color-mix(in srgb, var(--status-error) 35%, transparent);
  border-radius: 6px;
  padding: 2px 8px;
  background: color-mix(in srgb, var(--status-error) 6%, transparent);
}

.routing-fence-label {
  font-size: var(--fs-xs);
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--status-error);
  white-space: nowrap;
}

/* Armed is the one state that must read as "about to cut": a filled warning
   surface, not a tint. The `!important`s are gone — the selector is more
   specific than .btn-live-now on its own. */
.control-bar .btn-live-now.btn-live-armed {
  background: var(--status-armed);
  border-color: var(--status-armed);
  color: var(--text-on-warning);
}
/* §7: the arm-window ring. A conic sweep driven by --arm-progress, which the
   script updates every 100ms. It sits on its own layer so the button below it
   never repaints. */
.arm-ring {
  position: absolute;
  inset: -3px;
  border-radius: inherit;
  pointer-events: none;
  background: conic-gradient(
    var(--status-armed) calc(var(--arm-progress, 0) * 360deg),
    transparent 0
  );
  -webkit-mask:
    radial-gradient(farthest-side, transparent calc(100% - 2px), black calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), black calc(100% - 2px));
  opacity: 0.9;
}

.control-bar .btn-live-now.btn-live-armed::after {
  box-shadow: 0 0 22px color-mix(in srgb, var(--status-armed) 90%, transparent);
  animation: pulse-live-glow 0.6s ease-in-out infinite;
}

/* §7 group 1: a status readout (not a control) beside its own action. */
.ctrl-engine {
  gap: 8px;
}

.conn-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: default;
}

.conn-action-btn {
  font-size: var(--fs-xs);
  padding: 5px 11px;
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
  box-shadow: var(--shadow-3);
  z-index: var(--z-popover);
}

.conn-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.conn-popover-title {
  font-size: var(--fs-sm);
  font-weight: 700;
  color: var(--text-primary);
}

.conn-popover-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--fs-md);
}

.conn-popover-body {
  font-size: var(--fs-xs);
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
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-subtle);
  min-width: 140px;
  max-width: 195px;
  height: 32px;
  box-sizing: border-box;
  /* PERF F-23: `all` also animated the dock width every time the label changed. */
  transition: border-color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
}

.ctrl-nextup-dock.is-imminent {
  border-color: var(--status-cued);
  background: color-mix(in srgb, var(--status-cued) 15%, transparent);
  animation: pulse-imminent 1s infinite alternate;
}

@keyframes pulse-imminent {
  0% { opacity: 0.35; }
  100% { opacity: 1; }
}

.nextup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  line-height: 1;
}

.nextup-kicker {
  font-size: var(--fs-xs);
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

.nextup-imminent-pill {
  font-size: var(--fs-xs);
  font-weight: 800;
  color: var(--text-on-warning);
  background: var(--status-armed);
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
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 130px;
}

.nextup-duration-pill {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  font-weight: 700;
  color: var(--accent-blue);
  font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
  padding: 0 4px;
  border-radius: 3px;
  white-space: nowrap;
}

.brand-play-icon {
  fill: var(--accent-purple);
}
.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--border-strong);
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
}
.status-dot.connected,
.status-dot.tone-ready {
  background: var(--status-ready);
  box-shadow: 0 0 8px color-mix(in srgb, var(--status-ready) 60%, transparent);
}
.status-dot.tone-warning {
  background: var(--status-warning);
  box-shadow: 0 0 8px color-mix(in srgb, var(--status-warning) 60%, transparent);
}
.status-dot.tone-error {
  background: var(--status-error);
  box-shadow: 0 0 8px color-mix(in srgb, var(--status-error) 70%, transparent);
}
.status-dot.tone-processing {
  background: var(--status-processing);
  box-shadow: 0 0 8px color-mix(in srgb, var(--status-processing) 70%, transparent);
}
.status-dot.tone-idle {
  background: var(--accent-purple);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent-purple) 60%, transparent);
}
.status-dot.pulse {
  animation: status-dot-pulse 1.4s ease-in-out infinite;
}
@keyframes status-dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.85); }
}

.monitor-badge {
  font-size: var(--fs-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent-purple) 20%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-purple) 50%, transparent);
  color: var(--accent-purple);
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
  transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
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
  border-radius: var(--radius-pill);
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--accent-purple) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-purple) 45%, transparent);
  color: var(--accent-purple);
}

.ctrl-meta-brand:hover,
.ctrl-meta-brand.is-open {
  background: color-mix(in srgb, var(--accent-purple) 28%, transparent);
  border-color: color-mix(in srgb, var(--accent-purple) 75%, transparent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent-purple) 45%, transparent);
  color: color-mix(in srgb, var(--accent-purple) 70%, var(--text-primary));
}

.ctrl-meta-brand:hover .brand-play-icon,
.ctrl-meta-brand.is-open .brand-play-icon {
  fill: color-mix(in srgb, var(--accent-purple) 70%, var(--text-primary));
}

.ctrl-meta-help {
  width: var(--btn-h-compact, 30px);
  padding: 0;
  font-size: var(--fs-lg);
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
  box-shadow: var(--shadow-3);
  backdrop-filter: blur(18px);
  z-index: var(--z-popover);
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
  font-size: var(--fs-xs);
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.ctrl-meta-title {
  margin-top: 4px;
  font-size: var(--fs-lg);
  font-weight: 700;
  color: var(--text-primary);
}

.ctrl-meta-copy {
  margin: 10px 0 0;
  font-size: var(--fs-sm);
  line-height: 1.45;
  color: var(--text-secondary);
}

.ctrl-meta-section-label {
  margin-top: 12px;
  font-size: var(--fs-xs);
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
  font-size: var(--fs-sm);
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
  font-size: var(--fs-lg);
}

.ctrl-meta-close:hover {
  background: var(--border-medium);
  color: var(--text-primary);
}

/* ---------------------------------------------------------------------------
   §4.2 — the collapse ladder.

   Each step is cumulative: `:is([data-step='3'], [data-step='4'], …)` reads as
   "at step 3 or tighter". Nothing here is a media query; the step comes from
   `fitControlBar()`, which measured whether the content actually fits.

     0  everything
     1  ROUTING label, INGEST word, thinner dividers
     2  utilities become icon-only
     3  long button labels become their short forms
     4  the NEXT UP dock shrinks
     5  utilities fold into one More popover

   PLAY / STOP, the routing fence buttons and the timecode never shrink. They
   are what the bar is for.
   --------------------------------------------------------------------------- */

/* Every direct child reports its natural width, or `scrollWidth` would report
   the shrunk-to-fit width and the loop would think everything fits. */
.control-bar > * {
  flex-shrink: 0;
}

/* Step 1 ------------------------------------------------------------------ */
.control-bar:is([data-step='1'], [data-step='2'], [data-step='3'], [data-step='4'], [data-step='5']) .routing-fence-label {
  display: none;
}
.control-bar:is([data-step='1'], [data-step='2'], [data-step='3'], [data-step='4'], [data-step='5']) .ctrl-ingest .ctrl-label {
  display: none;
}
.control-bar:is([data-step='1'], [data-step='2'], [data-step='3'], [data-step='4'], [data-step='5']) .ctrl-divider {
  margin: 0 2px;
}

/* Step 2: the utilities keep their hit areas and lose their words. The lock's
   glyph already changes shape between states (§7.5), so nothing is lost. */
.control-bar:is([data-step='2'], [data-step='3'], [data-step='4'], [data-step='5']) .lock-text,
.control-bar:is([data-step='2'], [data-step='3'], [data-step='4'], [data-step='5']) .ctrl-settings-btn .ctrl-btn-label {
  display: none;
}
.control-bar:is([data-step='2'], [data-step='3'], [data-step='4'], [data-step='5']) .ctrl-settings-btn,
.control-bar:is([data-step='2'], [data-step='3'], [data-step='4'], [data-step='5']) .lock-toggle-btn {
  padding-inline: 10px;
}

/* Step 3: long labels become their short forms. The engine action keeps its
   glyph and its tooltip; the dot beside it is what actually says "connected". */
.control-bar:is([data-step='3'], [data-step='4'], [data-step='5']) .conn-action-btn .ctrl-btn-label {
  display: none;
}
.control-bar:is([data-step='3'], [data-step='4'], [data-step='5']) .conn-action-btn {
  padding-inline: 10px;
}

.control-bar:is([data-step='3'], [data-step='4'], [data-step='5']) .btn-live-now .ctrl-btn-label,
.control-bar:is([data-step='3'], [data-step='4'], [data-step='5']) .btn-live-active .ctrl-btn-label {
  display: none;
}
.control-bar:is([data-step='3'], [data-step='4'], [data-step='5']) .btn-live-now .ctrl-btn-label-short,
.control-bar:is([data-step='3'], [data-step='4'], [data-step='5']) .btn-live-active .ctrl-btn-label-short {
  display: inline;
}
.control-bar:is([data-step='3'], [data-step='4'], [data-step='5']) .ctrl-divider {
  display: none;
}

/* Step 4: the dock is a readout, so it yields before any control does. */
.control-bar:is([data-step='4'], [data-step='5']) .ctrl-nextup-dock {
  min-width: 96px;
  max-width: 128px;
}
.control-bar:is([data-step='4'], [data-step='5']) .nextup-title {
  max-width: 88px;
}
.control-bar:is([data-step='4'], [data-step='5']) .nextup-duration-pill {
  display: none;
}

/* Step 5: one popover instead of three controls -- and the brand and help
   buttons go with them, because More already holds About and Quick guide. The
   dock itself stays in the tree: it is what the popovers are positioned
   against, and it is what the outside-click handler tests. */
.control-bar[data-step='5'] .ctrl-utilities,
.control-bar[data-step='5'] .ctrl-meta-brand,
.control-bar[data-step='5'] .ctrl-meta-help {
  display: none;
}
.control-bar[data-step='5'] .ctrl-meta-dock {
  gap: 0;
}

/* The popovers anchor to the right edge of the dock by default; at the tight
   steps the dock can sit close enough to the left that they would overflow. */
.control-bar:is([data-step='3'], [data-step='4'], [data-step='5']) .ctrl-meta-popover,
.control-bar:is([data-step='3'], [data-step='4'], [data-step='5']) .ctrl-meta-popover-guide {
  width: min(380px, calc(100vw - 24px));
}

.ctrl-utilities {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ctrl-more-wrap {
  position: relative;
}
.ctrl-more-btn.is-open {
  background: var(--bg-surface-elevated);
  color: var(--text-primary);
}
.ctrl-more-menu {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  right: 0;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: var(--z-popover);
}
/* A status line, not a control: it reads the same as the rows around it but
   does nothing when clicked, so it is not a button. */
.ctrl-more-menu .popover-item.is-static {
  cursor: default;
}
.popover-item-badge {
  margin-left: auto;
  padding: 1px var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  font-weight: 800;
  letter-spacing: 0.08em;
}

.halt-banner {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-banner);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  background: color-mix(in srgb, var(--status-error) 15%, var(--bg-surface));
  border: 1px solid color-mix(in srgb, var(--status-error) 45%, transparent);
  backdrop-filter: blur(12px);
  border-radius: 8px;
  box-shadow: var(--shadow-2);
  color: var(--text-primary);
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
  background: color-mix(in srgb, var(--status-warning) 16%, var(--bg-surface));
  border-color: color-mix(in srgb, var(--status-warning) 50%, transparent);
  box-shadow: var(--shadow-2);
}

.fault-toasts {
  position: absolute;
  right: 16px;
  bottom: 92px;
  z-index: var(--z-toast);
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
  background: color-mix(in srgb, var(--status-error) 14%, var(--bg-surface));
  border: 1px solid color-mix(in srgb, var(--status-error) 40%, transparent);
  backdrop-filter: blur(10px);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  font-family: Inter, system-ui, sans-serif;
  pointer-events: auto;
  animation: slideDownFade 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.fault-source {
  font-weight: 700;
  opacity: 0.85;
  text-transform: uppercase;
  font-size: var(--fs-xs);
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
  color: var(--status-error);
  animation: pulseWarning 1.5s infinite ease-in-out;
}

.persist-banner .halt-icon {
  color: var(--status-warning);
}

.halt-text {
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.halt-dismiss-btn {
  background: var(--bg-hover);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  padding: 6px 12px;
  font-size: var(--fs-xs);
  font-weight: 700;
  cursor: pointer;
  transition: background 0.2s, transform 0.1s;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.halt-dismiss-btn:hover {
  background: var(--bg-active);
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
  50% { transform: scale(1.15); }
}

@media (prefers-reduced-motion: reduce) {
  .arm-ring {
    /* The sweep is a state readout, not decoration, so it stays -- but it is
       driven by a property update, not an animation, so there is nothing to
       disable here beyond documenting the intent. */
    opacity: 0.9;
  }
}
</style>
