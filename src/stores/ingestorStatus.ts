import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

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
