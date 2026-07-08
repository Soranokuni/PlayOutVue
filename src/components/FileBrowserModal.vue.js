import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
const props = withDefaults(defineProps(), {
    startPath: '',
    extensions: () => [],
    defaultFileName: '',
    description: ''
});
const emit = defineEmits();
const roots = ref([]);
const currentPath = ref('');
const parentPath = ref(null);
const entries = ref([]);
const selectedEntry = ref(null);
const fileName = ref('');
const isLoading = ref(false);
const errorMessage = ref('');
const showFiles = computed(() => props.mode !== 'directory');
const canConfirm = computed(() => {
    if (props.mode === 'directory')
        return !!currentPath.value;
    if (props.mode === 'open-file')
        return selectedEntry.value?.entry_type === 'file';
    return !!currentPath.value && !!fileName.value.trim();
});
const normalizeJoin = (base, child) => {
    if (!base)
        return child;
    const separator = base.endsWith('\\') || base.endsWith('/') ? '' : '/';
    return `${base}${separator}${child}`;
};
const ensureExtension = (value) => {
    const trimmed = value.trim();
    if (!trimmed || props.mode !== 'save-file' || props.extensions.length !== 1)
        return trimmed;
    const ext = (props.extensions[0] || '').replace(/^\./, '');
    return trimmed.toLowerCase().endsWith(`.${ext}`) ? trimmed : `${trimmed}.${ext}`;
};
const loadRoots = async () => {
    roots.value = await invoke('list_filesystem_roots');
};
const openDirectory = async (path) => {
    isLoading.value = true;
    errorMessage.value = '';
    selectedEntry.value = null;
    try {
        const listing = await invoke('browse_filesystem', {
            path,
            showFiles: showFiles.value,
            allowedExtensions: props.extensions.length ? props.extensions : null
        });
        currentPath.value = listing.current_path;
        parentPath.value = listing.parent_path || null;
        entries.value = listing.entries;
    }
    catch (error) {
        errorMessage.value = String(error);
    }
    finally {
        isLoading.value = false;
    }
};
const initializeBrowser = async () => {
    if (!props.isOpen)
        return;
    fileName.value = props.defaultFileName;
    selectedEntry.value = null;
    await loadRoots();
    const rawInitialPath = props.startPath || roots.value[0] || '';
    if (rawInitialPath) {
        const looksLikeFile = showFiles.value && !!rawInitialPath.split(/[\\/]/).pop()?.includes('.');
        const initialPath = looksLikeFile ? rawInitialPath.replace(/[\\/][^\\/]+$/, '') : rawInitialPath;
        if (props.mode === 'save-file' && looksLikeFile) {
            fileName.value = rawInitialPath.split(/[\\/]/).pop() || props.defaultFileName;
        }
        await openDirectory(initialPath || roots.value[0] || rawInitialPath);
    }
};
const selectEntry = (entry) => {
    selectedEntry.value = entry;
    if (props.mode === 'save-file' && entry.entry_type === 'file') {
        fileName.value = entry.name;
    }
};
const activateEntry = async (entry) => {
    if (entry.entry_type === 'folder') {
        await openDirectory(entry.path);
        return;
    }
    if (props.mode === 'open-file') {
        emit('select', entry.path);
    }
};
const confirmSelection = () => {
    if (!canConfirm.value)
        return;
    if (props.mode === 'directory') {
        emit('select', currentPath.value);
        return;
    }
    if (props.mode === 'open-file') {
        if (selectedEntry.value?.entry_type === 'file')
            emit('select', selectedEntry.value.path);
        return;
    }
    emit('select', normalizeJoin(currentPath.value, ensureExtension(fileName.value)));
};
watch(() => props.isOpen, (open) => {
    if (open)
        initializeBrowser();
});
const __VLS_defaults = {
    startPath: '',
    extensions: () => [],
    defaultFileName: '',
    description: ''
};
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['browser-footer']} */ ;
/** @type {__VLS_StyleScopedClasses['browser-header']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar-item']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar-item']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar-item']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['browser-entry']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['browser-entry']} */ ;
/** @type {__VLS_StyleScopedClasses['browser-entry']} */ ;
/** @type {__VLS_StyleScopedClasses['browser-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['browser-shell']} */ ;
/** @type {__VLS_StyleScopedClasses['browser-sidebar']} */ ;
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
if (__VLS_ctx.isOpen) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.emit('close'));
                // @ts-ignore
                [isOpen, emit,];
            } },
        ...{ class: "modal-backdrop" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-backdrop']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "glass-panel browser-modal" },
    });
    /** @type {__VLS_StyleScopedClasses['glass-panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['browser-modal']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "browser-header" },
    });
    /** @type {__VLS_StyleScopedClasses['browser-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
        ...{ class: "text-accent" },
    });
    /** @type {__VLS_StyleScopedClasses['text-accent']} */ ;
    (__VLS_ctx.title);
    if (__VLS_ctx.description) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "browser-description" },
        });
        /** @type {__VLS_StyleScopedClasses['browser-description']} */ ;
        (__VLS_ctx.description);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.emit('close'));
                // @ts-ignore
                [emit, title, description, description,];
            } },
        ...{ class: "icon-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "browser-shell" },
    });
    /** @type {__VLS_StyleScopedClasses['browser-shell']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.aside, __VLS_intrinsics.aside)({
        ...{ class: "browser-sidebar" },
    });
    /** @type {__VLS_StyleScopedClasses['browser-sidebar']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "sidebar-title" },
    });
    /** @type {__VLS_StyleScopedClasses['sidebar-title']} */ ;
    for (const [root] of __VLS_vFor((__VLS_ctx.roots))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    return (__VLS_ctx.openDirectory(root));
                    // @ts-ignore
                    [roots, openDirectory,];
                } },
            key: (root),
            ...{ class: "sidebar-item" },
            ...{ class: ({ active: __VLS_ctx.currentPath.startsWith(root) }) },
        });
        /** @type {__VLS_StyleScopedClasses['sidebar-item']} */ ;
        /** @type {__VLS_StyleScopedClasses['active']} */ ;
        (root);
        // @ts-ignore
        [currentPath,];
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
        ...{ class: "browser-main" },
    });
    /** @type {__VLS_StyleScopedClasses['browser-main']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "browser-toolbar" },
    });
    /** @type {__VLS_StyleScopedClasses['browser-toolbar']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.parentPath && __VLS_ctx.openDirectory(__VLS_ctx.parentPath));
                // @ts-ignore
                [openDirectory, parentPath, parentPath,];
            } },
        ...{ class: "toolbar-btn" },
        disabled: (!__VLS_ctx.parentPath),
    });
    /** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "path-pill" },
        title: (__VLS_ctx.currentPath),
    });
    /** @type {__VLS_StyleScopedClasses['path-pill']} */ ;
    (__VLS_ctx.currentPath || 'Select a drive');
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.currentPath && __VLS_ctx.openDirectory(__VLS_ctx.currentPath));
                // @ts-ignore
                [openDirectory, currentPath, currentPath, currentPath, currentPath, parentPath,];
            } },
        ...{ class: "toolbar-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "browser-list" },
    });
    /** @type {__VLS_StyleScopedClasses['browser-list']} */ ;
    if (__VLS_ctx.isLoading) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "browser-empty" },
        });
        /** @type {__VLS_StyleScopedClasses['browser-empty']} */ ;
    }
    else if (__VLS_ctx.errorMessage) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "browser-empty is-error" },
        });
        /** @type {__VLS_StyleScopedClasses['browser-empty']} */ ;
        /** @type {__VLS_StyleScopedClasses['is-error']} */ ;
        (__VLS_ctx.errorMessage);
    }
    else if (__VLS_ctx.entries.length === 0) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "browser-empty" },
        });
        /** @type {__VLS_StyleScopedClasses['browser-empty']} */ ;
    }
    for (const [entry] of __VLS_vFor((__VLS_ctx.entries))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    return (__VLS_ctx.selectEntry(entry));
                    // @ts-ignore
                    [isLoading, errorMessage, errorMessage, entries, entries, selectEntry,];
                } },
            ...{ onDblclick: (...[$event]) => {
                    if (!(__VLS_ctx.isOpen))
                        throw 0;
                    return (__VLS_ctx.activateEntry(entry));
                    // @ts-ignore
                    [activateEntry,];
                } },
            key: (entry.path),
            ...{ class: "browser-entry" },
            ...{ class: ({ selected: __VLS_ctx.selectedEntry?.path === entry.path }) },
        });
        /** @type {__VLS_StyleScopedClasses['browser-entry']} */ ;
        /** @type {__VLS_StyleScopedClasses['selected']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "entry-icon" },
        });
        /** @type {__VLS_StyleScopedClasses['entry-icon']} */ ;
        (entry.entry_type === 'folder' ? '📁' : '📄');
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "entry-name" },
        });
        /** @type {__VLS_StyleScopedClasses['entry-name']} */ ;
        (entry.name);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "entry-kind" },
        });
        /** @type {__VLS_StyleScopedClasses['entry-kind']} */ ;
        (entry.entry_type === 'folder' ? 'Folder' : 'File');
        // @ts-ignore
        [selectedEntry,];
    }
    if (__VLS_ctx.mode === 'save-file') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "save-row" },
        });
        /** @type {__VLS_StyleScopedClasses['save-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            ...{ class: "save-label" },
        });
        /** @type {__VLS_StyleScopedClasses['save-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            ...{ onKeydown: (__VLS_ctx.confirmSelection) },
            ...{ class: "glass-input" },
            placeholder: "playlist.playout",
        });
        (__VLS_ctx.fileName);
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "browser-footer" },
    });
    /** @type {__VLS_StyleScopedClasses['browser-footer']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "footer-hint" },
    });
    /** @type {__VLS_StyleScopedClasses['footer-hint']} */ ;
    (__VLS_ctx.mode === 'directory' ? 'The current folder will be selected.' : __VLS_ctx.mode === 'open-file' ? 'Select a file to continue.' : 'Choose a folder and enter a file name.');
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "footer-actions" },
    });
    /** @type {__VLS_StyleScopedClasses['footer-actions']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.isOpen))
                    throw 0;
                return (__VLS_ctx.emit('close'));
                // @ts-ignore
                [emit, mode, mode, mode, confirmSelection, fileName,];
            } },
        ...{ class: "toolbar-btn" },
    });
    /** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.confirmSelection) },
        ...{ class: "toolbar-btn btn-primary" },
        disabled: (!__VLS_ctx.canConfirm),
    });
    /** @type {__VLS_StyleScopedClasses['toolbar-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    (__VLS_ctx.mode === 'directory' ? 'Use Folder' : __VLS_ctx.mode === 'open-file' ? 'Open' : 'Save Here');
}
// @ts-ignore
[mode, mode, confirmSelection, canConfirm,];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __defaults: __VLS_defaults,
    __typeProps: {},
});
export default {};
