// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Tooltip from '../ui/Tooltip.vue';
import { activeTooltip, hideTooltip, TOOLTIP_GAP_PX } from '../../lib/tooltip';

/**
 * Round 3 §7.3 — the single tooltip host.
 *
 * One element in the document no matter how many controls are decorated, and
 * it must never be the thing the pointer hits: a tooltip that eats the click
 * meant for the control it describes is worse than no tooltip.
 */

const makeAnchor = (rect: Partial<DOMRect> = {}) => {
  const el = document.createElement('button');
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({ left: 100, top: 200, width: 40, height: 28, right: 140, bottom: 228, x: 100, y: 200, toJSON: () => ({}), ...rect }) as DOMRect;
  return el;
};

/** happy-dom gives every element a zero rect; the host measures itself. */
const stubSelfSize = (host: HTMLElement, width: number, height: number) => {
  host.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
};

describe('ui/Tooltip.vue', () => {
  beforeEach(() => hideTooltip());
  afterEach(() => hideTooltip());

  it('renders nothing while no tooltip is active', () => {
    const w = mount(Tooltip, { attachTo: document.body });
    expect(document.querySelector('.tooltip')).toBeNull();
    w.unmount();
  });

  it('renders the active tooltip with role="tooltip" and the id the anchor points at', async () => {
    const w = mount(Tooltip, { attachTo: document.body });
    const anchor = makeAnchor();
    activeTooltip.value = { id: 'tooltip-1', text: 'Settings', anchor, placement: null };
    await nextTick();

    const el = document.querySelector('.tooltip') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.getAttribute('role')).toBe('tooltip');
    expect(el.id).toBe('tooltip-1');
    expect(el.textContent).toContain('Settings');
    w.unmount();
  });

  it('renders a shortcut as a key cap, not as prose', async () => {
    const w = mount(Tooltip, { attachTo: document.body });
    activeTooltip.value = { id: 'tooltip-2', text: 'Save playlist…', shortcut: 'Ctrl+S', anchor: makeAnchor(), placement: null };
    await nextTick();

    const kbd = document.querySelector('.tooltip kbd');
    expect(kbd?.textContent).toBe('Ctrl+S');
    w.unmount();
  });

  it('measures itself and writes a placement back', async () => {
    const w = mount(Tooltip, { attachTo: document.body });
    const anchor = makeAnchor({ left: 100, top: 200, width: 40, height: 28 });
    activeTooltip.value = { id: 'tooltip-3', text: 'Settings', anchor, placement: null };
    await nextTick();
    stubSelfSize(document.querySelector('.tooltip') as HTMLElement, 80, 24);
    // The host defers one tick to let the element exist before measuring.
    await nextTick();
    await nextTick();

    expect(activeTooltip.value?.placement).toEqual({ left: 80, top: 200 + 28 + TOOLTIP_GAP_PX, side: 'bottom' });
    w.unmount();
  });

  it('wears the shared popover surface rather than a bespoke one', async () => {
    const w = mount(Tooltip, { attachTo: document.body });
    activeTooltip.value = { id: 'tooltip-4', text: 'Settings', anchor: makeAnchor(), placement: null };
    await nextTick();
    expect(document.querySelector('.tooltip')?.classList.contains('popover-surface')).toBe(true);
    w.unmount();
  });

  it('is transparent to the pointer', () => {
    // A scoped <style> block is not applied by happy-dom, so the guard reads
    // the SFC. A tooltip that eats the click meant for the control it
    // describes is worse than no tooltip at all.
    const sfc = readFileSync(resolve(__dirname, '../ui/Tooltip.vue'), 'utf-8');
    expect(sfc).toMatch(/\.tooltip\s*\{[^}]*pointer-events:\s*none/s);
  });

  it('dismisses on scroll, on resize and on Escape — anything that moves the anchor', async () => {
    const w = mount(Tooltip, { attachTo: document.body });

    for (const fire of [
      () => window.dispatchEvent(new Event('scroll')),
      () => window.dispatchEvent(new Event('resize')),
      () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    ]) {
      const anchor = makeAnchor();
      activeTooltip.value = { id: 'tooltip-x', text: 'Settings', anchor, placement: null };
      anchor.setAttribute('aria-describedby', 'tooltip-x');
      fire();
      expect(activeTooltip.value).toBeNull();
      expect(anchor.hasAttribute('aria-describedby')).toBe(false);
    }
    w.unmount();
  });

  it('lets Escape through — the modal underneath still has to see it', () => {
    const w = mount(Tooltip, { attachTo: document.body });
    activeTooltip.value = { id: 'tooltip-5', text: 'Settings', anchor: makeAnchor(), placement: null };
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(seen).toHaveBeenCalled();
    window.removeEventListener('keydown', seen);
    w.unmount();
  });

  it('clears the active tooltip when the host unmounts', async () => {
    const w = mount(Tooltip, { attachTo: document.body });
    activeTooltip.value = { id: 'tooltip-6', text: 'Settings', anchor: makeAnchor(), placement: null };
    await nextTick();
    w.unmount();
    expect(activeTooltip.value).toBeNull();
    expect(document.querySelector('.tooltip')).toBeNull();
  });
});
