import { ref, onMounted, onUnmounted } from 'vue';
const props = defineProps();
const emit = defineEmits();
const menuRef = ref(null);
const computedX = ref(props.x);
const computedY = ref(props.y);
const isPositioned = ref(false);
const activeSubmenu = ref(null);
const currentHoveredParentId = ref(null);
let closeTimeout = null;
onMounted(() => {
    // Give Vue a moment to render and get actual dimensions
    setTimeout(() => {
        if (menuRef.value) {
            const rect = menuRef.value.getBoundingClientRect();
            const menuWidth = rect.width || 220;
            const menuHeight = rect.height || 300;
            // Boundary calculations
            let newX = props.x;
            if (props.x + menuWidth > window.innerWidth) {
                newX = Math.max(10, window.innerWidth - menuWidth - 10);
            }
            let newY = props.y;
            if (props.y + menuHeight > window.innerHeight) {
                // Flip upwards as requested
                newY = Math.max(10, props.y - menuHeight);
            }
            computedX.value = newX;
            computedY.value = newY;
            isPositioned.value = true;
        }
        else {
            isPositioned.value = true;
        }
    }, 16); // ~1 frame delay
});
onUnmounted(() => {
    if (closeTimeout) {
        clearTimeout(closeTimeout);
    }
});
// Open submenu with hover bridge and viewport boundary check
const openSubmenu = (event, item, index) => {
    if (closeTimeout) {
        clearTimeout(closeTimeout);
        closeTimeout = null;
    }
    if (!item.children || item.children.length === 0 || item.disabled) {
        // Hovering a non-submenu item: trigger close of any open submenu after a small delay
        currentHoveredParentId.value = null;
        closeTimeout = setTimeout(() => {
            activeSubmenu.value = null;
        }, 120);
        return;
    }
    const parentId = item.id || `sub-${index}`;
    currentHoveredParentId.value = parentId;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const submenuWidth = 190;
    // Calculate left coordinate (flip to open left if it overflows right screen boundary)
    let left = rect.right;
    if (rect.right + submenuWidth > window.innerWidth) {
        left = Math.max(10, rect.left - submenuWidth);
    }
    // Calculate top coordinate (clamp if it overflows bottom boundary)
    let top = rect.top;
    const estimatedSubmenuHeight = item.children.length * 32 + 8; // approx
    if (rect.top + estimatedSubmenuHeight > window.innerHeight) {
        top = Math.max(10, window.innerHeight - estimatedSubmenuHeight - 10);
    }
    activeSubmenu.value = {
        id: parentId,
        top,
        left,
        children: item.children
    };
};
const onMouseLeaveItem = () => {
    // Start hover bridge close timeout
    closeTimeout = setTimeout(() => {
        activeSubmenu.value = null;
        currentHoveredParentId.value = null;
    }, 220);
};
const onMouseEnterSubmenu = () => {
    if (closeTimeout) {
        clearTimeout(closeTimeout);
        closeTimeout = null;
    }
};
const onMouseLeaveSubmenu = () => {
    closeTimeout = setTimeout(() => {
        activeSubmenu.value = null;
        currentHoveredParentId.value = null;
    }, 220);
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
/** @type {__VLS_StyleScopedClasses['custom-scrollbar']} */ ;
/** @type {__VLS_StyleScopedClasses['custom-scrollbar']} */ ;
/** @type {__VLS_StyleScopedClasses['custom-scrollbar']} */ ;
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['action-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['action-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-item']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-item']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['menu-item']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onClick: () => { } },
    ref: "menuRef",
    ...{ class: "win11-context-menu" },
    ...{ style: ({
            top: __VLS_ctx.computedY + 'px',
            left: __VLS_ctx.computedX + 'px',
            opacity: __VLS_ctx.isPositioned ? 1 : 0,
            pointerEvents: __VLS_ctx.isPositioned ? 'auto' : 'none'
        }) },
});
/** @type {__VLS_StyleScopedClasses['win11-context-menu']} */ ;
if (__VLS_ctx.topActions && __VLS_ctx.topActions.length > 0) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "top-action-bar" },
    });
    /** @type {__VLS_StyleScopedClasses['top-action-bar']} */ ;
    for (const [btn] of __VLS_vFor((__VLS_ctx.topActions))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.topActions && __VLS_ctx.topActions.length > 0))
                        throw 0;
                    return (!btn.disabled && (btn.action(), __VLS_ctx.emit('close')));
                    // @ts-ignore
                    [computedY, computedX, isPositioned, isPositioned, topActions, topActions, topActions, emit,];
                } },
            key: (btn.id),
            ...{ class: "action-btn" },
            ...{ class: ({ disabled: btn.disabled }) },
            'data-tooltip': (btn.tooltip),
            disabled: (btn.disabled),
        });
        /** @type {__VLS_StyleScopedClasses['action-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['disabled']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "action-icon" },
        });
        /** @type {__VLS_StyleScopedClasses['action-icon']} */ ;
        if (btn.id === 'trim') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                'stroke-width': "2",
                'stroke-linecap': "round",
                'stroke-linejoin': "round",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.circle, __VLS_intrinsics.circle)({
                cx: "6",
                cy: "6",
                r: "3",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.circle, __VLS_intrinsics.circle)({
                cx: "6",
                cy: "18",
                r: "3",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.line, __VLS_intrinsics.line)({
                x1: "20",
                y1: "4",
                x2: "8.12",
                y2: "15.88",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.line, __VLS_intrinsics.line)({
                x1: "14.47",
                y1: "14.48",
                x2: "20",
                y2: "20",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.line, __VLS_intrinsics.line)({
                x1: "8.12",
                y1: "8.12",
                x2: "12",
                y2: "12",
            });
        }
        else if (btn.id === 'rename') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                'stroke-width': "2",
                'stroke-linecap': "round",
                'stroke-linejoin': "round",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path, __VLS_intrinsics.path)({
                d: "M12 20h9",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path, __VLS_intrinsics.path)({
                d: "M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z",
            });
        }
        else if (btn.id === 'purge') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                ...{ class: "icon-danger" },
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                'stroke-width': "2",
                'stroke-linecap': "round",
                'stroke-linejoin': "round",
            });
            /** @type {__VLS_StyleScopedClasses['icon-danger']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M10 11v6M14 11v6",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path)({
                d: "M12 8.5v4",
                stroke: "#ff4d4d",
                'stroke-width': "2.5",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.circle)({
                cx: "12",
                cy: "16",
                r: "0.75",
                fill: "#ff4d4d",
                stroke: "none",
            });
        }
        else if (btn.id === 'delete') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                'stroke-width': "2",
                'stroke-linecap': "round",
                'stroke-linejoin': "round",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.polyline, __VLS_intrinsics.polyline)({
                points: "3 6 5 6 21 6",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.path, __VLS_intrinsics.path)({
                d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
            });
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
            (btn.id);
        }
        // @ts-ignore
        [];
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "menu-items-list custom-scrollbar" },
});
/** @type {__VLS_StyleScopedClasses['menu-items-list']} */ ;
/** @type {__VLS_StyleScopedClasses['custom-scrollbar']} */ ;
for (const [item, idx] of __VLS_vFor((__VLS_ctx.items))) {
    __VLS_asFunctionalElement(__VLS_intrinsics.template)({
        key: (idx),
    });
    if (item.type === 'divider') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div)({
            ...{ onMouseenter: (...[$event]) => {
                    if (!(item.type === 'divider'))
                        throw 0;
                    return (__VLS_ctx.openSubmenu($event, { type: 'divider' }, idx));
                    // @ts-ignore
                    [items, openSubmenu,];
                } },
            ...{ onMouseleave: (__VLS_ctx.onMouseLeaveItem) },
            ...{ class: "menu-divider" },
        });
        /** @type {__VLS_StyleScopedClasses['menu-divider']} */ ;
    }
    else if (item.type === 'label') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onMouseenter: (...[$event]) => {
                    if (!!(item.type === 'divider'))
                        throw 0;
                    if (!(item.type === 'label'))
                        throw 0;
                    return (__VLS_ctx.openSubmenu($event, { type: 'label' }, idx));
                    // @ts-ignore
                    [openSubmenu, onMouseLeaveItem,];
                } },
            ...{ onMouseleave: (__VLS_ctx.onMouseLeaveItem) },
            ...{ class: "menu-label" },
        });
        /** @type {__VLS_StyleScopedClasses['menu-label']} */ ;
        (item.label);
    }
    else if (item.type === 'action' || item.type === 'toggle') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onMouseenter: (...[$event]) => {
                    if (!!(item.type === 'divider'))
                        throw 0;
                    if (!!(item.type === 'label'))
                        throw 0;
                    if (!(item.type === 'action' || item.type === 'toggle'))
                        throw 0;
                    return (__VLS_ctx.openSubmenu($event, item, idx));
                    // @ts-ignore
                    [openSubmenu, onMouseLeaveItem,];
                } },
            ...{ onMouseleave: (__VLS_ctx.onMouseLeaveItem) },
            ...{ onClick: (...[$event]) => {
                    if (!!(item.type === 'divider'))
                        throw 0;
                    if (!!(item.type === 'label'))
                        throw 0;
                    if (!(item.type === 'action' || item.type === 'toggle'))
                        throw 0;
                    return (!item.disabled && item.action && (item.action(), __VLS_ctx.emit('close')));
                    // @ts-ignore
                    [emit, onMouseLeaveItem,];
                } },
            ...{ class: "menu-item" },
            ...{ class: ({ danger: item.danger, disabled: item.disabled }) },
        });
        /** @type {__VLS_StyleScopedClasses['menu-item']} */ ;
        /** @type {__VLS_StyleScopedClasses['danger']} */ ;
        /** @type {__VLS_StyleScopedClasses['disabled']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "menu-item-check-spacer" },
        });
        /** @type {__VLS_StyleScopedClasses['menu-item-check-spacer']} */ ;
        if (item.checked) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "check-mark" },
            });
            /** @type {__VLS_StyleScopedClasses['check-mark']} */ ;
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "menu-item-label" },
        });
        /** @type {__VLS_StyleScopedClasses['menu-item-label']} */ ;
        (item.label);
    }
    else if (item.type === 'submenu') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onMouseenter: (...[$event]) => {
                    if (!!(item.type === 'divider'))
                        throw 0;
                    if (!!(item.type === 'label'))
                        throw 0;
                    if (!!(item.type === 'action' || item.type === 'toggle'))
                        throw 0;
                    if (!(item.type === 'submenu'))
                        throw 0;
                    return (__VLS_ctx.openSubmenu($event, item, idx));
                    // @ts-ignore
                    [openSubmenu,];
                } },
            ...{ onMouseleave: (__VLS_ctx.onMouseLeaveItem) },
            ...{ onClick: (...[$event]) => {
                    if (!!(item.type === 'divider'))
                        throw 0;
                    if (!!(item.type === 'label'))
                        throw 0;
                    if (!!(item.type === 'action' || item.type === 'toggle'))
                        throw 0;
                    if (!(item.type === 'submenu'))
                        throw 0;
                    return (__VLS_ctx.openSubmenu($event, item, idx));
                    // @ts-ignore
                    [openSubmenu, onMouseLeaveItem,];
                } },
            ...{ class: "menu-item has-submenu" },
            ...{ class: ({
                    disabled: item.disabled,
                    'submenu-active': __VLS_ctx.currentHoveredParentId === (item.id || `sub-${idx}`)
                }) },
        });
        /** @type {__VLS_StyleScopedClasses['menu-item']} */ ;
        /** @type {__VLS_StyleScopedClasses['has-submenu']} */ ;
        /** @type {__VLS_StyleScopedClasses['disabled']} */ ;
        /** @type {__VLS_StyleScopedClasses['submenu-active']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "menu-item-check-spacer" },
        });
        /** @type {__VLS_StyleScopedClasses['menu-item-check-spacer']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "menu-item-label" },
        });
        /** @type {__VLS_StyleScopedClasses['menu-item-label']} */ ;
        (item.label);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "submenu-chevron" },
        });
        /** @type {__VLS_StyleScopedClasses['submenu-chevron']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.svg, __VLS_intrinsics.svg)({
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            'stroke-width': "2.5",
            'stroke-linecap': "round",
            'stroke-linejoin': "round",
        });
        __VLS_asFunctionalElement1(__VLS_intrinsics.polyline, __VLS_intrinsics.polyline)({
            points: "9 18 15 12 9 6",
        });
    }
    // @ts-ignore
    [currentHoveredParentId,];
}
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
if (__VLS_ctx.activeSubmenu) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onMouseenter: (__VLS_ctx.onMouseEnterSubmenu) },
        ...{ onMouseleave: (__VLS_ctx.onMouseLeaveSubmenu) },
        ...{ onClick: () => { } },
        ...{ class: "win11-context-menu submenu-flyout custom-scrollbar" },
        ...{ style: ({
                top: __VLS_ctx.activeSubmenu.top + 'px',
                left: __VLS_ctx.activeSubmenu.left + 'px',
                position: 'fixed'
            }) },
    });
    /** @type {__VLS_StyleScopedClasses['win11-context-menu']} */ ;
    /** @type {__VLS_StyleScopedClasses['submenu-flyout']} */ ;
    /** @type {__VLS_StyleScopedClasses['custom-scrollbar']} */ ;
    for (const [child, cIdx] of __VLS_vFor((__VLS_ctx.activeSubmenu.children))) {
        __VLS_asFunctionalElement(__VLS_intrinsics.template)({
            key: (cIdx),
        });
        if (child.type === 'divider') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div)({
                ...{ class: "menu-divider" },
            });
            /** @type {__VLS_StyleScopedClasses['menu-divider']} */ ;
        }
        else if (child.type === 'label') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "menu-label" },
            });
            /** @type {__VLS_StyleScopedClasses['menu-label']} */ ;
            (child.label);
        }
        else {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.activeSubmenu))
                            throw 0;
                        if (!!(child.type === 'divider'))
                            throw 0;
                        if (!!(child.type === 'label'))
                            throw 0;
                        return (!child.disabled && child.action && (child.action(), __VLS_ctx.emit('close'), __VLS_ctx.activeSubmenu = null));
                        // @ts-ignore
                        [emit, activeSubmenu, activeSubmenu, activeSubmenu, activeSubmenu, activeSubmenu, onMouseEnterSubmenu, onMouseLeaveSubmenu,];
                    } },
                ...{ class: "menu-item" },
                ...{ class: ({ danger: child.danger, disabled: child.disabled }) },
            });
            /** @type {__VLS_StyleScopedClasses['menu-item']} */ ;
            /** @type {__VLS_StyleScopedClasses['danger']} */ ;
            /** @type {__VLS_StyleScopedClasses['disabled']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "menu-item-check-spacer" },
            });
            /** @type {__VLS_StyleScopedClasses['menu-item-check-spacer']} */ ;
            if (child.checked) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "check-mark" },
                });
                /** @type {__VLS_StyleScopedClasses['check-mark']} */ ;
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "menu-item-label" },
            });
            /** @type {__VLS_StyleScopedClasses['menu-item-label']} */ ;
            (child.label);
        }
        // @ts-ignore
        [];
    }
}
// @ts-ignore
[];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
