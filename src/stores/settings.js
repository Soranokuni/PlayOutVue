import { defineStore } from 'pinia';
export const useSettingsStore = defineStore('settings', {
    state: () => ({
        playoutEngine: 'casparcg',
        // Ingestor API
        ingestorApiBaseUrl: 'http://127.0.0.1:4353',
        // Media Paths
        localMediaPath: 'C:\\Users\\toutountzaki\\Desktop\\casparcg-server-v2.5.0-stable-windows\\media',
        ffmpegBinPath: '',
        debugMode: false,
        // Local logo and ratings asset folder
        logosPath: '',
        // Hardware Output
        decklinkOutputName: '',
        decklinkOutputDevice: 0, // Blackmagic DeckLink device number for SDI output (0 = unset)
        decklinkInputDevice: 0, // Blackmagic DeckLink device number for SDI ingest / live rebroadcast
        liveInputSourceName: '',
        casparConfigPath: '',
        casparOscPort: 6250,
        // DeckLink consumer settings
        decklinkEmbeddedAudio: false,
        decklinkBufferDepth: 3,
        decklinkLatency: 'normal',
        decklinkKeyer: 'external',
        decklinkKeyDevice: 0,
        // PAL / SOTA playout profile
        playoutProfile: 'PAL_1080I50',
        transitionFrames: 2,
        prerollFrames: 2,
        // Character Generator (CG) settings
        cg: {
            stationIdPath: '',
            stationIdEnabled: true,
        },
        cgRatingKPath: '',
        cgRating8Path: '',
        cgRating12Path: '',
        cgRating16Path: '',
        cgRating18Path: '',
        cgRatingTPPath: '',
        // CG Positions (Percentages)
        cgStationLogoPos: { left: 5, top: 5, width: 12, height: 12 },
        cgRatingBadgePos: { left: 88, top: 5, width: 7, height: 7 },
        cgTPPos: { left: 88, top: 13, width: 7, height: 7 },
        cgExplanationBannerPos: { left: 60, top: 5, width: 27, height: 7 },
        cgCrawlPos: { left: 0, top: 90, width: 100, height: 8 },
        // CG Templates & Crawl state
        cgCrawlTemplate: 'playout/crawl',
        cgCrawlPosition: 'bottom',
        cgCrawlText: '',
        cgCrawlActive: false,
        cgExplanationTemplate: 'playout/explanation',
    }),
    actions: {
        updateSettings(payload) {
            Object.assign(this.$state, payload);
        }
    },
    persist: true
});
