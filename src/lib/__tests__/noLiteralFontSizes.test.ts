import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Round 3 §7.6 — the type-scale guard.
 *
 * Sibling to `noLiteralColors.test.ts`, and for the same reason. The app had
 * 25 distinct font sizes between 0.6rem and 1.75rem scattered through its
 * component styles: not a scale, but 25 independent decisions, each made
 * against whatever happened to be next to it. Two consequences.
 *
 * First, illegibility: `--fs-xs` (0.7rem) is the documented floor for
 * user-facing text and several literals sat under it. Second, the density
 * setting stopped working — `--font-size-base` scales with `--ui-scale`, but a
 * hard-coded `0.76rem` does not, so "Large" moved the rows apart and left the
 * type in them exactly as small as it was.
 *
 * The rule is: component styles use `--fs-*`. The allowlist records the files
 * that have not been migrated yet, with today's exact count. It may only ever
 * go down — a file not listed must have zero, and a listed file may not exceed
 * its budget.
 */

const SRC = join(process.cwd(), 'src');

/**
 * Remaining literals per file. Lower these; never raise them.
 *
 * Round 3 cleared the four files §7.6 names — `App.vue`, `RundownList.vue`,
 * `RundownRow.vue` and `ContextMenu.vue` — plus the library's toolbar and the
 * rundown header. What is left is the dialogs, which later phases migrate.
 */
const ALLOWLIST: Record<string, number> = {
  // One `0.95em` inside a nested rule; relative, so it does follow the scale.
  'components/SettingsModal.vue': 1,
};

const LITERAL = /font-size:\s*[0-9.]+(?:rem|px|em)\b/gi;

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

/** The parts of an SFC a font size can hide in: styles and style attrs. */
function typeSurfaces(source: string): string {
  const styleBlocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const styleAttrs = [...source.matchAll(/:?style="([^"]*)"/g)].map((m) => m[1]);
  return [...styleBlocks, ...styleAttrs].join('\n');
}

function countLiterals(source: string): number {
  return (typeSurfaces(source).match(LITERAL) ?? []).length;
}

describe('Round 3 §7.6 · type-scale guard', () => {
  const files = vueFiles(SRC);

  it('finds the components to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('allows no font-size literals outside the shrinking allowlist', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const key = relative(SRC, file).split(sep).join('/');
      const count = countLiterals(readFileSync(file, 'utf8'));
      const budget = ALLOWLIST[key] ?? 0;

      if (count > budget) {
        offenders.push(
          `${key}: ${count} font-size literal(s), budget ${budget}. ` +
            'Use an --fs-* token from main.css, or raise this only with a reason.'
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist honest — no entry may be larger than it needs', () => {
    const slack: string[] = [];

    for (const [key, budget] of Object.entries(ALLOWLIST)) {
      const count = countLiterals(readFileSync(join(SRC, key), 'utf8'));
      if (count < budget) {
        slack.push(`${key}: budget ${budget} but only ${count} left — lower it to ${count}.`);
      }
    }

    expect(slack).toEqual([]);
  });

  it('defines the whole scale, so there is always a token to reach for', () => {
    const css = readFileSync(join(SRC, 'assets', 'main.css'), 'utf8');
    for (const token of ['--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--fs-tc', '--fs-tc-hero']) {
      expect(css, `${token} is not defined`).toContain(`${token}:`);
    }
  });

  it('keeps the four files §7.6 names at zero', () => {
    for (const key of [
      'App.vue',
      'components/RundownList.vue',
      'components/RundownRow.vue',
      'components/ContextMenu.vue',
      'components/MenuRow.vue',
    ]) {
      expect(countLiterals(readFileSync(join(SRC, key), 'utf8')), key).toBe(0);
    }
  });
});
