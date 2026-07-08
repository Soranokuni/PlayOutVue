import { computed, ref } from 'vue';
import { useIngestorStatusStore } from '../stores/ingestorStatus';
const props = defineProps();
const emit = defineEmits();
const status = useIngestorStatusStore();
const localOpen = ref(props.modelValue ?? false);
const isOpen = computed({
    get: () => props.modelValue ?? localOpen.value,
    set: (value) => {
        localOpen.value = value;
        emit('update:modelValue', value);
    }
});
const formatTime = (timestamp) => {
    if (!timestamp)
        return '--:--:--';
    return new Date(timestamp).toLocaleTimeString([], {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
};
const clear = () => status.clearLog();
const toggle = () => { isOpen.value = !isOpen.value; };
const close = () => { isOpen.value = false; };
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
/** @type {__VLS_StyleScopedClasses['diagnostics-row']} */ ;
/** @type {__VLS_StyleScopedClasses['diag-level']} */ ;
/** @type {__VLS_StyleScopedClasses['diag-level']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
/** @type {__VLS_StyleScopedClasses['diagnostics-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['diagnostics-toggle']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "diagnostics-wrap" },
});
/** @type {__VLS_StyleScopedClasses['diagnostics-wrap']} */ ;
let __VLS_0;
/** @ts-ignore @type { | typeof __VLS_components.Transition | typeof __VLS_components.Transition} */
Transition;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    name: "slide",
}));
const __VLS_2 = __VLS_1({
    name: "slide",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
if (__VLS_ctx.isOpen) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "diagnostics-panel glass-panel custom-scroll" },
    });
    /** @type {__VLS_StyleScopedClasses['diagnostics-panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['glass-panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['custom-scroll']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "diagnostics-header" },
    });
    /** @type {__VLS_StyleScopedClasses['diagnostics-header']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "diagnostics-title" },
    });
    /** @type {__VLS_StyleScopedClasses['diagnostics-title']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "diagnostics-actions" },
    });
    /** @type {__VLS_StyleScopedClasses['diagnostics-actions']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.clear) },
        ...{ class: "icon-action" },
        disabled: (!__VLS_ctx.status.logEntries.length),
    });
    /** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.close) },
        ...{ class: "icon-action" },
    });
    /** @type {__VLS_StyleScopedClasses['icon-action']} */ ;
    if (!__VLS_ctx.status.logEntries.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "diagnostics-empty" },
        });
        /** @type {__VLS_StyleScopedClasses['diagnostics-empty']} */ ;
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "diagnostics-list" },
        });
        /** @type {__VLS_StyleScopedClasses['diagnostics-list']} */ ;
        for (const [entry] of __VLS_vFor((__VLS_ctx.status.logEntries.slice().reverse()))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                key: (entry.timestamp + entry.scope + entry.message),
                ...{ class: "diagnostics-row" },
                ...{ class: (`level-${entry.level}`) },
            });
            /** @type {__VLS_StyleScopedClasses['diagnostics-row']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "diag-time" },
            });
            /** @type {__VLS_StyleScopedClasses['diag-time']} */ ;
            (__VLS_ctx.formatTime(entry.timestamp));
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "diag-level" },
            });
            /** @type {__VLS_StyleScopedClasses['diag-level']} */ ;
            (entry.level.toUpperCase());
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "diag-scope" },
            });
            /** @type {__VLS_StyleScopedClasses['diag-scope']} */ ;
            (entry.scope);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "diag-message" },
            });
            /** @type {__VLS_StyleScopedClasses['diag-message']} */ ;
            (entry.message);
            // @ts-ignore
            [isOpen, clear, status, status, status, close, formatTime,];
        }
    }
}
// @ts-ignore
[];
var __VLS_3;
if (!__VLS_ctx.$slots.default) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.toggle) },
        ...{ class: "diagnostics-toggle" },
        ...{ class: ({ active: __VLS_ctx.isOpen }) },
        title: "Toggle client diagnostics",
    });
    /** @type {__VLS_StyleScopedClasses['diagnostics-toggle']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
}
// @ts-ignore
[isOpen, $slots, toggle,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
