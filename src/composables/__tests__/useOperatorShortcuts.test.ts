import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyActiveScope,
  isInteractiveControl,
  activeScope,
  activeModalName,
  activeTrimmerContext
} from '../useOperatorShortcuts';

describe('useOperatorShortcuts composable & scope classifier', () => {
  beforeEach(() => {
    activeScope.value = 'rundown';
    activeModalName.value = null;
    activeTrimmerContext.value = null;
  });

  it('classifies modal scope when activeModalName is set', () => {
    activeModalName.value = 'caspar-config';
    expect(classifyActiveScope()).toBe('modal');

    activeModalName.value = 'trimmer';
    expect(classifyActiveScope()).toBe('trimmer');
  });

  it('identifies interactive controls that consume Spacebar natively', () => {
    const mockButton = { tagName: 'BUTTON', getAttribute: () => null } as any;
    const mockInput = { tagName: 'INPUT', getAttribute: () => null } as any;
    const mockDiv = { tagName: 'DIV', getAttribute: () => null } as any;
    const mockRoleButton = { tagName: 'DIV', getAttribute: (attr: string) => (attr === 'role' ? 'button' : null) } as any;

    expect(isInteractiveControl(mockButton)).toBe(true);
    expect(isInteractiveControl(mockInput)).toBe(true);
    expect(isInteractiveControl(mockRoleButton)).toBe(true);
    expect(isInteractiveControl(mockDiv)).toBe(false);
  });
});
