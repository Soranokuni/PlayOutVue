import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyActiveScope, activeScope, activeModalName } from '../useOperatorShortcuts';

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
