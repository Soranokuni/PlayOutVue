import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { computed, ref } from 'vue';

export type CasparProcessState =
  | 'unconfigured'
  | 'stopped'
  | 'starting'
  | 'operational'
  | 'external_running'
  | 'disconnected'
  | 'crashed';

export type InstanceRole = 'primary' | 'monitor';

export interface CasparProcessStatus {
  state: CasparProcessState;
  role: InstanceRole;
  pid: number | null;
  executablePath: string;
  resolvedExecutablePath: string | null;
  workingDir: string | null;
  configFilename: string;
  exitCode: number | null;
  lastError: string | null;
  amcpPort: number;
  isPortOpen: boolean;
  keepAliveOnExit: boolean;
  autoRelaunchOnCrash: boolean;
  circuitBreakerTripped: boolean;
  canControl: boolean;
}

export interface CasparValidationInfo {
  isValid: boolean;
  resolvedPath: string;
  parentDir: string;
  configExists: boolean;
  configPath: string | null;
  message: string;
}

export const processStatus = ref<CasparProcessStatus | null>(null);
export const isStarting = ref(false);
export const isStopping = ref(false);

export const isPrimaryInstance = computed(() => {
  return processStatus.value?.role !== 'monitor';
});

export const processState = computed<CasparProcessState>(() => {
  return (processStatus.value?.state as CasparProcessState) || 'unconfigured';
});

let unlistenStateChanged: UnlistenFn | null = null;

/**
 * Fetch the latest process status from the Rust supervisor.
 */
export async function refreshProcessStatus(): Promise<CasparProcessStatus | null> {
  try {
    const status = await invoke<CasparProcessStatus>('caspar_process_get_status');
    processStatus.value = status;
    processStateListeners.forEach((fn) => {
      try { fn(status); } catch (e) { console.warn('[CasparProcess] Listener error:', e); }
    });
    return status;
  } catch (err) {
    console.warn('[CasparProcess] Failed to query status:', err);
    return null;
  }
}

/**
 * Validate a candidate CasparCG executable binary path.
 */
export async function validateCasparExecutablePath(path: string): Promise<CasparValidationInfo> {
  return invoke<CasparValidationInfo>('caspar_process_validate_path', { path });
}

/**
 * Start the CasparCG server process.
 */
export async function startCasparServer(): Promise<void> {
  if (isStarting.value) return;
  isStarting.value = true;
  try {
    await invoke('caspar_process_start');
    await refreshProcessStatus();
  } finally {
    isStarting.value = false;
  }
}

/**
 * Stop the CasparCG server process.
 */
export async function stopCasparServer(force = false): Promise<void> {
  if (isStopping.value) return;
  isStopping.value = true;
  try {
    await invoke('caspar_process_stop', { force });
    await refreshProcessStatus();
  } finally {
    isStopping.value = false;
  }
}

/**
 * Restart the CasparCG server process.
 */
export async function restartCasparServer(): Promise<void> {
  isStarting.value = true;
  try {
    await invoke('caspar_process_restart');
    await refreshProcessStatus();
  } finally {
    isStarting.value = false;
  }
}

export type ProcessStateListener = (status: CasparProcessStatus) => void;
const processStateListeners = new Set<ProcessStateListener>();

/**
 * Subscribe to CasparCG process state changes.
 */
export function onCasparProcessStateChange(listener: ProcessStateListener): () => void {
  processStateListeners.add(listener);
  if (processStatus.value) {
    try {
      listener(processStatus.value);
    } catch (e) {
      console.warn('[CasparProcess] Listener error on subscribe:', e);
    }
  }
  return () => {
    processStateListeners.delete(listener);
  };
}

/**
 * Register listener for Tauri lifecycle events.
 */
export async function initCasparProcessListener(): Promise<() => void> {
  if (unlistenStateChanged) {
    return unlistenStateChanged;
  }

  try {
    unlistenStateChanged = await listen<CasparProcessStatus | undefined>(
      'caspar://process-state-changed',
      (event) => {
        if (event.payload && typeof event.payload === 'object' && 'state' in event.payload) {
          const status = event.payload as CasparProcessStatus;
          processStatus.value = status;
          processStateListeners.forEach((fn) => {
            try { fn(status); } catch (e) { console.warn('[CasparProcess] Listener error:', e); }
          });
        } else {
          refreshProcessStatus().then((status) => {
            if (status) {
              processStateListeners.forEach((fn) => {
                try { fn(status); } catch (e) { console.warn('[CasparProcess] Listener error:', e); }
              });
            }
          }).catch(() => {});
        }
      }
    );
  } catch (err) {
    console.warn('[CasparProcess] Failed to bind event listener:', err);
  }

  const initialStatus = await refreshProcessStatus();
  if (initialStatus) {
    processStateListeners.forEach((fn) => {
      try { fn(initialStatus); } catch (e) { console.warn('[CasparProcess] Initial listener error:', e); }
    });
  }

  return () => {
    if (unlistenStateChanged) {
      unlistenStateChanged();
      unlistenStateChanged = null;
    }
  };
}
