import { computed } from 'vue';
import type { RundownItem } from '../stores/rundown';
import { casparPlayoutService, currentCasparDurationMs, currentCasparMs, currentCasparTime, isCasparConnected, isCasparPlaying, isLiveActive } from './caspar';

export type PlayoutEngine = 'casparcg';
export type PlayoutItem = RundownItem;
/// Advance callback receives the next item's stable key (playoutvueId || local
/// id) or `null` when the rundown has reached its end. Identity-keyed advance
/// replaces the old positional-index callback (plan §2.2).
export type PlayoutAdvanceCallback = (uuid: string | null) => void;

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
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    play(items: PlayoutItem[], startIndex: number, resumeSeekMs?: number): Promise<void>;
    pause?(): Promise<void>;
    stop(): Promise<void>;
    cue?(item: PlayoutItem): Promise<void>;
    take?(): Promise<void>;
    clear(): Promise<void>;
    cutToLive?(): Promise<void>;
    returnFromLive?(): Promise<void>;
    refreshQueue?(items: PlayoutItem[]): Promise<void>;
    onAdvance?(callback: PlayoutAdvanceCallback): void;
    getOutputs?(): Promise<any[]>;
    getInputs?(): Promise<any[]>;
    syncLiveInputScene?(preferredSourceName?: string): Promise<void>;
    startStream?(): Promise<void>;
    stopStream?(): Promise<void>;
    startDeckLink?(outputName: string): Promise<void>;
    stopDeckLink?(outputName: string): Promise<void>;
    seekMedia?(inputName: string, timeCursor: number): Promise<void>;
    applyComplianceForItem?(item: PlayoutItem): Promise<void>;
    clearCompliance?(): Promise<void>;
    reloadComplianceTemplate?(): Promise<void>;
    /// Clear the on-demand crawl layer (plan §3.2).
    clearOverlays?(): Promise<void>;
    /// Clear the station logo branding layer (plan §3.2).
    clearBranding?(): Promise<void>;
    handleProcessStateEvent?(status: any): void;
}

export const getActivePlayoutService = (): PlayoutService => casparPlayoutService;

export const registerPlayoutAdvanceListener = (callback: PlayoutAdvanceCallback) => {
    casparPlayoutService.onAdvance?.(callback);
};

export const activePlayoutLabel = computed(() => getActivePlayoutService().label);
export const activePlayoutCapabilities = computed(() => getActivePlayoutService().supports);

export const isPlayoutConnected = computed(() => isCasparConnected.value);
export const isPlayoutPlaying = computed(() => isCasparPlaying.value);
export const isPlayoutLive = computed(() => isLiveActive.value);
export const currentPlayoutTime = computed(() => currentCasparTime.value);
export const currentPlayoutMs = computed(() => currentCasparMs.value);
export const currentTotalPlayoutMs = computed(() => currentCasparDurationMs.value);
