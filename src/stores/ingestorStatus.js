import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from './settings';
const MAX_LOG_ENTRIES = 200;
export const useIngestorStatusStore = defineStore('ingestorStatus', () => {
    const isIngestorOnline = ref(false);
    const lastSeenAt = ref(null);
    const logEntries = ref([]);
    const isOffline = computed(() => !isIngestorOnline.value);
    function setOnline(online, seenAt) {
        isIngestorOnline.value = online;
        if (typeof seenAt === 'number') {
            lastSeenAt.value = seenAt;
        }
        else {
            lastSeenAt.value = Date.now();
        }
    }
    function log(scope, message, level = 'warn') {
        // Write to the backend physical file logger regardless of UI toggles
        invoke('push_diagnostic_log', { level, scope, message }).catch(() => { });
        // If debugMode is false, completely halt reactive UI log pushes
        const settingsStore = useSettingsStore();
        if (!settingsStore.debugMode) {
            return;
        }
        const entry = {
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
    function logWarning(scope, message) {
        log(scope, message, 'warn');
    }
    function logError(scope, message) {
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
}, {
    persist: {
        pick: ['isIngestorOnline', 'lastSeenAt'],
    },
});
