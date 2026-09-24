/**
 * Content type: what a clip *is*, so the operator can see at a glance where
 * the films, the shows, the ad breaks and the kids' block sit in a rundown.
 *
 * The one list. Rows, both context menus, the library, the rating string sent
 * to the transcoder and the CG show tag all read it from here. It absorbed the
 * old separate "Commercial tag" (spot / telemarketing): a row that still
 * carries only that legacy tag reads as the matching type through
 * `effectiveContentType`.
 */

export const CONTENT_TYPE_IDS = [
    'movie',
    'show',
    'documentary',
    'news',
    'kids',
    'spot',
    'promo',
    'jingle',
    'telemarketing',
] as const;

export type ContentTypeId = (typeof CONTENT_TYPE_IDS)[number];
export type ContentType = ContentTypeId | 'none';

export interface ContentTypeMeta {
    id: ContentTypeId;
    /** Menu and tooltip label. */
    label: string;
    /** Short uppercase word for chips and the two-line library row. */
    short: string;
    /** Interstitial (ads, promos, idents) rather than programme content. */
    interstitial: boolean;
}

export const CONTENT_TYPES: readonly ContentTypeMeta[] = [
    { id: 'movie', label: 'Movie', short: 'MOVIE', interstitial: false },
    { id: 'show', label: 'Series / Show', short: 'SERIES', interstitial: false },
    { id: 'documentary', label: 'Documentary', short: 'DOCUMENTARY', interstitial: false },
    { id: 'news', label: 'News', short: 'NEWS', interstitial: false },
    { id: 'kids', label: 'Kids / Animation', short: 'KIDS', interstitial: false },
    { id: 'spot', label: 'Spot (ad)', short: 'SPOT', interstitial: true },
    { id: 'promo', label: 'Promo / Trailer', short: 'PROMO', interstitial: true },
    { id: 'jingle', label: 'Jingle / Ident', short: 'JINGLE', interstitial: true },
    { id: 'telemarketing', label: 'Telemarketing', short: 'TELEMARKETING', interstitial: true },
];

const META = new Map(CONTENT_TYPES.map((t) => [t.id, t]));

export function isContentTypeId(value: unknown): value is ContentTypeId {
    return typeof value === 'string' && META.has(value as ContentTypeId);
}

/** Tolerant parse of a stored value (any case, legacy aliases) to a known type. */
export function parseContentType(raw: string | null | undefined): ContentType {
    const value = (raw || '').trim().toLowerCase();
    if (isContentTypeId(value)) return value;
    if (value === 'series') return 'show';
    if (value === 'kid' || value === 'animation' || value === 'children') return 'kids';
    if (value === 'ident' || value === 'bumper') return 'jingle';
    if (value === 'trailer') return 'promo';
    if (value === 'ad' || value === 'commercial') return 'spot';
    return 'none';
}

export function contentTypeMeta(type: string | null | undefined): ContentTypeMeta | undefined {
    return META.get(type as ContentTypeId);
}

export function contentTypeLabel(type: string | null | undefined): string {
    return contentTypeMeta(type)?.label ?? '';
}

/**
 * The type a row or asset should be shown as: its own content type, else the
 * legacy commercial tag (spot / telemarketing) it may still carry.
 */
export function effectiveContentType(contentType: string | null | undefined, legacyIndicator?: string | null): ContentType {
    const own = parseContentType(contentType);
    if (own !== 'none') return own;
    return legacyIndicator === 'spot' || legacyIndicator === 'telemarketing' ? legacyIndicator : 'none';
}

/**
 * The legacy commercial tag to keep in step with a content type, so a playlist
 * saved now still shows its ad breaks in an older build.
 */
export function legacyIndicatorFor(type: ContentType): 'none' | 'spot' | 'telemarketing' {
    return type === 'spot' || type === 'telemarketing' ? type : 'none';
}
