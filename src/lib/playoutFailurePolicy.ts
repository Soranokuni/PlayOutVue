/** Failure classification is deliberately protocol-agnostic so UI policy is
 * testable and transport wording cannot accidentally turn into a red row. */
export type PlayoutFailureKind = 'content' | 'transient' | 'cancelled';

export interface PlayoutFailure {
    kind: PlayoutFailureKind;
    message: string;
}

export function classifyPlayoutFailure(error: unknown): PlayoutFailure {
    const message = String((error as { message?: string })?.message || error || 'Unknown playout failure');
    const text = message.toLowerCase();
    if (/stale|superseded|cancelled|aborted/.test(text)) return { kind: 'cancelled', message };
    if (/degenerate trim|file not found|qc not passed|mezzanine_ok=false|critical|\b404\b|\b501\b/.test(text)) {
        return { kind: 'content', message };
    }
    return { kind: 'transient', message };
}

export function shouldFlagItemFailure(failure: PlayoutFailure): boolean {
    return failure.kind === 'content';
}
