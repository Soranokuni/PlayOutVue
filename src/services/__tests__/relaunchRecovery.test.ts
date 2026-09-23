// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * PlayOut itself died (crash, hang, relaunch). On the first handshake the
 * Rust checkpoint decides: a clip CasparCG still plays is adopted by its row
 * identity; otherwise the operator gets a countdown plan.
 */

const EMPTY_LAYER = '201 INFO OK\r\n<layer><foreground><producer>empty</producer></foreground></layer>';
const playing = (path: string, timeS: number, durationS: number) =>
  `201 INFO OK\r\n<layer><foreground><producer>ffmpeg</producer><file><path>${path}</path><time>${timeS}</time><duration>${durationS}</duration></file><paused>false</paused></foreground></layer>`;

type InvokeArgs = Record<string, any> | undefined;
const calls: Array<{ cmd: string; args: InvokeArgs }> = [];
let layer10 = EMPTY_LAYER;
let bootInfo: any = null;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: InvokeArgs) => {
    calls.push({ cmd, args });
    if (cmd === 'caspar_send_command') {
      const amcp = String(args?.cmd || '');
      if (amcp === 'INFO 1-10') return layer10;
      if (amcp.startsWith('INFO 1-')) return EMPTY_LAYER;
      return '201 INFO OK';
    }
    if (cmd === 'recovery_boot_info') return bootInfo;
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
  dispatchPlay: vi.fn().mockResolvedValue({ durationMs: 30_000, expectedOutMs: 30_000 }),
  dispatchLoadbg: vi.fn().mockResolvedValue({ durationMs: 60_000, expectedOutMs: 60_000 }),
}));

import { setActivePinia, createPinia } from 'pinia';
import { dispatchPlay } from '../../lib/playoutDispatch';

const row = (id: string, path: string, trimIn = 0, trimOut = 60_000, fileMs = 60_000) =>
  ({
    id,
    playoutvueId: id,
    type: 'video',
    filename: `${id}.mp4`,
    path,
    duration_ms: fileMs,
    trim_in_ms: trimIn,
    trim_out_ms: trimOut,
    ingestorStatus: 'ready',
  }) as any;

async function boot(items: any[]) {
  vi.resetModules();
  const mod = await import('../caspar');
  const { useRundownStore } = await import('../../stores/rundown');
  const store = useRundownStore();
  const playlist = store.playlists[0]!;
  playlist.items = items;
  return { ...mod, store, playlistId: playlist.id };
}

const checkpointFor = (playlistId: string, onAir: Record<string, unknown>, ageMs: number) => ({
  previousCheckpoint: {
    version: 1,
    seq: 9,
    sessionId: 'old',
    writtenAtMs: Date.now() - ageMs,
    onAir: {
      playlistId,
      filename: 'x',
      trimInMs: 0,
      trimOutMs: 60_000,
      durationMs: 60_000,
      resumeOffsetMs: 0,
      isLive: false,
      nextUuid: null,
      nextPath: null,
      playGeneration: 3,
      paused: false,
      ...onAir,
    },
    graphics: { advisoryOnAir: true, advisoryItem: null, crawlActive: false, crawlText: '' },
    rundownRevision: 0,
    cleanShutdown: false,
  },
  previousSession: { sessionId: 'old', pid: 1, startedAtMs: 0, endedAtMs: null, clean: false, recoveredLaunch: false },
  previousHandled: false,
  crashLoop: false,
  recoveredLaunch: true,
  uiReloads: 0,
  liveCheckpoint: null,
});

const invoked = (cmd: string) => calls.filter((c) => c.cmd === cmd);

describe('PlayOut relaunch recovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    calls.length = 0;
    layer10 = EMPTY_LAYER;
    bootInfo = null;
    vi.mocked(dispatchPlay).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adopts the checkpoint row when CasparCG is still playing a file two rows share', async () => {
    // The whole show and its second part share show.mxf; 700 s is in both.
    const env = await boot([row('whole', 'D:/m/show.mxf', 0, 1_200_000, 1_200_000), row('part2', 'D:/m/show.mxf', 600_000, 1_200_000, 1_200_000)]);
    bootInfo = checkpointFor(env.playlistId, { uuid: 'part2', path: 'D:/m/show.mxf', trimInMs: 600_000, trimOutMs: 1_200_000, durationMs: 600_000, positionMs: 95_000 }, 5_000);
    layer10 = playing('show.mxf', 700, 1200);

    const connected = env.casparPlayoutService.connect();
    await vi.advanceTimersByTimeAsync(3000);
    await connected;

    const registered = invoked('caspar_register_playback').at(-1)?.args;
    expect(registered?.uuid).toBe('part2');
    expect(registered?.isAdopted).toBe(true);
    expect(env.relaunchOffer.value).toBeNull();
    expect(invoked('recovery_ack_previous').length).toBeGreaterThan(0);
    expect(dispatchPlay).not.toHaveBeenCalled();
  });

  it('offers to resume after a short outage and runs it when the countdown ends', async () => {
    const env = await boot([row('a', 'D:/m/a.mp4'), row('b', 'D:/m/b.mp4'), row('c', 'D:/m/c.mp4')]);
    bootInfo = checkpointFor(env.playlistId, { uuid: 'b', path: 'D:/m/b.mp4', positionMs: 20_000, nextUuid: 'c' }, 8_000);

    const connected = env.casparPlayoutService.connect();
    await vi.advanceTimersByTimeAsync(500);
    await connected;

    const offer = env.relaunchOffer.value;
    expect(offer?.actions[0]?.action).toEqual({ kind: 'resume', index: 1, seekMs: 19_000 });
    expect(offer?.actions.at(-1)?.action.kind).toBe('hold');
    expect(offer?.deadlineMs).not.toBeNull();
    expect(dispatchPlay).not.toHaveBeenCalled();
    // The station ID from before the crash is restored before any decision.
    expect(invoked('caspar_cg_add').some((c) => c.args?.layer === 32)).toBe(true);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(dispatchPlay).toHaveBeenCalledTimes(1);
    const [played, , , , seekMs] = vi.mocked(dispatchPlay).mock.calls[0]!;
    expect((played as any).id).toBe('b');
    expect(seekMs).toBe(19_000);
    expect(env.isCasparPlaying.value).toBe(true);
    expect(env.store.onAirPlaylistId).toBe(env.playlistId);
    expect(env.relaunchOffer.value).toBeNull();
  });

  it('an operator touching the dialog stops the countdown; Stay off air leaves the channel alone', async () => {
    const env = await boot([row('a', 'D:/m/a.mp4'), row('b', 'D:/m/b.mp4')]);
    bootInfo = checkpointFor(env.playlistId, { uuid: 'b', path: 'D:/m/b.mp4', positionMs: 20_000 }, 8_000);

    const connected = env.casparPlayoutService.connect();
    await vi.advanceTimersByTimeAsync(500);
    await connected;

    env.pauseRelaunchCountdown();
    expect(env.relaunchOffer.value?.deadlineMs).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dispatchPlay).not.toHaveBeenCalled();

    await env.resolveRelaunchOffer({ kind: 'hold', index: -1, seekMs: 0 });
    expect(dispatchPlay).not.toHaveBeenCalled();
    expect(env.engineRecovery.value.phase).toBe('held');
    expect(env.relaunchOffer.value).toBeNull();
  });

  it('a clip frozen on its last frame is not adopted: the plan continues after it', async () => {
    const env = await boot([row('a', 'D:/m/a.mp4'), row('b', 'D:/m/b.mp4'), row('c', 'D:/m/c.mp4'), row('d', 'D:/m/d.mp4')]);
    // PlayOut died 20 s into B; CasparCG played B out and the armed C, then froze.
    bootInfo = checkpointFor(env.playlistId, { uuid: 'b', path: 'D:/m/b.mp4', positionMs: 20_000, nextUuid: 'c', nextPath: 'D:/m/c.mp4' }, 105_000);
    layer10 = playing('c.mp4', 60, 60);

    const connected = env.casparPlayoutService.connect();
    await vi.advanceTimersByTimeAsync(500);
    await connected;

    expect(invoked('caspar_register_playback').length).toBe(0);
    const offer = env.relaunchOffer.value;
    expect(offer?.offer.offAirMs).toBeLessThan(10_000);
    expect(offer?.actions[0]?.action).toEqual({ kind: 'resume', index: 3, seekMs: 0 });
  });

  it('a take during the offer withdraws it', async () => {
    const env = await boot([row('a', 'D:/m/a.mp4'), row('b', 'D:/m/b.mp4')]);
    bootInfo = checkpointFor(env.playlistId, { uuid: 'b', path: 'D:/m/b.mp4', positionMs: 20_000 }, 8_000);
    const connected = env.casparPlayoutService.connect();
    await vi.advanceTimersByTimeAsync(500);
    await connected;
    expect(env.relaunchOffer.value).not.toBeNull();

    await env.casparPlayoutService.stop();
    expect(env.relaunchOffer.value).toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(dispatchPlay).not.toHaveBeenCalled();
  });

  it('checkpoints every take with integer fields the Rust side accepts', async () => {
    const env = await boot([row('a', 'D:/m/a.mp4'), row('b', 'D:/m/b.mp4')]);
    const connected = env.casparPlayoutService.connect();
    await vi.advanceTimersByTimeAsync(500);
    await connected;

    const playlist = env.store.playlists[0]!.items as any[];
    const done = env.casparPlayoutService.play(playlist, 0);
    await vi.advanceTimersByTimeAsync(3000);
    await done;

    const take = invoked('recovery_checkpoint_update').find((c) => c.args?.event === 'take');
    const onAir = take?.args?.context?.onAir;
    expect(onAir?.uuid).toBe('a');
    expect(onAir?.nextUuid).toBe('b');
    for (const key of ['trimInMs', 'trimOutMs', 'durationMs', 'resumeOffsetMs', 'playGeneration']) {
      expect(Number.isInteger(onAir?.[key]), key).toBe(true);
      expect(onAir?.[key], key).toBeGreaterThanOrEqual(0);
    }
  });
});
