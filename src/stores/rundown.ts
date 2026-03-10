import { defineStore } from 'pinia';
import { v4 as uuidv4 } from 'uuid';
import { computed, ref } from 'vue';
import type { LibraryIndicator } from './mediaDefaults';

export type ComplianceRating = 'none' | 'k' | '8' | '12' | '16' | '18';
export type RundownItemType = 'video' | 'live' | 'graphic' | 'gap';

export interface RundownItem {
    id: string;
    type: RundownItemType;
    path: string;
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

type RundownDraft = Omit<RundownItem, 'id' | 'inPoint' | 'outPoint' | 'plannedDuration' | 'note' | 'complianceRating' | 'complianceDescriptors' | 'complianceText' | 'hardStartTime'>
    & Partial<Pick<RundownItem, 'complianceRating' | 'complianceDescriptors' | 'complianceText'>>;

const defaultPlaylistName = (index: number) => `Playlist ${index}`;

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
    hardStartTime: normalizeTimeString(time) || time.trim()
});

export const useRundownStore = defineStore('rundown', () => {
    const initialPlaylist = makePlaylistRecord(1, 'Rundown');
    const playlists = ref<RundownPlaylist[]>([initialPlaylist]);
    const activePlaylistId = ref(initialPlaylist.id);
    const onAirPlaylistId = ref<string | null>(null);

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
            currentPlaylist.value.items = items;
        }
    });

    const selectedItemId = computed<string | null>({
        get: () => currentPlaylist.value?.selectedItemId || null,
        set: (value) => {
            if (!currentPlaylist.value) return;
            currentPlaylist.value.selectedItemId = value;
        }
    });

    const currentPlayingIndex = computed<number>({
        get: () => currentPlaylist.value?.currentPlayingIndex ?? -1,
        set: (value) => {
            if (!currentPlaylist.value) return;
            currentPlaylist.value.currentPlayingIndex = value;
        }
    });

    const currentPlaylistName = computed(() => currentPlaylist.value?.name || 'Rundown');
    const currentPlaylistStartFrom = computed<string>({
        get: () => currentPlaylist.value?.startFromTime || '',
        set: (value) => {
            if (!currentPlaylist.value) return;
            currentPlaylist.value.startFromTime = normalizeTimeString(value);
        }
    });
    const currentPlaylistStartWeekday = computed<number>({
        get: () => currentPlaylist.value?.startFromWeekday ?? new Date().getDay(),
        set: (value) => {
            if (!currentPlaylist.value) return;
            currentPlaylist.value.startFromWeekday = normalizeWeekday(value);
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
            if (item.outPoint > 0 && item.inPoint >= 0) {
                return acc + (item.outPoint - item.inPoint) / 1000;
            }
            return acc + (item.plannedDuration || item.duration || 0);
        }, 0)
    );

    const makeItem = (item: RundownDraft): RundownItem => ({
        ...item,
        id: uuidv4(),
        inPoint: 0,
        outPoint: 0,
        plannedDuration: item.duration || 0,
        note: '',
        complianceRating: item.complianceRating || 'none',
        complianceDescriptors: item.complianceDescriptors || [],
        complianceText: item.complianceText || '',
        hardStartTime: ''
    });

    const hydrateItem = (item: Partial<RundownItem>): RundownItem => {
        if (item.type === 'gap') {
            const marker = makeGapMarkerRecord(item.hardStartTime || item.filename || '00:00');
            return {
                ...marker,
                id: uuidv4(),
                filename: item.filename || marker.filename,
                hardStartTime: marker.hardStartTime
            };
        }

        return {
            id: uuidv4(),
            type: (item.type as RundownItemType) || 'video',
            path: item.path || '',
            shortPath: item.shortPath || '',
            filename: item.filename || 'Untitled',
            libraryIndicator: item.libraryIndicator || 'none',
            duration: item.duration || 0,
            seek: item.seek || 0,
            length: item.length || 0,
            inPoint: item.inPoint || 0,
            outPoint: item.outPoint || 0,
            plannedDuration: item.plannedDuration || item.duration || 0,
            note: item.note || '',
            complianceRating: item.complianceRating || 'none',
            complianceDescriptors: Array.isArray(item.complianceDescriptors) ? item.complianceDescriptors : [],
            complianceText: item.complianceText || '',
            hardStartTime: ''
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
        playlist.items.push(makeItem(item));
    };

    const insertItemAt = (index: number, item: RundownDraft, playlistId = activePlaylistId.value) => {
        const playlist = getPlaylistById(playlistId);
        if (!playlist) return;
        const nextIndex = Math.max(0, Math.min(index, playlist.items.length));
        playlist.items.splice(nextIndex, 0, makeItem(item));
    };

    const addGapMarker = (time: string, index?: number) => {
        const playlist = currentPlaylist.value;
        const normalizedTime = normalizeTimeString(time);
        if (!playlist || !normalizedTime || !canScheduleCurrentPlaylist.value) return false;

        const selectedIndex = index ?? (playlist.selectedItemId
            ? playlist.items.findIndex((item) => item.id === playlist.selectedItemId) + 1
            : playlist.items.length);
        const nextIndex = Math.max(0, Math.min(selectedIndex, playlist.items.length));
        playlist.items.splice(nextIndex, 0, makeGapMarkerRecord(normalizedTime));
        return true;
    };

    const addLiveItem = (name: string, durationSec: number, playlistId = activePlaylistId.value) => {
        const playlist = getPlaylistById(playlistId);
        if (!playlist) return;
        playlist.items.push({
            id: uuidv4(),
            type: 'live',
            path: '',
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
            hardStartTime: ''
        });
    };

    const removeItem = (id: string) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        const index = playlist.items.findIndex((item) => item.id === id);
        if (index === -1) return;
        if (playlist.id === onAirPlaylistId.value && index === playlist.currentPlayingIndex) {
            return;
        }
        playlist.items.splice(index, 1);
        if (playlist.selectedItemId === id) playlist.selectedItemId = null;
        if (playlist.currentPlayingIndex >= playlist.items.length) playlist.currentPlayingIndex = -1;
    };

    const reorderItems = (oldIndex: number, newIndex: number) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        const movedItem = playlist.items[oldIndex];
        if (!movedItem) return;
        playlist.items.splice(oldIndex, 1);
        playlist.items.splice(newIndex, 0, movedItem);
    };

    const updateItem = (id: string, updates: Partial<RundownItem>) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        const index = playlist.items.findIndex((item) => item.id === id);
        if (index === -1) return;
        playlist.items[index] = { ...playlist.items[index], ...updates } as RundownItem;
    };

    const clearRundown = () => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        playlist.items = [];
        playlist.selectedItemId = null;
        if (playlist.id === onAirPlaylistId.value) {
            playlist.currentPlayingIndex = -1;
            playlist.playStartVisibleIndex = -1;
        }
    };

    const serializeRundown = (name?: string): PlaylistFile => ({
        version: '1.1',
        name: name || currentPlaylist.value?.name || 'Rundown',
        created: Date.now(),
        startFromTime: currentPlaylist.value?.startFromTime || '',
        startFromWeekday: currentPlaylist.value?.startFromWeekday ?? new Date().getDay(),
        items: JSON.parse(JSON.stringify(currentPlaylist.value?.items || []))
    });

    const deserializeRundown = (playlistData: PlaylistFile, append = false) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        const hydrated = (playlistData.items || []).map((item) => hydrateItem(item));
        if (append) {
            playlist.items.push(...hydrated);
        } else {
            playlist.items = hydrated;
            playlist.selectedItemId = null;
            playlist.currentPlayingIndex = -1;
            playlist.playStartVisibleIndex = -1;
            playlist.startFromTime = normalizeTimeString(playlistData.startFromTime || '');
            playlist.startFromWeekday = normalizeWeekday(playlistData.startFromWeekday ?? playlist.startFromWeekday ?? new Date().getDay());
            if (playlistData.name) {
                playlist.name = playlistData.name;
            }
        }
    };

    const duplicateItem = (id: string) => {
        const playlist = currentPlaylist.value;
        if (!playlist) return;
        const index = playlist.items.findIndex((item) => item.id === id);
        if (index === -1) return;
        const duplicate = hydrateItem({ ...playlist.items[index], id: undefined });
        playlist.items.splice(index + 1, 0, duplicate);
    };

    const createPlaylist = (name?: string) => {
        const playlist = makePlaylistRecord(playlists.value.length + 1, name);
        playlists.value.push(playlist);
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
        playlist.name = trimmed;
    };

    const closePlaylist = (playlistId: string) => {
        if (playlists.value.length <= 1 || playlistId === onAirPlaylistId.value) return false;
        const index = playlists.value.findIndex((playlist) => playlist.id === playlistId);
        if (index === -1) return false;
        playlists.value.splice(index, 1);
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
                previousPlaylist.currentPlayingIndex = -1;
                previousPlaylist.playStartVisibleIndex = -1;
            }
        }

        const playlist = getPlaylistById(playlistId);
        if (!playlist) return;
        onAirPlaylistId.value = playlistId;
        playlist.currentPlayingIndex = startVisibleIndex;
        playlist.playStartVisibleIndex = startVisibleIndex;
    };

    const setOnAirPlayingIndex = (playableIndex: number) => {
        const playlist = onAirPlaylist.value;
        if (!playlist) return;
        playlist.currentPlayingIndex = mapPlayableIndexToVisible(playlist.id, playableIndex);
    };

    const clearOnAirState = () => {
        const playlist = onAirPlaylist.value;
        if (playlist) {
            playlist.currentPlayingIndex = -1;
            playlist.playStartVisibleIndex = -1;
        }
        onAirPlaylistId.value = null;
    };

    return {
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
        serializeRundown,
        deserializeRundown,
        setPlaylistOnAir,
        setOnAirPlayingIndex,
        clearOnAirState
    };
}, {
    persist: true
});

