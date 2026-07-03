import { invoke } from '@tauri-apps/api/core';
import type { RundownItem } from './rundownHydrator';
import { useSettingsStore } from '../stores/settings';

export interface FrameTrimResult {
    in_frame: number;
    out_frame: number;
    duration_frames: number;
    fps_rational: string;
}

/**
 * Prepares the path to be relative to the CasparCG media folder.
 */
async function preparePath(clientPath: string): Promise<string> {
    const settings = useSettingsStore();
    try {
        const prepared = await invoke<string>('prepare_caspar_media_path', {
            path: clientPath,
            mediaRoot: settings.localMediaPath || ''
        });
        return prepared.replace(/\\/g, '/').replace(/"/g, '');
    } catch (e) {
        console.warn('[playoutDispatch] Failed to prepare path via invoke, using local fallback:', e);
        let p = clientPath.replace(/\\/g, '/');
        const mediaRoot = (settings.localMediaPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (mediaRoot) {
            const pLower = p.toLowerCase();
            const rootLower = mediaRoot.toLowerCase();
            if (pLower.startsWith(rootLower)) {
                p = p.substring(mediaRoot.length).replace(/^\/+/, '');
            } else {
                const rootParts = mediaRoot.split('/');
                const rootBaseName = (rootParts[rootParts.length - 1] || '').toLowerCase();
                const pParts = p.split('/');
                const rootIdx = pParts.findIndex(s => s.toLowerCase() === rootBaseName);
                if (rootIdx >= 0) {
                    p = pParts.slice(rootIdx + 1).join('/');
                } else {
                    p = pParts[pParts.length - 1] || p;
                }
            }
        }
        return p.replace(/"/g, '');
    }
}

export async function dispatchPlay(
    item: RundownItem,
    channel: number,
    layer: number,
    nextPath: string | null = null
): Promise<{ durationMs: number; expectedOutMs: number }> {
    // 1. compute_frame_trim
    const trim = await invoke<FrameTrimResult>('compute_frame_trim', {
        path: item.path,
        trimInMs: item.trim_in_ms,
        trimOutMs: item.trim_out_ms
    });

    // 2. prepare path
    const formattedPath = await preparePath(item.path);

    // 3. Construct and send AMCP command
    const cmd = `PLAY ${channel}-${layer} "${formattedPath}" SEEK ${trim.in_frame} LENGTH ${trim.duration_frames}`;
    await invoke('caspar_send_command', { cmd });

    // 4. Calculate precise expected duration and expected out ms
    const durationMs = Math.round((trim.duration_frames / (item.fps_num / item.fps_den)) * 1000);
    const expectedOutMs = item.trim_in_ms + durationMs;

    // 5. Register playback with backend
    await invoke('caspar_register_playback', {
        uuid: item.id,
        durationMs,
        expectedOutPointMs: expectedOutMs,
        currentPath: formattedPath,
        nextPath
    });

    return { durationMs, expectedOutMs };
}

export async function dispatchLoadbg(
    item: RundownItem,
    channel: number,
    layer: number
): Promise<{ durationMs: number; expectedOutMs: number }> {
    // 1. compute_frame_trim
    const trim = await invoke<FrameTrimResult>('compute_frame_trim', {
        path: item.path,
        trimInMs: item.trim_in_ms,
        trimOutMs: item.trim_out_ms
    });

    // 2. prepare path
    const formattedPath = await preparePath(item.path);

    // 3. Construct and send LOADBG command with AUTO
    const cmd = `LOADBG ${channel}-${layer} "${formattedPath}" SEEK ${trim.in_frame} LENGTH ${trim.duration_frames} AUTO`;
    await invoke('caspar_send_command', { cmd });

    // 4. Calculate duration and expected out point
    const durationMs = Math.round((trim.duration_frames / (item.fps_num / item.fps_den)) * 1000);
    const expectedOutMs = item.trim_in_ms + durationMs;

    return { durationMs, expectedOutMs };
}
