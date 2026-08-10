import { describe, it, expect, beforeEach } from 'vitest';
import { PlaybackCoordinator, RundownItemRef } from '../playbackCoordinator';

describe('PlaybackCoordinator (Race Matrix & Identity Playout)', () => {
  let coordinator: PlaybackCoordinator;
  let rundown: RundownItemRef[];

  beforeEach(() => {
    coordinator = new PlaybackCoordinator(1);
    rundown = [
      { id: 'item-A', enabled: true },
      { id: 'item-B', enabled: true },
      { id: 'item-C', enabled: true },
      { id: 'item-D', enabled: true },
      { id: 'item-E', enabled: true },
    ];
  });

  it('1. Reported bug: Manually playing B while C is on air makes B on air; C and D never play', () => {
    // Put C on air
    const takeC = coordinator.initiateTake({ targetItemId: 'item-C', rundownRevision: 1, source: 'manual' }, rundown);
    expect(takeC).not.toBeNull();
    const confirmC = coordinator.confirmTake(takeC!.intent.takeId, takeC!.intent.playGeneration, 1, 10, rundown);
    expect(confirmC).not.toBeNull();
    expect(coordinator.onAirItemId).toBe('item-C');

    // Record generation before manual take of B
    const genBeforeB = coordinator.playGeneration;

    // Manually take B (row immediately above C)
    const takeB = coordinator.initiateTake({ targetItemId: 'item-B', rundownRevision: 1, source: 'manual' }, rundown);
    expect(takeB).not.toBeNull();
    expect(takeB!.intent.playGeneration).toBe(genBeforeB + 1);

    // Confirm B
    const confirmB = coordinator.confirmTake(takeB!.intent.takeId, takeB!.intent.playGeneration, 1, 10, rundown);
    expect(confirmB).not.toBeNull();
    expect(coordinator.onAirItemId).toBe('item-B');

    // Simulate stale EOF from C arriving under genBeforeB
    const staleAutoAdvance = coordinator.evaluateAutoAdvance(
      {
        generation: genBeforeB,
        playbackInstanceId: confirmC!.playbackInstanceId,
        itemId: 'item-C',
      },
      rundown
    );

    // Stale auto advance from C MUST be rejected
    expect(staleAutoAdvance).toBeNull();
    expect(coordinator.onAirItemId).toBe('item-B');
  });

  it('2. Below on-air: Manually playing D while C is on air makes D on air', () => {
    // Put C on air
    const takeC = coordinator.initiateTake({ targetItemId: 'item-C', rundownRevision: 1, source: 'manual' }, rundown);
    const confirmC = coordinator.confirmTake(takeC!.intent.takeId, takeC!.intent.playGeneration, 1, 10, rundown);
    expect(coordinator.onAirItemId).toBe('item-C');

    // Take D
    const takeD = coordinator.initiateTake({ targetItemId: 'item-D', rundownRevision: 1, source: 'manual' }, rundown);
    const confirmD = coordinator.confirmTake(takeD!.intent.takeId, takeD!.intent.playGeneration, 1, 10, rundown);
    expect(confirmD).not.toBeNull();
    expect(coordinator.onAirItemId).toBe('item-D');
  });

  it('3. More than one above: Manually playing A while C is on air makes A on air', () => {
    const takeC = coordinator.initiateTake({ targetItemId: 'item-C', rundownRevision: 1, source: 'manual' }, rundown);
    coordinator.confirmTake(takeC!.intent.takeId, takeC!.intent.playGeneration, 1, 10, rundown);

    const takeA = coordinator.initiateTake({ targetItemId: 'item-A', rundownRevision: 1, source: 'manual' }, rundown);
    const confirmA = coordinator.confirmTake(takeA!.intent.takeId, takeA!.intent.playGeneration, 1, 10, rundown);
    expect(confirmA).not.toBeNull();
    expect(coordinator.onAirItemId).toBe('item-A');
  });

  it('4. EOF race: Clicking B while C emits EOF -> B wins deterministically', () => {
    // Put C on air
    const takeC = coordinator.initiateTake({ targetItemId: 'item-C', rundownRevision: 1, source: 'manual' }, rundown);
    const confirmC = coordinator.confirmTake(takeC!.intent.takeId, takeC!.intent.playGeneration, 1, 10, rundown);

    // Operator clicks B -> generation bumps to 2
    const takeB = coordinator.initiateTake({ targetItemId: 'item-B', rundownRevision: 1, source: 'manual' }, rundown);

    // C emits EOF with old generation 1
    const autoAdvanceTarget = coordinator.evaluateAutoAdvance(
      {
        generation: takeC!.intent.playGeneration,
        playbackInstanceId: confirmC!.playbackInstanceId,
        itemId: 'item-C',
      },
      rundown
    );

    // Auto-advance is blocked
    expect(autoAdvanceTarget).toBeNull();

    // B completes confirmation
    const confirmB = coordinator.confirmTake(takeB!.intent.takeId, takeB!.intent.playGeneration, 1, 10, rundown);
    expect(confirmB).not.toBeNull();
    expect(coordinator.onAirItemId).toBe('item-B');
  });

  it('5. Delayed old ACK: Old C ACK arrives after take B -> UI and coordinator remain B', () => {
    // Initiate take B
    const takeB = coordinator.initiateTake({ targetItemId: 'item-B', rundownRevision: 1, source: 'manual' }, rundown);

    // Old ACK with stale takeId / generation arrives
    const staleConfirm = coordinator.confirmTake('old-stale-takeId', 0, 1, 10, rundown);
    expect(staleConfirm).toBeNull();

    // Confirm real B take
    const realConfirm = coordinator.confirmTake(takeB!.intent.takeId, takeB!.intent.playGeneration, 1, 10, rundown);
    expect(realConfirm).not.toBeNull();
    expect(coordinator.onAirItemId).toBe('item-B');
  });

  it('6. Reorder race: Move B while preflighting -> resolves target by UUID or fails gracefully', () => {
    const takeB = coordinator.initiateTake({ targetItemId: 'item-B', rundownRevision: 1, source: 'manual' }, rundown);

    // Reorder rundown: [B, A, C, D, E]
    const reorderedRundown = [
      { id: 'item-B', enabled: true },
      { id: 'item-A', enabled: true },
      { id: 'item-C', enabled: true },
      { id: 'item-D', enabled: true },
      { id: 'item-E', enabled: true },
    ];
    coordinator.setRundownRevision(2);

    // Confirm take B against new rundown
    const confirmB = coordinator.confirmTake(takeB!.intent.takeId, takeB!.intent.playGeneration, 1, 10, reorderedRundown);
    expect(confirmB).not.toBeNull();
    expect(coordinator.onAirItemId).toBe('item-B');
  });

  it('7. Trim mutation: Edit armed item trim before EOF -> invalidates armed state', () => {
    const takeC = coordinator.initiateTake({ targetItemId: 'item-C', rundownRevision: 1, source: 'manual' }, rundown);
    coordinator.confirmTake(takeC!.intent.takeId, takeC!.intent.playGeneration, 1, 10, rundown);

    coordinator.armNextItem('item-D', coordinator.playGeneration);
    expect(coordinator.armedItemId).toBe('item-D');

    // Operator modifies trim -> arming invalidated
    coordinator.invalidateArming('trim modified');
    expect(coordinator.armedItemId).toBeNull();
  });

  it('8. Reconnect: Connection drops during manual take -> bumps generation and cancels stale take', () => {
    const takeB = coordinator.initiateTake({ targetItemId: 'item-B', rundownRevision: 1, source: 'manual' }, rundown);
    const genBeforeStop = coordinator.playGeneration;

    // Disconnect event occurs -> coordinator stopped
    coordinator.stop('connection drop');
    expect(coordinator.playGeneration).toBeGreaterThan(genBeforeStop);

    // Late ACK from takeB arrives -> rejected
    const confirmB = coordinator.confirmTake(takeB!.intent.takeId, genBeforeStop, 1, 10, rundown);
    expect(confirmB).toBeNull();
  });
});
