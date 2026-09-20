import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * UI/UX plan §10 — contrast floors.
 *
 * The plan asks for `--text-muted` to clear 4.5:1 against `--bg-secondary` in
 * every theme, and for every chip's foreground/background pair to be checked.
 * Doing that by eye is how `--text-muted` sat at 3.75:1 in the dark theme and
 * how the 18 badge shipped white-on-red at 3.76:1 — both of which read fine to
 * someone who already knows what they say.
 *
 * WCAG 2.1 SC 1.4.3: 4.5:1 for normal text. Every pair here is small text
 * (chips and micro-labels at --fs-xs), so the large-text 3:1 allowance does not
 * apply to any of them.
 */

const CSS = readFileSync(join(process.cwd(), 'src/assets/main.css'), 'utf8').replace(/\r\n/g, '\n');

/** Reads a token's literal value from a theme block. */
function token(themeSelector: string, name: string): string {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = CSS.indexOf('\n' + themeSelector + ' {', from);
    if (start === -1) break;
    const open = CSS.indexOf('{', start);
    const close = CSS.indexOf('\n}', open);
    if (close === -1) break;
    bodies.push(CSS.slice(open, close));
    from = close;
  }

  for (const body of bodies) {
    const match = body.match(new RegExp(`${name}:\\s*([^;]+);`));
    if (match) return match[1]!.trim();
  }
  throw new Error(`${themeSelector} does not define ${name}`);
}

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = [':root,\n.dark-theme', '.monokai-theme', '.light-theme'] as const;

const AA_NORMAL = 4.5;

describe('§10 · theme contrast floors', () => {
  it('keeps --text-muted readable on --bg-secondary in every theme', () => {
    const failures: string[] = [];

    for (const theme of THEMES) {
      const ratio = contrast(token(theme, '--text-muted'), token(theme, '--bg-secondary'));
      if (ratio < AA_NORMAL) {
        failures.push(`${theme}: --text-muted on --bg-secondary is ${ratio.toFixed(2)}:1`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps --text-secondary readable on --bg-secondary in every theme', () => {
    const failures: string[] = [];

    for (const theme of THEMES) {
      const ratio = contrast(token(theme, '--text-secondary'), token(theme, '--bg-secondary'));
      if (ratio < AA_NORMAL) {
        failures.push(`${theme}: --text-secondary on --bg-secondary is ${ratio.toFixed(2)}:1`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps every filled rating chip readable', () => {
    const failures: string[] = [];

    for (const theme of THEMES) {
      for (const rating of ['k', '8', '12', '16', '18', 'tp']) {
        const bg = token(theme, `--rating-${rating}`);
        const fg = token(theme, `--rating-${rating}-fg`);
        const ratio = contrast(fg, bg);
        if (ratio < AA_NORMAL) {
          failures.push(`${theme}: rating ${rating.toUpperCase()} is ${ratio.toFixed(2)}:1 (${fg} on ${bg})`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps the filled on-air and danger surfaces readable', () => {
    const failures: string[] = [];

    for (const theme of THEMES) {
      // The STOP button and the LIVE ON AIR pill — the two controls an operator
      // must be able to read at a glance mid-take.
      const pairs: [string, string, string][] = [
        ['--status-onair / --text-on-danger', token(theme, '--status-onair'), token(theme, '--text-on-danger')],
        ['--status-error / --text-on-danger', token(theme, '--status-error'), token(theme, '--text-on-danger')],
        ['--status-armed / --text-on-warning', token(theme, '--status-armed'), token(theme, '--text-on-warning')],
        ['--accent-blue / --text-on-accent', token(theme, '--accent-blue'), token(theme, '--text-on-accent')],
      ];

      for (const [label, bg, fg] of pairs) {
        const ratio = contrast(fg, bg);
        if (ratio < AA_NORMAL) {
          failures.push(`${theme}: ${label} is ${ratio.toFixed(2)}:1 (${fg} on ${bg})`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
