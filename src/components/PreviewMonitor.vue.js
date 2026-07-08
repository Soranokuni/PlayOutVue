import { ref } from 'vue';
import { activePlayoutCapabilities, activePlayoutLabel, isPlayoutConnected } from '../services/playout';
const previewSrc = ref(null);
const lastError = ref('');
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "preview-monitor" },
});
/** @type {__VLS_StyleScopedClasses['preview-monitor']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "monitor-header" },
});
/** @type {__VLS_StyleScopedClasses['monitor-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "badge-program" },
});
/** @type {__VLS_StyleScopedClasses['badge-program']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "text-secondary" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
(__VLS_ctx.activePlayoutCapabilities.preview ? (__VLS_ctx.isPlayoutConnected ? (__VLS_ctx.previewSrc ? 'Live' : 'Waiting…') : 'Not connected') : __VLS_ctx.activePlayoutLabel + ' preview unavailable');
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "monitor-frame" },
});
/** @type {__VLS_StyleScopedClasses['monitor-frame']} */ ;
if (__VLS_ctx.previewSrc) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
        src: (__VLS_ctx.previewSrc),
        ...{ class: "monitor-image" },
        alt: "Playout Program Output",
    });
    /** @type {__VLS_StyleScopedClasses['monitor-image']} */ ;
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "monitor-placeholder" },
    });
    /** @type {__VLS_StyleScopedClasses['monitor-placeholder']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
}
// @ts-ignore
[activePlayoutCapabilities, isPlayoutConnected, previewSrc, previewSrc, previewSrc, activePlayoutLabel,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
