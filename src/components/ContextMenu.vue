<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { claimContextMenu, releaseContextMenu } from '../lib/activeContextMenu';
import AppIcon from './ui/AppIcon.vue';
import type { IconName } from './ui/icons';

/**
 * The menu's colour vocabulary.
 *
 * Every entry used to be the same grey, so a 14-row menu mixing "inspect this",
 * "give this an 18 rating" and "delete this permanently" read as one
 * undifferentiated list and the operator had to parse each label to find out
 * which kind of thing a row was. A tone is not decoration: it maps a row to the
 * colour that same concept already carries elsewhere in the app -- an 18 row is
 * the same red as the 18 badge on the rundown, a SPOT row the same orange as
 * the SPOT chip -- so the menu teaches the palette instead of fighting it.
 *
 * Each tone resolves to `--menu-tone` (and `--menu-tone-fg` where a filled chip
 * needs a foreground) in this component's stylesheet. Tones are token names, so
 * a theme change carries the menu with it.
 */
export type MenuTone =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'cued'
  | 'rating-k'
  | 'rating-8'
  | 'rating-12'
  | 'rating-16'
  | 'rating-18'
  | 'rating-tp'
  | 'type-movie'
  | 'type-show'
  | 'type-documentary'
  | 'type-news'
  | 'tag-spot'
  | 'tag-telemarketing';

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
  /** Colour family for the icon, the hover tint and any badge on this row. */
  tone?: MenuTone;
  /**
   * A filled mini-chip rendered at the end of the row in the row's tone --
   * used where the row *is* the thing the chip shows on air ("12", "TP",
   * "SPOT"), so the menu shows the mark rather than describing it.
   */
  badge?: string;
  /**
   * A raw colour for rows whose colour is operator data rather than a theme
   * token (the folder colour palette). Rendered as a swatch, never as a tone.
   */
  swatch?: string;
  action?: () => void;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children?: MenuItem[];
}

export interface TopAction {
  id: 'trim' | 'rename' | 'purge' | 'delete' | string;
  icon?: IconName;
  tone?: MenuTone;
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

/**
 * A row with no tone of its own still gets one: `danger` is a colour decision
 * the caller already made by setting the flag, and neutral is the floor.
 */
const itemTone = (item: MenuItem): MenuTone => item.tone ?? (item.danger ? 'danger' : 'neutral');

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
        <div
          v-else-if="item.type === 'action' || item.type === 'toggle'"
          class="menu-item"
          :class="{ danger: item.danger, disabled: item.disabled, 'is-checked': item.checked }"
          :data-tone="itemTone(item)"
          @mouseenter="openSubmenu($event, item, idx)"
          @mouseleave="onMouseLeaveItem($event)"
          @click.stop="!item.disabled && item.action && (item.action(), emit('close'))"
        >
          <span class="menu-item-check-spacer">
            <AppIcon v-if="item.checked" class="check-mark" name="check" :size="14" :stroke-width="3" />
          </span>
          <span v-if="item.swatch" class="menu-item-swatch" :style="{ background: item.swatch }" aria-hidden="true" />
          <AppIcon v-else-if="item.icon" class="menu-item-icon" :name="item.icon" :size="14" />
          <span class="menu-item-label">{{ item.label }}</span>
          <span v-if="item.badge" class="menu-item-badge">{{ item.badge }}</span>
        </div>

        <!-- Submenu parent item -->
        <div
          v-else-if="item.type === 'submenu'"
          class="menu-item has-submenu"
          :class="{ 
            disabled: item.disabled,
            'submenu-active': currentHoveredParentId === (item.id || `sub-${idx}`)
          }"
          :data-tone="itemTone(item)"
          @mouseenter="openSubmenu($event, item, idx)"
          @mousemove="onItemMouseMove($event, item, idx)"
          @mouseleave="onMouseLeaveItem($event)"
          @click.stop="openSubmenu($event, item, idx)"
        >
          <span class="menu-item-check-spacer"></span>
          <span v-if="item.swatch" class="menu-item-swatch" :style="{ background: item.swatch }" aria-hidden="true" />
          <AppIcon v-else-if="item.icon" class="menu-item-icon" :name="item.icon" :size="14" />
          <span class="menu-item-label">{{ item.label }}</span>
          <span v-if="item.badge" class="menu-item-badge">{{ item.badge }}</span>
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
          <div
            v-else
            class="menu-item"
            :class="{ danger: child.danger, disabled: child.disabled, 'is-checked': child.checked }"
            :data-tone="itemTone(child)"
            @click.stop="!child.disabled && child.action && (child.action(), emit('close'), activeSubmenu = null)"
          >
            <span class="menu-item-check-spacer">
              <AppIcon v-if="child.checked" class="check-mark" name="check" :size="14" :stroke-width="3" />
            </span>
            <span v-if="child.swatch" class="menu-item-swatch" :style="{ background: child.swatch }" aria-hidden="true" />
            <AppIcon v-else-if="child.icon" class="menu-item-icon" :name="child.icon" :size="14" />
            <span class="menu-item-label">{{ child.label }}</span>
            <span v-if="child.badge" class="menu-item-badge">{{ child.badge }}</span>
          </div>
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
  min-width: 220px;
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

/* ---------------------------------------------------------------------------
   Tone map.

   `--menu-tone` is the row's colour; `--menu-tone-fg` is the type that sits on
   it when the row carries a filled badge. Both are theme tokens, so the menu
   follows a theme switch without a second palette to maintain.
   --------------------------------------------------------------------------- */
.menu-item,
.action-btn {
  --menu-tone: var(--text-secondary);
  --menu-tone-fg: var(--text-on-accent);
}
.menu-item[data-tone='accent'],
.action-btn[data-tone='accent'] { --menu-tone: var(--accent-blue); --menu-tone-fg: var(--text-on-accent); }
.menu-item[data-tone='success'] { --menu-tone: var(--status-ready); --menu-tone-fg: var(--text-on-success); }
.menu-item[data-tone='warning'] { --menu-tone: var(--status-warning); --menu-tone-fg: var(--text-on-warning); }
.menu-item[data-tone='danger'],
.action-btn[data-tone='danger'] { --menu-tone: var(--status-error); --menu-tone-fg: var(--text-on-danger); }
.menu-item[data-tone='cued'] { --menu-tone: var(--status-cued); --menu-tone-fg: var(--text-on-accent); }

/* The regulatory family. These are the same five colours the rating badge
   shows on the rundown row and on air, so a "12" row in this menu and a "12"
   badge on the clip are self-evidently the same statement. */
.menu-item[data-tone='rating-k'] { --menu-tone: var(--rating-k); --menu-tone-fg: var(--rating-k-fg); }
.menu-item[data-tone='rating-8'] { --menu-tone: var(--rating-8); --menu-tone-fg: var(--rating-8-fg); }
.menu-item[data-tone='rating-12'] { --menu-tone: var(--rating-12); --menu-tone-fg: var(--rating-12-fg); }
.menu-item[data-tone='rating-16'] { --menu-tone: var(--rating-16); --menu-tone-fg: var(--rating-16-fg); }
.menu-item[data-tone='rating-18'] { --menu-tone: var(--rating-18); --menu-tone-fg: var(--rating-18-fg); }
.menu-item[data-tone='rating-tp'] { --menu-tone: var(--rating-tp); --menu-tone-fg: var(--rating-tp-fg); }

.menu-item[data-tone='type-movie'] { --menu-tone: var(--type-movie); --menu-tone-fg: var(--text-on-danger); }
.menu-item[data-tone='type-show'] { --menu-tone: var(--type-show); --menu-tone-fg: var(--text-on-accent); }
.menu-item[data-tone='type-documentary'] { --menu-tone: var(--type-documentary); --menu-tone-fg: var(--text-on-danger); }
.menu-item[data-tone='type-news'] { --menu-tone: var(--type-news); --menu-tone-fg: var(--text-on-success); }

.menu-item[data-tone='tag-spot'] { --menu-tone: var(--tag-spot); --menu-tone-fg: var(--text-on-warning); }
.menu-item[data-tone='tag-telemarketing'] { --menu-tone: var(--tag-telemarketing); --menu-tone-fg: var(--text-on-danger); }

/* Hover is the tone at low alpha plus a 2 px leading bar in the tone at full
   strength: the tint alone is too weak to identify a colour at 12 %, and the
   bar alone leaves the row looking unhovered. */
.menu-item:hover:not(.disabled) {
  background: color-mix(in srgb, var(--menu-tone) 14%, var(--bg-hover));
  color: var(--text-primary);
}

.menu-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  border-radius: var(--radius-pill);
  background: var(--menu-tone);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.menu-item:hover:not(.disabled)::before,
.menu-item.is-checked::before {
  opacity: 1;
}

/* A checked row keeps its tone at rest -- "this clip is 16" should be legible
   without hovering it. */
.menu-item.is-checked {
  background: color-mix(in srgb, var(--menu-tone) 10%, transparent);
}

.menu-item.danger:hover:not(.disabled) {
  color: var(--status-error);
}

/* The badge is the mark itself, drawn the way it is drawn on air. */
.menu-item-badge {
  flex-shrink: 0;
  margin-left: var(--space-2);
  min-width: 22px;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--menu-tone);
  color: var(--menu-tone-fg);
  font-size: var(--fs-xs);
  font-weight: 800;
  line-height: 1.35;
  text-align: center;
  letter-spacing: 0.03em;
}

/* Folder colours are operator data, not a theme tone, so they get a plain
   swatch in the row's icon slot rather than a tone. */
.menu-item-swatch {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  margin-right: var(--space-1);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-medium);
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
  background: color-mix(in srgb, var(--menu-tone) 14%, var(--bg-hover));
  color: var(--text-primary);
}
.submenu-active::before {
  opacity: 1;
}
/* UI F-10: the optional leading glyph on a menu row. It carries the tone at
   rest, which is what makes a long menu scannable by colour before it is read
   by label. */
.menu-item-icon {
  color: var(--menu-tone);
  margin-right: var(--space-1);
  flex-shrink: 0;
}

.menu-item[data-tone='neutral'] .menu-item-icon {
  color: var(--text-secondary);
}

.menu-item[data-tone='neutral']:hover:not(.disabled) .menu-item-icon {
  color: var(--text-primary);
}

/* Top-bar icons take their tone too, so "move to bin" is not the same grey as
   "rename" in a bar where every control is icon-only. */
.action-btn[data-tone='danger'] .action-icon {
  color: var(--status-error);
}
.action-btn[data-tone='accent'] .action-icon {
  color: var(--accent-blue);
}
.action-btn[data-tone='danger']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--status-error) 16%, transparent);
}
</style>
