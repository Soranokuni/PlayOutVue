// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, ref, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import {
  vTooltip,
  activeTooltip,
  hideTooltip,
  placeTooltip,
  parseTooltipText,
  TOOLTIP_DELAY_MS,
  TOOLTIP_GAP_PX,
  TOOLTIP_MARGIN_PX,
} from '../tooltip';

/**
 * Round 3 §7.3 — tooltips that teach.
 *
 * The chrome's icon-only controls relied on the native `title`: about a second
 * of delay, the OS's own styling, no way to render a shortcut as a key cap,
 * and nothing at all for a control reached by keyboard. These pin the
 * replacement's contract, in the three places it can go wrong:
 *
 * - the placement arithmetic (pure, so it is tested without a layout engine),
 * - the delay and the native-`title` handover,
 * - the accessibility wiring (`aria-describedby`, never `aria-label`).
 */

const stubAnchor = (el: HTMLElement, rect: Partial<DOMRect>) => {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 32, height: 28, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}), ...rect }) as DOMRect;
};

describe('placeTooltip', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 120, height: 24 };

  it('sits below the anchor, horizontally centred on it', () => {
    const p = placeTooltip({ left: 400, top: 100, width: 40, height: 28 }, size, viewport);
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(100 + 28 + TOOLTIP_GAP_PX);
    // 400 + 20 (half the anchor) - 60 (half the tooltip)
    expect(p.left).toBe(360);
  });

  it('flips above when the anchor is against the bottom of the viewport', () => {
    const p = placeTooltip({ left: 400, top: 770, width: 40, height: 28 }, size, viewport);
    expect(p.side).toBe('top');
    expect(p.top).toBe(770 - TOOLTIP_GAP_PX - size.height);
  });

  it('stays below when neither side fits — below is the less surprising half', () => {
    const p = placeTooltip({ left: 400, top: 4, width: 40, height: 28 }, size, { width: 1000, height: 50 });
    expect(p.side).toBe('bottom');
  });

  it('clamps rather than flips horizontally at the left edge', () => {
    const p = placeTooltip({ left: 2, top: 100, width: 28, height: 28 }, size, viewport);
    expect(p.left).toBe(TOOLTIP_MARGIN_PX);
  });

  it('clamps at the right edge — a control-bar button at 1920 is still readable', () => {
    const p = placeTooltip({ left: 1890, top: 8, width: 28, height: 28 }, size, { width: 1920, height: 1080 });
    expect(p.left).toBe(1920 - size.width - TOOLTIP_MARGIN_PX);
    expect(p.left + size.width).toBeLessThanOrEqual(1920);
  });

  it('never leaves the viewport even when the tooltip is wider than it', () => {
    const p = placeTooltip({ left: 10, top: 10, width: 28, height: 28 }, { width: 400, height: 24 }, { width: 200, height: 300 });
    expect(p.left).toBe(TOOLTIP_MARGIN_PX);
  });
});

describe('parseTooltipText', () => {
  it('lifts a trailing chord out of a legacy title string', () => {
    expect(parseTooltipText('Load playlist… (Ctrl+O)')).toEqual({ text: 'Load playlist…', shortcut: 'Ctrl+O' });
  });

  it('leaves a parenthetical that is not a chord alone', () => {
    expect(parseTooltipText('Running in secondary monitor mode (read-only)')).toEqual({
      text: 'Running in secondary monitor mode (read-only)',
    });
  });

  it('keeps plain text intact', () => {
    expect(parseTooltipText('  Settings  ')).toEqual({ text: 'Settings' });
  });
});

describe('v-tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hideTooltip();
  });

  afterEach(() => {
    hideTooltip();
    vi.useRealTimers();
  });

  /** A directive reads far more clearly in a template than in a render fn. */
  const mountTpl = (template: string, setup: () => Record<string, unknown> = () => ({})) =>
    mount(defineComponent({ directives: { tooltip: vTooltip }, template, setup }), { attachTo: document.body });

  it('waits the full delay before showing, and shows the bound text', async () => {
    const w = mountTpl(`<button v-tooltip="'Settings'">x</button>`);
    stubAnchor(w.element as HTMLElement, {});
    await w.trigger('pointerenter');

    vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
    expect(activeTooltip.value).toBeNull();

    vi.advanceTimersByTime(1);
    expect(activeTooltip.value?.text).toBe('Settings');
    w.unmount();
  });

  it('shows nothing if the pointer leaves before the delay elapses', async () => {
    const w = mountTpl(`<button v-tooltip="'Settings'">x</button>`);
    await w.trigger('pointerenter');
    vi.advanceTimersByTime(200);
    await w.trigger('pointerleave');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(activeTooltip.value).toBeNull();
    w.unmount();
  });

  it('ignores a touch "hover" — it would cover the control being pressed', async () => {
    const w = mountTpl(`<button v-tooltip="'Settings'">x</button>`);
    await w.trigger('pointerenter', { pointerType: 'touch' });
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS * 2);
    expect(activeTooltip.value).toBeNull();
    w.unmount();
  });

  it('dismisses on press — the operator has committed and wants to see the result', async () => {
    const w = mountTpl(`<button v-tooltip="'Settings'">x</button>`);
    await w.trigger('pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(activeTooltip.value).not.toBeNull();
    await w.trigger('pointerdown');
    expect(activeTooltip.value).toBeNull();
    w.unmount();
  });

  it('takes the native title off the element so the two never stack', () => {
    const w = mountTpl(`<button v-tooltip="'Settings'" title="Settings">x</button>`);
    expect(w.element.hasAttribute('title')).toBe(false);
    w.unmount();
    // Restored on unmount, so a non-tooltip consumer of the DOM is unaffected.
    expect(w.element.getAttribute('title')).toBe('Settings');
  });

  it('adopts the native title as its text when no value is bound', async () => {
    const w = mountTpl(`<button v-tooltip title="Save playlist… (Ctrl+S)">x</button>`);
    expect(w.element.hasAttribute('title')).toBe(false);
    await w.trigger('pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(activeTooltip.value?.text).toBe('Save playlist…');
    expect(activeTooltip.value?.shortcut).toBe('Ctrl+S');
    w.unmount();
  });

  it('re-strips a title that the host component re-binds on every patch', async () => {
    const w = mountTpl(`<button v-tooltip="'Settings'" :title="t">x</button>`, () => {
      const t = ref('a');
      return { t };
    });
    expect(w.element.hasAttribute('title')).toBe(false);
    (w.vm as unknown as { t: string }).t = 'b';
    await nextTick();
    expect(w.element.hasAttribute('title')).toBe(false);
    w.unmount();
  });

  it('carries a shortcut through as a separate field, for the Kbd cap', async () => {
    const w = mountTpl(`<button v-tooltip="{ text: 'Save playlist…', shortcut: 'Ctrl+S' }">x</button>`);
    await w.trigger('pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(activeTooltip.value).toMatchObject({ text: 'Save playlist…', shortcut: 'Ctrl+S' });
    w.unmount();
  });

  it('describes the control rather than naming it', async () => {
    const w = mountTpl(`<button v-tooltip="'Delete playlist'" aria-label="Delete playlist">x</button>`);
    await w.trigger('pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(w.element.getAttribute('aria-describedby')).toBe(activeTooltip.value?.id);
    expect(w.element.getAttribute('aria-label')).toBe('Delete playlist');
    await w.trigger('pointerleave');
    expect(w.element.hasAttribute('aria-describedby')).toBe(false);
    w.unmount();
  });

  it('follows a label that changes while it is open — the armed Delete', async () => {
    const w = mountTpl(`<button v-tooltip="label">x</button>`, () => {
      const label = ref('Delete playlist');
      return { label };
    });
    await w.trigger('pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(activeTooltip.value?.text).toBe('Delete playlist');

    (w.vm as unknown as { label: string }).label = 'Delete “Morning block”?';
    await nextTick();
    expect(activeTooltip.value?.text).toBe('Delete “Morning block”?');
    w.unmount();
  });

  it('shows nothing at all when the binding is empty', async () => {
    const w = mountTpl(`<button v-tooltip="''">x</button>`);
    await w.trigger('pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(activeTooltip.value).toBeNull();
    w.unmount();
  });

  it('clears itself when the control unmounts mid-hover', async () => {
    const w = mountTpl(`<button v-tooltip="'Settings'">x</button>`);
    await w.trigger('pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(activeTooltip.value).not.toBeNull();
    w.unmount();
    expect(activeTooltip.value).toBeNull();
  });

  it('never shows two at once', async () => {
    const w = mountTpl(`<div><button id="a" v-tooltip="'A'">a</button><button id="b" v-tooltip="'B'">b</button></div>`);
    await w.find('#a').trigger('pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    await w.find('#b').trigger('pointerenter');
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(activeTooltip.value?.text).toBe('B');
    expect(w.find('#a').element.hasAttribute('aria-describedby')).toBe(false);
    w.unmount();
  });

});
