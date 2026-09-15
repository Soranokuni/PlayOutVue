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
        const stylingFnIndex = content.indexOf('function applyStylingVariables(');
        expect(stylingFnIndex).toBeGreaterThan(0);
        const fnSnippet = content.slice(stylingFnIndex, stylingFnIndex + 4500);

        expect(fnSnippet).toContain('setLogoShape');
        expect(fnSnippet).toContain('setRatingShape');
        expect(fnSnippet).toContain('--cg-logo-size');
        expect(fnSnippet).toContain('sld-logo-radius');
        expect(fnSnippet).toContain('col-logo-base');
        expect(fnSnippet).toContain('col-logo-grad');
        expect(fnSnippet).toContain('updateLogoFromControls()');
        expect(fnSnippet).toContain('updateRatingFromControls()');
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
