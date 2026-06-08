<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const emit = defineEmits<{
    (event: 'close'): void;
}>();

interface IngestServiceStatus {
    running: boolean;
    pid: number | null;
    executable: string;
    apiBaseUrl: string;
    port: number;
    destinationPath: string;
    watchFolderPath: string | null;
    autoTrimBlack: boolean;
    maxConcurrency: number;
    ffmpegThreads: number;
    pollSecs: number;
    settleSecs: number;
    includeExtensions: string;
    excludeExtensions: string;
    duplicatePolicy: string;
    startedAtMs: number;
}

  type ResourcePreset = 'low' | 'normal' | 'high';

interface IngestJobAccepted {
    jobId: string;
}

interface IngestJobStatus {
    id: string;
    stage: string;
    message: string;
    progress: number;
    done: boolean;
    success: boolean;
    error?: string;
}

const destinationPath = useStorage('ingestShell.destinationPath', 'C:/Media/Ingested');
const watchFolderPath = useStorage('ingestShell.watchFolderPath', 'C:/Media/Watch');
const autoTrimBlack = useStorage('ingestShell.autoTrimBlack', true);
const port = useStorage('ingestShell.port', 8088);
const maxConcurrency = useStorage('ingestShell.maxConcurrency', 2);
const ffmpegThreads = useStorage('ingestShell.ffmpegThreads', 2);
const pollSecs = useStorage('ingestShell.pollSecs', 5);
const settleSecs = useStorage('ingestShell.settleSecs', 5);
const includeExtensions = useStorage('ingestShell.includeExtensions', '');
const excludeExtensions = useStorage('ingestShell.excludeExtensions', '');
const duplicatePolicy = useStorage('ingestShell.duplicatePolicy', 'skip');
const resourcePreset = useStorage<ResourcePreset>('ingestShell.resourcePreset', 'normal');

const ingestFilePath = ref('');
const ingestAutoTrim = ref(true);
const serviceStatus = ref<IngestServiceStatus | null>(null);
const jobStatus = ref<IngestJobStatus | null>(null);
const jobId = ref('');
const busy = ref(false);
const statusMessage = ref('Idle');

let statusTimer: ReturnType<typeof setInterval> | null = null;
let jobTimer: ReturnType<typeof setInterval> | null = null;
let unlistenClose: (() => void) | null = null;

const running = computed(() => !!serviceStatus.value?.running);

const resourceSlider = computed({
  get: () => ({ low: 1, normal: 2, high: 3 }[resourcePreset.value] || 2),
  set: (value: number) => {
    resourcePreset.value = value <= 1 ? 'low' : value >= 3 ? 'high' : 'normal';
  }
});

watch(resourcePreset, (preset) => {
  if (preset === 'low') {
    maxConcurrency.value = 1;
    ffmpegThreads.value = 1;
  } else if (preset === 'high') {
    maxConcurrency.value = 4;
    ffmpegThreads.value = 4;
  } else {
    maxConcurrency.value = 2;
    ffmpegThreads.value = 2;
  }
}, { immediate: true });

const refreshStatus = async () => {
    try {
        const status = await invoke<IngestServiceStatus>('get_ingestd_service_status');
        serviceStatus.value = status;
        if (status.running) {
            statusMessage.value = `Service running on ${status.apiBaseUrl}`;
        } else {
            statusMessage.value = 'Service stopped';
        }
    } catch (error) {
        statusMessage.value = `Failed to read service status: ${error}`;
    }
};

const startService = async () => {
    busy.value = true;
    statusMessage.value = 'Starting ingest service...';
    try {
        const status = await invoke<IngestServiceStatus>('start_ingestd_service', {
            options: {
                destinationPath: destinationPath.value,
                watchFolderPath: watchFolderPath.value,
                autoTrimBlack: autoTrimBlack.value,
                port: Number(port.value) || 8088,
                maxConcurrency: Number(maxConcurrency.value) || 1,
                ffmpegThreads: Number(ffmpegThreads.value) || 1,
                pollSecs: Number(pollSecs.value) || 1,
                settleSecs: Number(settleSecs.value) || 1,
                includeExtensions: includeExtensions.value,
                excludeExtensions: excludeExtensions.value,
                duplicatePolicy: duplicatePolicy.value
            }
        });
        serviceStatus.value = status;
        statusMessage.value = `Service started at ${status.apiBaseUrl}`;
    } catch (error) {
        statusMessage.value = `Start failed: ${error}`;
    } finally {
        busy.value = false;
    }
};

const stopService = async () => {
    busy.value = true;
    statusMessage.value = 'Stopping ingest service...';
    try {
        const status = await invoke<IngestServiceStatus>('stop_ingestd_service');
        serviceStatus.value = status;
        statusMessage.value = 'Service stopped';
        jobStatus.value = null;
        jobId.value = '';
    } catch (error) {
        statusMessage.value = `Stop failed: ${error}`;
    } finally {
        busy.value = false;
    }
};

const pollJobStatus = async () => {
    if (!running.value || !jobId.value || !serviceStatus.value?.apiBaseUrl) return;

    try {
        const response = await fetch(`${serviceStatus.value.apiBaseUrl}/api/ingest/${encodeURIComponent(jobId.value)}`);
        if (!response.ok) return;
        const payload = await response.json() as IngestJobStatus;
        jobStatus.value = payload;
        statusMessage.value = `${payload.stage} ${payload.progress.toFixed(0)}%`;
        if (payload.done && jobTimer) {
            clearInterval(jobTimer);
            jobTimer = null;
        }
    } catch (error) {
        statusMessage.value = `Job polling failed: ${error}`;
    }
};

const startIngest = async () => {
    if (!running.value || !serviceStatus.value?.apiBaseUrl) {
        statusMessage.value = 'Start the service first.';
        return;
    }

    if (!ingestFilePath.value.trim()) {
        statusMessage.value = 'Input file path is required.';
        return;
    }

    busy.value = true;
    statusMessage.value = 'Queueing ingest job...';
    try {
        const response = await fetch(`${serviceStatus.value.apiBaseUrl}/api/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filePath: ingestFilePath.value.trim(),
                autoTrim: ingestAutoTrim.value
            })
        });

        if (!response.ok) {
            const message = await response.text();
            throw new Error(message || `HTTP ${response.status}`);
        }

        const payload = await response.json() as IngestJobAccepted;
        jobId.value = payload.jobId;
        jobStatus.value = {
            id: payload.jobId,
            stage: 'Queued',
            message: 'Queued',
            progress: 0,
            done: false,
            success: false
        };

        if (jobTimer) clearInterval(jobTimer);
        jobTimer = setInterval(() => {
            pollJobStatus().catch(() => {});
        }, 1200);

        await pollJobStatus();
    } catch (error) {
        statusMessage.value = `Ingest request failed: ${error}`;
    } finally {
        busy.value = false;
    }
};

const handleCloseRequest = async (event: any) => {
    event.preventDefault();
    const keepRunning = window.confirm('Keep ingest service running in tray?\nOK = Minimize to tray\nCancel = Exit application');

    if (keepRunning) {
        await invoke('ingest_shell_minimize_to_tray');
    } else {
        await invoke('ingest_shell_exit_app');
    }
};

onMounted(async () => {
    await refreshStatus();
    statusTimer = setInterval(() => {
        refreshStatus().catch(() => {});
    }, 2500);

    const appWindow = getCurrentWindow();
    unlistenClose = await appWindow.onCloseRequested(handleCloseRequest);
});

onUnmounted(() => {
    if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
    }
    if (jobTimer) {
        clearInterval(jobTimer);
        jobTimer = null;
    }
    if (unlistenClose) {
        unlistenClose();
        unlistenClose = null;
    }
});
</script>

<template>
  <section class="ingest-shell">
    <header class="ingest-header glass-panel">
      <div>
        <h2>Ingest Service Shell</h2>
        <p>Standalone ingest supervisor for watchfolder, API ingest, and resource control.</p>
      </div>
      <div class="ingest-actions">
        <button class="btn" @click="startService" :disabled="busy || running">Start Service</button>
        <button class="btn" @click="stopService" :disabled="busy || !running">Stop Service</button>
        <button class="btn secondary" @click="$emit('close')">Back to Playout</button>
      </div>
    </header>

    <div class="ingest-grid">
      <article class="glass-panel card">
        <h3>Service Options</h3>
        <label>Destination Path<input v-model="destinationPath" type="text"></label>
        <label>Watchfolder Path<input v-model="watchFolderPath" type="text"></label>

        <div class="row">
          <label>Port<input v-model.number="port" type="number" min="1024" max="65535"></label>
          <label>Auto Trim Black<input v-model="autoTrimBlack" type="checkbox"></label>
        </div>

        <div class="row">
          <label>Resource Preset
            <input v-model.number="resourceSlider" type="range" min="1" max="3" step="1">
          </label>
          <span>{{ resourcePreset }}</span>
        </div>

        <div class="row">
          <label>Max Concurrent Jobs<input v-model.number="maxConcurrency" type="range" min="1" max="8"></label>
          <span>{{ maxConcurrency }}</span>
        </div>

        <div class="row">
          <label>FFmpeg Threads / Job<input v-model.number="ffmpegThreads" type="range" min="1" max="8"></label>
          <span>{{ ffmpegThreads }}</span>
        </div>

        <div class="row">
          <label>Poll Seconds<input v-model.number="pollSecs" type="number" min="1" max="60"></label>
          <label>Settle Seconds<input v-model.number="settleSecs" type="number" min="1" max="120"></label>
        </div>

        <label>Include Extensions (csv)<input v-model="includeExtensions" type="text" placeholder="mov,mxf,mp4"></label>
        <label>Exclude Extensions (csv)<input v-model="excludeExtensions" type="text" placeholder="tmp,part"></label>

        <label>Duplicate Policy
          <select v-model="duplicatePolicy">
            <option value="skip">Skip</option>
            <option value="overwrite">Overwrite</option>
            <option value="rename">Rename</option>
          </select>
        </label>
      </article>

      <article class="glass-panel card">
        <h3>Quick Ingest</h3>
        <label>File Path<input v-model="ingestFilePath" type="text" placeholder="C:/Media/input.mov"></label>
        <label>Auto Trim For This Job<input v-model="ingestAutoTrim" type="checkbox"></label>
        <button class="btn" @click="startIngest" :disabled="busy || !running">Ingest Now</button>

        <div class="job" v-if="jobStatus">
          <div><strong>Job:</strong> {{ jobStatus.id }}</div>
          <div><strong>Stage:</strong> {{ jobStatus.stage }}</div>
          <div><strong>Message:</strong> {{ jobStatus.message }}</div>
          <div><strong>Progress:</strong> {{ jobStatus.progress.toFixed(0) }}%</div>
          <div v-if="jobStatus.done"><strong>Result:</strong> {{ jobStatus.success ? 'Success' : 'Failed' }}</div>
          <div v-if="jobStatus.error" class="error">{{ jobStatus.error }}</div>
        </div>
      </article>

      <article class="glass-panel card">
        <h3>Status</h3>
        <div class="status-row"><strong>Service:</strong> {{ running ? 'Running' : 'Stopped' }}</div>
        <div class="status-row"><strong>Message:</strong> {{ statusMessage }}</div>
        <div class="status-row" v-if="serviceStatus?.apiBaseUrl"><strong>API:</strong> {{ serviceStatus.apiBaseUrl }}</div>
        <div class="status-row" v-if="serviceStatus?.pid"><strong>PID:</strong> {{ serviceStatus.pid }}</div>
        <div class="status-row" v-if="serviceStatus?.destinationPath"><strong>Destination:</strong> {{ serviceStatus.destinationPath }}</div>
        <div class="status-row" v-if="serviceStatus?.watchFolderPath"><strong>Watchfolder:</strong> {{ serviceStatus.watchFolderPath }}</div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.ingest-shell {
  min-height: 100vh;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ingest-header {
  padding: 14px;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.ingest-header h2 {
  margin: 0;
  font-size: 1.1rem;
}

.ingest-header p {
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.ingest-actions {
  display: flex;
  gap: 8px;
}

.ingest-grid {
  display: grid;
  grid-template-columns: 1.3fr 1fr 1fr;
  gap: 12px;
}

.card {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.card h3 {
  margin: 0;
  font-size: 0.92rem;
}

label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--text-secondary);
}

input[type='text'],
input[type='number'] {
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  padding: 7px 8px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

select {
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  padding: 7px 8px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

input[type='checkbox'] {
  margin-top: 6px;
  width: 16px;
  height: 16px;
}

.row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.row > label {
  flex: 1;
}

.btn {
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent-blue) 18%, var(--bg-tertiary));
  color: var(--text-primary);
  padding: 8px 10px;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn.secondary {
  background: var(--bg-tertiary);
}

.job,
.status-row {
  font-size: 0.78rem;
  color: var(--text-primary);
}

.error {
  color: #f4a261;
}

@media (max-width: 1100px) {
  .ingest-grid {
    grid-template-columns: 1fr;
  }

  .ingest-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
