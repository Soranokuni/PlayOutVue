import { describe, it, expect } from 'vitest';
import { commandRegistry, type CommandContext } from '../../services/commandRegistry';

describe('commandRegistry context dispatcher & command collisions', () => {
  it('registers and retrieves scope-specific commands', () => {
    const all = commandRegistry.getAll();
    expect(all.length).toBeGreaterThan(5);

    const rundownCmds = all.filter((c) => c.scopes.includes('rundown'));
    expect(rundownCmds.some((c) => c.id === 'rundown.selectPrevious')).toBe(true);
    expect(rundownCmds.some((c) => c.id === 'rundown.takeSelected')).toBe(true);
  });

  it('evaluates commands dynamically using invocation context without global closure leaks', async () => {
    const mockRundown: any = {
      activeItems: [{ id: 'item-1' }, { id: 'item-2' }],
      selectedItemId: null,
      moveSelectionDelta: (delta: number) => {
        mockRundown.selectedItemId = 'item-1';
      }
    };

    const ctx: CommandContext = {
      scope: 'rundown',
      rundown: mockRundown,
      selection: { selectedItemIds: ['item-1'], primarySelectedId: 'item-1' },
      activeModal: null,
      trimmer: null
    };

    const executed = await commandRegistry.execute('rundown.selectPrevious', ctx);
    expect(executed).toBe(true);
    expect(mockRundown.selectedItemId).toBe('item-1');
  });

  it('prevents execution of disabled commands', async () => {
    const mockRundown: any = {
      activeItems: [],
      selectedItemId: null
    };

    const ctx: CommandContext = {
      scope: 'rundown',
      rundown: mockRundown,
      selection: { selectedItemIds: [], primarySelectedId: null },
      activeModal: null,
      trimmer: null
    };

    const executed = await commandRegistry.execute('rundown.takeSelected', ctx);
    expect(executed).toBe(false);
  });
});
