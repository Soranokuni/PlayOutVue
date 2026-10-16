import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const invokeMock = vi.fn();
const askMock = vi.fn();
const messageMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: (...args: unknown[]) => askMock(...args),
  message: (...args: unknown[]) => messageMock(...args),
}));

import { useMediaRootStore } from '../mediaRoot';
import { useSettingsStore, sanitizeSettingsState } from '../settings';
import {
  describeMediaRoot,
  proposedLocalRoot,
  registryIdToRemember,
  shouldOfferCasparFix,
  type MediaRootStatus,
} from '../../lib/mediaRootStatus';
import {
  getAdvertisedMediaRoot,
  isMediaRootError,
  mediaRootErrorText,
  resetAdvertisedMediaRoot,
} from '../../lib/mediaRootContext';

function status(over: Partial<MediaRootStatus> = {}): MediaRootStatus {
  return {
    advertised: {
      registry_id: 'reg-a',
      target_folder: 'D:\\Mezz',
      host: 'TX01',
      layout: { videos: 'videos', sidecars: 'sidecars' },
      marker_file: '.playouttranscode-registry.json',
      claimed: true,
      source: 'v2',
      data_dir: '',
    },
    transcoder_error: null,
    transcoder_local: true,
    proposal: 'D:\\Mezz',
    local_root: 'D:/Mezz',
    local_root_exists: true,
    marker: { registry_id: 'reg-a', data_dir: 'C:/PT' },
    verified: 'strong',
    caspar_config_path: 'D:/casparcg/casparcg.config',
    caspar_media_path: 'D:/casparcg/media/',
    caspar_matches: false,
    ...over,
  };
}

describe('media root status mapping', () => {
  it('maps every verification result to a chip', () => {
    expect(describeMediaRoot(null).hidden).toBe(true);
    expect(describeMediaRoot(status()).tone).toBe('ready');
    expect(describeMediaRoot(status({ verified: 'weak' })).tone).toBe('warning');
    expect(describeMediaRoot(status({ verified: 'mismatch' })).tone).toBe('error');
    const missing = describeMediaRoot(status({ verified: 'missing', local_root_exists: false }));
    expect(missing.tone).toBe('error');
    expect(missing.detail).toMatch(/not reachable/);
    expect(describeMediaRoot(status({ verified: 'unknown' })).hidden).toBe(true);
    // Transcoder offline, verified by the remembered registry id.
    expect(describeMediaRoot(status({ advertised: null })).detail).toMatch(/not answering/);
  });

  it('offers the CasparCG fix only for a verified root CasparCG does not use', () => {
    expect(shouldOfferCasparFix(status())).toBe(true);
    expect(shouldOfferCasparFix(status({ verified: 'weak' }))).toBe(true);
    expect(shouldOfferCasparFix(status({ caspar_matches: true }))).toBe(false);
    expect(shouldOfferCasparFix(status({ caspar_matches: null }))).toBe(false);
    expect(shouldOfferCasparFix(status({ verified: 'mismatch' }))).toBe(false);
    expect(shouldOfferCasparFix(status({ local_root_exists: false }))).toBe(false);
  });

  it('proposes the loopback folder only when it differs from the draft', () => {
    expect(proposedLocalRoot(status(), 'C:/Other')).toBe('D:\\Mezz');
    expect(proposedLocalRoot(status(), 'd:/mezz/')).toBeNull();
    expect(proposedLocalRoot(status({ proposal: null }), 'C:/Other')).toBeNull();
  });

  it('remembers the advertised id, or the marker id on the weak path', () => {
    expect(registryIdToRemember(status())).toBe('reg-a');
    expect(registryIdToRemember(status({ verified: 'weak', advertised: { ...status().advertised!, registry_id: '' } }))).toBe('reg-a');
    expect(registryIdToRemember(status({ verified: 'mismatch' }))).toBeNull();
  });

  it('recognises resolver errors that must fail the take', () => {
    const error = new Error("[media-root] 'videos/a.mxf' is not under the Local media path 'E:/'");
    expect(isMediaRootError(error)).toBe(true);
    expect(isMediaRootError('CasparCG media file not found')).toBe(false);
    expect(mediaRootErrorText(error)).toMatch(/^'videos\/a.mxf'/);
  });

  it('sanitises the new settings keys', () => {
    const defaults = { mediaRootRegistryId: '', mediaRootVerifiedAt: 0 };
    expect(sanitizeSettingsState({ mediaRootRegistryId: 'reg a\r\n', mediaRootVerifiedAt: -5 }, defaults))
      .toMatchObject({ mediaRootRegistryId: '', mediaRootVerifiedAt: 0 });
    expect(sanitizeSettingsState({ mediaRootRegistryId: 'reg-a', mediaRootVerifiedAt: 12.4 }, defaults))
      .toMatchObject({ mediaRootRegistryId: 'reg-a', mediaRootVerifiedAt: 12 });
  });
});

describe('media root store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    invokeMock.mockReset();
    askMock.mockReset();
    messageMock.mockReset();
    resetAdvertisedMediaRoot();
  });

  it('refresh verifies the saved path, remembers the registry and arms the resolver', async () => {
    const settings = useSettingsStore();
    settings.updateSettings({ localMediaPath: 'D:/Mezz' });
    invokeMock.mockResolvedValueOnce(status());
    const store = useMediaRootStore();
    await store.refresh();
    expect(invokeMock).toHaveBeenCalledWith('media_root_status', { localRoot: 'D:/Mezz', knownRegistryId: null });
    expect(settings.mediaRootRegistryId).toBe('reg-a');
    expect(settings.mediaRootVerifiedAt).toBeGreaterThan(0);
    expect(getAdvertisedMediaRoot()).toBe('D:\\Mezz');
    expect(store.view.label).toBe('Media root');
    expect(store.offerCasparFix).toBe(true);
  });

  it('a probe of a draft path does not overwrite what is remembered', async () => {
    const settings = useSettingsStore();
    settings.updateSettings({ localMediaPath: 'D:/Mezz', mediaRootRegistryId: 'reg-a' });
    invokeMock.mockResolvedValueOnce(status({ local_root: 'E:/Elsewhere', verified: 'mismatch' }));
    const store = useMediaRootStore();
    const result = await store.probe('E:/Elsewhere');
    expect(invokeMock).toHaveBeenCalledWith('media_root_status', { localRoot: 'E:/Elsewhere', knownRegistryId: 'reg-a' });
    expect(result.verified).toBe('mismatch');
    expect(store.status).toBeNull();
    expect(settings.mediaRootRegistryId).toBe('reg-a');
  });

  it('keeps the last advertised root while the transcoder is offline', async () => {
    useSettingsStore().updateSettings({ localMediaPath: 'D:/Mezz' });
    const store = useMediaRootStore();
    invokeMock.mockResolvedValueOnce(status());
    await store.refresh();
    invokeMock.mockResolvedValueOnce(status({ advertised: null, transcoder_error: 'connection refused' }));
    await store.refresh();
    expect(getAdvertisedMediaRoot()).toBe('D:\\Mezz');
  });

  it('Fix asks first and does nothing when the operator cancels', async () => {
    useSettingsStore().updateSettings({ localMediaPath: 'D:/Mezz' });
    const store = useMediaRootStore();
    invokeMock.mockResolvedValueOnce(status());
    await store.refresh();
    askMock.mockResolvedValueOnce(false);
    expect(await store.fixCasparMediaPath(false)).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('Fix rewrites the config after confirmation and re-reads the status', async () => {
    useSettingsStore().updateSettings({ localMediaPath: 'D:/Mezz' });
    const store = useMediaRootStore();
    invokeMock.mockResolvedValueOnce(status());
    await store.refresh();
    askMock.mockResolvedValueOnce(true);
    invokeMock.mockResolvedValueOnce({
      config_path: 'D:/casparcg/casparcg.config',
      backup_path: 'D:/casparcg/casparcg.config.bak-20261016-100000',
      media_path: 'D:/Mezz/',
      restarted: true,
      restart_error: null,
    });
    invokeMock.mockResolvedValueOnce(status({ caspar_media_path: 'D:/Mezz/', caspar_matches: true }));
    expect(await store.fixCasparMediaPath(false)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('fix_caspar_media_path', { root: 'D:/Mezz', onAir: false });
    expect(store.offerCasparFix).toBe(false);
  });

  it('Fix is refused on air without asking', async () => {
    useSettingsStore().updateSettings({ localMediaPath: 'D:/Mezz' });
    const store = useMediaRootStore();
    invokeMock.mockResolvedValueOnce(status());
    await store.refresh();
    expect(await store.fixCasparMediaPath(true)).toBe(false);
    expect(askMock).not.toHaveBeenCalled();
    expect(messageMock).toHaveBeenCalled();
  });

  it('Dismiss hides the banner for that CasparCG path', async () => {
    useSettingsStore().updateSettings({ localMediaPath: 'D:/Mezz' });
    const store = useMediaRootStore();
    invokeMock.mockResolvedValueOnce(status());
    await store.refresh();
    store.dismissCasparFix();
    expect(store.offerCasparFix).toBe(false);
    invokeMock.mockResolvedValueOnce(status({ caspar_media_path: 'E:/other/' }));
    await store.refresh();
    expect(store.offerCasparFix).toBe(true);
  });
});
