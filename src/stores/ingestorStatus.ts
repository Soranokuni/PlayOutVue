import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from './settings';

export type DiagnosticLevel = 'warn' | 'error';

export interface IngestorLogEntry {
    timestamp: number;
    level: DiagnosticLevel;
    scope: string;
    message: string;
}

const MAX_LOG_ENTRIES = 200;

export const useIngestorStatusStore = defineStore(
    'ingestorStatus',
    () => {
        const isIngestorOnline = ref(false);
        const lastSeenAt = ref<number | null>(null);
        const logEntries = ref<IngestorLogEntry[]>([]);

        const isOffline = computed(() => !isIngestorOnline.value);

        function setOnline(online: boolean, seenAt?: number) {
            isIngestorOnline.value = online;
            if (typeof seenAt === 'number') {
                lastSeenAt.value = seenAt;
            } else {
                lastSeenAt.value = Date.now();
            }
        }

        function log(scope: string, message: string, level: DiagnosticLevel = 'warn') {
            // Write to the backend physical file logger regardless of UI toggles
            invoke('push_diagnostic_log', { level, scope, message }).catch(() => {});

            // If debugMode is false, completely halt reactive UI log pushes
            const settingsStore = useSettingsStore();
            if (!settingsStore.debugMode) {
                return;
            }

            const entry: IngestorLogEntry = {
                timestamp: Date.now(),
                level,
                scope,
                message,
            };
            logEntries.value.push(entry);
            if (logEntries.value.length > MAX_LOG_ENTRIES) {
                logEntries.value.shift();
            }
        }

        function logWarning(scope: string, message: string) {
            log(scope, message, 'warn');
        }

        function logError(scope: string, message: string) {
            log(scope, message, 'error');
        }

        function clearLog() {
            logEntries.value = [];
        }

        return {
            isIngestorOnline,
            lastSeenAt,
            logEntries,
            isOffline,
            setOnline,
            log,
            logWarning,
            logError,
            clearLog,
        };
    },
    {
        persist: {
            pick: ['isIngestorOnline', 'lastSeenAt'],
        },
    }
);
