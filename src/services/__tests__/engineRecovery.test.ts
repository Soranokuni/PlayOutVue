import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Field report 2026-09-23: CasparCG killed from Task Manager with a clip on
 * air. The rundown kept "rolling" on the wall clock, the relaunched engine
 * stayed black (no resume), and the next manual take played without the
 * station ID or advisories because the advisory template was believed to be
 * loaded and every apply became a CG UPDATE into an empty layer.
 */

const EMPTY_LAYER = '201 INFO OK\r\n<layer><foreground><producer>empty</producer></foreground></layer>';

type InvokeArgs = Record<string, any> | undefined;
const calls: Array<{ cmd: string; args: InvokeArgs }> = [];
let layer32 = EMPTY_LAYER;
let cgUpdateFails = false;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: InvokeArgs) => {
    calls.push({ cmd, args });
    if (cmd === 'caspar_send_command') {
      const amcp = String(args?.cmd || '');
      if (amcp === 'INFO 1-10' || amcp === 'INFO 1-33') return EMPTY_LAYER;
      if (amcp === 'INFO 1-32') return layer32;
      return '201 INFO OK';
    }
    if (cmd === 'caspar_cg_update' && cgUpdateFails) throw new Error('Error (code 404)\n404 CG UPDATE FAILED');
    if (cmd === 'prepare_caspar_media_path') return String(args?.path || '');
    return null;
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/playoutDispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/playoutDispatch')>()),
  dispatchPlay: vi.fn().mockResolvedValue({ durationMs: 19_000, expectedOutMs: 19_000 }),
  dispatchLoadbg: vi.fn().mockResolvedValue({ durationMs: 60_000, expectedOutMs: 60_000 }),
}));

import { setActivePinia, createPinia } from 'pinia';
import { dispatchPlay } from '../../lib/playoutDispatch';

const item = (id: string) =>
  ({
    id,
    playoutvueId: id,
    type: 'video',
    filename: `${id}.mp4`,
    path: `D:/media/${id}.mp4`,
    duration_ms: 60_000,
    trim_in_ms: 0,
    trim_out_ms: 60_000,
    ingestorStatus: 'ready',
    complianceRating: 'K12',
  }) as any;

const crashed = { state: 'crashed', exitCode: 1, circuitBreakerTripped: false, lastError: null } as any;

async function loadService() {
  vi.resetModules();
  const mod = await import('../caspar');
  const { useSettingsStore } = await import('../../stores/settings');
  return { ...mod, settings: useSettingsStore() };
}

/** Put `b` on air 42 s into a 60 s clip, with the advisory template loaded. */
async function onAir(mod: Awaited<ReturnType<typeof loadService>>) {
  mod.__playoutQueueTestHooks.setState([item('a'), item('b'), item('c')], 'b', true);
  mod.isCasparConnected.value = true;
  mod.currentCasparMs.value = 42_000;
  mod.currentCasparDurationMs.value = 60_000;
  await mod.casparPlayoutService.applyComplianceForItem!(item('b'));
}

const cgAddsOnLayer = (layer: number) =>
  calls.filter((c) => c.cmd === 'caspar_cg_add' && c.args?.layer === layer).length;

describe('engine-loss recovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    calls.length = 0;
    layer32 = EMPTY_LAYER;
    cgUpdateFails = false;
    vi.mocked(dispatchPlay).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('freezes on loss, then resumes the clip and restores the graphics on the relaunched engine', async () => {
    const mod = await loadService();
    await onAir(mod);
    expect(cgAddsOnLayer(32)).toBe(1);

    mod.casparPlayoutService.handleProcessStateEvent!(crashed);
    await vi.advanceTimersByTimeAsync(1600);

    expect(mod.engineRecovery.value.phase).toBe('outage');
    expect(mod.isCasparPlaying.value).toBe(false);
    // The Rust advance is paused so its deadline cannot fire into a dead engine.
    expect(calls.some((c) => c.cmd === 'caspar_set_playback_paused' && c.args?.paused === true)).toBe(true);

    // Nothing advances during the outage (end guard, watchdog, stale event).
    await mod.advanceNext(true, 'b');
    expect(dispatchPlay).not.toHaveBeenCalled();

    // The relaunched engine answers: fresh, empty layers.
    const connected = mod.casparPlayoutService.connect();
    await vi.advanceTimersByTimeAsync(5000);
    await connected;

    expect(dispatchPlay).toHaveBeenCalledTimes(1);
    const [played, , , , seekMs] = vi.mocked(dispatchPlay).mock.calls[0]!;
    expect((played as any).id).toBe('b');
    expect(seekMs).toBe(41_000);
    expect(mod.isCasparPlaying.value).toBe(true);
    // The clock continues from the resume point, over the whole item.
    expect(mod.currentCasparDurationMs.value).toBe(60_000);
    expect(mod.engineRecovery.value.phase).toBe('restored');
    // Advisory / station ID re-added on the new engine, not CG UPDATEd into nothing.
    expect(cgAddsOnLayer(32)).toBeGreaterThanOrEqual(2);
  });

  it('holds off air when automatic resume is disabled, but still restores the station ID', async () => {
    const mod = await loadService();
    mod.settings.autoResumeAfterRestart = false;
    await onAir(mod);

    mod.casparPlayoutService.handleProcessStateEvent!(crashed);
    await vi.advanceTimersByTimeAsync(1600);
    const connected = mod.casparPlayoutService.connect();
    await vi.advanceTimersByTimeAsync(5000);
    await connected;

    expect(dispatchPlay).not.toHaveBeenCalled();
    expect(mod.engineRecovery.value.phase).toBe('held');
    expect(mod.isCasparPlaying.value).toBe(false);
    expect(cgAddsOnLayer(32)).toBe(2);
  });

  it('an operator stop during the outage cancels the automatic resume', async () => {
    const mod = await loadService();
    await onAir(mod);
    mod.casparPlayoutService.handleProcessStateEvent!(crashed);
    await vi.advanceTimersByTimeAsync(1600);
    expect(mod.engineRecovery.value.phase).toBe('outage');

    await mod.casparPlayoutService.stop();
    expect(mod.engineRecovery.value.phase).toBe('idle');

    const connected = mod.casparPlayoutService.connect();
    await vi.advanceTimersByTimeAsync(5000);
    await connected;
    expect(dispatchPlay).not.toHaveBeenCalled();
  });

  it('a transport blip with the engine still ticking is not an outage', async () => {
    const mod = await loadService();
    await onAir(mod);
    // Status poll glitch: 'starting' without an exit code, reconnected quickly.
    mod.casparPlayoutService.handleProcessStateEvent!({ state: 'starting', exitCode: null } as any);
    mod.isCasparConnected.value = true;
    await vi.advanceTimersByTimeAsync(1600);
    expect(mod.engineRecovery.value.phase).toBe('idle');
    expect(mod.isCasparPlaying.value).toBe(true);
  });

  it('a failed CG UPDATE re-adds the advisory template instead of leaving the layer empty', async () => {
    const mod = await loadService();
    await onAir(mod);
    expect(cgAddsOnLayer(32)).toBe(1);

    cgUpdateFails = true;
    await mod.casparPlayoutService.applyComplianceForItem!(item('c'));
    expect(cgAddsOnLayer(32)).toBe(2);
  });
});

describe('parseLayerOccupancy', () => {
  it('reads the INFO shapes CasparCG returns', async () => {
    const { parseLayerOccupancy } = await import('../caspar');
    expect(parseLayerOccupancy(EMPTY_LAYER)).toBe('empty');
    expect(parseLayerOccupancy('<layer><foreground><producer><type>empty-producer</type></producer></foreground></layer>')).toBe('empty');
    expect(parseLayerOccupancy('<layer><foreground><producer/></foreground></layer>')).toBe('empty');
    expect(parseLayerOccupancy('<layer><foreground><producer><type>html-producer</type><url>x</url></producer></foreground></layer>')).toBe('present');
    expect(parseLayerOccupancy('<layer><foreground><producer>ffmpeg</producer></foreground></layer>')).toBe('present');
    expect(parseLayerOccupancy('201 INFO OK')).toBe('unknown');
  });
});
