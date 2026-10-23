/**
 * Lets the playout engine release media before the library deletes it.
 *
 * Windows refuses to delete or move a file CasparCG holds open, and every
 * clip waiting in the fork's queue holds an open decoder (the transcoder
 * only logs a warning). The library calls `releaseAssetsBeforeDelete`
 * before a trash or purge; the playout service registers the handler. The
 * indirection keeps the library store from importing the playout service.
 */
/** Returns `null` when nothing had to be released. */
type ReleaseHandler = (assetUuids: readonly string[]) => Promise<void> | null;

let handler: ReleaseHandler | null = null;

export function registerAssetReleaseHandler(next: ReleaseHandler | null): void {
    handler = next;
}

/**
 * `null` when there is nothing to release, so the caller adds no await to
 * its delete path. The promise never rejects: a failed release must not
 * block the delete itself.
 */
export function releaseAssetsBeforeDelete(assetUuids: readonly string[]): Promise<void> | null {
    if (!handler || assetUuids.length === 0) return null;
    let pending: Promise<void> | null;
    try {
        pending = handler(assetUuids);
    } catch (error) {
        console.warn('[assetRelease] Releasing queued media failed', error);
        return null;
    }
    return pending?.catch((error) => {
        console.warn('[assetRelease] Releasing queued media failed', error);
    }) ?? null;
}
