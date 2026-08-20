<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { refDebounced } from '@vueuse/core';
import { invoke } from '@tauri-apps/api/core';
import { ask, save } from '@tauri-apps/plugin-dialog';
import { useRundownStore, parseBroadcastRating, serializeBroadcastRating, getMetadataFromAssetResponse, type ComplianceRating, type InsertionTarget } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';
import { useMediaDefaultsStore, type LibraryIndicator } from '../stores/mediaDefaults';
import { useIngestorStatusStore } from '../stores/ingestorStatus';
import { useMediaLibraryStore, type LibraryAsset, type TreeNode } from '../stores/mediaLibrary';
import { draggingItem } from '../composables/useDragState';
import { beginLibraryDrag, didCompletePointerDrag } from '../composables/useDragSession';
import { activeScope, activeLibraryContext } from '../composables/useOperatorShortcuts';
import { type LibraryCommandContext, type LibraryInsertResult } from '../services/commandRegistry';
import TrimPanel from './TrimPanel.vue';
import FolderPickerModal from './FolderPickerModal.vue';
import RecycleBinModal from './RecycleBinModal.vue';
import StatusIndicator from './StatusIndicator.vue';
import { resolveLibraryStatusTone } from '../lib/statusResolver';

import ContextMenu, { type MenuItem, type TopAction } from './ContextMenu.vue';
import { GREEK_COMPLIANCE_PRESETS, type GreekCompliancePreset } from '../lib/greekCompliance';
import { buildVirtualFolderTree, type VirtualFolderNode } from '../stores/mediaLibrary';

const store = useRundownStore();
const settings = useSettingsStore();
const mediaDefaults = useMediaDefaultsStore();
const mediaLibrary = useMediaLibraryStore();
const ingestorStatus = useIngestorStatusStore();

const showTrimPanel = ref(false);
const trimAsset = ref<LibraryAsset | null>(null);
const showRecycleBin = ref(false);
const isScanning = ref(false);
const isWarmingCatalog = ref(false);
const libraryQuery = ref('');
const showDebugMenu = ref(false);
const showDebugPanel = ref(false);
const diagnosticEntries = ref<DiagnosticEntry[]>([]);

const purgeAlertModal = ref<{
    show: boolean;
    title: string;
    message: string;
    isFolder: boolean;
    targetPathOrUuid: string;
    displayName: string;
}>({
    show: false,
    title: '',
    message: '',
    isFolder: false,
    targetPathOrUuid: '',
    displayName: ''
});

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
let libraryPollTimer: ReturnType<typeof setInterval> | null = null;

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

const expandedFolders = ref<Record<string, boolean>>({ '/': true });

function getFolderName(path: string): string {
    if (path === '/') return 'All Media';
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'Unknown';
}

export interface VisibleTreeRow {
    key: string;
    id: string;
    type: 'folder' | 'asset';
    depth: number;
    path: string;
    displayName: string;
    hasChildren?: boolean;
    isExpanded?: boolean;
    allAssetCount?: number;
    color?: string;
    isTransient?: boolean;
    asset?: LibraryAsset;
}

const visibleTreeRows = computed<VisibleTreeRow[]>(() => {
    const query = mediaLibrary.searchQuery.trim().toLowerCase();
    const tree = buildVirtualFolderTree(
        mediaLibrary.assets,
        mediaLibrary.transientFolders,
        mediaLibrary.folderColors,
        mediaLibrary.deletedUuids,
        query
    );

    const rows: VisibleTreeRow[] = [];

    const traverse = (node: VirtualFolderNode) => {
        if (query && node.allAssetCount === 0 && !node.name.toLowerCase().includes(query)) {
            return;
        }

        const isExpanded = query ? true : (expandedFolders.value[node.path] !== false);

        // 1. Folder row
        rows.push({
            key: `folder:${node.path}`,
            id: `folder:${node.path}`,
            type: 'folder',
            depth: node.depth,
            path: node.path,
            displayName: node.path === '/' ? 'All Media (Root)' : node.name,
            hasChildren: node.children.length > 0,
            isExpanded,
            allAssetCount: node.allAssetCount,
            color: node.color,
            isTransient: node.isTransient,
        });

        // 2. If folder is expanded:
        if (isExpanded) {
            // A. Subfolders on TOP
            for (const child of node.children) {
                traverse(child);
            }
            // B. Direct assets BELOW subfolders
            for (const asset of node.directAssets) {
                rows.push({
                    key: `asset:${asset.uuid}`,
                    id: `asset:${asset.uuid}`,
                    type: 'asset',
                    depth: node.depth + 1,
                    path: node.path,
                    displayName: asset.display_name,
                    asset,
                });
            }
        }
    };

    traverse(tree);
    return rows;
});

// Breadcrumbs for active folder context
const currentBreadcrumbs = computed(() => {
    const path = mediaLibrary.currentFolderPath || '/';
    if (path === '/') return [{ name: 'All Media', path: '/' }];
    const parts = path.split('/').filter(Boolean);
    const crumbs = [{ name: 'All Media', path: '/' }];
    let accum = '';
    for (const p of parts) {
        accum += `/${p}`;
        crumbs.push({ name: p, path: accum });
    }
    return crumbs;
});

function navigateBreadcrumb(path: string) {
    mediaLibrary.currentFolderPath = path;
    mediaLibrary.selectedNodeId = `folder:${path}`;
    expandedFolders.value[path] = true;
}

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

// Parse-once cache for rating strings (plan §2.2): parseBroadcastRating is
// called up to 4× per asset row per render and performs string splitting plus
// JSON.parse. Keyed by uuid+rating so a metadata edit (which replaces the
// serialized rating) invalidates the entry naturally.
const ratingMetaCache = new Map<string, ReturnType<typeof parseBroadcastRating>>();

function cachedRatingMeta(asset: LibraryAsset) {
    const key = `${asset.uuid}|${asset.rating}`;
    let meta = ratingMetaCache.get(key);
    if (!meta) {
        meta = parseBroadcastRating(asset.rating);
        ratingMetaCache.set(key, meta);
    }
    return meta;
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
        mezzanine_ok: asset.mezzanine_ok,
        fps: asset.fps,
        total_frames: asset.total_frames,
        gop_frames: asset.gop_frames,
        keyframe_safe_start_ms: asset.keyframe_safe_start_ms,
        warnings: asset.warnings,
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

let fetchAssetsInFlight = false;

async function fetchAssets(options: { force?: boolean } = {}) {
    if (fetchAssetsInFlight) return;
    fetchAssetsInFlight = true;
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
        fetchAssetsInFlight = false;
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
    const outPoint = (asset.trim_out_ms && asset.trim_out_ms > 0)
        ? asset.trim_out_ms
        : asset.duration_ms;
    const inPoint = asset.trim_in_ms || 0;
    const effectiveMs = outPoint - inPoint;
    return Math.max(0, effectiveMs) / 1000;
}

function makeRundownDraftFromAsset(asset: LibraryAsset) {
    const nameLower = (asset.display_name || '').toLowerCase();
    const ratingLower = (asset.rating || '').toLowerCase();
    const hasTrim = (asset.trim_in_ms && asset.trim_in_ms > 0) ||
        (asset.trim_out_ms && asset.trim_out_ms > 0 && asset.trim_out_ms < (asset.duration_ms || Infinity)) ||
        nameLower.includes('sub-clip') || nameLower.includes('subclip') || ratingLower.includes('subclip');

    let duration = assetDurationSeconds(asset);
    let effective = effectiveDurationSeconds(asset);
    let inPoint = asset.trim_in_ms || 0;
    let outPoint = (asset.trim_out_ms && asset.trim_out_ms > 0)
        ? asset.trim_out_ms
        : (asset.duration_ms || 0);
    let durationMs = asset.duration_ms;

    if (hasTrim) {
        // A virtual subclip or trimmed asset is a full copy of the source with trim points.
        // Keep duration_ms as the PHYSICAL file duration so the trimmer can
        // retrim against the whole file and the hydrator's out-point clamp
        // never truncates the trim. Only the playable duration and
        // plannedDuration reflect the trimmed range.
        const calculatedDuration = Math.max(0, (asset.trim_out_ms || outPoint) - (asset.trim_in_ms || 0));
        duration = calculatedDuration / 1000;
        effective = calculatedDuration / 1000;
        inPoint = asset.trim_in_ms || 0;
        outPoint = asset.trim_out_ms || outPoint;
    }

    const meta = cachedRatingMeta(asset);
    const compliance = meta.ageRating ||
        mediaDefaults.getCompliance(asset.uuid, asset.current_path);

    const statusVal = (asset.status === 'ready' || asset.status === 'processing' || asset.status === 'error' || asset.status === 'missing' || asset.status === 'idle')
        ? asset.status
        : (asset.mezzanine_ok ? 'ready' : 'idle');

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
        complianceDescriptors: [],
        complianceText: meta.advisoryText || meta.timeline[0]?.text || '',
        timeline: meta.timeline || [],
        tp_flag: meta.tpFlag,
        content_type: meta.contentType,
        display_name: asset.display_name,
        virtual_folder: asset.virtual_folder,
        current_path: asset.current_path,
        duration_ms: durationMs,
        trim_in_ms: asset.trim_in_ms,
        trim_out_ms: asset.trim_out_ms,
        ingestorStatus: statusVal as any,
        mezzanine_ok: asset.mezzanine_ok,
        fps: asset.fps,
        fps_num: asset.fpsNum,
        fps_den: asset.fpsDen,
        total_frames: asset.total_frames,
        gop_frames: asset.gop_frames,
        keyframe_safe_start_ms: asset.keyframe_safe_start_ms,
        warnings: asset.warnings || [],
    };
}

function appendLibraryAssetToRundown(asset: LibraryAsset, target: InsertionTarget): LibraryInsertResult {
    const durationMs = asset.duration_ms || (asset.fps && asset.total_frames ? (asset.total_frames / asset.fps) * 1000 : 0);
    if (!durationMs || durationMs <= 0) {
        return {
            insertedIds: [],
            skippedIds: [asset.uuid],
            errors: [`Asset "${asset.display_name || asset.uuid}" duration is unavailable`]
        };
    }

    const draft = makeRundownDraftFromAsset(asset);
    const createdIds = store.insertLibraryItems({
        items: [draft],
        target
    });

    return {
        insertedIds: createdIds,
        skippedIds: [],
        errors: []
    };
}

async function addSelectedAssetToRundown() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset) return;
    appendLibraryAssetToRundown(asset, { kind: 'append' });
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

function isAssetSelected(uuid: string): boolean {
    return mediaLibrary.selectedNodeIds.includes(`asset:${uuid}`) || mediaLibrary.selectedNodeId === `asset:${uuid}`;
}

function isAssetPrimarySelected(uuid: string): boolean {
    return mediaLibrary.selectedNodeId === `asset:${uuid}`;
}

function getAssetTooltip(asset: LibraryAsset): string | undefined {
    if (asset.warnings && asset.warnings.length > 0) {
        return `Warning:\n• ${asset.warnings.join('\n• ')}`;
    }
    return undefined;
}

function onAssetClick(asset: LibraryAsset, event?: MouseEvent) {
    if (didCompletePointerDrag()) {
        event?.preventDefault();
        event?.stopPropagation();
        return;
    }
    mediaLibrary.selectNode(`asset:${asset.uuid}`, {
        multi: event?.ctrlKey || event?.metaKey,
        range: event?.shiftKey,
    });
    if (libTreeRef.value) {
        libTreeRef.value.focus({ preventScroll: true });
    }
}

let libraryScrollFrame: number | null = null;

function scrollSelectedLibraryAssetIntoView() {
    if (libraryScrollFrame !== null) {
        cancelAnimationFrame(libraryScrollFrame);
    }
    libraryScrollFrame = requestAnimationFrame(() => {
        libraryScrollFrame = null;
        const id = mediaLibrary.selectedAssetId;
        if (!id || !libTreeRef.value) return;

        const row = libTreeRef.value.querySelector<HTMLElement>(
            `[data-asset-id="${CSS.escape(id)}"]`
        );

        row?.scrollIntoView({
            block: 'nearest',
            behavior: 'auto',
        });
    });
}

watch(
    () => mediaLibrary.selectedNodeId,
    () => {
        scrollSelectedLibraryAssetIntoView();
    }
);

function onAssetDoubleClick(asset: LibraryAsset) {
    store.addItem(makeRundownDraftFromAsset(asset));
}

function onAssetPointerDown(event: PointerEvent, asset: LibraryAsset) {
    if (event.button !== 0) return;
    mediaLibrary.selectedNodeId = `asset:${asset.uuid}`;
    const meta = cachedRatingMeta(asset);
    const payload = {
        source: 'library' as const,
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
        ingestorStatus: (asset.status || (asset.mezzanine_ok ? 'ready' : 'idle')) as any,
        mezzanine_ok: asset.mezzanine_ok,
        fps: asset.fps,
        fps_num: asset.fpsNum,
        fps_den: asset.fpsDen,
        total_frames: asset.total_frames,
        gop_frames: asset.gop_frames,
        keyframe_safe_start_ms: asset.keyframe_safe_start_ms,
        warnings: asset.warnings || [],
    };
    beginLibraryDrag({
        pointerId: event.pointerId,
        event,
        payload,
        onDropOutside: ({ clientX, clientY }) => {
            const folderElement = document.elementFromPoint(clientX, clientY)
                ?.closest<HTMLElement>('[data-library-folder-path]');
            const folderPath = folderElement?.dataset.libraryFolderPath;
            return folderPath ? moveAssetToFolder(asset, folderPath) : false;
        }
    });
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

function ctxInspect() {
    const node = contextMenu.value.node;
    if (node?.type === 'asset' && node.asset) {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('playout:open-inspector', { detail: node.asset }));
        }
    }
    closeContextMenu();
}

function ctxAppend() {
    if (store.isRundownLocked) {
        closeContextMenu();
        return;
    }
    const node = contextMenu.value.node;
    if (node?.type === 'asset' && node.asset) {
        store.addItem(makeRundownDraftFromAsset(node.asset));
    }
    closeContextMenu();
}

function ctxInsertAfter() {
    if (store.isRundownLocked) {
        closeContextMenu();
        return;
    }
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
        doTrashAsset(node.asset.uuid);
    }
    closeContextMenu();
}

function ctxPurge() {
    const node = contextMenu.value.node;
    if (node?.type === 'asset' && node.asset) {
        promptPurgeAsset(node.asset);
    }
    closeContextMenu();
}

function ctxMove() {
    closeContextMenu();
    openMoveAssetModal();
}

function ctxTrim() {
    const node = contextMenu.value.node;
    if (node?.type === 'asset' && node.asset) {
        trimAsset.value = node.asset;
        showTrimPanel.value = true;
    }
    closeContextMenu();
}

const showFolderPicker = ref(false);
const folderPickerTitle = ref('Move to Virtual Folder');
const folderPickerCurrentPath = ref('/');
const folderPickerForbiddenPaths = ref<string[]>([]);
const folderPickerMode = ref<'asset' | 'folder'>('asset');
const folderPickerTargetAsset = ref<LibraryAsset | null>(null);
const folderPickerTargetFolder = ref<string | null>(null);

function openMoveAssetModal(asset?: LibraryAsset) {
    const target = asset || (contextMenu.value.node?.type === 'asset' ? contextMenu.value.node.asset : mediaLibrary.selectedAsset);
    if (!target) return;
    folderPickerTargetAsset.value = target;
    folderPickerTargetFolder.value = null;
    folderPickerMode.value = 'asset';
    folderPickerTitle.value = `Move "${target.display_name}" to Virtual Folder`;
    folderPickerCurrentPath.value = target.virtual_folder || '/';
    folderPickerForbiddenPaths.value = [];
    showFolderPicker.value = true;
    closeContextMenu();
}

function openMoveFolderModal(folderPath?: string) {
    const target = folderPath || (contextMenu.value.node?.type === 'folder' ? contextMenu.value.node.virtualFolder : mediaLibrary.currentFolderPath);
    if (!target || target === '/') return;
    folderPickerTargetAsset.value = null;
    folderPickerTargetFolder.value = target;
    folderPickerMode.value = 'folder';
    folderPickerTitle.value = `Move Folder "${getFolderName(target)}"`;
    folderPickerCurrentPath.value = target;
    folderPickerForbiddenPaths.value = [target];
    showFolderPicker.value = true;
    closeContextMenu();
}

async function handleFolderPickerSelect(targetFolderPath: string) {
    showFolderPicker.value = false;
    if (folderPickerMode.value === 'asset' && folderPickerTargetAsset.value) {
        await mediaLibrary.moveAssetToFolder(folderPickerTargetAsset.value.uuid, targetFolderPath);
    } else if (folderPickerMode.value === 'folder' && folderPickerTargetFolder.value) {
        await mediaLibrary.moveFolderTo(folderPickerTargetFolder.value, targetFolderPath);
    }
}

function doNewVirtualFolder(parentPath?: string) {
    const base = parentPath || (contextMenu.value.node?.type === 'folder' ? contextMenu.value.node.virtualFolder : mediaLibrary.currentFolderPath) || '/';
    const name = window.prompt(`New virtual subfolder name inside "${getFolderName(base)}":`);
    if (!name) return;
    mediaLibrary.createVirtualFolder(base, name);
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

function doMoveSelected() {
    openMoveAssetModal();
}

function doDeleteSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset) return;
    doTrashAsset(asset.uuid);
}

async function doTrashAsset(uuid: string) {
    try {
        await mediaLibrary.trashAsset(uuid);
    } catch (e) {
        window.alert(`Failed to move asset to Recycle Bin: ${e}`);
    }
}

async function doTrashFolder(folderPath: string) {
    try {
        await mediaLibrary.trashFolder(folderPath);
    } catch (e) {
        window.alert(`Failed to move folder to Recycle Bin: ${e}`);
    }
}

function promptPurgeAsset(asset: LibraryAsset) {
    if (asset.uuid.startsWith('local:')) {
        window.alert("Cannot purge local fallback assets.");
        return;
    }
    purgeAlertModal.value = {
        show: true,
        title: 'Delete & Purge Asset',
        message: `Are you sure you want to permanently delete and purge "${asset.display_name}"? This will permanently delete the physical mezzanine file on disk, sidecar file, and all database records matching this asset.`,
        isFolder: false,
        targetPathOrUuid: asset.uuid,
        displayName: asset.display_name
    };
}

function promptPurgeFolder(folderPath: string) {
    purgeAlertModal.value = {
        show: true,
        title: 'Delete & Purge Folder',
        message: `Are you sure you want to permanently delete and purge folder "${folderPath}" and all contained assets? This will permanently delete all physical mezzanine files on disk, sidecar files, and database records for this folder.`,
        isFolder: true,
        targetPathOrUuid: folderPath,
        displayName: folderPath
    };
}

async function executePurgeAlert() {
    const { isFolder, targetPathOrUuid } = purgeAlertModal.value;
    purgeAlertModal.value.show = false;
    try {
        if (isFolder) {
            await mediaLibrary.purgeFolder(targetPathOrUuid);
        } else {
            await mediaLibrary.purgeAsset(targetPathOrUuid);
        }
        await fetchAssets({ force: true });
    } catch (e) {
        window.alert(`Failed to purge: ${e}`);
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
    // A subclip creation registers a brand-new asset in the Ingestor API.
    // `updateAsset` only patches an existing entry, so the new subclip would
    // never appear in the tree. Trigger a full forced re-fetch to pull the
    // new asset (and any siblings) from the API.
    await fetchAssets({ force: true });
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
    if (!probeStatus.value?.running) return '';
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

const visibleAssetNodes = computed(() =>
    mediaLibrary.allTreeNodes.filter((node) => node.type === 'asset')
);

onMounted(() => {
    activeLibraryContext.value = {
        getSelectedAssetIds: () => mediaLibrary.selectedAssetIds,
        getVisibleAssetIds: () => visibleAssetNodes.value.map((n) => n.asset?.uuid || n.id),
        selectPrevious: () => mediaLibrary.moveSelectionDelta(-1, visibleAssetNodes.value),
        selectNext: () => mediaLibrary.moveSelectionDelta(1, visibleAssetNodes.value),
        selectFirst: () => mediaLibrary.selectFirst(visibleAssetNodes.value),
        selectLast: () => mediaLibrary.selectLast(visibleAssetNodes.value),
        extendSelection: (delta: -1 | 1) => mediaLibrary.extendSelection(delta, visibleAssetNodes.value),
        appendSelectedToPlaylist: async (): Promise<LibraryInsertResult> => {
            const selectedUuids = mediaLibrary.selectedAssetIds;
            const selectedAssets = selectedUuids
                .map(uuid => mediaLibrary.assets.find(a => a.uuid === uuid))
                .filter((a): a is LibraryAsset => !!a);
            const assetsToInsert = selectedAssets.length > 0
                ? selectedAssets
                : (mediaLibrary.selectedAsset ? [mediaLibrary.selectedAsset] : []);

            if (assetsToInsert.length === 0) {
                return { insertedIds: [], skippedIds: [], errors: ['No library asset selected'] };
            }

            const insertedIds: string[] = [];
            const skippedIds: string[] = [];
            const errors: string[] = [];

            const validDrafts = [];
            for (const a of assetsToInsert) {
                const durationMs = a.duration_ms || (a.fps && a.total_frames ? (a.total_frames / a.fps) * 1000 : 0);
                if (!durationMs || durationMs <= 0) {
                    skippedIds.push(a.uuid);
                    errors.push(`Asset "${a.display_name || a.uuid}" duration is unavailable`);
                } else {
                    validDrafts.push(makeRundownDraftFromAsset(a));
                }
            }

            if (validDrafts.length > 0) {
                const created = store.insertLibraryItems({
                    items: validDrafts,
                    target: { kind: 'append' }
                });
                insertedIds.push(...created);
            }

            return { insertedIds, skippedIds, errors };
        },
        insertSelectedAfter: async (targetId: string | null): Promise<LibraryInsertResult> => {
            const selectedUuids = mediaLibrary.selectedAssetIds;
            const selectedAssets = selectedUuids
                .map(uuid => mediaLibrary.assets.find(a => a.uuid === uuid))
                .filter((a): a is LibraryAsset => !!a);
            const assetsToInsert = selectedAssets.length > 0
                ? selectedAssets
                : (mediaLibrary.selectedAsset ? [mediaLibrary.selectedAsset] : []);

            if (assetsToInsert.length === 0) {
                return { insertedIds: [], skippedIds: [], errors: ['No library asset selected'] };
            }

            const insertedIds: string[] = [];
            const skippedIds: string[] = [];
            const errors: string[] = [];

            const validDrafts = [];
            for (const a of assetsToInsert) {
                const durationMs = a.duration_ms || (a.fps && a.total_frames ? (a.total_frames / a.fps) * 1000 : 0);
                if (!durationMs || durationMs <= 0) {
                    skippedIds.push(a.uuid);
                    errors.push(`Asset "${a.display_name || a.uuid}" duration is unavailable`);
                } else {
                    validDrafts.push(makeRundownDraftFromAsset(a));
                }
            }

            if (validDrafts.length > 0) {
                const target = targetId ? { kind: 'after' as const, targetItemId: targetId } : { kind: 'append' as const };
                const created = store.insertLibraryItems({
                    items: validDrafts,
                    target
                });
                insertedIds.push(...created);
            }

            return { insertedIds, skippedIds, errors };
        }
    };

    refreshProbeStatus().catch(() => {});
    fetchAssets();
    if (settings.debugMode) refreshDebugPanel().catch(() => {});
    periodicWarmupTimer = setInterval(() => {
        if (!probeStatus.value.running) {
            scheduleLibraryWarmup(0);
        }
    }, 300000);
    libraryPollTimer = setInterval(() => {
        if (isScanning.value) return;
        if (!ingestorStatus.isIngestorOnline) return;
        fetchAssets().catch(() => {});
    }, 30000);
    mediaLibrary.fetchFolderColors();
    window.addEventListener('click', closeContextMenu);
});

onUnmounted(() => {
    activeLibraryContext.value = null;
    if (periodicWarmupTimer) {
        clearInterval(periodicWarmupTimer);
        periodicWarmupTimer = null;
    }
    if (libraryPollTimer) {
        clearInterval(libraryPollTimer);
        libraryPollTimer = null;
    }
    clearScheduledWarmup();
    window.removeEventListener('click', closeContextMenu);
});

function onFolderDragOverPath(event: DragEvent, folderPath: string) {
    // Ignore drags that are not ours (plan §2.2): only an asset drag or a
    // folder drag should highlight a folder as a drop target. This prevents
    // stray dragover events (rundown reorders, external OS drags) from
    // painting drop markers on every folder.
    const isFolderDrag = event.dataTransfer?.types.includes(FOLDER_DRAG_MIME) ?? false;
    if (!draggingItem.value && !isFolderDrag) return;
    event.preventDefault();
    folderDropTargetId.value = `folder:${folderPath}`;
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = isFolderDrag ? 'move' : 'copy';
    }
}

async function moveAssetToFolder(asset: LibraryAsset, folderPath: string): Promise<boolean> {
    if (!asset.uuid) return false;

    if (!asset.uuid.startsWith('local:')) {
        const result = await ingestorInvoke<void>(
            'move_ingestor_asset',
            { uuid: asset.uuid, virtual_folder: folderPath, api_base_url_override: null },
            'ingestor-move'
        );
        if (result === null) return false;
    }

    mediaLibrary.moveAssetToFolder(asset.uuid, folderPath);
    return true;
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

    // Asset rows use the pointer drag controller. Native HTML5 drag/drop remains
    // only for folders, so asset relocation is handled by onDropOutside above.
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

async function ctxApplyCompliancePreset(preset: GreekCompliancePreset) {
  const asset = contextMenu.value.node?.asset;
  if (asset) {
    await mediaLibrary.updateAssetMetadata(asset.uuid, {
      complianceRating: preset.ageRating,
      complianceText: preset.advisoryText,
      timeline: preset.advisoryText ? [{ start: 0, end: (preset.displayDurationSec || 30) * 1000, text: preset.advisoryText }] : []
    });
  }
  closeContextMenu();
}

async function ctxToggleTP() {
  const asset = contextMenu.value.node?.asset;
  if (asset) {
    const meta = cachedRatingMeta(asset);
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
    const ratingMeta = cachedRatingMeta(asset);
    
    return [
      {
        type: 'action',
        label: '🔍 Inspect Clip (Ctrl+I)',
        action: ctxInspect
      },
      {
        type: 'action',
        label: 'Append to Rundown',
        disabled: store.isRundownLocked,
        action: ctxAppend
      },
      {
        type: 'action',
        label: 'Insert After Selected',
        disabled: store.isRundownLocked,
        action: ctxInsertAfter
      },
      { type: 'divider' },
      {
        type: 'submenu',
        label: '🇬🇷 Greek Warning Presets (ΕΣΡ)',
        children: GREEK_COMPLIANCE_PRESETS.map(p => ({
          type: 'action',
          label: p.name,
          checked: ratingMeta.ageRating === p.ageRating && ratingMeta.advisoryText === p.advisoryText,
          action: () => ctxApplyCompliancePreset(p)
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
        action: () => openMoveAssetModal(asset)
      },
      { type: 'divider' },
      {
        type: 'action',
        label: '🗑 Move to Recycle Bin',
        action: () => doTrashAsset(asset.uuid)
      },
      {
        type: 'action',
        label: '💥 Delete & Purge…',
        action: () => promptPurgeAsset(asset)
      }
    ];
  } else if (node.type === 'folder') {
    const isRoot = node.virtualFolder === '/';
    const folderItems: MenuItem[] = [
      {
        type: 'action',
        label: '📁+ New Subfolder here',
        action: () => doNewVirtualFolder(node.virtualFolder)
      }
    ];

    if (!isRoot) {
      folderItems.push({
        type: 'action',
        label: '➡️ Move Folder to…',
        action: () => openMoveFolderModal(node.virtualFolder)
      });
      folderItems.push({
        type: 'action',
        label: '✏️ Rename folder',
        action: doRenameFolder
      });
      folderItems.push({ type: 'divider' });
      folderItems.push({
        type: 'action',
        label: '🗑 Move Folder to Recycle Bin',
        action: () => doTrashFolder(node.virtualFolder)
      });
      folderItems.push({
        type: 'action',
        label: '💥 Delete & Purge Folder…',
        action: () => promptPurgeFolder(node.virtualFolder)
      });
    }

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
  <div class="lib-wrap media-library-panel" data-scope="library" data-command-scope="library" tabindex="0" @focus="activeScope = 'library'">

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
        @click="() => doNewVirtualFolder()"
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
        title="Move selected asset to Recycle Bin"
        :disabled="!mediaLibrary.selectedAsset"
        @click="doDeleteSelected"
      >
        🗑 Delete
      </button>
      <button
        class="icon-action recycle-bin-toggle-btn"
        title="Open Recycle Bin"
        @click="showRecycleBin = true"
      >
        🗑 Recycle Bin
        <span v-if="mediaLibrary.recycleBinAssets.length > 0" class="recycle-bin-count-badge">
          {{ mediaLibrary.recycleBinAssets.length }}
        </span>
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

    <!-- Active Path Breadcrumb Bar -->
    <div class="lib-breadcrumb-bar">
      <span class="breadcrumb-icon">📁</span>
      <div class="breadcrumb-trail custom-scroll">
        <span
          v-for="(crumb, idx) in currentBreadcrumbs"
          :key="crumb.path"
          class="breadcrumb-crumb"
          :class="{ 'is-active': crumb.path === mediaLibrary.currentFolderPath }"
          @click="navigateBreadcrumb(crumb.path)"
        >
          {{ crumb.name }}
          <span v-if="idx < currentBreadcrumbs.length - 1" class="breadcrumb-sep">/</span>
        </span>
      </div>
    </div>

    <!-- Tree List -->
    <div
      ref="libTreeRef"
      class="lib-tree custom-scroll"
      data-command-scope="library"
      role="listbox"
      aria-label="Media library"
      aria-multiselectable="true"
      tabindex="0"
      @focus="activeScope = 'library'"
      @contextmenu.prevent
      style="overflow-y: auto;"
    >
      <div v-if="isScanning && !visibleTreeRows.length" class="lib-empty">⌛ Loading…</div>
      <div v-else-if="visibleTreeRows.length === 0" class="lib-empty">
        {{ libraryQuery ? 'No matching assets found.' : '📂 No media found.\nSet the Ingestor API or media folder in ⚙️ Settings.' }}
      </div>
      <div v-else class="lib-tree-content">
        <template v-for="row in visibleTreeRows" :key="row.key">
          <!-- 1. Folder Row -->
          <div
            v-if="row.type === 'folder'"
            class="lib-row is-folder"
            :class="{
              'is-selected': mediaLibrary.selectedNodeId === row.id,
              'is-folder-drop-target': folderDropTargetId === row.id,
              'is-root-folder': row.depth === 0,
            }"
            :style="{ paddingLeft: `${row.depth * 18 + 8}px` }"
            :data-library-folder-path="row.path"
            :draggable="row.depth > 0"
            @click="onFolderClick(row.path)"
            @dblclick="onFolderDoubleClick(row.path)"
            @contextmenu.prevent="onFolderContextMenu($event, row.path)"
            @dragstart="onFolderDragStart($event, row.path)"
            @dragend="folderDropTargetId = null"
            @dragover="onFolderDragOverPath($event, row.path)"
            @drop="onFolderDropPath($event, row.path)"
          >
            <!-- Vertical Indentation Tree Guides -->
            <span
              v-for="d in row.depth"
              :key="d"
              class="tree-guide-line"
              :style="{ left: `${(d - 1) * 18 + 14}px` }"
            ></span>

            <!-- Chevron for collapsible folder -->
            <span
              class="chevron-icon"
              :class="{ 'is-expanded': row.isExpanded }"
              @click.stop="expandedFolders[row.path] = !row.isExpanded"
            >
              ▶
            </span>

            <span class="lib-icon" @click.stop="onFolderClick(row.path)">
              <svg
                class="folder-svg"
                viewBox="0 0 24 24"
                :style="{ fill: row.color || (row.depth === 0 ? '#38bdf8' : 'var(--accent-blue)') }"
              >
                <path v-if="row.isExpanded" d="M19 5.5h-7.28l-2-2H4c-1.1 0-2 .9-2 2v13c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-11c0-1.1-.9-2-2-2zm0 13H4v-11h16v11z"/>
                <path v-else d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
              </svg>
            </span>

            <span class="lib-text">
              <span class="lib-name folder-title-text">{{ row.displayName }}</span>
            </span>

            <span v-if="row.allAssetCount !== undefined" class="folder-count-badge">
              {{ row.allAssetCount }}
            </span>
          </div>

          <!-- 2. Asset Row -->
          <div
            v-else-if="row.type === 'asset' && row.asset"
            class="lib-row is-asset"
            :class="{
              'is-selected': isAssetSelected(row.asset.uuid)
            }"
            role="option"
            :data-asset-id="row.asset.uuid"
            :aria-selected="isAssetSelected(row.asset.uuid)"
            :tabindex="isAssetPrimarySelected(row.asset.uuid) ? 0 : -1"
            :style="{ paddingLeft: `${row.depth * 18 + 8}px` }"
            @click="onAssetClick(row.asset, $event)"
            @dblclick="onAssetDoubleClick(row.asset)"
            @contextmenu.prevent="onAssetContextMenu($event, row.asset)"
            @pointerdown="onAssetPointerDown($event, row.asset)"
          >
            <!-- Vertical Indentation Tree Guides -->
            <span
              v-for="d in row.depth"
              :key="d"
              class="tree-guide-line"
              :style="{ left: `${(d - 1) * 18 + 14}px` }"
            ></span>

            <span class="chevron-spacer"></span>

            <span class="lib-icon" @click.stop="onAssetClick(row.asset)">
              <StatusIndicator :tone="resolveLibraryStatusTone(row.asset, settings.qcSensitivity)" variant="dot" :tooltip="getAssetTooltip(row.asset)" />
              <span>🎬</span>
            </span>

            <span class="lib-text" :class="{ 'is-managed': !row.asset.uuid.startsWith('local:') }">
              <span class="lib-name-wrap">
                <span class="lib-name">{{ row.asset.display_name }}</span>
                <span class="mcr-badges">
                  <span v-if="cachedRatingMeta(row.asset).ageRating !== 'none'" data-testid="age-rating-badge" class="mcr-badge badge-age" :class="`age-${cachedRatingMeta(row.asset).ageRating}`">
                    {{ cachedRatingMeta(row.asset).ageRating.toUpperCase() }}
                  </span>
                  <span v-if="cachedRatingMeta(row.asset).tpFlag" class="mcr-badge badge-tp">TP</span>
                  <span v-if="cachedRatingMeta(row.asset).contentType !== 'none'" class="mcr-badge badge-content" :class="`content-${cachedRatingMeta(row.asset).contentType}`">
                    {{ cachedRatingMeta(row.asset).contentType.toUpperCase() }}
                  </span>
                </span>
              </span>
            </span>

            <span v-if="effectiveDurationSeconds(row.asset) > 0" class="lib-time-pill">
              {{ formatDuration(effectiveDurationSeconds(row.asset)) }}
            </span>
          </div>
        </template>
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

    <!-- Folder Picker Modal -->
    <FolderPickerModal
      :is-open="showFolderPicker"
      :title="folderPickerTitle"
      :current-path="folderPickerCurrentPath"
      :forbidden-paths="folderPickerForbiddenPaths"
      :mode="folderPickerMode"
      @select="handleFolderPickerSelect"
      @close="showFolderPicker = false"
    />

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
              duration_ms: trimAsset.duration_ms,
              inPoint: trimAsset.trim_in_ms,
              outPoint: (trimAsset.trim_out_ms && trimAsset.trim_out_ms > 0) ? trimAsset.trim_out_ms : (trimAsset.duration_ms || 0),
            }
          : null"
        @saved="handleTrimSaved"
        @close="showTrimPanel = false; trimAsset = null"
      />

      <!-- Recycle Bin Modal -->
      <RecycleBinModal
        v-if="showRecycleBin"
        @close="showRecycleBin = false"
      />

      <!-- Pulsing Alert Purge Confirmation Dialog -->
      <div v-if="purgeAlertModal.show" class="purge-dialog-backdrop" @click.self="purgeAlertModal.show = false">
        <div class="purge-dialog-box danger-pulse-box">
          <div class="purge-icon-circle">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
          </div>

          <h3 class="purge-dialog-title">{{ purgeAlertModal.title }}</h3>
          <p class="purge-dialog-text">{{ purgeAlertModal.message }}</p>

          <div class="purge-warning-callout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>This action is destructive and irreversible. Physical media, sidecars, and database entries will be permanently deleted.</span>
          </div>

          <div class="purge-dialog-actions">
            <button class="dialog-cancel-btn" @click="purgeAlertModal.show = false">
              Cancel
            </button>
            <button class="dialog-danger-btn" @click="executePurgeAlert">
              Permanently Purge
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.lib-wrap { height:100%; display:flex; flex-direction:column; overflow:hidden; position:relative; }
.lib-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
  background: var(--bg-secondary);
}
.lib-header-actions { display: flex; align-items: center; gap: 6px; }
.lib-header-copy { display: flex; flex-direction: column; gap: 2px; }
.lib-title { font-size: 0.95rem; font-weight: 700; color: var(--text-primary); }
.lib-subtitle { color: var(--text-secondary); font-size: 0.74rem; }

.lib-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  flex-shrink: 0;
  min-width: 280px;
}
.lib-search {
  flex: 1 1 120px;
  min-width: 90px;
}
.lib-toolbar .icon-action {
  flex: 0 0 auto;
  padding: 5px 8px;
  font-size: 0.8rem;
  font-weight: 600;
  white-space: nowrap;
}
.toolbar-spacer { display: none; }

.lib-debug-panel {
  padding: 8px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}
.debug-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: flex-start;
}
.debug-summary {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.74rem;
  color: var(--text-secondary);
}
.debug-actions {
  display: flex;
  gap: 6px;
}
.debug-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.72rem;
  color: var(--text-secondary);
  word-break: break-all;
}
.debug-error {
  color: var(--accent-orange);
}
.debug-log {
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--border-medium);
  border-radius: 6px;
  background: var(--bg-primary);
}
.debug-empty {
  color: var(--text-muted);
  font-size: 0.75rem;
  padding: 10px;
}
.debug-entry {
  display: grid;
  grid-template-columns: 60px 48px 54px 1fr;
  gap: 8px;
  padding: 6px 8px;
  font-size: 0.72rem;
  border-bottom: 1px solid var(--border-subtle);
  align-items: start;
}
.debug-entry:last-child {
  border-bottom: none;
}
.debug-time,
.debug-level,
.debug-scope {
  color: var(--text-muted);
}
.debug-message {
  color: var(--text-primary);
  word-break: break-word;
}
.level-error .debug-level {
  color: var(--accent-red);
}
.level-warn .debug-level {
  color: var(--accent-orange);
}
.level-info .debug-level {
  color: var(--accent-blue);
}

.lib-tree {
  flex: 1;
  position: relative;
  min-height: 0;
  overflow: hidden;
  padding: 4px 6px;
}
.lib-empty { color: var(--text-muted); font-size: 0.82rem; text-align: center; padding: 20px 10px; line-height: 1.6; white-space: pre-line; }

.glass-input {
  background: var(--bg-input); border: 1px solid var(--border-medium);
  color: var(--text-primary); border-radius: 6px; font-size: 0.84rem; padding: 6px 10px;
}
.glass-input:focus {
  border-color: var(--accent-blue);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent-blue) 25%, transparent);
}

.icon-action {
  background: var(--bg-hover); border: 1px solid var(--border-medium);
  color: var(--text-primary); border-radius: 6px; cursor: pointer; padding: 5px 10px; font-size: 0.8rem; font-weight: 600; transition: 0.15s;
}
.icon-action:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-blue) 12%, var(--bg-hover)); border-color: var(--border-strong); }
.icon-action:disabled { opacity: 0.4; cursor: not-allowed; }

/* Breadcrumbs bar */
.lib-breadcrumb-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 0.78rem;
  flex-shrink: 0;
}
.breadcrumb-icon {
  font-size: 0.85rem;
  color: var(--accent-blue);
  flex-shrink: 0;
}
.breadcrumb-trail {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  white-space: nowrap;
  color: var(--text-secondary);
}
.breadcrumb-crumb {
  cursor: pointer;
  font-weight: 600;
  transition: color 0.12s ease;
}
.breadcrumb-crumb:hover {
  color: var(--accent-blue);
  text-decoration: underline;
}
.breadcrumb-crumb.is-active {
  color: var(--text-primary);
  font-weight: 700;
}
.breadcrumb-sep {
  margin: 0 2px;
  color: var(--text-muted);
}

.lib-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: var(--row-h-library, 38px);
  height: var(--row-h-library, 38px);
  padding: 3px 8px;
  border-radius: 6px;
  user-select: none;
  border: 1px solid transparent;
  transition: background 0.12s ease, border-color 0.12s ease;
  cursor: pointer;
  background: var(--bg-secondary);
}
.lib-row.is-folder {
  background: var(--bg-hover);
  margin-bottom: 2px;
}
.lib-row.is-folder:hover {
  background: color-mix(in srgb, var(--accent-blue) 10%, var(--bg-hover));
  border-color: color-mix(in srgb, var(--accent-blue) 30%, transparent);
}
.lib-row.is-folder.is-root-folder {
  font-weight: 700;
}
.lib-row.is-asset:hover {
  background: var(--bg-hover);
  border-color: var(--border-medium);
}
.lib-row.is-selected {
  background: var(--bg-active) !important;
  border-color: color-mix(in srgb, var(--accent-blue) 45%, transparent) !important;
}

/* Tree Indentation Guides */
.tree-guide-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-medium);
  pointer-events: none;
}
.lib-row:hover .tree-guide-line {
  background: var(--accent-blue);
}

.lib-row.is-transient .lib-name {
  font-style: italic;
  opacity: 0.75;
}
.lib-row.is-folder-drop-target {
  outline: 2px dashed var(--accent-blue);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent-blue) 18%, transparent);
}
.lib-row[draggable="true"] { cursor: grab; }
.lib-row[draggable="true"]:active { cursor: grabbing; }

.lib-icon {
  font-size: 0.95rem;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.lib-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.lib-name {
  font-size: 0.88rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  font-weight: 600;
  color: var(--text-primary);
}
.folder-title-text {
  font-weight: 700;
  letter-spacing: 0.01em;
}
.is-managed .lib-name {
  color: var(--text-primary);
}

.folder-count-badge {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  padding: 2px 7px;
  border-radius: 4px;
  border: 1px solid var(--border-medium);
  flex-shrink: 0;
}

.lib-time-pill {
  font-size: 0.78rem;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-medium);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  font-weight: 700;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

/* Debug menu */
.debug-menu-wrap { position: relative; }
.debug-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  min-width: 190px;
  display: flex;
  flex-direction: column;
  padding: 6px;
  gap: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-medium);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  z-index: 20;
}
.debug-menu-item {
  background: transparent;
  border: none;
  color: var(--text-primary);
  text-align: left;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.82rem;
  font-weight: 600;
}
.debug-menu-item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
}
.debug-menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 1280px) {
  .lib-toolbar {
    flex-wrap: wrap;
  }
  .toolbar-spacer { display: none; }
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
  flex-shrink: 0;
}

.mcr-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 800;
  padding: 2px 5px;
  border-radius: 3px;
  line-height: 1;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

/* Greek NCRTV Regulatory Color Codes */
.badge-age.age-k {
  background: #10b981;
  color: #fff;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.25);
}
.badge-age.age-8 {
  background: #06b6d4;
  color: #000;
  font-weight: 900;
  box-shadow: 0 0 6px rgba(6, 182, 212, 0.25);
}
.badge-age.age-12 {
  background: #eab308;
  color: #000;
  font-weight: 900;
  box-shadow: 0 0 6px rgba(234, 179, 8, 0.25);
}
.badge-age.age-16 {
  background: #f97316;
  color: #fff;
  box-shadow: 0 0 6px rgba(249, 115, 22, 0.25);
}
.badge-age.age-18 {
  background: #ef4444;
  color: #fff;
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.4);
}

.badge-tp {
  background: #ec4899;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.2);
  box-shadow: 0 0 6px rgba(236, 72, 153, 0.25);
}

.badge-content.content-movie { background: #3b82f6; color: #fff; }
.badge-content.content-show { background: #8b5cf6; color: #fff; }
.badge-content.content-documentary { background: #f59e0b; color: #000; font-weight: 800; }
.badge-content.content-news { background: #14b8a6; color: #fff; }

.chevron-icon {
  font-size: 0.65rem;
  color: var(--text-secondary);
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  transition: transform 0.15s ease, color 0.15s ease;
  margin-right: 2px;
  flex-shrink: 0;
}
.chevron-icon.is-expanded {
  transform: rotate(90deg);
  color: var(--accent-blue);
}
.chevron-icon:hover {
  color: var(--text-primary);
}
.chevron-spacer {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.folder-svg {
  width: 16px;
  height: 16px;
  display: block;
  transition: fill 0.15s ease;
  flex-shrink: 0;
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

/* Recycle Bin Toggle & Badges */
.recycle-bin-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(239, 68, 68, 0.1) !important;
  border-color: rgba(239, 68, 68, 0.3) !important;
  color: #fca5a5 !important;
}

.recycle-bin-toggle-btn:hover {
  background: rgba(239, 68, 68, 0.2) !important;
  border-color: #ef4444 !important;
  color: #fff !important;
}

.recycle-bin-count-badge {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 9999px;
  background: #ef4444;
  color: #fff;
  font-size: 0.65rem;
  font-weight: 800;
  line-height: 1;
}

/* Pulsing Danger Purge Dialog */
.purge-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.danger-pulse-box {
  background: #1c1315;
  border: 2px solid #ef4444;
  border-radius: 12px;
  width: 480px;
  max-width: 90vw;
  padding: 24px;
  box-shadow: 0 0 35px rgba(239, 68, 68, 0.35);
  animation: danger-pulse 2s infinite ease-in-out;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}

@keyframes danger-pulse {
  0% {
    box-shadow: 0 0 20px rgba(239, 68, 68, 0.3);
    border-color: #ef4444;
  }
  50% {
    box-shadow: 0 0 45px rgba(239, 68, 68, 0.7), 0 0 10px rgba(239, 68, 68, 0.5);
    border-color: #f87171;
  }
  100% {
    box-shadow: 0 0 20px rgba(239, 68, 68, 0.3);
    border-color: #ef4444;
  }
}

.purge-icon-circle {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.purge-dialog-title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 700;
  color: #fee2e2;
}

.purge-dialog-text {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  color: #cbd5e1;
}

.purge-warning-callout {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 11px;
  color: #fca5a5;
  text-align: left;
  margin-bottom: 20px;
}

.purge-warning-callout svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.purge-dialog-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  width: 100%;
}

.dialog-cancel-btn {
  flex: 1;
  padding: 9px 16px;
  background: #23272e;
  border: 1px solid #333842;
  border-radius: 6px;
  color: #cbd5e1;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.dialog-cancel-btn:hover:not(:disabled) {
  background: #2d3139;
  color: #fff;
}

.dialog-danger-btn {
  flex: 1;
  padding: 9px 16px;
  background: #dc2626;
  border: 1px solid #b91c1c;
  border-radius: 6px;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s ease;
}

.dialog-danger-btn:hover:not(:disabled) {
  background: #ef4444;
  box-shadow: 0 0 12px rgba(239, 68, 68, 0.5);
}
</style>
