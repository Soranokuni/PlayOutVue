import { reactive } from 'vue';
import type { HealthItem } from './mediaHealth';

/**
 * MEDIA-FALLBACK-HANDOFF AE-2 / AE-4: what the fork falls back on and whether
 * it is armed. `caspar.ts` writes `engineSet`/`mode` after each `FALLBACK`;
 * the monitor (`services/fallbackMonitor.ts`) writes the self-test results.
 * A plain module so the protected service only touches state, not UI.
 */

export interface ClipTest {
    ok: boolean;
    path: string | null;
    local: boolean;
    duration_ms: number;
    reason: string | null;
}

export interface FillerTest {
    ok: boolean;
    local: boolean;
    files: number;
    first_ok: string | null;
    failed: string[];
    reason: string | null;
}

export interface FallbackSelfTest {
    clip: ClipTest | null;
    fillers: FillerTest | null;
}

/** AE-4: the engine's fallback / fillers are on air. */
export interface FallbackOnAir {
    since: number;
    /** The filler on air (C2 `file`), null for the single clip. */
    file: string | null;
    reason: string;
    /** Fillers aired in this run. */
    count: number;
}

export interface FallbackHealthState {
    /** `QUEUE INFO` `fallback.set` after the last FALLBACK; null = not known (stock, offline). */
    engineSet: boolean | null;
    /** What PlayOut last asked for. */
    mode: 'clip' | 'list' | 'none' | null;
    /** The clip or folder sent with it. */
    target: string;
    test: FallbackSelfTest | null;
    testedAt: number;
    testError: string | null;
    /** AE-4: false after the filler folder failed its self-test; the single clip is used instead. */
    fillersUsable: boolean;
    /** AE-4: what the engine shows instead of a rundown row, null when a row (or nothing) is on air. */
    onAir: FallbackOnAir | null;
    /** F1: the rundown ended naturally and the fallback / fillers took over. */
    rundownFinished: boolean;
}

export const fallbackHealth = reactive<FallbackHealthState>({
    engineSet: null,
    mode: null,
    target: '',
    test: null,
    testedAt: 0,
    testError: null,
    fillersUsable: true,
    onAir: null,
    rundownFinished: false,
});

/** Tests only. */
export function resetFallbackHealth(): void {
    Object.assign(fallbackHealth, {
        engineSet: null,
        mode: null,
        target: '',
        test: null,
        testedAt: 0,
        testError: null,
        fillersUsable: true,
        onAir: null,
        rundownFinished: false,
    });
}

/** An absolute Windows path (`D:/…`, `D:\…`). */
export function isAbsoluteClipPath(clip: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(clip.trim());
}

/** The clip as the engine gets it: absolute paths with forward slashes (FK-1). */
export function normalizeFallbackClip(clip: string | null | undefined): string {
    const trimmed = (clip ?? '').trim();
    return isAbsoluteClipPath(trimmed) ? trimmed.replace(/\\/g, '/') : trimmed;
}

/** "On fillers" / "Finished · on fillers": sticky, it is what the channel shows. */
export function describeFallbackOnAir(state: FallbackHealthState, forkMode: boolean): HealthItem | null {
    if (!forkMode || !state.onAir) return null;
    const fillers = state.mode === 'list' || !!state.onAir.file;
    const what = fillers ? 'On fillers' : 'On fallback';
    const label = state.rundownFinished ? `Finished · ${what.toLowerCase()}` : what;
    const playing = state.onAir.file ? ` Now: ${state.onAir.file}.` : '';
    const detail = state.rundownFinished
        ? `The rundown finished; CasparCG shows its ${fillers ? 'fillers' : 'fallback clip'} until a row is taken.${playing}`
        : `CasparCG shows its ${fillers ? 'fillers' : 'fallback clip'} (${state.onAir.reason}) until a row is taken.${playing}`;
    return { key: 'fallback-on-air', tone: 'processing', label, detail, section: 'playout', sticky: true };
}

/** The chip item for the fallback; null when it has nothing to say (stock engine). */
export function describeFallback(state: FallbackHealthState, forkMode: boolean): HealthItem | null {
    if (!forkMode) return null;
    if (state.engineSet === false || state.mode === 'none') {
        return {
            key: 'fallback',
            tone: 'error',
            label: 'No fallback',
            detail: 'No fallback is armed in CasparCG: a dry rundown or a failed clip goes to black. Choose a local fallback clip in Settings → Playout.',
            section: 'playout',
        };
    }
    const clip = state.test?.clip;
    const fillers = state.test?.fillers;
    if (clip && !clip.ok) {
        return {
            key: 'fallback',
            tone: 'error',
            label: 'Fallback broken',
            detail: `Fallback clip self-test failed: ${clip.reason ?? 'unknown error'}.`,
            section: 'playout',
        };
    }
    if (fillers && !fillers.ok) {
        return {
            key: 'fallback',
            tone: 'warning',
            label: 'Fillers broken',
            detail: `Filler folder self-test failed (${fillers.reason ?? 'unknown error'}); the single fallback clip is used instead.`,
            section: 'playout',
        };
    }
    if (clip && !clip.local) {
        return {
            key: 'fallback',
            tone: 'warning',
            label: 'Fallback not local',
            detail: 'The fallback clip is not on a local disk: a share outage would take it out with the media.',
            section: 'playout',
        };
    }
    if (state.testError) {
        return { key: 'fallback', tone: 'warning', label: 'Fallback untested', detail: `Fallback self-test failed to run: ${state.testError}.`, section: 'playout' };
    }
    if (state.engineSet === true) {
        const what = state.mode === 'list' ? `fillers from ${state.target}` : `the clip ${state.target}`;
        return { key: 'fallback', tone: 'ready', label: 'Fallback', detail: `Fallback armed: ${what}.`, section: 'playout' };
    }
    return null;
}
