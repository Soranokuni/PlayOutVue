// TRIM-CONTRACT-AUDIT C-5: a trim the transcoder refuses must never reach the
// rundown, and a server asset's OUT must not be sent past its registry duration.
import { describe, it, expect, vi } from 'vitest';
import { saveAssetTrim, resolveTrimToSave } from '../trimSave';

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const asset = { id: UUID, uuid: UUID, path: 'D:/media/spot.mp4', duration_ms: 37_680 };

describe('saveAssetTrim', () => {
    it('does not touch the rundown when the server rejects the save', async () => {
        const invoke = vi.fn().mockRejectedValue(new Error('HTTP 422: OUT beyond duration'));
        const applyToRundown = vi.fn();

        await expect(saveAssetTrim(asset, 5_000, 20_000, { invoke, applyToRundown })).rejects.toThrow('422');
        expect(applyToRundown).not.toHaveBeenCalled();
    });

    it('applies to the rundown only after the server accepted the save', async () => {
        const order: string[] = [];
        const invoke = vi.fn(async () => { order.push('put'); });
        const applyToRundown = vi.fn(() => { order.push('apply'); });

        await saveAssetTrim(asset, 5_000.4, 20_000.6, { invoke, applyToRundown });

        expect(order).toEqual(['put', 'apply']);
        expect(invoke).toHaveBeenCalledWith('update_ingestor_trim', {
            uuid: UUID, trim_in_ms: 5_000, trim_out_ms: 20_001, api_base_url_override: null
        });
        expect(applyToRundown).toHaveBeenCalledWith({ id: UUID, uuid: UUID }, 5_000, 20_001);
    });

    it('clamps a server OUT taken from <video>.duration to the registry duration', async () => {
        const invoke = vi.fn(async () => undefined);
        const applyToRundown = vi.fn();

        const saved = await saveAssetTrim(asset, 1_000, 37_720, { invoke, applyToRundown });

        expect(saved).toEqual({ inMs: 1_000, outMs: 37_680, clamped: true });
        expect(invoke).toHaveBeenCalledWith('update_ingestor_trim', expect.objectContaining({ trim_out_ms: 37_680 }));
        expect(applyToRundown).toHaveBeenCalledWith({ id: UUID, uuid: UUID }, 1_000, 37_680);
    });

    it('saves a local file through its trim profile, unclamped, then applies it', async () => {
        const local = { id: 'local:D:/x.mp4', uuid: 'local:D:/x.mp4', path: 'D:/x.mp4', duration_ms: 10_000 };
        const invoke = vi.fn(async () => undefined);
        const applyToRundown = vi.fn();

        await saveAssetTrim(local, 0, 12_000, { invoke, applyToRundown });

        expect(invoke).toHaveBeenCalledWith('save_media_trim_profile', { path: 'D:/x.mp4', inMs: 0, outMs: 12_000 });
        expect(applyToRundown).toHaveBeenCalledWith({ id: local.id, uuid: local.uuid }, 0, 12_000);
    });

    it('refuses a window that the clamp leaves empty, before any call', async () => {
        const invoke = vi.fn();
        const applyToRundown = vi.fn();

        await expect(saveAssetTrim(asset, 37_680, 40_000, { invoke, applyToRundown })).rejects.toThrow('OUT point');
        expect(invoke).not.toHaveBeenCalled();
        expect(applyToRundown).not.toHaveBeenCalled();
        expect(() => resolveTrimToSave(asset, 2_000, 2_000)).toThrow();
    });
});
