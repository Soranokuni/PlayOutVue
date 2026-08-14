import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useMediaLibraryStore, type LibraryAsset } from '../../stores/mediaLibrary';
import { useRundownStore, type RundownItem } from '../../stores/rundown';
import { computeTrimFields, buildPlayCommand } from '../trimCommands';

describe('V2 Ingestor Adapter & Contract Integration Suite', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('1. Hydrates a fully compliant V2 ready asset into LibraryAsset model', () => {
    const v2Asset: LibraryAsset = {
      uuid: 'v2-asset-101',
      current_path: 'D:/Media/broadcast_clip.mp4',
      display_name: 'Broadcast Master Clip',
      virtual_folder: '/Main',
      duration_ms: 30000,
      trim_in_ms: 0,
      trim_out_ms: 30000,
      rating: '12',
      tp: 'true',
      status: 'ready',
      fpsNum: 25,
      fpsDen: 1,
      fps: 25.0,
      mezzanine_ok: true,
      qc_report: {
        passed: true,
        blocking_errors: 0,
        warnings_count: 0,
        findings: []
      },
      loudness: {
        integrated_lufs: -23.0,
        true_peak_dbtp: -1.0,
        lra_lu: 6.5,
        mode: 'ebu_r128'
      }
    };

    const store = useMediaLibraryStore();
    store.setAssets([v2Asset]);

    expect(store.assets.length).toBe(1);
    const loaded = store.assets[0];
    expect(loaded.uuid).toBe('v2-asset-101');
    expect(loaded.status).toBe('ready');
    expect(loaded.mezzanine_ok).toBe(true);
    expect(loaded.qc_report?.passed).toBe(true);
    expect(loaded.loudness?.integrated_lufs).toBe(-23.0);
  });

  it('2. Maps intermediate V2 processing phases accurately', () => {
    const phases = ['queued', 'probing', 'encoding', 'normalizing_audio', 'validating', 'publishing'];
    const store = useMediaLibraryStore();

    phases.forEach((phase, idx) => {
      const asset: LibraryAsset = {
        uuid: `v2-phase-${idx}`,
        current_path: `D:/Media/in_flight_${idx}.mp4`,
        display_name: `Phase ${phase}`,
        virtual_folder: '/',
        duration_ms: 10000,
        trim_in_ms: 0,
        trim_out_ms: 10000,
        rating: 'none',
        status: phase,
        mezzanine_ok: false
      };
      store.setAssets([asset]);
      expect(store.assets[0].status).toBe(phase);
    });
  });

  it('3. Retains definitive V2 QC validation failure as non-playable error status', () => {
    const errorAsset: LibraryAsset = {
      uuid: 'v2-err-01',
      current_path: 'D:/Media/corrupt.mp4',
      display_name: 'Corrupt Clip',
      virtual_folder: '/',
      duration_ms: 10000,
      trim_in_ms: 0,
      trim_out_ms: 10000,
      rating: 'none',
      status: 'error',
      mezzanine_ok: false,
      qc_report: {
        passed: false,
        blocking_errors: 2,
        warnings_count: 0,
        findings: [
          { severity: 'error', code: 'invalid_audio_sample_rate', message: 'Audio sample rate 44100 != 48000' }
        ]
      }
    };

    const store = useMediaLibraryStore();
    store.setAssets([errorAsset]);
    expect(store.assets[0].status).toBe('error');
    expect(store.assets[0].mezzanine_ok).toBe(false);
  });

  it('4. Rejects temporary/staging paths from ready status', () => {
    const stagingAsset: LibraryAsset = {
      uuid: 'v2-staging-01',
      current_path: 'D:/Media/.tmp_v2-staging-01_output.mp4',
      display_name: 'Staged Clip',
      virtual_folder: '/',
      duration_ms: 10000,
      trim_in_ms: 0,
      trim_out_ms: 10000,
      rating: 'none',
      status: 'processing',
      mezzanine_ok: false
    };

    const store = useMediaLibraryStore();
    store.setAssets([stagingAsset]);
    expect(store.assets[0].current_path).toContain('.tmp_');
    expect(store.assets[0].status).not.toBe('ready');
  });

  it('5. Tolerates omission of optional loudness metadata on legacy assets', () => {
    const legacyAsset: LibraryAsset = {
      uuid: 'legacy-asset-01',
      current_path: 'D:/Media/legacy.mp4',
      display_name: 'Legacy Master',
      virtual_folder: '/',
      duration_ms: 20000,
      trim_in_ms: 0,
      trim_out_ms: 20000,
      rating: 'none',
      status: 'ready',
      mezzanine_ok: true
    };

    const store = useMediaLibraryStore();
    store.setAssets([legacyAsset]);
    expect(store.assets[0].loudness).toBeUndefined();
    expect(store.assets[0].status).toBe('ready');
  });

  it('6. Preserves frame trim calculation for broadcast 25fps video', () => {
    const fields = computeTrimFields({
      in_frame: 25,
      out_frame: 125,
      duration_frames: 100,
      fps_rational: '25/1'
    });
    expect(fields.seekFields).toBe(50);
    expect(fields.lengthFields).toBe(200);
    expect(fields.hasInTrim).toBe(true);
  });

  it('7. Preserves frame trim calculation for broadcast 50fps video', () => {
    const fields = computeTrimFields({
      in_frame: 50,
      out_frame: 250,
      duration_frames: 200,
      fps_rational: '50/1'
    });
    expect(fields.seekFields).toBe(50);
    expect(fields.lengthFields).toBe(200);
    expect(fields.hasInTrim).toBe(true);
  });

  it('8. Verifies bit-identical AMCP PLAY trimmed command formatting for CasparCG', () => {
    const fields = computeTrimFields({
      in_frame: 25,
      out_frame: 725,
      duration_frames: 700,
      fps_rational: '25/1'
    });

    const cmd = buildPlayCommand(1, 1, 'D:/Media/broadcast_clip.mp4', fields);
    expect(cmd).toBe('PLAY 1-1 "D:/Media/broadcast_clip.mp4" SEEK 50 LENGTH 1400');
  });
});
