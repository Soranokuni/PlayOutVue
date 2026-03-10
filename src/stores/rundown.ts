import { defineStore } from 'pinia';
import { v4 as uuidv4 } from 'uuid';
import { ref, computed } from 'vue';

export type ComplianceRating = 'none' | 'k' | '8' | '12' | '16' | '18';

export interface RundownItem {
    id: string;
    type: 'video' | 'live' | 'graphic';
    path: string;
    shortPath: string;
    filename: string;
    duration: number;       // total duration in seconds (0 = unknown/live)
    seek: number;           // legacy seek field
    length: number;         // legacy length field
    inPoint: number;        // non-destructive IN trim point in ms (0 = start)
    outPoint: number;       // non-destructive OUT trim point in ms (0 = end/disabled)
    plannedDuration: number; // for live items: operator-planned duration in seconds
    note: string;           // optional operator note per line
    complianceRating: ComplianceRating;
    complianceDescriptors: string[];
    complianceText: string;
}

export interface PlaylistFile {
    version: '1.0';
    name: string;
    created: number;
    items: RundownItem[];
}

type RundownDraft = Omit<RundownItem, 'id' | 'inPoint' | 'outPoint' | 'plannedDuration' | 'note' | 'complianceRating' | 'complianceDescriptors' | 'complianceText'>
    & Partial<Pick<RundownItem, 'complianceRating' | 'complianceDescriptors' | 'complianceText'>>;

export const useRundownStore = defineStore('rundown', () => {
    const activeItems = ref<RundownItem[]>([]);
    const selectedItemId = ref<string | null>(null);

    const makeItem = (item: RundownDraft): RundownItem => ({
        ...item,
        id: uuidv4(),
        inPoint: 0,
        outPoint: 0,
        plannedDuration: item.duration || 0,
        note: '',
        complianceRating: item.complianceRating || 'none',
        complianceDescriptors: item.complianceDescriptors || [],
        complianceText: item.complianceText || ''
    });

    const hydrateItem = (item: Partial<RundownItem>): RundownItem => ({
        id: uuidv4(),
        type: (item.type as RundownItem['type']) || 'video',
        path: item.path || '',
        shortPath: item.shortPath || '',
        filename: item.filename || 'Untitled',
        duration: item.duration || 0,
        seek: item.seek || 0,
        length: item.length || 0,
        inPoint: item.inPoint || 0,
        outPoint: item.outPoint || 0,
        plannedDuration: item.plannedDuration || item.duration || 0,
        note: item.note || '',
        complianceRating: item.complianceRating || 'none',
        complianceDescriptors: Array.isArray(item.complianceDescriptors) ? item.complianceDescriptors : [],
        complianceText: item.complianceText || ''
    });

    const addItem = (item: RundownDraft) => {
        activeItems.value.push(makeItem(item));
    };

    const insertItemAt = (index: number, item: RundownDraft) => {
        const nextIndex = Math.max(0, Math.min(index, activeItems.value.length));
        activeItems.value.splice(nextIndex, 0, makeItem(item));
    };

    const addLiveItem = (name: string, durationSec: number) => {
        activeItems.value.push({
            id: uuidv4(),
            type: 'live',
            path: '',
            shortPath: '',
            filename: name,
            duration: durationSec,
            seek: 0,
            length: 0,
            inPoint: 0,
            outPoint: 0,
            plannedDuration: durationSec,
            note: '',
            complianceRating: 'none',
            complianceDescriptors: [],
            complianceText: ''
        });
    };

    const removeItem = (id: string) => {
        const index = activeItems.value.findIndex(i => i.id === id);
        if (index !== -1) {
            activeItems.value.splice(index, 1);
        }
        if (selectedItemId.value === id) selectedItemId.value = null;
    };

    const reorderItems = (oldIndex: number, newIndex: number) => {
        const movedItem = activeItems.value[oldIndex];
        if (movedItem) {
            activeItems.value.splice(oldIndex, 1);
            activeItems.value.splice(newIndex, 0, movedItem);
        }
    };

    const updateItem = (id: string, updates: Partial<RundownItem>) => {
        const index = activeItems.value.findIndex(i => i.id === id);
        if (index !== -1) {
            activeItems.value[index] = { ...activeItems.value[index], ...updates } as RundownItem;
        }
    };

    const clearRundown = () => {
        activeItems.value.splice(0, activeItems.value.length);
        selectedItemId.value = null;
    };

    const serializeRundown = (name: string): PlaylistFile => ({
        version: '1.0',
        name,
        created: Date.now(),
        items: JSON.parse(JSON.stringify(activeItems.value))
    });

    const deserializeRundown = (playlist: PlaylistFile, append = false) => {
        const hydrated = playlist.items.map(item => hydrateItem(item));
        if (append) {
            activeItems.value.push(...hydrated);
        } else {
            activeItems.value = hydrated;
            selectedItemId.value = null;
        }
    };

    const duplicateItem = (id: string) => {
        const idx = activeItems.value.findIndex(i => i.id === id);
        if (idx === -1) return;
        const original = activeItems.value[idx] as RundownItem;
        const copy: RundownItem = { ...original, id: uuidv4() };
        activeItems.value.splice(idx + 1, 0, copy);
    };

    const currentPlayingIndex = ref<number>(-1);

    const selectedItem = computed(() =>
        activeItems.value.find(i => i.id === selectedItemId.value) || null
    );

    const totalDuration = computed(() =>
        activeItems.value.reduce((acc, item) => {
            if (item.outPoint > 0 && item.inPoint >= 0) {
                return acc + (item.outPoint - item.inPoint) / 1000;
            }
            return acc + (item.plannedDuration || item.duration || 0);
        }, 0)
    );

    return {
        activeItems,
        selectedItemId,
        selectedItem,
        totalDuration,
        currentPlayingIndex,
        addItem,
        insertItemAt,
        addLiveItem,
        removeItem,
        duplicateItem,
        reorderItems,
        clearRundown,
        updateItem,
        serializeRundown,
        deserializeRundown
    };
});

