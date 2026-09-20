<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { claimContextMenu, releaseContextMenu } from '../lib/activeContextMenu';
import AppIcon from './ui/AppIcon.vue';
import type { IconName } from './ui/icons';

export interface MenuItem {
  type: 'action' | 'divider' | 'submenu' | 'label' | 'toggle';
  id?: string;
  label?: string;
  /**
   * UI F-10: menu labels used to embed an emoji ("🔍 Inspect Clip"). The glyph
   * belongs in its own slot so it can be themed, sized and aligned, and so the
   * label stays a plain translatable string.
   */
  icon?: IconName;
  action?: () => void;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children?: MenuItem[];
}

export interface TopAction {
  id: 'trim' | 'rename' | 'purge' | 'delete' | string;
  icon?: IconName;
  tooltip: string;
  action: () => void;
  disabled?: boolean;
}

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
    class="win11-context-menu"
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
        :data-tooltip="btn.tooltip"
        :disabled="btn.disabled"
        @click.stop="!btn.disabled && (btn.action(), emit('close'))"
      >
        <span class="action-icon" :class="{ 'icon-danger': btn.id === 'purge' }">
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
        <div
          v-else-if="item.type === 'action' || item.type === 'toggle'"
          class="menu-item"
          :class="{ danger: item.danger, disabled: item.disabled }"
          @mouseenter="openSubmenu($event, item, idx)"
          @mouseleave="onMouseLeaveItem($event)"
          @click.stop="!item.disabled && item.action && (item.action(), emit('close'))"
        >
          <span class="menu-item-check-spacer">
            <AppIcon v-if="item.checked" class="check-mark" name="check" :size="14" :stroke-width="3" />
          </span>
          <AppIcon v-if="item.icon" class="menu-item-icon" :name="item.icon" :size="14" />
          <span class="menu-item-label">{{ item.label }}</span>
        </div>

        <!-- Submenu parent item -->
        <div
          v-else-if="item.type === 'submenu'"
          class="menu-item has-submenu"
          :class="{ 
            disabled: item.disabled,
            'submenu-active': currentHoveredParentId === (item.id || `sub-${idx}`)
          }"
          @mouseenter="openSubmenu($event, item, idx)"
          @mousemove="onItemMouseMove($event, item, idx)"
          @mouseleave="onMouseLeaveItem($event)"
          @click.stop="openSubmenu($event, item, idx)"
        >
          <span class="menu-item-check-spacer"></span>
          <AppIcon v-if="item.icon" class="menu-item-icon" :name="item.icon" :size="14" />
          <span class="menu-item-label">{{ item.label }}</span>
          <span class="submenu-chevron">
            <AppIcon name="chevron-right" :size="14" :stroke-width="2.5" />
          </span>
        </div>
      </template>
    </div>

    <!-- Teleported Submenu Flyout -->
    <Teleport to="body">
      <div
        v-if="activeSubmenu"
        ref="submenuRef"
        class="win11-context-menu submenu-flyout custom-scrollbar"
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
          <div
            v-else
            class="menu-item"
            :class="{ danger: child.danger, disabled: child.disabled }"
            @click.stop="!child.disabled && child.action && (child.action(), emit('close'), activeSubmenu = null)"
          >
            <span class="menu-item-check-spacer">
              <AppIcon v-if="child.checked" class="check-mark" name="check" :size="14" :stroke-width="3" />
            </span>
            <AppIcon v-if="child.icon" class="menu-item-icon" :name="child.icon" :size="14" />
            <span class="menu-item-label">{{ child.label }}</span>
          </div>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* Main Context Menu Styling */
.win11-context-menu {
  position: fixed;
  z-index: var(--z-context-menu);
  min-width: 220px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-medium);
  border-radius: 0.6rem;
  box-shadow: var(--shadow-3);
  font-family: var(--font-ui);
  color: var(--text-primary);
  padding: 5px 0;
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
  padding: 4px;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 4px;
}

.action-btn {
  position: relative;
  flex: 1;
  height: 32px;
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
  background: var(--bg-hover);
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

.action-icon svg.icon-danger {
  color: var(--accent-red);
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
  padding: 6px 12px 3px;
  font-size: var(--fs-xs);
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.menu-item {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  font-size: 0.84rem;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
  margin: 1px 4px;
  border-radius: 4px;
  position: relative;
  transition: background 0.1s ease, color 0.1s ease;
  box-sizing: border-box;
}

.menu-item:hover:not(.disabled) {
  background: color-mix(in srgb, var(--accent-blue) 12%, var(--bg-hover));
  color: var(--text-primary);
}

.menu-item.danger:hover:not(.disabled) {
  background: color-mix(in srgb, var(--accent-red) 16%, transparent);
  color: var(--accent-red);
}

.menu-item.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.menu-item-check-spacer {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  margin-right: 8px;
  font-size: 0.84rem;
}

.check-mark {
  color: var(--accent-blue);
  font-weight: bold;
}

.menu-item-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.submenu-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  opacity: 0.7;
  margin-left: 8px;
  color: var(--text-secondary);
}

.menu-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 0;
}

/* Teleported Submenu Flyout specific settings */
.submenu-flyout {
  min-width: 220px;
  max-height: 50vh;
  overflow-y: auto;
  z-index: calc(var(--z-context-menu) + 5);
  background: var(--bg-secondary);
  border: 1px solid var(--border-medium);
  border-radius: 0.6rem;
  box-shadow: var(--shadow-2);
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

.submenu-active {
  background: color-mix(in srgb, var(--accent-blue) 12%, var(--bg-hover));
  color: var(--text-primary);
}
/* UI F-10: the optional leading glyph on a menu row. */
.menu-item-icon {
  color: var(--text-secondary);
  margin-right: var(--space-1);
}

.menu-item:hover:not(.disabled) .menu-item-icon {
  color: var(--text-primary);
}

.menu-item.danger .menu-item-icon {
  color: var(--status-error);
}
</style>
