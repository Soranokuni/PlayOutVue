import { ref } from 'vue';
import { useRundownStore } from '../stores/rundown';
const store = useRundownStore();
const emit = defineEmits(['close']);
const name = ref('');
const hours = ref(0);
const minutes = ref(0);
const seconds = ref(0);
const totalSeconds = () => hours.value * 3600 + minutes.value * 60 + seconds.value;
const confirm = () => {
    if (!name.value.trim())
        return;
    store.addLiveItem(name.value.trim(), totalSeconds());
    emit('close');
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
/** @type {__VLS_StyleScopedClasses['form-group']} */ ;
/** @type {__VLS_StyleScopedClasses['dur-field']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
/** @type {__VLS_StyleScopedClasses['trim-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "modal-backdrop" },
});
/** @type {__VLS_StyleScopedClasses['modal-backdrop']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "glass-panel live-dialog" },
});
/** @type {__VLS_StyleScopedClasses['glass-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['live-dialog']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "dialog-header" },
});
/** @type {__VLS_StyleScopedClasses['dialog-header']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "text-accent" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['text-accent']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.$emit('close'));
            // @ts-ignore
            [$emit,];
        } },
    ...{ class: "icon-btn" },
});
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "form-group" },
});
/** @type {__VLS_StyleScopedClasses['form-group']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
    ...{ class: "text-secondary" },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
    ...{ onKeyup: (__VLS_ctx.confirm) },
    ...{ class: "glass-input" },
    placeholder: "e.g. Live Studio Camera 1",
    autofocus: true,
});
(__VLS_ctx.name);
/** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "form-group" },
});
/** @type {__VLS_StyleScopedClasses['form-group']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
    ...{ class: "text-secondary" },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "duration-row" },
});
/** @type {__VLS_StyleScopedClasses['duration-row']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "dur-field" },
});
/** @type {__VLS_StyleScopedClasses['dur-field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
    type: "number",
    ...{ class: "glass-input" },
    min: "0",
    max: "23",
});
(__VLS_ctx.hours);
/** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "text-secondary" },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "dur-field" },
});
/** @type {__VLS_StyleScopedClasses['dur-field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
    type: "number",
    ...{ class: "glass-input" },
    min: "0",
    max: "59",
});
(__VLS_ctx.minutes);
/** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "text-secondary" },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "dur-field" },
});
/** @type {__VLS_StyleScopedClasses['dur-field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
    type: "number",
    ...{ class: "glass-input" },
    min: "0",
    max: "59",
});
(__VLS_ctx.seconds);
/** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "text-secondary" },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "dialog-footer" },
});
/** @type {__VLS_StyleScopedClasses['dialog-footer']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.$emit('close'));
            // @ts-ignore
            [$emit, confirm, name, hours, minutes, seconds,];
        } },
    ...{ class: "trim-btn" },
});
/** @type {__VLS_StyleScopedClasses['trim-btn']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.confirm) },
    ...{ class: "trim-btn btn-primary" },
    disabled: (!__VLS_ctx.name.trim()),
});
/** @type {__VLS_StyleScopedClasses['trim-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
// @ts-ignore
[confirm, name,];
const __VLS_export = (await import('vue')).defineComponent({
    emits: {},
});
export default {};
