import { computed, onUnmounted, ref, watch, type Ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';

interface DiskSpaceDto {
    free_bytes: number;
    total_bytes: number;
    path: string;
}

export type DiskTone = 'ok' | 'low' | 'critical';

/** Below this share free the gauge turns amber, and below the second, red. */
export const DISK_LOW_PCT = 15;
export const DISK_CRITICAL_PCT = 5;

const POLL_MS = 30_000;

export function diskTone(freePct: number): DiskTone {
    if (freePct < DISK_CRITICAL_PCT) return 'critical';
    if (freePct < DISK_LOW_PCT) return 'low';
    return 'ok';
}

export function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Windows drive (or UNC share) the path lives on, for the tooltip. */
function volumeLabel(path: string): string {
    const drive = /^([a-zA-Z]:)/.exec(path);
    if (drive) return drive[1]!.toUpperCase();
    const unc = /^(\\\\[^\\]+\\[^\\]+)/.exec(path.replace(/\//g, '\\'));
    return unc ? unc[1]! : path;
}

/**
 * Polls free space on the volume holding `path` (the media root). Everything
 * is null while the path is empty or can't be read, so the caller just hides
 * the gauge.
 */
export function useDiskSpace(path: Ref<string>) {
    const space = ref<DiskSpaceDto | null>(null);
    let timer: ReturnType<typeof setInterval> | null = null;
    let seq = 0;

    async function refresh() {
        const target = path.value.trim();
        const mine = ++seq;
        if (!target) {
            space.value = null;
            return;
        }
        try {
            const result = await invoke<DiskSpaceDto | null>('get_disk_space', { path: target });
            if (mine === seq) space.value = result && result.total_bytes > 0 ? result : null;
        } catch {
            if (mine === seq) space.value = null;
        }
    }

    watch(path, () => { void refresh(); }, { immediate: true });
    timer = setInterval(() => { void refresh(); }, POLL_MS);
    onUnmounted(() => {
        if (timer) clearInterval(timer);
        timer = null;
    });

    const freePct = computed(() =>
        space.value ? Math.max(0, Math.min(100, (space.value.free_bytes / space.value.total_bytes) * 100)) : null
    );
    const tone = computed<DiskTone | null>(() => (freePct.value === null ? null : diskTone(freePct.value)));
    const label = computed(() => (freePct.value === null ? '' : `${Math.floor(freePct.value)}% free`));
    const tooltip = computed(() => {
        if (!space.value) return '';
        const { free_bytes, total_bytes, path: queried } = space.value;
        return `${formatBytes(free_bytes)} free of ${formatBytes(total_bytes)} (${volumeLabel(queried)})`;
    });

    return { space, freePct, tone, label, tooltip, refresh };
}
