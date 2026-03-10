<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useRundownStore, type ComplianceRating } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';
import { useMediaDefaultsStore, type LibraryIndicator } from '../stores/mediaDefaults';
import { draggingItem } from '../composables/useDragState';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import MediaTreeNode from './MediaTreeNode.vue';
import TrimPanel from './TrimPanel.vue';

const store = useRundownStore();
const settings = useSettingsStore();
const mediaDefaults = useMediaDefaultsStore();

const showTrimPanel = ref(false);
const trimLibraryItem = ref<{ path: string, filename: string, type: string, duration?: number } | null>(null);

interface MediaNode {
    name: string;
    path: string;
    shortPath?: string;
    type: 'file' | 'folder';
    mediaType?: 'video' | 'live' | 'graphic';
    defaultComplianceRating?: ComplianceRating;
    libraryIndicator?: LibraryIndicator;
    width?: number;
    height?: number;
    fpsNum?: number;
    fpsDen?: number;
    displayAspectRatio?: string;
    fieldOrder?: string;
    palCompatible?: boolean;
    duration?: number;
    duration_ms?: number;
    probing?: boolean;
    children?: MediaNode[];
    expanded?: boolean;
}

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

const tree = ref<MediaNode[]>([]);
const isScanning = ref(false);
const isWarmingCatalog = ref(false);
const streamUrl = ref('');
const isExtracting = ref(false);
const libraryQuery = ref('');
const selectedLibraryPath = ref('');
const showDebugMenu = ref(false);
const showDebugPanel = ref(false);
const probeStatus = ref<MediaProbeStatus>(createDefaultProbeStatus());
const diagnosticEntries = ref<DiagnosticEntry[]>([]);
const sortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const durationProbeInFlight = new Map<string, Promise<number>>();
let diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let scheduledWarmupTimer: ReturnType<typeof setTimeout> | null = null;
let periodicWarmupTimer: ReturnType<typeof setInterval> | null = null;

const contextMenu = ref({
    show: false, x: 0, y: 0, node: null as MediaNode | null
});

const normalizePath = (value: string) => value.replace(/\\/g, '/');
const ratingOptions: Array<{ id: ComplianceRating; label: string }> = [
    { id: 'none', label: 'None' },
    { id: 'k', label: 'K' },
    { id: '8', label: '8+' },
    { id: '12', label: '12+' },
    { id: '16', label: '16+' },
    { id: '18', label: '18+' }
];
const indicatorOptions: Array<{ id: LibraryIndicator; label: string }> = [
    { id: 'none', label: 'None' },
    { id: 'spot', label: 'Spot' },
    { id: 'telemarketing', label: 'Telemarketing' }
];

const getDefaultCompliance = (path: string) => mediaDefaults.getCompliance(path);
const getDefaultIndicator = (path: string) => mediaDefaults.getIndicator(path);

const makeRundownDraft = (node: MediaNode) => ({
    filename: node.name,
    path: node.path,
    shortPath: node.shortPath || '',
    type: node.mediaType || 'video',
    libraryIndicator: getDefaultIndicator(node.path),
    duration: getNodeDurationSeconds(node),
    seek: 0,
    length: 0,
    complianceRating: getDefaultCompliance(node.path)
});

const buildResolvedRundownDraft = async (node: MediaNode) => {
    const seconds = await ensureNodeDuration(node);
    return {
        ...makeRundownDraft(node),
        duration: seconds || getNodeDurationSeconds(node)
    };
};

const findNodeByPath = (nodes: MediaNode[], path: string): MediaNode | null => {
    for (const node of nodes) {
        if (node.type === 'file' && node.path === path) return node;
        const childMatch = node.children?.length ? findNodeByPath(node.children, path) : null;
        if (childMatch) return childMatch;
    }
    return null;
};

const selectLibraryNode = (node: MediaNode) => {
    if (node.type !== 'file') return;
    selectedLibraryPath.value = node.path;
};

const getSelectedLibraryNode = () => {
    if (!selectedLibraryPath.value) return null;
    return findNodeByPath(tree.value, selectedLibraryPath.value);
};

const applyLibraryDefaults = (nodes: MediaNode[]) => {
    for (const node of nodes) {
        if (node.type === 'file') {
            node.defaultComplianceRating = getDefaultCompliance(node.path);
            node.libraryIndicator = getDefaultIndicator(node.path);
        }
        if (node.children?.length) applyLibraryDefaults(node.children);
    }
};

const snapshotExpandedFolders = (nodes: MediaNode[], snapshot = new Map<string, boolean>()) => {
    for (const node of nodes) {
        if (node.type === 'folder') {
            snapshot.set(node.path, !!node.expanded);
            if (node.children?.length) snapshotExpandedFolders(node.children, snapshot);
        }
    }
    return snapshot;
};

const filterTree = (nodes: MediaNode[], query: string): MediaNode[] => {
    if (!query) return nodes;

    return nodes.flatMap((node) => {
        const label = `${node.name} ${node.path} ${node.defaultComplianceRating || ''} ${node.libraryIndicator || ''}`.toLowerCase();
        const isMatch = label.includes(query);

        if (node.type === 'folder') {
            const filteredChildren = filterTree(node.children || [], query);
            if (!isMatch && filteredChildren.length === 0) return [];
            return [{
                ...node,
                expanded: true,
                children: filteredChildren
            }];
        }

        return isMatch ? [node] : [];
    });
};

const countFiles = (nodes: MediaNode[]): number =>
    nodes.reduce((count, node) => count + (node.type === 'file' ? 1 : countFiles(node.children || [])), 0);

const visibleTree = computed(() => filterTree(tree.value, libraryQuery.value.trim().toLowerCase()));
const visibleFileCount = computed(() => countFiles(visibleTree.value));
const getNodeDurationSeconds = (node: MediaNode) => node.duration || (node.duration_ms ? node.duration_ms / 1000 : 0);
const shouldPollDiagnostics = computed(() => settings.debugMode && showDebugPanel.value);
const probeProgressLabel = computed(() => {
    if (!probeStatus.value.running) return '';
    if (probeStatus.value.totalCandidates > 0) {
        return `probing ${probeStatus.value.checked}/${probeStatus.value.totalCandidates}`;
    }
    return 'probing…';
});

const parseFrameRateString = (value: string) => {
    const [numRaw = '25', denRaw = '1'] = value.split('/');
    const fpsNum = Number.parseInt(numRaw, 10);
    const fpsDen = Number.parseInt(denRaw, 10);
    return {
        fpsNum: Number.isFinite(fpsNum) && fpsNum > 0 ? fpsNum : 25,
        fpsDen: Number.isFinite(fpsDen) && fpsDen > 0 ? fpsDen : 1
    };
};

const applyMetadataToNode = (node: MediaNode, metadata: {
    duration?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    display_aspect_ratio?: string;
    field_order?: string;
}) => {
    const seconds = Number.parseFloat(metadata.duration || '0');
    if (Number.isFinite(seconds) && seconds > 0) {
        node.duration = seconds;
        node.duration_ms = Math.round(seconds * 1000);
    }
    if (typeof metadata.width === 'number') node.width = metadata.width;
    if (typeof metadata.height === 'number') node.height = metadata.height;
    if (metadata.r_frame_rate) {
        const { fpsNum, fpsDen } = parseFrameRateString(metadata.r_frame_rate);
        node.fpsNum = fpsNum;
        node.fpsDen = fpsDen;
    }
    if (typeof metadata.display_aspect_ratio === 'string') node.displayAspectRatio = metadata.display_aspect_ratio;
    if (typeof metadata.field_order === 'string') node.fieldOrder = metadata.field_order;
    node.palCompatible = isPalCompatible({
        width: node.width,
        height: node.height,
        fps_num: node.fpsNum,
        fps_den: node.fpsDen
    });
};

const formatDiagnosticTime = (timestampMs: number) => {
    if (!timestampMs) return '--:--:--';
    return new Date(timestampMs).toLocaleTimeString([], {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
};

const updateNodeDurationByPath = (nodes: MediaNode[], targetPath: string, durationSeconds: number): boolean => {
    for (const node of nodes) {
        if (node.type === 'file' && node.path === targetPath) {
            node.duration = durationSeconds;
            node.duration_ms = Math.round(durationSeconds * 1000);
            node.probing = false;
            return true;
        }

        if (node.children?.length && updateNodeDurationByPath(node.children, targetPath, durationSeconds)) {
            return true;
        }
    }

    return false;
};

const updateNodeMetadataByPath = (nodes: MediaNode[], targetPath: string, metadata: {
    duration?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    display_aspect_ratio?: string;
    field_order?: string;
}): boolean => {
    for (const node of nodes) {
        if (node.type === 'file' && node.path === targetPath) {
            applyMetadataToNode(node, metadata);
            node.probing = false;
            return true;
        }

        if (node.children?.length && updateNodeMetadataByPath(node.children, targetPath, metadata)) {
            return true;
        }
    }

    return false;
};

const nodeNeedsBackgroundProbe = (node: MediaNode): boolean => {
    if (node.type !== 'file' || node.mediaType !== 'video' || !node.path || /^https?:/i.test(node.path)) return false;
    return getNodeDurationSeconds(node) <= 0 || !node.width || !node.height;
};

const countPendingMetadata = (nodes: MediaNode[]): number =>
    nodes.reduce((count, node) => count
        + (nodeNeedsBackgroundProbe(node) ? 1 : 0)
        + countPendingMetadata(node.children || []), 0);

const clearScheduledWarmup = () => {
    if (!scheduledWarmupTimer) return;
    clearTimeout(scheduledWarmupTimer);
    scheduledWarmupTimer = null;
};

const updateNodeProbeStateByPath = (nodes: MediaNode[], targetPath: string, probing: boolean): boolean => {
    for (const node of nodes) {
        if (node.type === 'file' && node.path === targetPath) {
            node.probing = probing;
            return true;
        }

        if (node.children?.length && updateNodeProbeStateByPath(node.children, targetPath, probing)) {
            return true;
        }
    }

    return false;
};

const ensureNodeDuration = async (node: MediaNode): Promise<number> => {
    const knownSeconds = getNodeDurationSeconds(node);
    if (knownSeconds > 0) return knownSeconds;
    if (node.type !== 'file' || !node.path || node.mediaType !== 'video' || /^https?:/i.test(node.path)) return 0;

    const existing = durationProbeInFlight.get(node.path);
    if (existing) return existing;

    node.probing = true;
    updateNodeProbeStateByPath(tree.value, node.path, true);

    const probePromise = invoke<{
        duration: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        display_aspect_ratio?: string;
        field_order?: string;
    }>('scan_media', { filepath: node.path })
        .then((metadata) => {
            const seconds = Number.parseFloat(metadata.duration || '0');
            applyMetadataToNode(node, metadata);
            updateNodeMetadataByPath(tree.value, node.path, metadata);
            if (Number.isFinite(seconds) && seconds > 0) {
                updateNodeDurationByPath(tree.value, node.path, seconds);
                return seconds;
            }
            return 0;
        })
        .catch((error) => {
            console.warn('[Library] Failed to resolve media duration', node.path, error);
            return 0;
        })
        .finally(() => {
            node.probing = false;
            updateNodeProbeStateByPath(tree.value, node.path, false);
            durationProbeInFlight.delete(node.path);
        });

    durationProbeInFlight.set(node.path, probePromise);
    return probePromise;
};

const ensureFolder = (rootNodes: MediaNode[], folderParts: string[], expandedSnapshot: Map<string, boolean>) => {
    let currentLevel = rootNodes;
    let currentFolderPath = '';

    for (const rawPart of folderParts) {
        const partName = rawPart || 'Folder';
        currentFolderPath = currentFolderPath ? `${currentFolderPath}/${partName}` : partName;
        let folder = currentLevel.find((node) => node.type === 'folder' && node.path === currentFolderPath);
        if (!folder) {
            folder = {
                name: partName,
                path: currentFolderPath,
                type: 'folder',
                children: [],
                expanded: expandedSnapshot.get(currentFolderPath) ?? false
            };
            currentLevel.push(folder);
        }
        if (!folder.children) folder.children = [];
        currentLevel = folder.children;
    }

    return currentLevel;
};

const isPalCompatible = (entry: { width?: number; height?: number; fps_num?: number; fps_den?: number }) => {
    if (!entry.width || !entry.height || !entry.fps_num || !entry.fps_den) return false;
    const fps = entry.fps_num / entry.fps_den;
    const isPalFps = Math.abs(fps - 25) < 0.01 || Math.abs(fps - 50) < 0.01;
    const is1080 = (entry.width === 1920 || entry.width === 1440) && entry.height === 1080;
    const is720 = entry.width === 1280 && entry.height === 720;
    const is576 = entry.width === 720 && entry.height === 576;
    return (is1080 || is720 || is576) && isPalFps;
};

const buildTree = async (dirPath: string): Promise<MediaNode[]> => {
    const rootNodes: MediaNode[] = [];
    try {
        const expandedSnapshot = snapshotExpandedFolders(tree.value);
        const files = await invoke<{
            filename: string,
            path: string,
            short_path: string,
            entry_kind: 'file' | 'folder',
            media_type: string,
            duration: number,
            duration_ms?: number,
            width?: number,
            height?: number,
            fps_num?: number,
            fps_den?: number,
            display_aspect_ratio?: string,
            field_order?: string
        }[]>(
            'scan_directory', { path: dirPath }
        );

        const normalizedDir = normalizePath(dirPath);

        for (const f of files) {
            const normalizedFilePath = normalizePath(f.path);
            let relPath = normalizedFilePath;
            
            if (normalizedFilePath.startsWith(normalizedDir)) {
                relPath = normalizedFilePath.substring(normalizedDir.length);
            }
            relPath = relPath.replace(/^\/+/, '');
            if (!relPath) continue;

            const parts = relPath.split('/').filter(Boolean);
            const isFolder = f.entry_kind === 'folder';
            const folderParts = isFolder ? parts : parts.slice(0, -1);
            const currentLevel = ensureFolder(rootNodes, folderParts, expandedSnapshot);
            
            if (isFolder) {
                ensureFolder(rootNodes, parts, expandedSnapshot);
                continue;
            }

            const fileName = parts[parts.length - 1] || f.filename || 'Untitled';
            currentLevel.push({
                name: f.filename || fileName,
                path: f.path || '',
                shortPath: f.short_path || '',
                type: 'file',
                mediaType: f.media_type as any,
                defaultComplianceRating: getDefaultCompliance(f.path || ''),
                libraryIndicator: getDefaultIndicator(f.path || ''),
                duration: f.duration || 0,
                duration_ms: f.duration_ms || (f.duration ? f.duration * 1000 : 0),
                width: f.width || 0,
                height: f.height || 0,
                fpsNum: f.fps_num || 0,
                fpsDen: f.fps_den || 1,
                displayAspectRatio: f.display_aspect_ratio || '',
                fieldOrder: f.field_order || '',
                palCompatible: isPalCompatible(f)
            });
        }
        
        const sortNodes = (nodes: MediaNode[]) => {
            nodes.sort((a, b) => {
                if (!a || !b) return 0;
                if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
                return sortCollator.compare(a.name || '', b.name || '');
            });
            nodes.forEach((n: MediaNode) => {
                if (n && n.children) sortNodes(n.children as MediaNode[]);
            });
        };
        sortNodes(rootNodes);

    } catch (e) {
        console.warn('[Library] buildTree scan failed:', e);
    }
    return rootNodes;
};

const handleProbeStatusUpdate = async (status: MediaProbeStatus) => {
    const previousFinishedAt = probeStatus.value.finishedAtMs;
    probeStatus.value = status;
    isWarmingCatalog.value = status.running;

    const normalizedCurrentRoot = normalizePath(settings.localMediaPath || '').replace(/\/+$/, '');
    const normalizedProbeRoot = normalizePath(status.rootPath || '').replace(/\/+$/, '');
    if (!status.running && status.finishedAtMs && status.finishedAtMs !== previousFinishedAt && normalizedProbeRoot === normalizedCurrentRoot) {
        await rescanLibrary({ scheduleProbe: false });
    }
};

const refreshProbeStatus = async () => {
    try {
        const status = await invoke<MediaProbeStatus>('get_media_probe_status');
        await handleProbeStatusUpdate(status);
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
        await handleProbeStatusUpdate(status);
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
    if (!mediaPath || probeStatus.value.running || countPendingMetadata(tree.value) === 0) return;

    scheduledWarmupTimer = setTimeout(() => {
        scheduledWarmupTimer = null;
        startBackgroundProbe('scheduled').catch(() => {});
    }, delayMs);
};

const rescanLibrary = async (options: RescanOptions = {}) => {
    isScanning.value = true;
    try {
        const nodes = await buildTree(settings.localMediaPath || '');
        nodes.push({
            name: settings.liveInputSourceName || 'Live Rebroadcast',
            path: settings.liveInputSourceName || '',
            type: 'file',
            mediaType: 'live'
        });
        nodes.push({ name: 'External_Network_Stream.m3u8', path: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', type: 'file', mediaType: 'video' });
        tree.value = nodes;
    } catch (e) {
        console.warn('[Library] rescanLibrary failed:', e);
        tree.value = [
            { name: '⚠ Set media folder in ⚙️ Settings', path: '', type: 'file', mediaType: 'video' },
            { name: settings.liveInputSourceName || 'Live Rebroadcast', path: settings.liveInputSourceName || '', type: 'file', mediaType: 'live' }
        ];
    } finally {
        isScanning.value = false;
        if (options.scheduleProbe !== false) {
            scheduleLibraryWarmup(options.probeDelayMs ?? 1500);
        }
    }
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

const handleTrimSaved = async ({ outputPath }: { outputPath: string }) => {
    if (!outputPath) return;
    try {
        await invoke('scan_media', { filepath: outputPath });
    } catch (error) {
        console.warn('[Library] Failed to pre-prime trimmed media metadata', outputPath, error);
    }
    await rescanLibrary({ scheduleProbe: true, probeDelayMs: 350 });
};

watch(() => [settings.localMediaPath, settings.liveInputSourceName], () => {
    rescanLibrary({ scheduleProbe: true, probeDelayMs: 1800 });
});
watch(() => mediaDefaults.complianceByPath, () => applyLibraryDefaults(tree.value), { deep: true });
watch(() => mediaDefaults.indicatorByPath, () => applyLibraryDefaults(tree.value), { deep: true });
watch(shouldPollDiagnostics, (enabled) => {
    if (diagnosticsTimer) {
        clearInterval(diagnosticsTimer);
        diagnosticsTimer = null;
    }

    if (!enabled) return;

    refreshDiagnostics().catch(() => {});
    diagnosticsTimer = setInterval(() => {
        refreshDiagnostics().catch(() => {});
    }, 1500);
}, { immediate: true });

watch(() => probeStatus.value.running, (running) => {
    if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
    }

    if (!running) return;

    statusTimer = setInterval(() => {
        refreshProbeStatus().catch(() => {});
    }, 1500);
}, { immediate: true });

watch(() => settings.debugMode, (enabled) => {
    if (!enabled) {
        showDebugMenu.value = false;
        showDebugPanel.value = false;
        diagnosticEntries.value = [];
    } else {
        refreshDebugPanel().catch(() => {});
    }
});

const addWebStream = async () => {
    if (!streamUrl.value) return;
    isExtracting.value = true;
    try {
        const rawUrl = await invoke<string>('extract_web_stream', { url: streamUrl.value });
        tree.value = [
            ...tree.value,
            { name: 'Web Stream', path: rawUrl, type: 'file', mediaType: 'video' }
        ];
        streamUrl.value = '';
    } catch (e) { console.error('Stream extraction failed:', e); }
    finally { isExtracting.value = false; }
};

const onDragStart = (event: DragEvent, node: MediaNode) => {
    selectLibraryNode(node);
    const payload = {
        filename: node.name,
        path: node.path,
        shortPath: node.shortPath || '',
        type: node.mediaType || 'video',
        libraryIndicator: getDefaultIndicator(node.path),
        duration: getNodeDurationSeconds(node), seek: 0, length: 0,
        complianceRating: getDefaultCompliance(node.path)
    };
    draggingItem.value = payload;
    ensureNodeDuration(node).then((seconds) => {
        if (draggingItem.value === payload && seconds > 0) {
            draggingItem.value.duration = seconds;
        }
    }).catch(() => {});
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
};

const addItem = async (node: MediaNode) => {
    selectLibraryNode(node);
    store.addItem(await buildResolvedRundownDraft(node));
};

const appendSelectedLibraryNode = async () => {
    const node = getSelectedLibraryNode();
    if (!node || node.type !== 'file' || !node.path) return;

    const item = await buildResolvedRundownDraft(node);
    if (store.selectedItemId) {
        const index = store.activeItems.findIndex((entry) => entry.id === store.selectedItemId);
        if (index >= 0) {
            store.insertItemAt(index + 1, item);
            return;
        }
    }

    store.addItem(item);
};

// --- Context Menu Options ---
const onContextMenu = (event: MouseEvent, node: MediaNode) => {
    if (node.type !== 'file' || !node.path) return;
    selectLibraryNode(node);
    contextMenu.value = { show: true, x: event.clientX, y: event.clientY, node };
};

const closeContextMenu = () => {
    showDebugMenu.value = false;
    contextMenu.value = { ...contextMenu.value, show: false, node: null };
};

const openTrimPanel = () => {
    if (contextMenu.value.node) {
        trimLibraryItem.value = {
            path: contextMenu.value.node.path,
            filename: contextMenu.value.node.name,
            type: contextMenu.value.node.mediaType || 'video',
            duration: contextMenu.value.node.duration || 0
        };
        showTrimPanel.value = true;
    }
    closeContextMenu();
};

const appendNode = async () => {
    if (contextMenu.value.node) await addItem(contextMenu.value.node);
    closeContextMenu();
};

const insertNode = async () => {
    if (contextMenu.value.node) {
        const item = await buildResolvedRundownDraft(contextMenu.value.node);
        if (store.selectedItemId) {
            const idx = store.activeItems.findIndex((i: any) => i.id === store.selectedItemId);
            if (idx >= 0) {
                store.insertItemAt(idx + 1, item);
                closeContextMenu();
                return;
            }
        }
        store.addItem(item);
    }
    closeContextMenu();
};

const setDefaultRating = (rating: ComplianceRating) => {
    if (!contextMenu.value.node?.path) return;
    mediaDefaults.setCompliance(contextMenu.value.node.path, rating);
    applyLibraryDefaults(tree.value);
    closeContextMenu();
};

const setLibraryIndicator = (indicator: LibraryIndicator) => {
    if (!contextMenu.value.node?.path) return;
    mediaDefaults.setIndicator(contextMenu.value.node.path, indicator);
    applyLibraryDefaults(tree.value);
    closeContextMenu();
};

const handleLibraryKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    if (event.key !== 'F8') return;
    if (!getSelectedLibraryNode()) return;

    event.preventDefault();
    appendSelectedLibraryNode().catch((error) => {
        console.warn('[Library] Failed to append selected library item via F8', error);
    });
};

onMounted(() => {
    refreshProbeStatus().catch(() => {});
    rescanLibrary({ scheduleProbe: true, probeDelayMs: 1100 });
    if (settings.debugMode) {
        refreshDebugPanel().catch(() => {});
    }
    periodicWarmupTimer = setInterval(() => {
        if (!probeStatus.value.running) {
            scheduleLibraryWarmup(0);
        }
    }, 300000);
    window.addEventListener('click', closeContextMenu);
    window.addEventListener('keydown', handleLibraryKey);
});
onUnmounted(() => {
    if (diagnosticsTimer) {
        clearInterval(diagnosticsTimer);
        diagnosticsTimer = null;
    }
    if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
    }
    if (periodicWarmupTimer) {
        clearInterval(periodicWarmupTimer);
        periodicWarmupTimer = null;
    }
    clearScheduledWarmup();
    window.removeEventListener('click', closeContextMenu);
    window.removeEventListener('keydown', handleLibraryKey);
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
                <button class="icon-action" @click="rescanLibrary({ scheduleProbe: true, probeDelayMs: 350 })" :disabled="isScanning" :title="isScanning ? 'Scanning…' : 'Rescan'">
                    {{ isScanning ? '⌛' : '↻' }}
                </button>
            </div>
    </div>

        <div class="lib-toolbar">
            <input
                v-model="libraryQuery"
                class="glass-input lib-search"
                type="search"
                placeholder="Search files, folders, or paths"
            >
            <button v-if="libraryQuery" class="icon-action" @click="libraryQuery = ''" title="Clear search">✕</button>
        </div>

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
                <div v-for="(entry, index) in diagnosticEntries" :key="`${entry.timestampMs}-${entry.scope}-${index}`" class="debug-entry" :class="`level-${entry.level}`">
                    <span class="debug-time">{{ formatDiagnosticTime(entry.timestampMs) }}</span>
                    <span class="debug-level">{{ entry.level.toUpperCase() }}</span>
                    <span class="debug-scope">{{ entry.scope }}</span>
                    <span class="debug-message">{{ entry.message }}</span>
                </div>
            </div>
        </div>

    <!-- File Tree -->
    <div class="lib-tree custom-scroll" @contextmenu.prevent>
      <div v-if="isScanning" class="lib-empty">⌛ Scanning…</div>
            <div v-else-if="visibleTree.length === 0" class="lib-empty">
                {{ libraryQuery ? 'No matching media found.' : '📂 No media found.' }}
                <br>
                <small>{{ libraryQuery ? 'Try a broader search.' : 'Set folder in ⚙️ Settings' }}</small>
            </div>

      <MediaTreeNode
                v-for="node in visibleTree"
        :key="node.path || node.name"
        :node="node"
                :selected-path="selectedLibraryPath"
        @dragstart="onDragStart"
        @dblclick="addItem"
        @contextmenu="onContextMenu"
                @select="selectLibraryNode"
      />
    </div>

    <!-- Web Stream Ingest -->
    <div class="lib-stream-bar">
      <label class="text-secondary" style="font-size:0.7rem; margin-bottom:3px; display:block;">Web Stream (HLS / YouTube)</label>
      <div style="display:flex; gap:6px;">
                <input class="glass-input" v-model="streamUrl" placeholder="https://…" style="flex:1; font-size:0.78rem; padding:4px 8px;" @keydown.enter.prevent="addWebStream">
        <button class="icon-action" @click="addWebStream" :disabled="isExtracting">{{ isExtracting ? '⌛' : '＋' }}</button>
      </div>
    </div>

    <!-- Custom Context Menu -->
    <Teleport to="body">
      <div v-if="contextMenu.show" class="context-menu" :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }">
        <div class="menu-item" @click.stop="appendNode">Append to Rundown</div>
        <div class="menu-item" @click.stop="insertNode">Insert After Selected</div>
        <div class="menu-divider"></div>
                <div class="menu-label">Default Rating</div>
                <div v-for="rating in ratingOptions" :key="rating.id" class="menu-item" @click.stop="setDefaultRating(rating.id)">
                    {{ getDefaultCompliance(contextMenu.node?.path || '') === rating.id ? '✓ ' : '' }}{{ rating.label }}
                </div>
                <div class="menu-divider"></div>
                                <div class="menu-label">Library Tag</div>
                                <div v-for="indicator in indicatorOptions" :key="indicator.id" class="menu-item" @click.stop="setLibraryIndicator(indicator.id)">
                                        {{ getDefaultIndicator(contextMenu.node?.path || '') === indicator.id ? '✓ ' : '' }}{{ indicator.label }}
                                </div>
                                <div class="menu-divider"></div>
        <div class="menu-item" @click.stop="openTrimPanel">✂️ Trim & Extract...</div>
        <div class="menu-divider"></div>
        <div class="menu-item" @click.stop="closeContextMenu">Cancel</div>
      </div>
    </Teleport>

    <!-- Trim Panel Modal -->
    <Teleport to="body">
      <TrimPanel 
        :is-open="showTrimPanel" 
        :library-item="trimLibraryItem"
                @saved="handleTrimSaved"
        @close="showTrimPanel = false; trimLibraryItem = null" 
      />
    </Teleport>
  </div>
</template>

<style scoped>
.lib-wrap { height:100%; display:flex; flex-direction:column; overflow:hidden; position: relative; }
.lib-header {
    display:flex; justify-content:space-between; align-items:center;
    padding:6px 10px; border-bottom:1px solid var(--glass-border); flex-shrink:0;
}
.lib-header-actions { display:flex; align-items:center; gap:6px; }
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
.lib-header-copy { display:flex; flex-direction:column; gap:2px; }
.lib-title { font-size:0.9rem; font-weight:600; }
.lib-subtitle { color:var(--text-secondary); font-size:0.7rem; }
.lib-toolbar {
    display:flex; align-items:center; gap:6px;
    padding:8px 8px 6px;
    border-bottom:1px solid var(--glass-border);
}
.lib-search { flex:1; }
.lib-debug-panel {
    padding:8px;
    border-bottom:1px solid var(--glass-border);
    background:color-mix(in srgb, var(--bg-tertiary) 72%, transparent);
    display:flex;
    flex-direction:column;
    gap:8px;
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
.lib-tree { flex:1; overflow-y:auto; padding:4px; min-height:0; }
.lib-empty { color:var(--text-secondary); font-size:0.78rem; text-align:center; padding:20px 10px; line-height:1.6; }
.lib-stream-bar { padding:8px; border-top:1px solid var(--glass-border); flex-shrink:0; }
.glass-input {
    background:var(--bg-tertiary); border:1px solid var(--glass-border);
    color:var(--text-primary); border-radius:4px; font-size:0.8rem; padding:5px 8px;
}
.icon-action {
    background:color-mix(in srgb, var(--bg-tertiary) 84%, transparent); border:1px solid var(--glass-border);
    color:var(--text-primary); border-radius:4px; cursor:pointer; padding:4px 8px; font-size:0.82rem; transition:0.15s;
}
.icon-action:hover { background:color-mix(in srgb, var(--accent-blue) 10%, var(--bg-tertiary)); }
.icon-action:disabled { opacity:0.4; cursor:not-allowed; }

/* Context Menu */
.context-menu {
    position: fixed;
    background: var(--bg-secondary);
    border: 1px solid var(--glass-border);
    border-radius: 6px;
    padding: 4px 0;
    min-width: 160px;
    z-index: 9999;
    box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    backdrop-filter: blur(10px);
}
.menu-label {
    padding: 6px 12px 4px;
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-secondary);
}
.menu-item {
    padding: 6px 12px;
    font-size: 0.8rem;
    color: var(--text-primary);
    cursor: pointer;
    transition: background 0.1s;
}
.menu-item:hover {
    background: color-mix(in srgb, var(--accent-blue) 14%, transparent);
    color: var(--accent-blue);
}
.menu-divider {
    height: 1px;
    background: var(--glass-border);
    margin: 4px 0;
}
</style>
