import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, checkBudgets, declarations } from './styleGuard';

/**
 * Final polish §3.2 — the spacing grid.
 *
 * The audit found 500 spacing declarations of which 98 used a `--space-*`
 * token. The other 402 were px values off the 4px grid — `6px` eighty-four
 * times, `10px` fifty, `14px` fifteen — plus forty in rem and em
 * (`padding: 1.15rem`, `padding: 0.85rem 1rem 0.65rem 1rem`).
 *
 * That is not a rhythm, it is 402 independent decisions, each made against
 * whatever happened to be next to it. The visible result is that nothing lines
 * up across a seam: the library header and the rundown header differed by 5px,
 * so the divider under them stepped across the resizer, and every strip below
 * inherited the offset.
 *
 * The ladder is 2 · 4 · 8 · 12 · 16 · 20 · 24 · 32. A value that is not on it
 * is a bug, even when it looks fine on its own.
 */

const GRID = new Set([0, 2, 4, 8, 12, 16, 20, 24, 32]);

const SPACING = /padding|padding-top|padding-right|padding-bottom|padding-left|margin|margin-top|margin-right|margin-bottom|margin-left|gap|row-gap|column-gap|inset/;

/** Remaining off-grid spacing values per file. Lower these; never raise them. */
const ALLOWLIST: Record<string, number> = {
  'App.vue': 36,
  'components/ComplianceModule.vue': 25,
  'components/DeckLinkWizard.vue': 25,
  'components/CasparConfigModal.vue': 19,
  'components/FolderPickerModal.vue': 16,
  'components/MediaInspector.vue': 14,
  'components/CommandPaletteModal.vue': 11,
  'components/RecycleBinModal.vue': 10,
  'components/RundownRow.vue': 9,
  'components/MenuRow.vue': 5,
  'components/SettingsModal.vue': 5,
  'components/ContextMenu.vue': 4,
  'components/IngestorStatusLight.vue': 2,
  'components/StatusIndicator.vue': 2,
  'components/ui/Chip.vue': 2,
  'components/ui/Kbd.vue': 1,
  'components/ui/ToastHost.vue': 1,
};

function countOffGrid(source: string): number {
  let n = 0;
  for (const value of declarations(source, SPACING)) {
    for (const [, px] of value.matchAll(/(-?[\d.]+)px/g)) {
      if (!GRID.has(Math.abs(Number(px)))) n += 1;
    }
    for (const [, size] of value.matchAll(/(-?[\d.]+)r?em/g)) {
      if (Number(size) !== 0) n += 1;
    }
  }
  return n;
}

describe('§3.2 · the spacing grid', () => {
  it('allows no off-grid spacing outside the shrinking allowlist', () => {
    expect(checkBudgets(ALLOWLIST, countOffGrid).offenders).toEqual([]);
  });

  it('keeps the allowlist honest — no entry may be larger than it needs', () => {
    expect(checkBudgets(ALLOWLIST, countOffGrid).slack).toEqual([]);
  });

  it('defines the whole ladder, so there is always a token to reach for', () => {
    const css = readFileSync(join(SRC, 'assets', 'main.css'), 'utf8');
    for (const token of ['--space-0', '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8']) {
      expect(css, `${token} is not defined`).toContain(`${token}:`);
    }
  });
});
