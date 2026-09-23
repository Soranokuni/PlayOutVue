// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import RundownRow from '../RundownRow.vue';
import type { RundownItem } from '../../stores/rundown';

// The minimal rundown lost the colour an operator used to find the ad breaks,
// the films and the kids' block by. Content type now tints the row faintly and
// draws a 4px bar; the ΕΣΡ letters sit in the flags column.

const baseItem = {
  id: 'item-1', playoutvueId: 'asset-1', display_name: 'Clip', type: 'video', duration_ms: 30000,
  complianceRating: '12', complianceDescriptors: ['violence'], tp_flag: false,
  content_type: 'none', libraryIndicator: 'none',
} as unknown as RundownItem;

const mountRow = (item: Partial<RundownItem>) =>
  mount(RundownRow, {
    props: {
      item: { ...baseItem, ...item } as RundownItem,
      index: 0, selected: false, playing: false, played: false, nextUp: false, nextUpImminent: false,
      progressPct: 0, progressTone: '' as const, countdown: '', elapsedLabel: '', totalLabel: '00:00:30',
      dayLabel: '·', atKind: '' as const, atText: '', playProtected: false,
    },
  });

describe('rundown content type colour', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('marks the row with its content type', () => {
    expect(mountRow({ content_type: 'kids' }).find('.rw-row').attributes('data-content-type')).toBe('kids');
    expect(mountRow({ content_type: 'none' }).find('.rw-row').attributes('data-content-type')).toBeUndefined();
  });

  it('shows a row that only carries the legacy commercial tag as that type, without the old chip', () => {
    const row = mountRow({ content_type: 'none', libraryIndicator: 'spot' });
    expect(row.find('.rw-row').attributes('data-content-type')).toBe('spot');
    expect(row.text()).not.toContain('SPOT');
  });

  it('shows the ΕΣΡ letters in the flags column', () => {
    expect(mountRow({}).find('.rw-flags .desc-chip').text()).toBe('Β');
  });

  it('keeps the content tint weaker than, and before, every state rule', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/RundownRow.vue'), 'utf8');
    const tint = css.indexOf('.rw-row[data-content-type] {');
    expect(tint).toBeGreaterThan(-1);
    for (const state of ['.rw-row.selected {', '.rw-row.next-up {', '.rw-row.playing:not([data-progress-tone]) {']) {
      expect(css.indexOf(state)).toBeGreaterThan(tint);
    }
  });
});
