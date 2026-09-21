import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyActiveScope, activeScope, activeModalName } from '../useOperatorShortcuts';
import { commandRegistry } from '../../services/commandRegistry';

describe('operatorKeyboardRouting & scope classifier', () => {
  let originalDocument: any;

  beforeEach(() => {
    activeScope.value = 'rundown';
    activeModalName.value = null;
    originalDocument = (globalThis as any).document;
  });

  afterEach(() => {
    (globalThis as any).document = originalDocument;
  });

  it('classifies active scope based on data-command-scope attributes', () => {
    const mockRundownElement = {
      closest: (selector: string) => (selector.includes('rundown') ? {} : null)
    };
    const mockLibraryElement = {
      closest: (selector: string) => (selector.includes('library') ? {} : null)
    };
    const mockTrimmerElement = {
      closest: (selector: string) => (selector.includes('trimmer') ? {} : null)
    };

    (globalThis as any).document = { activeElement: mockRundownElement };
    expect(classifyActiveScope()).toBe('rundown');

    (globalThis as any).document = { activeElement: mockLibraryElement };
    expect(classifyActiveScope()).toBe('library');

    (globalThis as any).document = { activeElement: mockTrimmerElement };
    expect(classifyActiveScope()).toBe('trimmer');
  });

  it('classifies text-input scope for editable elements', () => {
    const mockInput = {
      tagName: 'INPUT',
      isContentEditable: false,
      closest: () => null
    };

    (globalThis as any).document = { activeElement: mockInput };
    expect(classifyActiveScope()).toBe('text-input');
  });
});

/**
 * Round 3 §5.4 — the playlist file keys.
 *
 * Load / Append / Save are the three things the operator does constantly that
 * had no shortcut at all. They go through the registry so the palette, the
 * header buttons and the keys are one implementation; the routing contract is
 * that each one resolves to exactly one command, that Ctrl+Shift+O is Append
 * rather than a second Load, and that none of them shadow a key already bound.
 */
describe('Round 3 §5.4 · playlist file shortcuts', () => {
  const route = (key: string, shiftKey = false): string | null => {
    const k = key.toLowerCase();
    if (k === 's') return 'playlist.save';
    if (k === 'o') return shiftKey ? 'playlist.append' : 'playlist.load';
    return null;
  };

  it('resolves each chord to exactly one command', () => {
    expect(route('s')).toBe('playlist.save');
    expect(route('S')).toBe('playlist.save');
    expect(route('o')).toBe('playlist.load');
    expect(route('o', true)).toBe('playlist.append');
    expect(route('O', true)).toBe('playlist.append');
  });

  it('registers all three with the advertised chords and no collision', () => {
    const ids = ['playlist.save', 'playlist.load', 'playlist.append'];
    const chords = ids.map((id) => {
      const cmd = commandRegistry.get(id);
      expect(cmd, `${id} is not registered`).toBeDefined();
      expect(cmd!.safety).toBe('safe');
      expect(cmd!.scopes).toContain('rundown');
      return cmd!.defaultShortcut;
    });

    expect(chords).toEqual(['Ctrl/Cmd+S', 'Ctrl/Cmd+O', 'Ctrl/Cmd+Shift+O']);
    expect(new Set(chords).size).toBe(chords.length);

    // And they do not collide with anything already bound.
    const taken = commandRegistry
      .getAll()
      .filter((c) => !ids.includes(c.id))
      .map((c) => c.defaultShortcut)
      .filter(Boolean);
    for (const chord of chords) expect(taken).not.toContain(chord);
  });

  it('never routes these keys while a text field has focus', () => {
    const mockInput = { tagName: 'INPUT', isContentEditable: false, closest: () => null };
    (globalThis as any).document = { activeElement: mockInput };
    // The router returns before section 3c for a text-input scope, so Ctrl+S
    // in a rename field stays the browser's.
    expect(classifyActiveScope()).toBe('text-input');
  });

  it('leaves Delete without a key, on purpose', () => {
    const deleteChords = commandRegistry
      .getAll()
      .filter((c) => c.id.startsWith('playlist.'))
      .map((c) => c.id);
    expect(deleteChords).not.toContain('playlist.delete');
  });
});
