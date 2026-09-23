import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The rundown's column labels are micro-labels. 77b2486 rewrote the
 * `.rw-cols-label` rule for the sticky header and lost its type line, so
 * "# TITLE FLAGS …" rendered at body size in primary white. This pins it.
 */
describe('rundown column labels', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/RundownList.vue'), 'utf8');
  const rule = source.match(/\n\.rw-cols-label \{([\s\S]*?)\n\}/)?.[1] ?? '';

  it('keeps the micro-label type on the header row', () => {
    expect(rule).toContain('font-size: var(--fs-xs)');
    expect(rule).toContain('text-transform: uppercase');
    expect(rule).toContain('letter-spacing: var(--tracking-caps)');
    expect(rule).toContain('color: var(--text-muted)');
  });
});
