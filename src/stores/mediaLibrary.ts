import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useMediaDefaultsStore, type LibraryIndicator } from './mediaDefaults';
import { useRundownStore, parseBroadcastRating, serializeBroadcastRating } from './rundown';
import type { ComplianceRating } from './rundown';
import { invoke } from '@tauri-apps/api/core';

export interface QcFinding {
    severity: 'info' | 'warning' | 'error' | string;
    code: string;
    message: string;
    measured?: string;
    expected?: string;
}

export interface QcReport {
    passed: boolean;
    blocking_errors: number;
    warnings_count: number;
    findings: QcFinding[];
}

export interface LoudnessMetadata {
    integrated_lufs?: number;
    true_peak_dbtp?: number;
    lra_lu?: number;
    mode?: string;
}

export interface LibraryAsset {
    uuid: string;
    current_path: string;
    display_name: string;
    virtual_folder: string;
    duration_ms: number;
    trim_in_ms: number;
    trim_out_ms: number;
    rating: string;
    tp?: string;
    status: string;
    width?: number;
    height?: number;
    fpsNum?: number;
    fpsDen?: number;
    displayAspectRatio?: string;
    fieldOrder?: string;
    codec?: string;
    probing?: boolean;
    mezzanine_ok?: boolean;
    fps?: number;
    total_frames?: number;
    gop_frames?: number;
    keyframe_safe_start_ms?: number;
    warnings?: string[];
    qc_report?: QcReport;
    loudness?: LoudnessMetadata;
    deleted_at?: string;
    original_virtual_folder?: string;
}

export interface TreeNode {
    id: string;
    type: 'folder' | 'asset';
    name: string;
    virtualFolder: string; // for assets, this is the folder they belong to; for folders, the folder path
    depth: number;
    expanded?: boolean;
    asset?: LibraryAsset;
    isTransient?: boolean;
    color?: string; // Add color property for folders!
}

function normalizeVirtualFolder(value?: string | null): string {
    if (!value) return '/';
    const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized === '') return '/';
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function folderName(path: string): string {
    if (path === '/') return 'All Media';
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'Unknown';
}

function mapApiRating(rating: string): ComplianceRating {
    return parseBroadcastRating(rating).ageRating;
}

export interface VirtualFolderNode {
    path: string; // e.g. "/" or "/Shows" or "/Shows/Show 1"
    name: string; // e.g. "Library Root" or "Shows" or "Show 1"
    depth: number;
    color?: string;
    isTransient?: boolean;
    directAssets: LibraryAsset[];
    allAssetCount: number;
    children: VirtualFolderNode[];
}

export function buildVirtualFolderTree(
    assets: LibraryAsset[],
    transientFolders: Record<string, any> = {},
    folderColors: Record<string, string> = {},
    deletedUuids: string[] = [],
    query: string = ''
): VirtualFolderNode {
    const root: VirtualFolderNode = {
        path: '/',
        name: 'All Media (Root)',
        depth: 0,
        color: folderColors['/'],
        isTransient: false,
        directAssets: [],
        allAssetCount: 0,
        children: []
    };

    const nodeMap = new Map<string, VirtualFolderNode>();
    nodeMap.set('/', root);

    const getOrCreateNode = (folderPath: string): VirtualFolderNode => {
        const norm = normalizeVirtualFolder(folderPath);
        if (nodeMap.has(norm)) return nodeMap.get(norm)!;

        const segments = norm.split('/').filter(Boolean);
        let currentPath = '';
        let parentNode = root;

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i]!;
            currentPath += `/${seg}`;
            if (!nodeMap.has(currentPath)) {
                const newNode: VirtualFolderNode = {
                    path: currentPath,
                    name: seg,
                    depth: i + 1,
                    color: folderColors[currentPath],
                    isTransient: !!transientFolders[currentPath],
                    directAssets: [],
                    allAssetCount: 0,
                    children: []
                };
                nodeMap.set(currentPath, newNode);
                parentNode.children.push(newNode);
                parentNode.children.sort((a, b) => a.name.localeCompare(b.name));
            }
            parentNode = nodeMap.get(currentPath)!;
        }

        return parentNode;
    };

    // Ensure all transient folders exist in the tree
    for (const folder of Object.keys(transientFolders)) {
        getOrCreateNode(folder);
    }

    // Populate assets
    const lowerQuery = query.trim().toLowerCase();
    for (const asset of assets) {
        if (deletedUuids.includes(asset.uuid)) continue;
        if (lowerQuery) {
            const displayName = asset.display_name || asset.current_path?.split(/[/\\]/).pop() || 'Untitled';
            if (!displayName.toLowerCase().includes(lowerQuery)) {
                continue;
            }
        }
        const node = getOrCreateNode(asset.virtual_folder);
        node.directAssets.push(asset);
    }

    // Sort assets in each node
    for (const node of nodeMap.values()) {
        node.directAssets.sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
    }

    // Compute total asset counts recursively
    const computeAssetCounts = (node: VirtualFolderNode): number => {
        let count = node.directAssets.length;
        for (const child of node.children) {
            count += computeAssetCounts(child);
        }
        node.allAssetCount = count;
        return count;
    };
    computeAssetCounts(root);

    return root;
}

export const useMediaLibraryStore = defineStore('mediaLibrary',
    () => {
        const mediaDefaults = useMediaDefaultsStore();
        const assets = ref<LibraryAsset[]>([]);
        const recycleBinAssets = ref<LibraryAsset[]>([]);
        const isRecycleBinLoading = ref(false);
        const currentFolderPath = ref('/');
        const searchQuery = ref('');
        const selectedNodeId = ref<string | null>(null);
        const selectedNodeIds = ref<string[]>([]);
        const selectionAnchorNodeId = ref<string | null>(null);
        const expandedFolders = ref<string[]>(['/']);
        const deletedUuids = ref<string[]>([]);
        const transientFolders = ref<Record<string, string>>({});
        const localVirtualFolders = ref<Record<string, string>>({});
        const folderOverrides = ref<Record<string, string>>({});
        const folderColors = ref<Record<string, string>>({});

        const expandedFoldersSet = computed(() => new Set(expandedFolders.value));
        const deletedUuidsSet = computed(() => new Set(deletedUuids.value));
        const transientFoldersMap = computed(() => new Map(Object.entries(transientFolders.value)));

        const allTreeNodes = computed<TreeNode[]>(() => {
            const query = searchQuery.value.trim().toLowerCase();
            const tree = buildVirtualFolderTree(
                assets.value,
                transientFolders.value,
                folderColors.value,
                deletedUuids.value,
                query
            );

            const result: TreeNode[] = [];
            const traverse = (node: VirtualFolderNode) => {
                if (query && node.allAssetCount === 0 && !node.name.toLowerCase().includes(query)) {
                    return;
                }

                result.push({
                    id: `folder:${node.path}`,
                    type: 'folder',
                    name: node.path === '/' ? 'All Media' : node.name,
                    virtualFolder: node.path,
                    depth: node.depth,
                    expanded: query ? true : (expandedFoldersSet.value.has(node.path) || node.path === '/'),
                    isTransient: node.isTransient,
                    color: node.color,
                });

                const isExpanded = query ? true : (expandedFoldersSet.value.has(node.path) || node.path === '/');
                if (isExpanded) {
                    for (const child of node.children) {
                        traverse(child);
                    }
                    for (const asset of node.directAssets) {
                        result.push({
                            id: `asset:${asset.uuid}`,
                            type: 'asset',
                            name: asset.display_name,
                            virtualFolder: node.path,
                            depth: node.depth + 1,
                            asset,
                        });
                    }
                }
            };

            traverse(tree);
            return ensureFolderAsSelected(result);
        });

        // Ensure selected folder is expanded so its contents are visible
        function ensureFolderAsSelected(nodes: TreeNode[]): TreeNode[] {
            if (!selectedNodeId.value) return nodes;
            const selectedFolder = nodes.find(
                (n) => n.id === selectedNodeId.value && n.type === 'folder'
            );
            if (selectedFolder && !selectedFolder.expanded) {
                ensureExpanded(selectedFolder.virtualFolder);
            }
            return nodes;
        }

        const selectedAsset = computed<LibraryAsset | null>(() => {
            if (!selectedNodeId.value?.startsWith('asset:')) return null;
            const uuid = selectedNodeId.value.slice(6);
            return assets.value.find((a) => a.uuid === uuid) || null;
        });

        const selectedAssetId = computed<string | null>(() => {
            if (!selectedNodeId.value?.startsWith('asset:')) return null;
            return selectedNodeId.value.slice(6);
        });

        const selectedAssetIds = computed<string[]>(() => {
            if (!selectedNodeIds.value.length) {
                return selectedNodeId.value?.startsWith('asset:') ? [selectedNodeId.value.slice(6)] : [];
            }
            return selectedNodeIds.value
                .filter((id) => id.startsWith('asset:'))
                .map((id) => id.slice(6));
        });

        function selectNode(
            id: string | null,
            options: { multi?: boolean; range?: boolean; visibleNodes?: TreeNode[] } = {}
        ) {
            if (!id) {
                selectedNodeId.value = null;
                selectedNodeIds.value = [];
                selectionAnchorNodeId.value = null;
                return;
            }

            const nodes = options.visibleNodes || allTreeNodes.value;

            if (options.range && selectionAnchorNodeId.value && nodes.length) {
                const anchorIdx = nodes.findIndex((n) => n.id === selectionAnchorNodeId.value);
                const targetIdx = nodes.findIndex((n) => n.id === id);
                if (anchorIdx !== -1 && targetIdx !== -1) {
                    const start = Math.min(anchorIdx, targetIdx);
                    const end = Math.max(anchorIdx, targetIdx);
                    const rangeIds = nodes.slice(start, end + 1).map((n) => n.id);
                    selectedNodeIds.value = rangeIds;
                    selectedNodeId.value = id;
                    return;
                }
            }

            if (options.multi) {
                const set = new Set(selectedNodeIds.value);
                if (set.has(id)) {
                    set.delete(id);
                    if (selectedNodeId.value === id) {
                        selectedNodeId.value = Array.from(set).pop() || null;
                    }
                } else {
                    set.add(id);
                    selectedNodeId.value = id;
                }
                selectedNodeIds.value = Array.from(set);
                selectionAnchorNodeId.value = id;
                return;
            }

            selectedNodeId.value = id;
            selectedNodeIds.value = [id];
            selectionAnchorNodeId.value = id;
        }

        function moveSelectionDelta(delta: number, visibleNodes: TreeNode[] = allTreeNodes.value) {
            const selectableNodes = visibleNodes.filter((n) => n.type === 'asset');
            if (!selectableNodes.length) return;

            const currentIdx = selectedNodeId.value
                ? selectableNodes.findIndex((n) => n.id === selectedNodeId.value)
                : -1;

            let targetIdx: number;
            if (currentIdx === -1) {
                targetIdx = delta > 0 ? 0 : selectableNodes.length - 1;
            } else {
                targetIdx = Math.max(0, Math.min(selectableNodes.length - 1, currentIdx + delta));
            }

            const targetNode = selectableNodes[targetIdx];
            if (targetNode) {
                selectNode(targetNode.id, { visibleNodes });
            }
        }

        function moveSelectionPage(delta: number, pageSize: number, visibleNodes: TreeNode[] = allTreeNodes.value) {
            moveSelectionDelta(delta * pageSize, visibleNodes);
        }

        function selectFirst(visibleNodes: TreeNode[] = allTreeNodes.value) {
            const selectableNodes = visibleNodes.filter((n) => n.type === 'asset');
            if (!selectableNodes.length || !selectableNodes[0]) return;
            selectNode(selectableNodes[0].id, { visibleNodes });
        }

        function selectLast(visibleNodes: TreeNode[] = allTreeNodes.value) {
            const selectableNodes = visibleNodes.filter((n) => n.type === 'asset');
            const last = selectableNodes[selectableNodes.length - 1];
            if (!selectableNodes.length || !last) return;
            selectNode(last.id, { visibleNodes });
        }

        function extendSelection(delta: number, visibleNodes: TreeNode[] = allTreeNodes.value) {
            const selectableNodes = visibleNodes.filter((n) => n.type === 'asset');
            if (!selectableNodes.length) return;

            const currentIdx = selectedNodeId.value
                ? selectableNodes.findIndex((n) => n.id === selectedNodeId.value)
                : -1;

            if (currentIdx === -1) {
                selectFirst(visibleNodes);
                return;
            }

            const targetIdx = Math.max(0, Math.min(selectableNodes.length - 1, currentIdx + delta));
            const targetNode = selectableNodes[targetIdx];
            if (targetNode) {
                selectNode(targetNode.id, { range: true, visibleNodes });
            }
        }

        function clearSelection() {
            selectNode(null);
        }

        const currentFolderAssets = computed<LibraryAsset[]>(() =>
            assets.value.filter(
                (a) =>
                    !deletedUuidsSet.value.has(a.uuid) &&
                    normalizeVirtualFolder(a.virtual_folder) === normalizeVirtualFolder(currentFolderPath.value)
            )
        );

        function setAssets(next: LibraryAsset[]) {
            const activeOnly = next.filter((a) => !a.deleted_at);
            const processed = activeOnly.map((asset) => {
                // current_path-keyed override (local fallback assets).
                const pathOverride = localVirtualFolders.value[asset.current_path];
                // uuid-keyed override (Ingestor assets moved client-side; survives
                // refreshes even if the API did not persist the move — plan §3.2).
                const uuidOverride = folderOverrides.value[asset.uuid];
                const override = uuidOverride ?? pathOverride;
                return {
                    ...asset,
                    virtual_folder: override ? normalizeVirtualFolder(override) : normalizeVirtualFolder(asset.virtual_folder),
                };
            });
            assets.value.splice(0, assets.value.length, ...processed);
        }

        function updateAsset(uuid: string, patch: Partial<LibraryAsset>) {
            const index = assets.value.findIndex((a) => a.uuid === uuid);
            if (index >= 0) {
                const updated = { ...assets.value[index]!, ...patch };
                assets.value.splice(index, 1, updated);
            }
        }

        function navigateTo(folderPath: string) {
            currentFolderPath.value = normalizeVirtualFolder(folderPath);
            searchQuery.value = '';
        }

        function ensureExpanded(folderPath: string) {
            const normalized = normalizeVirtualFolder(folderPath);
            if (!expandedFolders.value.includes(normalized)) {
                expandedFolders.value.push(normalized);
            }
        }

        function toggleFolder(folderPath: string) {
            const normalized = normalizeVirtualFolder(folderPath);
            const index = expandedFolders.value.indexOf(normalized);
            if (index >= 0) {
                expandedFolders.value.splice(index, 1);
            } else {
                expandedFolders.value.push(normalized);
            }
        }

        function createVirtualFolder(nameOrParent: string, subName?: string) {
            let parentPath = '/';
            let folderName = '';

            if (subName !== undefined) {
                parentPath = normalizeVirtualFolder(nameOrParent);
                folderName = subName.trim();
            } else {
                parentPath = normalizeVirtualFolder(currentFolderPath.value);
                folderName = nameOrParent.trim();
            }

            if (!folderName) return;

            // Strip leading and trailing slashes
            folderName = folderName.replace(/^\/+|\/+$/g, '');
            const newPath = parentPath === '/' ? `/${folderName}` : `${parentPath}/${folderName}`;
            const normalized = normalizeVirtualFolder(newPath);

            if (transientFolders.value[normalized]) return normalized;

            transientFolders.value[normalized] = parentPath;
            ensureExpanded(parentPath);
            ensureExpanded(normalized);
            selectedNodeId.value = `folder:${normalized}`;
            currentFolderPath.value = normalized;
            return normalized;
        }

        async function moveAssetToFolder(uuid: string, folderPath: string) {
            const normalized = normalizeVirtualFolder(folderPath);
            updateAsset(uuid, { virtual_folder: normalized });

            folderOverrides.value[uuid] = normalized;

            if (uuid.startsWith('local:')) {
                const asset = assets.value.find((a) => a.uuid === uuid);
                if (asset) {
                    localVirtualFolders.value[asset.current_path] = normalized;
                }
            } else {
                try {
                    await invoke('move_ingestor_asset', {
                        uuid,
                        virtual_folder: normalized,
                        api_base_url_override: null
                    });
                } catch (e) {
                    console.warn('[LibraryStore] Failed to update backend virtual_folder:', e);
                }
            }

            ensureExpanded(normalized);
        }

        /// Move an entire virtual folder (and all descendant folders and assets) under `targetParentFolder`
        async function moveFolderTo(sourceFolder: string, targetParentFolder: string) {
            const source = normalizeVirtualFolder(sourceFolder);
            const targetParent = normalizeVirtualFolder(targetParentFolder);
            if (!source || source === '/' || source === targetParent || targetParent.startsWith(source + '/')) {
                return; // Refuse invalid or circular move
            }

            const folderBaseName = source.split('/').filter(Boolean).pop() || 'Folder';
            const newFolderPath = targetParent === '/' ? `/${folderBaseName}` : `${targetParent}/${folderBaseName}`;

            if (newFolderPath === source) return;

            // 1. Identify all affected assets
            const affectedAssets: { uuid: string; newVf: string }[] = [];
            for (const a of assets.value) {
                const vf = normalizeVirtualFolder(a.virtual_folder);
                if (vf === source) {
                    affectedAssets.push({ uuid: a.uuid, newVf: newFolderPath });
                } else if (vf.startsWith(source + '/')) {
                    const sub = vf.slice(source.length);
                    affectedAssets.push({ uuid: a.uuid, newVf: `${newFolderPath}${sub}` });
                }
            }

            // 2. Persist to backend for non-local assets
            for (const item of affectedAssets) {
                if (!item.uuid.startsWith('local:')) {
                    try {
                        await invoke('move_ingestor_asset', {
                            uuid: item.uuid,
                            virtual_folder: item.newVf,
                            api_base_url_override: null
                        });
                    } catch (e) {
                        console.warn('[LibraryStore] Failed to update backend virtual_folder on folder move:', e);
                    }
                }
                folderOverrides.value[item.uuid] = item.newVf;
            }

            // 3. Update local asset state
            const nextAssets = assets.value.map(a => {
                const found = affectedAssets.find(x => x.uuid === a.uuid);
                return found ? { ...a, virtual_folder: found.newVf } : a;
            });
            assets.value = nextAssets;

            // 4. Update transient folders
            const nextTransient: Record<string, any> = {};
            for (const [tf, val] of Object.entries(transientFolders.value)) {
                if (tf === source) {
                    nextTransient[newFolderPath] = targetParent;
                } else if (tf.startsWith(source + '/')) {
                    const sub = tf.slice(source.length);
                    nextTransient[`${newFolderPath}${sub}`] = newFolderPath;
                } else {
                    nextTransient[tf] = val;
                }
            }
            transientFolders.value = nextTransient;

            // 5. Update folder colors
            const nextColors: Record<string, string> = { ...folderColors.value };
            if (nextColors[source]) {
                nextColors[newFolderPath] = nextColors[source]!;
                delete nextColors[source];
            }
            for (const [fc, col] of Object.entries(folderColors.value)) {
                if (fc.startsWith(source + '/')) {
                    const sub = fc.slice(source.length);
                    nextColors[`${newFolderPath}${sub}`] = col;
                    delete nextColors[fc];
                }
            }
            folderColors.value = nextColors;

            // 6. Update expanded folders
            expandedFolders.value = expandedFolders.value.map(f => {
                if (f === source) return newFolderPath;
                if (f.startsWith(source + '/')) return `${newFolderPath}${f.slice(source.length)}`;
                return f;
            });

            ensureExpanded(targetParent);
            ensureExpanded(newFolderPath);
            currentFolderPath.value = newFolderPath;
            selectedNodeId.value = `folder:${newFolderPath}`;
        }

        function moveFolderInto(sourceFolder: string, targetFolder: string) {
            moveFolderTo(sourceFolder, targetFolder);
        }

        function renameAsset(uuid: string, newDisplayName: string) {
            const trimmed = newDisplayName.trim();
            if (!trimmed) return;
            updateAsset(uuid, { display_name: trimmed });
        }

        function deleteAsset(uuid: string) {
            if (deletedUuids.value.includes(uuid)) return;
            deletedUuids.value.push(uuid);
            if (selectedNodeId.value === `asset:${uuid}`) {
                selectedNodeId.value = null;
            }
        }

        function removeTransientFolder(folderPath: string) {
            const hasAssets = assets.value.some(a => {
                if (deletedUuids.value.includes(a.uuid)) return false;
                const vf = a.virtual_folder || '/';
                return vf === folderPath || vf.startsWith(folderPath + '/');
            });
            if (hasAssets) {
                window.alert('Cannot remove folder: it contains active media assets.');
                return;
            }
            delete transientFolders.value[folderPath];
            for (const key of Object.keys(transientFolders.value)) {
                if (key.startsWith(folderPath + '/')) {
                    delete transientFolders.value[key];
                }
            }
        }

        function renameTransientFolder(oldPath: string, newName: string) {
            const trimmed = newName.trim();
            if (!trimmed || trimmed.includes('/')) {
                window.alert('Invalid folder name.');
                return;
            }

            const parts = oldPath.split('/');
            parts[parts.length - 1] = trimmed;
            const newPath = parts.join('/');

            if (transientFolders.value[newPath]) {
                window.alert('A folder with that name already exists.');
                return;
            }

            if (transientFolders.value[oldPath] !== undefined) {
                const parent = transientFolders.value[oldPath];
                delete transientFolders.value[oldPath];
                transientFolders.value[newPath] = parent;
            }

            for (const key of Object.keys(transientFolders.value)) {
                if (key.startsWith(oldPath + '/')) {
                    const subNewPath = key.replace(oldPath + '/', newPath + '/');
                    const parentVal = transientFolders.value[key];
                    if (parentVal !== undefined) {
                        const parent = parentVal.replace(oldPath, newPath);
                        delete transientFolders.value[key];
                        transientFolders.value[subNewPath] = parent;
                    }
                }
            }

            const nextAssets = [...assets.value];
            let assetsUpdated = false;
            for (let i = 0; i < nextAssets.length; i++) {
                const a = nextAssets[i]!;
                const vf = a.virtual_folder || '/';
                if (vf === oldPath) {
                    nextAssets[i] = { ...a, virtual_folder: newPath };
                    assetsUpdated = true;
                } else if (vf.startsWith(oldPath + '/')) {
                    nextAssets[i] = { ...a, virtual_folder: vf.replace(oldPath + '/', newPath + '/') };
                    assetsUpdated = true;
                }
            }
            if (assetsUpdated) {
                assets.value = nextAssets;
            }

            expandedFolders.value = expandedFolders.value.map(folder => {
                if (folder === oldPath) return newPath;
                if (folder.startsWith(oldPath + '/')) {
                    return folder.replace(oldPath + '/', newPath + '/');
                }
                return folder;
            });

            if (selectedNodeId.value === `folder:${oldPath}`) {
                selectedNodeId.value = `folder:${newPath}`;
            }
        }

        function getNodeDefaultCompliance(node: TreeNode): ComplianceRating {
            if (node.type === 'asset' && node.asset) {
                const fromApi = mapApiRating(node.asset.rating);
                if (fromApi !== 'none') return fromApi;
                return mediaDefaults.getCompliance(node.asset.uuid, node.asset.current_path);
            }
            return 'none';
        }

        function getNodeDefaultIndicator(node: TreeNode): LibraryIndicator {
            if (node.type === 'asset' && node.asset) {
                return mediaDefaults.getIndicator(node.asset.uuid, node.asset.current_path);
            }
            return 'none';
        }

        function durationSeconds(uuid: string): number {
            const asset = assets.value.find((a) => a.uuid === uuid);
            if (!asset) return 0;
            return asset.duration_ms > 0 ? asset.duration_ms / 1000 : 0;
        }

        async function updateAssetMetadata(
            uuid: string,
            updates: {
                complianceRating?: ComplianceRating;
                complianceText?: string;
                tp_flag?: boolean;
                content_type?: 'movie' | 'show' | 'documentary' | 'news' | 'none';
                timeline?: Array<{ start: number; end: number; text: string }>;
            }
        ) {
            const asset = assets.value.find((a) => a.uuid === uuid);
            if (!asset) return;

            const currentMeta = parseBroadcastRating(asset.rating);
            const age = updates.complianceRating !== undefined ? updates.complianceRating : currentMeta.ageRating;
            const tp = updates.tp_flag !== undefined ? updates.tp_flag : currentMeta.tpFlag;
            const content = updates.content_type !== undefined ? updates.content_type : currentMeta.contentType;
            const timeline = updates.timeline !== undefined
                ? updates.timeline
                : (updates.complianceText ? [{ start: 0, end: 30000, text: updates.complianceText }] : currentMeta.timeline);
            const advisoryText = updates.complianceText !== undefined
                ? updates.complianceText
                : (timeline[0]?.text || currentMeta.advisoryText || '');

            const serialized = serializeBroadcastRating({
                ageRating: age,
                tpFlag: tp,
                contentType: content,
                timeline: timeline
            });

            // 1. Update backend database first
            if (!uuid.startsWith('local:')) {
                try {
                    if (updates.complianceRating !== undefined || updates.complianceText !== undefined) {
                        await invoke('update_ingestor_rating', {
                            uuid,
                            rating: age,
                            apiBaseUrlOverride: null
                        });
                    }
                    if (updates.tp_flag !== undefined) {
                        await invoke('update_ingestor_tp', {
                            uuid,
                            tp: tp ? 'TP' : 'None',
                            apiBaseUrlOverride: null
                        });
                    }
                } catch (error) {
                    console.error('[LibraryStore] Failed to update backend metadata:', error);
                    return;
                }
            }

            // 2. Update local asset
            updateAsset(uuid, { rating: serialized, tp: tp ? 'TP' : 'None' });

            // 3. Sync with Rundown Store items
            const rundownStore = useRundownStore();
            for (const playlist of rundownStore.playlists) {
                let changed = false;
                playlist.items.forEach((item, idx) => {
                    if (item.playoutvueId === uuid) {
                        playlist.items[idx] = {
                            ...item,
                            complianceRating: age,
                            complianceText: advisoryText,
                            tp_flag: tp,
                            content_type: content,
                            timeline: timeline
                        };
                        changed = true;
                    }
                });
                if (changed) {
                    rundownStore.triggerPlaylistsUpdate();
                }
            }
        }

        async function fetchFolderColors() {
            try {
                const colors = await invoke<Array<{ virtual_folder: string; color: string }>>('list_ingestor_folder_colors');
                if (colors) {
                    for (const { virtual_folder, color } of colors) {
                        folderColors.value[normalizeVirtualFolder(virtual_folder)] = color;
                    }
                }
            } catch (error) {
                console.warn('[LibraryStore] Failed to fetch folder colors:', error);
            }
        }

        async function setFolderColor(folderPath: string, color: string) {
            const normalized = normalizeVirtualFolder(folderPath);
            folderColors.value[normalized] = color;
            try {
                await invoke('set_ingestor_folder_color', { virtualFolder: normalized, color });
            } catch (error) {
                console.error('[LibraryStore] Failed to set folder color:', error);
            }
        }

        async function fetchRecycleBin() {
            isRecycleBinLoading.value = true;
            try {
                const res = await invoke<any[]>('list_ingestor_recycle_bin', {
                    apiBaseUrlOverride: null
                });
                if (res) {
                    recycleBinAssets.value = res.map((a) => ({
                        uuid: a.uuid,
                        current_path: a.current_path,
                        display_name: a.display_name || a.current_path?.split(/[/\\]/).pop() || 'Untitled',
                        virtual_folder: normalizeVirtualFolder(a.virtual_folder),
                        duration_ms: a.duration_ms || 0,
                        trim_in_ms: a.trim_in_ms || 0,
                        trim_out_ms: a.trim_out_ms || a.duration_ms || 0,
                        rating: a.rating || 'K',
                        tp: a.tp || 'None',
                        status: a.status || 'ready',
                        mezzanine_ok: a.mezzanine_ok,
                        fps: a.fps,
                        fpsNum: a.fps_num,
                        fpsDen: a.fps_den,
                        warnings: a.warnings,
                        qc_report: a.qc_report,
                        loudness: a.loudness,
                        deleted_at: a.deleted_at,
                        original_virtual_folder: a.original_virtual_folder
                    }));
                }
            } catch (error) {
                console.warn('[LibraryStore] Failed to fetch recycle bin:', error);
            } finally {
                isRecycleBinLoading.value = false;
            }
        }

        async function trashAsset(uuid: string) {
            try {
                if (!uuid.startsWith('local:')) {
                    await invoke('trash_ingestor_asset', { uuid, apiBaseUrlOverride: null });
                }
            } catch (error) {
                console.error('[LibraryStore] Failed to trash asset on backend:', error);
                throw error;
            }

            const idx = assets.value.findIndex(a => a.uuid === uuid);
            if (idx >= 0) {
                assets.value.splice(idx, 1);
            }
            if (selectedNodeId.value === `asset:${uuid}`) {
                selectedNodeId.value = null;
            }
            fetchRecycleBin();
        }

        async function trashFolder(folderPath: string) {
            const norm = normalizeVirtualFolder(folderPath);
            try {
                await invoke('trash_ingestor_folder', { folderPath: norm, apiBaseUrlOverride: null });
            } catch (error) {
                console.error('[LibraryStore] Failed to trash folder on backend:', error);
                throw error;
            }

            // Remove all matching assets from local state
            assets.value = assets.value.filter(a => {
                const vf = normalizeVirtualFolder(a.virtual_folder);
                if (norm === '/') return false;
                return vf !== norm && !vf.startsWith(norm + '/');
            });

            // Clean up transient folder entries
            delete transientFolders.value[norm];
            for (const key of Object.keys(transientFolders.value)) {
                if (key.startsWith(norm + '/')) {
                    delete transientFolders.value[key];
                }
            }

            if (currentFolderPath.value === norm || currentFolderPath.value.startsWith(norm + '/')) {
                currentFolderPath.value = '/';
            }
            if (selectedNodeId.value === `folder:${norm}` || selectedNodeId.value?.startsWith(`folder:${norm}/`)) {
                selectedNodeId.value = null;
            }

            fetchRecycleBin();
        }

        async function restoreAsset(uuid: string, targetFolder?: string) {
            try {
                await invoke('restore_ingestor_asset', {
                    uuid,
                    targetFolder: targetFolder ? normalizeVirtualFolder(targetFolder) : null,
                    apiBaseUrlOverride: null
                });
            } catch (error) {
                console.error('[LibraryStore] Failed to restore asset:', error);
                throw error;
            }

            // Remove from recycle bin list locally
            recycleBinAssets.value = recycleBinAssets.value.filter(a => a.uuid !== uuid);
        }

        async function restoreFolder(folderPath: string, fallbackToRoot = false) {
            const norm = normalizeVirtualFolder(folderPath);
            try {
                await invoke('restore_ingestor_folder', {
                    folderPath: norm,
                    fallbackToRoot,
                    apiBaseUrlOverride: null
                });
            } catch (error) {
                console.error('[LibraryStore] Failed to restore folder:', error);
                throw error;
            }

            await fetchRecycleBin();
        }

        async function purgeAsset(uuid: string) {
            try {
                await invoke('purge_ingestor_asset', { uuid, apiBaseUrlOverride: null });
            } catch (error) {
                console.error('[LibraryStore] Failed to purge asset:', error);
                throw error;
            }

            assets.value = assets.value.filter(a => a.uuid !== uuid);
            recycleBinAssets.value = recycleBinAssets.value.filter(a => a.uuid !== uuid);
        }

        async function purgeFolder(folderPath: string) {
            const norm = normalizeVirtualFolder(folderPath);
            try {
                await invoke('purge_ingestor_folder', { folderPath: norm, apiBaseUrlOverride: null });
            } catch (error) {
                console.error('[LibraryStore] Failed to purge folder:', error);
                throw error;
            }

            await fetchRecycleBin();
        }

        async function emptyRecycleBin() {
            try {
                await invoke('purge_ingestor_recycle_bin', { apiBaseUrlOverride: null });
            } catch (error) {
                console.error('[LibraryStore] Failed to empty recycle bin:', error);
                throw error;
            }

            recycleBinAssets.value = [];
        }

        async function checkAndTriggerAutoPurge(policy: string) {
            if (!policy || policy === 'disabled') return;
            try {
                await invoke('auto_purge_ingestor_recycle_bin', { policy, apiBaseUrlOverride: null });
            } catch (error) {
                console.warn('[LibraryStore] Auto-purge execution note:', error);
            }
        }

        return {
            assets,
            recycleBinAssets,
            isRecycleBinLoading,
            currentFolderPath,
            searchQuery,
            selectedNodeId,
            selectedNodeIds,
            selectionAnchorNodeId,
            selectedAssetId,
            selectedAssetIds,
            expandedFolders,
            deletedUuids,
            transientFolders,
            localVirtualFolders,
            folderOverrides,
            folderColors,
            allTreeNodes,
            selectedAsset,
            currentFolderAssets,
            selectNode,
            moveSelectionDelta,
            moveSelectionPage,
            selectFirst,
            selectLast,
            extendSelection,
            clearSelection,
            setAssets,
            updateAsset,
            navigateTo,
            toggleFolder,
            createVirtualFolder,
            moveAssetToFolder,
            moveFolderTo,
            moveFolderInto,
            renameAsset,
            deleteAsset,
            removeTransientFolder,
            renameTransientFolder,
            getNodeDefaultCompliance,
            getNodeDefaultIndicator,
            durationSeconds,
            updateAssetMetadata,
            fetchFolderColors,
            setFolderColor,
            fetchRecycleBin,
            trashAsset,
            trashFolder,
            restoreAsset,
            restoreFolder,
            purgeAsset,
            purgeFolder,
            emptyRecycleBin,
            checkAndTriggerAutoPurge,
        };
    },
    {
        persist: {
            pick: ['expandedFolders', 'deletedUuids', 'selectedNodeId', 'currentFolderPath', 'transientFolders', 'localVirtualFolders', 'folderOverrides', 'folderColors'],
        },
    }
);

