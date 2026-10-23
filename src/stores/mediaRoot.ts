import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from './settings';
import { setAdvertisedMediaRoot } from '../lib/mediaRootContext';
import {
    describeMediaRoot,
    registryIdToRemember,
    sameFolder,
    shouldOfferCasparFix,
    type MediaRootStatus,
} from '../lib/mediaRootStatus';

/** How often the status is re-read while the app runs. */
export const MEDIA_ROOT_POLL_MS = 60_000;

interface MediaPathFix {
    config_path: string;
    backup_path: string;
    media_path: string;
    restarted: boolean;
    restart_error: string | null;
}

/**
 * MEDIA-FALLBACK-HANDOFF AE-1: is *Local media path* the transcoder's media
 * root, and does CasparCG play from it? Re-read on start, every minute and
 * whenever the path or the transcoder URL changes.
 */
export const useMediaRootStore = defineStore('mediaRoot', () => {
    const status = ref<MediaRootStatus | null>(null);
    const lastError = ref<string | null>(null);
    const checking = ref(false);
    const fixing = ref(false);
    /** The Caspar path the operator dismissed the banner for. */
    const dismissedCasparPath = ref<string | null>(null);
    let timer: ReturnType<typeof setInterval> | null = null;

    const view = computed(() => describeMediaRoot(status.value));
    const offerCasparFix = computed(() =>
        shouldOfferCasparFix(status.value)
        && !sameFolder(dismissedCasparPath.value, status.value?.caspar_media_path ?? ''),
    );

    /** Read the status for `localRoot` without storing it (Settings → Verify). */
    async function probe(localRoot: string): Promise<MediaRootStatus> {
        const settings = useSettingsStore();
        const result = await invoke<MediaRootStatus>('media_root_status', {
            localRoot,
            knownRegistryId: settings.mediaRootRegistryId || null,
        });
        if (result?.advertised?.target_folder) setAdvertisedMediaRoot(result.advertised.target_folder);
        return result;
    }

    /** Remember a successful verification of the configured path. */
    function remember(result: MediaRootStatus) {
        const settings = useSettingsStore();
        const id = registryIdToRemember(result);
        if (id && sameFolder(result.local_root, settings.localMediaPath)) {
            settings.updateSettings({ mediaRootRegistryId: id, mediaRootVerifiedAt: Date.now() });
        }
    }

    async function refresh(): Promise<MediaRootStatus | null> {
        if (checking.value) return status.value;
        checking.value = true;
        try {
            const settings = useSettingsStore();
            const result = await probe(settings.localMediaPath || '');
            status.value = result;
            lastError.value = null;
            remember(result);
            return result;
        } catch (error) {
            lastError.value = String((error as any)?.message ?? error);
            return null;
        } finally {
            checking.value = false;
        }
    }

    function start() {
        if (timer) return;
        void refresh();
        timer = setInterval(() => void refresh(), MEDIA_ROOT_POLL_MS);
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    function dismissCasparFix() {
        dismissedCasparPath.value = status.value?.caspar_media_path ?? null;
    }

    /**
     * Q4: rewrite CasparCG's `<media-path>` to the verified root. Never
     * silent: the operator confirms, a backup is written, and the engine is
     * restarted only off air (Rust refuses otherwise).
     */
    async function fixCasparMediaPath(onAir: boolean): Promise<boolean> {
        const current = status.value;
        if (!current || !shouldOfferCasparFix(current) || fixing.value) return false;
        if (onAir) {
            await message('The channel is on air. Stop playback first: fixing the media path restarts CasparCG.', {
                title: 'CasparCG media path',
                kind: 'warning',
            });
            return false;
        }
        const confirmed = await ask(
            `CasparCG plays from:\n${current.caspar_media_path}\n\nThe verified media root is:\n${current.local_root}\n\n`
            + `Rewrite <media-path> in ${current.caspar_config_path ?? 'casparcg.config'} and restart CasparCG? `
            + 'A backup of the config is written first.',
            { title: 'Fix CasparCG media path', kind: 'warning', okLabel: 'Fix and restart', cancelLabel: 'Cancel' },
        );
        if (!confirmed) return false;
        fixing.value = true;
        try {
            const result = await invoke<MediaPathFix>('fix_caspar_media_path', {
                root: current.local_root,
                onAir,
            });
            await message(
                `CasparCG now plays from ${result.media_path}.\nBackup: ${result.backup_path}\n\n`
                + (result.restarted
                    ? 'CasparCG was restarted.'
                    : `CasparCG could not be restarted (${result.restart_error ?? 'unknown error'}). Restart it yourself to apply the change.`),
                { title: 'CasparCG media path', kind: result.restarted ? 'info' : 'warning' },
            );
            await refresh();
            return true;
        } catch (error) {
            await message(String((error as any)?.message ?? error), { title: 'CasparCG media path', kind: 'error' });
            return false;
        } finally {
            fixing.value = false;
        }
    }

    return {
        status,
        lastError,
        checking,
        fixing,
        view,
        offerCasparFix,
        probe,
        refresh,
        start,
        stop,
        dismissCasparFix,
        fixCasparMediaPath,
    };
});
