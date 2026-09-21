import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, checkBudgets, declarations } from './styleGuard';

/**
 * Final polish §3.3 — the radius ladder.
 *
 * 38 token uses against roughly 110 literals, and most of the literals were
 * not even new values: `6px` thirty-nine times and `4px` twenty-nine were
 * `--radius-md` and `--radius-sm` spelled out. `8px` seventeen times was the
 * app's de-facto card radius with no token at all, `10px` and `14px` competed
 * for "large", and "pill" was spelled four ways (`999px`, `99px`, `9999px`,
 * and the token).
 *
 * Corners are how an interface says which things are the same kind of thing.
 * Four spellings of a pill mean four kinds of pill.
 *
 * `50%` stays: that is a circle, not a radius on the ladder.
 */

/** Remaining radius literals per file. Lower these; never raise them. */
const ALLOWLIST: Record<string, number> = {
  'App.vue': 12,
};

function countLiteralRadius(source: string): number {
  let n = 0;
  for (const value of declarations(source, /border-radius|border-top-left-radius|border-top-right-radius|border-bottom-left-radius|border-bottom-right-radius/)) {
    if (/[\d.]+(px|r?em)/.test(value)) n += 1;
  }
  return n;
}

describe('§3.3 · the radius ladder', () => {
  it('allows no radius literals outside the shrinking allowlist', () => {
    expect(checkBudgets(ALLOWLIST, countLiteralRadius).offenders).toEqual([]);
  });

  it('keeps the allowlist honest — no entry may be larger than it needs', () => {
    expect(checkBudgets(ALLOWLIST, countLiteralRadius).slack).toEqual([]);
  });

  it('defines the whole ladder, so there is always a token to reach for', () => {
    const css = readFileSync(join(SRC, 'assets', 'main.css'), 'utf8');
    for (const token of ['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-pill']) {
      expect(css, `${token} is not defined`).toContain(`${token}:`);
    }
  });

  it('spells a pill one way', () => {
    const offenders: string[] = [];
    for (const file of ['assets/main.css', 'assets/components.css']) {
      const css = readFileSync(join(SRC, file), 'utf8');
      for (const spelling of ['99px', '9999px']) {
        if (css.includes(`radius: ${spelling}`)) offenders.push(`${file} spells a pill ${spelling}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
