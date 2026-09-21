// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount } from '@vue/test-utils';
import AppIcon from '../ui/AppIcon.vue';
import { ICONS, ICON_NAMES } from '../ui/icons';

/**
 * UI F-10. The app used 224 emoji as icons: full colour, so unthemeable;
 * inconsistent in weight and baseline; illegible at chip sizes; and
 * semantically random (four different glyphs all meaning "close").
 */
describe('UI F-10 · AppIcon', () => {
  it('draws in currentColor so it inherits the theme', () => {
    const wrapper = mount(AppIcon, { props: { name: 'play' } });
    expect(wrapper.attributes('stroke')).toBe('currentColor');
    expect(wrapper.attributes('fill')).toBe('none');
  });

  it('is decorative unless given a title', () => {
    const plain = mount(AppIcon, { props: { name: 'trash' } });
    expect(plain.attributes('aria-hidden')).toBe('true');
    expect(plain.attributes('role')).toBeUndefined();

    const named = mount(AppIcon, { props: { name: 'trash', title: 'Delete' } });
    expect(named.attributes('aria-hidden')).toBeUndefined();
    expect(named.attributes('role')).toBe('img');
    expect(named.attributes('aria-label')).toBe('Delete');
  });

  it('renders at the requested size on a 24-grid', () => {
    const wrapper = mount(AppIcon, { props: { name: 'close', size: 20 } });
    expect(wrapper.attributes('width')).toBe('20');
    expect(wrapper.attributes('height')).toBe('20');
    expect(wrapper.attributes('viewBox')).toBe('0 0 24 24');
  });

  it('renders the named glyph', () => {
    const wrapper = mount(AppIcon, { props: { name: 'check' } });
    // The DOM re-serialises `<path/>` as `<path></path>`, so compare the data.
    const d = ICONS.check.match(/d="([^"]+)"/)?.[1];
    expect(d).toBeTruthy();
    expect(wrapper.find('path').attributes('d')).toBe(d);
  });

  it('spins only when asked', () => {
    expect(mount(AppIcon, { props: { name: 'processing' } }).classes()).not.toContain('is-spinning');
    expect(mount(AppIcon, { props: { name: 'processing', spin: true } }).classes()).toContain('is-spinning');
  });

  it('ships no unused icon', () => {
    const sources = [
      'App.vue',
      'components/MediaLibrary.vue',
      'components/RundownList.vue',
      'components/RundownRow.vue',
      'components/PlaylistControls.vue',
      'components/ContextMenu.vue',
      'components/TrimPanel.vue',
      'components/ComplianceModule.vue',
      'components/MediaInspector.vue',
      'components/CommandPaletteModal.vue',
      'components/FolderPickerModal.vue',
      'components/ui/AppIcon.vue',
      // Round 3 §5.2: the toast host owns the Undo affordance's glyph.
      'components/ui/ToastHost.vue',
    ]
      .map((f) => readFileSync(join(process.cwd(), 'src', f), 'utf8'))
      .join('\n');

    const unused = ICON_NAMES.filter((name) => !sources.includes(`'${name}'`) && !sources.includes(`"${name}"`));

    // Phase 1.3 covers these five files; later phases migrate the dialogs and
    // will consume the rest. Any icon still unused when Phase 7 lands should be
    // deleted rather than carried.
    // Shrinks as the phases land; it may never grow. These three are consumed
    // by dialogs the migration has not reached yet.
    // Round 3 §4 consumes `more-horizontal` in the control bar's More popover.
    const expectedPending = ['chevron-down', 'help', 'arrow-up', 'more-horizontal'];

    expect(unused.filter((n) => !expectedPending.includes(n))).toEqual([]);
  });

  it('keeps every glyph on the 24-grid with no baked-in colour', () => {
    for (const [name, markup] of Object.entries(ICONS)) {
      // `fill="currentColor"` is allowed for solid dots; a literal is not.
      expect(markup, `${name} carries a colour literal`).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
      expect(markup.length, `${name} is empty`).toBeGreaterThan(0);
    }
  });
});
