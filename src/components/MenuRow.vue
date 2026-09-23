<script setup lang="ts">
import AppIcon from './ui/AppIcon.vue';
import Kbd from './ui/Kbd.vue';
import type { MenuItem, MenuTone } from './contextMenuTypes';

/**
 * One row of a context menu (round 3 §6).
 *
 * The row used to be a flex line that began with a 16 px check *spacer*, then
 * the icon, then 4 px, then the label. On an unchecked row — which is almost
 * every row — that put a coloured glyph adrift in the middle of a 24 px dead
 * zone with its label pressed against it. The owner's words: "the icons are
 * too close to the text … more to the left".
 *
 * The row is now a grid with a dedicated 16 px **icon rail** in column one, so
 * glyphs line up down the menu whether or not a given row has one, and a fixed
 * 12 px gutter before the label. The check mark moved to the trailing group:
 * a checked row already carries the tone bar and a 10 % tint, so the check is
 * a confirmation rather than the only signal, and it no longer competes with
 * the icon for the rail.
 *
 * Both the main list and the teleported submenu flyout render through this
 * component so the two cannot drift apart again — which is exactly how the
 * old duplicated markup grew two different paddings.
 */
defineProps<{
  item: MenuItem;
  /** Rows in the flyout get no submenu affordance of their own. */
  submenuActive?: boolean;
  tone: MenuTone;
}>();
</script>

<template>
  <div
    class="menu-item"
    :class="{
      danger: item.danger,
      disabled: item.disabled,
      'is-checked': item.checked,
      'has-submenu': item.type === 'submenu',
      'submenu-active': submenuActive,
    }"
    :data-tone="tone"
  >
    <span class="menu-item-rail" aria-hidden="true">
      <span v-if="item.swatch" class="menu-item-swatch" :style="{ background: item.swatch }" />
      <AppIcon v-else-if="item.icon" class="menu-item-icon" :name="item.icon" />
    </span>

    <span class="menu-item-label">{{ item.label }}</span>

    <span
      v-if="item.badge || item.shortcut || item.checked || item.type === 'submenu'"
      class="menu-item-trailing"
    >
      <span v-if="item.badge" class="menu-item-badge">{{ item.badge }}</span>
      <Kbd v-if="item.shortcut" class="menu-item-shortcut">{{ item.shortcut }}</Kbd>
      <AppIcon
        v-if="item.checked"
        class="menu-item-check"
        name="check"
        :size="14"
        :stroke-width="3"
      />
      <AppIcon
        v-if="item.type === 'submenu'"
        class="submenu-chevron"
        name="chevron-right"
        :size="14"
        :stroke-width="2.5"
      />
    </span>
  </div>
</template>

<style scoped>
/* ---------------------------------------------------------------------------
   Row anatomy (§6.1)

     10px | [16px icon rail] | 12px | Label ……… | badge · ⌘K · ✓ · › | 10px

   The rail is always present, so a menu mixing rows with and without icons
   still reads as one column of labels.
   --------------------------------------------------------------------------- */
.menu-item {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  column-gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  margin: var(--space-0) var(--space-1);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  position: relative;
  box-sizing: border-box;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

/* Tone map. `--menu-tone` is the row's colour; `--menu-tone-fg` is the type
   that sits on it when the row carries a filled badge. Both are theme tokens,
   so the menu follows a theme switch without a second palette to maintain. */
.menu-item {
  --menu-tone: var(--text-secondary);
  --menu-tone-fg: var(--text-on-accent);
}
.menu-item[data-tone='accent'] { --menu-tone: var(--accent-blue); --menu-tone-fg: var(--text-on-accent); }
.menu-item[data-tone='success'] { --menu-tone: var(--status-ready); --menu-tone-fg: var(--text-on-success); }
.menu-item[data-tone='warning'] { --menu-tone: var(--status-warning); --menu-tone-fg: var(--text-on-warning); }
.menu-item[data-tone='danger'] { --menu-tone: var(--status-error); --menu-tone-fg: var(--text-on-danger); }
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
.menu-item[data-tone='type-kids'] { --menu-tone: var(--type-kids); --menu-tone-fg: var(--text-on-warning); }
.menu-item[data-tone='type-spot'] { --menu-tone: var(--type-spot); --menu-tone-fg: var(--text-on-warning); }
.menu-item[data-tone='type-promo'] { --menu-tone: var(--type-promo); --menu-tone-fg: var(--text-on-success); }
.menu-item[data-tone='type-jingle'] { --menu-tone: var(--type-jingle); --menu-tone-fg: var(--text-on-danger); }
.menu-item[data-tone='type-telemarketing'] { --menu-tone: var(--type-telemarketing); --menu-tone-fg: var(--text-on-success); }

/* Hover is the tone at low alpha plus a 2 px leading bar in the tone at full
   strength: the tint alone is too weak to identify a colour at 12 %, and the
   bar alone leaves the row looking unhovered. */
.menu-item:hover:not(.disabled) {
  background: color-mix(in srgb, var(--menu-tone) 14%, var(--bg-hover));
  color: var(--text-primary);
}

/* §6.1: the bar sits inside the 10 px padding rather than on the popover's own
   border, where the border swallowed it. */
.menu-item::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  border-radius: var(--radius-pill);
  background: var(--menu-tone);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.menu-item:hover:not(.disabled)::before,
.menu-item.is-checked::before,
.menu-item.submenu-active::before {
  opacity: 1;
}

/* A checked row keeps its tone at rest — "this clip is 16" should be legible
   without hovering it. */
.menu-item.is-checked {
  background: color-mix(in srgb, var(--menu-tone) 10%, transparent);
}

.menu-item.submenu-active {
  background: color-mix(in srgb, var(--menu-tone) 14%, var(--bg-hover));
  color: var(--text-primary);
}

.menu-item.danger:hover:not(.disabled) {
  color: var(--status-error);
}

.menu-item.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.menu-item-rail {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}

/* The optional leading glyph carries the tone at rest, which is what makes a
   long menu scannable by colour before it is read by label. */
.menu-item-icon {
  color: var(--menu-tone);
  flex-shrink: 0;
}

.menu-item[data-tone='neutral'] .menu-item-icon {
  color: var(--text-secondary);
}

.menu-item[data-tone='neutral']:hover:not(.disabled) .menu-item-icon {
  color: var(--text-primary);
}

/* Folder colours are operator data, not a theme tone, so they get a plain
   swatch in the rail rather than a tone. */
.menu-item-swatch {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-medium);
}

.menu-item-label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu-item-trailing {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

/* The badge is the mark itself, drawn the way it is drawn on air. */
.menu-item-badge {
  min-width: 22px;
  padding: var(--space-0) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--menu-tone);
  color: var(--menu-tone-fg);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-tight);
  text-align: center;
  letter-spacing: var(--tracking-caps);
}

/* §6.1: the menu teaches the keyboard. Populated from the command registry
   wherever a menu action maps to a bound command. */
.menu-item-shortcut {
  font-size: var(--fs-xs);
  opacity: 0.85;
}

.menu-item-check {
  color: var(--menu-tone);
  flex-shrink: 0;
}

.menu-item[data-tone='neutral'] .menu-item-check {
  color: var(--accent-blue);
}

.submenu-chevron {
  color: var(--text-muted);
  flex-shrink: 0;
}
</style>
