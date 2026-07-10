import { defineStore } from 'pinia';
import { v4 as uuidv4 } from 'uuid';
import { invoke } from '@tauri-apps/api/core';
import { computed, shallowRef, triggerRef, ref, watch } from 'vue';
import type { LibraryIndicator } from './mediaDefaults';
import { useIngestorStatusStore } from './ingestorStatus';
import { playStartTime, casparPlayoutService } from '../services/caspar';
import { useMediaLibraryStore } from './mediaLibrary';
import { clampTrimIn, clampTrimOut } from '../utils/frameMath';
import { savePlaybackState, loadPlaybackState, clearPlaybackState } from '../lib/playbackPersistence';

export type ComplianceRating = 'none' | 'k' | '8' | '12' | '16' | '18';
export type RundownItemType = 'video' | 'live' | 'graphic' | 'gap';
export type IngestorStatus = 'idle' | 'processing' | 'ready' | 'error' | 'missing';

export interface RundownItem {
    id: string;
    type: RundownItemType;
    playoutvueId?: string;
    path: string;
    displayPath: string;
    shortPath: string;
    filename: string;
    libraryIndicator: LibraryIndicator;
    duration: number;
    seek: number;
    length: number;
    inPoint: number;
    outPoint: number;
    plannedDuration: number;
    note: string;
    complianceRating: ComplianceRating;
    complianceDescriptors: string[];
    complianceText: string;
    hardStartTime?: string;
    ingestorStatus: IngestorStatus;
    display_name?: string;
    virtual_folder?: string;
    current_path?: string;
    duration_ms?: number;
    trim_in_ms?: number;
    trim_out_ms?: number;
    tp_flag?: boolean;
    content_type?: 'movie' | 'show' | 'documentary' | 'news' | 'none';
    timeline?: Array<{ start: number; end: number; text: string }>;
    fps?: number;
    fps_num?: number;
    fps_den?: number;
    mezzanine_ok?: boolean;
    total_frames?: number;
    gop_frames?: number;
    keyframe_safe_start_ms?: number;
    warnings?: string[];
}

export interface RundownPlaylist {
    id: string;
    name: string;
    created: number;
    items: RundownItem[];
    selectedItemId: string | null;
    currentPlayingIndex: number;
    playStartVisibleIndex: number;
    startFromTime: string;
    startFromWeekday: number;
}

export interface PlaylistFile {
    version: '1.0' | '1.1';
    name: string;
    created: number;
    items: Partial<RundownItem>[];
    startFromTime?: string;
    startFromWeekday?: number;
}

export interface OptimizedPlaylistItem {
    t: 'v' | 'l' | 'g' | 'x';
    pid?: string;
    p?: string;
    dp?: string;
    s?: string;
    f?: string;
    i?: LibraryIndicator;
    d?: number;
    k?: number;
    l?: number;
    in?: number;
    out?: number;
    pd?: number;
    n?: string;
    cr?: ComplianceRating;
    cd?: string[];
    ct?: string;
    hs?: string;
    igs?: string;
    tp?: boolean;
    cot?: 'movie' | 'show' | 'documentary' | 'news' | 'none';
    tl?: Array<{ start: number; end: number; text: string }>;
}

export interface OptimizedPlaylistFile {
    format: 'playout-list';
    version: 2;
    playlist: {
        name: string;
        created: number;
        startFromTime?: string;
        startFromWeekday?: number;
    };
    items: OptimizedPlaylistItem[];
}

export type AnyPlaylistFile = PlaylistFile | OptimizedPlaylistFile;

export interface MediaRelinkEntry {
    playoutvueId: string;
    path: string;
    shortPath?: string;
    filename?: string;
    duration?: number;
    trim_in_ms?: number;
    trim_out_ms?: number;
}

type RundownDraft = Omit<RundownItem, 'id' | 'inPoint' | 'outPoint' | 'plannedDuration' | 'note' | 'complianceRating' | 'complianceDescriptors' | 'complianceText' | 'hardStartTime' | 'displayPath' | 'ingestorStatus'>
    & Partial<Pick<RundownItem, 'inPoint' | 'outPoint' | 'plannedDuration' | 'note' | 'complianceRating' | 'complianceDescriptors' | 'complianceText' | 'hardStartTime' | 'displayPath' | 'ingestorStatus'>>;

const defaultPlaylistName = (index: number) => `Playlist ${index}`;

const toCompactType = (type: RundownItemType): OptimizedPlaylistItem['t'] => {
    if (type === 'video') return 'v';
    if (type === 'live') return 'l';
    if (type === 'graphic') return 'g';
    return 'x';
};

const fromCompactType = (type: OptimizedPlaylistItem['t']): RundownItemType => {
    if (type === 'v') return 'video';
    if (type === 'l') return 'live';
    if (type === 'g') return 'graphic';
    return 'gap';
};

const normalizeWeekday = (value: number) => {
    if (!Number.isInteger(value)) {
        return new Date().getDay();
    }

    const normalized = value % 7;
    return normalized < 0 ? normalized + 7 : normalized;
};

const normalizeTimeString = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return '';

    const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return '';

    const hours = Number.parseInt(match[1]!, 10);
    const minutes = Number.parseInt(match[2]!, 10);
    const seconds = Number.parseInt(match[3] || '0', 10);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
        return '';
    }

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}${seconds ? `:${String(seconds).padStart(2, '0')}` : ''}`;
};

const filenameFromPath = (value: string) => {
    const normalized = value.replace(/\\/g, '/');
    return normalized.split('/').pop() || value;
};

export interface BroadcastMetadata {
    ageRating: ComplianceRating;
    tpFlag: boolean;
    contentType: 'movie' | 'show' | 'documentary' | 'news' | 'none';
    timeline: Array<{ start: number; end: number; text: string }>;
}

export const parseBroadcastRating = (ratingStr: string | null | undefined): BroadcastMetadata => {
    const raw = (ratingStr || '').trim();
    if (!raw) {
        return { ageRating: 'none', tpFlag: false, contentType: 'none', timeline: [] };
    }
    const parts = raw.split('|');
    const age = mapApiRatingToCompliance(parts[0]);
    if (parts.length === 1) {
        return { ageRating: age, tpFlag: false, contentType: 'none', timeline: [] };
    }
    const tpFlag = (parts[1] || '').toUpperCase() === 'TP';
    const rawContent = (parts[2] || '').toLowerCase();
    const contentType = ['movie', 'show', 'documentary', 'news'].includes(rawContent)
        ? rawContent as BroadcastMetadata['contentType']
        : 'none';
    
    let timeline: BroadcastMetadata['timeline'] = [];
    if (parts[3]) {
        try {
            timeline = JSON.parse(parts[3]);
            if (!Array.isArray(timeline)) {
                timeline = [];
            }
        } catch (e) {
            console.warn('Failed to parse timeline JSON from rating:', parts[3], e);
        }
    }
    return { ageRating: age, tpFlag, contentType, timeline };
};

export const getMetadataFromAssetResponse = (asset: { rating?: string | null, tp?: string | null }): BroadcastMetadata => {
    let rating = asset.rating || '';
    const tp = asset.tp || 'None';
    if (!rating.includes('|')) {
        const age = mapApiRatingToCompliance(rating);
        const tpFlag = tp.toUpperCase() === 'TP';
        return {
            ageRating: age,
            tpFlag: tpFlag,
            contentType: 'none',
            timeline: []
        };
    }
    return parseBroadcastRating(rating);
};

export const serializeBroadcastRating = (meta: BroadcastMetadata): string => {
    const age = (meta.ageRating || 'none').toUpperCase();
    const tp = meta.tpFlag ? 'TP' : 'NONE';
    const content = (meta.contentType || 'none').toUpperCase();
    const timelineStr = JSON.stringify(meta.timeline || []);
    return `${age}|${tp}|${content}|${timelineStr}`;
};

const mapApiRatingToCompliance = (rating: string | undefined | null): ComplianceRating => {
    const lower = (rating || '').toLowerCase();
    if (lower === 'k' || lower === '8' || lower === '12' || lower === '16' || lower === '18') {
        return lower as ComplianceRating;
    }
    return 'none';
};

const applyWeekdayAnchorInStore = (epochMs: number, weekday: number) => {
  const anchored = new Date(epochMs);
  anchored.setDate(anchored.getDate() - anchored.getDay() + weekday);
  return anchored.getTime();
};

const parseClockAnchorInStore = (timeText: string, fallbackMs: number) => {
  const parts = timeText.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => Number.isNaN(part))) {
    return fallbackMs;
  }

  const anchor = new Date(fallbackMs);
  anchor.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
  return anchor.getTime();
};

const formatClockTimeInStore = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString('el-GR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

const weekdayLabelInStore = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString('en-GB', { weekday: 'short' }).toLowerCase();

const makePlaylistRecord = (index: number, name?: string): RundownPlaylist => ({
    id: uuidv4(),
    name: name?.trim() || defaultPlaylistName(index),
    created: Date.now(),
    items: [],
    selectedItemId: null,
    currentPlayingIndex: -1,
    playStartVisibleIndex: -1,
    startFromTime: '',
    startFromWeekday: new Date().getDay()
});

const makeGapMarkerRecord = (time: string): RundownItem => ({
    id: uuidv4(),
    type: 'gap',
    path: '',
    displayPath: '',
    shortPath: '',
    filename: `Start @ ${normalizeTimeString(time) || time.trim()}`,
    libraryIndicator: 'none',
    duration: 0,
    seek: 0,
    length: 0,
    inPoint: 0,
    outPoint: 0,
    plannedDuration: 0,
    note: '',
    complianceRating: 'none',
    complianceDescriptors: [],
    complianceText: '',
    hardStartTime: normalizeTimeString(time) || time.trim(),
    ingestorStatus: 'idle',
    tp_flag: false,
    content_type: 'none'
});

export const useRundownStore = defineStore('rundown', () => {
    const initialPlaylist = makePlaylistRecord(1, 'Rundown');
    const playlists = shallowRef<RundownPlaylist[]>([initialPlaylist]);
    const activePlaylistId = ref(initialPlaylist.id);
    const onAirPlaylistId = ref<string | null>(null);

    const activePlayingUuid = ref<string | null>(null);
    const playbackProgressPct = ref<number>(0);
    const playbackCountdownStr = ref<string>('');
    const updateTrigger = ref(0);

    const updatePlaylistState = (playlistId: string, updates: Partial<RundownPlaylist>) => {
        const playlistIndex = playlists.value.findIndex((p) => p.id === playlistId);
        if (playlistIndex !== -1) {
            const playlist = playlists.value[playlistIndex]!;
            const updatedPlaylist = {
                ...playlist,
                ...updates
            };
            const nextPlaylists = [...playlists.value];
            nextPlaylists[playlistIndex] = updatedPlaylist;
            playlists.value = nextPlaylists;
        }
        triggerRef(playlists);
    };

    const triggerNuclearReactivity = (playlistId: string, newItems: RundownItem[]) => {
        updatePlaylistState(playlistId, { items: [...newItems] });
    };

    let playbackInterval: number | null = null;
    let playbackStartTime = 0;
    let playbackDurationMs = 0;

    let lastProgressTimerItemId = '';
    let lastProgressTimerStartedAt = 0;

    const startPlaybackProgressTimer = (itemId: string, durationMs: number, startTime = Date.now()) => {
        const now = Date.now();
        if (lastProgressTimerItemId === itemId && now - lastProgressTimerStartedAt < 1000) {
            return;
        }
        lastProgressTimerItemId = itemId;
        lastProgressTimerStartedAt = now;

        stopPlaybackProgressTimer();
        activePlayingUuid.value = itemId;
        playbackProgressPct.value = 0;
        playbackCountdownStr.value = formatCountdown(durationMs);

        playbackStartTime = startTime;
        playbackDurationMs = durationMs;

        savePlaybackState(itemId, playbackStartTime, durationMs);

        let lastProgressUpdate = 0;
        const progressLoop = () => {
            if (!activePlayingUuid.value || playbackDurationMs <= 0) {
                stopPlaybackProgressTimer();
                return;
            }
            const now = Date.now();
            if (now - lastProgressUpdate >= 250) {
                lastProgressUpdate = now;
                const elapsed = now - playbackStartTime;
                const pct = Math.min(100, Math.max(0, (elapsed / playbackDurationMs) * 100));
                playbackProgressPct.value = pct;

                const remaining = Math.max(0, playbackDurationMs - elapsed);
                playbackCountdownStr.value = formatCountdown(remaining);

                if (elapsed >= playbackDurationMs) {
                    playbackProgressPct.value = 100;
                    playbackCountdownStr.value = '-00:00';
                }
            }
            playbackInterval = requestAnimationFrame(progressLoop);
        };
        playbackInterval = requestAnimationFrame(progressLoop);
    };

    const stopPlaybackProgressTimer = () => {
        if (playbackInterval) {
            cancelAnimationFrame(playbackInterval);
            playbackInterval = null;
        }
        activePlayingUuid.value = null;
        playbackProgressPct.value = 0;
        playbackCountdownStr.value = '';

        lastProgressTimerItemId = '';
        lastProgressTimerStartedAt = 0;

        clearPlaybackState();
    };

    const restorePlaybackState = () => {
        const state = loadPlaybackState();
        if (!state) return;

        const elapsed = Date.now() - state.startTimestamp;
        if (elapsed < state.durationMs) {
            startPlaybackProgressTimer(state.uuid, state.durationMs, state.startTimestamp);
        } else {
            clearPlaybackState();
        }
    };

    const formatCountdown = (ms: number): string => {
        const totalSec = Math.ceil(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `-${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };

    const getPlaylistById = (playlistId?: string | null) => {
        if (!playlistId) return null;
        return playlists.value.find((playlist) => playlist.id === playlistId) || null;
    };

    const currentPlaylist = computed(() => getPlaylistById(activePlaylistId.value) || playlists.value[0]);
    const onAirPlaylist = computed(() => getPlaylistById(onAirPlaylistId.value));

    const activeItems = computed<RundownItem[]>({
        get: () => currentPlaylist.value?.items || [],
        set: (items) => {
            if (!currentPlaylist.value) return;
            updatePlaylistState(currentPlaylist.value.id, { items: [...items] });
        }
    });

    const selectedItemId = computed<string | null>({
        get: () => currentPlaylist.value?.selectedItemId || null,
        set: (value) => {
            if (!currentPlaylist.value) return;
            updatePlaylistState(currentPlaylist.value.id, { selectedItemId: value });
        }
    });

    const currentPlayingIndex = computed<number>({
        get: () => currentPlaylist.value?.currentPlayingIndex ?? -1,
        set: (value) => {
            if (!currentPlaylist.value) return;
            updatePlaylistState(currentPlaylist.value.id, { currentPlayingIndex: value });
        }
    });

    const currentPlaylistName = computed(() => currentPlaylist.value?.name || 'Rundown');
    const currentPlaylistStartFrom = computed<string>({
        get: () => currentPlaylist.value?.startFromTime || '',
        set: (value) => {
            if (!currentPlaylist.value) return;
            updatePlaylistState(currentPlaylist.value.id, { startFromTime: normalizeTimeString(value) });
        }
    });
    const currentPlaylistStartWeekday = computed<number>({
        get: () => currentPlaylist.value?.startFromWeekday ?? new Date().getDay(),
        set: (value) => {
            if (!currentPlaylist.value) return;
            updatePlaylistState(currentPlaylist.value.id, { startFromWeekday: normalizeWeekday(value) });
        }
    });

    const isCurrentPlaylistOnAir = computed(() => !!currentPlaylist.value && currentPlaylist.value.id === onAirPlaylistId.value);
    const canScheduleCurrentPlaylist = computed(() => !isCurrentPlaylistOnAir.value);

    const selectedItem = computed(() =>
        currentPlaylist.value?.items.find((item) => item.id === selectedItemId.value) || null
    );

    const totalDuration = computed(() =>
        (currentPlaylist.value?.items || []).reduce((acc, item) => {
            if (item.type === 'gap') return acc;
            if (item.type === 'live') return acc + (item.plannedDuration || item.duration || 0);
            const totalMs = item.duration_ms || (item.duration ? item.duration * 1000 : 0);
            const inMs = item.trim_in_ms ?? item.inPoint ?? 0;
            const outMs = item.trim_out_ms ?? (item.outPoint > 0 ? item.outPoint : totalMs);
            const durationMs = (outMs > inMs && inMs >= 0) ? (outMs - inMs) : totalMs;
            return acc + durationMs / 1000;
        }, 0)
    );

    const parseFps = (rFrameRate?: string): number => {
        if (!rFrameRate) return 25;
        const parts = rFrameRate.split('/');
        if (parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined) {
            const num = parseFloat(parts[0]);
            const den = parseFloat(parts[1]);
            if (num > 0 && den > 0) return Math.round((num / den) * 100) / 100;
        }
        const val = parseFloat(rFrameRate);
        return val > 0 ? val : 25;
    };

    const makeItem = (item: RundownDraft): RundownItem => {
        const totalMs = (item as any).duration_ms || (item.duration ? item.duration * 1000 : 0);
        let inPoint = item.inPoint && item.inPoint > 0 ? item.inPoint : 0;
        let outPoint = item.outPoint && item.outPoint > inPoint ? item.outPoint : totalMs;

        if (item.mezzanine_ok) {
            const geo = {
                fps: item.fps || 25,
                totalFrames: item.total_frames || 0,
                gopFrames: item.gop_frames || 25,
                keyframeSafeStartMs: item.keyframe_safe_start_ms || 0,
                mezzanineOk: true
            };
            inPoint = clampTrimIn(inPoint, geo);
            outPoint = clampTrimOut(outPoint, geo);
        }

        const plannedDuration = item.plannedDuration && item.plannedDuration > 0
            ? item.plannedDuration
            : (outPoint > inPoint ? (outPoint - inPoint) / 1000 : (item.duration || 0));

        let trim_in_ms = (item as any).trim_in_ms !== undefined ? (item as any).trim_in_ms : inPoint;
        let trim_out_ms = (item as any).trim_out_ms !== undefined && (item as any).trim_out_ms > 0
            ? (item as any).trim_out_ms 
            : (outPoint > 0 ? outPoint : totalMs);

        if (item.mezzanine_ok) {
            const geo = {
                fps: item.fps || 25,
                totalFrames: item.total_frames || 0,
                gopFrames: item.gop_frames || 25,
                keyframeSafeStartMs: item.keyframe_safe_start_ms || 0,
                mezzanineOk: true
            };
            trim_in_ms = clampTrimIn(trim_in_ms, geo);
            trim_out_ms = clampTrimOut(trim_out_ms, geo);
        }

        return {
            ...item,
            id: uuidv4(),
            inPoint,
            outPoint,
            plannedDuration,
            note: item.note || '',
            complianceRating: item.complianceRating || 'none',
            complianceDescriptors: item.complianceDescriptors || [],
            complianceText: item.complianceText || '',
            hardStartTime: item.hardStartTime || '',
            displayPath: (item as any).displayPath || item.path || '',
            ingestorStatus: 'idle',
            display_name: (item as any).display_name || item.filename || '',
            virtual_folder: (item as any).virtual_folder || '',
            current_path: (item as any).current_path || item.path || '',
            duration_ms: totalMs,
            trim_in_ms,
            trim_out_ms,
            tp_flag: (item as any).tp_flag || false,
            content_type: (item as any).content_type || 'none',
            mezzanine_ok: item.mezzanine_ok,
            fps: item.fps,
            total_frames: item.total_frames,
            gop_frames: item.gop_frames,
            keyframe_safe_start_ms: item.keyframe_safe_start_ms,
            warnings: item.warnings,
        };
    };

    const hydrateItem = (item: Partial<RundownItem>): RundownItem => {
        if (item.type === 'gap') {
            const marker = makeGapMarkerRecord(item.hardStartTime || item.filename || '00:00');
            return {
                ...marker,
                id: uuidv4(),
                filename: item.filename || marker.filename,
                hardStartTime: marker.hardStartTime,
                display_name: item.filename || marker.filename,
                current_path: '',
                virtual_folder: '',
                duration_ms: 0,
                trim_in_ms: 0,
                trim_out_ms: 0,
            };
        }

        const duration = item.duration || 0;
        const totalMs = item.duration_ms || (duration * 1000);
        let inPoint = item.inPoint || 0;
        let outPoint = item.outPoint || totalMs;

        if (item.mezzanine_ok) {
            const geo = {
                fps: item.fps || 25,
                totalFrames: item.total_frames || 0,
                gopFrames: item.gop_frames || 25,
                keyframeSafeStartMs: item.keyframe_safe_start_ms || 0,
                mezzanineOk: true
            };
            inPoint = clampTrimIn(inPoint, geo);
            outPoint = clampTrimOut(outPoint, geo);
        }

        let trim_in_ms = item.trim_in_ms || inPoint;
        let trim_out_ms = item.trim_out_ms !== undefined && item.trim_out_ms > 0
            ? item.trim_out_ms
            : (outPoint > 0 ? outPoint : totalMs);

        if (item.mezzanine_ok) {
            const geo = {
                fps: item.fps || 25,
                totalFrames: item.total_frames || 0,
                gopFrames: item.gop_frames || 25,
                keyframeSafeStartMs: item.keyframe_safe_start_ms || 0,
                mezzanineOk: true
            };
            trim_in_ms = clampTrimIn(trim_in_ms, geo);
            trim_out_ms = clampTrimOut(trim_out_ms, geo);
        }

        return {
            id: uuidv4(),
            type: (item.type as RundownItemType) || 'video',
            playoutvueId: item.playoutvueId || undefined,
            path: item.path || '',
            displayPath: (item as any).displayPath || item.path || '',
            shortPath: item.shortPath || '',
            filename: item.filename || 'Untitled',
            libraryIndicator: item.libraryIndicator || 'none',
            duration,
            seek: item.seek || 0,
            length: item.length || 0,
            inPoint,
            outPoint,
            plannedDuration: item.plannedDuration || duration,
            note: item.note || '',
            complianceRating: item.complianceRating || 'none',
            complianceDescriptors: Array.isArray(item.complianceDescriptors) ? item.complianceDescriptors : [],
            complianceText: item.complianceText || '',
            hardStartTime: '',
            ingestorStatus: (item as any).ingestorStatus || 'idle',
            display_name: item.display_name || item.filename || 'Untitled',
            virtual_folder: item.virtual_folder || '',
            current_path: item.current_path || item.path || '',
            duration_ms: totalMs,
            trim_in_ms,
            trim_out_ms,
            tp_flag: item.tp_flag || false,
            content_type: item.content_type || 'none',
            timeline: item.timeline || [],
            mezzanine_ok: item.mezzanine_ok,
            fps: item.fps,
            fps_num: item.fps_num,
            fps_den: item.fps_den,
            total_frames: item.total_frames,
            gop_frames: item.gop_frames,
            keyframe_safe_start_ms: item.keyframe_safe_start_ms,
            warnings: item.warnings,
        };
    };

    const isGapItem = (item: RundownItem | null | undefined) => item?.type === 'gap';

    const getPlayableItems = (playlistId = activePlaylistId.value) =>
        (getPlaylistById(playlistId)?.items || []).filter((item) => !isGapItem(item));

    const normalizeVisibleStartIndex = (playlistId: string, visibleIndex: number) => {
        const playlist = getPlaylistById(playlistId);
        if (!playlist || !playlist.items.length) return -1;

        const startIndex = Math.max(0, Math.min(visibleIndex, playlist.items.length - 1));
        for (let index = startIndex; index < playlist.items.length; index += 1) {
            if (!isGapItem(playlist.items[index])) return index;
        }
        for (let index = startIndex - 1; index >= 0; index -= 1) {
            if (!isGapItem(playlist.items[index])) return index;
        }
        return -1;
    };

    const resolvePlayableStartIndex = (playlistId: string, visibleIndex: number) => {
        const playlist = getPlaylistById(playlistId);
        if (!playlist) return -1;

        const normalizedVisibleIndex = normalizeVisibleStartIndex(playlistId, visibleIndex);
        if (normalizedVisibleIndex < 0) return -1;

        let playableIndex = 0;
        for (let index = 0; index < playlist.items.length; index += 1) {
            if (isGapItem(playlist.items[index])) continue;
            if (index === normalizedVisibleIndex) return playableIndex;
            playableIndex += 1;
        }

        return -1;
    };

    const mapPlayableIndexToVisible = (playlistId: string, playableIndex: number) => {
        const playlist = getPlaylistById(playlistId);
        if (!playlist) return -1;

        let currentPlayableIndex = 0;
        for (let index = 0; index < playlist.items.length; index += 1) {
            if (isGapItem(playlist.items[index])) continue;
            if (currentPlayableIndex === playableIndex) return index;
            currentPlayableIndex += 1;
        }

        return -1;
    };

    const buildPlaybackPayload = (visibleIndex?: number) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return null;

        const items = getPlayableItems(playlist.id);
        if (!items.length) return null;

        const selectedIndex = visibleIndex
            ?? (playlist.selectedItemId ? playlist.items.findIndex((item) => item.id === playlist.selectedItemId) : 0);
        const normalizedVisibleIndex = normalizeVisibleStartIndex(playlist.id, selectedIndex >= 0 ? selectedIndex : 0);
        const startIndex = resolvePlayableStartIndex(playlist.id, normalizedVisibleIndex >= 0 ? normalizedVisibleIndex : 0);
        if (normalizedVisibleIndex < 0 || startIndex < 0) return null;

        return {
            playlistId: playlist.id,
            items,
            startIndex,
            startVisibleIndex: normalizedVisibleIndex
        };
    };

    const addItem = (item: RundownDraft, playlistId = activePlaylistId.value) => {
        const playlist = getPlaylistById(playlistId);
        if (!playlist) return;
        const newItem = makeItem(item);
        const newItems = [...playlist.items, newItem];
        triggerNuclearReactivity(playlist.id, newItems);
        updateTrigger.value += 1;
        if (newItem.playoutvueId && newItem.type !== 'gap') {
            resolveAssetFromApi(newItem.id);
        }
    };

    const insertItemAt = (index: number, item: RundownDraft, playlistId = activePlaylistId.value) => {
        const playlist = getPlaylistById(playlistId);
        if (!playlist) return;
        const nextIndex = Math.max(0, Math.min(index, playlist.items.length));
        const newItem = makeItem(item);
        const newItems = [...playlist.items];
        newItems.splice(nextIndex, 0, newItem);

        let newCurrentPlayingIndex = playlist.currentPlayingIndex;
        if (playlist.id === onAirPlaylistId.value && nextIndex <= newCurrentPlayingIndex && newCurrentPlayingIndex >= 0) {
            newCurrentPlayingIndex += 1;
        }

        updatePlaylistState(playlist.id, {
            items: newItems,
            currentPlayingIndex: newCurrentPlayingIndex
        });
        updateTrigger.value += 1;
        if (newItem.playoutvueId && newItem.type !== 'gap') {
            resolveAssetFromApi(newItem.id);
        }
    };

    const addGapMarker = (time: string, index?: number) => {
        const playlist = currentPlaylist.value;
        const normalizedTime = normalizeTimeString(time);
        if (!playlist || !normalizedTime || !canScheduleCurrentPlaylist.value) return false;

        const selectedIndex = index ?? (playlist.selectedItemId
            ? playlist.items.findIndex((item) => item.id === playlist.selectedItemId) + 1
            : playlist.items.length);
        const nextIndex = Math.max(0, Math.min(selectedIndex, playlist.items.length));
        const newItems = [...playlist.items];
        newItems.splice(nextIndex, 0, makeGapMarkerRecord(normalizedTime));

        let newCurrentPlayingIndex = playlist.currentPlayingIndex;
        if (playlist.id === onAirPlaylistId.value && nextIndex <= newCurrentPlayingIndex && newCurrentPlayingIndex >= 0) {
            newCurrentPlayingIndex += 1;
        }

        updatePlaylistState(playlist.id, {
            items: newItems,
            currentPlayingIndex: newCurrentPlayingIndex
        });
        updateTrigger.value += 1;
        return true;
    };

    const addLiveItem = (name: string, durationSec: number, playlistId = activePlaylistId.value) => {
        const playlist = getPlaylistById(playlistId);
        if (!playlist) return;
        const newItem: RundownItem = {
            id: uuidv4(),
            type: 'live',
            path: '',
            displayPath: '',
            shortPath: '',
            filename: name,
            libraryIndicator: 'none',
            duration: durationSec,
            seek: 0,
            length: 0,
            inPoint: 0,
            outPoint: 0,
            plannedDuration: durationSec,
            note: '',
            complianceRating: 'none',
            complianceDescriptors: [],
            complianceText: '',
            hardStartTime: '',
            ingestorStatus: 'idle',
            display_name: name,
            current_path: '',
            virtual_folder: '',
            duration_ms: durationSec * 1000,
            trim_in_ms: 0,
            trim_out_ms: 0
        };
        const newItems = [...playlist.items, newItem];
        triggerNuclearReactivity(playlist.id, newItems);
        updateTrigger.value += 1;
    };

    const removeItem = (id: string) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        const index = playlist.items.findIndex((item) => item.id === id);
        if (index === -1) return;
        if (playlist.id === onAirPlaylistId.value && index === playlist.currentPlayingIndex) {
            return;
        }
        const newItems = [...playlist.items];
        newItems.splice(index, 1);
        
        let newSelectedItemId = playlist.selectedItemId;
        if (newSelectedItemId === id) {
            newSelectedItemId = null;
        }
        let newCurrentPlayingIndex = playlist.currentPlayingIndex;
        if (newCurrentPlayingIndex >= newItems.length) {
            newCurrentPlayingIndex = -1;
        } else if (playlist.id === onAirPlaylistId.value && index < playlist.currentPlayingIndex && newCurrentPlayingIndex >= 0) {
            newCurrentPlayingIndex -= 1;
        }
        
        updatePlaylistState(playlist.id, {
            items: newItems,
            selectedItemId: newSelectedItemId,
            currentPlayingIndex: newCurrentPlayingIndex
        });
        updateTrigger.value += 1;
    };

    const reorderItems = (oldIndex: number, newIndex: number) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        const movedItem = playlist.items[oldIndex];
        if (!movedItem) return;
        const newItems = [...playlist.items];
        newItems.splice(oldIndex, 1);
        newItems.splice(newIndex, 0, movedItem);

        let newCurrentPlayingIndex = playlist.currentPlayingIndex;
        if (newCurrentPlayingIndex >= 0) {
            if (oldIndex === newCurrentPlayingIndex) {
                newCurrentPlayingIndex = newIndex;
            } else if (oldIndex < newCurrentPlayingIndex && newIndex >= newCurrentPlayingIndex) {
                newCurrentPlayingIndex -= 1;
            } else if (oldIndex > newCurrentPlayingIndex && newIndex <= newCurrentPlayingIndex) {
                newCurrentPlayingIndex += 1;
            }
        }

        updatePlaylistState(playlist.id, {
            items: newItems,
            currentPlayingIndex: newCurrentPlayingIndex
        });
        updateTrigger.value += 1;
    };

    const updateItem = (id: string, updates: Partial<RundownItem>) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        const index = playlist.items.findIndex((item) => item.id === id);
        if (index === -1) return;
        const newItems = [...playlist.items];
        const existing = newItems[index]!;

        let trim_in_ms = updates.trim_in_ms !== undefined ? updates.trim_in_ms : (updates.inPoint !== undefined ? updates.inPoint : existing.trim_in_ms);
        let trim_out_ms = (() => {
            const val = updates.trim_out_ms !== undefined 
                ? updates.trim_out_ms 
                : (updates.outPoint !== undefined ? updates.outPoint : existing.trim_out_ms);
            if (val !== undefined && val < 0) {
                console.error("[Invariant Violation] trim_out_ms cannot be negative:", val, updates);
            }
            return val;
        })();

        const mezzanine_ok = updates.mezzanine_ok !== undefined ? updates.mezzanine_ok : existing.mezzanine_ok;
        if (mezzanine_ok) {
            const geo = {
                fps: updates.fps || existing.fps || 25,
                totalFrames: updates.total_frames || existing.total_frames || 0,
                gopFrames: updates.gop_frames || existing.gop_frames || 25,
                keyframeSafeStartMs: updates.keyframe_safe_start_ms || existing.keyframe_safe_start_ms || 0,
                mezzanineOk: true
            };
            if (trim_in_ms !== undefined) {
                trim_in_ms = clampTrimIn(trim_in_ms, geo);
            }
            if (trim_out_ms !== undefined && trim_out_ms > 0) {
                trim_out_ms = clampTrimOut(trim_out_ms, geo);
            }
        }

        const inPoint = trim_in_ms || 0;
        const outPoint = trim_out_ms || 0;

        const newPlannedDuration = (updates.plannedDuration !== undefined)
            ? updates.plannedDuration
            : (outPoint > inPoint
                ? (outPoint - inPoint) / 1000
                : existing.plannedDuration);

        newItems[index] = { 
            ...existing, 
            ...updates,
            display_name: updates.display_name !== undefined ? updates.display_name : (updates.filename !== undefined ? updates.filename : existing.display_name),
            current_path: updates.current_path !== undefined ? updates.current_path : (updates.path !== undefined ? updates.path : existing.current_path),
            duration_ms: updates.duration_ms !== undefined ? updates.duration_ms : (updates.duration !== undefined ? updates.duration * 1000 : existing.duration_ms),
            plannedDuration: newPlannedDuration,
            trim_in_ms,
            trim_out_ms,
            inPoint,
            outPoint,
        } as RundownItem;
        triggerNuclearReactivity(playlist.id, newItems);
    };

    const clearRundown = () => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        const updates: Partial<RundownPlaylist> = {
            items: [],
            selectedItemId: null
        };
        if (playlist.id === onAirPlaylistId.value) {
            updates.currentPlayingIndex = -1;
            updates.playStartVisibleIndex = -1;
        }
        updatePlaylistState(playlist.id, updates);
        updateTrigger.value += 1;
    };

    const serializeRundown = (name?: string): OptimizedPlaylistFile => {
        const playlistName = name || currentPlaylist.value?.name || 'Rundown';
        const startFromTime = currentPlaylist.value?.startFromTime || '';
        const startFromWeekday = currentPlaylist.value?.startFromWeekday ?? new Date().getDay();
        const items = (currentPlaylist.value?.items || []).map((item): OptimizedPlaylistItem => ({
            t: toCompactType(item.type),
            pid: item.playoutvueId || undefined,
            p: item.path || undefined,
            dp: item.displayPath || undefined,
            s: item.shortPath || undefined,
            f: item.filename || undefined,
            i: item.libraryIndicator !== 'none' ? item.libraryIndicator : undefined,
            d: item.duration > 0 ? item.duration : undefined,
            k: item.seek > 0 ? item.seek : undefined,
            l: item.length > 0 ? item.length : undefined,
            in: item.inPoint > 0 ? item.inPoint : undefined,
            out: item.outPoint > 0 ? item.outPoint : undefined,
            pd: item.plannedDuration > 0 ? item.plannedDuration : undefined,
            n: item.note || undefined,
            cr: item.complianceRating !== 'none' ? item.complianceRating : undefined,
            cd: item.complianceDescriptors.length ? item.complianceDescriptors : undefined,
            ct: item.complianceText || undefined,
            hs: item.hardStartTime || undefined,
            igs: item.ingestorStatus !== 'idle' ? item.ingestorStatus : undefined,
            tp: item.tp_flag || undefined,
            cot: item.content_type !== 'none' ? item.content_type : undefined,
            tl: item.timeline || undefined
        }));

        return {
            format: 'playout-list',
            version: 2,
            playlist: {
                name: playlistName,
                created: Date.now(),
                startFromTime: startFromTime || undefined,
                startFromWeekday
            },
            items
        };
    };

    const deserializeRundown = (playlistData: AnyPlaylistFile, append = false) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;

        const isOptimized = (playlistData as OptimizedPlaylistFile)?.format === 'playout-list'
            && (playlistData as OptimizedPlaylistFile)?.version === 2;

        const sourceItems: Partial<RundownItem>[] = isOptimized
            ? ((playlistData as OptimizedPlaylistFile).items || []).map((item) => ({
                type: fromCompactType(item.t),
                playoutvueId: item.pid || undefined,
                path: item.p || '',
                displayPath: item.dp || item.p || '',
                shortPath: item.s || '',
                filename: item.f || 'Untitled',
                libraryIndicator: item.i || 'none',
                duration: item.d || 0,
                seek: item.k || 0,
                length: item.l || 0,
                inPoint: item.in || 0,
                outPoint: item.out || 0,
                plannedDuration: item.pd || item.d || 0,
                note: item.n || '',
                complianceRating: item.cr || 'none',
                complianceDescriptors: item.cd || [],
                complianceText: item.ct || '',
                hardStartTime: item.hs || '',
                ingestorStatus: (item.igs || 'idle') as 'idle' | 'processing' | 'ready' | 'error' | 'missing',
                tp_flag: item.tp || false,
                content_type: item.cot || 'none',
                timeline: item.tl || []
            }))
            : ((playlistData as PlaylistFile).items || []);

        const hydrated = sourceItems.map((item) => hydrateItem(item));

        const payloadName = isOptimized
            ? (playlistData as OptimizedPlaylistFile).playlist?.name
            : (playlistData as PlaylistFile).name;
        const payloadStartFromTime = isOptimized
            ? (playlistData as OptimizedPlaylistFile).playlist?.startFromTime
            : (playlistData as PlaylistFile).startFromTime;
        const payloadStartFromWeekday = isOptimized
            ? (playlistData as OptimizedPlaylistFile).playlist?.startFromWeekday
            : (playlistData as PlaylistFile).startFromWeekday;

        if (append) {
            updatePlaylistState(playlist.id, {
                items: [...playlist.items, ...hydrated]
            });
        } else {
            const updates: Partial<RundownPlaylist> = {
                items: hydrated,
                selectedItemId: null,
                currentPlayingIndex: -1,
                playStartVisibleIndex: -1,
                startFromTime: normalizeTimeString(payloadStartFromTime || ''),
                startFromWeekday: normalizeWeekday(payloadStartFromWeekday ?? playlist.startFromWeekday ?? new Date().getDay())
            };
            if (payloadName) {
                updates.name = payloadName;
            }
            updatePlaylistState(playlist.id, updates);
        }
        updateTrigger.value += 1;

        const BATCH_SIZE = 100;
        const unresolvedItems = hydrated
            .filter(item => item.playoutvueId && item.type !== 'gap' && item.ingestorStatus === 'idle')
            .map(item => ({ id: item.id, uuid: item.playoutvueId! }));

        if (unresolvedItems.length > 0) {
            const uuidToItemId = new Map(unresolvedItems.map(i => [i.uuid, i.id]));
            const uuids = Array.from(uuidToItemId.keys());

            (async () => {
                for (let i = 0; i < uuids.length; i += BATCH_SIZE) {
                     const batch = uuids.slice(i, i + BATCH_SIZE);
                     try {
                         const map = await invoke<Record<string, any>>('resolve_ingestor_assets_batch', {
                             uuids: batch, apiBaseUrlOverride: null
                         });
                         for (const [uuid, asset] of Object.entries(map)) {
                             const itemId = uuidToItemId.get(uuid);
                             if (!itemId) continue;
                             const idx = playlist.items.findIndex(e => e.id === itemId);
                             if (idx === -1) continue;
                             const existing = playlist.items[idx]!;

                             const nameLower = (asset.display_name || existing.filename || '').toLowerCase();
                             const ratingLower = (asset.rating || '').toLowerCase();
                             const isSubclip = nameLower.includes('sub-clip') || nameLower.includes('subclip') || ratingLower.includes('subclip');

                             let inPoint = asset.trim_in_ms || 0;
                             let outPoint = 0;
                             let durationSec = (asset.duration_ms || 0) / 1000;
                             
                              if (isSubclip) {
                                  const calculatedDuration = (asset.trim_out_ms || 0) - (asset.trim_in_ms || 0);
                                  durationSec = calculatedDuration / 1000;
                                  outPoint = asset.trim_out_ms || 0;
                              } else {
                                  outPoint = (asset.trim_out_ms && asset.trim_out_ms > 0)
                                      ? asset.trim_out_ms
                                      : (asset.duration_ms || 0);
                                  durationSec = (outPoint - inPoint) / 1000;
                              }
                              const fileDurationMs = asset.duration_ms || 0;
                              const effectiveDurationMs = outPoint > inPoint ? (outPoint - inPoint) : fileDurationMs;

                              const meta = getMetadataFromAssetResponse(asset);
                              playlist.items[idx] = {
                                  ...existing,
                                  filename: asset.display_name || existing.filename,
                                  path: asset.current_path || existing.path,
                                  displayPath: asset.current_path || existing.displayPath,
                                  duration: effectiveDurationMs / 1000,
                                  inPoint,
                                  outPoint: outPoint > 0 ? outPoint : 0,
                                  plannedDuration: effectiveDurationMs / 1000,
                                  complianceRating: meta.ageRating,
                                  tp_flag: meta.tpFlag,
                                  content_type: meta.contentType,
                                  ingestorStatus: (asset.status || 'ready') as IngestorStatus,
                                  display_name: asset.display_name,
                                  virtual_folder: asset.virtual_folder,
                                  current_path: asset.current_path,
                                  duration_ms: fileDurationMs,
                                  trim_in_ms: inPoint,
                                  trim_out_ms: outPoint > 0 ? outPoint : 0,
                                 fps: asset.fps || parseFps(asset.r_frame_rate),
                                 mezzanine_ok: asset.mezzanine_ok,
                                 total_frames: asset.total_frames,
                                 gop_frames: asset.gop_frames,
                                 keyframe_safe_start_ms: asset.keyframe_safe_start_ms,
                                 warnings: asset.warnings,
                             };
                         }
                         updatePlaylistState(playlist.id, {
                             items: [...playlist.items]
                         });
                         casparPlayoutService.refreshQueue?.(getPlayableItems(playlist.id) as any);
                     } catch (e) {
                         try {
                             const ingestor = useIngestorStatusStore();
                             ingestor.logError('ingestor-batch', `Batch resolution failed for chunk ${i}-${i + batch.length}: ${e}`);
                         } catch {}
                         console.warn(`[Ingestor] Batch resolution failed for chunk ${i}-${i + batch.length}`, e);
                     }
                }
            })();
        }
    };

    const relinkItemsByStableId = (entries: MediaRelinkEntry[]) => {
        if (!entries.length) return 0;

        const byId = new Map<string, MediaRelinkEntry>();
        for (const entry of entries) {
            const key = (entry.playoutvueId || '').trim();
            if (!key || !entry.path) continue;
            byId.set(key, entry);
        }

        let relinkedCount = 0;

        for (const playlist of playlists.value) {
            const newItems = [...playlist.items];
            let playlistChanged = false;

            for (let idx = 0; idx < newItems.length; idx++) {
                const item = newItems[idx];
                if (!item || item.type === 'gap') continue;

                const key = (item.playoutvueId || '').trim();
                if (!key) continue;

                const match = byId.get(key);
                if (!match) continue;

                let changed = false;
                const newItem = { ...item };

                if (match.path && newItem.path !== match.path) {
                    newItem.path = match.path;
                    changed = true;
                }

                const nextShortPath = match.shortPath || match.path;
                if (nextShortPath && newItem.shortPath !== nextShortPath) {
                    newItem.shortPath = nextShortPath;
                    changed = true;
                }

                const nextFilename = match.filename || filenameFromPath(match.path);
                if (nextFilename && newItem.type !== 'live' && newItem.filename !== nextFilename) {
                    newItem.filename = nextFilename;
                    changed = true;
                }

                 const trimInMs = Math.max(0, Number(match.trim_in_ms || 0));
                const trimOutMs = Math.max(0, Number(match.trim_out_ms || 0));

                const nameLower = (match.filename || newItem.filename || '').toLowerCase();
                const isSubclip = nameLower.includes('sub-clip') || nameLower.includes('subclip');

                if (isSubclip) {
                    const calculatedDuration = trimOutMs - trimInMs;
                    newItem.duration = calculatedDuration / 1000;
                    newItem.plannedDuration = calculatedDuration / 1000;
                    newItem.inPoint = trimInMs;
                    newItem.outPoint = trimOutMs;
                    newItem.duration_ms = calculatedDuration;
                    changed = true;
                } else {
                    const duration = Number(match.duration || 0);
                    if (duration > 0 && newItem.duration <= 0) {
                        newItem.duration = duration;
                        if (newItem.plannedDuration <= 0 && newItem.outPoint <= newItem.inPoint) {
                            newItem.plannedDuration = duration;
                        }
                        changed = true;
                    }

                    if (trimInMs > 0 && newItem.inPoint === 0) {
                        newItem.inPoint = trimInMs;
                        changed = true;
                    }

                    if (trimOutMs > 0 && trimOutMs > newItem.inPoint && newItem.outPoint === 0) {
                        newItem.outPoint = trimOutMs;
                        newItem.plannedDuration = (newItem.outPoint - newItem.inPoint) / 1000;
                        changed = true;
                    }
                }

                if (changed) {
                    newItems[idx] = newItem;
                    playlistChanged = true;
                    relinkedCount += 1;
                }
            }

            if (playlistChanged) {
                updatePlaylistState(playlist.id, { items: newItems });
            }
        }

        return relinkedCount;
    };

    const duplicateItem = (id: string) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        const index = playlist.items.findIndex((item) => item.id === id);
        if (index === -1) return;
        const duplicate = hydrateItem({ ...playlist.items[index], id: undefined });
        const newItems = [...playlist.items];
        newItems.splice(index + 1, 0, duplicate);
        updatePlaylistState(playlist.id, { items: newItems });
    };

    const createPlaylist = (name?: string) => {
        const playlist = makePlaylistRecord(playlists.value.length + 1, name);
        playlists.value = [...playlists.value, playlist];
        triggerRef(playlists);
        activePlaylistId.value = playlist.id;
        return playlist.id;
    };

    const activatePlaylist = (playlistId: string) => {
        if (!getPlaylistById(playlistId)) return;
        activePlaylistId.value = playlistId;
    };

    const renamePlaylist = (playlistId: string, name: string) => {
        const playlist = getPlaylistById(playlistId);
        if (!playlist) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        if (playlist.name !== trimmed) {
            updatePlaylistState(playlistId, { name: trimmed });
        }
    };

    const closePlaylist = (playlistId: string) => {
        if (playlists.value.length <= 1 || playlistId === onAirPlaylistId.value) return false;
        const index = playlists.value.findIndex((playlist) => playlist.id === playlistId);
        if (index === -1) return false;
        const nextPlaylists = [...playlists.value];
        nextPlaylists.splice(index, 1);
        playlists.value = nextPlaylists;
        triggerRef(playlists);
        if (activePlaylistId.value === playlistId) {
            const nextPlaylist = playlists.value[Math.max(0, index - 1)] || playlists.value[0];
            if (nextPlaylist) {
                activePlaylistId.value = nextPlaylist.id;
            }
        }
        return true;
    };

    const setPlaylistOnAir = (playlistId: string, startVisibleIndex: number) => {
        if (onAirPlaylistId.value && onAirPlaylistId.value !== playlistId) {
            const previousPlaylist = getPlaylistById(onAirPlaylistId.value);
            if (previousPlaylist) {
                updatePlaylistState(previousPlaylist.id, {
                    currentPlayingIndex: -1,
                    playStartVisibleIndex: -1
                });
            }
        }

        const playlist = getPlaylistById(playlistId);
        if (!playlist) return;
        onAirPlaylistId.value = playlistId;
        updatePlaylistState(playlist.id, {
            currentPlayingIndex: startVisibleIndex,
            playStartVisibleIndex: startVisibleIndex
        });
        const startItem = playlist.items[startVisibleIndex];
        currentPlayingItemId.value = startItem
            ? (startItem.playoutvueId || startItem.id)
            : null;
        currentPlayingInstanceId.value = startItem
            ? startItem.id
            : null;
    };

    const setOnAirPlayingIndex = (playableIndex: number) => {
        const playlist = onAirPlaylist.value;
        if (!playlist) return;
        updatePlaylistState(playlist.id, {
            currentPlayingIndex: mapPlayableIndexToVisible(playlist.id, playableIndex)
        });
    };

    const currentPlayingItemId = ref<string | null>(null);
    const currentPlayingInstanceId = ref<string | null>(null);

    const setOnAirPlayingItemById = (uuid: string | null) => {
        const playlist = onAirPlaylist.value;
        if (!playlist || uuid == null) {
            currentPlayingItemId.value = null;
            currentPlayingInstanceId.value = null;
            if (playlist) {
                updatePlaylistState(playlist.id, { currentPlayingIndex: -1 });
            }
            return;
        }
        currentPlayingItemId.value = uuid;

        // 1. Try matching the exact playlist item instance ID first
        let visibleIndex = playlist.items.findIndex((item) => item.id === uuid);

        // 2. If not found (meaning uuid is the ingestor asset UUID), search closest instance
        if (visibleIndex === -1) {
            const matches = playlist.items
                .map((item, idx) => ({ item, idx }))
                .filter(({ item }) => item.playoutvueId && item.playoutvueId === uuid);

            if (matches.length > 0) {
                const currentIdx = playlist.currentPlayingIndex >= 0 ? playlist.currentPlayingIndex : 0;
                let bestMatch = matches[0];
                if (bestMatch) {
                    let minDistance = Math.abs(bestMatch.idx - currentIdx);

                    for (const match of matches) {
                        const distance = match.idx >= currentIdx 
                            ? match.idx - currentIdx 
                            : (playlist.items.length - currentIdx) + match.idx;
                        
                        if (distance < minDistance) {
                            minDistance = distance;
                            bestMatch = match;
                        }
                    }
                    visibleIndex = bestMatch.idx;
                }
            }
        }

        if (visibleIndex !== -1) {
            const foundItem = playlist.items[visibleIndex];
            if (foundItem) {
                currentPlayingInstanceId.value = foundItem.id;
            } else {
                currentPlayingInstanceId.value = null;
            }
        } else {
            currentPlayingInstanceId.value = null;
        }
        updatePlaylistState(playlist.id, { currentPlayingIndex: visibleIndex });
    };

    const clearOnAirState = () => {
        const playlist = onAirPlaylist.value;
        if (playlist) {
            updatePlaylistState(playlist.id, {
                currentPlayingIndex: -1,
                playStartVisibleIndex: -1
            });
        }
        onAirPlaylistId.value = null;
        currentPlayingItemId.value = null;
        currentPlayingInstanceId.value = null;
    };

    const resolveAssetFromApi = async (itemId: string) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;

        const index = playlist.items.findIndex((e) => e.id === itemId);
        if (index === -1) return;

        const item = playlist.items[index];
        if (!item || !item.playoutvueId || item.type === 'gap') return;

        playlist.items[index] = {
            ...item,
            id: item.id,
            type: item.type,
            ingestorStatus: 'processing' as IngestorStatus
        };
        triggerRef(playlists);

        try {
            const response = await invoke<any>('resolve_ingestor_asset', {
                uuid: item.playoutvueId,
                apiBaseUrlOverride: null
            });

            const nameLower = (response.display_name || item.filename || '').toLowerCase();
            const ratingLower = (response.rating || '').toLowerCase();
            const isSubclip = nameLower.includes('sub-clip') || nameLower.includes('subclip') || ratingLower.includes('subclip');

            let inPoint = response.trim_in_ms || 0;
            let outPoint = 0;
            let durationSec = (response.duration_ms || 0) / 1000;

            if (isSubclip) {
                const calculatedDuration = (response.trim_out_ms || 0) - (response.trim_in_ms || 0);
                durationSec = calculatedDuration / 1000;
                outPoint = response.trim_out_ms || 0;
            } else {
                outPoint = (response.trim_out_ms && response.trim_out_ms > 0)
                    ? response.trim_out_ms
                    : (response.duration_ms || 0);
                durationSec = (outPoint - inPoint) / 1000;
            }
            const fileDurationMs = response.duration_ms || 0;
            const effectiveDurationMs = outPoint > inPoint ? (outPoint - inPoint) : fileDurationMs;

            const meta = getMetadataFromAssetResponse(response);
            const updates: any = {
                filename: response.display_name || item.filename,
                path: response.current_path || item.path,
                displayPath: response.current_path || item.displayPath,
                duration: effectiveDurationMs / 1000,
                inPoint,
                outPoint: outPoint > 0 ? outPoint : 0,
                plannedDuration: effectiveDurationMs / 1000,
                complianceRating: meta.ageRating,
                tp_flag: meta.tpFlag,
                content_type: meta.contentType,
                ingestorStatus: response.status as IngestorStatus,
                display_name: response.display_name,
                virtual_folder: response.virtual_folder,
                current_path: response.current_path,
                duration_ms: fileDurationMs,
                trim_in_ms: inPoint,
                trim_out_ms: outPoint > 0 ? outPoint : 0,
                fps: response.fps || parseFps(response.r_frame_rate),
                mezzanine_ok: response.mezzanine_ok,
                total_frames: response.total_frames,
                gop_frames: response.gop_frames,
                keyframe_safe_start_ms: response.keyframe_safe_start_ms,
                warnings: response.warnings,
            };

            const newItems = [...playlist.items];
            const existing = newItems[index];
            if (existing) {
                newItems[index] = { ...existing, ...updates } as RundownItem;
                playlist.items = newItems;
            }
            triggerRef(playlists);
            casparPlayoutService.refreshQueue?.(getPlayableItems(playlist.id) as any);
        } catch (error) {
            try {
                const ingestor = useIngestorStatusStore();
                ingestor.logError('ingestor-resolve', `Failed to resolve asset ${item.playoutvueId}: ${error}`);
            } catch {}
            const existing = playlist.items[index];
            playlist.items[index] = {
                ...existing,
                ingestorStatus: 'error'
            } as RundownItem;
            triggerRef(playlists);
            console.error('[Ingestor] Failed to resolve asset', item.playoutvueId, error);
        }
    };

    const clockMs = ref(Date.now());
    let clockInterval: ReturnType<typeof setInterval> | null = null;
    if (typeof window !== 'undefined') {
        clockInterval = setInterval(() => {
            clockMs.value = Date.now();
        }, onAirPlaylistId.value ? 1000 : 5000);
    }

    watch(onAirPlaylistId, (newId) => {
        if (typeof window === 'undefined') return;
        if (clockInterval) {
            clearInterval(clockInterval);
        }
        clockInterval = setInterval(() => {
            clockMs.value = Date.now();
        }, newId ? 1000 : 5000);
    });

    const getItemDurationMs = (item: RundownItem): number => {
        if (item.type === 'gap') return 0;
        if (item.type === 'live') return (item.plannedDuration || item.duration || 0) * 1000;
        const totalMs = item.duration_ms || (item.duration ? item.duration * 1000 : 0);
        const inMs = item.trim_in_ms ?? item.inPoint ?? 0;
        const outMs = item.trim_out_ms ?? (item.outPoint > 0 ? item.outPoint : totalMs);
        if (outMs > inMs && inMs >= 0) return outMs - inMs;
        return totalMs;
    };

    const activeItemsETAs = computed(() => {
        const playlist = currentPlaylist.value;
        if (!playlist) return [];
        
        const playingCurrentPlaylist = isCurrentPlaylistOnAir.value && currentPlayingIndex.value >= 0;
        const now = clockMs.value;
        
        let accumulatedTime = playingCurrentPlaylist
            ? (playStartTime.value || now)
            : (playlist.startFromTime
                ? applyWeekdayAnchorInStore(parseClockAnchorInStore(playlist.startFromTime, now), playlist.startFromWeekday)
                : now);

        return playlist.items.map((item, index) => {
            if (item.type === 'gap') {
                const gapLabel = item.hardStartTime || item.filename.replace(/^Start @\s*/, '');
                if (!playingCurrentPlaylist && gapLabel) {
                    accumulatedTime = parseClockAnchorInStore(gapLabel, accumulatedTime);
                }
                return {
                    epochMs: accumulatedTime,
                    formatted: formatClockTimeInStore(accumulatedTime),
                    kind: 'gap',
                    label: gapLabel || 'Gap line',
                    dayLabel: weekdayLabelInStore(accumulatedTime)
                };
            }

            if (playingCurrentPlaylist && index < currentPlayingIndex.value) {
                const itemStart = accumulatedTime;
                accumulatedTime += getItemDurationMs(item);
                return {
                    epochMs: itemStart,
                    formatted: formatClockTimeInStore(itemStart),
                    kind: 'done',
                    label: 'PLAYED',
                    dayLabel: weekdayLabelInStore(itemStart)
                };
            }
            if (playingCurrentPlaylist && index === currentPlayingIndex.value) {
                const nextStart = accumulatedTime;
                accumulatedTime += getItemDurationMs(item);
                return {
                    epochMs: nextStart,
                    formatted: formatClockTimeInStore(now), // Shows current time for active item
                    kind: 'now',
                    label: 'ON AIR',
                    dayLabel: weekdayLabelInStore(now)
                };
            }

            const itemStart = accumulatedTime;
            accumulatedTime += getItemDurationMs(item);
            return {
                epochMs: itemStart,
                formatted: formatClockTimeInStore(itemStart),
                kind: 'time',
                label: '',
                dayLabel: weekdayLabelInStore(itemStart)
            };
        });
    });

    const updateItemMetadata = async (
        itemId: string,
        playoutvueId: string | undefined,
        updates: {
            complianceRating?: ComplianceRating;
            tp_flag?: boolean;
            content_type?: 'movie' | 'show' | 'documentary' | 'news' | 'none';
            timeline?: Array<{ start: number; end: number; text: string }>;
        }
    ) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;

        const idx = playlist.items.findIndex((item) => item.id === itemId);
        if (idx === -1) return;

        const item = playlist.items[idx]!;
        const age = updates.complianceRating !== undefined ? updates.complianceRating : (item.complianceRating || 'none');
        const tp = updates.tp_flag !== undefined ? updates.tp_flag : (item.tp_flag || false);
        const content = updates.content_type !== undefined ? updates.content_type : (item.content_type || 'none');
        const timeline = updates.timeline !== undefined ? updates.timeline : (item.timeline || []);

        // Serialize
        const serialized = serializeBroadcastRating({
            ageRating: age,
            tpFlag: tp,
            contentType: content,
            timeline: timeline
        });

        // If backend UUID exists, update database first
        const dbUuid = playoutvueId || item.playoutvueId;
        if (dbUuid && !dbUuid.startsWith('local:')) {
            try {
                await invoke('update_ingestor_rating', {
                    uuid: dbUuid,
                    rating: age,
                    apiBaseUrlOverride: null
                });
            } catch (error) {
                console.error('[Store] Failed to update backend rating:', error);
                return;
            }
        }

        // Update local item
        playlist.items[idx] = {
            ...item,
            complianceRating: age,
            tp_flag: tp,
            content_type: content,
            timeline: timeline
        };
        triggerRef(playlists);

        // Sync with MediaLibrary store
        if (dbUuid) {
            const mediaLibrary = useMediaLibraryStore();
            mediaLibrary.updateAsset(dbUuid, { rating: serialized });
            
            // Also sync other items in rundown with same playoutvueId
            playlist.items.forEach((e, i) => {
                if (e.playoutvueId === dbUuid && e.id !== itemId) {
                    playlist.items[i] = {
                        ...e,
                        complianceRating: age,
                        tp_flag: tp,
                        content_type: content,
                        timeline: timeline
                    };
                }
            });
            triggerRef(playlists);
        }
    };

    const triggerPlaylistsUpdate = () => {
        triggerRef(playlists);
    };

    return {
        triggerPlaylistsUpdate,
        playlists,
        activePlaylistId,
        onAirPlaylistId,
        currentPlaylist,
        onAirPlaylist,
        currentPlaylistName,
        currentPlaylistStartFrom,
        currentPlaylistStartWeekday,
        isCurrentPlaylistOnAir,
        canScheduleCurrentPlaylist,
        activeItems,
        selectedItemId,
        selectedItem,
        totalDuration,
        currentPlayingIndex,
        isGapItem,
        getPlayableItems,
        normalizeVisibleStartIndex,
        resolvePlayableStartIndex,
        buildPlaybackPayload,
        createPlaylist,
        activatePlaylist,
        renamePlaylist,
        closePlaylist,
        addItem,
        insertItemAt,
        addGapMarker,
        addLiveItem,
        removeItem,
        duplicateItem,
        reorderItems,
        clearRundown,
        updateItem,
        relinkItemsByStableId,
        serializeRundown,
        deserializeRundown,
        setPlaylistOnAir,
        setOnAirPlayingIndex,
        setOnAirPlayingItemById,
        currentPlayingItemId,
        currentPlayingInstanceId,
        clearOnAirState,
        resolveAssetFromApi,
        activePlayingUuid,
        playbackProgressPct,
        playbackCountdownStr,
        updateTrigger,
        startPlaybackProgressTimer,
        stopPlaybackProgressTimer,
        restorePlaybackState,
        clockMs,
        activeItemsETAs,
        updateItemMetadata
    };
}, {
    persist: true
});

