import { describe, it, expect } from 'vitest';
import { describeError, describeErrorMessage, rawErrorText } from '../describeError';

describe('UI F-15 · describeError', () => {
  it('extracts raw text from every shape the app throws', () => {
    expect(rawErrorText('plain string')).toBe('plain string');
    expect(rawErrorText(new Error('boom'))).toBe('boom');
    expect(rawErrorText({ message: 'from message' })).toBe('from message');
    expect(rawErrorText({ error: 'from error' })).toBe('from error');
    expect(rawErrorText(null)).toBe('');
    expect(rawErrorText(undefined)).toBe('');
  });

  it('turns the reported browser-mode IPC crash into an operator sentence', () => {
    // The exact string seen in the Configurator status card during the review.
    const result = describeError(new TypeError("Cannot read properties of undefined (reading 'invoke')"));

    expect(result.kind).toBe('ipc');
    expect(result.message).toBe('This action needs the desktop app — it is not available in a browser window.');
    // The raw text is kept, never discarded.
    expect(result.detail).toContain("reading 'invoke'");
  });

  it('maps Ingestor auth failures to the setting that fixes them', () => {
    expect(describeError('HTTP 401 Unauthorized').message).toContain('API token');
    expect(describeError('HTTP 401 Unauthorized').kind).toBe('auth');
    expect(describeError('request failed: 403 Forbidden').kind).toBe('auth');
  });

  it('maps unreachable services and timeouts', () => {
    expect(describeError('error sending request for url (http://localhost:8080)').kind).toBe('network');
    expect(describeError('ECONNREFUSED 127.0.0.1:8080').message).toContain('Could not reach the Ingestor');
    expect(describeError('operation timed out').kind).toBe('timeout');
  });

  it('maps AMCP failures', () => {
    expect(describeError('404 PLAY FAILED').kind).toBe('amcp');
    expect(describeError('404 PLAY FAILED').message).toContain('could not find that media file');
    expect(describeError('502 PLAY FAILED when executing command').kind).toBe('amcp');
    expect(describeError('connection reset by peer').message).toContain('Reconnect');
  });

  it('maps filesystem failures', () => {
    expect(describeError('ENOENT: no such file or directory').kind).toBe('filesystem');
    expect(describeError('Access is denied. (os error 5)').message).toContain('denied access');
    expect(describeError('ENOSPC: no space left on device').message).toContain('disk is full');
  });

  it('passes a short readable message through alongside the fallback', () => {
    const result = describeError('Playlist name already exists', 'Could not save the playlist.');
    expect(result.message).toBe('Could not save the playlist — Playlist name already exists');
  });

  it('hides stack traces and JS type errors behind the fallback', () => {
    const stack = 'TypeError: x is not a function\n    at foo (bundle.js:1:1)';
    const result = describeError(stack, 'Could not save the playlist.');

    expect(result.message).toBe('Could not save the playlist.');
    expect(result.detail).toBe(stack);
  });

  it('falls back cleanly when nothing was thrown', () => {
    const result = describeError(undefined, 'Could not start the server.');
    expect(result.message).toBe('Could not start the server.');
    expect(result.detail).toBe('');
  });

  it('never returns an empty message', () => {
    for (const input of [null, undefined, '', 0, {}, new Error('')]) {
      expect(describeErrorMessage(input).length).toBeGreaterThan(0);
    }
  });
});
