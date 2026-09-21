import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * §7.2 — the one button family.
 *
 * The app had 40+ button class families (`glass-btn`, `icon-action`,
 * `ctrl-btn`, `t-btn`, `pl-btn`, `action-btn`, `toolbar-btn`, `mini-btn`,
 * `row-btn`, `crawl-btn`, `trim-btn`, …), each with its own padding, radius,
 * hover treatment and disabled opacity, and most without a focus ring or a
 * press state at all. Rounds 1–3 migrated most of them; this round finished
 * the list §7.2 names.
 *
 * The rule is: a `<button>` in the app draws from `.btn`, either by carrying
 * the class or by being a `BaseButton`. There are two honest exceptions,
 * checked for explicitly rather than allowlisted:
 *
 * - `.popover-item` / `.menu-item` rows. A menu row is a list item that
 *   happens to be clickable; it is a different thing from a button and it has
 *   its own shared rule set in `components.css`.
 * - Buttons that are the interactive surface of something else — a tab, a
 *   breadcrumb, a tree row, a close affordance drawn into a chip. They are
 *   styled by the thing they belong to.
 *
 * Both exceptions are counted per file with a budget that may only go down,
 * the same shrinking-allowlist rule the colour and type-scale guards use.
 */

const SRC = join(process.cwd(), 'src');

/**
 * Raw `<button>` elements that draw neither on `.btn` nor on a shared row
 * rule. Lower these; never raise them.
 *
 * `App.vue` is at zero: every button in the shell chrome is `.btn` now.
 */
const ALLOWLIST: Record<string, number> = {
  // Tab strips, command-palette rows, preset chips and dismiss affordances:
  // each is the interactive surface of something else, styled by that thing.
  'components/RundownList.vue': 2,
  'components/ComplianceModule.vue': 1,
  'components/CommandPaletteModal.vue': 1,
  'components/DeckLinkWizard.vue': 1,
  // `BaseButton` is the family; its own `<button>` binds `:class`.
  'components/ui/BaseButton.vue': 1,
};

/**
 * Families retired outright — no rule and no call site left anywhere.
 *
 * `glass-btn` and `mini-btn` are deliberately not here: they still have call
 * sites in the dialogs, which §7.2 does not cover. They belong in this list
 * the day those are migrated.
 */
const RETIRED = ['icon-action', 'panel-toggle-btn'];

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

function template(source: string): string {
  const match = /<template>([\s\S]*)<\/template>/.exec(source);
  return match?.[1] ?? '';
}

/** Opening `<button …>` tags, attributes and all, newlines included. */
function buttonTags(source: string): string[] {
  return [...template(source).matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
}

const drawsOnFamily = (tag: string) =>
  /\bclass="[^"]*\bbtn\b/.test(tag) || /\bclass="[^"]*\b(popover-item|menu-item)\b/.test(tag);

describe('§7.2 · one button family', () => {
  const files = vueFiles(SRC);

  it('finds the components to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('allows no raw button outside the shrinking allowlist', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const key = relative(SRC, file).split(sep).join('/');
      const raw = buttonTags(readFileSync(file, 'utf8')).filter((t) => !drawsOnFamily(t));
      const budget = ALLOWLIST[key] ?? 0;

      if (raw.length > budget) {
        offenders.push(
          `${key}: ${raw.length} button(s) outside the family, budget ${budget}. ` +
            'Use BaseButton, or add `btn` to the class list.'
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist honest — no entry may be larger than it needs', () => {
    const slack: string[] = [];

    for (const [key, budget] of Object.entries(ALLOWLIST)) {
      const raw = buttonTags(readFileSync(join(SRC, key), 'utf8')).filter((t) => !drawsOnFamily(t));
      if (raw.length < budget) {
        slack.push(`${key}: budget ${budget} but only ${raw.length} left — lower it to ${raw.length}.`);
      }
    }

    expect(slack).toEqual([]);
  });

  it('keeps the shell chrome at zero', () => {
    // App.vue owns the control bar. §7.2's whole point is that the bar's
    // buttons are the same button as everything else.
    const raw = buttonTags(readFileSync(join(SRC, 'App.vue'), 'utf8')).filter((t) => !drawsOnFamily(t));
    expect(raw).toEqual([]);
  });

  it('does not let a retired family come back', () => {
    const returned: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const family of RETIRED) {
        // A comment naming one is fine; a selector or a class list is not.
        if (new RegExp(`class="[^"]*\\b${family}\\b|^\\s*\\.${family}\\b`, 'm').test(source)) {
          returned.push(`${relative(SRC, file).split(sep).join('/')}: ${family}`);
        }
      }
    }

    expect(returned).toEqual([]);
  });

  it('pins the press state and the focus ring to the family, not to call sites', () => {
    const css = readFileSync(join(SRC, 'assets', 'components.css'), 'utf8');
    expect(css, 'the one press').toMatch(/\.btn:active:not\(:disabled\)\s*\{[^}]*transform:/);
    expect(css, 'the one focus ring').toMatch(/\.btn:focus-visible\s*\{[^}]*--focus-ring/);
    expect(css, 'the one disabled treatment').toMatch(/\.btn:disabled[^{]*\{[^}]*opacity/);
  });

  it('leaves the control bar free to size its own buttons, and only that', () => {
    // §4's ladder rewrites the bar's padding per rung, so `.ctrl-btn` has to
    // override the family's metrics. It must not override anything else --
    // that is how the old duplicate rule set grew in the first place.
    const app = readFileSync(join(SRC, 'App.vue'), 'utf8');
    const rule = /^\.ctrl-btn \{([^}]*)\}/m.exec(app);
    expect(rule, '.ctrl-btn rule not found').not.toBeNull();

    const declared = (rule?.[1] ?? '')
      .split(';')
      .map((d) => d.split(':')[0]?.trim())
      .filter(Boolean)
      .sort();

    expect(declared).toEqual(['gap', 'height', 'line-height', 'padding']);
  });
});
