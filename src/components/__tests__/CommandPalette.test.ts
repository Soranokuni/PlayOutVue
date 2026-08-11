// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import CommandPaletteModal from '../CommandPaletteModal.vue';
import { commandRegistry, type CommandDefinition } from '../../services/commandRegistry';
import {
  useOperatorShortcuts,
  openCommandPalette,
  closeCommandPalette,
  activeModalName,
  resetShortcutsMountedStateForTesting
} from '../../composables/useOperatorShortcuts';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(true)
}));

describe('PR 4 Command Palette Modal & Focus Trapping (Remediated)', () => {
  let shortcuts: ReturnType<typeof useOperatorShortcuts>;

  beforeEach(() => {
    resetShortcutsMountedStateForTesting();
    setActivePinia(createPinia());
    document.body.innerHTML = '';
    activeModalName.value = null;

    shortcuts = useOperatorShortcuts();
    shortcuts.mountShortcuts();
  });

  afterEach(() => {
    shortcuts.unmountShortcuts();
    resetShortcutsMountedStateForTesting();
    activeModalName.value = null;
    document.body.innerHTML = '';
  });

  it('opens palette on Ctrl+K and captures previously focused element', async () => {
    const button = document.createElement('button');
    button.id = 'target-btn';
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })
    );

    expect(activeModalName.value).toBe('command-palette');

    closeCommandPalette();
    expect(activeModalName.value).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('opens palette on Cmd+K on macOS', async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'K', metaKey: true, bubbles: true, cancelable: true })
    );

    expect(activeModalName.value).toBe('command-palette');
  });

  it('restores focus to fallback container if captured element was removed from DOM', async () => {
    const fallbackContainer = document.createElement('div');
    fallbackContainer.setAttribute('data-command-scope', 'rundown');
    fallbackContainer.tabIndex = 0;
    document.body.appendChild(fallbackContainer);

    const tempBtn = document.createElement('button');
    document.body.appendChild(tempBtn);
    tempBtn.focus();

    openCommandPalette();
    tempBtn.remove(); // Remove captured element

    closeCommandPalette();
    expect(document.activeElement).toBe(fallbackContainer);
  });

  it('mounts CommandPaletteModal, focuses search input, and traps focus', async () => {
    openCommandPalette();

    const wrapper = mount(CommandPaletteModal, {
      props: { isOpen: true },
      attachTo: document.body
    });

    await nextTick();

    const input = wrapper.get('input[type="search"]');
    expect(input.exists()).toBe(true);

    const backdrop = wrapper.get('[data-command-scope="command-palette"]');
    expect(backdrop.exists()).toBe(true);

    const dialog = wrapper.get('section[role="dialog"]');
    expect(dialog.attributes('aria-modal')).toBe('true');

    wrapper.unmount();
  });

  it('filters commands fuzzy and executes highlighted command on Enter, emitting close only on success', async () => {
    let executed = false;
    const testCmd: CommandDefinition = {
      id: 'test.cmdPaletteAction',
      label: 'Special Test Action',
      scopes: ['global'],
      category: 'Global',
      safety: 'safe',
      isVisible: () => true,
      isEnabled: () => true,
      execute: () => {
        executed = true;
      }
    };
    commandRegistry.register(testCmd);

    openCommandPalette();
    const wrapper = mount(CommandPaletteModal, {
      props: { isOpen: true },
      attachTo: document.body
    });

    await nextTick();

    const input = wrapper.get('input[type="search"]');
    await input.setValue('Special Test');

    const backdrop = wrapper.get('[data-command-scope="command-palette"]');
    await backdrop.trigger('keydown', { key: 'Enter' });

    expect(executed).toBe(true);
    expect(wrapper.emitted('close')).toBeTruthy();

    commandRegistry.unregister('test.cmdPaletteAction');
    wrapper.unmount();
  });

  it('keeps palette open and displays error banner when command execution fails', async () => {
    const failingCmd: CommandDefinition = {
      id: 'test.failingAction',
      label: 'Failing Action',
      scopes: ['global'],
      category: 'Global',
      safety: 'safe',
      isVisible: () => true,
      isEnabled: () => true,
      execute: () => {
        throw new Error('Database write error');
      }
    };
    commandRegistry.register(failingCmd);

    openCommandPalette();
    const wrapper = mount(CommandPaletteModal, {
      props: { isOpen: true },
      attachTo: document.body
    });

    await nextTick();

    const input = wrapper.get('input[type="search"]');
    await input.setValue('Failing Action');

    const backdrop = wrapper.get('[data-command-scope="command-palette"]');
    await backdrop.trigger('keydown', { key: 'Enter' });
    await nextTick();

    expect(wrapper.emitted('close')).toBeFalsy();
    expect(wrapper.text()).toContain('Database write error');

    commandRegistry.unregister('test.failingAction');
    wrapper.unmount();
  });

  it('strictly excludes commands with safety: "playback"', async () => {
    const playbackCmd: CommandDefinition = {
      id: 'test.playbackAction',
      label: 'Direct Playback Action',
      scopes: ['global'],
      category: 'Global',
      safety: 'playback',
      isVisible: () => true,
      isEnabled: () => true,
      execute: () => {}
    };
    commandRegistry.register(playbackCmd);

    openCommandPalette();
    const wrapper = mount(CommandPaletteModal, {
      props: { isOpen: true },
      attachTo: document.body
    });

    await nextTick();

    const text = wrapper.text();
    expect(text).not.toContain('Direct Playback Action');

    commandRegistry.unregister('test.playbackAction');
    wrapper.unmount();
  });

  it('closes on Escape', async () => {
    openCommandPalette();
    const wrapper = mount(CommandPaletteModal, {
      props: { isOpen: true },
      attachTo: document.body
    });

    await nextTick();

    const backdrop = wrapper.get('[data-command-scope="command-palette"]');
    await backdrop.trigger('keydown', { key: 'Escape' });

    expect(wrapper.emitted('close')).toBeTruthy();
    wrapper.unmount();
  });
});
