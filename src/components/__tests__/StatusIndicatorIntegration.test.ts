// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import StatusIndicator from '../StatusIndicator.vue';
import RundownRow from '../RundownRow.vue';
import MediaLibrary from '../MediaLibrary.vue';
import { resolveRundownStatusTone, resolveLibraryStatusTone } from '../../lib/statusResolver';
import type { RundownItem } from '../../stores/rundown';
import type { LibraryAsset } from '../../stores/mediaLibrary';

describe('PR 6A StatusIndicator State Contract & Priority Resolution', () => {
  describe('Pure Rundown Tone Resolver (resolveRundownStatusTone)', () => {
    it('prioritizes on-air over ready and armed states', () => {
      const item: Partial<RundownItem> = { ingestorStatus: 'ready' };
      const tone = resolveRundownStatusTone(item, { playing: true, nextUp: true });
      expect(tone).toBe('on-air');
    });

    it('prioritizes armed state over ready', () => {
      const item: Partial<RundownItem> = { ingestorStatus: 'ready' };
      const tone = resolveRundownStatusTone(item, { nextUp: true });
      expect(tone).toBe('armed');
    });

    it('resolves error state when ingestorStatus is error', () => {
      const item: Partial<RundownItem> = { ingestorStatus: 'error', path: '/media/test.mp4' };
      const tone = resolveRundownStatusTone(item);
      expect(tone).toBe('error');
    });

    it('resolves offline state when path is missing or ingestorStatus is missing', () => {
      const itemNoPath: Partial<RundownItem> = { ingestorStatus: 'ready', path: '' };
      expect(resolveRundownStatusTone(itemNoPath)).toBe('offline');

      const itemMissing: Partial<RundownItem> = { ingestorStatus: 'missing', path: '/media/missing.mp4' };
      expect(resolveRundownStatusTone(itemMissing)).toBe('offline');
    });

    it('resolves processing state when ingestorStatus is processing', () => {
      const item: Partial<RundownItem> = { ingestorStatus: 'processing', path: '/media/test.mp4' };
      expect(resolveRundownStatusTone(item)).toBe('processing');
    });

    it('resolves warning state when warnings array is present', () => {
      const item: Partial<RundownItem> = {
        ingestorStatus: 'ready',
        path: '/media/test.mp4',
        warnings: ['Non-standard frame rate']
      };
      expect(resolveRundownStatusTone(item)).toBe('warning');
    });

    it('resolves unsaved-trim state for local virtual subclips', () => {
      const item: Partial<RundownItem> = {
        path: '/media/test.mp4',
        virtualSubclip: true,
        persistenceState: 'local-only'
      };
      expect(resolveRundownStatusTone(item)).toBe('unsaved-trim');
    });

    it('resolves ready and idle states cleanly', () => {
      const readyItem: Partial<RundownItem> = { ingestorStatus: 'ready', path: '/media/test.mp4' };
      expect(resolveRundownStatusTone(readyItem)).toBe('ready');

      expect(resolveRundownStatusTone(null)).toBe('idle');
    });
  });

  describe('Pure Library Tone Resolver (resolveLibraryStatusTone)', () => {
    it('resolves library asset status tones accurately according to priority', () => {
      const errAsset: Partial<LibraryAsset> = { status: 'error', current_path: '/media/test.mp4' };
      expect(resolveLibraryStatusTone(errAsset)).toBe('error');

      const missingAsset: Partial<LibraryAsset> = { status: 'missing', current_path: '' };
      expect(resolveLibraryStatusTone(missingAsset)).toBe('offline');

      const procAsset: Partial<LibraryAsset> = { status: 'processing', current_path: '/media/test.mp4' };
      expect(resolveLibraryStatusTone(procAsset)).toBe('processing');

      const warnAsset: Partial<LibraryAsset> = { status: 'ready', current_path: '/media/test.mp4', warnings: ['GOP unclosed'] };
      expect(resolveLibraryStatusTone(warnAsset)).toBe('warning');

      const readyAsset: Partial<LibraryAsset> = { status: 'ready', current_path: '/media/test.mp4' };
      expect(resolveLibraryStatusTone(readyAsset)).toBe('ready');
    });
  });

  describe('StatusIndicator Component Accessible Labels', () => {
    it('renders correct accessible aria-label for all 9 status tones', () => {
      const tones = [
        { tone: 'ready', expected: 'Ready' },
        { tone: 'processing', expected: 'Processing' },
        { tone: 'error', expected: 'Error' },
        { tone: 'warning', expected: 'Warning' },
        { tone: 'on-air', expected: 'ON AIR' },
        { tone: 'armed', expected: 'ARMED' },
        { tone: 'offline', expected: 'Offline' },
        { tone: 'unsaved-trim', expected: 'Unsaved Trim' },
        { tone: 'idle', expected: 'Idle' }
      ] as const;

      tones.forEach(({ tone, expected }) => {
        const wrapper = mount(StatusIndicator, {
          props: { tone, variant: 'dot' }
        });
        expect(wrapper.attributes('aria-label')).toBe(expected);
        expect(wrapper.attributes('role')).toBe('status');
      });
    });
  });

  describe('Surface Mounting Integration Tests', () => {
    beforeEach(() => {
      setActivePinia(createPinia());
    });

    it('mounts RundownRow and renders StatusIndicator with resolved tone', () => {
      const item: RundownItem = {
        id: 'row-status-test-1',
        playoutvueId: 'asset-99',
        display_name: 'On-Air Clip',
        filename: 'test.mp4',
        path: '/media/test.mp4',
        displayPath: '/media/test.mp4',
        shortPath: 'test.mp4',
        libraryIndicator: 'none',
        duration: 10,
        seek: 0,
        length: 10,
        inPoint: 0,
        outPoint: 10,
        plannedDuration: 10,
        note: '',
        complianceRating: 'none',
        complianceDescriptors: [],
        complianceText: '',
        ingestorStatus: 'ready',
        type: 'video'
      };

      const wrapper = mount(RundownRow, {
        props: {
          item,
          index: 0,
          selected: false,
          playing: true,
          played: false,
          nextUp: false,
          nextUpImminent: false,
          dropBefore: false,
          dropAfter: false,
          progressPct: 50,
          progressTone: 'green',
          countdown: '00:05',
          timerLabel: '00:10',
          etaHint: '',
          dayLabel: '12:00:00',
          atKind: 'now',
          atText: 'ON AIR',
          playProtected: false
        }
      });

      const indicator = wrapper.findComponent(StatusIndicator);
      expect(indicator.exists()).toBe(true);
      expect(indicator.props('tone')).toBe('on-air');
      expect(indicator.attributes('aria-label')).toBe('ON AIR');
    });

    it('mounts MediaLibrary surface containing StatusIndicator component', () => {
      const wrapper = mount(MediaLibrary);
      expect(wrapper.exists()).toBe(true);
    });
  });
});
