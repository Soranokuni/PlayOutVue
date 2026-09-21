<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { refDebounced, useStorage } from '@vueuse/core';
import { invoke } from '@tauri-apps/api/core';
import { ask, save, message } from '@tauri-apps/plugin-dialog';
import { describePurgeOutcome } from '../lib/ingestorFeedback';
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
import { lazyComponent } from '../lib/lazyComponent';
import StatusIndicator from './StatusIndicator.vue';
import AppIcon from './ui/AppIcon.vue';
import { vTooltip } from '../lib/tooltip';
import type { IconName } from './ui/icons';
import { resolveLibraryStatusTone } from '../lib/statusResolver';

import ContextMenu, { type MenuItem, type MenuTone, type TopAction } from './ContextMenu.vue';
import { contentTypeTone, ratingBadge, ratingTone } from '../lib/menuTones';
import { GREEK_COMPLIANCE_PRESETS, GREEK_CONTENT_DESCRIPTORS, buildGreekAdvisoryText, parseDescriptorsFromText, type GreekCompliancePreset, type ContentDescriptorId } from '../lib/greekCompliance';
import { buildVirtualFolderTree, type VirtualFolderNode } from '../stores/mediaLibrary';
import { describeErrorMessage, rawErrorText } from '../lib/describeError';
import EmptyState from './ui/EmptyState.vue';
import BaseButton from './ui/BaseButton.vue';

// PERF F-14: pickers/bin are opened rarely; fetch on first open, mount only while open.
const { component: FolderPickerModal } = lazyComponent(
  'FolderPickerModal',
  () => import('./FolderPickerModal.vue'),
);
const { component: RecycleBinModal, preload: preloadRecycleBinModal } = lazyComponent(
  'RecycleBinModal',
  () => import('./RecycleBinModal.vue'),
);

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

const displayedFolderRows = computed<VisibleTreeRow[]>(() => {
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

        if (isExpanded) {
            for (const child of node.children) {
                traverse(child);
            }
        }
    };

    traverse(tree);
    return rows;
});

// "Unrated" filter (client guide §8.7): since PlayoutTranscode 1.0.0 a fresh
// ingest carries NONE instead of K, so "no age mark" is now the normal state of
// every new file and operators need a way to list what still needs classifying.
const showUnratedOnly = ref(false);

// §5.2: single-line is the default because the operator scans this list for a
// name; the two-line mode is opt-in for the sessions where "which folder is
// this in" is the question, and it is persisted per workstation.
const libraryRowMode = useStorage<'single' | 'two-line'>('layout.libraryRowMode', 'single');

function isUnrated(asset: LibraryAsset): boolean {
    return cachedRatingMeta(asset).ageRating === 'none';
}

const unratedCount = computed(() => {
    const deleted = new Set(mediaLibrary.deletedUuids);
    let n = 0;
    for (const a of mediaLibrary.assets) {
        if (!deleted.has(a.uuid) && isUnrated(a)) n++;
    }
    return n;
});

const displayedAssets = computed<LibraryAsset[]>(() => {
    const deleted = new Set(mediaLibrary.deletedUuids);
    const query = mediaLibrary.searchQuery.trim().toLowerCase();
    const unratedOnly = showUnratedOnly.value;

    return mediaLibrary.assets.filter(a => {
        if (deleted.has(a.uuid)) return false;
        if (unratedOnly && !isUnrated(a)) return false;

        if (query) {
            const name = (a.display_name || a.current_path || '').toLowerCase();
            return name.includes(query);
        }

        const cur = mediaLibrary.currentFolderPath || '/';
        if (cur === '/') return true;

        const vf = a.virtual_folder || '/';
        return vf === cur || vf.startsWith(cur + '/');
    });
});

/* ----------------------------------------------------------- §5.3 / F-22 ---
 * Folder-tree keyboard navigation. The rows were divs with click handlers and
 * no role, tabindex or key handling, so the pane was mouse-only and invisible
 * to a screen reader — while the asset rows beside them were already
 * `role="option"`.
 * -------------------------------------------------------------------------- */

const isFolderRowSelected = (row: VisibleTreeRow) =>
    mediaLibrary.selectedNodeId === row.id ||
    (mediaLibrary.currentFolderPath === row.path && !mediaLibrary.selectedAssetId);

/** Roving tabindex: one stop for the whole tree, on the selected row. */
const folderRowTabIndex = (row: VisibleTreeRow, index: number) => {
    if (isFolderRowSelected(row)) return 0;
    const anySelected = displayedFolderRows.value.some((candidate) => isFolderRowSelected(candidate));
    return !anySelected && index === 0 ? 0 : -1;
};

const folderPaneRef = ref<HTMLElement | null>(null);

/*
 * NOTE for whoever picks up §5.3 (folder-tree keyboard navigation).
 *
 * Arrow/Home/End keys cannot be handled here. OPERATOR-UI-CONTRACT §5 gives a
 * single capture-phase listener in `useOperatorShortcuts` ownership of every
 * key, and in `library` scope it already claims the arrows for
 * `library.selectPrevious` / `library.selectNext` (the *asset* list), calling
 * `preventDefault()` and `stopPropagation()`. A row-level `@keydown` never
 * runs, so adding one would only look like it worked.
 *
 * Doing this properly means new commands in `commandRegistry`
 * (`library.folderNext`, `library.folderExpand`, …) plus a folder cursor on
 * `activeLibraryContext`, routed from the one listener -- a change to the
 * keyboard contract's surface that deserves its own PR and its own routing
 * tests. The roles, levels and roving tabindex below stand on their own: they
 * are what a screen reader reads, and the pane had none of them.
 */

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

const formatTabularDuration = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainingSeconds = total % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(remainingSeconds).padStart(2, '0');
    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
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
        logIngestor('ingestor-list', `Local fallback scan failed: ${rawErrorText(error)}`, 'error');
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
        complianceDescriptors: meta.descriptors || [],
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

/**
 * §5.2: the content type left-bar and the two-line subline need the word, not
 * the enum. One map, so the rows, the tooltip and the subline never disagree.
 */
const CONTENT_TYPE_LABELS: Record<string, string> = {
    movie: 'Movie',
    show: 'Show',
    documentary: 'Documentary',
    news: 'News',
};

function contentTypeLabel(contentType: string): string {
    return CONTENT_TYPE_LABELS[contentType] ?? contentType.toUpperCase();
}

/** The rating chip carries TP as a dot; the tooltip is what spells it out. */
function assetFlagTooltip(asset: LibraryAsset): string {
    const meta = cachedRatingMeta(asset);
    const parts = [`Age rating ${meta.ageRating.toUpperCase()}`];
    if (meta.tpFlag) parts.push('Product placement (TP)');
    if (meta.contentType !== 'none') parts.push(contentTypeLabel(meta.contentType));
    return parts.join(' · ');
}

/** Second line of the two-line row: where the asset actually lives. */
function assetFolderLabel(asset: LibraryAsset): string {
    const folder = normalizeVirtualFolder(asset.virtual_folder);
    return folder === '/' ? 'All media' : folder.replace(/^\//, '').split('/').join(' › ');
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
        complianceDescriptors: meta.descriptors || [],
        complianceText: meta.advisoryText || meta.timeline[0]?.text || '',
        timeline: meta.timeline || [],
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
            const trashEl = document.elementFromPoint(clientX, clientY)
                ?.closest<HTMLElement>('.system-node-recycle-bin');
            if (trashEl) {
                doTrashAsset(asset.uuid);
                return true;
            }
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

const showActionsMenu = ref(false);

const inlineEditingAssetUuid = ref<string | null>(null);
const inlineRenameAssetValue = ref('');

function startRenameAsset(asset: LibraryAsset) {
    inlineEditingAssetUuid.value = asset.uuid;
    inlineRenameAssetValue.value = asset.display_name;
    nextTick(() => {
        const input = document.querySelector<HTMLInputElement>('.lib-inline-rename-asset');
        input?.focus();
        input?.select();
    });
}

async function commitInlineRenameAsset() {
    const uuid = inlineEditingAssetUuid.value;
    const newName = inlineRenameAssetValue.value.trim();
    inlineEditingAssetUuid.value = null;
    if (!uuid || !newName) return;
    const asset = mediaLibrary.assets.find(a => a.uuid === uuid);
    if (!asset || asset.display_name === newName) return;

    if (!asset.uuid.startsWith('local:')) {
        const result = await ingestorInvoke<void>(
            'rename_ingestor_asset',
            {
                uuid,
                displayName: newName,
                display_name: newName,
                apiBaseUrlOverride: null,
                api_base_url_override: null
            },
            'ingestor-rename'
        );
        if (result === null) return;
    }
    mediaLibrary.renameAsset(uuid, newName);
}

function cancelInlineRenameAsset() {
    inlineEditingAssetUuid.value = null;
}

const inlineEditingFolderPath = ref<string | null>(null);
const inlineRenameFolderValue = ref('');

function startRenameFolder(path: string) {
    if (path === '/') return;
    inlineEditingFolderPath.value = path;
    inlineRenameFolderValue.value = path.split('/').pop() || '';
    nextTick(() => {
        const input = document.querySelector<HTMLInputElement>('.lib-inline-rename-folder');
        input?.focus();
        input?.select();
    });
}

function commitInlineRenameFolder() {
    const oldPath = inlineEditingFolderPath.value;
    const newName = inlineRenameFolderValue.value.trim();
    inlineEditingFolderPath.value = null;
    if (!oldPath || !newName) return;
    mediaLibrary.renameTransientFolder(oldPath, newName);
}

function cancelInlineRenameFolder() {
    inlineEditingFolderPath.value = null;
}

const newFolderTooltip = computed(() => {
    const path = mediaLibrary.currentFolderPath;
    if (!path || path === '/') return 'New folder at root';
    const name = path.split('/').filter(Boolean).pop() ?? path;
    return `New folder in "${name}"`;
});

const isCreatingFolder = ref(false);
const newFolderNameValue = ref('');
const newFolderParentPath = ref('/');

function doNewVirtualFolder(parentPath?: string) {
    const base = parentPath || (contextMenu.value.node?.type === 'folder' ? contextMenu.value.node.virtualFolder : mediaLibrary.currentFolderPath) || '/';
    newFolderParentPath.value = base;
    newFolderNameValue.value = 'New Folder';
    isCreatingFolder.value = true;
    closeContextMenu();
    nextTick(() => {
        const input = document.querySelector<HTMLInputElement>('.lib-new-folder-input');
        input?.focus();
        input?.select();
    });
}

function commitNewVirtualFolder() {
    if (!isCreatingFolder.value) return;
    const name = newFolderNameValue.value.trim();
    const parent = newFolderParentPath.value;
    isCreatingFolder.value = false;
    newFolderNameValue.value = '';
    if (!name) return;
    mediaLibrary.createVirtualFolder(parent, name);
}

function cancelNewVirtualFolder() {
    newFolderNameValue.value = '';
    isCreatingFolder.value = false;
}

function doRenameFolder() {
    const node = contextMenu.value.node;
    if (!node || node.type !== 'folder' || node.virtualFolder === '/') return;
    startRenameFolder(node.virtualFolder);
    closeContextMenu();
}

function doRemoveFolder() {
    const node = contextMenu.value.node;
    if (!node || node.type !== 'folder') return;
    mediaLibrary.removeTransientFolder(node.virtualFolder);
    closeContextMenu();
}

function doRenameSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (asset) {
        startRenameAsset(asset);
    } else if (mediaLibrary.selectedNodeId?.startsWith('folder:')) {
        const path = mediaLibrary.selectedNodeId.slice(7);
        if (path !== '/') {
            startRenameFolder(path);
        }
    }
}

function doMoveSelected() {
    if (mediaLibrary.selectedAsset) {
        openMoveAssetModal();
    } else if (mediaLibrary.selectedNodeId?.startsWith('folder:')) {
        const path = mediaLibrary.selectedNodeId.slice(7);
        if (path !== '/') {
            openMoveFolderModal(path);
        }
    }
}

/// Audit T1-11: every path that moves library content to the Recycle Bin
/// (Delete key, actions menu, context menu, drag onto the bin) asks first,
/// with a native dialog. One prompt per gesture, not per item.
async function confirmTrash(description: string): Promise<boolean> {
    try {
        return await ask(`Move ${description} to the Recycle Bin?`, {
            title: 'Recycle Bin',
            kind: 'warning',
            okLabel: 'Move to Bin',
            cancelLabel: 'Cancel'
        });
    } catch (e) {
        console.error('[MediaLibrary] confirmation dialog unavailable; refusing trash', e);
        return false;
    }
}

async function doDeleteSelected() {
    const selectedIds = mediaLibrary.selectedAssetIds;
    if (selectedIds.length > 0) {
        if (!(await confirmTrash(`${selectedIds.length} selected item${selectedIds.length === 1 ? '' : 's'}`))) return;
        for (const uuid of selectedIds) {
            await doTrashAsset(uuid, true);
        }
    } else if (mediaLibrary.selectedAsset) {
        await doTrashAsset(mediaLibrary.selectedAsset.uuid);
    } else if (mediaLibrary.selectedNodeId?.startsWith('folder:')) {
        const path = mediaLibrary.selectedNodeId.slice(7);
        if (path !== '/') {
            await doTrashFolder(path);
        }
    }
}

const isTrashDragOver = ref(false);

async function onTrashDrop(event: DragEvent) {
    isTrashDragOver.value = false;
    event.preventDefault();
    if (event.dataTransfer) {
        const folderPath = event.dataTransfer.getData(FOLDER_DRAG_MIME);
        if (folderPath && folderPath !== '/') {
            await doTrashFolder(folderPath);
            return;
        }
    }
    const selectedIds = mediaLibrary.selectedAssetIds;
    if (selectedIds.length > 0) {
        if (!(await confirmTrash(`${selectedIds.length} dragged item${selectedIds.length === 1 ? '' : 's'}`))) return;
        for (const uuid of selectedIds) {
            await doTrashAsset(uuid, true);
        }
    } else if (mediaLibrary.selectedAsset) {
        await doTrashAsset(mediaLibrary.selectedAsset.uuid);
    }
}

async function doTrashAsset(uuid: string, alreadyConfirmed = false) {
    if (!alreadyConfirmed) {
        const asset = mediaLibrary.assets.find((a: any) => a.uuid === uuid);
        const label = asset?.display_name || asset?.current_path?.split(/[\\/]/).pop() || 'this asset';
        if (!(await confirmTrash(`"${label}"`))) return;
    }
    try {
        await mediaLibrary.trashAsset(uuid);
    } catch (e) {
        await message(describeErrorMessage(e, 'Could not move the asset to the Recycle Bin.'), { title: 'Recycle Bin Error', kind: 'error' });
    }
}

async function doTrashFolder(folderPath: string, alreadyConfirmed = false) {
    if (!alreadyConfirmed) {
        if (!(await confirmTrash(`folder "${folderPath}" and its contents`))) return;
    }
    try {
        await mediaLibrary.trashFolder(folderPath);
    } catch (e) {
        await message(describeErrorMessage(e, 'Could not move the folder to the Recycle Bin.'), { title: 'Recycle Bin Error', kind: 'error' });
    }
}

async function promptPurgeAsset(asset: LibraryAsset) {
    if (asset.uuid.startsWith('local:')) {
        await message("Cannot purge local fallback assets.", { title: 'Purge Asset', kind: 'warning' });
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
    const { isFolder, targetPathOrUuid, displayName } = purgeAlertModal.value;
    purgeAlertModal.value.show = false;
    try {
        const outcome = isFolder
            ? await mediaLibrary.purgeFolder(targetPathOrUuid)
            : await mediaLibrary.purgeAsset(targetPathOrUuid);
        await fetchAssets({ force: true });
        const note = describePurgeOutcome(outcome, displayName || targetPathOrUuid);
        if (note) {
            await message(note, { title: 'Purge completed with warnings', kind: 'warning' });
        }
    } catch (e) {
        await message(describeErrorMessage(e, 'Could not delete the item permanently.'), { title: 'Purge Error', kind: 'error' });
    }
}

function openTrimPanelForSelected() {
    const asset = mediaLibrary.selectedAsset;
    if (!asset) return;
    trimAsset.value = asset;
    showTrimPanel.value = true;
}

/**
 * Re-hydrate one asset from `GET /api/assets/{uuid}` and patch it into the
 * store. Returns false when the Ingestor could not answer, so the caller can
 * fall back to a full listing (client guide §4.1).
 */
async function refreshAssetFromApi(uuid: string): Promise<boolean> {
    if (!uuid || uuid.startsWith('local:')) return false;
    const fresh = await ingestorInvoke<any>(
        'resolve_ingestor_asset',
        { uuid, apiBaseUrlOverride: null },
        'ingestor-resolve'
    );
    if (!fresh || typeof fresh !== 'object' || !fresh.uuid) return false;
    mediaLibrary.upsertAsset(libraryAssetFromApi(fresh));
    return true;
}

const handleTrimSaved = async ({ uuid }: { uuid?: string }) => {
    if (!uuid) return;
    // A trim edit changes one row; a subclip creation registers one brand-new
    // asset. Either way a single `GET /api/assets/{uuid}` is enough - it also
    // carries the full keyframe_offsets the listing no longer includes. Only
    // fall back to re-downloading the whole library if that call fails.
    const patched = await refreshAssetFromApi(uuid);
    if (!patched) {
        await fetchAssets({ force: true });
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

const visibleAssetNodes = computed(() => {
    const displayedUuids = new Set(displayedAssets.value.map(a => a.uuid));
    return mediaLibrary.allTreeNodes.filter(
        (node) => node.type === 'asset' && node.asset && displayedUuids.has(node.asset.uuid)
    );
});

function onGlobalClick() {
    closeContextMenu();
    showActionsMenu.value = false;
}

onMounted(() => {
    activeLibraryContext.value = {
        getSelectedAssetIds: () => mediaLibrary.selectedAssetIds,
        getVisibleAssetIds: () => visibleAssetNodes.value.map((n) => n.asset?.uuid || n.id),
        selectPrevious: () => mediaLibrary.moveSelectionDelta(-1, visibleAssetNodes.value),
        selectNext: () => mediaLibrary.moveSelectionDelta(1, visibleAssetNodes.value),
        selectFirst: () => mediaLibrary.selectFirst(visibleAssetNodes.value),
        selectLast: () => mediaLibrary.selectLast(visibleAssetNodes.value),
        selectPage: (delta: -1 | 1, pageSize?: number) => {
            mediaLibrary.moveSelectionPage(delta, pageSize || 10, visibleAssetNodes.value);
            return true;
        },
        renameSelected: () => {
            doRenameSelected();
            return true;
        },
        trashSelected: () => {
            doDeleteSelected();
            return true;
        },
        getSelectedFolderId: () => {
            if (mediaLibrary.selectedNodeId?.startsWith('folder:')) {
                const path = mediaLibrary.selectedNodeId.slice(7);
                return path !== '/' ? path : null;
            }
            return null;
        },
        hasSelection: () => {
            if (mediaLibrary.selectedAssetIds.length > 0 || mediaLibrary.selectedAsset) return true;
            if (mediaLibrary.selectedNodeId?.startsWith('folder:')) {
                const path = mediaLibrary.selectedNodeId.slice(7);
                return path !== '/';
            }
            return false;
        },
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
        insertSelectedAfter: async (targetId: string | null = null): Promise<LibraryInsertResult> => {
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
        // PERF F-11 (lite): a hidden window cannot show a fresher library, so
        // skip the 30 s full refetch while hidden and catch up once visible.
        if (document.hidden) {
            libraryPollMissedWhileHidden = true;
            return;
        }
        runLibraryPoll();
    }, 30000);
    document.addEventListener('visibilitychange', onLibraryVisibilityChange);
    mediaLibrary.fetchFolderColors();
    mediaLibrary.fetchRecycleBin().catch(() => {});
    window.addEventListener('click', onGlobalClick);
});

let libraryPollMissedWhileHidden = false;
function runLibraryPoll() {
    if (isScanning.value) return;
    if (!ingestorStatus.isIngestorOnline) return;
    fetchAssets().catch(() => {});
    mediaLibrary.fetchRecycleBin().catch(() => {});
}
function onLibraryVisibilityChange() {
    if (document.hidden || !libraryPollMissedWhileHidden) return;
    libraryPollMissedWhileHidden = false;
    runLibraryPoll();
}

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
    document.removeEventListener('visibilitychange', onLibraryVisibilityChange);
    window.removeEventListener('click', onGlobalClick);
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

interface AgeRatingOption {
  /** Distinguishes "with explanation" from "badge only" in the menu (F-10). */
  icon?: IconName;
  id: ComplianceRating;
  label: string;
  logoOnly?: boolean;
}

const ageRatingOptions: AgeRatingOption[] = [
  { id: 'k', label: 'Κ — Κατάλληλο για όλους (με επεξήγηση)', icon: 'radio-on' },
  { id: '8', label: '8 — Κατάλληλο άνω των 8 (με επεξήγηση)', icon: 'radio-on' },
  { id: '12', label: '12 — Κατάλληλο άνω των 12 (με επεξήγηση)', icon: 'radio-on' },
  { id: '16', label: '16 — Κατάλληλο άνω των 16 (με επεξήγηση)', icon: 'radio-on' },
  { id: '18', label: '18 — Κατάλληλο άνω των 18 (με επεξήγηση)', icon: 'radio-on' },
  { id: 'k', label: 'Κ — Μόνο Σήμα (χωρίς επεξήγηση)', logoOnly: true, icon: 'tag' },
  { id: '8', label: '8 — Μόνο Σήμα (χωρίς επεξήγηση)', logoOnly: true, icon: 'tag' },
  { id: '12', label: '12 — Μόνο Σήμα (χωρίς επεξήγηση)', logoOnly: true, icon: 'tag' },
  { id: '16', label: '16 — Μόνο Σήμα (χωρίς επεξήγηση)', logoOnly: true, icon: 'tag' },
  { id: '18', label: '18 — Μόνο Σήμα (χωρίς επεξήγηση)', logoOnly: true, icon: 'tag' },
  { id: 'none', label: 'Χωρίς Σήμανση (none)', icon: 'close' }
];

async function ctxSetAgeRating(opt: AgeRatingOption) {
  const asset = contextMenu.value.node?.asset;
  if (asset) {
    const meta = cachedRatingMeta(asset);
    const isLogoOnly = !!opt.logoOnly;
    const currentText = meta.advisoryText || '';
    const newText = isLogoOnly ? '__LOGO_ONLY__' : (currentText === '__LOGO_ONLY__' ? '' : currentText);
    await mediaLibrary.updateAssetMetadata(asset.uuid, {
      complianceRating: opt.id,
      complianceText: newText
    });
  }
  closeContextMenu();
}

async function ctxToggleDescriptor(descriptorId: ContentDescriptorId) {
  const asset = contextMenu.value.node?.asset;
  if (asset) {
    const meta = cachedRatingMeta(asset);
    const current: ContentDescriptorId[] = Array.isArray(meta.descriptors)
      ? [...(meta.descriptors as ContentDescriptorId[])]
      : [];
    const idx = current.indexOf(descriptorId);
    if (idx >= 0) {
      current.splice(idx, 1);
    } else {
      current.push(descriptorId);
    }
    const newText = buildGreekAdvisoryText(current);
    await mediaLibrary.updateAssetMetadata(asset.uuid, {
      complianceDescriptors: current,
      complianceText: newText,
      timeline: newText ? [{ start: 0, end: 30000, text: newText }] : []
    });
  }
  closeContextMenu();
}

async function ctxClearDescriptors() {
  const asset = contextMenu.value.node?.asset;
  if (asset) {
    await mediaLibrary.updateAssetMetadata(asset.uuid, {
      complianceDescriptors: [],
      complianceText: '',
      timeline: []
    });
  }
  closeContextMenu();
}

async function ctxApplyCompliancePreset(preset: GreekCompliancePreset) {
  const asset = contextMenu.value.node?.asset;
  if (asset) {
    await mediaLibrary.updateAssetMetadata(asset.uuid, {
      complianceRating: preset.ageRating,
      complianceDescriptors: parseDescriptorsFromText(preset.advisoryText),
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
  // Folder colours are operator data, not theme: the chosen hex is persisted
  // per folder and must render identically in every theme. These are the only
  // colour literals the lint guard allows in this file.
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
      tone: 'accent',
      tooltip: 'Trim asset',
      action: ctxTrim,
      disabled: false
    },
    {
      id: 'rename',
      tone: 'accent',
      tooltip: 'Rename asset',
      action: ctxRename,
      disabled: false
    },
    {
      id: 'delete',
      tone: 'warning',
      icon: 'restore',
      tooltip: 'Move to Recycle Bin',
      action: ctxDelete,
      disabled: false
    },
    {
      // §9: "Purge" named an implementation. The only icon-only control in
      // this bar that destroys media permanently is also the only red one.
      id: 'purge',
      tone: 'danger',
      tooltip: 'Delete permanently',
      action: ctxPurge,
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
    
    const descriptorCount = Array.isArray(ratingMeta.descriptors) ? ratingMeta.descriptors.length : 0;

    return [
      { type: 'label', label: 'Asset' },
      {
        type: 'action',
        icon: 'inspect',
        tone: 'accent',
        label: 'Inspect clip',
        shortcut: 'Ctrl+I',
        action: ctxInspect
      },
      {
        // The two rows that put media into the rundown share the tone the
        // rundown's own "cued" state uses.
        type: 'action',
        icon: 'arrow-right',
        tone: 'cued',
        label: 'Add to end',
        disabled: store.isRundownLocked,
        action: ctxAppend
      },
      {
        type: 'action',
        icon: 'arrow-right',
        tone: 'cued',
        label: 'Insert after selection',
        disabled: store.isRundownLocked,
        action: ctxInsertAfter
      },
      { type: 'divider' },
      { type: 'label', label: 'Compliance' },
      {
        type: 'submenu',
        id: 'compliance-rating',
        icon: 'shield',
        tone: ratingTone(ratingMeta.ageRating),
        badge: ratingBadge(ratingMeta.ageRating),
        label: 'Σήματα καταλληλότητας (age rating)',
        children: ageRatingOptions.map(r => {
          const itemRating = ratingMeta.ageRating || 'none';
          const itemIsLogoOnly = ratingMeta.advisoryText === '__LOGO_ONLY__';
          let isChecked = false;
          if (r.id === 'none') {
            isChecked = itemRating === 'none';
          } else if (r.logoOnly) {
            isChecked = itemRating === r.id && itemIsLogoOnly;
          } else {
            isChecked = itemRating === r.id && !itemIsLogoOnly;
          }
          return {
            type: 'action' as const,
            icon: r.icon,
            tone: ratingTone(r.id),
            badge: r.id === 'none' ? undefined : ratingBadge(r.id),
            label: r.label,
            checked: isChecked,
            action: () => ctxSetAgeRating(r)
          };
        })
      },
      {
        type: 'submenu',
        id: 'compliance-descriptors',
        icon: 'alert',
        tone: descriptorCount > 0 ? 'warning' : 'neutral',
        badge: descriptorCount > 0 ? String(descriptorCount) : undefined,
        label: 'Προειδοποιήσεις περιεχομένου (content warnings)',
        children: [
          ...GREEK_CONTENT_DESCRIPTORS.map(d => {
            const isChecked = Array.isArray(ratingMeta.descriptors) && ratingMeta.descriptors.includes(d.id);
            return {
              type: 'action' as const,
              icon: (isChecked ? 'square-check' : 'square') as IconName,
              tone: (isChecked ? 'warning' : 'neutral') as MenuTone,
              label: d.label,
              checked: isChecked,
              action: () => ctxToggleDescriptor(d.id)
            };
          }),
          {
            type: 'action' as const,
            icon: 'broom' as IconName,
            tone: 'danger' as MenuTone,
            label: 'Καθαρισμός προειδοποιήσεων',
            disabled: !ratingMeta.descriptors || ratingMeta.descriptors.length === 0,
            action: ctxClearDescriptors
          }
        ]
      },
      {
        type: 'toggle',
        icon: ratingMeta.tpFlag ? 'square-check' : 'square',
        tone: ratingMeta.tpFlag ? 'rating-tp' : 'neutral',
        badge: ratingMeta.tpFlag ? 'TP' : undefined,
        label: 'Προβολή προϊόντος (product placement, TP)',
        checked: ratingMeta.tpFlag,
        action: ctxToggleTP
      },
      {
        type: 'submenu',
        id: 'content-type',
        icon: 'layers',
        tone: contentTypeTone(ratingMeta.contentType),
        label: 'Content type',
        children: contentTypeOptions.map(ct => ({
          type: 'action',
          icon: (ratingMeta.contentType === ct.id ? 'radio-on' : 'radio-off') as IconName,
          tone: contentTypeTone(ct.id),
          label: ct.label,
          checked: ratingMeta.contentType === ct.id,
          action: () => ctxSetContentType(ct.id)
        }))
      },
      { type: 'divider' },
      { type: 'label', label: 'Manage' },
      {
        type: 'action',
        icon: 'folder-open',
        label: 'Move to…',
        action: () => openMoveAssetModal(asset)
      },
      {
        // Reversible: the bin keeps it. Amber, not red -- reserving red for
        // the one row below it that cannot be undone is what makes red mean
        // anything here.
        type: 'action',
        icon: 'restore',
        tone: 'warning',
        label: 'Move to Recycle Bin',
        shortcut: 'Del',
        action: () => doTrashAsset(asset.uuid)
      },
      {
        type: 'action',
        icon: 'trash',
        tone: 'danger',
        danger: true,
        label: 'Delete permanently…',
        action: () => promptPurgeAsset(asset)
      }
    ];
  } else if (node.type === 'folder') {
    const isRoot = node.virtualFolder === '/';
    const folderItems: MenuItem[] = [
      { type: 'label', label: 'Folder' },
      {
        type: 'action',
        icon: 'folder-plus',
        tone: 'accent',
        label: 'New subfolder here',
        action: () => doNewVirtualFolder(node.virtualFolder)
      }
    ];

    if (!isRoot) {
      folderItems.push({
        type: 'action',
        icon: 'folder-open',
        label: 'Move folder to…',
        action: () => openMoveFolderModal(node.virtualFolder)
      });
      folderItems.push({
        type: 'action',
        icon: 'rename',
        label: 'Rename folder',
        shortcut: 'F2',
        action: doRenameFolder
      });
      folderItems.push({ type: 'divider' });
      folderItems.push({
        type: 'action',
        icon: 'restore',
        tone: 'warning',
        label: 'Move folder to Recycle Bin',
        action: () => doTrashFolder(node.virtualFolder)
      });
      folderItems.push({
        type: 'action',
        icon: 'trash',
        tone: 'danger',
        danger: true,
        label: 'Delete folder permanently…',
        action: () => promptPurgeFolder(node.virtualFolder)
      });
    }

    if (node.isTransient) {
      folderItems.push({
        type: 'action',
        icon: 'close',
        tone: 'warning',
        label: 'Remove empty placeholder',
        action: doRemoveFolder
      });
    }

    folderItems.push({ type: 'divider' });
    folderItems.push({
      // A list of ten colour *names* is a colour picker that shows no colour.
      // Each row carries its own swatch, and so does the parent, so the current
      // folder colour is visible without opening the submenu.
      type: 'submenu',
      icon: 'palette',
      label: 'Folder colour',
      swatch: node.color || undefined,
      children: [
        ...folderColorsPreset.map(c => ({
          type: 'action' as const,
          label: c.label,
          swatch: c.hex,
          checked: node.color === c.hex,
          action: () => ctxSetFolderColor(c.hex)
        })),
        { type: 'divider' as const },
        {
          type: 'action' as const,
          icon: 'close' as IconName,
          label: 'Reset colour',
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
          <BaseButton
            variant="ghost"
            size="sm"
            :title="showDebugMenu ? 'Close debug menu' : 'Open debug menu'"
            @click.stop="showDebugMenu = !showDebugMenu"
          >
            Debug
          </BaseButton>
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
        <BaseButton
          variant="icon"
          size="sm"
          icon="refresh"
          :class="{ 'is-spinning': isScanning }"
          :disabled="isScanning"
          label="Refresh from Ingestor"
          v-tooltip="isScanning ? 'Refreshing…' : 'Refresh from Ingestor'"
          @click="fetchAssets({ force: true })"
        />
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
      <BaseButton
        v-if="libraryQuery"
        class="lib-search-clear"
        variant="icon"
        size="sm"
        icon="close"
        label="Clear search"
        v-tooltip="'Clear search'"
        @click="libraryQuery = ''"
      />
      <BaseButton
        class="lib-filter-unrated"
        variant="ghost"
        size="sm"
        icon="shield"
        :class="{ active: showUnratedOnly }"
        :aria-pressed="showUnratedOnly"
        v-tooltip="showUnratedOnly ? 'Showing only unrated assets — click to show all' : 'Show only assets nobody has classified yet'"
        data-testid="filter-unrated"
        @click="showUnratedOnly = !showUnratedOnly"
      >
        <span class="lib-filter-word">Unrated</span>
        <span v-if="unratedCount > 0" class="lib-filter-count">{{ unratedCount }}</span>
      </BaseButton>
      <BaseButton
        class="lib-row-mode-toggle"
        variant="icon"
        size="sm"
        :icon="libraryRowMode === 'two-line' ? 'rows-two' : 'rows-one'"
        :class="{ active: libraryRowMode === 'two-line' }"
        :aria-pressed="libraryRowMode === 'two-line'"
        label="Toggle row density"
        v-tooltip="libraryRowMode === 'two-line' ? 'Two-line rows — click for compact rows' : 'Compact rows — click to show the folder path under each name'"
        data-testid="toggle-row-mode"
        @click="libraryRowMode = libraryRowMode === 'two-line' ? 'single' : 'two-line'"
      />

      <!-- Actions Dropdown -->
      <div class="lib-actions-dropdown-wrap">
        <BaseButton
          class="lib-actions-trigger"
          variant="icon"
          size="sm"
          icon="more-vertical"
          label="Asset and folder actions"
          v-tooltip="showActionsMenu ? 'Close actions menu' : 'Asset and folder actions'"
          @click.stop="showActionsMenu = !showActionsMenu"
        />
        <div v-if="showActionsMenu" class="lib-actions-menu popover-surface" role="menu" @click.stop>
          <button
            class="lib-actions-item popover-item"
            :disabled="!mediaLibrary.selectedAsset && (!mediaLibrary.selectedNodeId?.startsWith('folder:') || mediaLibrary.selectedNodeId === 'folder:/')"
            @click="doRenameSelected(); showActionsMenu = false"
          >
            <AppIcon name="rename" :size="14" />
            <span>Rename</span>
          </button>
          <button
            class="lib-actions-item popover-item"
            :disabled="!mediaLibrary.selectedAsset && (!mediaLibrary.selectedNodeId?.startsWith('folder:') || mediaLibrary.selectedNodeId === 'folder:/')"
            @click="doMoveSelected(); showActionsMenu = false"
          >
            <AppIcon name="folder-open" :size="14" />
            <span>Move</span>
          </button>
          <button
            class="lib-actions-item popover-item popover-item--danger"
            :disabled="!mediaLibrary.selectedAsset && (!mediaLibrary.selectedNodeId?.startsWith('folder:') || mediaLibrary.selectedNodeId === 'folder:/')"
            @click="doDeleteSelected(); showActionsMenu = false"
          >
            <AppIcon name="trash" :size="14" />
            <span>Delete</span>
          </button>
        </div>
      </div>
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
          <BaseButton variant="ghost" size="sm" @click="refreshDebugPanel">Refresh</BaseButton>
          <BaseButton variant="ghost" size="sm" :disabled="!diagnosticEntries.length" @click="exportDiagnostics">Export</BaseButton>
          <BaseButton variant="ghost" size="sm" :disabled="!diagnosticEntries.length" @click="clearDiagnostics">Clear</BaseButton>
          <BaseButton variant="ghost" size="sm" @click="showDebugPanel = false">Close</BaseButton>
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

    <!-- §5.3: while a search is active the folder filter is suspended, which
         used to happen silently -- the operator saw results from folders they
         had not opened with no indication why. -->
    <div v-if="libraryQuery" class="lib-search-scope">
      <AppIcon name="search" :size="14" />
      <span>Searching all folders · {{ displayedAssets.length }} result{{ displayedAssets.length === 1 ? '' : 's' }}</span>
      <BaseButton variant="ghost" size="sm" @click="libraryQuery = ''">Clear</BaseButton>
      <div class="lib-crumb-spacer" />
      <BaseButton
        class="lib-new-folder-btn"
        variant="icon"
        size="sm"
        icon="folder-plus"
        disabled
        label="New folder"
        v-tooltip="'Clear the search first — a new folder is created in the folder you are looking at'"
      />
    </div>

    <!-- Active Path Breadcrumb Bar -->
    <div v-else class="lib-breadcrumb-bar">
      <AppIcon class="breadcrumb-icon" name="folder" :size="14" />
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
      <div class="lib-crumb-spacer" />
      <BaseButton
        class="lib-new-folder-btn"
        variant="icon"
        size="sm"
        icon="folder-plus"
        label="New folder"
        v-tooltip="newFolderTooltip"
        @click="() => doNewVirtualFolder()"
      />
    </div>

    <!-- Two-Pane Explorer Split -->
    <!-- Top Pane: Folder Tree & Navigation -->
    <div class="lib-folder-pane custom-scroll" ref="folderPaneRef">
      <!-- §7.7: a scan takes seconds against a cold Ingestor. Three ghost rows
           say "results are coming, and they will look like this" where
           "Loading…" said only that something was happening somewhere. -->
      <div v-if="isScanning && !displayedFolderRows.length" class="lib-skeleton" aria-hidden="true">
        <div v-for="n in 3" :key="n" class="lib-skeleton-row">
          <span class="lib-skeleton-box lib-skeleton-icon"></span>
          <span class="lib-skeleton-box lib-skeleton-name"></span>
          <span class="lib-skeleton-box lib-skeleton-meta"></span>
        </div>
      </div>
      <EmptyState
        v-else-if="displayedFolderRows.length === 0"
        compact
        icon="folder"
        title="No folders yet"
        hint="Folders appear once assets are filed into them."
      />
      <div v-else class="lib-folder-tree" role="tree" aria-label="Virtual folders">
        <div
          v-for="(row, rowIndex) in displayedFolderRows"
          :key="row.key"
          class="lib-row is-folder"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-expanded="row.hasChildren ? row.isExpanded : undefined"
          :aria-selected="isFolderRowSelected(row)"
          :tabindex="folderRowTabIndex(row, rowIndex)"
          :class="{
            'is-selected': isFolderRowSelected(row),
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
            v-if="row.hasChildren"
            class="chevron-icon"
            :class="{ 'is-expanded': row.isExpanded }"
            @click.stop="expandedFolders[row.path] = !row.isExpanded"
          >
            <AppIcon name="chevron-right" :size="14" :stroke-width="2.5" />
          </span>
          <span v-else class="chevron-spacer"></span>

          <span class="lib-icon" @click.stop="onFolderClick(row.path)">
            <svg
              class="folder-svg"
              viewBox="0 0 24 24"
              :style="{ fill: row.color || 'var(--accent-blue)' }"
            >
              <path v-if="row.isExpanded" d="M19 5.5h-7.28l-2-2H4c-1.1 0-2 .9-2 2v13c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-11c0-1.1-.9-2-2-2zm0 13H4v-11h16v11z"/>
              <path v-else d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
            </svg>
          </span>

          <span class="lib-text">
            <input
              v-if="inlineEditingFolderPath === row.path"
              v-model="inlineRenameFolderValue"
              class="lib-inline-rename lib-inline-rename-folder"
              type="text"
              @click.stop
              @keydown.enter.stop="commitInlineRenameFolder"
              @keydown.esc.stop="cancelInlineRenameFolder"
              @blur="commitInlineRenameFolder"
            />
            <span v-else class="lib-name folder-title-text">{{ row.displayName }}</span>
          </span>

          <span v-if="row.allAssetCount !== undefined" class="folder-count-badge">
            {{ row.allAssetCount }}
          </span>
        </div>

        <!-- Inline creating new folder -->
        <div
          v-if="isCreatingFolder"
          class="lib-row is-folder is-new-folder"
          :style="{ paddingLeft: '26px' }"
        >
          <span class="chevron-spacer"></span>
          <span class="lib-icon"><AppIcon name="folder" :size="16" /></span>
          <input
            v-model="newFolderNameValue"
            class="lib-inline-rename lib-new-folder-input"
            type="text"
            placeholder="New folder name…"
            @click.stop
            @keydown.enter.stop="commitNewVirtualFolder"
            @keydown.esc.stop="cancelNewVirtualFolder"
            @blur="commitNewVirtualFolder"
          />
        </div>
      </div>

      <!-- Persistent Recycle Bin Node -->
      <div
        class="system-node-recycle-bin"
        :class="{ 'is-drag-target': isTrashDragOver }"
        v-tooltip="'Recycle Bin — drag assets here to delete'"
        @pointerenter="preloadRecycleBinModal()"
        @click="showRecycleBin = true"
        @dragover.prevent="isTrashDragOver = true"
        @dragleave="isTrashDragOver = false"
        @drop.prevent="onTrashDrop($event)"
      >
        <span class="lib-icon"><AppIcon name="trash" :size="16" /></span>
        <span class="lib-text">Recycle Bin</span>
        <span v-if="mediaLibrary.recycleBinAssets.length > 0" class="recycle-bin-count-badge">
          {{ mediaLibrary.recycleBinAssets.length }}
        </span>
      </div>
    </div>

    <!-- Resizable / Visual Divider -->
    <div class="lib-pane-divider"></div>

    <!-- Bottom Pane: High-Density Asset Table -->
    <div
      ref="libTreeRef"
      class="lib-asset-pane custom-scroll"
      data-command-scope="library"
      role="listbox"
      aria-label="Media library assets"
      aria-multiselectable="true"
      tabindex="0"
      @focus="activeScope = 'library'"
      @contextmenu.prevent
    >
      <!-- §7.7: a scan takes seconds against a cold Ingestor. Three ghost rows
           say "results are coming, and they will look like this" where
           "Loading…" said only that something was happening somewhere. -->
      <div v-if="isScanning && !displayedAssets.length" class="lib-skeleton" aria-hidden="true">
        <div v-for="n in 3" :key="n" class="lib-skeleton-row">
          <span class="lib-skeleton-box lib-skeleton-icon"></span>
          <span class="lib-skeleton-box lib-skeleton-name"></span>
          <span class="lib-skeleton-box lib-skeleton-meta"></span>
        </div>
      </div>
      <EmptyState
        v-else-if="displayedAssets.length === 0"
        compact
        :icon="libraryQuery ? 'search' : 'film'"
        :title="libraryQuery ? 'No matching assets' : 'No media in this folder'"
        :hint="libraryQuery ? 'Try a shorter search, or clear it to browse folders again.' : 'Point Settings › Media & ingest at the Ingestor API or a media folder.'"
      />
      <div v-else class="lib-asset-list" :class="`row-mode-${libraryRowMode}`">
        <div
          v-for="asset in displayedAssets"
          :key="asset.uuid"
          class="lib-row is-asset"
          :class="{
            'is-selected': isAssetSelected(asset.uuid),
            'is-two-line': libraryRowMode === 'two-line'
          }"
          role="option"
          :data-asset-id="asset.uuid"
          :data-content-type="cachedRatingMeta(asset).contentType"
          :aria-selected="isAssetSelected(asset.uuid)"
          :tabindex="isAssetPrimarySelected(asset.uuid) ? 0 : -1"
          @click="onAssetClick(asset, $event)"
          @dblclick="onAssetDoubleClick(asset)"
          @contextmenu.prevent="onAssetContextMenu($event, asset)"
          @pointerdown="onAssetPointerDown($event, asset)"
        >
          <!-- §5.2: content type is a 3 px left tint bar, not a chip. A chip
               competed with the rating for the width the title needed; the bar
               costs nothing and the tooltip carries the word. -->
          <span
            v-if="cachedRatingMeta(asset).contentType !== 'none'"
            class="lib-type-bar"
            :title="contentTypeLabel(cachedRatingMeta(asset).contentType)"
            aria-hidden="true"
          />

          <span class="lib-icon" @click.stop="onAssetClick(asset)">
            <StatusIndicator
              v-if="resolveLibraryStatusTone(asset, settings.qcSensitivity) !== 'ready'"
              :tone="resolveLibraryStatusTone(asset, settings.qcSensitivity)"
              variant="dot"
              :tooltip="getAssetTooltip(asset)"
            />
            <AppIcon name="film" :size="16" />
          </span>

          <span class="lib-text" :class="{ 'is-managed': !asset.uuid.startsWith('local:') }">
            <span class="lib-name-wrap">
              <input
                v-if="inlineEditingAssetUuid === asset.uuid"
                v-model="inlineRenameAssetValue"
                class="lib-inline-rename lib-inline-rename-asset"
                type="text"
                @click.stop
                @keydown.enter.stop="commitInlineRenameAsset"
                @keydown.esc.stop="cancelInlineRenameAsset"
                @blur="commitInlineRenameAsset"
              />
              <span v-else class="lib-name" :title="asset.display_name">{{ asset.display_name }}</span>
              <span class="mcr-badges">
                <span
                  v-if="cachedRatingMeta(asset).ageRating !== 'none'"
                  data-testid="age-rating-badge"
                  class="mcr-badge badge-age"
                  :class="[`age-${cachedRatingMeta(asset).ageRating}`, { 'has-tp': cachedRatingMeta(asset).tpFlag }]"
                  :title="assetFlagTooltip(asset)"
                >
                  {{ cachedRatingMeta(asset).ageRating.toUpperCase() }}
                  <!-- §5.2: TP rides the rating chip as a dot rather than
                       spending a second chip's width on two letters. -->
                  <span v-if="cachedRatingMeta(asset).tpFlag" class="badge-tp-dot" aria-hidden="true" />
                </span>
                <!-- §5.2: with the Unrated filter on, every row is unrated, so
                     the chip says nothing and only costs title width. -->
                <span
                  v-else-if="!showUnratedOnly"
                  data-testid="unrated-badge"
                  class="mcr-badge badge-unrated"
                  title="Unrated - nobody has classified this asset yet"
                >Unrated</span>
                <span
                  v-if="cachedRatingMeta(asset).tpFlag && cachedRatingMeta(asset).ageRating === 'none'"
                  class="mcr-badge badge-tp"
                  title="Product placement (TP)"
                >TP</span>
              </span>
            </span>
            <span v-if="libraryRowMode === 'two-line'" class="lib-subline">
              <span class="lib-subline-path">{{ assetFolderLabel(asset) }}</span>
              <span v-if="cachedRatingMeta(asset).contentType !== 'none'" class="lib-subline-type">
                {{ contentTypeLabel(cachedRatingMeta(asset).contentType) }}
              </span>
            </span>
          </span>

          <span v-if="effectiveDurationSeconds(asset) > 0" class="lib-time-pill tabular-duration">
            {{ formatTabularDuration(effectiveDurationSeconds(asset)) }}
          </span>

          <button
            class="lib-row-action-btn"
            title="Asset actions"
            aria-label="Asset actions"
            @click.stop="onAssetContextMenu($event, asset)"
          >
            <AppIcon name="more-vertical" :size="16" />
          </button>
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

    <!-- Folder Picker Modal -->
    <FolderPickerModal
      v-if="showFolderPicker"
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
  padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
  background: var(--bg-secondary);
}
.lib-header-actions { display: flex; align-items: center; gap: var(--space-2); }
.lib-header-copy { display: flex; flex-direction: column; gap: var(--space-0); }
.lib-title { font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--text-primary); }
.lib-subtitle { color: var(--text-secondary); font-size: var(--fs-xs); }

/* §2.1: one row, fixed priority order, never wrapping. It used to be
   `flex-wrap: wrap`, so at a narrow library width the `New` button dropped to
   a second line and the toolbar silently grew 30 px taller. The only flexible
   child is the search field; everything else is its natural width. */
.lib-toolbar {
  container: library-toolbar / inline-size;
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-panel-header);
  box-shadow: var(--shadow-highlight);
  flex-shrink: 0;
  min-width: 0;
}
.lib-search {
  flex: 1 1 120px;
  min-width: 0;
}
.lib-toolbar > .btn {
  flex: 0 0 auto;
}
.lib-filter-unrated.active {
  background: color-mix(in srgb, var(--accent-blue) 22%, var(--bg-hover));
  border-color: var(--accent-blue);
  color: var(--text-primary);
}
.lib-row-mode-toggle.active {
  background: color-mix(in srgb, var(--accent-blue) 22%, var(--bg-hover));
  color: var(--text-primary);
}
.lib-filter-count {
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.lib-filter-unrated.active .lib-filter-count {
  background: var(--accent-blue);
  color: var(--text-on-accent);
}

/* Below ~300 px of toolbar the word is the first thing to go: the shield glyph
   and the count still say "n unrated", and the word stays in the tooltip. */
@container library-toolbar (max-width: 300px) {
  .lib-filter-word {
    display: none;
  }
}

.lib-debug-panel {
  padding: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex-shrink: 0;
}
.debug-toolbar {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  align-items: flex-start;
}
.debug-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-0);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}
.debug-actions {
  display: flex;
  gap: var(--space-2);
}
.debug-meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--fs-xs);
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
  border-radius: var(--radius-md);
  background: var(--bg-primary);
}
.debug-empty {
  color: var(--text-muted);
  font-size: var(--fs-xs);
  padding: var(--space-3);
}
.debug-entry {
  display: grid;
  grid-template-columns: 60px 48px 54px 1fr;
  gap: var(--space-2);
  padding: var(--space-2);
  font-size: var(--fs-xs);
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

.lib-folder-pane {
  flex: 0 0 35%;
  min-height: 110px;
  max-height: 48%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: var(--space-1) var(--space-2);
}
.lib-folder-tree {
  flex: 1;
}
.lib-pane-divider {
  height: 1px;
  background: var(--border-medium);
  flex-shrink: 0;
  margin: 0;
}
.lib-asset-pane {
  flex: 1 1 65%;
  min-height: 120px;
  overflow-y: auto;
  padding: var(--space-1) var(--space-2);
  outline: none;
}
.lib-asset-list {
  display: flex;
  flex-direction: column;
}
.lib-asset-pane .lib-row.is-asset {
  content-visibility: auto;
  contain-intrinsic-size: 38px;
}

.system-node-recycle-bin {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  margin: var(--space-2) var(--space-1) var(--space-0) var(--space-1);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  border: 1px dashed var(--border-medium);
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  font-size: var(--fs-sm);
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  flex-shrink: 0;
}
.system-node-recycle-bin:hover,
.system-node-recycle-bin.is-drag-target {
  background: color-mix(in srgb, var(--accent-red) 14%, var(--bg-secondary));
  border-color: var(--accent-red);
  color: var(--accent-red);
}
.system-node-recycle-bin .lib-icon {
  font-size: var(--fs-lg);
}
.system-node-recycle-bin .lib-text {
  flex: 1;
  font-weight: var(--fw-semibold);
}

.lib-actions-dropdown-wrap {
  position: relative;
}
/* Everything but position comes from `.popover-surface` / `.popover-item`. */
.lib-actions-menu {
  position: absolute;
  top: calc(100% + var(--space-1));
  right: 0;
  z-index: var(--z-popover);
  min-width: 160px;
  display: flex;
  flex-direction: column;
  gap: var(--space-0);
}

.lib-inline-rename {
  background: var(--bg-input);
  border: 1px solid var(--accent-blue);
  color: var(--text-primary);
  font-size: var(--fs-md);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  width: 100%;
  outline: none;
}
.lib-row.is-new-folder {
  background: color-mix(in srgb, var(--accent-blue) 10%, var(--bg-hover));
}

.lib-row-action-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: var(--fs-lg);
  padding: var(--space-0) var(--space-2);
  cursor: pointer;
  border-radius: var(--radius-sm);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
  margin-left: var(--space-0);
  flex-shrink: 0;
}
.lib-row.is-asset:hover .lib-row-action-btn {
  opacity: 1;
}
.lib-row-action-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.lib-time-pill.tabular-duration {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--tracking-caps);
}

.lib-empty { color: var(--text-muted); font-size: var(--fs-md); text-align: center; padding: var(--space-5) var(--space-3); line-height: var(--lh-body); white-space: pre-line; }

/* §7.7: the scanning skeleton. The shimmer is an overlay whose opacity
   animates -- never the row's own background, which is a perf-backlog
   violation on a surface that is on screen for the whole scan. */
.lib-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
}
.lib-skeleton-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--row-h-library);
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  background: var(--bg-hover);
}
.lib-skeleton-box {
  position: relative;
  overflow: hidden;
  height: 10px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--text-muted) 22%, transparent);
}
.lib-skeleton-icon { width: 14px; height: 14px; border-radius: var(--radius-sm); flex-shrink: 0; }
.lib-skeleton-name { flex: 1 1 auto; max-width: 240px; }
.lib-skeleton-meta { width: 48px; flex-shrink: 0; }

.lib-skeleton-box::after {
  content: '';
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--text-primary) 18%, transparent);
  opacity: 0;
  /* §3.4: `onair-pulse` in main.css is the app's one heartbeat. A shimmer and
     an on-air pill are the same device at the same tempo; they were 1.4s and
     1.6s only because they were written on different days. */
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
}
.lib-skeleton-row:nth-child(2) .lib-skeleton-box::after { animation-delay: var(--dur-fast); }
.lib-skeleton-row:nth-child(3) .lib-skeleton-box::after { animation-delay: var(--dur-slow); }


.glass-input {
  background: var(--bg-input); border: 1px solid var(--border-medium);
  color: var(--text-primary); border-radius: var(--radius-md); font-size: var(--fs-md); padding: var(--space-2) var(--space-3);
}
.glass-input:focus {
  border-color: var(--accent-primary);
  box-shadow: var(--glow-accent);
}


/* Breadcrumbs bar */
.lib-breadcrumb-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--fs-sm);
  flex-shrink: 0;
}
.breadcrumb-icon {
  font-size: var(--fs-md);
  color: var(--accent-blue);
  flex-shrink: 0;
}
/* §2.1: the trail yields its width to the New folder button rather than
   pushing it off the end. */
.lib-crumb-spacer {
  flex: 1 1 0;
  min-width: 0;
}
.lib-new-folder-btn {
  flex: 0 0 auto;
}
.breadcrumb-trail {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  color: var(--text-secondary);
}
.breadcrumb-crumb {
  cursor: pointer;
  font-weight: var(--fw-semibold);
  transition: color var(--dur-fast) var(--ease-out);
}
.breadcrumb-crumb:hover {
  color: var(--accent-blue);
  text-decoration: underline;
}
.breadcrumb-crumb.is-active {
  color: var(--text-primary);
  font-weight: var(--fw-bold);
}
.breadcrumb-sep {
  margin: 0 var(--space-0);
  color: var(--text-muted);
}

.lib-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--row-h-library, 38px);
  height: var(--row-h-library, 38px);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-md);
  user-select: none;
  border: 1px solid transparent;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
  cursor: pointer;
  /* §5.3: a row is its own surface, not the panel it sits in. */
  background: var(--surface-row);
}
.lib-row.is-folder {
  background: var(--bg-hover);
  margin-bottom: var(--space-0);
}
.lib-row.is-folder:hover {
  background: color-mix(in srgb, var(--accent-blue) 10%, var(--bg-hover));
  border-color: color-mix(in srgb, var(--accent-blue) 30%, transparent);
}
.lib-row.is-folder.is-root-folder {
  font-weight: var(--fw-bold);
}
.lib-row.is-asset:hover {
  background: var(--bg-hover);
  border-color: var(--border-medium);
}
/* Selection outranks hover by matching its specificity, not by !important. */
.lib-row.is-asset.is-selected,
.lib-row.is-folder.is-selected,
.lib-row.is-asset.is-selected:hover,
.lib-row.is-folder.is-selected:hover {
  background: var(--bg-active);
  border-color: color-mix(in srgb, var(--accent-primary) 45%, transparent);
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
  font-size: var(--fs-lg);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1);
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
  font-size: var(--fs-md);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.folder-title-text {
  font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps);
}
.is-managed .lib-name {
  color: var(--text-primary);
}

.folder-count-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-medium);
  flex-shrink: 0;
}

.lib-time-pill {
  font-size: var(--fs-sm);
  line-height: var(--lh-none);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-medium);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps);
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
  padding: var(--space-2);
  gap: var(--space-1);
  background: var(--bg-secondary);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  z-index: var(--z-popover);
}
.debug-menu-item {
  background: transparent;
  border: none;
  color: var(--text-primary);
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
}
.debug-menu-item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
}
.debug-menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}


.lib-name-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  flex: 1;
}

.mcr-badges {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}

.mcr-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  line-height: var(--lh-none);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
}

/* Greek NCRTV Regulatory Color Codes */
.badge-age.age-k {
  background: var(--rating-k);
  color: var(--rating-k-fg);
}
.badge-age.age-8 {
  background: var(--rating-8);
  color: var(--rating-8-fg);
  font-weight: var(--fw-bold);

}
.badge-age.age-12 {
  background: var(--rating-12);
  color: var(--rating-12-fg);
  font-weight: var(--fw-bold);

}
.badge-age.age-16 {
  background: var(--rating-16);
  color: var(--rating-16-fg);
}
.badge-age.age-18 {
  background: var(--rating-18);
  color: var(--rating-18-fg);
}

/* Unrated: deliberately quiet (dashed outline, muted text) so it reads as
   "nothing decided yet" rather than as a regulatory mark. */
.badge-age.age-none,
.badge-unrated {
  background: transparent;
  color: var(--text-secondary);
  border: 1px dashed var(--border-strong);
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
}

.badge-tp {
  background: var(--rating-tp);
  color: var(--rating-tp-fg);
  border: 1px solid var(--border-medium);
}

.badge-content.content-movie { background: var(--type-movie); color: var(--text-on-danger); }
.badge-content.content-show { background: var(--type-show); color: var(--text-on-accent); }
.badge-content.content-documentary { background: var(--type-documentary); color: var(--text-on-danger); font-weight: var(--fw-semibold); }
.badge-content.content-news { background: var(--type-news); color: var(--text-on-success); }

/* §5.2: the content-type tint bar. 3 px of colour on the leading edge reads as
   fast as a chip at a fraction of the width, and it never truncates a title. */
.lib-type-bar {
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  pointer-events: auto;
  background: var(--text-muted);
}
.lib-row[data-content-type='movie'] .lib-type-bar { background: var(--type-movie); }
.lib-row[data-content-type='show'] .lib-type-bar { background: var(--type-show); }
.lib-row[data-content-type='documentary'] .lib-type-bar { background: var(--type-documentary); }
.lib-row[data-content-type='news'] .lib-type-bar { background: var(--type-news); }

/* TP as a dot on the rating chip (§5.2). The ring is the chip's own background
   so the dot reads as applied *to* the rating rather than floating near it. */
.mcr-badge.badge-age.has-tp {
  position: relative;
  overflow: visible;
}
.badge-tp-dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  background: var(--rating-tp);
  box-shadow: 0 0 0 1.5px var(--bg-secondary);
}

/* Two-line opt-in (§5.2). The row grows; nothing else about it changes. */
.lib-row.is-two-line {
  height: auto;
  min-height: calc(var(--row-h-library, 38px) * 1.45);
  align-items: center;
}
.lib-row.is-two-line .lib-text {
  gap: var(--space-0);
}
.lib-subline {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lib-subline-path {
  overflow: hidden;
  text-overflow: ellipsis;
}
.lib-subline-type {
  flex-shrink: 0;
  font-weight: var(--fw-bold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--text-secondary);
}
.lib-asset-list.row-mode-two-line .lib-row.is-asset {
  contain-intrinsic-size: 55px;
}
.lib-row-mode-toggle.active {
  border-color: color-mix(in srgb, var(--accent-blue) 55%, transparent);
  color: var(--accent-blue);
  background: color-mix(in srgb, var(--accent-blue) 14%, transparent);
}

.chevron-icon {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  transition: transform var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  margin-right: var(--space-0);
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
  transition: fill var(--dur-fast) var(--ease-out);
  flex-shrink: 0;
}

.folder-colors-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

/* Recycle Bin badge */
.recycle-bin-count-badge {
  display: inline-block;
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--status-error);
  color: var(--text-on-danger);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-none);
}

/* Pulsing Danger Purge Dialog */
.purge-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--bg-primary) 85%, transparent);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-modal-nested);
}

.danger-pulse-box {
  position: relative;
  background: color-mix(in srgb, var(--status-error) 8%, var(--bg-secondary));
  border: 2px solid var(--status-error);
  border-radius: var(--radius-lg);
  width: 480px;
  max-width: 90vw;
  padding: var(--space-6);
  box-shadow: var(--shadow-3);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* PERF: the alarm glow was a box-shadow keyframe on the dialog itself. The
   overlay pulses its opacity on the compositor instead. */
.danger-pulse-box::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  pointer-events: none;
  box-shadow: 0 0 45px color-mix(in srgb, var(--status-error) 70%, transparent);
  animation: onair-pulse var(--dur-pulse) var(--ease-in-out) infinite;
  will-change: opacity;
}


.purge-icon-circle {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--status-error) 20%, transparent);
  color: var(--status-error);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-4);
}

.purge-dialog-title {
  margin: 0 0 var(--space-2);
  font-size: var(--fs-xl);
  font-weight: var(--fw-bold);
  color: var(--text-primary);
}

.purge-dialog-text {
  margin: 0 0 var(--space-4);
  font-size: var(--fs-sm);
  line-height: var(--lh-body);
  color: var(--text-secondary);
}

.purge-warning-callout {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  background: color-mix(in srgb, var(--status-error) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--status-error) 25%, transparent);
  border-radius: var(--radius-lg);
  padding: var(--space-3) var(--space-4);
  font-size: var(--fs-xs);
  color: var(--status-error);
  text-align: left;
  margin-bottom: var(--space-5);
}

.purge-warning-callout svg {
  flex-shrink: 0;
  margin-top: var(--space-0);
}

.purge-dialog-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  width: 100%;
}

.dialog-cancel-btn {
  flex: 1;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-hover);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.dialog-cancel-btn:hover:not(:disabled) {
  background: var(--bg-active);
  color: var(--text-primary);
}

.dialog-danger-btn {
  flex: 1;
  padding: var(--space-3) var(--space-4);
  background: var(--status-error);
  border: 1px solid var(--status-error);
  border-radius: var(--radius-md);
  color: var(--text-on-danger);
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}

.dialog-danger-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--status-error) 85%, var(--text-primary));
  /* §3.4/§3.5: the glow is one of the three, and it appears rather than
     tweening — a shadow cannot be composited, so transitioning one repaints
     the button and its neighbours for every frame of the hover. */
  box-shadow: var(--glow-onair);
}
/* §5.3: the search-scope banner that replaces the breadcrumb while a query is
   active, so the suspended folder filter is visible rather than implied. */
.lib-search-scope {
  padding-right: var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
  color: var(--accent-blue);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
}

.lib-search-scope > span {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* F-22: the tree is keyboard-reachable now, so it needs a visible focus ring. */
.lib-row.is-folder:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
</style>
