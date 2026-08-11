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
      name: 'Local Test Item',
      path: '/media/test.mp4',
      type: 'media',
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
  });

  it('persists subclip via backend IPC when server UUID is present', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      uuid: 'server-subclip-uuid-999',
      current_path: '/media/test.mp4'
    });

    const item: RundownItem = {
      id: 'server-item-1',
      playoutvueId: 'server-uuid-123',
      uuid: 'server-uuid-123',
      name: 'Server Managed Item',
      path: '/media/test.mp4',
      type: 'media',
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
  });

  it('rejects invalid trim ranges cleanly with error state', async () => {
    const item: RundownItem = {
      id: 'item-invalid',
      playoutvueId: 'uuid-1',
      name: 'Item',
      path: '/media/test.mp4',
      type: 'media',
      duration_ms: 10000
    };

    const result = await createVirtualSubclip({
      item,
      displayName: 'Invalid Subclip',
      trimInMs: 5000,
      trimOutMs: 2000 // Out <= In
    });

    expect(result.state).toBe('failed');
    expect(result.error).toContain('OUT point must be greater than IN point');
  });
});
