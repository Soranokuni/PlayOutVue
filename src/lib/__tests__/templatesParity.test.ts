import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Broadcast Templates Parity Verification', () => {
    const publicPath = path.resolve(__dirname, '../../../public/templates/playout/advisory.html');
    const assetsPath = path.resolve(__dirname, '../../assets/templates/playout/advisory.html');

    it('ensures public and src/assets copies of advisory.html are byte-identical', () => {
        expect(fs.existsSync(publicPath), `Public template does not exist: ${publicPath}`).toBe(true);
        expect(fs.existsSync(assetsPath), `Assets template does not exist: ${assetsPath}`).toBe(true);

        const publicBuffer = fs.readFileSync(publicPath);
        const assetsBuffer = fs.readFileSync(assetsPath);

        expect(
            publicBuffer.equals(assetsBuffer),
            'public/templates/playout/advisory.html and src/assets/templates/playout/advisory.html must be byte-for-byte identical'
        ).toBe(true);
    });

    it('contains no duplicate IDs in the initial static DOM markup', () => {
        const content = fs.readFileSync(publicPath, 'utf-8');
        const scriptIndex = content.indexOf('<script');
        const domMarkup = scriptIndex !== -1 ? content.slice(0, scriptIndex) : content;

        const idMatches = Array.from(domMarkup.matchAll(/\bid=["']([^"']+)["']/g)).map(m => m[1]);
        const seen = new Set<string>();
        const duplicates: string[] = [];

        for (const id of idMatches) {
            if (seen.has(id)) {
                duplicates.push(id);
            }
            seen.add(id);
        }

        expect(duplicates, `Found duplicate DOM IDs in static markup: ${duplicates.join(', ')}`).toEqual([]);
    });

    it('uses semantic sitia-logo-chassis and contains zero references to sitia-squircle-rect', () => {
        const content = fs.readFileSync(publicPath, 'utf-8');
        expect(content).toContain('id="sitia-logo-chassis"');
        expect(content).not.toContain('id="sitia-squircle-rect"');
        expect(content).not.toContain('sitia-squircle-rect');
    });

    it('implements toGreekUpper, escapeHtml, and RFC 2397 compliant SVG URIs', () => {
        const content = fs.readFileSync(publicPath, 'utf-8');
        expect(content).toContain('function toGreekUpper(');
        expect(content).toContain('function escapeHtml(');
        expect(content).toContain('function hydrateDefaultPreset(');
        expect(content).toContain('function fitStationSubtitleText(');

        // Verify that bg-movie uses RFC 2397 percent-encoded SVG
        expect(content).toContain('%3Csvg%20xmlns');
        expect(content).not.toContain("url('data:image/svg+xml;utf8,<svg");
    });

    it('ensures applyStylingVariables applies all logo, badge, and theme styling properties', () => {
        const content = fs.readFileSync(publicPath, 'utf-8');
        // applyStylingVariables is now a thin wrapper that opens the deferred
        // render block; the work lives in applyStylingVariablesInner.
        const stylingFnIndex = content.indexOf('function applyStylingVariablesInner(');
        expect(stylingFnIndex).toBeGreaterThan(0);
        const fnSnippet = content.slice(stylingFnIndex, content.indexOf('\n    function ', stylingFnIndex + 40));

        expect(fnSnippet).toContain('setLogoShape');
        expect(fnSnippet).toContain('setRatingShape');
        expect(fnSnippet).toContain('--cg-logo-size');
        expect(fnSnippet).toContain('sld-logo-radius');
        expect(fnSnippet).toContain('col-logo-base');
        expect(fnSnippet).toContain('col-logo-grad');
        expect(fnSnippet).toContain('updateLogoFromControls()');
        expect(fnSnippet).toContain('updateRatingFromControls()');
    });

    it('vendors its web fonts instead of reaching for Google Fonts', () => {
        // The CasparCG render host has no internet. A Google Fonts <link> meant
        // the studio previewed the real face while transmission fell through to
        // the local fallback stack, so the approved look was not the aired one.
        const content = fs.readFileSync(publicPath, 'utf-8');
        expect(content).not.toContain('fonts.googleapis.com');
        expect(content).not.toContain('fonts.gstatic.com');
        expect(content).toContain('@font-face');
        expect(content).toContain("src: url('fonts/");

        const fontDir = path.resolve(__dirname, '../../../public/templates/playout/fonts');
        const assetsFontDir = path.resolve(__dirname, '../../assets/templates/playout/fonts');
        expect(fs.existsSync(fontDir), 'vendored fonts directory is missing').toBe(true);

        // Every face the stylesheet points at must actually be on disk, in both
        // copies, or the render host silently falls back again.
        const referenced = Array.from(content.matchAll(/url\('fonts\/([^']+)'\)/g)).map(m => m[1]);
        expect(referenced.length).toBeGreaterThan(0);
        for (const file of new Set(referenced)) {
            expect(fs.existsSync(path.join(fontDir, file)), `missing public/…/fonts/${file}`).toBe(true);
            expect(fs.existsSync(path.join(assetsFontDir, file)), `missing src/assets/…/fonts/${file}`).toBe(true);
        }
    });

    it('applies every key the baked default preset carries', () => {
        // Audit 2.2: the preset carried keys that applyStylingVariables simply
        // ignored, so the operator's design was reset to defaults on air. Any
        // key added to the preset from here on has to be applied somewhere.
        const content = fs.readFileSync(publicPath, 'utf-8');
        const baked = /let BAKED_DEFAULT_PRESET = (\{.*?\});/.exec(content);
        expect(baked, 'BAKED_DEFAULT_PRESET anchor line not found').toBeTruthy();
        const preset = JSON.parse(baked![1]) as Record<string, unknown>;

        const start = content.indexOf('function applyStylingVariablesInner(');
        expect(start).toBeGreaterThan(0);
        const end = content.indexOf('\n    function ', start + 40);
        const body = content.slice(start, end);

        // Keys that are payload/bookkeeping rather than style, or that are read
        // through a documented legacy alias the function handles explicitly.
        const notStyling = new Set([
            'id', 'name', 'rating', 'warnings', 'tp', 'showTag', 'tagTexts',
            'orientation', 'displayMode', 'customLogoSvgPath', 'customRatingSvgPaths',
            'hold_time', 'ratingHoldSec', 'warning_hold_time', 'warningHoldSec',
            'accentMid', 'theme', 'ratingSize', 'ratingFontSize', 'ratingShape',
            'ratingFont', 'accentStyle', 'stencilStyle', 'badgeBorderRadiusPx',
        ]);

        const missing = Object.keys(preset).filter(k => !notStyling.has(k) && !body.includes(k));
        expect(missing, `preset keys applyStylingVariables ignores: ${missing.join(', ')}`).toEqual([]);
    });

    it('keeps the deferred-render guard that makes one update one build', () => {
        // Audit 2.3: a single window.update() fanned out into five to seven
        // buildTimeline() calls and killed the show-tag entry animation.
        const content = fs.readFileSync(publicPath, 'utf-8');
        expect(content).toContain('function beginDeferredRender(');
        expect(content).toContain('function endDeferredRender(');
        expect(content).toContain('if (!suppressSubtitleRender) renderStationSubtitle(');
        expect(content).toContain('if (deferredRenderDepth > 0) { pendingTimelineBuild = true; return; }');
    });

    it('offers no rating cut-out mode the select cannot represent', () => {
        // Audit 2.3.4: ratingCutout: 'stencil' shipped in all seven master
        // presets and was a silent no-op on #sel-rating-cutout.
        const content = fs.readFileSync(publicPath, 'utf-8');
        expect(content).toContain('function normalizeRatingCutout(');

        const options = Array.from(
            content.matchAll(/<select[^>]*id="sel-rating-cutout"[\s\S]*?<\/select>/g)
        ).flatMap(block => Array.from(block[0].matchAll(/<option value="([^"]+)"/g)).map(m => m[1]));
        expect(options.length).toBeGreaterThan(0);

        const declared = Array.from(content.matchAll(/ratingCutout: '([^']+)'/g)).map(m => m[1]);
        for (const value of new Set(declared)) {
            expect(options, `preset declares ratingCutout '${value}', which the select has no option for`).toContain(value);
        }
    });

    it('ensures all embedded script blocks in advisory.html have zero syntax errors', () => {
        const content = fs.readFileSync(publicPath, 'utf-8');
        const scriptMatches = content.match(/<script[\s\S]*?<\/script>/gi) || [];
        expect(scriptMatches.length).toBeGreaterThan(0);

        for (let i = 0; i < scriptMatches.length; i++) {
            const rawScript = scriptMatches[i];
            const code = rawScript.replace(/^<script.*?>/i, '').replace(/<\/script>$/i, '');
            expect(() => {
                // eslint-disable-next-line no-new-func -- compile-only syntax check of the template's script blocks; never invoked
                new Function(code);
            }, `Syntax error detected in advisory.html script block #${i}`).not.toThrow();
        }
    });
});
