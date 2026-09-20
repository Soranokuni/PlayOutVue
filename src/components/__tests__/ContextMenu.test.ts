// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ContextMenu, { type MenuItem } from '../ContextMenu.vue';
import { closeActiveContextMenu, hasActiveContextMenu } from '../../lib/activeContextMenu';

/**
 * UI F-05: the menu had no key handling and each parent closed it only on a
 * window `click`. A right-click in another panel fires `contextmenu`, not
 * `click`, so two menus could be open at once.
 */
describe('UI F-05 · ContextMenu dismissal', () => {
  const items: MenuItem[] = [{ type: 'action', id: 'a', label: 'Action A', action: () => {} }];

  const mountMenu = () =>
    mount(ContextMenu, {
      props: { x: 20, y: 20, items },
      attachTo: document.body
    });

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    closeActiveContextMenu();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('emits close on Escape', async () => {
    const wrapper = mountMenu();
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(wrapper.emitted('close')).toBeTruthy();
    wrapper.unmount();
  });

  it('swallows the Escape it handles so the rundown selection survives', async () => {
    const wrapper = mountMenu();
    await nextTick();

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    wrapper.unmount();
  });

  it('leaves other keys alone', async () => {
    const wrapper = mountMenu();
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));

    expect(wrapper.emitted('close')).toBeFalsy();
    wrapper.unmount();
  });

  it('emits close on a pointerdown outside the menu', async () => {
    const wrapper = mountMenu();
    await nextTick();

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    expect(wrapper.emitted('close')).toBeTruthy();
    wrapper.unmount();
  });

  it('stays open for a pointerdown inside the menu', async () => {
    const wrapper = mountMenu();
    await nextTick();

    wrapper.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    expect(wrapper.emitted('close')).toBeFalsy();
    wrapper.unmount();
  });

  it('emits close on a right-click outside — the case the old click handler missed', async () => {
    const wrapper = mountMenu();
    await nextTick();

    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

    expect(wrapper.emitted('close')).toBeTruthy();
    wrapper.unmount();
  });

  it('emits close when the window loses focus or is resized', async () => {
    const blurred = mountMenu();
    await nextTick();
    window.dispatchEvent(new Event('blur'));
    expect(blurred.emitted('close')).toBeTruthy();
    blurred.unmount();

    const resized = mountMenu();
    await nextTick();
    window.dispatchEvent(new Event('resize'));
    expect(resized.emitted('close')).toBeTruthy();
    resized.unmount();
  });

  it('opening a second menu closes the first', async () => {
    const first = mountMenu();
    await nextTick();
    expect(first.emitted('close')).toBeFalsy();

    const second = mountMenu();
    await nextTick();

    expect(first.emitted('close')).toBeTruthy();
    expect(second.emitted('close')).toBeFalsy();

    first.unmount();
    second.unmount();
  });

  it('releases the singleton slot on unmount', async () => {
    const wrapper = mountMenu();
    await nextTick();
    expect(hasActiveContextMenu()).toBe(true);

    wrapper.unmount();
    expect(hasActiveContextMenu()).toBe(false);
  });
});

/**
 * Round 3 §6: the row anatomy.
 *
 * The row began with a 16 px check *spacer*, then the icon, then 4 px, then
 * the label — so on an unchecked row (almost every row) a coloured glyph sat
 * adrift in a 24 px dead zone with its label pressed against it. The rail is
 * now column one of a grid, the check moved to the trailing group, and both
 * the main list and the submenu flyout render through one `MenuRow`.
 */
describe('Round 3 §6 · Context menu row anatomy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    closeActiveContextMenu();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const mountItems = (items: MenuItem[]) =>
    mount(ContextMenu, { props: { x: 10, y: 10, items }, attachTo: document.body });

  it('has no check spacer left anywhere', async () => {
    const wrapper = mountItems([
      { type: 'action', id: 'a', label: 'Checked', checked: true, action: () => {} },
      { type: 'action', id: 'b', label: 'Plain', icon: 'trash', action: () => {} },
      { type: 'submenu', id: 'c', label: 'More', children: [] },
    ]);
    await nextTick();
    expect(wrapper.findAll('.menu-item-check-spacer')).toHaveLength(0);
  });

  it('renders the check after the label, not in the icon rail', async () => {
    const wrapper = mountItems([
      { type: 'action', id: 'a', label: 'Checked', icon: 'trash', checked: true, action: () => {} },
    ]);
    await nextTick();

    const row = wrapper.get('.menu-item').element;
    const order = Array.from(row.querySelectorAll('.menu-item-icon, .menu-item-label, .menu-item-check'));
    const named = (el: Element) =>
      ['menu-item-icon', 'menu-item-label', 'menu-item-check'].find((c) => el.classList.contains(c));
    expect(order.map(named)).toEqual([
      'menu-item-icon',
      'menu-item-label',
      'menu-item-check',
    ]);
    // The rail holds the icon; the check is outside it.
    expect(wrapper.get('.menu-item-rail').element.querySelector('.menu-item-check')).toBeNull();
  });

  it('gives every row a rail, so labels align whether or not a row has an icon', async () => {
    const wrapper = mountItems([
      { type: 'action', id: 'a', label: 'With icon', icon: 'trash', action: () => {} },
      { type: 'action', id: 'b', label: 'Without', action: () => {} },
    ]);
    await nextTick();
    expect(wrapper.findAll('.menu-item-rail')).toHaveLength(2);
  });

  it('renders a shortcut hint as a real key cap', async () => {
    const wrapper = mountItems([
      { type: 'action', id: 'a', label: 'Rename', shortcut: 'F2', action: () => {} },
      { type: 'action', id: 'b', label: 'Inspect', action: () => {} },
    ]);
    await nextTick();

    const caps = wrapper.findAll('kbd');
    expect(caps).toHaveLength(1);
    expect(caps[0].text()).toBe('F2');
  });
});
