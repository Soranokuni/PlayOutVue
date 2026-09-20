// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import BaseModal from '../ui/BaseModal.vue';

const mockAsk = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: (...args: any[]) => mockAsk(...args),
}));

/**
 * UI F-11: ten dialogs, ten chromes. Escape worked in two of them, focus was
 * never trapped, and the footer button order differed per dialog.
 */
describe('UI F-11 · BaseModal', () => {
  const mountModal = (props: Record<string, unknown> = {}, slots: Record<string, string> = {}) =>
    mount(BaseModal, {
      props: { open: true, title: 'Test dialog', ...props },
      slots: { default: '<input class="first" /><button class="last">Go</button>', ...slots },
      attachTo: document.body,
    });

  beforeEach(() => {
    mockAsk.mockReset();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders as a labelled modal dialog', async () => {
    const wrapper = mountModal();
    await nextTick();

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toContain('Test dialog');

    wrapper.unmount();
  });

  it('tags itself for the keyboard router', async () => {
    const wrapper = mountModal();
    await nextTick();
    expect(document.querySelector('[data-command-scope="modal"]')).not.toBeNull();
    wrapper.unmount();

    const trimmer = mountModal({ commandScope: 'trimmer' });
    await nextTick();
    expect(document.querySelector('[data-command-scope="trimmer"]')).not.toBeNull();
    trimmer.unmount();
  });

  it('closes on Escape', async () => {
    const wrapper = mountModal();
    await nextTick();

    document.querySelector<HTMLElement>('.modal-panel')!.focus();
    document
      .querySelector('.modal-backdrop')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();

    expect(wrapper.emitted('close')).toBeTruthy();
    wrapper.unmount();
  });

  it('leaves Escape to the text input first — OPERATOR-UI-CONTRACT §6', async () => {
    const wrapper = mountModal();
    await nextTick();

    // A focused field classifies as `text-input`, so the first Escape belongs
    // to the field (the global router blurs it) and must not close the dialog.
    document.querySelector<HTMLInputElement>('input.first')!.focus();
    document
      .querySelector('.modal-backdrop')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();

    expect(wrapper.emitted('close')).toBeFalsy();
    wrapper.unmount();
  });

  it('closes on a backdrop press, but not on a press inside the panel', async () => {
    const wrapper = mountModal();
    await nextTick();

    document.querySelector('.modal-panel')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('close')).toBeFalsy();

    const backdrop = document.querySelector('.modal-backdrop')!;
    backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('close')).toBeTruthy();

    wrapper.unmount();
  });

  it('honours dismissOnBackdrop: false', async () => {
    const wrapper = mountModal({ dismissOnBackdrop: false });
    await nextTick();

    document.querySelector('.modal-backdrop')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await nextTick();

    expect(wrapper.emitted('close')).toBeFalsy();
    wrapper.unmount();
  });

  it('asks before discarding unsaved changes, and stays open on "no"', async () => {
    mockAsk.mockResolvedValue(false);
    const wrapper = mountModal({ dirty: true });
    await nextTick();

    document.querySelector<HTMLElement>('button[aria-label="Close"]')!.click();
    await nextTick();
    await nextTick();

    expect(mockAsk).toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeFalsy();
    wrapper.unmount();
  });

  it('closes when the discard prompt is confirmed', async () => {
    mockAsk.mockResolvedValue(true);
    const wrapper = mountModal({ dirty: true });
    await nextTick();

    document.querySelector<HTMLElement>('button[aria-label="Close"]')!.click();
    await nextTick();
    await nextTick();
    await nextTick();

    expect(wrapper.emitted('close')).toBeTruthy();
    wrapper.unmount();
  });

  it('marks a dirty dialog in its title', async () => {
    const wrapper = mountModal({ dirty: true });
    await nextTick();
    expect(document.querySelector('.modal-dirty')).not.toBeNull();
    wrapper.unmount();
  });

  it('focuses the first field, not the close button, and restores focus on close', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const wrapper = mountModal({ open: false });
    await wrapper.setProps({ open: true });
    await nextTick();
    await nextTick();

    expect(document.activeElement).toBe(document.querySelector('input.first'));

    await wrapper.setProps({ open: false });
    await nextTick();
    expect(document.activeElement).toBe(opener);

    wrapper.unmount();
  });

  it('traps Tab inside the dialog', async () => {
    const wrapper = mountModal();
    await nextTick();
    await nextTick();

    // Tabbing forward off the last control must wrap to the first, rather than
    // escaping to the rundown behind the dialog where Delete and the transport
    // shortcuts are live.
    const ring = document.querySelectorAll<HTMLElement>(
      '.modal-panel a[href], .modal-panel button, .modal-panel input, .modal-panel select, .modal-panel textarea'
    );
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    last.focus();

    document
      .querySelector('.modal-backdrop')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.activeElement).toBe(first);

    // And Shift+Tab off the first wraps back to the last.
    first.focus();
    document
      .querySelector('.modal-backdrop')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.activeElement).toBe(last);
    wrapper.unmount();
  });

  it('uses the nested layer when opened from another dialog', async () => {
    const wrapper = mountModal({ nested: true });
    await nextTick();
    expect(document.querySelector('.modal-backdrop')!.classList.contains('is-nested')).toBe(true);
    wrapper.unmount();
  });

  it('renders no close affordance when not closable', async () => {
    const wrapper = mountModal({ closable: false });
    await nextTick();
    expect(document.querySelector('button[aria-label="Close"]')).toBeNull();
    wrapper.unmount();
  });
});
