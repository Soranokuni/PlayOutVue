import { computed } from 'vue';
import type { RundownItem } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';
import { casparPlayoutService, currentCasparMs, currentCasparTime, isCasparConnected, isCasparPlaying } from './caspar';
import { currentMediaMs, currentMediaTime, isObsConnected, isPlaying, obsPlayoutService } from './obs';

export type PlayoutEngine = 'obs' | 'casparcg';
export type PlayoutItem = RundownItem;
export type PlayoutAdvanceCallback = (index: number) => void;

export interface PlayoutServiceCapabilities {
    preview: boolean;
    streaming: boolean;
    hardwareOutput: boolean;
    compliance: boolean;
    cue: boolean;
}

export interface PlayoutService {
    readonly engine: PlayoutEngine;
    readonly label: string;
    readonly supports: PlayoutServiceCapabilities;
    connect(url?: string, password?: string): Promise<void>;
    disconnect(): Promise<void>;
    play(items: PlayoutItem[], startIndex: number): Promise<void>;
    pause?(): Promise<void>;
    stop(): Promise<void>;
    cue?(item: PlayoutItem): Promise<void>;
    take?(): Promise<void>;
    clear(): Promise<void>;
    cutToLive?(): Promise<void>;
    refreshQueue?(items: PlayoutItem[]): Promise<void>;
    onAdvance?(callback: PlayoutAdvanceCallback): void;
    getOutputs?(): Promise<any[]>;
    getInputs?(): Promise<any[]>;
    syncLiveInputScene?(preferredSourceName?: string): Promise<void>;
    syncBrandingAssets?(): Promise<void>;
    startStream?(): Promise<void>;
    stopStream?(): Promise<void>;
    startDeckLink?(outputName: string): Promise<void>;
    stopDeckLink?(outputName: string): Promise<void>;
    seekMedia?(inputName: string, timeCursor: number): Promise<void>;
    applyComplianceForItem?(item: PlayoutItem): Promise<void>;
    clearCompliance?(): Promise<void>;
}

const getConfiguredEngine = (): PlayoutEngine => {
    try {
        return useSettingsStore().playoutEngine || 'obs';
    } catch {
        return 'obs';
    }
};

export const getActivePlayoutService = (): PlayoutService => (
    getConfiguredEngine() === 'casparcg' ? casparPlayoutService : obsPlayoutService
);

export const registerPlayoutAdvanceListener = (callback: PlayoutAdvanceCallback) => {
    obsPlayoutService.onAdvance?.(callback);
    casparPlayoutService.onAdvance?.(callback);
};

export const activePlayoutLabel = computed(() => getActivePlayoutService().label);
export const activePlayoutCapabilities = computed(() => getActivePlayoutService().supports);

export const isPlayoutConnected = computed(() => (
    getConfiguredEngine() === 'casparcg' ? isCasparConnected.value : isObsConnected.value
));

export const isPlayoutPlaying = computed(() => (
    getConfiguredEngine() === 'casparcg' ? isCasparPlaying.value : isPlaying.value
));

export const currentPlayoutTime = computed(() => (
    getConfiguredEngine() === 'casparcg' ? currentCasparTime.value : currentMediaTime.value
));

export const currentPlayoutMs = computed(() => (
    getConfiguredEngine() === 'casparcg' ? currentCasparMs.value : currentMediaMs.value
));
