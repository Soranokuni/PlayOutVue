import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { refDebounced } from '@vueuse/core';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useRundownStore, parseBroadcastRating, serializeBroadcastRating, getMetadataFromAssetResponse } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';
import { useMediaDefaultsStore } from '../stores/mediaDefaults';
import { useIngestorStatusStore } from '../stores/ingestorStatus';
import { useMediaLibraryStore } from '../stores/mediaLibrary';
import { draggingItem } from '../composables/useDragState';
import TrimPanel from './TrimPanel.vue';
import ContextMenu from './ContextMenu.vue';
const store = useRundownStore();
const settings = useSettingsStore();
const mediaDefaults = useMediaDefaultsStore();
const mediaLibrary = useMediaLibraryStore();
const ingestorStatus = useIngestorStatusStore();
const showTrimPanel = ref(false);
const trimAsset = ref(null);
const isScanning = ref(false);
const isWarmingCatalog = ref(false);
const libraryQuery = ref('');
const showDebugMenu = ref(false);
const showDebugPanel = ref(false);
const diagnosticEntries = ref([]);
const ROW_HEIGHT = 34;
const libTreeRef = ref(null);
const contextMenu = ref({
    show: false, x: 0, y: 0, node: null
});
const debouncedLibraryQuery = refDebounced(libraryQuery, 120);
let scheduledWarmupTimer = null;
let periodicWarmupTimer = null;
const createDefaultProbeStatus = () => ({
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
const probeStatus = ref(createDefaultProbeStatus());
const expandedFolders = ref({});
function getFolderName(path) {
    if (path === '/')
        return 'All Media';
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'Unknown';
}
const folderGroups = computed(() => {
    const query = mediaLibrary.searchQuery.trim().toLowerCase();
    const groups = {};
    groups['/'] = [];
    for (const asset of mediaLibrary.assets) {
        if (mediaLibrary.deletedUuids.includes(asset.uuid))
            continue;
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
        const sortedAssets = [...(groups[folderPath] || [])].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
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
const visibleFileCount = computed(() => mediaLibrary.assets.filter((a) => !mediaLibrary.deletedUuids.includes(a.uuid)).length);
const formatDuration = (seconds) => {
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
function logIngestor(scope, message, level = 'warn') {
    ingestorStatus.log(scope, message, level);
}
async function ingestorInvoke(cmd, args, scope) {
    try {
        return await invoke(cmd, args);
    }
    catch (error) {
        logIngestor(scope, `${error}`, 'error');
        return null;
    }
}
function mapApiRating(rating) {
    const lower = (rating || '').toLowerCase();
    if (['k', '8', '12', '16', '18'].includes(lower)) {
        return lower;
    }
    return 'none';
}
function normalizeVirtualFolder(value) {
    if (!value)
        return '/';
    const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized === '')
        return '/';
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}
function libraryAssetFromApi(asset) {
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
        mezzanine_ok: asset.mezzanine_ok,
        fps: asset.fps,
        total_frames: asset.total_frames,
        gop_frames: asset.gop_frames,
        keyframe_safe_start_ms: asset.keyframe_safe_start_ms,
        warnings: asset.warnings,
    };
}
async function fetchAssetsFromApi() {
    const response = await ingestorInvoke('list_ingestor_assets', { apiBaseUrlOverride: null }, 'ingestor-list');
    if (!response)
        return null;
    return response.map(libraryAssetFromApi);
}
async function fetchAssetsFromLocalFallback() {
    const root = (settings.localMediaPath || '').trim();
    if (!root)
        return [];
    try {
        const files = await invoke('scan_directory', { path: root });
        return files
            .filter((f) => f.entry_kind === 'file')
            .map((f) => ({
            uuid: f.playoutvue_id || `local:${f.path}`,
            current_path: f.path,
            display_name: f.display_name || f.filename,
            virtual_folder: normalizeVirtualFolder(f.virtual_folder ? `/Unmanaged/${f.virtual_folder}` : '/Unmanaged'),
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
    }
    catch (error) {
        logIngestor('ingestor-list', `Local fallback scan failed: ${error}`, 'error');
        return [];
    }
}
async function fetchAssets(options = {}) {
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
        }
        else {
            ingestorStatus.setOnline(false);
            if (!ingestorStatus.lastSeenAt) {
                logIngestor('ingestor-list', 'Ingestor API is unreachable; falling back to local directory scan.', 'warn');
            }
        }
        // Fallback when offline or during forced refresh
        if (!ingestorStatus.isIngestorOnline) {
            const fallbackAssets = await fetchAssetsFromLocalFallback();
            const merged = mergeAssets(mediaLibrary.assets, fallbackAssets);
            mediaLibrary.setAssets(merged);
        }
    }
    finally {
        isScanning.value = false;
    }
}
function mergeAssets(existing, fallback) {
    const byUuid = new Map(existing.map((a) => [a.uuid, a]));
    for (const asset of fallback) {
        if (!byUuid.has(asset.uuid)) {
            byUuid.set(asset.uuid, asset);
        }
    }
    return Array.from(byUuid.values());
}
function assetDurationSeconds(asset) {
    return asset && asset.duration_ms > 0 ? asset.duration_ms / 1000 : 0;
}
function effectiveDurationSeconds(asset) {
    if (!asset || asset.duration_ms <= 0)
        return 0;
    const outPoint = (asset.trim_out_ms && asset.trim_out_ms > 0)
        ? asset.trim_out_ms
        : asset.duration_ms;
    const inPoint = asset.trim_in_ms || 0;
    const effectiveMs = outPoint - inPoint;
    return Math.max(0, effectiveMs) / 1000;
}
function makeRundownDraftFromAsset(asset) {
    const nameLower = (asset.display_name || '').toLowerCase();
    const ratingLower = (asset.rating || '').toLowerCase();
    const isSubclip = nameLower.includes('sub-clip') || nameLower.includes('subclip') || ratingLower.includes('subclip');
    let duration = assetDurationSeconds(asset);
    let effective = effectiveDurationSeconds(asset);
    let inPoint = asset.trim_in_ms || 0;
    let outPoint = (asset.trim_out_ms && asset.trim_out_ms > 0)
        ? asset.trim_out_ms
        : (asset.duration_ms || 0);
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
        type: 'video',
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
        mezzanine_ok: asset.mezzanine_ok,
        fps: asset.fps,
        total_frames: asset.total_frames,
        gop_frames: asset.gop_frames,
        keyframe_safe_start_ms: asset.keyframe_safe_start_ms,
        warnings: asset.warnings,
    };
}
async function addSelectedAssetToRundown() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset)
        return;
    store.addItem(makeRundownDraftFromAsset(asset));
}
const FOLDER_DRAG_MIME = 'application/x-playout-folder';
const folderDropTargetId = ref(null);
function onFolderClick(folderPath) {
    mediaLibrary.selectedNodeId = `folder:${folderPath}`;
    mediaLibrary.currentFolderPath = folderPath;
}
function onFolderDoubleClick(folderPath) {
    expandedFolders.value[folderPath] = !expandedFolders.value[folderPath];
}
function onAssetClick(asset) {
    mediaLibrary.selectedNodeId = `asset:${asset.uuid}`;
}
function onAssetDoubleClick(asset) {
    store.addItem(makeRundownDraftFromAsset(asset));
}
function onAssetDragStart(event, asset) {
    mediaLibrary.selectedNodeId = `asset:${asset.uuid}`;
    const meta = parseBroadcastRating(asset.rating);
    const payload = {
        playoutvueId: asset.uuid.startsWith('local:') ? undefined : asset.uuid,
        filename: asset.display_name,
        path: asset.current_path,
        shortPath: '',
        type: 'video',
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
function onFolderDragStart(event, folderPath) {
    mediaLibrary.selectedNodeId = `folder:${folderPath}`;
    if (event.dataTransfer) {
        event.dataTransfer.setData(FOLDER_DRAG_MIME, folderPath);
        event.dataTransfer.setData('text/plain', folderPath);
        event.dataTransfer.effectAllowed = 'move';
    }
}
function onAssetContextMenu(event, asset) {
    const node = {
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
function onFolderContextMenu(event, folderPath) {
    const node = {
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
    if (!name)
        return;
    mediaLibrary.createVirtualFolder(name);
    closeContextMenu();
}
function doRenameFolder() {
    const node = contextMenu.value.node;
    if (!node || node.type !== 'folder')
        return;
    const oldPath = node.virtualFolder;
    const currentName = oldPath.split('/').pop() || '';
    const newName = window.prompt(`Rename folder "${currentName}" to:`, currentName);
    if (!newName)
        return;
    mediaLibrary.renameTransientFolder(oldPath, newName);
    closeContextMenu();
}
function doRemoveFolder() {
    const node = contextMenu.value.node;
    if (!node || node.type !== 'folder')
        return;
    mediaLibrary.removeTransientFolder(node.virtualFolder);
    closeContextMenu();
}
async function doRenameSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset)
        return;
    const newName = window.prompt('Rename asset', asset.display_name);
    if (!newName || newName === asset.display_name)
        return;
    const result = await ingestorInvoke('rename_ingestor_asset', { uuid: asset.uuid, display_name: newName, apiBaseUrlOverride: null }, 'ingestor-rename');
    if (result === null)
        return;
    mediaLibrary.renameAsset(asset.uuid, newName);
}
async function doMoveSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset)
        return;
    const current = mediaLibrary.currentFolderPath || '/';
    const target = window.prompt('Move to virtual folder', current);
    if (target === null)
        return;
    const normalized = normalizeVirtualFolder(target);
    if (asset.uuid.startsWith('local:')) {
        mediaLibrary.moveAssetToFolder(asset.uuid, normalized);
    }
    else {
        const result = await ingestorInvoke('move_ingestor_asset', { uuid: asset.uuid, virtual_folder: normalized, api_base_url_override: null }, 'ingestor-move');
        if (result === null)
            return;
        // Keep the local virtual_folder as source of truth; do NOT force-refresh
        // from the API here, which previously discarded in-flight local overrides
        // and made the asset "jump back" (plan §3.2 desync fix). The local
        // override is re-applied on every setAssets() via localVirtualFolders.
        mediaLibrary.moveAssetToFolder(asset.uuid, normalized);
    }
}
function doDeleteSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset)
        return;
    doDeleteAsset(asset.uuid);
}
function doDeleteAsset(uuid) {
    if (uuid.startsWith('local:')) {
        // Local fallback assets can be hidden immediately.
        mediaLibrary.deleteAsset(uuid);
        return;
    }
    // Ingestor-managed delete is client-side only until API support arrives.
    if (!window.confirm('Hide this asset from the library?\n(The Ingestor API does not yet support deletion.) '))
        return;
    mediaLibrary.deleteAsset(uuid);
}
async function doPurgeAsset(asset) {
    if (asset.uuid.startsWith('local:')) {
        window.alert("Cannot purge local fallback assets.");
        return;
    }
    const confirmed = window.confirm(`WARNING: Are you absolutely sure you want to permanently delete and purge "${asset.display_name}"?\n\nThis will:\n1. Permanently DELETE the physical file on disk.\n2. Delete all database records and virtual sub-clips matching this asset's file path or fingerprint.\n\nTHIS ACTION CANNOT BE UNDONE!`);
    if (!confirmed)
        return;
    try {
        await invoke('purge_ingestor_asset', {
            uuid: asset.uuid,
            apiBaseUrlOverride: null
        });
        mediaLibrary.deleteAsset(asset.uuid);
        await fetchAssets({ force: true });
    }
    catch (error) {
        window.alert(`Failed to purge asset: ${error}`);
    }
}
function openTrimPanelForSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset)
        return;
    trimAsset.value = asset;
    showTrimPanel.value = true;
}
const handleTrimSaved = async ({ uuid }) => {
    if (!uuid)
        return;
    // Refresh the changed asset from the API in the background.
    const response = await ingestorInvoke('resolve_ingestor_asset', { uuid, apiBaseUrlOverride: null }, 'ingestor-resolve');
    if (response) {
        mediaLibrary.updateAsset(uuid, libraryAssetFromApi(response));
    }
};
// --- Legacy local-file debug/probe panel (kept separate from client diagnostics) ---
const refreshProbeStatus = async () => {
    try {
        const status = await invoke('get_media_probe_status');
        probeStatus.value = status;
    }
    catch (error) {
        console.warn('[Library] Failed to refresh probe status', error);
    }
};
const refreshDiagnostics = async () => {
    if (!settings.debugMode)
        return;
    try {
        diagnosticEntries.value = await invoke('get_diagnostic_logs', { limit: 80 });
    }
    catch (error) {
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
    if (!mediaPath)
        return;
    if (probeStatus.value.running) {
        await refreshProbeStatus();
        return;
    }
    try {
        const status = await invoke('start_media_probe', { path: mediaPath });
        probeStatus.value = status;
        if (settings.debugMode && showDebugPanel.value) {
            await refreshDiagnostics();
        }
    }
    catch (error) {
        console.warn('[Library] Media cache warm-up failed', error);
        await refreshProbeStatus();
    }
};
const scheduleLibraryWarmup = (delayMs = 1400) => {
    clearScheduledWarmup();
    const mediaPath = (settings.localMediaPath || '').trim();
    if (!mediaPath || probeStatus.value.running || mediaLibrary.assets.length === 0)
        return;
    scheduledWarmupTimer = setTimeout(() => {
        scheduledWarmupTimer = null;
        startBackgroundProbe('scheduled').catch(() => { });
    }, delayMs);
};
const clearScheduledWarmup = () => {
    if (!scheduledWarmupTimer)
        return;
    clearTimeout(scheduledWarmupTimer);
    scheduledWarmupTimer = null;
};
const clearDiagnostics = async () => {
    try {
        await invoke('clear_diagnostic_logs');
        diagnosticEntries.value = [];
        await refreshDiagnostics();
    }
    catch (error) {
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
        if (!outputPath || Array.isArray(outputPath))
            return;
        await invoke('export_diagnostic_logs', { outputPath });
    }
    catch (error) {
        console.warn('[Library] Failed to export diagnostics', error);
    }
};
const probeProgressLabel = computed(() => {
    if (!probeStatus.value.running)
        return '';
    if (probeStatus.value.totalCandidates > 0) {
        return `probing ${probeStatus.value.checked}/${probeStatus.value.totalCandidates}`;
    }
    return 'probing…';
});
const formatDiagnosticTime = (timestampMs) => {
    if (!timestampMs)
        return '--:--:--';
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
    }
    else {
        refreshDebugPanel().catch(() => { });
    }
});
watch(probeProgressLabel, () => { }, { immediate: true });
onMounted(() => {
    refreshProbeStatus().catch(() => { });
    fetchAssets();
    if (settings.debugMode)
        refreshDebugPanel().catch(() => { });
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
function onFolderDragOverPath(event, folderPath) {
    event.preventDefault();
    folderDropTargetId.value = `folder:${folderPath}`;
    if (event.dataTransfer) {
        const isFolderDrag = event.dataTransfer.types.includes(FOLDER_DRAG_MIME);
        event.dataTransfer.dropEffect = isFolderDrag ? 'move' : 'copy';
    }
}
async function onFolderDropPath(event, folderPath) {
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
        const result = await ingestorInvoke('move_ingestor_asset', { uuid: uuid, virtual_folder: folderPath, api_base_url_override: null }, 'ingestor-move');
        if (result !== null) {
            mediaLibrary.moveAssetToFolder(uuid, folderPath);
        }
    }
    else {
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
];
const contentTypeOptions = [
    { id: 'none', label: 'None' },
    { id: 'movie', label: 'Movie' },
    { id: 'show', label: 'Show' },
    { id: 'documentary', label: 'Documentary' },
    { id: 'news', label: 'News' }
];
async function ctxSetAgeRating(rating) {
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
async function ctxSetContentType(cType) {
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
async function ctxSetFolderColor(color) {
    const node = contextMenu.value.node;
    if (node && node.type === 'folder') {
        await mediaLibrary.setFolderColor(node.virtualFolder, color);
    }
    closeContextMenu();
}
const topActionItems = computed(() => {
    const node = contextMenu.value.node;
    if (!node || node.type !== 'asset' || !node.asset)
        return [];
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
const menuItems = computed(() => {
    const node = contextMenu.value.node;
    if (!node)
        return [];
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
    }
    else if (node.type === 'folder') {
        const folderItems = [
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
                    type: 'action',
                    label: c.label,
                    checked: node.color === c.hex,
                    action: () => ctxSetFolderColor(c.hex)
                })),
                { type: 'divider' },
                {
                    type: 'action',
                    label: 'Reset Color',
                    checked: !node.color,
                    action: () => ctxSetFolderColor('')
                }
            ]
        });
        return folderItems;
    }
    return [];
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['debug-entry']} */ ;
/** @type {__VLS_StyleScopedClasses['debug-level']} */ ;
/** @type {__VLS_StyleScopedClasses['debug-level']} */ ;
/** @type {__VLS_StyleScopedClasses['debug-level']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-row']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-row']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-row']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-row']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-row']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-row']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-name']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-name']} */ ;
/** @type {__VLS_StyleScopedClasses['debug-menu-item']} */ ;
/** @type {__VLS_StyleScopedClasses['debug-menu-item']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-spacer']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-age']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-age']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-age']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-age']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-content']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-content']} */ ;
/** @type {__VLS_StyleScopedClasses['badge-content']} */ ;
/** @type {__VLS_StyleScopedClasses['chevron-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['chevron-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['folder-color-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['folder-color-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['folder-color-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['color-reset']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "lib-wrap" },
});
/** @type {__VLS_StyleScopedClasses['lib-wrap']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "lib-header" },
});
/** @type {__VLS_StyleScopedClasses['lib-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "lib-header-copy" },
});
/** @type {__VLS_StyleScopedClasses['lib-header-copy']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "text-accent lib-title" },
});
/** @type {__VLS_StyleScopedClasses['text-accent']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-title']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "lib-subtitle" },
});
/** @type {__VLS_StyleScopedClasses['lib-subtitle']} */ ;
(__VLS_ctx.visibleFileCount);
(__VLS_ctx.visibleFileCount === 1 ? 'asset' : 'assets');
if (__VLS_ctx.totalLibraryDuration) {
    (__VLS_ctx.totalLibraryDuration);
}
if (__VLS_ctx.probeProgressLabel) {
    (__VLS_ctx.probeProgressLabel);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "lib-header-actions" },
});
/** @type {__VLS_StyleScopedClasses['lib-header-actions']} */ ;
if (__VLS_ctx.settings.debugMode) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "debug-menu-wrap" },
    });
    /** @type {__VLS_StyleScopedClasses['debug-menu-wrap']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.settings.debugMode))
                    throw 0;
                return (__VLS_ctx.showDebugMenu = !__VLS_ctx.showDebugMenu);
                // @ts-ignore
                [visibleFileCount, visibleFileCount, totalLibraryDuration, totalLibraryDuration, probeProgressLabel, probeProgressLabel, settings, showDebugMenu, showDebugMenu,];
            } },
        ...{ class: "icon-action" },
        title: (__VLS_ctx.showDebugMenu ? 'Close debug menu' : 'Open debug menu'),
    });
    /** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
    if (__VLS_ctx.showDebugMenu) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "debug-menu" },
        });
        /** @type {__VLS_StyleScopedClasses['debug-menu']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.settings.debugMode))
                        throw 0;
                    if (!(__VLS_ctx.showDebugMenu))
                        throw 0;
                    __VLS_ctx.startBackgroundProbe('manual');
                    __VLS_ctx.showDebugMenu = false;
                    // @ts-ignore
                    [showDebugMenu, showDebugMenu, showDebugMenu, startBackgroundProbe,];
                } },
            ...{ class: "debug-menu-item" },
            disabled: (__VLS_ctx.isWarmingCatalog),
        });
        /** @type {__VLS_StyleScopedClasses['debug-menu-item']} */ ;
        (__VLS_ctx.isWarmingCatalog ? 'Background probe running…' : 'Start background probe');
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.settings.debugMode))
                        throw 0;
                    if (!(__VLS_ctx.showDebugMenu))
                        throw 0;
                    __VLS_ctx.refreshDebugPanel();
                    __VLS_ctx.showDebugPanel = true;
                    __VLS_ctx.showDebugMenu = false;
                    // @ts-ignore
                    [showDebugMenu, isWarmingCatalog, isWarmingCatalog, refreshDebugPanel, showDebugPanel,];
                } },
            ...{ class: "debug-menu-item" },
        });
        /** @type {__VLS_StyleScopedClasses['debug-menu-item']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.settings.debugMode))
                        throw 0;
                    if (!(__VLS_ctx.showDebugMenu))
                        throw 0;
                    __VLS_ctx.exportDiagnostics();
                    __VLS_ctx.showDebugMenu = false;
                    // @ts-ignore
                    [showDebugMenu, exportDiagnostics,];
                } },
            ...{ class: "debug-menu-item" },
            disabled: (!__VLS_ctx.diagnosticEntries.length),
        });
        /** @type {__VLS_StyleScopedClasses['debug-menu-item']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.settings.debugMode))
                        throw 0;
                    if (!(__VLS_ctx.showDebugMenu))
                        throw 0;
                    __VLS_ctx.clearDiagnostics();
                    __VLS_ctx.showDebugMenu = false;
                    // @ts-ignore
                    [showDebugMenu, diagnosticEntries, clearDiagnostics,];
                } },
            ...{ class: "debug-menu-item" },
            disabled: (!__VLS_ctx.diagnosticEntries.length),
        });
        /** @type {__VLS_StyleScopedClasses['debug-menu-item']} */ ;
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.fetchAssets({ force: true }));
            // @ts-ignore
            [diagnosticEntries, fetchAssets,];
        } },
    ...{ class: "icon-action" },
    disabled: (__VLS_ctx.isScanning),
    title: (__VLS_ctx.isScanning ? 'Refreshing…' : 'Refresh from Ingestor'),
});
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
(__VLS_ctx.isScanning ? '⌛' : '↻');
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "lib-toolbar" },
});
/** @type {__VLS_StyleScopedClasses['lib-toolbar']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
    ...{ class: "glass-input lib-search" },
    type: "search",
    placeholder: "Search assets…",
});
(__VLS_ctx.libraryQuery);
/** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
/** @type {__VLS_StyleScopedClasses['lib-search']} */ ;
if (__VLS_ctx.libraryQuery) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.libraryQuery))
                    throw 0;
                return (__VLS_ctx.libraryQuery = '');
                // @ts-ignore
                [isScanning, isScanning, isScanning, libraryQuery, libraryQuery, libraryQuery,];
            } },
        ...{ class: "icon-action" },
        title: "Clear search",
    });
    /** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div)({
    ...{ class: "toolbar-spacer" },
});
/** @type {__VLS_StyleScopedClasses['toolbar-spacer']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.doNewVirtualFolder) },
    ...{ class: "icon-action" },
    title: "New virtual folder in current folder",
    disabled: (!__VLS_ctx.mediaLibrary.currentFolderPath),
});
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.doRenameSelected) },
    ...{ class: "icon-action" },
    title: "Rename selected asset",
    disabled: (!__VLS_ctx.mediaLibrary.selectedAsset),
});
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.doMoveSelected) },
    ...{ class: "icon-action" },
    title: "Move selected asset",
    disabled: (!__VLS_ctx.mediaLibrary.selectedAsset),
});
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.doDeleteSelected) },
    ...{ class: "icon-action" },
    title: "Hide selected asset",
    disabled: (!__VLS_ctx.mediaLibrary.selectedAsset),
});
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
if (__VLS_ctx.settings.debugMode && __VLS_ctx.showDebugPanel) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "lib-debug-panel" },
    });
    /** @type {__VLS_StyleScopedClasses['lib-debug-panel']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "debug-toolbar" },
    });
    /** @type {__VLS_StyleScopedClasses['debug-toolbar']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "debug-summary" },
    });
    /** @type {__VLS_StyleScopedClasses['debug-summary']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
    (__VLS_ctx.probeStatus.running ? 'Background probe active' : 'Background probe idle');
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    (__VLS_ctx.probeStatus.checked);
    (__VLS_ctx.probeStatus.updated);
    (__VLS_ctx.probeStatus.skipped);
    if (__VLS_ctx.probeStatus.totalCandidates) {
        (__VLS_ctx.probeStatus.totalCandidates);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "debug-actions" },
    });
    /** @type {__VLS_StyleScopedClasses['debug-actions']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.refreshDebugPanel) },
        ...{ class: "icon-action" },
    });
    /** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.exportDiagnostics) },
        ...{ class: "icon-action" },
        disabled: (!__VLS_ctx.diagnosticEntries.length),
    });
    /** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.clearDiagnostics) },
        ...{ class: "icon-action" },
        disabled: (!__VLS_ctx.diagnosticEntries.length),
    });
    /** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.settings.debugMode && __VLS_ctx.showDebugPanel))
                    throw 0;
                return (__VLS_ctx.showDebugPanel = false);
                // @ts-ignore
                [settings, refreshDebugPanel, showDebugPanel, showDebugPanel, exportDiagnostics, diagnosticEntries, diagnosticEntries, clearDiagnostics, doNewVirtualFolder, mediaLibrary, mediaLibrary, mediaLibrary, mediaLibrary, doRenameSelected, doMoveSelected, doDeleteSelected, probeStatus, probeStatus, probeStatus, probeStatus, probeStatus, probeStatus,];
            } },
        ...{ class: "icon-action" },
    });
    /** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "debug-meta" },
    });
    /** @type {__VLS_StyleScopedClasses['debug-meta']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    (__VLS_ctx.probeStatus.ffprobePath || 'not resolved yet');
    if (__VLS_ctx.probeStatus.currentFile) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
        (__VLS_ctx.probeStatus.currentFile);
    }
    else if (__VLS_ctx.probeStatus.rootPath) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
        (__VLS_ctx.probeStatus.rootPath);
    }
    if (__VLS_ctx.probeStatus.lastError) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "debug-error" },
        });
        /** @type {__VLS_StyleScopedClasses['debug-error']} */ ;
        (__VLS_ctx.probeStatus.lastError);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "debug-log custom-scroll" },
    });
    /** @type {__VLS_StyleScopedClasses['debug-log']} */ ;
    /** @type {__VLS_StyleScopedClasses['custom-scroll']} */ ;
    if (!__VLS_ctx.diagnosticEntries.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "debug-empty" },
        });
        /** @type {__VLS_StyleScopedClasses['debug-empty']} */ ;
    }
    for (const [entry, index] of __VLS_vFor((__VLS_ctx.diagnosticEntries))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (`${entry.timestampMs}-${entry.scope}-${index}`),
            ...{ class: "debug-entry" },
            ...{ class: (`level-${entry.level}`) },
        });
        /** @type {__VLS_StyleScopedClasses['debug-entry']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "debug-time" },
        });
        /** @type {__VLS_StyleScopedClasses['debug-time']} */ ;
        (__VLS_ctx.formatDiagnosticTime(entry.timestampMs));
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "debug-level" },
        });
        /** @type {__VLS_StyleScopedClasses['debug-level']} */ ;
        (entry.level.toUpperCase());
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "debug-scope" },
        });
        /** @type {__VLS_StyleScopedClasses['debug-scope']} */ ;
        (entry.scope);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "debug-message" },
        });
        /** @type {__VLS_StyleScopedClasses['debug-message']} */ ;
        (entry.message);
        // @ts-ignore
        [diagnosticEntries, diagnosticEntries, probeStatus, probeStatus, probeStatus, probeStatus, probeStatus, probeStatus, probeStatus, formatDiagnosticTime,];
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onContextmenu: () => { } },
    ref: "libTreeRef",
    ...{ class: "lib-tree custom-scroll" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['lib-tree']} */ ;
/** @type {__VLS_StyleScopedClasses['custom-scroll']} */ ;
if (__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "lib-empty" },
    });
    /** @type {__VLS_StyleScopedClasses['lib-empty']} */ ;
}
else if (__VLS_ctx.folderGroups.length === 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "lib-empty" },
    });
    /** @type {__VLS_StyleScopedClasses['lib-empty']} */ ;
    (__VLS_ctx.libraryQuery ? 'No matching assets found.' : '📂 No media found.\nSet the Ingestor API or media folder in ⚙️ Settings.');
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "lib-tree-content" },
    });
    /** @type {__VLS_StyleScopedClasses['lib-tree-content']} */ ;
    for (const [group] of __VLS_vFor((__VLS_ctx.folderGroups))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (group.folderName),
            ...{ class: "folder-group" },
        });
        /** @type {__VLS_StyleScopedClasses['folder-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                        throw 0;
                    if (!!(__VLS_ctx.folderGroups.length === 0))
                        throw 0;
                    return (__VLS_ctx.onFolderClick(group.folderName));
                    // @ts-ignore
                    [isScanning, libraryQuery, folderGroups, folderGroups, folderGroups, onFolderClick,];
                } },
            ...{ onDblclick: (...[$event]) => {
                    if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                        throw 0;
                    if (!!(__VLS_ctx.folderGroups.length === 0))
                        throw 0;
                    return (__VLS_ctx.onFolderDoubleClick(group.folderName));
                    // @ts-ignore
                    [onFolderDoubleClick,];
                } },
            ...{ onContextmenu: (...[$event]) => {
                    if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                        throw 0;
                    if (!!(__VLS_ctx.folderGroups.length === 0))
                        throw 0;
                    return (__VLS_ctx.onFolderContextMenu($event, group.folderName));
                    // @ts-ignore
                    [onFolderContextMenu,];
                } },
            ...{ onDragstart: (...[$event]) => {
                    if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                        throw 0;
                    if (!!(__VLS_ctx.folderGroups.length === 0))
                        throw 0;
                    return (__VLS_ctx.onFolderDragStart($event, group.folderName));
                    // @ts-ignore
                    [onFolderDragStart,];
                } },
            ...{ onDragend: (...[$event]) => {
                    if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                        throw 0;
                    if (!!(__VLS_ctx.folderGroups.length === 0))
                        throw 0;
                    return (__VLS_ctx.folderDropTargetId = null);
                    // @ts-ignore
                    [folderDropTargetId,];
                } },
            ...{ onDragover: (...[$event]) => {
                    if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                        throw 0;
                    if (!!(__VLS_ctx.folderGroups.length === 0))
                        throw 0;
                    return (__VLS_ctx.onFolderDragOverPath($event, group.folderName));
                    // @ts-ignore
                    [onFolderDragOverPath,];
                } },
            ...{ onDrop: (...[$event]) => {
                    if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                        throw 0;
                    if (!!(__VLS_ctx.folderGroups.length === 0))
                        throw 0;
                    return (__VLS_ctx.onFolderDropPath($event, group.folderName));
                    // @ts-ignore
                    [onFolderDropPath,];
                } },
            ...{ class: "lib-row is-folder" },
            ...{ class: ({
                    'is-selected': __VLS_ctx.mediaLibrary.selectedNodeId === `folder:${group.folderName}`,
                    'is-folder-drop-target': __VLS_ctx.folderDropTargetId === `folder:${group.folderName}`
                }) },
            draggable: (true),
        });
        /** @type {__VLS_StyleScopedClasses['lib-row']} */ ;
        /** @type {__VLS_StyleScopedClasses['is-folder']} */ ;
        /** @type {__VLS_StyleScopedClasses['is-selected']} */ ;
        /** @type {__VLS_StyleScopedClasses['is-folder-drop-target']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                        throw 0;
                    if (!!(__VLS_ctx.folderGroups.length === 0))
                        throw 0;
                    return (__VLS_ctx.expandedFolders[group.folderName] = !__VLS_ctx.expandedFolders[group.folderName]);
                    // @ts-ignore
                    [mediaLibrary, folderDropTargetId, expandedFolders, expandedFolders,];
                } },
            ...{ class: "chevron-icon" },
            ...{ class: ({ 'is-expanded': __VLS_ctx.expandedFolders[group.folderName] }) },
        });
        /** @type {__VLS_StyleScopedClasses['chevron-icon']} */ ;
        /** @type {__VLS_StyleScopedClasses['is-expanded']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                        throw 0;
                    if (!!(__VLS_ctx.folderGroups.length === 0))
                        throw 0;
                    return (__VLS_ctx.onFolderClick(group.folderName));
                    // @ts-ignore
                    [onFolderClick, expandedFolders,];
                } },
            ...{ class: "lib-icon" },
        });
        /** @type {__VLS_StyleScopedClasses['lib-icon']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            ...{ class: "folder-svg" },
            viewBox: "0 0 24 24",
            ...{ style: ({ fill: __VLS_ctx.mediaLibrary.folderColors[group.folderName] || 'var(--accent-blue)' }) },
        });
        /** @type {__VLS_StyleScopedClasses['folder-svg']} */ ;
        if (__VLS_ctx.expandedFolders[group.folderName]) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M19 5.5h-7.28l-2-2H4c-1.1 0-2 .9-2 2v13c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-11c0-1.1-.9-2-2-2zm0 13H4v-11h16v11z",
            });
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
            });
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "lib-text" },
        });
        /** @type {__VLS_StyleScopedClasses['lib-text']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "lib-name" },
        });
        /** @type {__VLS_StyleScopedClasses['lib-name']} */ ;
        (__VLS_ctx.getFolderName(group.folderName));
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "folder-children" },
            ...{ style: {} },
        });
        __VLS_asFunctionalDirective(__VLS_directives.vShow, {})(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.expandedFolders[group.folderName]) }, null, null);
        /** @type {__VLS_StyleScopedClasses['folder-children']} */ ;
        for (const [asset] of __VLS_vFor((group.assets))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                            throw 0;
                        if (!!(__VLS_ctx.folderGroups.length === 0))
                            throw 0;
                        return (__VLS_ctx.onAssetClick(asset));
                        // @ts-ignore
                        [mediaLibrary, expandedFolders, expandedFolders, getFolderName, onAssetClick,];
                    } },
                ...{ onDblclick: (...[$event]) => {
                        if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                            throw 0;
                        if (!!(__VLS_ctx.folderGroups.length === 0))
                            throw 0;
                        return (__VLS_ctx.onAssetDoubleClick(asset));
                        // @ts-ignore
                        [onAssetDoubleClick,];
                    } },
                ...{ onContextmenu: (...[$event]) => {
                        if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                            throw 0;
                        if (!!(__VLS_ctx.folderGroups.length === 0))
                            throw 0;
                        return (__VLS_ctx.onAssetContextMenu($event, asset));
                        // @ts-ignore
                        [onAssetContextMenu,];
                    } },
                ...{ onDragstart: (...[$event]) => {
                        if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                            throw 0;
                        if (!!(__VLS_ctx.folderGroups.length === 0))
                            throw 0;
                        return (__VLS_ctx.onAssetDragStart($event, asset));
                        // @ts-ignore
                        [onAssetDragStart,];
                    } },
                key: (asset.uuid),
                ...{ class: "lib-row is-asset" },
                ...{ class: ({
                        'is-selected': __VLS_ctx.mediaLibrary.selectedNodeId === `asset:${asset.uuid}`
                    }) },
                draggable: (true),
                ...{ style: ({ paddingLeft: '26px' }) },
            });
            /** @type {__VLS_StyleScopedClasses['lib-row']} */ ;
            /** @type {__VLS_StyleScopedClasses['is-asset']} */ ;
            /** @type {__VLS_StyleScopedClasses['is-selected']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "chevron-spacer" },
            });
            /** @type {__VLS_StyleScopedClasses['chevron-spacer']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.isScanning && !__VLS_ctx.folderGroups.length))
                            throw 0;
                        if (!!(__VLS_ctx.folderGroups.length === 0))
                            throw 0;
                        return (__VLS_ctx.onAssetClick(asset));
                        // @ts-ignore
                        [mediaLibrary, onAssetClick,];
                    } },
                ...{ class: "lib-icon" },
            });
            /** @type {__VLS_StyleScopedClasses['lib-icon']} */ ;
            if (asset.status === 'ready') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
            }
            else if (asset.status === 'processing') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
            }
            else {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "lib-text" },
                ...{ class: ({ 'is-managed': !asset.uuid.startsWith('local:') }) },
            });
            /** @type {__VLS_StyleScopedClasses['lib-text']} */ ;
            /** @type {__VLS_StyleScopedClasses['is-managed']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "lib-name-wrap" },
            });
            /** @type {__VLS_StyleScopedClasses['lib-name-wrap']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "lib-name" },
            });
            /** @type {__VLS_StyleScopedClasses['lib-name']} */ ;
            (asset.display_name);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "mcr-badges" },
            });
            /** @type {__VLS_StyleScopedClasses['mcr-badges']} */ ;
            if (__VLS_ctx.parseBroadcastRating(asset.rating).ageRating !== 'none') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "mcr-badge badge-age" },
                    ...{ class: (`age-${__VLS_ctx.parseBroadcastRating(asset.rating).ageRating}`) },
                });
                /** @type {__VLS_StyleScopedClasses['mcr-badge']} */ ;
                /** @type {__VLS_StyleScopedClasses['badge-age']} */ ;
                (__VLS_ctx.parseBroadcastRating(asset.rating).ageRating.toUpperCase());
            }
            if (__VLS_ctx.parseBroadcastRating(asset.rating).tpFlag) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "mcr-badge badge-tp" },
                });
                /** @type {__VLS_StyleScopedClasses['mcr-badge']} */ ;
                /** @type {__VLS_StyleScopedClasses['badge-tp']} */ ;
            }
            if (__VLS_ctx.parseBroadcastRating(asset.rating).contentType !== 'none') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "mcr-badge badge-content" },
                    ...{ class: (`content-${__VLS_ctx.parseBroadcastRating(asset.rating).contentType}`) },
                });
                /** @type {__VLS_StyleScopedClasses['mcr-badge']} */ ;
                /** @type {__VLS_StyleScopedClasses['badge-content']} */ ;
                (__VLS_ctx.parseBroadcastRating(asset.rating).contentType.toUpperCase());
            }
            if (__VLS_ctx.effectiveDurationSeconds(asset) > 0) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "lib-time-pill" },
                });
                /** @type {__VLS_StyleScopedClasses['lib-time-pill']} */ ;
                (__VLS_ctx.formatDuration(__VLS_ctx.effectiveDurationSeconds(asset)));
            }
            // @ts-ignore
            [parseBroadcastRating, parseBroadcastRating, parseBroadcastRating, parseBroadcastRating, parseBroadcastRating, parseBroadcastRating, parseBroadcastRating, effectiveDurationSeconds, effectiveDurationSeconds, formatDuration,];
        }
        // @ts-ignore
        [];
    }
}
let __VLS_0;
/** @ts-ignore @type { | typeof __VLS_components.Teleport | typeof __VLS_components.Teleport} */
Teleport;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    to: "body",
}));
const __VLS_2 = __VLS_1({
    to: "body",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
if (__VLS_ctx.contextMenu.show) {
    const __VLS_6 = ContextMenu;
    // @ts-ignore
    const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
        ...{ 'onClose': {} },
        x: (__VLS_ctx.contextMenu.x),
        y: (__VLS_ctx.contextMenu.y),
        topActions: (__VLS_ctx.topActionItems),
        items: (__VLS_ctx.menuItems),
    }));
    const __VLS_8 = __VLS_7({
        ...{ 'onClose': {} },
        x: (__VLS_ctx.contextMenu.x),
        y: (__VLS_ctx.contextMenu.y),
        topActions: (__VLS_ctx.topActionItems),
        items: (__VLS_ctx.menuItems),
    }, ...__VLS_functionalComponentArgsRest(__VLS_7));
    let __VLS_11;
    const __VLS_12 = {
        /** @type {typeof __VLS_11.close} */
        onClose: (__VLS_ctx.closeContextMenu),
    };
    var __VLS_9;
    var __VLS_10;
}
// @ts-ignore
[contextMenu, contextMenu, contextMenu, topActionItems, menuItems, closeContextMenu,];
var __VLS_3;
let __VLS_13;
/** @ts-ignore @type { | typeof __VLS_components.Teleport | typeof __VLS_components.Teleport} */
Teleport;
// @ts-ignore
const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({
    to: "body",
}));
const __VLS_15 = __VLS_14({
    to: "body",
}, ...__VLS_functionalComponentArgsRest(__VLS_14));
const { default: __VLS_18 } = __VLS_16.slots;
const __VLS_19 = TrimPanel;
// @ts-ignore
const __VLS_20 = __VLS_asFunctionalComponent1(__VLS_19, new __VLS_19({
    ...{ 'onSaved': {} },
    ...{ 'onClose': {} },
    isOpen: (__VLS_ctx.showTrimPanel),
    libraryItem: (__VLS_ctx.trimAsset
        ? {
            id: __VLS_ctx.trimAsset.uuid,
            uuid: __VLS_ctx.trimAsset.uuid,
            path: __VLS_ctx.trimAsset.current_path,
            filename: __VLS_ctx.trimAsset.display_name,
            type: 'video',
            duration: __VLS_ctx.assetDurationSeconds(__VLS_ctx.trimAsset),
            inPoint: __VLS_ctx.trimAsset.trim_in_ms,
            outPoint: __VLS_ctx.trimAsset.duration_ms > 0 ? __VLS_ctx.trimAsset.duration_ms - __VLS_ctx.trimAsset.trim_out_ms : 0,
        }
        : null),
}));
const __VLS_21 = __VLS_20({
    ...{ 'onSaved': {} },
    ...{ 'onClose': {} },
    isOpen: (__VLS_ctx.showTrimPanel),
    libraryItem: (__VLS_ctx.trimAsset
        ? {
            id: __VLS_ctx.trimAsset.uuid,
            uuid: __VLS_ctx.trimAsset.uuid,
            path: __VLS_ctx.trimAsset.current_path,
            filename: __VLS_ctx.trimAsset.display_name,
            type: 'video',
            duration: __VLS_ctx.assetDurationSeconds(__VLS_ctx.trimAsset),
            inPoint: __VLS_ctx.trimAsset.trim_in_ms,
            outPoint: __VLS_ctx.trimAsset.duration_ms > 0 ? __VLS_ctx.trimAsset.duration_ms - __VLS_ctx.trimAsset.trim_out_ms : 0,
        }
        : null),
}, ...__VLS_functionalComponentArgsRest(__VLS_20));
let __VLS_24;
const __VLS_25 = {
    /** @type {typeof __VLS_24.saved} */
    onSaved: (__VLS_ctx.handleTrimSaved),
};
const __VLS_26 = {
    /** @type {typeof __VLS_24.close} */
    onClose: (...[$event]) => {
        __VLS_ctx.showTrimPanel = false;
        __VLS_ctx.trimAsset = null;
        // @ts-ignore
        [showTrimPanel, showTrimPanel, trimAsset, trimAsset, trimAsset, trimAsset, trimAsset, trimAsset, trimAsset, trimAsset, trimAsset, trimAsset, trimAsset, assetDurationSeconds, handleTrimSaved,];
    },
};
var __VLS_22;
var __VLS_23;
// @ts-ignore
[];
var __VLS_16;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
