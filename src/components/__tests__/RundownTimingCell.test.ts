// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import RundownRow from '../RundownRow.vue';
import type { RundownItem } from '../../stores/rundown';

/**
 * Round 3 §3 — the on-air row's timing cell.
 *
 * The playing row stacked three values in a 96 px column (`-00:22`, then
 * `00:00:12 / 00:00:34`) while a 68 px `At` column squeezed the word `ON AIR`
 * in beside them. The owner circled it. What an operator needs from that cell,
 * in order, is: time remaining, then elapsed / total, and the on-air state is
 * already said by the row tint, the left bar and the tab's pill.
 *
 * These pin the resulting anatomy: two lines while playing, one at rest, a
 * pill rather than bare text in the `At` column, and a countdown that changes
 * colour under ten seconds without changing the cell's shape.
 */
describe('Round 3 §3 · Rundown timing cell', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const item = {
    id: 'item-1',
    playoutvueId: 'asset-1',
    name: 'Test Clip',
    display_name: 'Test Clip',
    type: 'video',
    duration_ms: 34000,
    complianceRating: 'none',
    tp_flag: false,
    content_type: 'none',
  } as unknown as RundownItem;

  const mountRow = (overrides: Record<string, unknown> = {}) =>
    mount(RundownRow, {
      props: {
        item,
        index: 0,
        selected: false,
        playing: false,
        played: false,
        nextUp: false,
        nextUpImminent: false,
        progressPct: 0,
        progressTone: '' as const,
        countdown: '',
        elapsedLabel: '',
        totalLabel: '00:00:34',
        dayLabel: '·',
        atKind: '' as const,
        atText: '',
        playProtected: false,
        ...overrides,
      },
    });

  it('renders exactly two lines on the playing row', () => {
    const wrapper = mountRow({
      countdown: '-00:22',
      elapsedLabel: '00:12',
      totalLabel: '00:34',
      atKind: 'now',
      playing: true,
      progressTone: 'red',
      progressPct: 35,
    });

    const cell = wrapper.get('.rw-dur');
    expect(cell.find('.rw-countdown').text()).toBe('-00:22');
    expect(cell.find('.rw-dur-sub').text()).toBe('00:12 / 00:34');
    // The single-value line is the *alternative* to the pair, never both.
    expect(cell.find('.rw-dur-value').exists()).toBe(false);
  });

  it('renders the At column as a pill, not as a fourth sentence', () => {
    const wrapper = mountRow({ countdown: '-00:22', elapsedLabel: '00:12', totalLabel: '00:34', atKind: 'now' });

    const at = wrapper.get('.rw-at');
    expect(at.find('.rw-onair-pill').exists()).toBe(true);
    expect(at.find('.rw-onair-pill').text()).toBe('ON AIR');
    expect(at.find('.tc-now').exists()).toBe(false);
  });

  it('renders the total alone on a row that is not playing', () => {
    const wrapper = mountRow({ totalLabel: '00:04:53' });

    const cell = wrapper.get('.rw-dur');
    expect(cell.find('.rw-countdown').exists()).toBe(false);
    expect(cell.find('.rw-dur-sub').exists()).toBe(false);
    expect(cell.get('.rw-dur-value').text()).toBe('00:04:53');
  });

  it('marks the last ten seconds without reflowing the cell', () => {
    const relaxed = mountRow({ countdown: '-00:22', elapsedLabel: '00:12', totalLabel: '00:34' });
    expect(relaxed.get('.rw-countdown').classes()).not.toContain('is-imminent');

    const urgent = mountRow({ countdown: '-00:09', elapsedLabel: '00:25', totalLabel: '00:34' });
    expect(urgent.get('.rw-countdown').classes()).toContain('is-imminent');

    // An hour-long clip at T-1:05:03 is not imminent, and the parse must not
    // read "05" as the seconds.
    const long = mountRow({ countdown: '-01:05:03', elapsedLabel: '10:00', totalLabel: '1:15:03' });
    expect(long.get('.rw-countdown').classes()).not.toContain('is-imminent');
  });

  it('drives progress from a transform overlay, not a repainting background', () => {
    const wrapper = mountRow({ progressTone: 'red', progressPct: 40, playing: true });

    const hairline = wrapper.get('.rw-progress-hairline');
    expect(hairline.attributes('style')).toContain('scaleX(0.4)');
    // The row itself carries no inline background any more.
    expect(wrapper.get('.rw-row').attributes('style') ?? '').not.toContain('linear-gradient');
    expect(wrapper.get('.rw-row').attributes('data-progress-tone')).toBe('red');
  });

  it('draws no hairline on a row that is not playing', () => {
    expect(mountRow().find('.rw-progress-hairline').exists()).toBe(false);
  });
});
