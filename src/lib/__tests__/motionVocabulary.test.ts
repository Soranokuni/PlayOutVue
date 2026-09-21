import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, checkBudgets, declarations, styleSurfaces } from './styleGuard';

/**
 * Final polish §3.4 — the motion vocabulary.
 *
 * 57 transitions, of which four used the tokens. Sixteen were `transition:
 * all`, which animates properties nobody chose — including `width`, so the
 * NEXT UP dock used to resize smoothly every time its label changed. The
 * de-facto duration was `0.15s`, which matches neither `--dur-fast` (120ms)
 * nor `--dur-base` (180ms): a number that arrived by habit.
 *
 * And six transitions plus a dozen keyframes animated `box-shadow`. A shadow
 * cannot be composited; every frame of a pulsing glow is a repaint of the
 * element and everything under it, forever, on a surface that is on screen for
 * the whole shift. A glow that must pulse is a pseudo-element carrying the
 * static shadow whose *opacity* animates — opacity the compositor can do.
 *
 * Two durations for interaction, one for entrances, one curve. That is all.
 */

/** Remaining `transition: all` per file. Drive to zero; it has no future. */
const ALL_ALLOWLIST: Record<string, number> = {
  'components/TrimPanel.vue': 6,
  'components/ComplianceModule.vue': 3,
  'components/DeckLinkWizard.vue': 3,
  'components/RecycleBinModal.vue': 2,
  'App.vue': 1,
  'components/FolderPickerModal.vue': 1,
};

/** Remaining duration literals per file. Lower these; never raise them. */
const DURATION_ALLOWLIST: Record<string, number> = {
  'App.vue': 20,
  'components/RundownList.vue': 20,
  'components/TrimPanel.vue': 8,
  'components/RundownRow.vue': 6,
  'components/RecycleBinModal.vue': 5,
  'components/ComplianceModule.vue': 4,
  'components/FolderPickerModal.vue': 4,
  'components/ContextMenu.vue': 3,
  'components/DeckLinkWizard.vue': 3,
  'components/IngestorStatusLight.vue': 3,
  'components/CommandPaletteModal.vue': 1,
  'components/StatusIndicator.vue': 1,
  'components/ui/AppIcon.vue': 1,
};

/** Remaining animated shadows per file. Lower these; never raise them. */
const SHADOW_ALLOWLIST: Record<string, number> = {
  'App.vue': 3,
  'components/RundownList.vue': 4,
  'components/RundownRow.vue': 2,
};

function countTransitionAll(source: string): number {
  return declarations(source, /transition|transition-property/).filter((value) => /(^|,|\s)all(\s|$|,)/.test(value)).length;
}

function countDurationLiterals(source: string): number {
  let n = 0;
  for (const value of declarations(source, /transition|transition-duration|transition-delay|animation|animation-duration|animation-delay/)) {
    n += [...value.matchAll(/(?:^|[\s,(])[\d.]+m?s\b/g)].length;
  }
  return n;
}

/** The body of every `@keyframes` block, found by counting braces. */
function keyframeBodies(css: string): string[] {
  const out: string[] = [];
  for (const match of css.matchAll(/@keyframes[^{]*\{/g)) {
    let depth = 1;
    let i = match.index! + match[0].length;
    const from = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(css.slice(from, i - 1));
  }
  return out;
}

/** `box-shadow` named in a transition list, or set inside a `@keyframes`. */
function countAnimatedShadows(source: string): number {
  let n = declarations(source, /transition|transition-property/).filter((value) => value.includes('box-shadow')).length;
  for (const body of keyframeBodies(styleSurfaces(source))) {
    n += [...body.matchAll(/box-shadow\s*:/g)].length;
  }
  return n;
}

describe('§3.4 · the motion vocabulary', () => {
  it('never animates everything at once', () => {
    expect(checkBudgets(ALL_ALLOWLIST, countTransitionAll).offenders).toEqual([]);
  });

  it('allows no duration literals outside the shrinking allowlist', () => {
    expect(checkBudgets(DURATION_ALLOWLIST, countDurationLiterals).offenders).toEqual([]);
  });

  it('never transitions or animates a box-shadow', () => {
    expect(checkBudgets(SHADOW_ALLOWLIST, countAnimatedShadows).offenders).toEqual([]);
  });

  it('keeps every allowlist honest — no entry may be larger than it needs', () => {
    expect([
      ...checkBudgets(ALL_ALLOWLIST, countTransitionAll).slack,
      ...checkBudgets(DURATION_ALLOWLIST, countDurationLiterals).slack,
      ...checkBudgets(SHADOW_ALLOWLIST, countAnimatedShadows).slack,
    ]).toEqual([]);
  });

  it('defines the whole vocabulary, so there is always a token to reach for', () => {
    const css = readFileSync(join(SRC, 'assets', 'main.css'), 'utf8');
    for (const token of ['--dur-fast', '--dur-base', '--dur-slow', '--ease-out', '--ease-in-out']) {
      expect(css, `${token} is not defined`).toContain(`${token}:`);
    }
  });
});
