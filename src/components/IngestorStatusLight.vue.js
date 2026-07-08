import { computed } from 'vue';
import { useIngestorStatusStore } from '../stores/ingestorStatus';
import { useSettingsStore } from '../stores/settings';
const status = useIngestorStatusStore();
const settings = useSettingsStore();
const tooltip = computed(() => {
    const base = settings.ingestorApiBaseUrl || 'http://127.0.0.1:4353';
    if (status.isIngestorOnline) {
        const seen = status.lastSeenAt
            ? new Date(status.lastSeenAt).toLocaleTimeString()
            : 'unknown';
        return `Ingestor online\n${base}\nLast heartbeat: ${seen}`;
    }
    const seen = status.lastSeenAt
        ? new Date(status.lastSeenAt).toLocaleTimeString()
        : 'never';
    return `Ingestor offline\n${base}\nLast seen: ${seen}`;
});
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "status-light-wrap" },
    title: (__VLS_ctx.tooltip),
});
/** @type {__VLS_StyleScopedClasses['status-light-wrap']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "status-dot" },
    ...{ class: ({ online: __VLS_ctx.status.isIngestorOnline, offline: !__VLS_ctx.status.isIngestorOnline }) },
});
/** @type {__VLS_StyleScopedClasses['status-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['online']} */ ;
/** @type {__VLS_StyleScopedClasses['offline']} */ ;
// @ts-ignore
[tooltip, status, status,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
