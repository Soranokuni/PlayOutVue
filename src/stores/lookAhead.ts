import { defineStore } from 'pinia';
import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useRundownStore } from './rundown';
import { useSettingsStore } from './settings';
import { getAdvertisedMediaRoot } from '../lib/mediaRootContext';
import {
    mergeIssues,
    selectLookAheadRows,
    type PreflightIssue,
    type PreflightResult,
} from '../lib/lookAhead';

/** MEDIA-FALLBACK-HANDOFF AE-3: the pre-flight cadence. */
export const LOOK_AHEAD_INTERVAL_MS = 30_000;

/**
 * Pre-flight the rows due next (AE-3). Problems show on the row as "will fail
 * at HH:MM" with Skip / Hold; nothing here ever blocks or delays a take.
 */
export const useLookAheadStore = defineStore('lookAhead', () => {
    const issues = ref<Record<string, PreflightIssue>>({});
    const lastRunAt = ref(0);
    const lastError = ref<string | null>(null);
    let timer: ReturnType<typeof setInterval> | null = null;
    let running = false;

    async function run(nowMs = Date.now()): Promise<void> {
        if (running) return;
        running = true;
        try {
            const rundown = useRundownStore();
            const settings = useSettingsStore();
            const items = rundown.activeItems;
            const etas = rundown.activeItemsETAs as Array<{ epochMs: number }>;
            const afterIndex = rundown.isCurrentPlaylistOnAir ? rundown.currentPlayingIndex : -1;
            const advertisedRoot = getAdvertisedMediaRoot();
            const rows = selectLookAheadRows(
                items as any,
                etas.map((eta) => eta?.epochMs),
                afterIndex,
                nowMs,
                Number(settings.lookAheadRows) || 5,
                Number(settings.lookAheadMinutes) || 30,
                advertisedRoot !== '',
            );
            if (rows.length === 0) {
                issues.value = {};
                return;
            }
            const results = await invoke<PreflightResult[]>('preflight_rows', {
                rows: rows.map(({ id, path, playoutvueId }) => ({ id, path, playoutvueId })),
                mediaRoot: settings.localMediaPath || '',
                advertisedRoot: advertisedRoot || null,
            });
            issues.value = mergeIssues(issues.value, rows, results, nowMs);
            lastRunAt.value = nowMs;
            lastError.value = null;
        } catch (error) {
            // Keep the last known issues; a slow share must not clear them.
            lastError.value = String((error as any)?.message ?? error);
        } finally {
            running = false;
        }
    }

    function issueFor(rowId: string): PreflightIssue | null {
        return issues.value[rowId] ?? null;
    }

    /** A status edit is not structural; push the queue so the engine drops the row. */
    function pushQueue() {
        const rundown = useRundownStore();
        if (rundown.isCurrentPlaylistOnAir) rundown.syncPlayoutQueue(rundown.activePlaylistId);
    }

    /** Skip: the chain passes over the row, as it does for any failed row. */
    function skip(rowId: string) {
        useRundownStore().updateItem(rowId, { ingestorStatus: 'error' });
        pushQueue();
    }

    /**
     * Hold: the row stays but is not ready, so the chain stops before it (fork
     * mode: the queue runs dry and the fallback / fillers hold the air until
     * the operator acts).
     */
    function hold(rowId: string) {
        useRundownStore().updateItem(rowId, { ingestorStatus: 'missing' });
        pushQueue();
    }

    function start() {
        if (timer) return;
        void run();
        timer = setInterval(() => void run(), LOOK_AHEAD_INTERVAL_MS);
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { issues, lastRunAt, lastError, run, issueFor, skip, hold, start, stop };
});
