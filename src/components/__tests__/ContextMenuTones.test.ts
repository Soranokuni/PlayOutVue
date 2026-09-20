// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ContextMenu, { type MenuItem } from '../ContextMenu.vue';
import { closeActiveContextMenu } from '../../lib/activeContextMenu';
import { commercialTagTone, contentTypeTone, ratingBadge, ratingTone } from '../../lib/menuTones';

/**
 * The context menu's colour vocabulary.
 *
 * Every row used to be the same grey, so a menu mixing "inspect this", "give
 * this an 18 rating" and "delete this permanently" read as one undifferentiated
 * list. A tone maps a row to the colour that concept already carries elsewhere;
 * these tests pin that the mapping reaches the DOM and that the two menus which
 * share these vocabularies cannot drift into two palettes.
 */
describe('Context menu tones', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    closeActiveContextMenu();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('maps every compliance vocabulary to the token family it uses elsewhere', () => {
    expect(['k', '8', '12', '16', '18'].map(ratingTone)).toEqual([
      'rating-k',
      'rating-8',
      'rating-12',
      'rating-16',
      'rating-18',
    ]);
    // "No rating" is the absence of a mark; colouring it would imply one.
    expect(ratingTone('none')).toBe('neutral');
    expect(ratingTone(undefined)).toBe('neutral');
    expect(ratingBadge('12')).toBe('12');
    expect(ratingBadge('none')).toBe('–');

    expect(contentTypeTone('documentary')).toBe('type-documentary');
    expect(contentTypeTone('none')).toBe('neutral');
    expect(commercialTagTone('spot')).toBe('tag-spot');
    expect(commercialTagTone('none')).toBe('neutral');
  });

  it('puts the tone on the row and renders its badge and swatch', async () => {
    const items: MenuItem[] = [
      { type: 'action', id: 'rate', label: '18', tone: 'rating-18', badge: '18', action: () => {} },
      { type: 'action', id: 'colour', label: 'Red', swatch: '#e63946', action: () => {} },
      { type: 'action', id: 'plain', label: 'Rename', action: () => {} },
      { type: 'action', id: 'nuke', label: 'Delete permanently…', danger: true, action: () => {} },
    ];
    const wrapper = mount(ContextMenu, { props: { x: 10, y: 10, items }, attachTo: document.body });
    await nextTick();

    const rows = wrapper.findAll('.menu-item');
    expect(rows[0].attributes('data-tone')).toBe('rating-18');
    expect(rows[0].find('.menu-item-badge').text()).toBe('18');

    // A folder colour is operator data, not a theme token, so it renders as a
    // swatch rather than resolving to a tone.
    expect(rows[1].find('.menu-item-swatch').attributes('style')).toContain('#e63946');
    expect(rows[1].attributes('data-tone')).toBe('neutral');

    // A row with no opinion stays neutral; `danger: true` is already a colour
    // decision and resolves to the danger tone without restating it.
    expect(rows[2].attributes('data-tone')).toBe('neutral');
    expect(rows[3].attributes('data-tone')).toBe('danger');
    wrapper.unmount();
  });

  it('tones the icon-only top action bar, where a label cannot explain the verb', async () => {
    const wrapper = mount(ContextMenu, {
      props: {
        x: 10,
        y: 10,
        items: [],
        topActions: [
          { id: 'rename', tooltip: 'Rename asset', action: () => {} },
          { id: 'purge', tooltip: 'Delete permanently', action: () => {} },
        ],
      },
      attachTo: document.body,
    });
    await nextTick();

    const buttons = wrapper.findAll('.action-btn');
    expect(buttons[0].attributes('data-tone')).toBe('accent');
    expect(buttons[1].attributes('data-tone')).toBe('danger');
    // Icon-only, so the tooltip has to also be the accessible name.
    expect(buttons[1].attributes('aria-label')).toBe('Delete permanently');
    wrapper.unmount();
  });
});
