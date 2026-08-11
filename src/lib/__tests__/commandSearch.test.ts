import { describe, it, expect } from 'vitest';
import { searchCommands } from '../commandSearch';
import type { CommandDefinition } from '../../services/commandRegistry';

describe('commandSearch pure fuzzy utility', () => {
  const sampleCommands: CommandDefinition[] = [
    {
      id: 'rundown.copySelected',
      label: 'Copy Selected Items',
      scopes: ['rundown'],
      defaultShortcut: 'Ctrl+C',
      category: 'Rundown',
      isVisible: () => true,
      isEnabled: () => true,
      execute: () => {}
    },
    {
      id: 'rundown.cutSelected',
      label: 'Cut Selected Items',
      scopes: ['rundown'],
      defaultShortcut: 'Ctrl+X',
      category: 'Rundown',
      isVisible: () => true,
      isEnabled: () => true,
      execute: () => {}
    },
    {
      id: 'library.appendSelected',
      label: 'Append Asset to Rundown',
      scopes: ['library'],
      defaultShortcut: 'F8',
      category: 'Library',
      isVisible: () => true,
      isEnabled: () => true,
      execute: () => {}
    }
  ];

  it('ranks exact label match highest (1000)', () => {
    const results = searchCommands('Copy Selected Items', sampleCommands);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.command.id).toBe('rundown.copySelected');
    expect(results[0]?.score).toBe(1000);
  });

  it('ranks prefix matches above substring matches', () => {
    const results = searchCommands('Cut', sampleCommands);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.command.id).toBe('rundown.cutSelected');
    expect(results[0]?.score).toBe(800);
  });

  it('filters by shortcut', () => {
    const results = searchCommands('F8', sampleCommands);
    expect(results).toHaveLength(1);
    expect(results[0]?.command.id).toBe('library.appendSelected');
    expect(results[0]?.score).toBe(600);
  });

  it('returns empty array when query does not match', () => {
    const results = searchCommands('NonExistentQuery123', sampleCommands);
    expect(results).toHaveLength(0);
  });

  it('returns all commands with score 1 when query is empty', () => {
    const results = searchCommands('', sampleCommands);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.score === 1)).toBe(true);
  });
});
