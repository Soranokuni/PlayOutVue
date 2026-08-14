import { defineStore } from 'pinia';
import type { PlayoutEngine } from '../services/playout';

export const useSettingsStore = defineStore('settings', {
    state: () => ({
        playoutEngine: 'casparcg' as PlayoutEngine,

        // Ingestor API
        ingestorApiBaseUrl: 'http://127.0.0.1:4353',

        // Media Paths
        localMediaPath: 'C:\\Users\\toutountzaki\\Desktop\\casparcg-server-v2.5.0-stable-windows\\media',
        ffmpegBinPath: '',
        debugMode: false,

        // Local logo and ratings asset folder
        logosPath: '',

        // Compliance & QC Sensitivity ('strict' = everything flagged, 'production' = subclip alignment ok, 'lenient' = only severe errors)
        qcSensitivity: 'production' as 'strict' | 'production' | 'lenient',

        // Hardware Output
        decklinkOutputName: '',
        decklinkOutputDevice: 0,     // Blackmagic DeckLink device number for SDI output (0 = unset)
        decklinkInputDevice: 0,      // Blackmagic DeckLink device number for SDI ingest / live rebroadcast
        decklinkInputFormat: '1080i5000', // e.g. 1080i5000, 1080p2500, auto
        liveInputSourceName: '',
        casparConfigPath: '',
        casparOscPort: 6250,

        // DeckLink consumer settings
        decklinkEmbeddedAudio: false,
        decklinkBufferDepth: 3,
        decklinkLatency: 'normal' as 'normal' | 'low' | 'default',
        decklinkKeyer: 'external' as 'external' | 'external_separate_device' | 'internal' | 'default',
        decklinkKeyDevice: 0,

        // PAL / SOTA playout profile
        playoutProfile: 'PAL_1080I50' as 'PAL_1080I50' | 'PAL_1080P25',
        transitionFrames: 2,
        prerollFrames: 2,

        // Crash recovery: re-issue PLAY ... SEEK at the crash-time position
        // when CasparCG restarts while a clip was on air.
        autoResumeAfterRestart: true,

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
        cgCrawlPosition: 'bottom' as 'top' | 'bottom',
        cgCrawlText: '',
        cgCrawlActive: false,
        cgExplanationTemplate: 'playout/explanation',
    }),

    actions: {
        updateSettings(payload: Partial<typeof this.$state>) {
            Object.assign(this.$state, payload);
        }
    },

    persist: true
});
