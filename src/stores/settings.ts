import { defineStore } from 'pinia';
import type { PlayoutEngine } from '../services/playout';

export interface CgAdvisoryTemplateConfig {
    fontFamily: string;
    topOffsetPx: number;
    rightOffsetPx: number;
    badgeSizePx: number;
    badgeFontSizePx: number;
    badgeBorderRadiusPx: number;
    explanationFontSizePx: number;
    warningLeadFontSizePx: number;
    warningBodyFontSizePx: number;
    warningIconSizePx: number;
    accentLineHeightPx: number;
    accentColor: string;
    ratingHoldSec: number;
    warningHoldSec: number;
}

export const DEFAULT_CG_ADVISORY_CONFIG: CgAdvisoryTemplateConfig = {
    fontFamily: 'Outfit, system-ui, -apple-system, sans-serif',
    topOffsetPx: 60,
    rightOffsetPx: 60,
    badgeSizePx: 54,
    badgeFontSizePx: 27,
    badgeBorderRadiusPx: 12,
    explanationFontSizePx: 13,
    warningLeadFontSizePx: 10.5,
    warningBodyFontSizePx: 12,
    warningIconSizePx: 28,
    accentLineHeightPx: 2,
    accentColor: 'rgba(255, 255, 255, 0.95)',
    ratingHoldSec: 30,
    warningHoldSec: 30,
};

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

        // Visual Theme ('dark' | 'monokai' | 'light')
        theme: 'dark' as 'dark' | 'monokai' | 'light',

        // UI Scale ('standard' | 'comfortable' | 'large')
        uiScale: 'comfortable' as 'standard' | 'comfortable' | 'large',

        // Recycle Bin & Auto-Purge Policy ('disabled' | '1week' | '2weeks' | '3weeks' | '1month')
        recycleBinAutoPurge: 'disabled' as 'disabled' | '1week' | '2weeks' | '3weeks' | '1month',
        lastAutoPurgeCheck: 0 as number,

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
        complianceRenderMode: 'html5' as 'html5' | 'legacy_png',
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
        cgExplanationTemplate: 'playout/advisory',

        // Universal CG Advisory Template Customizer Configuration
        cgAdvisoryConfig: {
            fontFamily: 'Outfit, system-ui, -apple-system, sans-serif',
            topOffsetPx: 60,
            rightOffsetPx: 60,
            badgeSizePx: 54,
            badgeFontSizePx: 27,
            badgeBorderRadiusPx: 12,
            explanationFontSizePx: 13,
            warningLeadFontSizePx: 10.5,
            warningBodyFontSizePx: 12,
            warningIconSizePx: 28,
            accentLineHeightPx: 2,
            accentColor: 'rgba(255, 255, 255, 0.95)',
            ratingHoldSec: 30,
            warningHoldSec: 30,
        } as CgAdvisoryTemplateConfig,
    }),

    actions: {
        updateSettings(payload: Partial<typeof this.$state>) {
            Object.assign(this.$state, payload);
        }
    },

    persist: true
});
