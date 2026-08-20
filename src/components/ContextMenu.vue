<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';

export interface MenuItem {
  type: 'action' | 'divider' | 'submenu' | 'label' | 'toggle';
  id?: string;
  label?: string;
  action?: () => void;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children?: MenuItem[];
}

export interface TopAction {
  id: 'trim' | 'rename' | 'purge' | 'delete' | string;
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
    } else {
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

  const target = event.currentTarget as HTMLElement;
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
        <span class="action-icon">
          <!-- Trim (Scissors) -->
          <svg v-if="btn.id === 'trim'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="6" cy="6" r="3"></circle>
            <circle cx="6" cy="18" r="3"></circle>
            <line x1="20" y1="4" x2="8.12" y2="15.88"></line>
            <line x1="14.47" y1="14.48" x2="20" y2="20"></line>
            <line x1="8.12" y1="8.12" x2="12" y2="12"></line>
          </svg>
          
          <!-- Rename (Pencil) -->
          <svg v-else-if="btn.id === 'rename'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
          </svg>
          
          <!-- Purge (Trash Can with Warning Exclamation) -->
          <svg v-else-if="btn.id === 'purge'" class="icon-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            <path d="M10 11v6M14 11v6" />
            <path d="M12 8.5v4" stroke="#ff4d4d" stroke-width="2.5" />
            <circle cx="12" cy="16" r="0.75" fill="#ff4d4d" stroke="none" />
          </svg>
          
          <!-- Delete (Trash Can) -->
          <svg v-else-if="btn.id === 'delete'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
          
          <span v-else>{{ btn.id }}</span>
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
          @mouseleave="onMouseLeaveItem"
        />

        <!-- Label -->
        <div
          v-else-if="item.type === 'label'"
          class="menu-label"
          @mouseenter="openSubmenu($event, { type: 'label' }, idx)"
          @mouseleave="onMouseLeaveItem"
        >
          {{ item.label }}
        </div>

        <!-- Action / Toggle item -->
        <div
          v-else-if="item.type === 'action' || item.type === 'toggle'"
          class="menu-item"
          :class="{ danger: item.danger, disabled: item.disabled }"
          @mouseenter="openSubmenu($event, item, idx)"
          @mouseleave="onMouseLeaveItem"
          @click.stop="!item.disabled && item.action && (item.action(), emit('close'))"
        >
          <span class="menu-item-check-spacer">
            <span v-if="item.checked" class="check-mark">✓</span>
          </span>
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
          @mouseleave="onMouseLeaveItem"
          @click.stop="openSubmenu($event, item, idx)"
        >
          <span class="menu-item-check-spacer"></span>
          <span class="menu-item-label">{{ item.label }}</span>
          <span class="submenu-chevron">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </span>
        </div>
      </template>
    </div>

    <!-- Teleported Submenu Flyout -->
    <Teleport to="body">
      <div
        v-if="activeSubmenu"
        class="win11-context-menu submenu-flyout custom-scrollbar"
        :style="{
          top: activeSubmenu.top + 'px',
          left: activeSubmenu.left + 'px',
          position: 'fixed'
        }"
        @mouseenter="onMouseEnterSubmenu"
        @mouseleave="onMouseLeaveSubmenu"
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
              <span v-if="child.checked" class="check-mark">✓</span>
            </span>
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
  z-index: 10000;
  min-width: 220px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-medium);
  border-radius: 0.6rem;
  box-shadow: 
    0 12px 32px rgba(0, 0, 0, 0.45), 
    0 2px 6px rgba(0, 0, 0, 0.2);
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
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  z-index: 10010;
}

.action-btn:hover::after {
  opacity: 1;
  transform: translateX(-50%) translateY(-2px);
}

/* Vertical Menu Items list */
.menu-label {
  padding: 6px 12px 3px;
  font-size: 0.68rem;
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
  z-index: 10005;
  background: var(--bg-secondary);
  border: 1px solid var(--border-medium);
  border-radius: 0.6rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}

.submenu-active {
  background: color-mix(in srgb, var(--accent-blue) 12%, var(--bg-hover));
  color: var(--text-primary);
}
</style>
