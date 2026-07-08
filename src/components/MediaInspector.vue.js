import { computed, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useRundownStore } from '../stores/rundown';
import ComplianceModule from './ComplianceModule.vue';
import { getActivePlayoutService } from '../services/playout';
const store = useRundownStore();
const ingestorFetchInFlight = ref(false);
const pushTrimInFlight = ref(false);
const pushRatingInFlight = ref(false);
const transcodeInfo = computed(() => {
    const item = store.selectedItem;
    if (!item?.playoutvueId)
        return null;
    return {
        uuid: item.playoutvueId,
        sourcePath: item.path,
    };
});
const statusLabel = (status) => ({
    idle: 'Unresolved',
    processing: 'Processing...',
    ready: 'Ready',
    error: 'Error',
    missing: 'Missing'
}[status] || status);
const statusColor = (status) => ({
    idle: '#555',
    processing: '#f8b400',
    ready: '#4caf50',
    error: '#e63946',
    missing: '#888'
}[status] || '#aaa');
const hasIngestorUuid = computed(() => !!(store.selectedItem?.playoutvueId));
const fetchFromIngestor = async () => {
    if (!store.selectedItem?.id || !store.selectedItem?.playoutvueId)
        return;
    ingestorFetchInFlight.value = true;
    try {
        await store.resolveAssetFromApi(store.selectedItem.id);
    }
    catch (error) {
        console.error('[Inspector] Ingestor fetch failed', error);
    }
    finally {
        ingestorFetchInFlight.value = false;
    }
};
const pushTrimToIngestor = async () => {
    const item = store.selectedItem;
    if (!item?.playoutvueId)
        return;
    pushTrimInFlight.value = true;
    try {
        const trimIn = item.trim_in_ms !== undefined ? item.trim_in_ms : item.inPoint;
        const trimOut = item.trim_out_ms !== undefined ? item.trim_out_ms : (item.duration_ms && item.outPoint ? item.duration_ms - item.outPoint : (item.duration && item.outPoint ? Math.round(item.duration * 1000) - item.outPoint : 0));
        await invoke('update_ingestor_trim', {
            uuid: item.playoutvueId,
            trim_in_ms: Math.round(trimIn),
            trim_out_ms: Math.round(trimOut),
            api_base_url_override: null
        });
    }
    catch (error) {
        console.error('[Inspector] Failed to push trim', error);
    }
    finally {
        pushTrimInFlight.value = false;
    }
};
const pushRatingToIngestor = async (rating) => {
    const item = store.selectedItem;
    if (!item?.playoutvueId)
        return;
    pushRatingInFlight.value = true;
    try {
        await invoke('update_ingestor_rating', {
            uuid: item.playoutvueId,
            rating: rating.toUpperCase(),
            apiBaseUrlOverride: null
        });
    }
    catch (error) {
        console.error('[Inspector] Failed to push rating', error);
    }
    finally {
        pushRatingInFlight.value = false;
    }
};
const adjustTrim = async (field, val) => {
    if (store.selectedItem && store.selectedItem.type !== 'gap') {
        const newVal = Math.max(0, store.selectedItem[field] + val);
        store.updateItem(store.selectedItem.id, {
            [field]: newVal
        });
        if (field === 'seek' && store.selectedItem.type === 'video') {
            await getActivePlayoutService().seekMedia?.(store.selectedItem.filename, newVal);
        }
    }
};
const fireCue = async () => {
    if (!store.selectedItem || store.selectedItem.type === 'gap')
        return;
    try {
        await getActivePlayoutService().cue?.(store.selectedItem);
    }
    catch (e) {
        console.error('Playout cue failed:', e);
    }
};
const firePlay = async () => {
    if (!store.selectedItem || store.selectedItem.type === 'gap')
        return;
    try {
        await getActivePlayoutService().take?.();
    }
    catch (e) {
        console.error('Playout take failed:', e);
    }
};
const fireClear = async () => {
    if (!store.selectedItem || store.selectedItem.type === 'gap')
        return;
    try {
        await getActivePlayoutService().clear();
    }
    catch (e) {
        console.error('Playout clear failed:', e);
    }
};
const getDisplayName = (item) => {
    if (!item)
        return '';
    if (item.display_name)
        return item.display_name;
    if (item.current_path) {
        const filename = item.current_path.split(/[/\\]/).pop();
        if (filename && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filename)) {
            return filename;
        }
    }
    if (item.filename && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.filename)) {
        return item.filename;
    }
    return 'Untitled Asset';
};
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-accent']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-accent']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "text-danger" },
});
/** @type {__VLS_StyleScopedClasses['text-danger']} */ ;
if (__VLS_ctx.store.selectedItem) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ style: {} },
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
        ...{ class: "text-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['text-primary']} */ ;
    (__VLS_ctx.getDisplayName(__VLS_ctx.store.selectedItem));
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-secondary text-sm" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
    (__VLS_ctx.store.selectedItem.current_path || __VLS_ctx.store.selectedItem.path);
    if (__VLS_ctx.store.selectedItem.displayPath && __VLS_ctx.store.selectedItem.displayPath !== (__VLS_ctx.store.selectedItem.current_path || __VLS_ctx.store.selectedItem.path)) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "text-secondary text-sm" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
        (__VLS_ctx.store.selectedItem.displayPath);
    }
    if (__VLS_ctx.hasIngestorUuid) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "inspector-group" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['inspector-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ style: {} },
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "text-accent" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['text-accent']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "igs-status-badge" },
            ...{ style: ({ color: __VLS_ctx.statusColor(__VLS_ctx.store.selectedItem.ingestorStatus), borderColor: __VLS_ctx.statusColor(__VLS_ctx.store.selectedItem.ingestorStatus) }) },
        });
        /** @type {__VLS_StyleScopedClasses['igs-status-badge']} */ ;
        (__VLS_ctx.statusLabel(__VLS_ctx.store.selectedItem.ingestorStatus));
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "text-secondary text-sm" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "mono" },
        });
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.store.selectedItem.playoutvueId);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ style: {} },
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.fetchFromIngestor) },
            ...{ class: "glass-btn btn-accent" },
            ...{ style: {} },
            disabled: (__VLS_ctx.ingestorFetchInFlight),
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-accent']} */ ;
        (__VLS_ctx.ingestorFetchInFlight ? 'Fetching...' : 'Fetch from Ingestor');
        if (__VLS_ctx.store.selectedItem.ingestorStatus !== 'idle') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ style: {} },
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (__VLS_ctx.pushTrimToIngestor) },
                ...{ class: "glass-btn" },
                ...{ style: {} },
                disabled: (__VLS_ctx.pushTrimInFlight),
                title: "Push current trim points to the Ingestor API",
            });
            /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
            (__VLS_ctx.pushTrimInFlight ? 'Pushing...' : 'Push Trim');
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.store.selectedItem))
                            throw 0;
                        if (!(__VLS_ctx.hasIngestorUuid))
                            throw 0;
                        if (!(__VLS_ctx.store.selectedItem.ingestorStatus !== 'idle'))
                            throw 0;
                        return (__VLS_ctx.pushRatingToIngestor(__VLS_ctx.store.selectedItem.complianceRating));
                        // @ts-ignore
                        [store, store, store, store, store, store, store, store, store, store, store, store, store, store, store, getDisplayName, hasIngestorUuid, statusColor, statusColor, statusLabel, fetchFromIngestor, ingestorFetchInFlight, ingestorFetchInFlight, pushTrimToIngestor, pushTrimInFlight, pushTrimInFlight, pushRatingToIngestor,];
                    } },
                ...{ class: "glass-btn" },
                ...{ style: {} },
                disabled: (__VLS_ctx.pushRatingInFlight),
                title: "Push current rating to the Ingestor API",
            });
            /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
            (__VLS_ctx.pushRatingInFlight ? 'Pushing...' : 'Push Rating');
        }
    }
    if (__VLS_ctx.store.selectedItem.type === 'video') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "inspector-group" },
        });
        /** @type {__VLS_StyleScopedClasses['inspector-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "text-accent" },
        });
        /** @type {__VLS_StyleScopedClasses['text-accent']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "control-row" },
        });
        /** @type {__VLS_StyleScopedClasses['control-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "adjuster" },
        });
        /** @type {__VLS_StyleScopedClasses['adjuster']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.store.selectedItem))
                        throw 0;
                    if (!(__VLS_ctx.store.selectedItem.type === 'video'))
                        throw 0;
                    return (__VLS_ctx.adjustTrim('seek', -10));
                    // @ts-ignore
                    [store, pushRatingInFlight, pushRatingInFlight, adjustTrim,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "number",
            value: (__VLS_ctx.store.selectedItem.seek),
            readonly: true,
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.store.selectedItem))
                        throw 0;
                    if (!(__VLS_ctx.store.selectedItem.type === 'video'))
                        throw 0;
                    return (__VLS_ctx.adjustTrim('seek', 10));
                    // @ts-ignore
                    [store, adjustTrim,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "control-row" },
        });
        /** @type {__VLS_StyleScopedClasses['control-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "adjuster" },
        });
        /** @type {__VLS_StyleScopedClasses['adjuster']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.store.selectedItem))
                        throw 0;
                    if (!(__VLS_ctx.store.selectedItem.type === 'video'))
                        throw 0;
                    return (__VLS_ctx.adjustTrim('length', -10));
                    // @ts-ignore
                    [adjustTrim,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "number",
            value: (__VLS_ctx.store.selectedItem.length),
            readonly: true,
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.store.selectedItem))
                        throw 0;
                    if (!(__VLS_ctx.store.selectedItem.type === 'video'))
                        throw 0;
                    return (__VLS_ctx.adjustTrim('length', 10));
                    // @ts-ignore
                    [store, adjustTrim,];
                } },
            ...{ class: "glass-btn" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "text-secondary text-sm" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
    }
    else if (__VLS_ctx.store.selectedItem.type === 'live') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "inspector-group" },
        });
        /** @type {__VLS_StyleScopedClasses['inspector-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "text-warning" },
        });
        /** @type {__VLS_StyleScopedClasses['text-warning']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "control-row" },
        });
        /** @type {__VLS_StyleScopedClasses['control-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
            ...{ class: "glass-input" },
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "1",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
            value: "2",
        });
    }
    else if (__VLS_ctx.store.selectedItem.type === 'gap') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "inspector-group" },
        });
        /** @type {__VLS_StyleScopedClasses['inspector-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "text-warning" },
        });
        /** @type {__VLS_StyleScopedClasses['text-warning']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "text-secondary text-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
        /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
    }
    if (__VLS_ctx.store.selectedItem.type !== 'gap') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "execution-controls" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['execution-controls']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.fireCue) },
            ...{ class: "glass-btn btn-primary" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.firePlay) },
            ...{ class: "glass-btn btn-warning" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-warning']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.fireClear) },
            ...{ class: "glass-btn btn-danger" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-danger']} */ ;
    }
    if (__VLS_ctx.store.selectedItem.type !== 'gap') {
        const __VLS_0 = ComplianceModule;
        // @ts-ignore
        const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({}));
        const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
    }
    if (__VLS_ctx.transcodeInfo) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "inspector-group" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['inspector-group']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "text-accent" },
        });
        /** @type {__VLS_StyleScopedClasses['text-accent']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "transcode-meta" },
        });
        /** @type {__VLS_StyleScopedClasses['transcode-meta']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "meta-row" },
        });
        /** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "meta-label" },
        });
        /** @type {__VLS_StyleScopedClasses['meta-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "meta-value mono" },
        });
        /** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.transcodeInfo.uuid);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "meta-row" },
        });
        /** @type {__VLS_StyleScopedClasses['meta-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "meta-label" },
        });
        /** @type {__VLS_StyleScopedClasses['meta-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "meta-value" },
        });
        /** @type {__VLS_StyleScopedClasses['meta-value']} */ ;
        (__VLS_ctx.transcodeInfo.sourcePath);
    }
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "empty-state" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "text-secondary text-sm" },
    });
    /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
}
// @ts-ignore
[store, store, store, store, fireCue, firePlay, fireClear, transcodeInfo, transcodeInfo, transcodeInfo,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
