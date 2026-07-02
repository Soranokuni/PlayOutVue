<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { refDebounced } from '@vueuse/core';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useRundownStore, parseBroadcastRating, serializeBroadcastRating, getMetadataFromAssetResponse, type ComplianceRating } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';
import { useMediaDefaultsStore, type LibraryIndicator } from '../stores/mediaDefaults';
import { useIngestorStatusStore } from '../stores/ingestorStatus';
import { useMediaLibraryStore, type LibraryAsset, type TreeNode } from '../stores/mediaLibrary';
import { draggingItem } from '../composables/useDragState';
import TrimPanel from './TrimPanel.vue';
import ContextMenu, { type MenuItem, type TopAction } from './ContextMenu.vue';

const store = useRundownStore();
const settings = useSettingsStore();
const mediaDefaults = useMediaDefaultsStore();
const mediaLibrary = useMediaLibraryStore();
const ingestorStatus = useIngestorStatusStore();

const showTrimPanel = ref(false);
const trimAsset = ref<LibraryAsset | null>(null);
const isScanning = ref(false);
const isWarmingCatalog = ref(false);
const libraryQuery = ref('');
const showDebugMenu = ref(false);
const showDebugPanel = ref(false);
const diagnosticEntries = ref<DiagnosticEntry[]>([]);

interface DiagnosticEntry {
    timestampMs: number;
    level: string;
    scope: string;
    message: string;
}

interface MediaProbeStatus {
    running: boolean;
    rootPath: string;
    ffprobePath: string;
    currentFile: string;
    checked: number;
    updated: number;
    skipped: number;
    totalCandidates: number;
    startedAtMs: number;
    finishedAtMs: number;
    lastError: string;
}

interface RescanOptions {
    scheduleProbe?: boolean;
    probeDelayMs?: number;
}

interface DiscoveredMedia {
    filename: string;
    path: string;
    short_path: string;
    entry_kind: string;
    media_type: string;
    playoutvue_id: string;
    duration: number;
    duration_ms: number;
    trim_in_ms: number;
    trim_out_ms: number;
    width: number;
    height: number;
    codec: string;
    fps_num: number;
    fps_den: number;
    display_aspect_ratio: string;
    field_order: string;
    display_name: string;
    virtual_folder: string;
}

const ROW_HEIGHT = 34;
const libTreeRef = ref<HTMLElement | null>(null);
const contextMenu = ref({
    show: false, x: 0, y: 0, node: null as TreeNode | null
});

const debouncedLibraryQuery = refDebounced(libraryQuery, 120);
let scheduledWarmupTimer: ReturnType<typeof setTimeout> | null = null;
let periodicWarmupTimer: ReturnType<typeof setInterval> | null = null;

const createDefaultProbeStatus = (): MediaProbeStatus => ({
    running: false,
    rootPath: '',
    ffprobePath: '',
    currentFile: '',
    checked: 0,
    updated: 0,
    skipped: 0,
    totalCandidates: 0,
    startedAtMs: 0,
    finishedAtMs: 0,
    lastError: ''
});
const probeStatus = ref<MediaProbeStatus>(createDefaultProbeStatus());

const expandedFolders = ref<Record<string, boolean>>({});

function getFolderName(path: string): string {
    if (path === '/') return 'All Media';
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'Unknown';
}

const folderGroups = computed(() => {
    const query = mediaLibrary.searchQuery.trim().toLowerCase();
    const groups: Record<string, LibraryAsset[]> = {};

    groups['/'] = [];

    for (const asset of mediaLibrary.assets) {
        if (mediaLibrary.deletedUuids.includes(asset.uuid)) continue;

        if (query) {
            const displayName = asset.display_name || asset.current_path?.split(/[/\\]/).pop() || 'Untitled';
            if (!displayName.toLowerCase().includes(query)) {
                continue;
            }
        }

        const folder = normalizeVirtualFolder(asset.virtual_folder);
        if (!groups[folder]) {
            groups[folder] = [];
        }
        groups[folder].push(asset);
    }

    if (!query) {
        for (const folder of Object.keys(mediaLibrary.transientFolders)) {
            const normalized = normalizeVirtualFolder(folder);
            if (!groups[normalized]) {
                groups[normalized] = [];
            }
        }
    }

    const sortedFolderNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));

    return sortedFolderNames.map(folderPath => {
        const sortedAssets = [...(groups[folderPath] || [])].sort((a, b) =>
            (a.display_name || '').localeCompare(b.display_name || '')
        );
        return {
            folderName: folderPath,
            assets: sortedAssets
        };
    }).filter(group => {
        if (query) {
            const nameMatch = getFolderName(group.folderName).toLowerCase().includes(query);
            return group.assets.length > 0 || nameMatch;
        }
        return true;
    });
});


watch(debouncedLibraryQuery, (query) => {
    mediaLibrary.searchQuery = query.trim().toLowerCase();
}, { immediate: true });

const visibleFileCount = computed(() =>
    mediaLibrary.assets.filter((a) => !mediaLibrary.deletedUuids.includes(a.uuid)).length
);

const formatDuration = (seconds: number) => {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainingSeconds = total % 60;
    return [
        hours ? `${hours}h` : '',
        minutes ? `${minutes}m` : '',
        `${remainingSeconds}s`
    ].filter(Boolean).join(' ');
};

const totalLibraryDuration = computed(() => {
    let ms = 0;
    for (const asset of mediaLibrary.assets) {
        if (!mediaLibrary.deletedUuids.includes(asset.uuid)) {
            ms += Math.max(0, asset.duration_ms);
        }
    }
    return formatDuration(ms / 1000);
});

function logIngestor(scope: string, message: string, level: 'warn' | 'error' = 'warn') {
    ingestorStatus.log(scope, message, level);
}

async function ingestorInvoke<T>(
    cmd: string,
    args: Record<string, unknown>,
    scope: string
): Promise<T | null> {
    try {
        return await invoke<T>(cmd, args);
    } catch (error) {
        logIngestor(scope, `${error}`, 'error');
        return null;
    }
}

function mapApiRating(rating: string): ComplianceRating {
    const lower = (rating || '').toLowerCase();
    if (['k', '8', '12', '16', '18'].includes(lower)) {
        return lower as ComplianceRating;
    }
    return 'none';
}

function normalizeVirtualFolder(value?: string | null): string {
    if (!value) return '/';
    const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized === '') return '/';
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function libraryAssetFromApi(asset: any): LibraryAsset {
    const meta = getMetadataFromAssetResponse(asset);
    const serializedRating = serializeBroadcastRating(meta);
    return {
        uuid: asset.uuid || '',
        current_path: asset.current_path || '',
        display_name: asset.display_name || asset.current_path?.split(/[/\\]/).pop() || 'Untitled',
        virtual_folder: normalizeVirtualFolder(asset.virtual_folder),
        duration_ms: asset.duration_ms || 0,
        trim_in_ms: asset.trim_in_ms || 0,
        trim_out_ms: asset.trim_out_ms || 0,
        rating: serializedRating,
        tp: asset.tp || 'None',
        status: asset.status || 'idle',
        width: asset.width,
        height: asset.height,
        fpsNum: asset.fps_num || asset.fpsNum,
        fpsDen: asset.fps_den || asset.fpsDen,
        displayAspectRatio: asset.display_aspect_ratio || asset.displayAspectRatio,
        fieldOrder: asset.field_order || asset.fieldOrder,
        codec: asset.codec,
    };
}

async function fetchAssetsFromApi(): Promise<LibraryAsset[] | null> {
    const response = await ingestorInvoke<any[]>(
        'list_ingestor_assets',
        { apiBaseUrlOverride: null },
        'ingestor-list'
    );
    if (!response) return null;
    return response.map(libraryAssetFromApi);
}

async function fetchAssetsFromLocalFallback(): Promise<LibraryAsset[]> {
    const root = (settings.localMediaPath || '').trim();
    if (!root) return [];

    try {
        const files = await invoke<DiscoveredMedia[]>('scan_directory', { path: root }
        );
        return files
            .filter((f) => f.entry_kind === 'file')
            .map((f) => ({
                uuid: f.playoutvue_id || `local:${f.path}`,
                current_path: f.path,
                display_name: f.display_name || f.filename,
                virtual_folder: normalizeVirtualFolder(
                    f.virtual_folder ? `/Unmanaged/${f.virtual_folder}` : '/Unmanaged'
                ),
                duration_ms: f.duration_ms || 0,
                trim_in_ms: f.trim_in_ms || 0,
                trim_out_ms: f.trim_out_ms || 0,
                rating: '',
                tp: 'None',
                status: 'ready',
                width: f.width,
                height: f.height,
                fpsNum: f.fps_num,
                fpsDen: f.fps_den,
                displayAspectRatio: f.display_aspect_ratio,
                fieldOrder: f.field_order,
                codec: f.codec,
            }));
    } catch (error) {
        logIngestor('ingestor-list', `Local fallback scan failed: ${error}`, 'error');
        return [];
    }
}

async function fetchAssets(options: { force?: boolean } = {}) {
    isScanning.value = true;
    try {
        const apiAssets = await fetchAssetsFromApi();
        if (apiAssets) {
            mediaLibrary.setAssets(apiAssets);
            ingestorStatus.setOnline(true);
            await mediaLibrary.fetchFolderColors();
            if (!options.force) {
                return;
            }
        } else {
            ingestorStatus.setOnline(false);
            if (!ingestorStatus.lastSeenAt) {
                logIngestor(
                    'ingestor-list',
                    'Ingestor API is unreachable; falling back to local directory scan.',
                    'warn'
                );
            }
        }

        // Fallback when offline or during forced refresh
        if (!ingestorStatus.isIngestorOnline) {
            const fallbackAssets = await fetchAssetsFromLocalFallback();
            const merged = mergeAssets(mediaLibrary.assets, fallbackAssets);
            mediaLibrary.setAssets(merged);
        }
    } finally {
        isScanning.value = false;
    }
}

function mergeAssets(
    existing: LibraryAsset[],
    fallback: LibraryAsset[]
): LibraryAsset[] {
    const byUuid = new Map(existing.map((a) => [a.uuid, a]));
    for (const asset of fallback) {
        if (!byUuid.has(asset.uuid)) {
            byUuid.set(asset.uuid, asset);
        }
    }
    return Array.from(byUuid.values());
}

function assetDurationSeconds(asset?: LibraryAsset): number {
    return asset && asset.duration_ms > 0 ? asset.duration_ms / 1000 : 0;
}

function effectiveDurationSeconds(asset?: LibraryAsset): number {
    if (!asset || asset.duration_ms <= 0) return 0;
    const effectiveMs = asset.duration_ms - (asset.trim_in_ms || 0) - (asset.trim_out_ms || 0);
    return Math.max(0, effectiveMs) / 1000;
}

function makeRundownDraftFromAsset(asset: LibraryAsset) {
    const nameLower = (asset.display_name || '').toLowerCase();
    const ratingLower = (asset.rating || '').toLowerCase();
    const isSubclip = nameLower.includes('sub-clip') || nameLower.includes('subclip') || ratingLower.includes('subclip');

    let duration = assetDurationSeconds(asset);
    let effective = effectiveDurationSeconds(asset);
    let inPoint = asset.trim_in_ms || 0;
    let outPoint = asset.duration_ms > 0
        ? asset.duration_ms - (asset.trim_out_ms || 0)
        : 0;
    let durationMs = asset.duration_ms;

    if (isSubclip) {
        const calculatedDuration = (asset.trim_out_ms || 0) - (asset.trim_in_ms || 0);
        durationMs = calculatedDuration;
        duration = calculatedDuration / 1000;
        effective = calculatedDuration / 1000;
        inPoint = asset.trim_in_ms || 0;
        outPoint = asset.trim_out_ms || 0;
    }

    const meta = parseBroadcastRating(asset.rating);
    const compliance = meta.ageRating ||
        mediaDefaults.getCompliance(asset.uuid, asset.current_path);
    return {
        playoutvueId: asset.uuid.startsWith('local:') ? undefined : asset.uuid,
        inPoint,
        outPoint,
        filename: asset.display_name,
        path: asset.current_path,
        shortPath: '',
        type: 'video' as const,
        libraryIndicator: mediaDefaults.getIndicator(asset.uuid, asset.current_path),
        duration,
        plannedDuration: effective,
        seek: 0,
        length: 0,
        complianceRating: compliance,
        tp_flag: meta.tpFlag,
        content_type: meta.contentType,
        display_name: asset.display_name,
        virtual_folder: asset.virtual_folder,
        current_path: asset.current_path,
        duration_ms: durationMs,
        trim_in_ms: asset.trim_in_ms,
        trim_out_ms: asset.trim_out_ms,
    };
}

async function addSelectedAssetToRundown() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset) return;
    store.addItem(makeRundownDraftFromAsset(asset));
}

const FOLDER_DRAG_MIME = 'application/x-playout-folder';
const folderDropTargetId = ref<string | null>(null);

function onFolderClick(folderPath: string) {
    mediaLibrary.selectedNodeId = `folder:${folderPath}`;
    mediaLibrary.currentFolderPath = folderPath;
}

function onFolderDoubleClick(folderPath: string) {
    expandedFolders.value[folderPath] = !expandedFolders.value[folderPath];
}

function onAssetClick(asset: LibraryAsset) {
    mediaLibrary.selectedNodeId = `asset:${asset.uuid}`;
}

function onAssetDoubleClick(asset: LibraryAsset) {
    store.addItem(makeRundownDraftFromAsset(asset));
}

function onAssetDragStart(event: DragEvent, asset: LibraryAsset) {
    mediaLibrary.selectedNodeId = `asset:${asset.uuid}`;
    const meta = parseBroadcastRating(asset.rating);
    const payload = {
        playoutvueId: asset.uuid.startsWith('local:') ? undefined : asset.uuid,
        filename: asset.display_name,
        path: asset.current_path,
        shortPath: '',
        type: 'video' as const,
        libraryIndicator: mediaDefaults.getIndicator(asset.uuid, asset.current_path),
        inPoint: asset.trim_in_ms,
        outPoint: asset.duration_ms > 0 ? asset.duration_ms - (asset.trim_out_ms || 0) : 0,
        duration: assetDurationSeconds(asset),
        plannedDuration: effectiveDurationSeconds(asset),
        seek: 0,
        length: 0,
        complianceRating: meta.ageRating ||
            mediaDefaults.getCompliance(asset.uuid, asset.current_path),
        tp_flag: meta.tpFlag,
        content_type: meta.contentType,
        display_name: asset.display_name,
        virtual_folder: asset.virtual_folder,
        current_path: asset.current_path,
        duration_ms: asset.duration_ms,
        trim_in_ms: asset.trim_in_ms,
        trim_out_ms: asset.trim_out_ms,
    };
    draggingItem.value = payload;
    if (event.dataTransfer) {
        event.dataTransfer.setData('text/plain', asset.uuid);
        event.dataTransfer.effectAllowed = 'copy';
    }
}

function onFolderDragStart(event: DragEvent, folderPath: string) {
    mediaLibrary.selectedNodeId = `folder:${folderPath}`;
    if (event.dataTransfer) {
        event.dataTransfer.setData(FOLDER_DRAG_MIME, folderPath);
        event.dataTransfer.setData('text/plain', folderPath);
        event.dataTransfer.effectAllowed = 'move';
    }
}

function onAssetContextMenu(event: MouseEvent, asset: LibraryAsset) {
    const node: TreeNode = {
        id: `asset:${asset.uuid}`,
        type: 'asset',
        name: asset.display_name,
        virtualFolder: asset.virtual_folder,
        depth: 1,
        asset
    };
    mediaLibrary.selectedNodeId = node.id;
    contextMenu.value = { show: true, x: event.clientX, y: event.clientY, node };
}

function onFolderContextMenu(event: MouseEvent, folderPath: string) {
    const node: TreeNode = {
        id: `folder:${folderPath}`,
        type: 'folder',
        name: getFolderName(folderPath),
        virtualFolder: folderPath,
        depth: 0,
        expanded: expandedFolders.value[folderPath],
        color: mediaLibrary.folderColors[folderPath] || ''
    };
    mediaLibrary.selectedNodeId = node.id;
    contextMenu.value = { show: true, x: event.clientX, y: event.clientY, node };
}

function closeContextMenu() {
    contextMenu.value = { ...contextMenu.value, show: false, node: null };
}

function ctxAppend() {
    const node = contextMenu.value.node;
    if (node?.type === 'asset' && node.asset) {
        store.addItem(makeRundownDraftFromAsset(node.asset));
    }
    closeContextMenu();
}

function ctxInsertAfter() {
    const node = contextMenu.value.node;
    if (node?.type !== 'asset' || !node.asset) {
        closeContextMenu();
        return;
    }
    const draft = makeRundownDraftFromAsset(node.asset);
    if (store.selectedItemId) {
        const idx = store.activeItems.findIndex((i) => i.id === store.selectedItemId);
        if (idx >= 0) {
            store.insertItemAt(idx + 1, draft);
            closeContextMenu();
            return;
        }
    }
    store.addItem(draft);
    closeContextMenu();
}

function ctxRename() {
    closeContextMenu();
    doRenameSelected();
}

function ctxDelete() {
    const node = contextMenu.value.node;
    if (node?.type === 'asset' && node.asset) {
        doDeleteAsset(node.asset.uuid);
    }
    closeContextMenu();
}

function ctxPurge() {
    const node = contextMenu.value.node;
    if (node?.type === 'asset' && node.asset) {
        doPurgeAsset(node.asset);
    }
    closeContextMenu();
}

function ctxMove() {
    closeContextMenu();
    doMoveSelected();
}

function ctxTrim() {
    const node = contextMenu.value.node;
    if (node?.type === 'asset' && node.asset) {
        trimAsset.value = node.asset;
        showTrimPanel.value = true;
    }
    closeContextMenu();
}

function doNewVirtualFolder() {
    const name = window.prompt('New virtual folder name');
    if (!name) return;
    mediaLibrary.createVirtualFolder(name);
    closeContextMenu();
}

function doRenameFolder() {
    const node = contextMenu.value.node;
    if (!node || node.type !== 'folder') return;
    const oldPath = node.virtualFolder;
    const currentName = oldPath.split('/').pop() || '';
    const newName = window.prompt(`Rename folder "${currentName}" to:`, currentName);
    if (!newName) return;
    mediaLibrary.renameTransientFolder(oldPath, newName);
    closeContextMenu();
}

function doRemoveFolder() {
    const node = contextMenu.value.node;
    if (!node || node.type !== 'folder') return;
    mediaLibrary.removeTransientFolder(node.virtualFolder);
    closeContextMenu();
}

async function doRenameSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset) return;
    const newName = window.prompt('Rename asset', asset.display_name);
    if (!newName || newName === asset.display_name) return;

    const result = await ingestorInvoke<void>(
        'rename_ingestor_asset',
        { uuid: asset.uuid, display_name: newName, apiBaseUrlOverride: null },
        'ingestor-rename'
    );
    if (result === null) return;
    mediaLibrary.renameAsset(asset.uuid, newName);
}

async function doMoveSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset) return;
    const current = mediaLibrary.currentFolderPath || '/';
    const target = window.prompt('Move to virtual folder', current);
    if (target === null) return;

    const normalized = normalizeVirtualFolder(target);
    if (asset.uuid.startsWith('local:')) {
        mediaLibrary.moveAssetToFolder(asset.uuid, normalized);
    } else {
        const result = await ingestorInvoke<void>(
            'move_ingestor_asset',
            { uuid: asset.uuid, virtual_folder: normalized, api_base_url_override: null },
            'ingestor-move'
        );
        if (result === null) return;
        // Keep the local virtual_folder as source of truth; do NOT force-refresh
        // from the API here, which previously discarded in-flight local overrides
        // and made the asset "jump back" (plan §3.2 desync fix). The local
        // override is re-applied on every setAssets() via localVirtualFolders.
        mediaLibrary.moveAssetToFolder(asset.uuid, normalized);
    }
}

function doDeleteSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset) return;
    doDeleteAsset(asset.uuid);
}

function doDeleteAsset(uuid: string) {
    if (uuid.startsWith('local:')) {
        // Local fallback assets can be hidden immediately.
        mediaLibrary.deleteAsset(uuid);
        return;
    }
    // Ingestor-managed delete is client-side only until API support arrives.
    if (!window.confirm('Hide this asset from the library?\n(The Ingestor API does not yet support deletion.) ')) return;
    mediaLibrary.deleteAsset(uuid);
}

async function doPurgeAsset(asset: LibraryAsset) {
    if (asset.uuid.startsWith('local:')) {
        window.alert("Cannot purge local fallback assets.");
        return;
    }
    const confirmed = window.confirm(
        `WARNING: Are you absolutely sure you want to permanently delete and purge "${asset.display_name}"?\n\nThis will:\n1. Permanently DELETE the physical file on disk.\n2. Delete all database records and virtual sub-clips matching this asset's file path or fingerprint.\n\nTHIS ACTION CANNOT BE UNDONE!`
    );
    if (!confirmed) return;

    try {
        await invoke('purge_ingestor_asset', {
            uuid: asset.uuid,
            apiBaseUrlOverride: null
        });
        mediaLibrary.deleteAsset(asset.uuid);
        await fetchAssets({ force: true });
    } catch (error) {
        window.alert(`Failed to purge asset: ${error}`);
    }
}

function openTrimPanelForSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset) return;
    trimAsset.value = asset;
    showTrimPanel.value = true;
}

const handleTrimSaved = async ({ uuid }: { uuid?: string }) => {
    if (!uuid) return;
    // Refresh the changed asset from the API in the background.
    const response = await ingestorInvoke<{
        uuid?: string;
        current_path: string;
        display_name?: string;
        virtual_folder?: string;
        duration_ms: number;
        trim_in_ms: number;
        trim_out_ms: number;
        rating: string;
        status: string;
    }>(
        'resolve_ingestor_asset',
        { uuid, apiBaseUrlOverride: null },
        'ingestor-resolve'
    );
    if (response) {
        mediaLibrary.updateAsset(uuid, libraryAssetFromApi(response));
    }
};

// --- Legacy local-file debug/probe panel (kept separate from client diagnostics) ---

const refreshProbeStatus = async () => {
    try {
        const status = await invoke<MediaProbeStatus>('get_media_probe_status');
        probeStatus.value = status;
    } catch (error) {
        console.warn('[Library] Failed to refresh probe status', error);
    }
};

const refreshDiagnostics = async () => {
    if (!settings.debugMode) return;
    try {
        diagnosticEntries.value = await invoke<DiagnosticEntry[]>('get_diagnostic_logs', { limit: 80 });
    } catch (error) {
        console.warn('[Library] Failed to refresh diagnostics', error);
    }
};

const refreshDebugPanel = async () => {
    await refreshProbeStatus();
    await refreshDiagnostics();
};

const startBackgroundProbe = async (_reason = 'manual') => {
    clearScheduledWarmup();
    const mediaPath = (settings.localMediaPath || '').trim();
    if (!mediaPath) return;
    if (probeStatus.value.running) {
        await refreshProbeStatus();
        return;
    }
    try {
        const status = await invoke<MediaProbeStatus>('start_media_probe', { path: mediaPath });
        probeStatus.value = status;
        if (settings.debugMode && showDebugPanel.value) {
            await refreshDiagnostics();
        }
    } catch (error) {
        console.warn('[Library] Media cache warm-up failed', error);
        await refreshProbeStatus();
    }
};

const scheduleLibraryWarmup = (delayMs = 1400) => {
    clearScheduledWarmup();
    const mediaPath = (settings.localMediaPath || '').trim();
    if (!mediaPath || probeStatus.value.running || mediaLibrary.assets.length === 0) return;

    scheduledWarmupTimer = setTimeout(() => {
        scheduledWarmupTimer = null;
        startBackgroundProbe('scheduled').catch(() => {});
    }, delayMs);
};

const clearScheduledWarmup = () => {
    if (!scheduledWarmupTimer) return;
    clearTimeout(scheduledWarmupTimer);
    scheduledWarmupTimer = null;
};

const clearDiagnostics = async () => {
    try {
        await invoke('clear_diagnostic_logs');
        diagnosticEntries.value = [];
        await refreshDiagnostics();
    } catch (error) {
        console.warn('[Library] Failed to clear diagnostics', error);
    }
};

const exportDiagnostics = async () => {
    try {
        const outputPath = await save({
            title: 'Export PlayOut Debug Log',
            defaultPath: 'playout-debug-log.txt',
            filters: [{ name: 'Text Files', extensions: ['txt'] }]
        });
        if (!outputPath || Array.isArray(outputPath)) return;
        await invoke('export_diagnostic_logs', { outputPath });
    } catch (error) {
        console.warn('[Library] Failed to export diagnostics', error);
    }
};

const probeProgressLabel = computed(() => {
    if (!probeStatus.value.running) return '';
    if (probeStatus.value.totalCandidates > 0) {
        return `probing ${probeStatus.value.checked}/${probeStatus.value.totalCandidates}`;
    }
    return 'probing…';
});

const formatDiagnosticTime = (timestampMs: number) => {
    if (!timestampMs) return '--:--:--';
    return new Date(timestampMs).toLocaleTimeString([], {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
};

watch(() => [settings.ingestorApiBaseUrl, settings.localMediaPath], () => {
    fetchAssets();
}, { deep: true });

watch(() => settings.debugMode, (enabled) => {
    if (!enabled) {
        showDebugMenu.value = false;
        showDebugPanel.value = false;
        diagnosticEntries.value = [];
    } else {
        refreshDebugPanel().catch(() => {});
    }
});

watch(
    probeProgressLabel,
    () => {},
    { immediate: true }
);

onMounted(() => {
    refreshProbeStatus().catch(() => {});
    fetchAssets();
    if (settings.debugMode) refreshDebugPanel().catch(() => {});
    periodicWarmupTimer = setInterval(() => {
        if (!probeStatus.value.running) {
            scheduleLibraryWarmup(0);
        }
    }, 300000);
    mediaLibrary.fetchFolderColors();
    window.addEventListener('click', closeContextMenu);
});

onUnmounted(() => {
    if (periodicWarmupTimer) {
        clearInterval(periodicWarmupTimer);
        periodicWarmupTimer = null;
    }
    clearScheduledWarmup();
    window.removeEventListener('click', closeContextMenu);
});

function onFolderDragOverPath(event: DragEvent, folderPath: string) {
    event.preventDefault();
    folderDropTargetId.value = `folder:${folderPath}`;
    if (event.dataTransfer) {
        const isFolderDrag = event.dataTransfer.types.includes(FOLDER_DRAG_MIME);
        event.dataTransfer.dropEffect = isFolderDrag ? 'move' : 'copy';
    }
}

async function onFolderDropPath(event: DragEvent, folderPath: string) {
    event.preventDefault();
    folderDropTargetId.value = null;

    if (event.dataTransfer) {
        const sourceFolder = event.dataTransfer.getData(FOLDER_DRAG_MIME);
        if (sourceFolder) {
            mediaLibrary.moveFolderInto(sourceFolder, folderPath);
            draggingItem.value = null;
            return;
        }
    }

    let uuid = '';
    if (event.dataTransfer) {
        uuid = event.dataTransfer.getData('text/plain');
    }
    if (!uuid && draggingItem.value) {
        uuid = draggingItem.value.playoutvueId || `local:${draggingItem.value.path}`;
    }
    if (!uuid || uuid.startsWith('/') || uuid.startsWith('application/')) {
        draggingItem.value = null;
        return;
    }

    const isLocal = uuid.startsWith('local:');

    if (!isLocal) {
        const result = await ingestorInvoke<void>(
            'move_ingestor_asset',
            { uuid: uuid, virtual_folder: folderPath, api_base_url_override: null },
            'ingestor-move'
        );
        if (result !== null) {
            mediaLibrary.moveAssetToFolder(uuid, folderPath);
        }
    } else {
        mediaLibrary.moveAssetToFolder(uuid, folderPath);
    }

    draggingItem.value = null;
}

const ratingOptions = [
  { id: 'none', label: 'None' },
  { id: 'k', label: 'K' },
  { id: '8', label: '8+' },
  { id: '12', label: '12+' },
  { id: '16', label: '16+' },
  { id: '18', label: '18+' }
] as const;

const contentTypeOptions = [
  { id: 'none', label: 'None' },
  { id: 'movie', label: 'Movie' },
  { id: 'show', label: 'Show' },
  { id: 'documentary', label: 'Documentary' },
  { id: 'news', label: 'News' }
] as const;

async function ctxSetAgeRating(rating: ComplianceRating) {
  const asset = contextMenu.value.node?.asset;
  if (asset) {
    await mediaLibrary.updateAssetMetadata(asset.uuid, { complianceRating: rating });
  }
  closeContextMenu();
}

async function ctxToggleTP() {
  const asset = contextMenu.value.node?.asset;
  if (asset) {
    const meta = parseBroadcastRating(asset.rating);
    await mediaLibrary.updateAssetMetadata(asset.uuid, { tp_flag: !meta.tpFlag });
  }
  closeContextMenu();
}

async function ctxSetContentType(cType: typeof contentTypeOptions[number]['id']) {
  const asset = contextMenu.value.node?.asset;
  if (asset) {
    await mediaLibrary.updateAssetMetadata(asset.uuid, { content_type: cType });
  }
  closeContextMenu();
}

const folderColorsPreset = [
  { hex: '#e63946', label: 'Red' },
  { hex: '#f4a261', label: 'Orange' },
  { hex: '#e9c46a', label: 'Yellow' },
  { hex: '#2a9d8f', label: 'Teal' },
  { hex: '#457b9d', label: 'Blue' },
  { hex: '#a2d2ff', label: 'Light Blue' },
  { hex: '#b5e2fa', label: 'Sky' },
  { hex: '#c8b6ff', label: 'Lavender' },
  { hex: '#ffc6ff', label: 'Pink' },
  { hex: '#588157', label: 'Green' },
];

async function ctxSetFolderColor(color: string) {
  const node = contextMenu.value.node;
  if (node && node.type === 'folder') {
    await mediaLibrary.setFolderColor(node.virtualFolder, color);
  }
  closeContextMenu();
}

const topActionItems = computed<TopAction[]>(() => {
  const node = contextMenu.value.node;
  if (!node || node.type !== 'asset' || !node.asset) return [];
  
  return [
    {
      id: 'trim',
      tooltip: 'Trim Asset',
      action: ctxTrim,
      disabled: false
    },
    {
      id: 'rename',
      tooltip: 'Rename Asset',
      action: ctxRename,
      disabled: false
    },
    {
      id: 'purge',
      tooltip: 'Delete & Purge',
      action: ctxPurge,
      disabled: false
    },
    {
      id: 'delete',
      tooltip: 'Hide Asset',
      action: ctxDelete,
      disabled: false
    }
  ];
});

const menuItems = computed<MenuItem[]>(() => {
  const node = contextMenu.value.node;
  if (!node) return [];
  
  if (node.type === 'asset' && node.asset) {
    const asset = node.asset;
    const ratingMeta = parseBroadcastRating(asset.rating);
    
    return [
      {
        type: 'action',
        label: 'Append to Rundown',
        action: ctxAppend
      },
      {
        type: 'action',
        label: 'Insert After Selected',
        action: ctxInsertAfter
      },
      { type: 'divider' },
      {
        type: 'submenu',
        label: 'Age Ratings (Σήματα Καταλληλότητας)',
        children: ratingOptions.map(r => ({
          type: 'action',
          label: r.label,
          checked: ratingMeta.ageRating === r.id,
          action: () => ctxSetAgeRating(r.id)
        }))
      },
      { type: 'divider' },
      {
        type: 'toggle',
        label: ratingMeta.tpFlag ? '✓ TP (Active)' : '□ TP (None)',
        checked: ratingMeta.tpFlag,
        action: ctxToggleTP
      },
      { type: 'divider' },
      {
        type: 'submenu',
        label: 'Categories/Tags',
        children: contentTypeOptions.map(ct => ({
          type: 'action',
          label: ct.label,
          checked: ratingMeta.contentType === ct.id,
          action: () => ctxSetContentType(ct.id)
        }))
      },
      { type: 'divider' },
      {
        type: 'action',
        label: '➡️ Move to…',
        action: ctxMove
      }
    ];
  } else if (node.type === 'folder') {
    const folderItems: MenuItem[] = [
      {
        type: 'action',
        label: '📁 New Virtual Folder here',
        action: doNewVirtualFolder
      },
      {
        type: 'action',
        label: '✏️ Rename folder',
        action: doRenameFolder
      }
    ];
    
    if (node.isTransient) {
      folderItems.push({
        type: 'action',
        label: 'Remove empty placeholder',
        action: doRemoveFolder
      });
    }
    
    folderItems.push({ type: 'divider' });
    folderItems.push({
      type: 'submenu',
      label: 'Folder Colors',
      children: [
        ...folderColorsPreset.map(c => ({
          type: 'action' as const,
          label: c.label,
          checked: node.color === c.hex,
          action: () => ctxSetFolderColor(c.hex)
        })),
        { type: 'divider' as const },
        {
          type: 'action' as const,
          label: 'Reset Color',
          checked: !node.color,
          action: () => ctxSetFolderColor('')
        }
      ] as MenuItem[]
    });
    
    return folderItems;
  }
  
  return [];
});

</script>

<template>
  <div class="lib-wrap">
    <!-- Header -->
    <div class="lib-header">
      <div class="lib-header-copy">
        <span class="text-accent lib-title">Library</span>
        <span class="lib-subtitle">
          {{ visibleFileCount }} {{ visibleFileCount === 1 ? 'asset' : 'assets' }}
          <template v-if="totalLibraryDuration"> · {{ totalLibraryDuration }}</template>
          <template v-if="probeProgressLabel"> · {{ probeProgressLabel }}</template>
        </span>
      </div>
      <div class="lib-header-actions">
        <div v-if="settings.debugMode" class="debug-menu-wrap">
          <button class="icon-action" @click.stop="showDebugMenu = !showDebugMenu" :title="showDebugMenu ? 'Close debug menu' : 'Open debug menu'">
            Debug
          </button>
          <div v-if="showDebugMenu" class="debug-menu">
            <button class="debug-menu-item" @click.stop="startBackgroundProbe('manual'); showDebugMenu = false" :disabled="isWarmingCatalog">
              {{ isWarmingCatalog ? 'Background probe running…' : 'Start background probe' }}
            </button>
            <button class="debug-menu-item" @click.stop="refreshDebugPanel(); showDebugPanel = true; showDebugMenu = false">
              Show debug log
            </button>
            <button class="debug-menu-item" @click.stop="exportDiagnostics(); showDebugMenu = false" :disabled="!diagnosticEntries.length">
              Export log to .txt
            </button>
            <button class="debug-menu-item" @click.stop="clearDiagnostics(); showDebugMenu = false" :disabled="!diagnosticEntries.length">
              Clear debug log
            </button>
          </div>
        </div>
        <button
          class="icon-action"
          :disabled="isScanning"
          :title="isScanning ? 'Refreshing…' : 'Refresh from Ingestor'"
          @click="fetchAssets({ force: true })"
        >
          {{ isScanning ? '⌛' : '↻' }}
        </button>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="lib-toolbar">
      <input
        v-model="libraryQuery"
        class="glass-input lib-search"
        type="search"
        placeholder="Search assets…"
      >
      <button v-if="libraryQuery" class="icon-action" @click="libraryQuery = ''" title="Clear search">✕</button>
      <div class="toolbar-spacer" />
      <button
        class="icon-action"
        title="New virtual folder in current folder"
        :disabled="!mediaLibrary.currentFolderPath"
        @click="doNewVirtualFolder"
      >
        📁 New
      </button>
      <button
        class="icon-action"
        title="Rename selected asset"
        :disabled="!mediaLibrary.selectedAsset"
        @click="doRenameSelected"
      >
        ✏️ Rename
      </button>
      <button
        class="icon-action"
        title="Move selected asset"
        :disabled="!mediaLibrary.selectedAsset"
        @click="doMoveSelected"
      >
        ➡️ Move
      </button>
      <button
        class="icon-action"
        title="Hide selected asset"
        :disabled="!mediaLibrary.selectedAsset"
        @click="doDeleteSelected"
      >
        🗑 Delete
      </button>
    </div>

    <!-- Debug panel -->
    <div v-if="settings.debugMode && showDebugPanel" class="lib-debug-panel">
      <div class="debug-toolbar">
        <div class="debug-summary">
          <strong>{{ probeStatus.running ? 'Background probe active' : 'Background probe idle' }}</strong>
          <span>
            {{ probeStatus.checked }} checked · {{ probeStatus.updated }} updated · {{ probeStatus.skipped }} skipped
            <template v-if="probeStatus.totalCandidates"> · {{ probeStatus.totalCandidates }} total</template>
          </span>
        </div>
        <div class="debug-actions">
          <button class="icon-action" @click="refreshDebugPanel">Refresh</button>
          <button class="icon-action" @click="exportDiagnostics" :disabled="!diagnosticEntries.length">Export</button>
          <button class="icon-action" @click="clearDiagnostics" :disabled="!diagnosticEntries.length">Clear</button>
          <button class="icon-action" @click="showDebugPanel = false">Close</button>
        </div>
      </div>

      <div class="debug-meta">
        <div>ffprobe: {{ probeStatus.ffprobePath || 'not resolved yet' }}</div>
        <div v-if="probeStatus.currentFile">Current: {{ probeStatus.currentFile }}</div>
        <div v-else-if="probeStatus.rootPath">Root: {{ probeStatus.rootPath }}</div>
        <div v-if="probeStatus.lastError" class="debug-error">Last error: {{ probeStatus.lastError }}</div>
      </div>

      <div class="debug-log custom-scroll">
        <div v-if="!diagnosticEntries.length" class="debug-empty">No diagnostic entries yet.</div>
        <div
          v-for="(entry, index) in diagnosticEntries"
          :key="`${entry.timestampMs}-${entry.scope}-${index}`"
          class="debug-entry"
          :class="`level-${entry.level}`"
        >
          <span class="debug-time">{{ formatDiagnosticTime(entry.timestampMs) }}</span>
          <span class="debug-level">{{ entry.level.toUpperCase() }}</span>
          <span class="debug-scope">{{ entry.scope }}</span>
          <span class="debug-message">{{ entry.message }}</span>
        </div>
      </div>
    </div>

    <!-- Tree List -->
    <div ref="libTreeRef" class="lib-tree custom-scroll" @contextmenu.prevent style="overflow-y: auto;">
      <div v-if="isScanning && !folderGroups.length" class="lib-empty">⌛ Loading…</div>
      <div v-else-if="folderGroups.length === 0" class="lib-empty">
        {{ libraryQuery ? 'No matching assets found.' : '📂 No media found.\nSet the Ingestor API or media folder in ⚙️ Settings.' }}
      </div>
      <div v-else class="lib-tree-content">
        <div v-for="group in folderGroups" :key="group.folderName" class="folder-group">
          <div
            class="lib-row is-folder"
            :class="{
              'is-selected': mediaLibrary.selectedNodeId === `folder:${group.folderName}`,
              'is-folder-drop-target': folderDropTargetId === `folder:${group.folderName}`
            }"
            :draggable="true"
            @click="onFolderClick(group.folderName)"
            @dblclick="onFolderDoubleClick(group.folderName)"
            @contextmenu.prevent="onFolderContextMenu($event, group.folderName)"
            @dragstart="onFolderDragStart($event, group.folderName)"
            @dragend="folderDropTargetId = null"
            @dragover="onFolderDragOverPath($event, group.folderName)"
            @drop="onFolderDropPath($event, group.folderName)"
          >
            <!-- Chevron for folders -->
            <span
              class="chevron-icon"
              :class="{ 'is-expanded': expandedFolders[group.folderName] }"
              @click.stop="expandedFolders[group.folderName] = !expandedFolders[group.folderName]"
            >
              ▶
            </span>
            
            <span class="lib-icon" @click.stop="onFolderClick(group.folderName)">
              <svg
                class="folder-svg"
                viewBox="0 0 24 24"
                :style="{ fill: mediaLibrary.folderColors[group.folderName] || 'var(--accent-blue)' }"
              >
                <path v-if="expandedFolders[group.folderName]" d="M19 5.5h-7.28l-2-2H4c-1.1 0-2 .9-2 2v13c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-11c0-1.1-.9-2-2-2zm0 13H4v-11h16v11z"/>
                <path v-else d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
              </svg>
            </span>
            <span class="lib-text">
              <span class="lib-name">{{ getFolderName(group.folderName) }}</span>
            </span>
          </div>

          <!-- Wrap folder's assets list in v-show -->
          <div v-show="expandedFolders[group.folderName]" class="folder-children" style="display: flex; flex-direction: column;">
            <div
              v-for="asset in group.assets"
              :key="asset.uuid"
              class="lib-row is-asset"
              :class="{
                'is-selected': mediaLibrary.selectedNodeId === `asset:${asset.uuid}`
              }"
              :draggable="true"
              :style="{ paddingLeft: '26px' }"
              @click="onAssetClick(asset)"
              @dblclick="onAssetDoubleClick(asset)"
              @contextmenu.prevent="onAssetContextMenu($event, asset)"
              @dragstart="onAssetDragStart($event, asset)"
            >
              <span class="chevron-spacer"></span>
              
              <span class="lib-icon" @click.stop="onAssetClick(asset)">
                <span v-if="asset.status === 'ready'">🎬</span>
                <span v-else-if="asset.status === 'processing'">⏳</span>
                <span v-else>📄</span>
              </span>
              <span class="lib-text" :class="{ 'is-managed': !asset.uuid.startsWith('local:') }">
                <span class="lib-name-wrap">
                  <span class="lib-name">{{ asset.display_name }}</span>
                  <span class="mcr-badges">
                    <span v-if="parseBroadcastRating(asset.rating).ageRating !== 'none'" class="mcr-badge badge-age" :class="`age-${parseBroadcastRating(asset.rating).ageRating}`">
                      {{ parseBroadcastRating(asset.rating).ageRating.toUpperCase() }}
                    </span>
                    <span v-if="parseBroadcastRating(asset.rating).tpFlag" class="mcr-badge badge-tp">TP</span>
                    <span v-if="parseBroadcastRating(asset.rating).contentType !== 'none'" class="mcr-badge badge-content" :class="`content-${parseBroadcastRating(asset.rating).contentType}`">
                      {{ parseBroadcastRating(asset.rating).contentType.toUpperCase() }}
                    </span>
                  </span>
                </span>
              </span>
              <span v-if="effectiveDurationSeconds(asset) > 0" class="lib-time-pill">
                {{ formatDuration(effectiveDurationSeconds(asset)) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Context Menu -->
    <Teleport to="body">
      <ContextMenu
        v-if="contextMenu.show"
        :x="contextMenu.x"
        :y="contextMenu.y"
        :top-actions="topActionItems"
        :items="menuItems"
        @close="closeContextMenu"
      />
    </Teleport>

    <!-- Trim Panel -->
    <Teleport to="body">
      <TrimPanel
        :is-open="showTrimPanel"
        :library-item="trimAsset
          ? {
              id: trimAsset.uuid,
              uuid: trimAsset.uuid,
              path: trimAsset.current_path,
              filename: trimAsset.display_name,
              type: 'video',
              duration: assetDurationSeconds(trimAsset),
              inPoint: trimAsset.trim_in_ms,
              outPoint: trimAsset.duration_ms > 0 ? trimAsset.duration_ms - trimAsset.trim_out_ms : 0,
            }
          : null"
        @saved="handleTrimSaved"
        @close="showTrimPanel = false; trimAsset = null"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.lib-wrap { height:100%; display:flex; flex-direction:column; overflow:hidden; position:relative; }
.lib-header {
  display:flex; justify-content:space-between; align-items:center;
  padding:6px 10px; border-bottom:1px solid var(--glass-border); flex-shrink:0;
}
.lib-header-actions { display:flex; align-items:center; gap:6px; }
.lib-header-copy { display:flex; flex-direction:column; gap:2px; }
.lib-title { font-size:0.9rem; font-weight:600; }
.lib-subtitle { color:var(--text-secondary); font-size:0.7rem; }

.lib-toolbar {
  display:flex; align-items:center; gap:6px;
  padding:8px; border-bottom:1px solid var(--glass-border);
  flex-shrink:0;
}
.lib-search { flex:1; }
.toolbar-spacer { flex:1; }

.lib-debug-panel {
  padding:8px;
  border-bottom:1px solid var(--glass-border);
  background:color-mix(in srgb, var(--bg-tertiary) 72%, transparent);
  display:flex;
  flex-direction:column;
  gap:8px;
  flex-shrink:0;
}
.debug-toolbar {
  display:flex;
  justify-content:space-between;
  gap:8px;
  align-items:flex-start;
}
.debug-summary {
  display:flex;
  flex-direction:column;
  gap:2px;
  font-size:0.72rem;
  color:var(--text-secondary);
}
.debug-actions {
  display:flex;
  gap:6px;
}
.debug-meta {
  display:flex;
  flex-direction:column;
  gap:4px;
  font-size:0.7rem;
  color:var(--text-secondary);
  word-break:break-all;
}
.debug-error {
  color:#f4a261;
}
.debug-log {
  max-height:180px;
  overflow:auto;
  border:1px solid var(--glass-border);
  border-radius:6px;
  background:color-mix(in srgb, var(--bg-primary) 30%, var(--bg-secondary));
}
.debug-empty {
  color:var(--text-secondary);
  font-size:0.72rem;
  padding:10px;
}
.debug-entry {
  display:grid;
  grid-template-columns:60px 48px 54px 1fr;
  gap:8px;
  padding:6px 8px;
  font-size:0.7rem;
  border-bottom:1px solid rgba(255,255,255,0.04);
  align-items:start;
}
.debug-entry:last-child {
  border-bottom:none;
}
.debug-time,
.debug-level,
.debug-scope {
  color:var(--text-secondary);
}
.debug-message {
  color:var(--text-primary);
  word-break:break-word;
}
.level-error .debug-level {
  color:#e76f51;
}
.level-warn .debug-level {
  color:#f4a261;
}
.level-info .debug-level {
  color:#7bdff2;
}

.lib-tree {
  flex:1;
  position:relative;
  min-height:0;
  overflow:hidden;
}
.lib-empty { color:var(--text-secondary); font-size:0.78rem; text-align:center; padding:20px 10px; line-height:1.6; white-space:pre-line; }

.glass-input {
  background:var(--bg-tertiary); border:1px solid var(--glass-border);
  color:var(--text-primary); border-radius:4px; font-size:0.8rem; padding:5px 8px;
}
.icon-action {
  background:color-mix(in srgb, var(--bg-tertiary) 84%, transparent); border:1px solid var(--glass-border);
  color:var(--text-primary); border-radius:4px; cursor:pointer; padding:4px 8px; font-size:0.78rem; transition:0.15s;
}
.icon-action:hover:not(:disabled) { background:color-mix(in srgb, var(--accent-blue) 10%, var(--bg-tertiary)); }
.icon-action:disabled { opacity:0.4; cursor:not-allowed; }

.lib-row {
  display:flex;
  align-items:center;
  gap:8px;
  min-height:34px;
  height:34px;
  padding:5px 8px;
  padding-left:8px;
  border-radius:8px;
  user-select:none;
  border:1px solid transparent;
  transition:background 0.12s, border-color 0.12s;
  cursor:pointer;
}
.lib-row:hover {
  background:color-mix(in srgb, var(--accent-blue) 10%, transparent);
  border-color:color-mix(in srgb, var(--accent-blue) 18%, transparent);
}
.lib-row.is-selected {
  background:color-mix(in srgb, var(--accent-blue) 14%, transparent);
  border-color:color-mix(in srgb, var(--accent-blue) 34%, transparent);
}
.lib-row.is-transient .lib-name {
  font-style:italic;
  opacity:0.7;
}
.lib-row.is-folder-drop-target {
  outline: 2px dashed color-mix(in srgb, var(--accent-blue) 60%, transparent);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent-blue) 16%, transparent);
}
.lib-row[draggable="true"] { cursor:grab; }
.lib-row[draggable="true"]:active { cursor:grabbing; }
.lib-icon { font-size:0.85rem; flex-shrink:0; display:flex; align-items:center; gap:4px; cursor:pointer; }
.lib-text { flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; }
.lib-name { font-size:0.76rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; font-weight:600; }
.is-managed .lib-name { color:var(--accent-blue); }
.lib-time-pill {
  font-size:0.72rem;
  line-height:1;
  padding:5px 8px;
  border-radius:999px;
  background:color-mix(in srgb, var(--accent-red) 12%, var(--bg-secondary));
  border:1px solid color-mix(in srgb, var(--accent-red) 26%, transparent);
  color:var(--text-primary);
  font-variant-numeric:tabular-nums;
  font-family:'Courier New', monospace;
  font-weight:700;
  letter-spacing:0.04em;
  flex-shrink:0;
}

/* Debug menu */
.debug-menu-wrap { position:relative; }
.debug-menu {
  position:absolute;
  right:0;
  top:calc(100% + 6px);
  min-width:190px;
  display:flex;
  flex-direction:column;
  padding:6px;
  gap:4px;
  background:color-mix(in srgb, var(--bg-secondary) 96%, transparent);
  border:1px solid var(--glass-border);
  border-radius:8px;
  box-shadow:0 8px 24px rgba(0,0,0,0.35);
  z-index:20;
}
.debug-menu-item {
  background:transparent;
  border:none;
  color:var(--text-primary);
  text-align:left;
  padding:8px 10px;
  border-radius:6px;
  cursor:pointer;
  font-size:0.78rem;
}
.debug-menu-item:hover:not(:disabled) {
  background:color-mix(in srgb, var(--accent-blue) 10%, transparent);
}
.debug-menu-item:disabled {
  opacity:0.45;
  cursor:not-allowed;
}



@media (max-width: 1280px) {
  .lib-toolbar {
    flex-wrap: wrap;
  }
  .toolbar-spacer { display:none; }
}

.lib-name-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.mcr-badges {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mcr-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.62rem;
  font-weight: 800;
  padding: 1px 4px;
  border-radius: 3px;
  line-height: 1;
  text-transform: uppercase;
}

.badge-age.age-k { background: #2ecc71; color: #fff; }
.badge-age.age-8 { background: #f1c40f; color: #000; }
.badge-age.age-12 { background: #e67e22; color: #fff; }
.badge-age.age-16 { background: #d35400; color: #fff; }
.badge-age.age-18 { background: #c0392b; color: #fff; }

.badge-tp {
  background: #e74c3c;
  color: #fff;
  border: 1px solid #c0392b;
}

.badge-content.content-movie { background: #3498db; color: #fff; }
.badge-content.content-show { background: #9b59b6; color: #fff; }
.badge-content.content-documentary { background: #f39c12; color: #000; }
.badge-content.content-news { background: #1abc9c; color: #fff; }

.chevron-icon {
  font-size: 0.55rem;
  color: var(--text-secondary);
  width: 12px;
  height: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  transition: transform 0.15s ease, color 0.15s ease;
  margin-right: 4px;
}
.chevron-icon.is-expanded {
  transform: rotate(90deg);
  color: var(--text-primary);
}
.chevron-icon:hover {
  color: var(--text-primary);
}
.chevron-spacer {
  width: 16px;
  height: 12px;
  flex-shrink: 0;
}
.folder-svg {
  width: 14px;
  height: 14px;
  display: block;
  transition: fill 0.15s ease;
}

.folder-colors-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  padding: 6px 12px;
}
.folder-color-tag {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: bold;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.15);
  transition: transform 0.1s, border-color 0.1s;
}
.folder-color-tag:hover {
  transform: scale(1.15);
  border-color: rgba(255, 255, 255, 0.4);
}
.folder-color-tag.color-reset {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border-color: var(--glass-border);
}
.folder-color-tag.color-reset:hover {
  color: var(--text-primary);
}
.color-check {
  text-shadow: 0 1px 2px rgba(0,0,0,0.6);
}
</style>
