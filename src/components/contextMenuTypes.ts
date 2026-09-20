import type { IconName } from './ui/icons';

/**
 * The context menu's public vocabulary.
 *
 * These live outside `ContextMenu.vue` so `MenuRow.vue` — which renders one
 * row for both the main list and the teleported submenu flyout — can import
 * them without a circular import back through the component that owns it.
 * `ContextMenu.vue` re-exports every name, so the dozen call sites that
 * already do `import type { MenuItem } from './ContextMenu.vue'` keep working.
 */

/**
 * A tone is not decoration: it maps a row to the colour that same concept
 * already carries elsewhere in the app — an 18 row is the same red as the 18
 * badge on the rundown, a SPOT row the same orange as the SPOT chip — so the
 * menu teaches the palette instead of fighting it.
 *
 * Each tone resolves to `--menu-tone` (and `--menu-tone-fg` where a filled
 * chip needs a foreground) in `MenuRow.vue`'s stylesheet. Tones are token
 * names, so a theme change carries the menu with it.
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
   * Round 3 §6.1: the key that does the same thing, rendered as a `Kbd` in the
   * trailing group. Set it wherever the action maps to a registered command so
   * the menu teaches the keyboard instead of hiding it.
   */
  shortcut?: string;
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

/**
 * A row with no tone of its own still gets one: `danger` is a colour decision
 * the caller already made by setting the flag, and neutral is the floor.
 */
export const itemTone = (item: MenuItem): MenuTone => item.tone ?? (item.danger ? 'danger' : 'neutral');
