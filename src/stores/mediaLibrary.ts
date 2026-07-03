import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useMediaDefaultsStore, type LibraryIndicator } from './mediaDefaults';
import { useRundownStore, parseBroadcastRating, serializeBroadcastRating } from './rundown';
import type { ComplianceRating } from './rundown';
import { invoke } from '@tauri-apps/api/core';

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

interface FolderNode {
    virtualFolder: string;
    children: FolderNode[];
    assets: LibraryAsset[];
}

function buildFolderTree(assets: LibraryAsset[]): FolderNode {
    const root: FolderNode = { virtualFolder: '/', children: [], assets: [] };
    const map = new Map<string, FolderNode>();
    map.set('/', root);

    function ensureFolder(folderPath: string): FolderNode {
        const normalized = normalizeVirtualFolder(folderPath);
        if (map.has(normalized)) return map.get(normalized)!;

        let parentPath = '/';
        const parts = normalized.split('/').filter(Boolean);
        let currentPath = '/';
        for (let i = 0; i < parts.length; i += 1) {
            const parent = currentPath;
            currentPath = i === 0 ? `/${parts[i]}` : `${currentPath}/${parts[i]}`;
            if (!map.has(currentPath)) {
                const newFolder: FolderNode = { virtualFolder: currentPath, children: [], assets: [] };
                map.set(currentPath, newFolder);
                map.get(parent)!.children.push(newFolder);
            }
        }
        return map.get(normalized)!;
    }

    for (const asset of assets) {
        const folder = ensureFolder(asset.virtual_folder);
        folder.assets.push(asset);
    }

    sortFolderTree(root);
    return root;
}

function sortFolderTree(node: FolderNode) {
    node.children.sort((a, b) => a.virtualFolder.localeCompare(b.virtualFolder));
    node.assets.sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
    for (const child of node.children) sortFolderTree(child);
}

function flattenVisibleTree(
    node: FolderNode,
    expanded: ReadonlySet<string>,
    depth: number,
    deleted: ReadonlySet<string>,
    transientFolders: ReadonlyMap<string, string>,
    folderColors: Record<string, string>,
): TreeNode[] {
    const result: TreeNode[] = [];
    const isExpanded = expanded.has(node.virtualFolder) || node.virtualFolder === '/';

    const folderNode: TreeNode = {
        id: `folder:${node.virtualFolder}`,
        type: 'folder',
        name: folderName(node.virtualFolder),
        virtualFolder: node.virtualFolder,
        depth,
        expanded: isExpanded,
        isTransient: transientFolders.has(node.virtualFolder),
        color: folderColors[node.virtualFolder] || '',
    };
    result.push(folderNode);

    if (!isExpanded) return result;

    for (const child of node.children) {
        result.push(...flattenVisibleTree(child, expanded, depth + 1, deleted, transientFolders, folderColors));
    }

    for (const asset of node.assets) {
        if (deleted.has(asset.uuid)) continue;
        const displayName = asset.display_name || asset.current_path?.split(/[/\\]/).pop() || 'Untitled';
        result.push({
            id: `asset:${asset.uuid}`,
            type: 'asset',
            name: displayName,
            virtualFolder: node.virtualFolder,
            depth: depth + 1,
            asset,
        });
    }

    return result;
}

function filterTreeForSearch(
    node: FolderNode,
    query: string,
    deleted: ReadonlySet<string>,
    folderColors: Record<string, string>,
): { matches: TreeNode[]; hasMatch: boolean; expanded: Set<string> } {
    const result: TreeNode[] = [];
    const expanded = new Set<string>();
    let hasMatch = false;

    const folderMatch = folderName(node.virtualFolder).toLowerCase().includes(query);
    if (folderMatch) hasMatch = true;

    const childResults = node.children.map((child) =>
        filterTreeForSearch(child, query, deleted, folderColors)
    );
    const anyChildMatch = childResults.some((r) => r.hasMatch);
    const matchingAssets = node.assets.filter(
        (asset) => {
            const displayName = asset.display_name || asset.current_path?.split(/[/\\]/).pop() || 'Untitled';
            return !deleted.has(asset.uuid) && displayName.toLowerCase().includes(query);
        }
    );
    if (matchingAssets.length > 0) hasMatch = true;

    if (hasMatch) {
        result.push({
            id: `folder:${node.virtualFolder}`,
            type: 'folder',
            name: folderName(node.virtualFolder),
            virtualFolder: node.virtualFolder,
            depth: 0,
            expanded: true,
            color: folderColors[node.virtualFolder] || '',
        });
        expanded.add(node.virtualFolder);

        for (const childResult of childResults) {
            if (childResult.hasMatch) {
                result.push(...childResult.matches);
                for (const path of childResult.expanded) expanded.add(path);
            }
        }

        for (const asset of matchingAssets) {
            const displayName = asset.display_name || asset.current_path?.split(/[/\\]/).pop() || 'Untitled';
            result.push({
                id: `asset:${asset.uuid}`,
                type: 'asset',
                name: displayName,
                virtualFolder: node.virtualFolder,
                depth: 0,
                asset,
            });
        }
    }

    return { matches: result, hasMatch, expanded };
}

export const useMediaLibraryStore = defineStore('mediaLibrary',
    () => {
        const mediaDefaults = useMediaDefaultsStore();
        const assets = ref<LibraryAsset[]>([]);
        const currentFolderPath = ref('/');
        const searchQuery = ref('');
        const selectedNodeId = ref<string | null>(null);
        const expandedFolders = ref<string[]>(['/']);
        const deletedUuids = ref<string[]>([]);
        const transientFolders = ref<Record<string, string>>({});
        const localVirtualFolders = ref<Record<string, string>>({});
        const folderOverrides = ref<Record<string, string>>({});
        const folderColors = ref<Record<string, string>>({});

        const expandedFoldersSet = computed(() => new Set(expandedFolders.value));
        const deletedUuidsSet = computed(() => new Set(deletedUuids.value));
        const transientFoldersMap = computed(() => new Map(Object.entries(transientFolders.value)));

        function folderTree(): FolderNode {
            const tree = buildFolderTree(assets.value);

            // Inject transient folders under current selected folder but keep them in expanded state
            for (const [folderPath, parentPath] of Object.entries(transientFolders.value)) {
                const parent = findFolderNode(tree, parentPath || '/');
                if (parent && !parent.children.some((c) => c.virtualFolder === folderPath)) {
                    parent.children.push({
                        virtualFolder: folderPath,
                        children: [],
                        assets: [],
                    });
                    parent.children.sort((a, b) =>
                        a.virtualFolder.localeCompare(b.virtualFolder)
                    );
                }
            }
            return tree;
        }

        function findFolderNode(tree: FolderNode, path: string): FolderNode | null {
            if (tree.virtualFolder === path) return tree;
            for (const child of tree.children) {
                const found = findFolderNode(child, path);
                if (found) return found;
            }
            return null;
        }

        const allTreeNodes = computed<TreeNode[]>(() => {
            const query = searchQuery.value.trim().toLowerCase();
            const tree = folderTree();
            if (query) {
                const { matches } = filterTreeForSearch(
                    tree,
                    query,
                    deletedUuidsSet.value,
                    folderColors.value,
                );
                return matches;
            }
            const visible = flattenVisibleTree(
                tree,
                expandedFoldersSet.value,
                0,
                deletedUuidsSet.value,
                transientFoldersMap.value,
                folderColors.value,
            );
            return ensureFolderAsSelected(visible);
        });

        // Ensure selected folder is expanded so its contents are visible
        function ensureFolderAsSelected(nodes: TreeNode[]): TreeNode[] {
            if (!selectedNodeId.value) return nodes;
            const selectedFolder = nodes.find(
                (n) => n.id === selectedNodeId.value && n.type === 'folder'
            );
            if (selectedFolder && !selectedFolder.expanded) {
                ensureExpanded(selectedFolder.virtualFolder);
                const tree = folderTree();
                return flattenVisibleTree(
                    tree,
                    expandedFoldersSet.value,
                    0,
                    deletedUuidsSet.value,
                    transientFoldersMap.value,
                    folderColors.value,
                );
            }
            return nodes;
        }

        const selectedAsset = computed<LibraryAsset | null>(() => {
            if (!selectedNodeId.value?.startsWith('asset:')) return null;
            const uuid = selectedNodeId.value.slice(6);
            return assets.value.find((a) => a.uuid === uuid) || null;
        });

        const currentFolderAssets = computed<LibraryAsset[]>(() =>
            assets.value.filter(
                (a) =>
                    !deletedUuidsSet.value.has(a.uuid) &&
                    normalizeVirtualFolder(a.virtual_folder) === normalizeVirtualFolder(currentFolderPath.value)
            )
        );

        function setAssets(next: LibraryAsset[]) {
            const processed = next.map((asset) => {
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

        function createVirtualFolder(name: string) {
            const trimmed = name.trim();
            if (!trimmed) return;
            const base = normalizeVirtualFolder(currentFolderPath.value);
            const newPath = base === '/' ? `/${trimmed}` : `${base}/${trimmed}`;
            if (transientFolders.value[newPath]) return;

            transientFolders.value[newPath] = base;
            ensureExpanded(base);
            ensureExpanded(newPath);
            selectedNodeId.value = `folder:${newPath}`;
        }

        function moveAssetToFolder(uuid: string, folderPath: string) {
            const normalized = normalizeVirtualFolder(folderPath);
            updateAsset(uuid, { virtual_folder: normalized });

            // Record a uuid-keyed override so the move survives API refreshes even
            // when the Ingestor API does not persist it (plan §3.2 folderMap).
            folderOverrides.value[uuid] = normalized;

            if (uuid.startsWith('local:')) {
                const asset = assets.value.find((a) => a.uuid === uuid);
                if (asset) {
                    localVirtualFolders.value[asset.current_path] = normalized;
                }
            }

            // If the asset was inside a transient folder, that folder may now contain no assets.
            // We leave cleanup to the next explicit API refresh; the user can delete empty transients.
            ensureExpanded(normalized);
        }

        /// Move a whole virtual folder (and all its child assets) into `targetFolder` by
        /// re-prefixing every child asset's `virtual_folder`. Only `virtual_folder`
        /// changes — `current_path` is never mutated, so CasparCG file references stay
        /// intact (plan §3.2). Records uuid overrides so the move survives API refreshes.
        function moveFolderInto(sourceFolder: string, targetFolder: string) {
            const source = normalizeVirtualFolder(sourceFolder);
            const target = normalizeVirtualFolder(targetFolder);
            if (!source || source === '/' || source === target || target.startsWith(source + '/')) {
                return; // refuse no-op or nesting into own descendant
            }
            const sourceBaseName = source.split('/').filter(Boolean).pop() || source;
            const newFolderPath = target === '/' ? `/${sourceBaseName}` : `${target}/${sourceBaseName}`;

            let changed = false;

            for (let i = 0; i < assets.value.length; i++) {
                const a = assets.value[i]!;
                const vf = normalizeVirtualFolder(a.virtual_folder);
                let newVf: string | null = null;
                if (vf === source) {
                    newVf = newFolderPath;
                } else if (vf.startsWith(source + '/')) {
                    newVf = newFolderPath + vf.slice(source.length);
                }
                if (newVf !== null) {
                    const updated = { ...a, virtual_folder: normalizeVirtualFolder(newVf) };
                    assets.value.splice(i, 1, updated);
                    folderOverrides.value[a.uuid] = normalizeVirtualFolder(newVf);
                    changed = true;
                }
            }

            if (changed) {
                ensureExpanded(newFolderPath);
            }
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
            const timeline = updates.timeline !== undefined ? updates.timeline : currentMeta.timeline;

            const serialized = serializeBroadcastRating({
                ageRating: age,
                tpFlag: tp,
                contentType: content,
                timeline: timeline
            });

            // 1. Update backend database first
            if (!uuid.startsWith('local:')) {
                try {
                    if (updates.complianceRating !== undefined) {
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

        return {
            assets,
            currentFolderPath,
            searchQuery,
            selectedNodeId,
            expandedFolders,
            deletedUuids,
            transientFolders,
            localVirtualFolders,
            folderOverrides,
            folderColors,
            allTreeNodes,
            selectedAsset,
            currentFolderAssets,
            setAssets,
            updateAsset,
            navigateTo,
            toggleFolder,
            createVirtualFolder,
            moveAssetToFolder,
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
        };
    },
    {
        persist: {
            pick: ['expandedFolders', 'deletedUuids', 'selectedNodeId', 'currentFolderPath', 'transientFolders', 'localVirtualFolders', 'folderOverrides', 'folderColors'],
        },
    }
);

