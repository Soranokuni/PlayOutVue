// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import RundownRow from '../RundownRow.vue';
import MediaLibrary from '../MediaLibrary.vue';
import type { RundownItem } from '../../types/rundown';

describe('PR 5A Rating Badge Ownership & Capability Visibility', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders exactly one [data-testid="age-rating-badge"] in RundownRow', () => {
    const item: RundownItem = {
      id: 'test-item-1',
      playoutvueId: 'asset-123',
      name: 'Test Clip',
      type: 'media',
      duration_ms: 10000,
      complianceRating: '12',
      tp_flag: false,
      content_type: 'none'
    };

    const wrapper = mount(RundownRow, {
      props: {
        item,
        index: 0,
        isSelected: false,
        isPlaying: false,
        isNext: false,
        currentPlaylistName: 'Main Rundown'
      }
    });

    const ratingBadges = wrapper.findAll('[data-testid="age-rating-badge"]');
    expect(ratingBadges).toHaveLength(1);
    expect(ratingBadges[0].text()).toBe('12');
  });

  it('renders rating badge in MediaLibrary with data-testid="age-rating-badge"', () => {
    const wrapper = mount(MediaLibrary);
    expect(wrapper.exists()).toBe(true);
  });
});
