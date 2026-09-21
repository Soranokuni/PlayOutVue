import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { THEMES } from '../../config/themes';

/**
 * UI/UX plan Appendix B — the theme-safety guard.
 *
 * A colour written as a literal inside a component is invisible to the theme
 * system: it looks right in whichever theme the author had open and wrong in
 * the other two. That is how "CUT TO LIVE" ended up as white text on a pale
 * pink pill (F-02) and how Settings and the DeckLink wizard became dark islands
 * inside the light theme (F-06).
 *
 * The rule is: component styles use tokens. The allowlist below records the
 * files that have not been migrated yet, with today's exact count. It may only
 * ever go down — a file not listed must have zero, and a listed file may not
 * exceed its budget. Delete each entry as its phase lands.
 */

const SRC = join(process.cwd(), 'src');

/** Remaining literals per file. Lower these; never raise them. */
const ALLOWLIST: Record<string, number> = {
  // (SettingsModal's nine swatch literals are gone: §5.2 moved the swatch
  // colours into `config/themes.ts`, where they are data about a theme rather
  // than a style of the dialog, and bound through `:style`.)
  // The `.mock-screen-crop` subtree simulates the on-air raster: its black
  // background and white type are content and must not follow the theme.
  'components/ComplianceModule.vue': 22,
  // Video letterbox and vignette on the TrimPanel scrubber surface.
  'components/TrimPanel.vue': 2,
  // (MediaLibrary's ten folder swatches are operator data in <script>, not
  // styles, so they fall outside this guard's surface by construction.)
};

/** Tokens every theme block must define, so a theme can never be half-built. */
const REQUIRED_TOKENS = [
  '--text-on-accent',
  '--text-on-danger',
  '--text-on-warning',
  '--text-on-success',
  '--status-ready',
  '--status-processing',
  '--status-warning',
  '--status-error',
  '--status-offline',
  '--status-onair',
  '--status-armed',
  '--status-cued',
  '--status-unsaved',
  '--rating-k',
  '--rating-k-fg',
  '--rating-8',
  '--rating-8-fg',
  '--rating-12',
  '--rating-12-fg',
  '--rating-16',
  '--rating-16-fg',
  '--rating-18',
  '--rating-18-fg',
  '--rating-tp',
  '--rating-tp-fg',
  '--type-movie',
  '--type-show',
  '--type-documentary',
  '--type-news',
  '--tag-spot',
  '--tag-telemarketing',
  '--shadow-1',
  '--shadow-2',
  '--shadow-3',
  '--backdrop',
  '--backdrop-strong',
  '--focus-ring',
  // §5.1 / §5.3: the action colour and the row surface are per theme, because
  // Ember's primary is amber and Graphite and Paper step their rows away from
  // the panel. A theme that defines neither is half-built.
  '--accent-primary',
  '--surface-row',
];

/**
 * §3.5: the glow vocabulary and the top-edge highlight. These are derived
 * entirely from other tokens, so they are written once in the theme-independent
 * block rather than repeated in every theme — but they must exist, or a
 * component reaches for a hand-rolled box-shadow again.
 */
const GLOBAL_TOKENS = ['--shadow-highlight', '--glow-onair', '--glow-armed', '--glow-accent'];

/**
 * Every theme block in `main.css`, derived from the one registry (§5.2) so a
 * theme cannot be added to the app and forgotten here. The default theme is
 * written as `:root, .dark-theme`, which is also how `main.css` opens it.
 */
const THEME_SELECTORS = THEMES.map((theme) =>
  theme.className === 'dark-theme' ? ':root,\n.dark-theme' : `.${theme.className}`
);

/**
 * Collects every top-level rule opened by `selector` and returns their bodies
 * joined. A theme's tokens are deliberately split across more than one block
 * (the palette near the top of main.css, the semantic layer below it), so
 * reading only the first would report tokens as missing that are defined.
 */
function themeBlocks(css: string, selector: string): string {
  const normalised = css.replace(/\r\n/g, '\n');
  const bodies: string[] = [];
  let from = 0;

  for (;;) {
    const start = normalised.indexOf('\n' + selector + ' {', from);
    if (start === -1) break;
    const open = normalised.indexOf('{', start);
    const close = normalised.indexOf('\n}', open);
    if (close === -1) break;
    bodies.push(normalised.slice(open, close));
    from = close;
  }

  return bodies.join('\n');
}

/* §7.3: hsl(), oklch() and hwb() spell the same literal a different way; the
   guard cannot be bypassed by changing colour space. */
const LITERAL = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|lch|lab|hwb)\(/gi;

function vueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...vueFiles(full));
    } else if (entry.endsWith('.vue')) {
      out.push(full);
    }
  }
  return out;
}

/** The parts of an SFC a literal colour can hide in: styles and style attrs. */
function colourSurfaces(source: string): string {
  const styleBlocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const styleAttrs = [...source.matchAll(/:?style="([^"]*)"/g)].map((m) => m[1]);
  return [...styleBlocks, ...styleAttrs].join('\n');
}

function countLiterals(source: string): number {
  return (colourSurfaces(source).match(LITERAL) ?? []).length;
}

describe('Appendix B · theme-safety guard', () => {
  const files = vueFiles(SRC);

  it('finds the components to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('allows no colour literals outside the shrinking allowlist', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const key = relative(SRC, file).split(sep).join('/');
      const count = countLiterals(readFileSync(file, 'utf8'));
      const budget = ALLOWLIST[key] ?? 0;

      if (count > budget) {
        offenders.push(
          `${key}: ${count} colour literal(s), budget ${budget}. ` +
            'Use a token from main.css §3.1, or raise this only with a reason.'
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist honest — a budget may not sit above the real count', () => {
    const stale: string[] = [];

    for (const [key, budget] of Object.entries(ALLOWLIST)) {
      const count = countLiterals(readFileSync(join(SRC, key), 'utf8'));
      if (count < budget) {
        stale.push(`${key}: budget ${budget} but only ${count} left — lower it to ${count}.`);
      }
    }

    expect(stale).toEqual([]);
  });

  it('defines every semantic token in every theme block', () => {
    const css = readFileSync(join(SRC, 'assets/main.css'), 'utf8');
    const missing: string[] = [];

    for (const selector of THEME_SELECTORS) {
      const block = themeBlocks(css, selector);
      expect(block, `theme block ${selector} not found`).not.toBe('');

      for (const token of REQUIRED_TOKENS) {
        if (!block.includes(`${token}:`)) {
          missing.push(`${selector} is missing ${token}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('defines the glow vocabulary once, for every theme to derive from', () => {
    const css = readFileSync(join(SRC, 'assets/main.css'), 'utf8');
    for (const token of GLOBAL_TOKENS) {
      expect(css, `main.css is missing ${token}`).toContain(`${token}:`);
    }
  });

  it('defines the layer scale, so no component invents a z-index again', () => {
    const css = readFileSync(join(SRC, 'assets/main.css'), 'utf8');
    for (const token of [
      '--z-panel',
      '--z-sticky',
      '--z-popover',
      '--z-drawer',
      '--z-modal',
      '--z-modal-nested',
      '--z-context-menu',
      '--z-palette',
      '--z-toast',
      '--z-banner',
    ]) {
      expect(css, `main.css is missing ${token}`).toContain(`${token}:`);
    }
  });

  it('carries no reference to the two removed themes', () => {
    const css = readFileSync(join(SRC, 'assets/main.css'), 'utf8');
    expect(css).not.toContain('soft-slate');
    expect(css).not.toContain('periwinkle');
  });
});
