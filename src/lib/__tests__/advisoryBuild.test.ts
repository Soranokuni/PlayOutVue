import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
// @ts-expect-error -- plain .mjs build script, no types
import { buildAdvisory, OUTPUTS } from '../../../scripts/build-advisory.mjs';

/**
 * The advisory template is generated from templates-src/advisory/ and the two
 * committed copies are build output. Editing them by hand works right up until
 * the next build silently reverts it, so this test makes that mistake loud.
 */
describe('CG advisory: build output', () => {
    const srcDir = path.resolve(__dirname, '../../../templates-src/advisory');

    it('regenerates both committed copies byte-for-byte', () => {
        const built: string = buildAdvisory();
        for (const target of OUTPUTS as string[]) {
            const current = fs.readFileSync(target, 'utf-8');
            expect(
                current === built,
                `${path.relative(path.resolve(__dirname, '../../..'), target)} differs from the build output. ` +
                    'Edit templates-src/advisory/ and run "npm run build:cg" instead of editing the generated file.'
            ).toBe(true);
        }
    });

    it('keeps the string anchor the Rust preset baker searches for', () => {
        // studio_server.rs::bake_preset_into_template_content rewrites this exact
        // line shape. Changing the declaration breaks Save & Deploy silently.
        const built: string = buildAdvisory();
        const matches = built.match(/^ {4}let BAKED_DEFAULT_PRESET = \{.*\};$/gm);
        expect(matches, 'BAKED_DEFAULT_PRESET anchor line missing or reshaped').toHaveLength(1);
    });

    it('generates the baked preset from the sidecar, so the two cannot drift', () => {
        const built: string = buildAdvisory();
        const baked = JSON.parse(/let BAKED_DEFAULT_PRESET = (\{.*?\});/.exec(built)![1]);
        const sidecar = JSON.parse(
            fs.readFileSync(
                path.resolve(__dirname, '../../../public/templates/playout/advisory_default_preset.json'),
                'utf-8'
            )
        );
        expect(baked).toEqual(sidecar);
    });

    it('sources every part the build concatenates', () => {
        const script = fs.readFileSync(path.resolve(__dirname, '../../../scripts/build-advisory.mjs'), 'utf-8');
        const parts = Array.from(script.matchAll(/^ {4}'((?:css|core|studio)\/[\w.-]+)',$/gm)).map((m) => m[1]);
        expect(parts.length).toBeGreaterThan(10);
        for (const part of parts) {
            expect(fs.existsSync(path.join(srcDir, part)), `missing source part ${part}`).toBe(true);
        }

        // And nothing in the source tree is orphaned: a part that exists but is
        // never concatenated is dead code that looks live.
        const onDisk: string[] = [];
        for (const dir of ['css', 'core', 'studio']) {
            for (const f of fs.readdirSync(path.join(srcDir, dir))) onDisk.push(`${dir}/${f}`);
        }
        expect(onDisk.sort()).toEqual([...parts].sort());
    });
});
