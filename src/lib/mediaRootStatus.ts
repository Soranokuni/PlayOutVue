/**
 * MEDIA-FALLBACK-HANDOFF AE-1: what `media_root_status` returns and how the
 * operator sees it (header chip, Settings → Media, the "CasparCG media path
 * differs" banner). Pure, so the mapping is unit-tested without Tauri.
 */

export type MediaRootVerified = 'strong' | 'weak' | 'mismatch' | 'missing' | 'unknown';

export interface MediaRootAdvert {
    registry_id: string;
    target_folder: string;
    host: string;
    layout: { videos: string; sidecars: string };
    marker_file: string;
    claimed: boolean;
    /** `v2` (C1) or `diagnostics` (older transcoder, weak). */
    source: string;
    data_dir: string;
}

export interface MediaRootStatus {
    advertised: MediaRootAdvert | null;
    transcoder_error: string | null;
    transcoder_local: boolean;
    proposal: string | null;
    local_root: string;
    local_root_exists: boolean;
    marker: { registry_id: string; data_dir: string } | null;
    verified: MediaRootVerified;
    caspar_config_path: string | null;
    caspar_media_path: string | null;
    caspar_matches: boolean | null;
}

export type ChipTone = 'ready' | 'warning' | 'error' | 'processing' | 'offline';

export interface MediaRootView {
    /** Nothing to say: no transcoder, nothing verified before. */
    hidden: boolean;
    tone: ChipTone;
    /** Two or three words for the chip. */
    label: string;
    /** One sentence for the tooltip / Settings. */
    detail: string;
}

/** Lower-case, forward slashes, no trailing slash. */
export function normalizeFolder(path: string | null | undefined): string {
    return (path ?? '').trim().replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
}

export function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
    const na = normalizeFolder(a);
    return na !== '' && na === normalizeFolder(b);
}

export function describeMediaRoot(status: MediaRootStatus | null): MediaRootView {
    if (!status) return { hidden: true, tone: 'offline', label: '', detail: '' };
    const where = status.local_root || 'the Local media path';
    switch (status.verified) {
        case 'strong':
            return {
                hidden: false,
                tone: 'ready',
                label: 'Media root',
                detail: status.advertised
                    ? `Media root verified: ${where} is the transcoder's folder (registry marker matches).`
                    : `Media root verified earlier: ${where} carries the same registry marker. The transcoder is not answering now.`,
            };
        case 'weak':
            return {
                hidden: false,
                tone: 'warning',
                label: 'Media root (weak)',
                detail: `Media root verified (weak): this transcoder is too old to advertise its root, so ${where} was matched by its data folder only.`,
            };
        case 'mismatch':
            return {
                hidden: false,
                tone: 'error',
                label: 'Wrong media root',
                detail: `${where} belongs to a different transcoder registry. Takes of transcoder clips are refused until the path is fixed in Settings → Media.`,
            };
        case 'missing':
            return {
                hidden: false,
                tone: 'error',
                label: 'Media root missing',
                detail: status.local_root_exists
                    ? `${where} has no transcoder registry marker: it is not the transcoder's media root.`
                    : `${where} is not reachable from this PC.`,
            };
        default:
            return { hidden: true, tone: 'offline', label: '', detail: '' };
    }
}

/** Offer the Fix banner: the root is verified and CasparCG looks elsewhere. */
export function shouldOfferCasparFix(status: MediaRootStatus | null): boolean {
    if (!status) return false;
    return status.caspar_matches === false
        && status.local_root_exists
        && (status.verified === 'strong' || status.verified === 'weak');
}

/** A loopback transcoder's own folder, when it differs from what is set. */
export function proposedLocalRoot(status: MediaRootStatus | null, current: string): string | null {
    const proposal = status?.proposal?.trim();
    if (!proposal) return null;
    return sameFolder(proposal, current) ? null : proposal;
}

/** The registry id to remember after a successful verification. */
export function registryIdToRemember(status: MediaRootStatus | null): string | null {
    if (!status || (status.verified !== 'strong' && status.verified !== 'weak')) return null;
    return status.advertised?.registry_id || status.marker?.registry_id || null;
}
