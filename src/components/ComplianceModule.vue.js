import { computed, ref, watch } from 'vue';
import { activePlayoutCapabilities, getActivePlayoutService } from '../services/playout';
import { useRundownStore } from '../stores/rundown';
import { useSettingsStore } from '../stores/settings';
// Greek Age Rating Definitions (NCRTV Standards)
const ageRatings = [
    { id: 'none', label: 'None (Manual only)', visual: 'No automatic overlay' },
    { id: 'k', label: 'K (All Ages)', visual: 'White rhombus on green' },
    { id: '8', label: '8+ (Children restricted)', visual: 'White circle on blue' },
    { id: '12', label: '12+ (Post 9:30 PM)', visual: 'White triangle on orange' },
    { id: '16', label: '16+ (Post 11:00 PM)', visual: 'Purple square' },
    { id: '18', label: '18+ (Post 1:00 AM)', visual: 'Red Circle 18' }
];
const contentDescriptors = [
    { id: 'violence', label: 'ΒΙΑ (Violence)', text: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ' },
    { id: 'sex', label: 'ΣΕΞ (Sex)', text: 'ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ' },
    { id: 'substances', label: 'ΧΡΗΣΗ ΟΥΣΙΩΝ (Substances)', text: 'ΠΕΡΙΕΧΕΙ ΧΡΗΣΗ ΟΥΣΙΩΝ' },
    { id: 'language', label: 'ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ (Language)', text: 'ΠΕΡΙΕΧΕΙ ΑΚΑΤΑΛΛΗΛΗ ΦΡΑΣΕΟΛΟΓΙΑ' }
];
const store = useRundownStore();
const settings = useSettingsStore();
const item = computed(() => store.selectedItem);
const selectedRating = ref('none');
const selectedDescriptors = ref([]);
const advisoryText = ref('');
const tpFlag = ref(false);
const isOverlayActive = ref(false);
const timelineFields = ref([
    { start: '0:00', end: '0:30', text: '' },
    { start: '1:00', end: '1:30', text: '' }
]);
function parseTimeToMs(t) {
    if (typeof t === 'number')
        return t * 1000;
    const parts = String(t).split(':').map(Number);
    if (parts.length === 2) {
        return ((parts[0] || 0) * 60 + (parts[1] || 0)) * 1000;
    }
    else if (parts.length === 3) {
        return (((parts[0] || 0) * 60 + (parts[1] || 0)) * 60 + (parts[2] || 0)) * 1000;
    }
    const parsed = parseFloat(t);
    return isNaN(parsed) ? 0 : parsed * 1000;
}
function formatMsToTime(ms) {
    const totalSecs = Math.floor(Number(ms) / 1000);
    if (isNaN(totalSecs) || totalSecs <= 0)
        return '0:00';
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}
const syncFromItem = () => {
    selectedRating.value = item.value?.complianceRating || 'none';
    selectedDescriptors.value = [...(item.value?.complianceDescriptors || [])];
    advisoryText.value = item.value?.complianceText || '';
    tpFlag.value = item.value?.tp_flag || false;
    const itemTimeline = item.value?.timeline || [];
    timelineFields.value = [
        {
            start: itemTimeline[0]?.start != null ? formatMsToTime(itemTimeline[0].start) : '0:00',
            end: itemTimeline[0]?.end != null ? formatMsToTime(itemTimeline[0].end) : '0:30',
            text: itemTimeline[0]?.text || ''
        },
        {
            start: itemTimeline[1]?.start != null ? formatMsToTime(itemTimeline[1].start) : '1:00',
            end: itemTimeline[1]?.end != null ? formatMsToTime(itemTimeline[1].end) : '1:30',
            text: itemTimeline[1]?.text || ''
        }
    ];
    isOverlayActive.value = false;
};
watch(() => item.value?.id, syncFromItem, { immediate: true });
const computedDescriptorText = computed(() => {
    const presetText = selectedDescriptors.value
        .map((id) => contentDescriptors.find((descriptor) => descriptor.id === id)?.text)
        .filter(Boolean)
        .join(' • ');
    return [presetText, advisoryText.value.trim()].filter(Boolean).join(' • ');
});
const persistCompliance = () => {
    if (!item.value)
        return;
    // Save locally
    store.updateItem(item.value.id, {
        complianceRating: selectedRating.value,
        complianceDescriptors: selectedRating.value === 'none' ? [] : [...selectedDescriptors.value],
        complianceText: selectedRating.value === 'none' ? '' : advisoryText.value.trim(),
        tp_flag: tpFlag.value
    });
    const parsedTimeline = timelineFields.value
        .filter(field => field.text.trim() !== '')
        .map(field => ({
        start: parseTimeToMs(field.start),
        end: parseTimeToMs(field.end),
        text: field.text.trim()
    }));
    // Update metadata and push to db
    store.updateItemMetadata(item.value.id, item.value.playoutvueId, {
        complianceRating: selectedRating.value,
        tp_flag: tpFlag.value,
        content_type: item.value.content_type || 'none',
        timeline: parsedTimeline
    });
};
watch([selectedRating, selectedDescriptors, advisoryText, tpFlag, timelineFields], persistCompliance, { deep: true });
const applyComplianceOverlay = async () => {
    if (!item.value)
        return;
    persistCompliance();
    if (!activePlayoutCapabilities.value.compliance) {
        isOverlayActive.value = false;
        return;
    }
    if (selectedRating.value === 'none') {
        await clearComplianceOverlay();
        return;
    }
    try {
        await getActivePlayoutService().applyComplianceForItem?.({
            ...item.value,
            complianceRating: selectedRating.value,
            complianceDescriptors: [...selectedDescriptors.value],
            complianceText: computedDescriptorText.value
        });
        isOverlayActive.value = true;
    }
    catch (e) {
        console.error("Failed to push compliance graphics:", e);
    }
};
const clearComplianceOverlay = async () => {
    if (!activePlayoutCapabilities.value.compliance) {
        isOverlayActive.value = false;
        return;
    }
    try {
        await getActivePlayoutService().clearCompliance?.();
        isOverlayActive.value = false;
    }
    catch (e) {
        console.error("Failed to clear compliance graphics:", e);
    }
};
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-danger']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "compliance-module" },
});
/** @type {__VLS_StyleScopedClasses['compliance-module']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
    ...{ class: "text-warning" },
    ...{ style: {} },
});
/** @type {__VLS_StyleScopedClasses['text-warning']} */ ;
if (!__VLS_ctx.settings.logosPath && !__VLS_ctx.settings.cg?.stationIdPath) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "info-banner" },
    });
    /** @type {__VLS_StyleScopedClasses['info-banner']} */ ;
}
if (!__VLS_ctx.activePlayoutCapabilities.compliance) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "info-banner" },
    });
    /** @type {__VLS_StyleScopedClasses['info-banner']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "form-group" },
});
/** @type {__VLS_StyleScopedClasses['form-group']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
    ...{ class: "text-secondary text-sm" },
});
/** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
    value: (__VLS_ctx.selectedRating),
    ...{ class: "glass-input full-width" },
});
/** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
/** @type {__VLS_StyleScopedClasses['full-width']} */ ;
for (const [rating] of __VLS_vFor((__VLS_ctx.ageRatings))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
        key: (rating.id),
        value: (rating.id),
    });
    (rating.label);
    // @ts-ignore
    [settings, settings, activePlayoutCapabilities, selectedRating, ageRatings,];
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "form-group" },
});
/** @type {__VLS_StyleScopedClasses['form-group']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
    ...{ style: {} },
});
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    type: "checkbox",
    ...{ style: {} },
});
(__VLS_ctx.tpFlag);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
if (__VLS_ctx.selectedRating !== 'none' && __VLS_ctx.selectedRating !== 'k' && __VLS_ctx.selectedRating !== '8') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "form-group" },
    });
    /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "text-secondary text-sm" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
    for (const [desc] of __VLS_vFor((__VLS_ctx.contentDescriptors))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (desc.id),
            ...{ class: "checkbox-row" },
        });
        /** @type {__VLS_StyleScopedClasses['checkbox-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            type: "checkbox",
            id: (desc.id),
            value: (desc.id),
        });
        (__VLS_ctx.selectedDescriptors);
        __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
            for: (desc.id),
        });
        (desc.label);
        // @ts-ignore
        [selectedRating, selectedRating, selectedRating, tpFlag, contentDescriptors, selectedDescriptors,];
    }
}
if (__VLS_ctx.selectedRating !== 'none' && __VLS_ctx.selectedRating !== 'k') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "form-group" },
    });
    /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "text-secondary text-sm" },
    });
    /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
        value: (__VLS_ctx.advisoryText),
        ...{ class: "glass-input full-width text-area" },
        rows: "3",
        placeholder: "Π.χ. ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΣΕΞ",
    });
    /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
    /** @type {__VLS_StyleScopedClasses['full-width']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-area']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.small, __VLS_intrinsics.small)({
        ...{ class: "helper-text" },
    });
    /** @type {__VLS_StyleScopedClasses['helper-text']} */ ;
}
if (__VLS_ctx.selectedRating !== 'none' && __VLS_ctx.selectedRating !== 'k') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "preview-row" },
    });
    /** @type {__VLS_StyleScopedClasses['preview-row']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "preview-label" },
    });
    /** @type {__VLS_StyleScopedClasses['preview-label']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "preview-value" },
    });
    /** @type {__VLS_StyleScopedClasses['preview-value']} */ ;
    (__VLS_ctx.computedDescriptorText || 'No advisory text');
}
if (__VLS_ctx.selectedRating !== 'none') {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "form-group" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['form-group']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "text-secondary text-sm" },
        ...{ style: {} },
    });
    /** @type {__VLS_StyleScopedClasses['text-secondary']} */ ;
    /** @type {__VLS_StyleScopedClasses['text-sm']} */ ;
    for (const [field, index] of __VLS_vFor((__VLS_ctx.timelineFields))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (index),
            ...{ class: "timeline-field-row" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['timeline-field-row']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ style: {} },
        });
        (index + 1);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ style: {} },
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            ...{ style: {} },
            value: (field.start),
            placeholder: "0:00",
            title: "Start Time (e.g. 0:00)",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ style: {} },
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input" },
            ...{ style: {} },
            value: (field.end),
            placeholder: "0:30",
            title: "End Time (e.g. 0:30)",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.input, __VLS_intrinsics.input)({
            type: "text",
            ...{ class: "glass-input full-width" },
            ...{ style: {} },
            value: (field.text),
            placeholder: "e.g. ΚΑΤΑΛΛΗΛΟ ΑΝΩ ΤΩΝ 8 ΕΤΩΝ",
            title: "Explanation Text",
        });
        /** @type {__VLS_StyleScopedClasses['glass-input']} */ ;
        /** @type {__VLS_StyleScopedClasses['full-width']} */ ;
        // @ts-ignore
        [selectedRating, selectedRating, selectedRating, selectedRating, selectedRating, advisoryText, computedDescriptorText, timelineFields,];
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "actions" },
});
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
if (!__VLS_ctx.isOverlayActive) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.applyComplianceOverlay) },
        ...{ class: "glass-btn btn-primary full-width" },
    });
    /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    /** @type {__VLS_StyleScopedClasses['full-width']} */ ;
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.clearComplianceOverlay) },
        ...{ class: "glass-btn btn-danger full-width" },
    });
    /** @type {__VLS_StyleScopedClasses['glass-btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-danger']} */ ;
    /** @type {__VLS_StyleScopedClasses['full-width']} */ ;
}
// @ts-ignore
[isOverlayActive, applyComplianceOverlay, clearComplianceOverlay,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
