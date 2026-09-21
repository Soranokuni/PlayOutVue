import { describe, it, expect } from 'vitest';
import { checkBudgets, styleSurfaces } from './styleGuard';

/**
 * Final polish §3.10 — no `!important` in component styles.
 *
 * `!important` is never about the declaration it is attached to; it is a note
 * that two rules are fighting and nobody decided which should win. In this app
 * the fight was real: `.rw-row.selected` and `.rw-row.playing` competed with
 * the content-type and rating tints at exactly equal specificity, so whichever
 * came last in the file won, and `!important` was how the state rules were
 * made to win instead. The fix is to say what the precedence is — one selector
 * list, ordered — not to shout louder.
 *
 * `main.css` is exempt and holds the one deliberate exception: `.theme-switching`,
 * which must beat every component's `transition` during a theme swap (§2.1).
 * A discrete event is exactly the case `!important` exists for.
 */

/** Remaining `!important` per file. Drive to zero. */
const ALLOWLIST: Record<string, number> = {
  'components/RundownRow.vue': 4,
  'App.vue': 1,
};

function countImportant(source: string): number {
  return [...styleSurfaces(source).matchAll(/!\s*important/gi)].length;
}

describe('§3.10 · no !important in component styles', () => {
  it('allows none outside the shrinking allowlist', () => {
    expect(checkBudgets(ALLOWLIST, countImportant).offenders).toEqual([]);
  });

  it('keeps the allowlist honest — no entry may be larger than it needs', () => {
    expect(checkBudgets(ALLOWLIST, countImportant).slack).toEqual([]);
  });
});
