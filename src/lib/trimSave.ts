/**
 * Saving an asset trim from the trimmer (TRIM-CONTRACT-AUDIT C-5).
 *
 * The rundown used to be updated *before* the transcoder was asked, and was
 * not rolled back when it refused. The rows then played the rejected window
 * until the next library poll put the old one back, with nothing shown. The
 * usual refusal is 422 "OUT beyond duration": the panel's end comes from
 * `<video>.duration`, which can run past the registry's `duration_ms`.
 *
 * So the store is written only once the save has been accepted, and a server
 * asset's OUT is clamped to its registry duration before it is sent.
 */

export interface TrimSaveTarget {
    id?: string;
    uuid?: string;
    path?: string;
    /** Registry file duration; the server rejects an OUT beyond it. */
    duration_ms?: number;
}

export interface TrimSaveDeps {
    invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    /** Apply the accepted trim to the rundown rows of this asset. */
    applyToRundown: (identifier: { id?: string; uuid?: string }, inMs: number, outMs: number) => void;
}

export const hasServerIdentity = (uuid?: string): uuid is string =>
    !!uuid && !uuid.startsWith('local:') && !uuid.startsWith('local-subclip:');

const isLocalFilePath = (path?: string) => !!path && !/^https?:/i.test(path);

/**
 * The window that will be saved: integer ms, and for a server asset an OUT no
 * later than its registry duration. Throws when no valid window is left.
 */
export const resolveTrimToSave = (target: TrimSaveTarget, inMs: number, outMs: number) => {
    const registryMs = hasServerIdentity(target.uuid) && target.duration_ms && target.duration_ms > 0
        ? Math.round(target.duration_ms)
        : 0;
    const trimIn = Math.max(0, Math.round(inMs));
    let trimOut = Math.round(outMs);
    if (registryMs > 0 && trimOut > registryMs) trimOut = registryMs;
    if (!(trimOut > trimIn)) {
        throw new Error('OUT point must be greater than IN point.');
    }
    return { inMs: trimIn, outMs: trimOut, clamped: trimOut !== Math.round(outMs) };
};

/** Persist the trim, then apply it to the rundown. Nothing is applied on failure. */
export const saveAssetTrim = async (
    target: TrimSaveTarget,
    inMs: number,
    outMs: number,
    deps: TrimSaveDeps
) => {
    const trim = resolveTrimToSave(target, inMs, outMs);

    if (hasServerIdentity(target.uuid)) {
        await deps.invoke('update_ingestor_trim', {
            uuid: target.uuid,
            trim_in_ms: trim.inMs,
            trim_out_ms: trim.outMs,
            api_base_url_override: null
        });
    } else if (isLocalFilePath(target.path)) {
        await deps.invoke('save_media_trim_profile', {
            path: target.path,
            inMs: trim.inMs,
            outMs: trim.outMs
        });
    }

    deps.applyToRundown({ id: target.id, uuid: target.uuid }, trim.inMs, trim.outMs);
    return trim;
};
