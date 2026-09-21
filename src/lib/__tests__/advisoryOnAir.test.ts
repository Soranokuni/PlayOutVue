// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * On-air guard tests for the CG advisory template.
 *
 * These pin the three defects that made transmission differ from what the
 * operator approved in the studio:
 *
 *  - a single window.update() fanned out into five to seven timeline builds,
 *    so the stage visibly restarted mid-update;
 *  - the styling pass ran renderStationSubtitle() a second time and killed the
 *    show-tag dot -> line -> tag animation that had just started, so the
 *    signature entry almost never played on air;
 *  - the web fonts came from Google Fonts, which the render host cannot reach.
 *
 * The template is loaded into happy-dom with GSAP stubbed. Counters come from
 * window.__cgDebug, which only exists when a harness creates it before load.
 */

const templatePath = path.resolve(__dirname, '../../../public/templates/playout/advisory.html');

interface CgDebug {
    updates: number;
    timelineBuilds: number;
    subtitleRenders: number;
}

declare global {
    /** Counter bag the harness installs before the template's scripts run. */
    var __cgDebug: CgDebug | undefined;
}

/** Minimal chainable GSAP stand-in: the template only ever builds and drives timelines. */
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
        tl.timeScale = chain;
        return tl;
    };
    const noop = () => undefined;
    (globalThis as Record<string, unknown>).gsap = {
        timeline,
        to: noop,
        from: noop,
        fromTo: noop,
        set: noop,
        killTweensOf: noop,
        registerPlugin: noop,
        ticker: { add: noop, remove: noop },
    };
}

/**
 * Loads the template's markup and evaluates its inline scripts, skipping the
 * DOMContentLoaded init (which would hit the network for the default preset).
 */
function loadTemplate() {
    const html = fs.readFileSync(templatePath, 'utf-8');

    const markup = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    const inner = markup
        .replace(/^[\s\S]*?<html[^>]*>/i, '')
        .replace(/<\/html>[\s\S]*$/i, '');
    document.documentElement.innerHTML = inner;

    installGsapStub();
    globalThis.__cgDebug = { updates: 0, timelineBuilds: 0, subtitleRenders: 0 };

    // Only the template's own inline blocks; vendor/gsap.min.js has a src.
    const blocks = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)).map((m) => m[1]);
    for (const code of blocks) {
        // eslint-disable-next-line no-new-func -- evaluating the template under test
        new Function(code).call(globalThis);
    }
}

describe('CG advisory: on-air runtime', () => {
    beforeAll(() => {
        loadTemplate();
    });

    it('exposes the CasparCG layer 32 contract', () => {
        expect(typeof (window as unknown as { update?: unknown }).update).toBe('function');
        expect(typeof (window as unknown as { play?: unknown }).play).toBe('function');
        expect(typeof (window as unknown as { stop?: unknown }).stop).toBe('function');
    });

    it('renders the station subtitle exactly once per update, styling or not', () => {
        // The reproduction from the audit: PlayOut always sends `styling`, and
        // the styling pass used to kill the show-tag animation started a few
        // lines earlier in the same update.
        globalThis.__cgDebug = { updates: 0, timelineBuilds: 0, subtitleRenders: 0 };
        (window as unknown as { update: (d: unknown) => void }).update({
            show_tag: 'live',
            styling: { logoShape: 'squircle' },
        });

        expect(globalThis.__cgDebug!.updates).toBe(1);
        expect(globalThis.__cgDebug!.subtitleRenders).toBe(1);
    });

    it('builds the timeline exactly once per update', () => {
        globalThis.__cgDebug = { updates: 0, timelineBuilds: 0, subtitleRenders: 0 };
        (window as unknown as { update: (d: unknown) => void }).update({
            rating: '16',
            warnings: ['violence'],
            show_tag: 'movie',
            styling: {
                logoShape: 'circle',
                themeName: 'matte-slate',
                anchorPosition: 'top-left',
                fontFamily: 'inter',
                logoSize: 92,
                badgeSizePx: 50,
            },
        });

        expect(globalThis.__cgDebug!.timelineBuilds).toBe(1);
    });

    it('applies the operator logo position instead of snapping to the margin corner', () => {
        (window as unknown as { update: (d: unknown) => void }).update({
            rating: '12',
            styling: { logoTopPx: 140, logoLeftPx: 220 },
        });

        const root = document.documentElement;
        expect(root.style.getPropertyValue('--cg-logo-top').trim()).toBe('140px');
        expect(root.style.getPropertyValue('--cg-logo-left').trim()).toBe('220px');
    });

    it('applies the banner type scale the preset has always carried', () => {
        (window as unknown as { update: (d: unknown) => void }).update({
            rating: '18',
            styling: {
                explanationFontSizePx: 15,
                warningBodyFontSizePx: 14,
                warningLeadFontSizePx: 11.5,
                warningIconSizePx: 34,
            },
        });

        const root = document.documentElement;
        expect(root.style.getPropertyValue('--cg-explanation-font-size').trim()).toBe('15px');
        expect(root.style.getPropertyValue('--cg-warning-body-font-size').trim()).toBe('14px');
        expect(root.style.getPropertyValue('--cg-warning-lead-font-size').trim()).toBe('11.5px');
        expect(root.style.getPropertyValue('--cg-warning-icon-size').trim()).toBe('34px');
    });

    it('lets a badge colour override beat the blueprint, and a new blueprint take it back', () => {
        (window as unknown as { update: (d: unknown) => void }).update({
            styling: { themeName: 'frosted', badgeTint: '#ffcc00', badgeRim: '#221100' },
        });
        expect(document.documentElement.style.getPropertyValue('--badge-fill').trim()).toBe('#ffcc00');
        expect(document.documentElement.style.getPropertyValue('--badge-stroke').trim()).toBe('#221100');

        (window as unknown as { update: (d: unknown) => void }).update({
            styling: { themeName: 'matte-slate' },
        });
        expect(document.documentElement.style.getPropertyValue('--badge-fill').trim()).not.toBe('#ffcc00');
    });

    it('turns the virtual light angle into real gradient coordinates', () => {
        const grad = document.getElementById('sitia-convex-surface')!;
        (window as unknown as { update: (d: unknown) => void }).update({
            styling: { lightAngleDeg: 135 },
        });
        // 135deg must reproduce the original static gradient exactly, so the
        // shipped look is unchanged by wiring the slider up.
        expect(grad.getAttribute('x1')).toBe('10.00%');
        expect(grad.getAttribute('y1')).toBe('10.00%');
        expect(grad.getAttribute('x2')).toBe('90.00%');
        expect(grad.getAttribute('y2')).toBe('90.00%');

        (window as unknown as { update: (d: unknown) => void }).update({
            styling: { lightAngleDeg: 315 },
        });
        expect(grad.getAttribute('x1')).toBe('90.00%');
        expect(grad.getAttribute('y1')).toBe('90.00%');
    });

    it('renders the per-rating custom badge SVGs PlayOut has always been sending', () => {
        // Audit 2.3.5: customLogos was accepted into currentConfig and rendered
        // nowhere, so an operator who configured a custom badge saw the
        // built-in stencil go to air instead.
        const host = document.getElementById('rating-badge-container')!;

        (window as unknown as { update: (d: unknown) => void }).update({
            rating: '16',
            customLogos: { '16': '<svg viewBox="0 0 52 52"><rect width="52" height="52" fill="#ff0000"/></svg>' },
        });
        expect(host.querySelector('[data-custom-rating-svg]')).toBeTruthy();
        expect(host.getAttribute('data-custom-rating')).toBe('16');

        // A rating with no custom SVG gets the built-in stencil back.
        (window as unknown as { update: (d: unknown) => void }).update({ rating: '12' });
        expect(host.querySelector('[data-custom-rating-svg]')).toBeNull();
    });

    it('sanitises a custom badge SVG before it reaches the on-air DOM', () => {
        // The markup comes off disk via read_svg_file, so it is untrusted.
        const host = document.getElementById('rating-badge-container')!;
        (window as unknown as { update: (d: unknown) => void }).update({
            rating: '18',
            customLogos: {
                '18': '<svg viewBox="0 0 52 52"><script>fetch("//evil")</script>'
                    + '<a href="javascript:alert(1)"><rect width="52" height="52" onload="alert(2)"/></a></svg>',
            },
        });
        const rendered = host.querySelector('[data-custom-rating-svg]');
        if (rendered) {
            expect(rendered.querySelector('script')).toBeNull();
            expect(rendered.innerHTML).not.toContain('javascript:');
            expect(rendered.innerHTML).not.toContain('onload');
        }
    });

    it('renders the artwork a preset carries, and puts the built-in back when it stops', () => {
        // A preset generated by the AI designer brings its own badge, glyphs
        // and tag icons. They arrive inside styling.assets like any other
        // preset field, and are re-sanitised here because a preset is a file
        // anyone can edit.
        const badge = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">'
            + '<defs><mask id="badge-stencil-mask"><rect width="52" height="52" fill="#ffffff"/>'
            + '<text id="stencil-text" x="26" y="26">16</text></mask></defs>'
            + '<rect width="52" height="52" fill="#993300" mask="url(#badge-stencil-mask)"/></svg>';

        (window as unknown as { update: (d: unknown) => void }).update({
            rating: '16',
            styling: { themeName: 'frosted', assets: { badgeSvg: badge } },
        });

        const host = document.getElementById('rating-badge-container')!;
        expect(host.querySelector('[data-preset-asset]'), 'the preset artwork should be on the canvas').toBeTruthy();
        const builtIn = host.querySelector('#badge-svg') as HTMLElement | null;
        expect(builtIn && builtIn.style.display).toBe('none');

        (window as unknown as { update: (d: unknown) => void }).update({
            rating: '16',
            styling: { themeName: 'frosted', assets: {} },
        });
        expect(host.querySelector('[data-preset-asset]'), 'and be gone once the preset stops carrying it').toBeNull();
        expect(builtIn && builtIn.style.display).toBe('');
    });

    it('keeps the on-air console silent', () => {
        // recordAction re-rendered a display:none card on every update.
        const list = document.getElementById('console-action-list');
        expect(list ? list.children.length : 0).toBe(0);
    });
});
