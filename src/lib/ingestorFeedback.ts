/**
 * Operator-facing interpretation of PlayoutTranscode responses.
 *
 * Pure functions only (no Tauri, no Pinia) so they can be unit-tested and
 * shared by the media library, the Recycle Bin modal and the settings dialog.
 */

/**
 * What a purge actually did, as reported by the Ingestor (`StructuredPurgeResult`).
 *
 * Since the 2026-09 remediation, purging a row whose status is not `ready`
 * deletes the registry entry but keeps the file on disk (for a `processing` or
 * `error` row the stored path is still the *source* in the watch folder). The
 * row disappearing therefore no longer implies the media is gone.
 */
export interface PurgeOutcome {
    operation: string;
    rows_deleted: number;
    media_removed: boolean;
    sidecar_removed: boolean;
    skipped_referenced_files: string[];
    cleanup_failures: string[];
    warnings: string[];
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asCount(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Coerce whatever the backend handed back (a structured result, an older
 * service's ad-hoc body, or nothing at all) into a well-formed outcome.
 */
export function normalizePurgeOutcome(raw: unknown): PurgeOutcome {
    const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        operation: typeof src.operation === 'string' ? src.operation : '',
        rows_deleted: asCount(src.rows_deleted),
        media_removed: src.media_removed === true,
        sidecar_removed: src.sidecar_removed === true,
        skipped_referenced_files: asStringArray(src.skipped_referenced_files),
        cleanup_failures: asStringArray(src.cleanup_failures),
        warnings: asStringArray(src.warnings),
    };
}

/**
 * A warning to show after a purge, or `null` when the purge did exactly what
 * the operator expected (rows and media gone, nothing left behind).
 */
export function describePurgeOutcome(outcome: PurgeOutcome, subject: string): string | null {
    const lines: string[] = [];

    if (outcome.rows_deleted > 0 && !outcome.media_removed) {
        lines.push(
            `The registry entry for ${subject} was removed, but the media file was kept on disk (the asset was not in a ready state, so the stored path may still be a source file).`
        );
    }
    if (outcome.skipped_referenced_files.length > 0) {
        const n = outcome.skipped_referenced_files.length;
        lines.push(`${n} file${n === 1 ? ' was' : 's were'} kept because subclips still reference ${n === 1 ? 'it' : 'them'}.`);
    }
    if (outcome.cleanup_failures.length > 0) {
        const n = outcome.cleanup_failures.length;
        lines.push(`${n} file${n === 1 ? '' : 's'} could not be deleted on the ingest host; check the service log.`);
    }
    for (const warning of outcome.warnings) {
        const text = warning.trim();
        if (text && !lines.includes(text)) lines.push(text);
    }

    return lines.length ? lines.join('\n') : null;
}
