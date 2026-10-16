/**
 * MEDIA-FALLBACK-HANDOFF AE-1: the transcoder's advertised media root (its own
 * view of `target_folder`), handed to `prepare_caspar_media_path` so registry
 * assets resolve strictly against the local media root.
 *
 * A plain module, not a store: `playoutDispatch.ts` and `caspar.ts` read it on
 * every take. The last known value survives a transcoder outage on purpose,
 * so a chain keeps resolving the same way while the library is offline.
 */

let advertisedRoot = '';

export function getAdvertisedMediaRoot(): string {
    return advertisedRoot;
}

export function setAdvertisedMediaRoot(value: string | null | undefined): void {
    const next = (value ?? '').trim();
    if (next) advertisedRoot = next;
}

/** Tests only. */
export function resetAdvertisedMediaRoot(): void {
    advertisedRoot = '';
}

/** Prefix of a resolver error that must fail the take, never fall back to a guess. */
export const MEDIA_ROOT_ERROR_PREFIX = '[media-root]';

export function isMediaRootError(error: unknown): boolean {
    const text = typeof error === 'string' ? error : String((error as any)?.message ?? error ?? '');
    return text.includes(MEDIA_ROOT_ERROR_PREFIX);
}

/** The operator-facing part of a resolver error, without the prefix. */
export function mediaRootErrorText(error: unknown): string {
    const text = typeof error === 'string' ? error : String((error as any)?.message ?? error ?? '');
    return text.replace(MEDIA_ROOT_ERROR_PREFIX, '').trim();
}
