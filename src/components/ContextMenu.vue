<script lang="ts">
/**
 * The menu's public vocabulary lives in `contextMenuTypes.ts` so `MenuRow.vue`
 * can import it without a circular import back through this component. It is
 * re-exported here because a dozen call sites already import `MenuItem` and
 * `TopAction` from this file.
 */
export type { MenuTone, MenuItem, TopAction } from './contextMenuTypes';
</script>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { claimContextMenu, releaseContextMenu } from '../lib/activeContextMenu';
import AppIcon from './ui/AppIcon.vue';
import MenuRow from './MenuRow.vue';
import { itemTone } from './contextMenuTypes';
import type { MenuItem, MenuTone, TopAction } from './contextMenuTypes';
import type { IconName } from './ui/icons';

const props = defineProps<{
  x: number;
  y: number;
  topActions?: TopAction[];
  items: MenuItem[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const menuRef = ref<HTMLElement | null>(null);
const submenuRef = ref<HTMLElement | null>(null);
const computedX = ref(props.x);
const computedY = ref(props.y);
const isPositioned = ref(false);

// Submenu reactive state
interface ActiveSubmenuState {
  id: string | number;
  top: number;
  left: number;
  children: MenuItem[];
}

const activeSubmenu = ref<ActiveSubmenuState | null>(null);
const currentHoveredParentId = ref<string | number | null>(null);
let closeTimeout: ReturnType<typeof setTimeout> | null = null;

// UI F-05: the menu owns its own dismissal. Previously each parent closed it on
// a window `click`, which never fired for a right-click in another panel, and
// nothing at all handled Escape.
const requestClose = () => emit('close');


/** The top bar's four stock actions carry the tone their verb implies. */
const defaultTopActionTone = (btn: TopAction): MenuTone =>
  (({ trim: 'accent', rename: 'accent', purge: 'danger', delete: 'danger' } as Record<string, MenuTone>)[btn.id] ??
    'neutral');

/** Falls back to the action id so a new top action still renders something. */
const topActionIcon = (btn: TopAction): IconName =>
  btn.icon ??
  (({ trim: 'scissors', rename: 'rename', purge: 'trash', delete: 'trash' } as Record<string, IconName>)[btn.id] ??
    'file');

const onDocumentKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return;
  // Take the event before the global operator router sees it, so Escape closes
  // the menu rather than clearing the rundown selection underneath it.
  event.preventDefault();
  event.stopPropagation();
  requestClose();
};

const isInsideMenu = (target: EventTarget | null) => {
  const node = target as Node | null;
  if (!node) return false;
  return !!menuRef.value?.contains(node) || !!submenuRef.value?.contains(node);
};

const onPointerDownOutside = (event: PointerEvent | MouseEvent) => {
  if (isInsideMenu(event.target)) return;
  requestClose();
};

// A right-click elsewhere must close this menu before the new one opens; the
// singleton covers menus, this covers a right-click on inert background.
const onContextMenuOutside = (event: MouseEvent) => {
  if (isInsideMenu(event.target)) return;
  requestClose();
};

onMounted(() => {
  claimContextMenu(requestClose);
  window.addEventListener('keydown', onDocumentKeyDown, true);
  window.addEventListener('pointerdown', onPointerDownOutside, true);
  window.addEventListener('contextmenu', onContextMenuOutside, true);
  window.addEventListener('blur', requestClose);
  window.addEventListener('resize', requestClose);

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
    } else {
      isPositioned.value = true;
    }
  }, 16); // ~1 frame delay
});

onUnmounted(() => {
  if (closeTimeout) {
    clearTimeout(closeTimeout);
  }
  releaseContextMenu(requestClose);
  window.removeEventListener('keydown', onDocumentKeyDown, true);
  window.removeEventListener('pointerdown', onPointerDownOutside, true);
  window.removeEventListener('contextmenu', onContextMenuOutside, true);
  window.removeEventListener('blur', requestClose);
  window.removeEventListener('resize', requestClose);
});

// Open submenu with hover bridge and viewport boundary check
const openSubmenu = (event: MouseEvent, item: MenuItem, index: number) => {
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

  // If this submenu is already active, keep it open and cancel closing
  if (activeSubmenu.value && activeSubmenu.value.id === parentId) {
    return;
  }

  const target = event.currentTarget as HTMLElement;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const submenuWidth = 220;
  
  // Calculate left coordinate (flip to open left if it overflows right screen boundary)
  let left = rect.right - 2;
  if (rect.right + submenuWidth > window.innerWidth) {
    left = Math.max(10, rect.left - submenuWidth + 2);
  }
  
  // Calculate top coordinate (clamp if it overflows bottom boundary)
  let top = rect.top;
  const estimatedSubmenuHeight = item.children.length * 32 + 10;
  if (rect.top + estimatedSubmenuHeight > window.innerHeight) {
    top = Math.max(10, window.innerHeight - estimatedSubmenuHeight - 10);
  }

  activeSubmenu.value = {
    id: parentId,
    top,
    left,
    children: item.children
  };

  // The estimates above are a first guess made before the flyout exists. They
  // are wrong whenever a label is longer than the assumed 220 px -- the Greek
  // compliance labels are roughly 300 -- and the result was a submenu whose
  // right-hand column (the rating badge) sat outside the window. Measure the
  // rendered flyout and correct it in the same frame it appears.
  void nextTick(() => {
    const flyout = submenuRef.value;
    const current = activeSubmenu.value;
    if (!flyout || !current || current.id !== parentId) return;

    const box = flyout.getBoundingClientRect();
    let correctedLeft = current.left;
    let correctedTop = current.top;

    if (correctedLeft + box.width > window.innerWidth - 8) {
      // Prefer flipping to the parent's left; clamp only if that overflows too.
      correctedLeft = Math.max(8, Math.min(rect.left - box.width + 2, window.innerWidth - box.width - 8));
    }
    if (correctedTop + box.height > window.innerHeight - 8) {
      correctedTop = Math.max(8, window.innerHeight - box.height - 8);
    }

    if (correctedLeft !== current.left || correctedTop !== current.top) {
      activeSubmenu.value = { ...current, left: correctedLeft, top: correctedTop };
    }
  });
};

const onItemMouseMove = (event: MouseEvent, item: MenuItem, index: number) => {
  if (item.type === 'submenu' && item.children && item.children.length > 0 && !item.disabled) {
    const parentId = item.id || `sub-${index}`;
    if (!activeSubmenu.value || activeSubmenu.value.id !== parentId) {
      openSubmenu(event, item, index);
    } else if (closeTimeout) {
      clearTimeout(closeTimeout);
      closeTimeout = null;
    }
  }
};

const onMouseLeaveItem = (event: MouseEvent) => {
  const related = event.relatedTarget as Node | null;
  // If moving directly into the open submenu flyout, don't close!
  if (submenuRef.value && related && submenuRef.value.contains(related)) {
    return;
  }

  // Start hover bridge close timeout
  if (closeTimeout) clearTimeout(closeTimeout);
  closeTimeout = setTimeout(() => {
    activeSubmenu.value = null;
    currentHoveredParentId.value = null;
  }, 240);
};

const onMouseEnterSubmenu = () => {
  if (closeTimeout) {
    clearTimeout(closeTimeout);
    closeTimeout = null;
  }
};

const onMouseLeaveSubmenu = (event: MouseEvent) => {
  const related = event.relatedTarget as Node | null;
  // If moving back into the main context menu, do NOT close prematurely;
  // let the main menu item determine active hover state!
  if (menuRef.value && related && menuRef.value.contains(related)) {
    return;
  }

  if (closeTimeout) clearTimeout(closeTimeout);
  closeTimeout = setTimeout(() => {
    activeSubmenu.value = null;
    currentHoveredParentId.value = null;
  }, 220);
};
</script>

<template>
  <div
    ref="menuRef"
    class="win11-context-menu popover-surface"
    :style="{
      top: computedY + 'px',
      left: computedX + 'px',
      opacity: isPositioned ? 1 : 0,
      pointerEvents: isPositioned ? 'auto' : 'none'
    }"
    @click.stop
  >
    <!-- Windows 11 Top Action Bar -->
    <div v-if="topActions && topActions.length > 0" class="top-action-bar">
      <button
        v-for="btn in topActions"
        :key="btn.id"
        class="action-btn"
        :class="{ disabled: btn.disabled }"
        :data-tone="btn.tone ?? defaultTopActionTone(btn)"
        :data-tooltip="btn.tooltip"
        :aria-label="btn.tooltip"
        :disabled="btn.disabled"
        @click.stop="!btn.disabled && (btn.action(), emit('close'))"
      >
        <span class="action-icon">
          <AppIcon :name="topActionIcon(btn)" :size="16" />
        </span>
      </button>
    </div>

    <!-- Vertical Menu Items -->
    <div class="menu-items-list custom-scrollbar">
      <template v-for="(item, idx) in items" :key="idx">
        <!-- Divider -->
        <div
          v-if="item.type === 'divider'"
          class="menu-divider"
          @mouseenter="openSubmenu($event, { type: 'divider' }, idx)"
          @mouseleave="onMouseLeaveItem($event)"
        />

        <!-- Label -->
        <div
          v-else-if="item.type === 'label'"
          class="menu-label"
          @mouseenter="openSubmenu($event, { type: 'label' }, idx)"
          @mouseleave="onMouseLeaveItem($event)"
        >
          {{ item.label }}
        </div>

        <!-- Action / Toggle item -->
        <MenuRow
          v-else-if="item.type === 'action' || item.type === 'toggle'"
          :item="item"
          :tone="itemTone(item)"
          @mouseenter="openSubmenu($event, item, idx)"
          @mouseleave="onMouseLeaveItem($event)"
          @click.stop="!item.disabled && item.action && (item.action(), emit('close'))"
        />

        <!-- Submenu parent item -->
        <MenuRow
          v-else-if="item.type === 'submenu'"
          :item="item"
          :tone="itemTone(item)"
          :submenu-active="currentHoveredParentId === (item.id || `sub-${idx}`)"
          @mouseenter="openSubmenu($event, item, idx)"
          @mousemove="onItemMouseMove($event, item, idx)"
          @mouseleave="onMouseLeaveItem($event)"
          @click.stop="openSubmenu($event, item, idx)"
        />
      </template>
    </div>

    <!-- Teleported Submenu Flyout -->
    <Teleport to="body">
      <div
        v-if="activeSubmenu"
        ref="submenuRef"
        class="win11-context-menu popover-surface submenu-flyout custom-scrollbar"
        :style="{
          top: activeSubmenu.top + 'px',
          left: activeSubmenu.left + 'px',
          position: 'fixed'
        }"
        @mouseenter="onMouseEnterSubmenu"
        @mouseleave="onMouseLeaveSubmenu($event)"
        @click.stop
      >
        <template v-for="(child, cIdx) in activeSubmenu.children" :key="cIdx">
          <div v-if="child.type === 'divider'" class="menu-divider" />
          <div v-else-if="child.type === 'label'" class="menu-label">{{ child.label }}</div>
          <MenuRow
            v-else
            :item="child"
            :tone="itemTone(child)"
            @click.stop="!child.disabled && child.action && (child.action(), emit('close'), activeSubmenu = null)"
          />
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* Main Context Menu Styling */
/* Surface, border, radius and shadow come from `.popover-surface`
   (components.css) so this menu, the library dropdown and the rundown
   overflow cannot drift apart again. */
.win11-context-menu {
  position: fixed;
  z-index: var(--z-context-menu);
  min-width: 240px;
  max-width: 320px;
  font-family: var(--font-ui);
  padding: var(--space-1) 0;
  transition: opacity 0.15s ease-out;
  user-select: none;
  box-sizing: border-box;
}

/* Scrollbar setup for height overflow */
.menu-items-list {
  max-height: 60vh;
  overflow-y: auto;
  overflow-x: hidden;
}

/* Windows 11 style Custom Scrollbar */
.custom-scrollbar::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: var(--border-medium);
  border-radius: 99px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: var(--border-strong);
}

/* Windows 11 Top Action Bar */
.top-action-bar {
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: 4px;
  padding: 4px;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 4px;
}

.action-btn {
  position: relative;
  flex: 1;
  height: 32px;
  min-width: 32px;
  max-width: 48px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease, color 0.12s ease;
}

.action-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--menu-tone) 14%, var(--bg-hover));
  color: var(--text-primary);
}

.action-btn:active:not(:disabled) {
  background: var(--border-medium);
}

.action-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.action-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}

.action-icon svg {
  width: 100%;
  height: 100%;
}

/* Action button tooltips */
.action-btn::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%) translateY(-6px);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border-medium);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 0.74rem;
  font-weight: 600;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease, transform 0.12s ease;
  box-shadow: var(--shadow-2);
  z-index: calc(var(--z-context-menu) + 10);
}

.action-btn:hover::after {
  opacity: 1;
  transform: translateX(-50%) translateY(-2px);
}

/* Vertical Menu Items list */
.menu-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 10px 3px 38px;
  font-size: var(--fs-xs);
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}

/* The top bar's icon buttons take a tone too, so "move to bin" is not the
   same grey as "rename" in a bar where every control is icon-only. Row tones
   live with the row, in MenuRow.vue. */
.action-btn {
  --menu-tone: var(--text-secondary);
  --menu-tone-fg: var(--text-on-accent);
}
.action-btn[data-tone='accent'] { --menu-tone: var(--accent-blue); }
.action-btn[data-tone='danger'] { --menu-tone: var(--status-error); }

.menu-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 0;
}

/* Teleported Submenu Flyout specific settings */
.submenu-flyout {
  min-width: 240px;
  max-width: 320px;
  max-height: 50vh;
  overflow-y: auto;
  z-index: calc(var(--z-context-menu) + 5);
}

.submenu-flyout::before {
  content: '';
  position: absolute;
  top: -4px;
  bottom: -4px;
  left: -14px;
  width: 16px;
  background: transparent;
  pointer-events: auto;
}

.action-btn[data-tone='danger'] .action-icon,
.action-btn[data-tone='accent'] .action-icon {
  color: var(--menu-tone);
}
</style>
