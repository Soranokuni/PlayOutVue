import { computed } from 'vue';
import { casparPlayoutService, currentCasparDurationMs, currentCasparMs, currentCasparTime, isCasparConnected, isCasparPlaying } from './caspar';
export const getActivePlayoutService = () => casparPlayoutService;
export const registerPlayoutAdvanceListener = (callback) => {
    casparPlayoutService.onAdvance?.(callback);
};
export const activePlayoutLabel = computed(() => getActivePlayoutService().label);
export const activePlayoutCapabilities = computed(() => getActivePlayoutService().supports);
export const isPlayoutConnected = computed(() => isCasparConnected.value);
export const isPlayoutPlaying = computed(() => isCasparPlaying.value);
export const currentPlayoutTime = computed(() => currentCasparTime.value);
export const currentPlayoutMs = computed(() => currentCasparMs.value);
export const currentTotalPlayoutMs = computed(() => currentCasparDurationMs.value);
