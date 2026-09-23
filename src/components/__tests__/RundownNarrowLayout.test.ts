import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A snapped window narrows the rundown. The columns shed in a fixed order,
 * and the Actions cell is pinned to the list's right edge so play and delete
 * stay reachable. Pinned, that cell paints `--rw-row-bg` over an opaque base,
 * which is only the row's own colour while every row state sets the custom
 * property instead of `background` directly.
 */
const styles = (file: string) => {
  const source = readFileSync(join(process.cwd(), 'src/components', file), 'utf8');
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
};

/** Each top-level `selector { body }` pair, comments stripped. */
const rules = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.trim(),
    body: m[2]!,
  }));

describe('rundown in a narrow window', () => {
  const row = styles('RundownRow.vue');
  const list = styles('RundownList.vue');

  it('has every row state set --rw-row-bg rather than background', () => {
    const offenders = rules(row)
      // The row box itself in any state; its pseudo-elements paint their own marks.
      .filter((r) => !r.selector.includes('::'))
      .filter((r) => /^\.rw-row(?:[.:[][^ ,>]*)?$/.test(r.selector.split(',').pop()!.trim()))
      .filter((r) => /(^|;|\s)background\s*:/.test(r.body) && !r.body.includes('var(--rw-row-bg)'));
    expect(offenders.map((r) => r.selector)).toEqual([]);
  });

  it('pins the Actions cell and its header label to the right edge', () => {
    const cell = rules(row).find((r) => r.selector === '.rw-actions' && r.body.includes('position: sticky'));
    expect(cell?.body).toContain('right: 0');
    expect(cell?.body).toContain('var(--rw-row-bg)');
    const label = rules(list).find((r) => r.selector === '.rw-cols-label .col-actions');
    expect(label?.body).toContain('position: sticky');
  });

  it('lets rows grow with their columns, and keeps a long title from widening them', () => {
    expect(rules(row).find((r) => r.selector === '.rw-row')?.body).toContain('min-width: min-content');
    expect(rules(row).some((r) => r.selector === '.rw-name' && r.body.includes('contain: inline-size'))).toBe(true);
  });

  it('sheds Trim, then the tag chips, then At, at the same widths in header and rows', () => {
    const steps = (css: string) => [...css.matchAll(/@container rundown \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    const rowSteps = steps(row);
    expect(rowSteps).toEqual([752, 660, 596]);
    // The header sheds the same three, plus the two title-floor steps it owns.
    expect(steps(list)).toEqual([792, ...rowSteps, 496]);
  });
});
