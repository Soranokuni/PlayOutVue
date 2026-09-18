import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
}));

import { setActivePinia, createPinia } from 'pinia';
import { __preloadGateTestHooks as gate } from '../caspar';

/**
 * Incident 2026-09-18: `LOADBG … AUTO` sent 26 ms after `PLAY OK` for a SEEK'd
 * clip made CasparCG's first-tick AUTO check wrap around (frame_number() =
 * time() - start() with time() == 0 before the first frame) and put the NEXT
 * clip on air. The take path now waits for Rust's first-frame proof
 * (`caspar://foreground-position-confirmed`) before arming the preload, with a
 * bounded timeout that still arms it. These tests pin the waiter semantics.
 */
describe('first-frame gate before LOADBG AUTO', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves true when the position confirmation for the same uuid arrives', async () => {
    const pending = gate.waitForPositionConfirmation('clip-a', 1500);
    expect(gate.pendingPositionWaiters()).toBe(1);

    gate.resolvePositionConfirmation('clip-a');
    await expect(pending).resolves.toBe(true);
    expect(gate.pendingPositionWaiters()).toBe(0);
  });

  it('ignores confirmations for other uuids (stale event from the previous clip)', async () => {
    const pending = gate.waitForPositionConfirmation('clip-b', 1500);
    gate.resolvePositionConfirmation('clip-a');
    expect(gate.pendingPositionWaiters()).toBe(1);

    vi.advanceTimersByTime(1500);
    await expect(pending).resolves.toBe(false);
  });

  it('times out to false after the bounded wait so the preload is still armed', async () => {
    const pending = gate.waitForPositionConfirmation('clip-c', gate.PRELOAD_ARM_CONFIRMATION_TIMEOUT_MS);
    vi.advanceTimersByTime(gate.PRELOAD_ARM_CONFIRMATION_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toBe(false);
    expect(gate.pendingPositionWaiters()).toBe(0);
  });

  it('keeps the legacy path confirmation as an independent waiter', async () => {
    const path = gate.waitForForegroundConfirmation('clip-d', 1500);
    const frame = gate.waitForPositionConfirmation('clip-d', 1500);
    gate.resolveForegroundConfirmation('clip-d');
    await expect(path).resolves.toBe(true);
    expect(gate.pendingPositionWaiters()).toBe(1);
    gate.resolvePositionConfirmation('clip-d');
    await expect(frame).resolves.toBe(true);
  });

  it('bounded timeout is long enough to outlive the first-frame window but short enough not to starve the preload', () => {
    expect(gate.PRELOAD_ARM_CONFIRMATION_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(gate.PRELOAD_ARM_CONFIRMATION_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});
