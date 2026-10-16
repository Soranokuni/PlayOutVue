import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const applyMock = vi.fn(async () => {});
const armedMock = vi.fn(async (): Promise<boolean | null> => true);
vi.mock('../caspar', () => ({
  applyForkFallbackSettings: () => applyMock(),
  readForkFallbackArmed: () => armedMock(),
  engineMode: ref('fork'),
  isCasparConnected: ref(true),
}));

import { runFallbackSelfTest, afterTemplatesDeployed } from '../fallbackMonitor';
import { useSettingsStore } from '../../stores/settings';
import { pickHeadline } from '../../lib/mediaHealth';
import {
  describeFallback,
  describeFallbackOnAir,
  fallbackHealth,
  normalizeFallbackClip,
  resetFallbackHealth,
  type FallbackSelfTest,
} from '../../lib/fallbackHealth';

const okClip = { ok: true, path: 'D:/fallback/slate.mov', local: true, duration_ms: 10_000, reason: null };

function selfTest(over: Partial<FallbackSelfTest> = {}): FallbackSelfTest {
  return { clip: okClip, fillers: null, ...over };
}

describe('fallback health', () => {
  beforeEach(() => resetFallbackHealth());

  it('sends absolute paths with forward slashes and leaves media names alone', () => {
    expect(normalizeFallbackClip('D:\\fallback\\slate.mov')).toBe('D:/fallback/slate.mov');
    expect(normalizeFallbackClip(' playout/emergency ')).toBe('playout/emergency');
    expect(normalizeFallbackClip(null)).toBe('');
  });

  it('says nothing on a stock engine', () => {
    fallbackHealth.engineSet = false;
    expect(describeFallback(fallbackHealth, false)).toBeNull();
  });

  it('turns red when the engine has no fallback armed', () => {
    fallbackHealth.engineSet = false;
    const item = describeFallback(fallbackHealth, true)!;
    expect(item.tone).toBe('error');
    expect(item.label).toBe('No fallback');
  });

  it('turns red for a clip that fails its self-test, amber for a non-local clip', () => {
    fallbackHealth.engineSet = true;
    fallbackHealth.test = selfTest({ clip: { ...okClip, ok: false, reason: 'does not probe' } });
    expect(describeFallback(fallbackHealth, true)!.tone).toBe('error');
    fallbackHealth.test = selfTest({ clip: { ...okClip, local: false } });
    expect(describeFallback(fallbackHealth, true)!.label).toBe('Fallback not local');
  });

  it('says "On fillers" while they air, and takes the chip over', () => {
    fallbackHealth.engineSet = true;
    fallbackHealth.mode = 'list';
    expect(describeFallbackOnAir(fallbackHealth, true)).toBeNull();
    fallbackHealth.onAir = { since: 1, file: 'promo_a.mov', reason: 'ended', count: 2 };
    const item = describeFallbackOnAir(fallbackHealth, true)!;
    expect(item.label).toBe('On fillers');
    expect(item.detail).toContain('promo_a.mov');
    fallbackHealth.rundownFinished = true;
    expect(describeFallbackOnAir(fallbackHealth, true)!.label).toBe('Finished · on fillers');
    const red = { key: 'media-root', tone: 'error' as const, label: 'Wrong media root', detail: '', section: 'media' };
    expect(pickHeadline([red, item])!.key).toBe('fallback-on-air');
    expect(describeFallbackOnAir(fallbackHealth, false)).toBeNull();
  });

  it('is green when armed and tested', () => {
    fallbackHealth.engineSet = true;
    fallbackHealth.mode = 'clip';
    fallbackHealth.target = 'D:/fallback/slate.mov';
    fallbackHealth.test = selfTest();
    const item = describeFallback(fallbackHealth, true)!;
    expect(item.tone).toBe('ready');
    expect(item.detail).toContain('D:/fallback/slate.mov');
  });
});

describe('fallback self-test', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetFallbackHealth();
    invokeMock.mockReset();
    applyMock.mockClear();
    armedMock.mockReset();
    armedMock.mockResolvedValue(true);
  });

  it('probes the configured clip and media root and stores the result', async () => {
    useSettingsStore().updateSettings({ forkFallbackClip: 'D:/fallback/slate.mov', localMediaPath: 'D:/Mezz' });
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'fallback_self_test' ? selfTest() : undefined));
    await runFallbackSelfTest();
    expect(invokeMock).toHaveBeenCalledWith('fallback_self_test', {
      clip: 'D:/fallback/slate.mov',
      mediaRoot: 'D:/Mezz',
      fillerFolder: null,
    });
    expect(fallbackHealth.test?.clip?.ok).toBe(true);
    expect(fallbackHealth.testedAt).toBeGreaterThan(0);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('re-sends FALLBACK once when the engine reports it unset (F4)', async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'fallback_self_test' ? selfTest() : undefined));
    armedMock.mockResolvedValueOnce(false);
    await runFallbackSelfTest();
    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  it('re-arms and re-tests after Deploy templates', async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'fallback_self_test' ? selfTest() : undefined));
    await afterTemplatesDeployed();
    expect(applyMock).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith('fallback_self_test', expect.anything());
  });

  it('records a failed run without throwing', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fallback_self_test') throw new Error('deadline');
      return undefined;
    });
    expect(await runFallbackSelfTest()).toBeNull();
    expect(fallbackHealth.testError).toBe('deadline');
  });
});
