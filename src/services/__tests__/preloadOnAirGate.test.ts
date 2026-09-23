import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/playoutDispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/playoutDispatch')>()),
  dispatchLoadbg: vi.fn().mockResolvedValue({ durationMs: 10_000, expectedOutMs: 10_000 }),
}));

import { setActivePinia, createPinia } from 'pinia';
import {
  casparPlayoutService,
  __playoutQueueTestHooks as queue,
  __preloadGateTestHooks as gate,
} from '../caspar';
import { dispatchLoadbg } from '../../lib/playoutDispatch';

const item = (id: string) =>
  ({
    id,
    playoutvueId: id,
    type: 'video',
    filename: `${id}.mp4`,
    path: `D:/media/${id}.mp4`,
    duration_ms: 10_000,
    trim_in_ms: 0,
    trim_out_ms: 10_000,
    ingestorStatus: 'ready',
  }) as any;

const loadbgTargets = () => vi.mocked(dispatchLoadbg).mock.calls.map((call) => (call[0] as any).id);

/** Let the awaited gate and dispatch chain settle. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/**
 * Incident 2026-09-23 (playout-debug-log): A (a subclip) was ending with B
 * armed in the background. The natural advance claimed B, and in the ~50 ms
 * before B reached air a rundown edit ran refreshQueue, saw C as B's
 * unarmed successor and sent LOADBG C … AUTO. That replaced B in the only
 * background slot, CasparCG cut A -> C at EOF and Rust reported a premature
 * AUTO transition 21.7 s early. Every rundown-driven LOADBG AUTO now waits
 * until the clip claimed as on air has proved its first frame.
 */
describe('LOADBG AUTO waits for the on-air clip to render', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.mocked(dispatchLoadbg).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not arm C while B is claimed but not yet on air, and arms it once B renders', async () => {
    queue.setState([item('a'), item('b'), item('c')], 'b', true);

    await casparPlayoutService.refreshQueue!([item('a'), item('b'), item('c')]);
    await settle();
    expect(loadbgTargets()).toEqual([]);

    gate.resolvePositionConfirmation('b');
    await settle();
    expect(loadbgTargets()).toEqual(['c']);
  });

  it('withholds the preload when the on-air clip never confirms', async () => {
    queue.setState([item('a'), item('b'), item('c')], 'b', true);

    await casparPlayoutService.refreshQueue!([item('a'), item('b'), item('c')]);
    vi.advanceTimersByTime(gate.PRELOAD_ARM_CONFIRMATION_TIMEOUT_MS);
    await settle();
    expect(loadbgTargets()).toEqual([]);
  });

  it('a confirmation for the outgoing clip does not release the preload', async () => {
    queue.setState([item('a'), item('b'), item('c')], 'b', true);

    await casparPlayoutService.refreshQueue!([item('a'), item('b'), item('c')]);
    gate.resolvePositionConfirmation('a');
    await settle();
    expect(loadbgTargets()).toEqual([]);
  });

  it('arms at once for a clip that has already proved it is on air (a mid-clip edit)', async () => {
    queue.setState([item('a'), item('b'), item('c')], 'b', true);
    gate.resolvePositionConfirmation('b');

    await casparPlayoutService.refreshQueue!([item('a'), item('b'), item('c')]);
    await settle();
    expect(loadbgTargets()).toEqual(['c']);
  });

  it('a new claim of the same row must earn the proof again (re-take)', async () => {
    queue.setState([item('a'), item('b'), item('c')], 'b', true);
    gate.resolvePositionConfirmation('b');
    queue.setState([item('a'), item('b'), item('c')], 'b', true);

    await casparPlayoutService.refreshQueue!([item('a'), item('b'), item('c')]);
    await settle();
    expect(loadbgTargets()).toEqual([]);
  });

  it('two preloads released by the same confirmation send one LOADBG', async () => {
    queue.setState([item('a'), item('b'), item('c')], 'b', true);

    await casparPlayoutService.refreshQueue!([item('a'), item('b'), item('c')]);
    await casparPlayoutService.refreshQueue!([item('a'), item('b'), item('c')]);
    gate.resolvePositionConfirmation('b');
    await settle();
    expect(loadbgTargets()).toEqual(['c']);
  });
});
