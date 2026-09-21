/**
 * Final polish §5.2 — the one theme registry.
 *
 * The theme list used to be enumerated in five places: the settings enum, two
 * copy-pasted body-class swaps (App.vue and SettingsModal.vue), the Appearance
 * cards, the swatch CSS, plus the two guard tests' own arrays. Adding a theme
 * meant finding all of them, and the swatch colours had to be literals in a
 * component style block because a swatch must show its own theme's palette
 * while a different theme is active.
 *
 * Everything about a theme that is not a CSS token lives here: its id (what the
 * store persists), its body class (what `main.css` styles), how Appearance
 * describes it, and the three colours its swatch paints. That last one is the
 * reason the swatches are *data* rather than style — bound through `:style`,
 * they leave `SettingsModal.vue` with zero colour literals.
 */

export interface ThemeDefinition {
  /** Persisted in settings; never rename without a REMOVED_THEME_ALIASES entry. */
  readonly id: string;
  /** The class `main.css` styles and `lib/theme.ts` puts on `<body>`. */
  readonly className: string;
  /** Card heading in Settings › Appearance. */
  readonly title: string;
  readonly scheme: 'dark' | 'light';
  readonly badge?: string;
  /** One line: what the theme is *for*, in operational terms. */
  readonly description: string;
  /** Panel / row / accent, as painted by the Appearance preview swatch. */
  readonly swatch: { readonly panel: string; readonly row: string; readonly accent: string };
}

export const THEMES = [
  {
    id: 'dark',
    className: 'dark-theme',
    title: 'Broadcast Midnight',
    scheme: 'dark',
    badge: 'Default',
    description: 'Deep slate, low glare — for dim control rooms.',
    swatch: { panel: '#0f172a', row: '#334155', accent: '#38bdf8' },
  },
  {
    id: 'graphite',
    className: 'graphite-theme',
    title: 'Graphite',
    scheme: 'dark',
    description: 'Neutral charcoal with no colour cast — for rooms where the picture monitors are the reference.',
    swatch: { panel: '#16171a', row: '#2a2b30', accent: '#7cc4fa' },
  },
  {
    id: 'monokai',
    className: 'monokai-theme',
    title: 'Engineering Dark',
    scheme: 'dark',
    description: 'Higher contrast charcoal with saturated accents.',
    swatch: { panel: '#22231e', row: '#3e4036', accent: '#a6e22e' },
  },
  {
    id: 'ember',
    className: 'ember-theme',
    title: 'Ember',
    scheme: 'dark',
    description: 'Warm near-black with an amber primary — for overnight shifts.',
    swatch: { panel: '#171412', row: '#2d2724', accent: '#f5b53f' },
  },
  {
    id: 'light',
    className: 'light-theme',
    title: 'Studio Light',
    scheme: 'light',
    description: 'Daylight surfaces for well-lit rooms.',
    swatch: { panel: '#ffffff', row: '#e2e8f0', accent: '#0369a1' },
  },
  {
    id: 'paper',
    className: 'paper-theme',
    title: 'Paper',
    scheme: 'light',
    description: 'Warm off-white with ink text — for newsrooms and print-adjacent work.',
    swatch: { panel: '#fffdf9', row: '#e8e2d6', accent: '#4338ca' },
  },
] as const satisfies readonly ThemeDefinition[];

export type ThemeId = (typeof THEMES)[number]['id'];

export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id);

export const THEME_CLASSES: readonly string[] = THEMES.map((theme) => theme.className);

/** The id every fallback lands on: the one marked Default above. */
export const DEFAULT_THEME_ID: ThemeId = 'dark';

export function themeClassFor(id: string): string {
  return THEMES.find((theme) => theme.id === id)?.className ?? 'dark-theme';
}
