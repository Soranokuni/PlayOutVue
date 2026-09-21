import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Shared plumbing for the style guards (final polish §7.3).
 *
 * `noLiteralColors` and `noLiteralFontSizes` each grew their own copy of these
 * three functions. Four more copies would have been four more chances for the
 * guards to disagree about what counts as a style surface — so the walk, the
 * surface extraction and the shrinking-allowlist assertion live here once.
 *
 * This file deliberately has no `.test.ts` suffix: the runner does not pick it
 * up, and the `vueFiles` walk skips `__tests__` entirely, so a guard cannot end
 * up policing itself.
 */

export const SRC = join(process.cwd(), 'src');

/** Every SFC under `src`, excluding tests. */
export function vueFiles(dir: string = SRC): string[] {
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

/** The file's key in an allowlist: a `/`-separated path relative to `src`. */
export function keyOf(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

/**
 * The parts of an SFC a style value can hide in: `<style>` blocks and `style`
 * attributes (bound or not). Comments are stripped, so a rule quoted in a
 * comment to explain why it is gone does not count as still being there.
 */
export function styleSurfaces(source: string): string {
  const blocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
  const attrs = [...source.matchAll(/:?style="([^"]*)"/g)].map((m) => m[1] ?? '');
  return [...blocks, ...attrs].join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

export type Allowlist = Record<string, number>;

export interface BudgetResult {
  /** `file: n offender(s), budget b` for every file over budget. */
  offenders: string[];
  /** `file: budget b but only n left` for every entry with slack. */
  slack: string[];
  /** What each file actually contains, for regenerating an allowlist. */
  counts: Record<string, number>;
}

/**
 * Runs `count` over every SFC and compares it with the allowlist, both ways.
 *
 * Both directions matter. Upwards, a file may not exceed its budget. Downwards,
 * a budget may not sit *above* the real count: a guard with slack in it stops
 * guarding the moment someone spends that slack, and the allowlist stops being
 * a record of what is left to do.
 */
export function checkBudgets(allowlist: Allowlist, count: (source: string) => number): BudgetResult {
  const offenders: string[] = [];
  const counts: Record<string, number> = {};

  for (const file of vueFiles()) {
    const key = keyOf(file);
    const n = count(readFileSync(file, 'utf8'));
    if (n > 0) counts[key] = n;
    const budget = allowlist[key] ?? 0;
    if (n > budget) offenders.push(`${key}: ${n}, budget ${budget}`);
  }

  const slack: string[] = [];
  for (const [key, budget] of Object.entries(allowlist)) {
    const n = counts[key] ?? 0;
    if (n < budget) slack.push(`${key}: budget ${budget} but only ${n} left — lower it to ${n}.`);
  }

  return { offenders, slack, counts };
}

/** Every declaration of `property` in a style surface, value only. */
export function declarations(source: string, property: RegExp): string[] {
  const re = new RegExp(`(?:^|[;{\\s])(${property.source})\\s*:\\s*([^;}]+)`, 'gi');
  return [...styleSurfaces(source).matchAll(re)].map((m) => (m[2] ?? '').trim());
}
