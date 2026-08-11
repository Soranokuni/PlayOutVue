// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createVirtualSubclip } from '../../services/virtualSubclipService';
import type { RundownItem } from '../../stores/rundown';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

describe('PR 5C Virtual Subclip Service & Persistence', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('creates local-only subclip when asset UUID is local: or backend is offline', async () => {
    const item: RundownItem = {
      id: 'local-item-1',
      playoutvueId: 'local:asset-123',
      uuid: 'local:asset-123',
      filename: 'test.mp4',
      path: '/media/test.mp4',
      displayPath: '/media/test.mp4',
      shortPath: 'test.mp4',
      libraryIndicator: 'none',
      duration: 20,
      seek: 0,
      length: 20,
      inPoint: 0,
      outPoint: 20,
      plannedDuration: 20,
      note: '',
      complianceRating: 'none',
      complianceDescriptors: [],
      complianceText: '',
      ingestorStatus: 'idle',
      type: 'video',
      duration_ms: 20000,
      trim_in_ms: 0,
      trim_out_ms: 20000
    };

    const result = await createVirtualSubclip({
      item,
      displayName: 'Local Subclip Test',
      trimInMs: 2000,
      trimOutMs: 8000
    });

    expect(result.state).toBe('local-only');
    expect(result.item).toBeDefined();
    expect(result.item?.display_name).toBe('Local Subclip Test');
    expect(result.item?.duration_ms).toBe(6000); // 8000 - 2000
    expect(result.item?.trim_in_ms).toBe(2000);
    expect(result.item?.trim_out_ms).toBe(8000);
    expect(result.item?.parentAssetUuid).toBe('local:asset-123');
    expect(result.item?.virtualSubclip).toBe(true);
    expect(result.item?.persistenceState).toBe('local-only');

    // Original item remains unchanged
    expect(item.trim_in_ms).toBe(0);
    expect(item.trim_out_ms).toBe(20000);
  });

  it('persists subclip via backend IPC and marks ready ONLY if mezzanine_ok/ready confirmed', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      uuid: 'server-subclip-uuid-999',
      current_path: '/media/test.mp4',
      status: 'processing',
      mezzanine_ok: false
    });

    const item: RundownItem = {
      id: 'server-item-1',
      playoutvueId: 'server-uuid-123',
      uuid: 'server-uuid-123',
      filename: 'test.mp4',
      path: '/media/test.mp4',
      displayPath: '/media/test.mp4',
      shortPath: 'test.mp4',
      libraryIndicator: 'none',
      duration: 30,
      seek: 0,
      length: 30,
      inPoint: 0,
      outPoint: 30,
      plannedDuration: 30,
      note: '',
      complianceRating: 'none',
      complianceDescriptors: [],
      complianceText: '',
      ingestorStatus: 'ready',
      type: 'video',
      duration_ms: 30000,
      trim_in_ms: 0,
      trim_out_ms: 30000
    };

    const result = await createVirtualSubclip({
      item,
      displayName: 'Server Subclip',
      trimInMs: 5000,
      trimOutMs: 15000
    });

    expect(invoke).toHaveBeenCalledWith('create_ingestor_subclip', {
      uuid: 'server-uuid-123',
      display_name: 'Server Subclip',
      trim_in_ms: 5000,
      trim_out_ms: 15000,
      api_base_url_override: null
    });

    expect(result.state).toBe('persisted');
    expect(result.item?.duration_ms).toBe(10000);
    expect(result.item?.playoutvueId).toBe('server-subclip-uuid-999');
    expect(result.item?.parentAssetUuid).toBe('server-uuid-123');
    // Must NOT be marked ready when backend response status is processing and mezzanine_ok is false
    expect(result.item?.ingestorStatus).toBe('processing');
  });

  it('fails safely when backend IPC rejects with an error', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Backend database error'));

    const item: RundownItem = {
      id: 'server-item-2',
      playoutvueId: 'server-uuid-456',
      uuid: 'server-uuid-456',
      filename: 'test.mp4',
      path: '/media/test.mp4',
      displayPath: '/media/test.mp4',
      shortPath: 'test.mp4',
      libraryIndicator: 'none',
      duration: 30,
      seek: 0,
      length: 30,
      inPoint: 0,
      outPoint: 30,
      plannedDuration: 30,
      note: '',
      complianceRating: 'none',
      complianceDescriptors: [],
      complianceText: '',
      ingestorStatus: 'ready',
      type: 'video',
      duration_ms: 30000
    };

    const result = await createVirtualSubclip({
      item,
      displayName: 'Failing Subclip',
      trimInMs: 1000,
      trimOutMs: 5000
    });

    expect(result.state).toBe('failed');
    expect(result.error).toBe('Backend database error');
    expect(result.item).toBeUndefined();
  });

  it('fails safely when parent asset identity is missing', async () => {
    const itemWithoutIdentity = {
      path: '/media/orphan.mp4',
      duration_ms: 10000
    };

    const result = await createVirtualSubclip({
      item: itemWithoutIdentity as any,
      displayName: 'Orphan Subclip',
      trimInMs: 1000,
      trimOutMs: 5000
    });

    expect(result.state).toBe('failed');
    expect(result.error).toContain('parent asset identity is missing');
  });

  it('rejects OUT point exceeding source duration', async () => {
    const item: RundownItem = {
      id: 'item-1',
      playoutvueId: 'asset-1',
      filename: 'clip.mp4',
      path: '/media/clip.mp4',
      displayPath: '/media/clip.mp4',
      shortPath: 'clip.mp4',
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
      type: 'video',
      duration_ms: 10000
    };

    const result = await createVirtualSubclip({
      item,
      displayName: 'Excessive Subclip',
      trimInMs: 2000,
      trimOutMs: 15000 // Exceeds 10000ms
    });

    expect(result.state).toBe('failed');
    expect(result.error).toContain('OUT point exceeds source duration');
  });

  it('preserves exact fractional-second millisecond trim values authoritatively', async () => {
    const item: RundownItem = {
      id: 'item-frac',
      playoutvueId: 'local:asset-frac',
      filename: 'frac.mp4',
      path: '/media/frac.mp4',
      displayPath: '/media/frac.mp4',
      shortPath: 'frac.mp4',
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
      type: 'video',
      duration_ms: 10000
    };

    // Fractional 1234ms IN, 5678ms OUT
    const result = await createVirtualSubclip({
      item,
      displayName: 'Fractional Subclip',
      trimInMs: 1234,
      trimOutMs: 5678
    });

    expect(result.state).toBe('local-only');
    expect(result.item?.trim_in_ms).toBe(1234);
    expect(result.item?.trim_out_ms).toBe(5678);
    expect(result.item?.duration_ms).toBe(4444);
    expect(result.item?.inPoint).toBe(1.234);
    expect(result.item?.outPoint).toBe(5.678);
  });
});
