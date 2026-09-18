import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useIngestorStatusStore } from '../ingestorStatus';
import { useSettingsStore } from '../settings';

const mockInvoke = vi.fn(() => Promise.resolve());

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...(args as [])),
}));

// PlayoutTranscode's health endpoint is exempt from the API token, so the
// heartbeat can be green while every real call is answered 401. The backend
// reports that separately and the store must surface it as its own state.
describe('ingestorStatus auth rejection', () => {
    beforeEach(() => {
        mockInvoke.mockClear();
        setActivePinia(createPinia());
    });

    it('is only "auth rejected" while online', () => {
        const status = useIngestorStatusStore();
        status.setAuthRejected(true);
        expect(status.authRejected).toBe(true);
        expect(status.isAuthRejected).toBe(false);
        status.setOnline(true);
        expect(status.isAuthRejected).toBe(true);
        status.setOnline(false);
        expect(status.isAuthRejected).toBe(false);
    });

    it('logs once on the transition to rejected and clears silently', () => {
        const settings = useSettingsStore();
        settings.debugMode = true;
        const status = useIngestorStatusStore();
        status.setOnline(true);

        status.setAuthRejected(true);
        status.setAuthRejected(true);
        expect(status.logEntries.filter((e) => e.scope === 'ingestor-auth')).toHaveLength(1);
        expect(status.logEntries[0]!.level).toBe('error');
        expect(status.logEntries[0]!.message).toContain('401');

        status.setAuthRejected(false);
        expect(status.isAuthRejected).toBe(false);
        expect(status.logEntries.filter((e) => e.scope === 'ingestor-auth')).toHaveLength(1);

        // Every log line also reaches the backend file logger.
        expect(mockInvoke).toHaveBeenCalledWith('push_diagnostic_log', expect.objectContaining({ level: 'error', scope: 'ingestor-auth' }));
    });

    it('does not persist the auth flag between sessions', () => {
        // `persist.pick` only covers online/lastSeenAt; a stale "rejected" flag
        // must never be restored ahead of the first heartbeat.
        const store = useIngestorStatusStore();
        const pick = (store.$options as unknown as { persist?: { pick?: string[] } })?.persist?.pick;
        if (pick) {
            expect(pick).not.toContain('authRejected');
        }
        expect(store.authRejected).toBe(false);
    });
});
