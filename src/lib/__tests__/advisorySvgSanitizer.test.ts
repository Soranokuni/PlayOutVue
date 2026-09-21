// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The forbidden-construct matrix for AI-generated and operator-supplied SVG.
 *
 * Everything a model returns is data. Presets go through fromPreset, which
 * clamps every value; assets go through sanitizeSvgMarkup, which strips the
 * dangerous constructs, and then through validateAiAsset, which enforces the
 * rules the sanitiser has no reason to know about — the filter budget CasparCG
 * needs, the id prefixes, the contract elements each asset must carry.
 *
 * These cases are the reason that pipeline exists, so they are pinned one by
 * one rather than asserted in aggregate.
 */

const templatePath = path.resolve(__dirname, '../../../public/templates/playout/advisory.html');

interface SanitizerHarness {
    sanitizeSvgMarkup: (markup: string) => SVGElement | null;
    validateAiAsset: (markup: string, kind: string, scope: string) => {
        ok: boolean;
        node: SVGElement | null;
        reasons: string[];
    };
    checkBroadcastLuma: (hex: string) => { legal: boolean; luma: number; fixed: string };
    validateStylePackage: (pkg: unknown, wanted: string[] | null) => {
        ok: boolean;
        variants: Array<{ name: string; preset: Record<string, unknown>; assets: Record<string, unknown>; notes: string[] }>;
        error: string | null;
    };
}

function installGsapStub() {
    const timeline = () => {
        const tl: Record<string, unknown> = {};
        const chain = () => tl;
        for (const m of ['to', 'from', 'fromTo', 'set', 'add', 'addLabel', 'call', 'restart', 'play', 'pause', 'kill', 'seek', 'eventCallback']) {
            tl[m] = chain;
        }
        tl.progress = () => 0;
        tl.totalDuration = () => 0;
        tl.duration = () => 0;
        tl.time = () => 0;
        tl.isActive = () => false;
        tl.timeScale = chain;
        return tl;
    };
    const noop = () => undefined;
    (globalThis as Record<string, unknown>).gsap = {
        timeline, to: noop, from: noop, fromTo: noop, set: noop,
        killTweensOf: noop, registerPlugin: noop, ticker: { add: noop, remove: noop },
    };
}

function loadHarness(): SanitizerHarness {
    const html = fs.readFileSync(templatePath, 'utf-8');
    document.documentElement.innerHTML = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/^[\s\S]*?<html[^>]*>/i, '')
        .replace(/<\/html>[\s\S]*$/i, '');
    installGsapStub();

    const blocks = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)).map((m) => m[1]);
    let harness: SanitizerHarness | undefined;
    for (const code of blocks) {
        const exported = code.includes('function validateAiAsset(')
            ? code + '\n;return { sanitizeSvgMarkup, validateAiAsset, checkBroadcastLuma, validateStylePackage };'
            : code;
        // eslint-disable-next-line no-new-func -- evaluating the template under test
        const result = new Function(exported).call(globalThis);
        if (result) harness = result as SanitizerHarness;
    }
    if (!harness) throw new Error('validateAiAsset block not found in the template');
    return harness;
}

/** A glyph that passes everything, used as the base for each negative case. */
const GOOD_GLYPH = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<path d="M4 4h24v24H4z" fill="#c8c8c8" stroke="#202020" stroke-width="1.5"/></svg>';

describe('CG advisory: SVG asset validation', () => {
    let h: SanitizerHarness;

    beforeAll(() => {
        h = loadHarness();
    });

    it('accepts a well-formed glyph', () => {
        const result = h.validateAiAsset(GOOD_GLYPH, 'glyph', 'glyph-violence');
        expect(result.reasons).toEqual([]);
        expect(result.ok).toBe(true);
    });

    it('strips script, event handlers and external references', () => {
        const hostile = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
            + '<script>fetch("//evil")</script>'
            + '<foreignObject><body onload="alert(1)"/></foreignObject>'
            + '<image href="https://evil.example/x.png"/>'
            + '<a href="javascript:alert(1)"><rect width="10" height="10" onclick="alert(2)"/></a>'
            + '<animate attributeName="x" to="99"/>'
            + '</svg>';
        const node = h.sanitizeSvgMarkup(hostile)!;
        expect(node).toBeTruthy();

        const html = node.outerHTML;
        expect(node.querySelector('script')).toBeNull();
        expect(node.querySelector('foreignObject')).toBeNull();
        expect(node.querySelector('animate')).toBeNull();
        expect(html).not.toContain('javascript:');
        expect(html).not.toContain('onload');
        expect(html).not.toContain('onclick');
        expect(html).not.toContain('evil.example');
    });

    it('enforces the viewBox each asset contract names', () => {
        // A glyph drawn at 24x24 lands at the wrong size on a 1080 frame and
        // there is nothing downstream that would notice.
        const wrong = GOOD_GLYPH.replace('0 0 32 32', '0 0 24 24');
        const result = h.validateAiAsset(wrong, 'glyph', 'glyph-sex');
        expect(result.ok).toBe(false);
        expect(result.reasons.join(' ')).toContain('viewBox');
    });

    it('enforces the filter budget CasparCG needs', () => {
        const filters = (n: number) =>
            Array.from({ length: n }, (_, i) => `<filter id="f${i}"><feOffset dx="1"/></filter>`).join('');
        const tooMany = GOOD_GLYPH.replace('<path', `<defs>${filters(4)}</defs><path`);
        const result = h.validateAiAsset(tooMany, 'glyph', 'glyph-drugs');
        expect(result.ok).toBe(false);
        expect(result.reasons.join(' ')).toMatch(/filters, limit 3/);
    });

    it('enforces the blur budget separately, because blur is what drops frames', () => {
        const blurs = '<defs><filter id="b">'
            + '<feGaussianBlur stdDeviation="2"/><feGaussianBlur stdDeviation="3"/><feDropShadow dx="1" dy="1"/>'
            + '</filter></defs>';
        const result = h.validateAiAsset(GOOD_GLYPH.replace('<path', blurs + '<path'), 'glyph', 'glyph-combo');
        expect(result.ok).toBe(false);
        expect(result.reasons.join(' ')).toMatch(/blur primitives, limit 2/);
    });

    it('prefixes unprefixed ids and follows every reference to them', () => {
        // Two assets sharing an id is a rendering bug that only appears
        // sometimes, so ids are rewritten rather than trusted.
        const withIds = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
            + '<defs><linearGradient id="grad"><stop offset="0" stop-color="#303030"/></linearGradient></defs>'
            + '<path d="M4 4h24v24H4z" fill="url(#grad)"/></svg>';
        const result = h.validateAiAsset(withIds, 'glyph', 'glyph-language');
        expect(result.reasons).toEqual([]);

        const html = result.node!.outerHTML;
        expect(html).toContain('id="glyph-language-grad"');
        expect(html).toContain('url(#glyph-language-grad)');
        expect(html).not.toContain('url(#grad)');
    });

    it('requires the badge to carry the stencil mask it is rendered through', () => {
        const noMask = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">'
            + '<rect width="52" height="52" fill="#a0a0a0"/></svg>';
        const result = h.validateAiAsset(noMask, 'badge', 'badge');
        expect(result.ok).toBe(false);
        expect(result.reasons.join(' ')).toContain('badge-stencil-mask');

        const withMask = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">'
            + '<defs><mask id="badge-stencil-mask"><rect width="52" height="52" fill="#ffffff"/>'
            + '<text id="stencil-text" x="26" y="26">16</text></mask></defs>'
            + '<rect width="52" height="52" fill="#a0a0a0" mask="url(#badge-stencil-mask)"/></svg>';
        expect(h.validateAiAsset(withMask, 'badge', 'badge').reasons).toEqual([]);
    });

    it('rejects an oversize asset', () => {
        const huge = GOOD_GLYPH.replace('<path', '<path d="' + 'M0 0'.repeat(20000) + '"/><path');
        const result = h.validateAiAsset(huge, 'glyph', 'glyph-violence');
        expect(result.ok).toBe(false);
        expect(result.reasons.join(' ')).toMatch(/too large/);
    });

    it('rejects a style block and anything reaching outside the asset', () => {
        const styled = GOOD_GLYPH.replace(
            '<path',
            '<style>@import url("//evil.example/x.css");</style><path'
        );
        const result = h.validateAiAsset(styled, 'glyph', 'glyph-sex');
        expect(result.ok).toBe(false);
        expect(result.reasons.join(' ')).toMatch(/<style>|outside the asset/);
    });

    it('holds colours inside legal broadcast luma', () => {
        // A studio monitor shows illegal luma perfectly happily; transmission
        // clips it.
        expect(h.checkBroadcastLuma('#808080').legal).toBe(true);

        const white = h.checkBroadcastLuma('#ffffff');
        expect(white.legal, 'pure white is not legal').toBe(false);
        expect(h.checkBroadcastLuma(white.fixed).legal, 'and the fix must be').toBe(true);

        const black = h.checkBroadcastLuma('#000000');
        expect(black.legal, 'pure black is not legal').toBe(false);
        expect(h.checkBroadcastLuma(black.fixed).legal).toBe(true);

        // The fix shifts towards legal rather than flattening to grey, so a
        // warm colour stays warm.
        const hot = h.checkBroadcastLuma('#fffff0');
        expect(hot.legal).toBe(false);
        expect(h.checkBroadcastLuma(hot.fixed).legal).toBe(true);
        expect(hot.fixed).not.toBe('#808080');

        // A colour already inside the range is returned untouched.
        expect(h.checkBroadcastLuma('#702177').fixed).toBe('#702177');

        expect(h.checkBroadcastLuma('not a colour').legal).toBe(false);
    });

    it('offers a variant whose preset passed even when an asset did not', () => {
        // A good palette with one bad glyph is still worth having; throwing the
        // whole variant away would waste the generation.
        const pkg = {
            variants: [{
                name: 'Gold',
                rationale: 'warm',
                preset: { logoBase: '#8a5a00' },
                assets: {
                    glyphs: {
                        violence: GOOD_GLYPH,
                        sex: GOOD_GLYPH.replace('0 0 32 32', '0 0 99 99'),
                    },
                },
            }],
        };
        const result = h.validateStylePackage(pkg, ['glyphs']);
        expect(result.ok).toBe(true);

        const variant = result.variants[0];
        expect(variant.name).toBe('Gold');
        expect((variant.assets.glyphs as Record<string, string>).violence).toBeTruthy();
        expect((variant.assets.glyphs as Record<string, string>).sex).toBeUndefined();
        expect(variant.notes.join(' '), 'the operator is told what was dropped').toContain('glyph-sex');
    });

    it('reports a clamped colour rather than applying it silently', () => {
        const pkg = {
            variants: [{ name: 'Blown out', rationale: '', preset: { logoBase: '#ffffff' } }],
        };
        const result = h.validateStylePackage(pkg, null);
        const variant = result.variants[0];
        expect(variant.preset.logoBase).not.toBe('#ffffff');
        expect(variant.notes.join(' ')).toContain('legal broadcast luma');
    });

    it('refuses a response that is not a style package', () => {
        expect(h.validateStylePackage(null, null).ok).toBe(false);
        expect(h.validateStylePackage({}, null).ok).toBe(false);
        expect(h.validateStylePackage({ variants: [] }, null).ok).toBe(false);
        expect(h.validateStylePackage({ variants: 'nope' }, null).ok).toBe(false);
    });
});
