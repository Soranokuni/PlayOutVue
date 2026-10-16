import { watch, type WatchStopHandle } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';
import { applyForkFallbackSettings, engineMode, isCasparConnected, readForkFallbackArmed } from './caspar';
import { fallbackHealth, type FallbackSelfTest } from '../lib/fallbackHealth';
import { recordFrontendFault } from '../lib/frontendFaults';

/** MEDIA-FALLBACK-HANDOFF AE-2: self-test on connect and every hour. */
export const FALLBACK_SELF_TEST_MS = 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let stopWatch: WatchStopHandle | null = null;
let running: Promise<FallbackSelfTest | null> | null = null;

function report(message: string, level: 'warn' | 'error' = 'warn') {
    invoke('push_diagnostic_log', { level, scope: 'fallback', message }).catch(() => {});
    recordFrontendFault('fallback', message);
}

/**
 * Probe the fallback clip (and, AE-4, the filler folder), then read back what
 * the engine has armed. A filler folder that fails switches the engine to the
 * single clip; one that recovers switches it back.
 */
export async function runFallbackSelfTest(): Promise<FallbackSelfTest | null> {
    if (running) return running;
    running = (async () => {
        const settings = useSettingsStore();
        try {
            const result = await invoke<FallbackSelfTest>('fallback_self_test', {
                clip: (settings.forkFallbackClip || '').trim() || null,
                mediaRoot: settings.localMediaPath || null,
                fillerFolder: ((settings as any).forkFillerFolder || '').trim() || null,
            });
            fallbackHealth.test = result;
            fallbackHealth.testError = null;
            fallbackHealth.testedAt = Date.now();
            if (result.clip && !result.clip.ok) {
                report(`Fallback clip self-test failed: ${result.clip.reason ?? 'unknown error'}`, 'error');
            }
            const fillersUsable = !result.fillers || result.fillers.ok;
            if (result.fillers && !result.fillers.ok) {
                report(`Filler folder self-test failed (${result.fillers.reason ?? 'unknown error'}); using the single fallback clip.`);
            }
            if (fillersUsable !== fallbackHealth.fillersUsable) {
                fallbackHealth.fillersUsable = fillersUsable;
                await applyForkFallbackSettings().catch(() => {});
            }
            const armed = await readForkFallbackArmed();
            if (armed === false) {
                // F4: e.g. the slate was deployed after connect. One re-send.
                await applyForkFallbackSettings().catch(() => {});
            }
            return result;
        } catch (error) {
            fallbackHealth.testError = String((error as any)?.message ?? error);
            return null;
        } finally {
            running = null;
        }
    })();
    return running;
}

/** F4: re-arm after `Deploy templates` (the default slate exists only now). */
export async function afterTemplatesDeployed(): Promise<void> {
    await applyForkFallbackSettings().catch(() => {});
    await runFallbackSelfTest();
}

/** After a settings save: re-send (done by the caller) and re-test. */
export function fallbackSettingsChanged(): void {
    fallbackHealth.fillersUsable = true;
    void runFallbackSelfTest();
}

export function startFallbackMonitor(): void {
    if (stopWatch) return;
    stopWatch = watch(
        () => isCasparConnected.value && engineMode.value === 'fork',
        (active) => {
            if (timer) clearInterval(timer);
            timer = null;
            if (!active) {
                fallbackHealth.engineSet = null;
                return;
            }
            void runFallbackSelfTest();
            timer = setInterval(() => void runFallbackSelfTest(), FALLBACK_SELF_TEST_MS);
        },
        { immediate: true },
    );
}

export function stopFallbackMonitor(): void {
    stopWatch?.();
    stopWatch = null;
    if (timer) clearInterval(timer);
    timer = null;
}
