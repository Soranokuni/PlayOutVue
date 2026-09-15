import { defineStore } from 'pinia';
import type { PlayoutEngine } from '../services/playout';

export interface CgAdvisoryTemplateConfig {
    themeName?: string;
    customLogoSvgPath?: string;
    customRatingSvgPaths?: Record<string, string>;
    badgeShape?: string;
    ratingShape?: string;
    logoShape?: string;
    logoBase?: string;
    logoGrad?: string;
    logoSize?: number;
    logoRadius?: number;
    logoExtrusion?: string;
    logoSpecular?: string;
    logoShadow?: string;
    logoFont?: string;
    stencilStyle?: 'neumorphic' | 'frosted' | 'contrast' | string;
    fontFamily: string;
    topOffsetPx: number;
    rightOffsetPx: number;
    textOffsetYPx?: number;
    anchorPosition?: string;
    badgeSizePx: number;
    badgeFontSizePx: number;
    badgeBorderRadiusPx: number;
    shadowBlurPx?: number;
    explanationFontSizePx: number;
    warningLeadFontSizePx: number;
    warningBodyFontSizePx: number;
    warningIconSizePx: number;
    accentLineHeightPx: number;
    accentStyle?: 'gradient' | 'solid' | 'bevel' | 'none' | string;
    accentColor: string;
    ratingHoldSec: number;
    warningHoldSec: number;
    [key: string]: any;
}

export const DEFAULT_CG_ADVISORY_CONFIG: CgAdvisoryTemplateConfig = {
    themeName: 'frosted',
    badgeShape: 'squircle',
    logoShape: 'squircle',
    stencilStyle: 'neumorphic',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    topOffsetPx: 60,
    rightOffsetPx: 60,
    textOffsetYPx: 0,
    anchorPosition: 'top-right',
    badgeSizePx: 54,
    badgeFontSizePx: 27,
    badgeBorderRadiusPx: 12,
    shadowBlurPx: 18,
    explanationFontSizePx: 13,
    warningLeadFontSizePx: 10.5,
    warningBodyFontSizePx: 12,
    warningIconSizePx: 28,
    accentLineHeightPx: 2,
    accentStyle: 'gradient',
    accentColor: 'rgba(255, 255, 255, 0.95)',
    ratingHoldSec: 30,
    warningHoldSec: 30,
    customLogoSvgPath: '',
    customRatingSvgPaths: {},
};

/**
 * Audit T2-23: persisted settings were restored verbatim. A hand-edited or
 * corrupted localStorage entry (or an older schema) could put a non-enum
 * value into an AMCP command (`LATENCY_UNDEFINED`), a NaN into a layer
 * position, or a string into a port. Coerce every enumerated / numeric field
 * back to a valid value; unknown keys are left alone.
 */
const ENUM_FIELDS: Record<string, readonly string[]> = {
    playoutEngine: ['casparcg', 'obs'],
    theme: ['dark', 'monokai', 'light', 'soft-slate', 'periwinkle'],
    uiScale: ['standard', 'comfortable', 'large'],
    recycleBinAutoPurge: ['disabled', '1week', '2weeks', '3weeks', '1month'],
    qcSensitivity: ['strict', 'production', 'lenient'],
    decklinkLatency: ['normal', 'low', 'default'],
    decklinkKeyer: ['external', 'external_separate_device', 'internal', 'default'],
    playoutProfile: ['PAL_1080I50', 'PAL_1080P25'],
    complianceRenderMode: ['html5', 'legacy_png'],
    cgCrawlPosition: ['top', 'bottom'],
};

const INT_FIELDS: Record<string, { min: number; max: number }> = {
    decklinkOutputDevice: { min: 0, max: 32 },
    decklinkInputDevice: { min: 0, max: 32 },
    decklinkKeyDevice: { min: 0, max: 32 },
    decklinkBufferDepth: { min: 1, max: 16 },
    casparOscPort: { min: 1, max: 65535 },
    transitionFrames: { min: 0, max: 100 },
    prerollFrames: { min: 0, max: 100 },
    lastAutoPurgeCheck: { min: 0, max: Number.MAX_SAFE_INTEGER },
};

const POSITION_FIELDS = ['cgStationLogoPos', 'cgRatingBadgePos', 'cgTPPos', 'cgExplanationBannerPos', 'cgCrawlPos'] as const;

/** A single token of the AMCP grammar: letters, digits, `_`, `-`, `.` */
const AMCP_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

export function sanitizeSettingsState<T extends Record<string, any>>(state: T, defaults: Record<string, any>): T {
    for (const [key, allowed] of Object.entries(ENUM_FIELDS)) {
        if (!allowed.includes(state[key])) {
            (state as any)[key] = defaults[key];
        }
    }
    for (const [key, range] of Object.entries(INT_FIELDS)) {
        const value = Number(state[key]);
        if (!Number.isFinite(value) || value < range.min || value > range.max) {
            (state as any)[key] = defaults[key];
        } else {
            (state as any)[key] = Math.round(value);
        }
    }
    for (const key of POSITION_FIELDS) {
        const pos = state[key];
        const fallback = defaults[key];
        if (!pos || typeof pos !== 'object') {
            (state as any)[key] = { ...fallback };
            continue;
        }
        for (const axis of ['left', 'top', 'width', 'height'] as const) {
            const value = Number(pos[axis]);
            pos[axis] = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback[axis];
        }
    }
    // Strings that end up inside an AMCP command line as bare tokens.
    if (typeof state.decklinkInputFormat !== 'string' || !AMCP_TOKEN.test(state.decklinkInputFormat)) {
        (state as any).decklinkInputFormat = defaults.decklinkInputFormat;
    }
    for (const key of ['cgCrawlTemplate', 'cgExplanationTemplate'] as const) {
        const value = state[key];
        if (typeof value !== 'string' || !/^[A-Za-z0-9_./ -]{1,256}$/.test(value) || value.includes('..')) {
            (state as any)[key] = defaults[key];
        }
    }
    // Free-text strings must never carry control characters (CRLF would
    // split an AMCP command); the backend rejects them, but fix the store too.
    for (const key of ['liveInputSourceName', 'cgCrawlText', 'decklinkOutputName'] as const) {
        if (typeof state[key] !== 'string') {
            (state as any)[key] = defaults[key];
        } else if (/[\u0000-\u001f\u007f]/.test(state[key])) {
            (state as any)[key] = state[key].replace(/[\u0000-\u001f\u007f]/g, ' ');
        }
    }
    if (typeof state.ingestorApiBaseUrl !== 'string' || !/^https?:\/\/[^\s]+$/i.test(state.ingestorApiBaseUrl)) {
        (state as any).ingestorApiBaseUrl = defaults.ingestorApiBaseUrl;
    }
    return state;
}

export const useSettingsStore = defineStore('settings', {
    state: () => ({
        playoutEngine: 'casparcg' as PlayoutEngine,

        // Ingestor API
        ingestorApiBaseUrl: 'http://127.0.0.1:4353',

        // Media Paths
        localMediaPath: '',
        ffmpegBinPath: '',
        debugMode: false,

        // Local logo and ratings asset folder
        logosPath: '',

        // Visual Theme ('dark' | 'monokai' | 'light' | 'soft-slate' | 'periwinkle')
        theme: 'dark' as 'dark' | 'monokai' | 'light' | 'soft-slate' | 'periwinkle',

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
        casparcgExecutablePath: '',
        casparcgConfigFilename: 'casparcg.config',
        casparAutoStart: false,
        casparKeepAliveOnExit: true,
        casparAutoRelaunchOnCrash: true,

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
            ...DEFAULT_CG_ADVISORY_CONFIG
        } as CgAdvisoryTemplateConfig,
    }),

    actions: {
        updateSettings(payload: Partial<typeof this.$state>) {
            Object.assign(this.$state, payload);
        },
        updateCgAdvisoryFromDeployedPreset(preset: Record<string, any>) {
            if (!preset || typeof preset !== 'object') return;
            const current = this.cgAdvisoryConfig || {} as CgAdvisoryTemplateConfig;
            
            const updated: CgAdvisoryTemplateConfig = {
                ...current,
            };

            if (preset.theme || preset.themeName) {
                updated.themeName = preset.theme || preset.themeName;
            }
            if (preset.logoShape) updated.logoShape = preset.logoShape;
            if (preset.logoBase) updated.logoBase = preset.logoBase;
            if (preset.logoGrad) updated.logoGrad = preset.logoGrad;
            if (preset.logoSize !== undefined) updated.logoSize = Number(preset.logoSize);
            if (preset.logoRadius !== undefined) updated.logoRadius = Number(preset.logoRadius);
            if (preset.logoExtrusion) updated.logoExtrusion = preset.logoExtrusion;
            if (preset.logoSpecular) updated.logoSpecular = preset.logoSpecular;
            if (preset.logoShadow) updated.logoShadow = preset.logoShadow;
            if (preset.logoFont) updated.logoFont = preset.logoFont;

            const rShape = preset.ratingShape || preset.badgeShape;
            if (rShape) {
                updated.badgeShape = rShape;
                updated.ratingShape = rShape;
            }
            if (preset.ratingSize !== undefined || preset.badgeSizePx !== undefined) {
                updated.badgeSizePx = Number(preset.ratingSize ?? preset.badgeSizePx);
                updated.ratingSize = updated.badgeSizePx;
            }
            if (preset.ratingFontSize !== undefined || preset.badgeFontSizePx !== undefined) {
                updated.badgeFontSizePx = Number(preset.ratingFontSize ?? preset.badgeFontSizePx);
                updated.ratingFontSize = updated.badgeFontSizePx;
            }
            const rawFont = preset.fontFamily || preset.ratingFont;
            if (rawFont) {
                updated.fontFamily = (!rawFont || rawFont.toLowerCase() === 'system' || rawFont.toLowerCase() === 'default')
                    ? '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
                    : rawFont;
                updated.ratingFont = updated.fontFamily;
            }
            if (preset.ratingCutout) updated.ratingCutout = preset.ratingCutout;
            if (preset.wordmark) updated.wordmark = preset.wordmark;
            if (preset.subtitle !== undefined) updated.subtitle = preset.subtitle;
            if (preset.showTag) updated.showTag = preset.showTag;
            if (preset.topOffsetPx !== undefined) updated.topOffsetPx = Number(preset.topOffsetPx);
            if (preset.rightOffsetPx !== undefined) updated.rightOffsetPx = Number(preset.rightOffsetPx);
            if (preset.textOffsetYPx !== undefined) updated.textOffsetYPx = Number(preset.textOffsetYPx);
            if (preset.anchorPosition || preset.anchor) {
                updated.anchorPosition = preset.anchorPosition || preset.anchor;
            }
            if (preset.hold_time !== undefined || preset.ratingHoldSec !== undefined) {
                updated.ratingHoldSec = Number(preset.hold_time ?? preset.ratingHoldSec);
            }
            if (preset.warning_hold_time !== undefined || preset.warningHoldSec !== undefined) {
                updated.warningHoldSec = Number(preset.warning_hold_time ?? preset.warningHoldSec);
            }
            if (preset.accentColor || preset.accentMid) {
                updated.accentColor = preset.accentColor || preset.accentMid;
            }
            if (preset.accentLineHeightPx !== undefined) {
                updated.accentLineHeightPx = Number(preset.accentLineHeightPx);
            }

            this.cgAdvisoryConfig = updated;
        }
    },

    persist: {
        afterHydrate: (ctx) => {
            // Defaults are the store's own initial state.
            const defaults = (ctx.store.$options?.state?.() ?? {}) as Record<string, any>;
            sanitizeSettingsState(ctx.store.$state as Record<string, any>, defaults);
        }
    }
});
