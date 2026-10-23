import type { ComplianceRating } from '../stores/rundown';
import type { PlayoutItem } from '../services/playout';
import { parseDescriptorsFromText, getGreekRatingDefaultText } from './greekCompliance';

/** The settings the advisory payload reads (a subset of the settings store). */
export interface AdvisorySettings {
    cgExplanationTemplate?: string;
    cgAdvisoryConfig?: {
        ratingHoldSec?: number;
        warningHoldSec?: number;
        customLogoSvgPath?: string;
        customRatingSvgPaths?: Record<string, string>;
        [key: string]: unknown;
    } | null;
}

/** Custom SVGs read from the paths in the advisory settings. */
export interface AdvisorySvgs {
    customLogoSvg: string | null;
    customLogos: Record<string, string>;
}

export const NO_ADVISORY_SVGS: AdvisorySvgs = { customLogoSvg: null, customLogos: {} };

/** The advisory template (layer 32), with the legacy placeholder name mapped to the default. */
export function advisoryTemplateName(settings: AdvisorySettings): string {
    const template = settings.cgExplanationTemplate || 'playout/advisory';
    return template === 'testdada' ? 'playout/advisory' : template;
}

/** The `CG ADD`/`CG UPDATE` data of the advisory template for one item. */
export function buildAdvisoryCgData(item: PlayoutItem, settings: AdvisorySettings, svgs: AdvisorySvgs) {
    const rating = (item.complianceRating || 'none') as ComplianceRating;
    const tpFlag = !!item.tp_flag;
    const isLive = item.type === 'live';
    const contentType = (item.content_type || 'none') as string;

    // Broadcast show tag from the row metadata.
    let showTag: string | undefined = undefined;
    if (isLive) {
        showTag = 'live';
    } else if (contentType && contentType !== 'none') {
        showTag = contentType;
    } else if (tpFlag) {
        showTag = 'telemarketing';
    }

    const advisoryText = item.complianceText || '';
    const isLogoOnly = advisoryText === '__LOGO_ONLY__' || advisoryText === 'LOGO_ONLY';
    let descriptors = item.complianceDescriptors || [];
    if ((!descriptors || descriptors.length === 0) && advisoryText && !isLogoOnly) {
        descriptors = parseDescriptorsFromText(advisoryText);
    }

    const ratingExplanationText = isLogoOnly ? '' : getGreekRatingDefaultText(rating as any);
    const ratingHoldSec = settings.cgAdvisoryConfig?.ratingHoldSec ?? 30;
    const warningHoldSec = settings.cgAdvisoryConfig?.warningHoldSec ?? 30;
    const hasAdvisoryContent = (rating !== 'none' || tpFlag || isLive || (contentType && contentType !== 'none'));

    return {
        on_air: true,
        playout_mode: 'on_air',
        is_on_air: true,
        rating: rating !== 'none' ? rating : 'none',
        rating_text: isLogoOnly ? '__LOGO_ONLY__' : ratingExplanationText,
        warning_text: isLogoOnly ? '' : advisoryText,
        text: isLogoOnly ? '' : ratingExplanationText,
        custom_text: isLogoOnly ? '__LOGO_ONLY__' : ratingExplanationText,
        explanation: hasAdvisoryContent && !isLogoOnly && rating !== 'none',
        show_explanation: hasAdvisoryContent && !isLogoOnly && rating !== 'none',
        show_station_logo: true, // Station logo is ALWAYS ON!
        warnings: hasAdvisoryContent ? descriptors : [],
        durationSec: ratingHoldSec,
        hold_time: ratingHoldSec,
        warning_hold_time: warningHoldSec,
        tp: tpFlag,
        content_type: contentType,
        is_live: isLive,
        show_tag: showTag || 'none',
        styling: settings.cgAdvisoryConfig,
        customLogoSvg: svgs.customLogoSvg || undefined,
        customLogos: Object.keys(svgs.customLogos).length > 0 ? svgs.customLogos : undefined
    };
}

/**
 * Reads the custom SVGs once per set of paths. They used to be read from
 * disk on every item (one IPC per file per cut); now a path change or
 * `invalidate()` triggers the only re-read.
 */
export function createAdvisorySvgCache(readSvg: (path: string) => Promise<string>) {
    let cachedKey: string | null = null;
    let cached: Promise<AdvisorySvgs> | null = null;

    async function load(settings: AdvisorySettings): Promise<AdvisorySvgs> {
        const config = settings.cgAdvisoryConfig;
        const svgs: AdvisorySvgs = { customLogoSvg: null, customLogos: {} };
        const logoSvgPath = config?.customLogoSvgPath;
        if (logoSvgPath) {
            try {
                svgs.customLogoSvg = await readSvg(logoSvgPath);
            } catch (err) {
                console.warn('[CasparCG] Failed to load custom logo SVG from:', logoSvgPath, err);
            }
        }
        const ratingSvgPaths = config?.customRatingSvgPaths;
        if (ratingSvgPaths && typeof ratingSvgPaths === 'object') {
            for (const [key, p] of Object.entries(ratingSvgPaths)) {
                if (!p) continue;
                try {
                    svgs.customLogos[key.toUpperCase()] = await readSvg(p);
                } catch (err) {
                    console.warn(`[CasparCG] Failed to load custom rating SVG for ${key} from:`, p, err);
                }
            }
        }
        return svgs;
    }

    return {
        get(settings: AdvisorySettings): Promise<AdvisorySvgs> {
            const config = settings.cgAdvisoryConfig;
            const key = JSON.stringify([config?.customLogoSvgPath || '', config?.customRatingSvgPaths || {}]);
            if (cached && cachedKey === key) return cached;
            cachedKey = key;
            cached = load(settings);
            return cached;
        },
        invalidate() {
            cachedKey = null;
            cached = null;
        },
    };
}
