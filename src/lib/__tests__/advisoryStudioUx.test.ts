// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Studio UX guards (§4).
 *
 * These pin the properties, not the pixels: every value is typeable, every
 * control is labelled, the chrome has no emoji, nothing blocks the operator
 * with a modal dialog, and there is one place to save a preset rather than
 * three.
 */

const templatePath = path.resolve(__dirname, '../../../public/templates/playout/advisory.html');
const srcDir = path.resolve(__dirname, '../../../templates-src/advisory');

/** Drops comments, so a test for a call cannot match a mention of it in prose. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Emoji and pictographic symbols, which is what the chrome used to be made of. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}\u{23F0}-\u{23FF}\u{FE0F}]/u;

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

interface StudioHarness {
    CONTROL_SCHEMA: Array<{ key: string; label: string; control: string | null; type: string; tier: string }>;
    hydrateStudioIcons: (root?: ParentNode) => void;
    enhanceControlRail: () => void;
    STUDIO_ICONS: Record<string, string>;
}

/** Loads the template in studio mode and runs the two chrome upgrades. */
function loadStudio(): StudioHarness {
    const html = fs.readFileSync(templatePath, 'utf-8');

    document.documentElement.innerHTML = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/^[\s\S]*?<html[^>]*>/i, '')
        .replace(/<\/html>[\s\S]*$/i, '');
    document.documentElement.classList.add('studio-mode');
    document.body.classList.add('studio-mode');

    installGsapStub();

    const blocks = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)).map((m) => m[1]);
    let harness: StudioHarness | undefined;
    for (const code of blocks) {
        const exported = code.includes('const CONTROL_SCHEMA')
            ? code + '\n;return { CONTROL_SCHEMA, hydrateStudioIcons, enhanceControlRail, STUDIO_ICONS };'
            : code;
        // eslint-disable-next-line no-new-func -- evaluating the template under test
        const result = new Function(exported).call(globalThis);
        if (result) harness = result as StudioHarness;
    }
    if (!harness) throw new Error('studio block not found');

    harness.hydrateStudioIcons();
    harness.enhanceControlRail();
    return harness;
}

describe('CG advisory: studio UX', () => {
    let h: StudioHarness;

    beforeAll(() => {
        h = loadStudio();
    });

    it('gives every numeric control a typeable field and every colour a hex field', () => {
        // A 2px step on a 460px rail cannot hit a specific value, and there was
        // no keyboard entry at all.
        const missing: string[] = [];
        for (const entry of h.CONTROL_SCHEMA) {
            if (!entry.control) continue;
            const el = document.getElementById(entry.control) as HTMLInputElement | null;
            if (!el) continue;
            if (el.type === 'range' && !el.parentElement!.querySelector('.ui-num')) {
                missing.push(`${entry.key} (${entry.control}): no number field`);
            }
            if (el.type === 'color' && !el.parentElement!.querySelector(`[data-hex-for="${entry.control}"]`)) {
                missing.push(`${entry.key} (${entry.control}): no hex field`);
            }
        }
        expect(missing).toEqual([]);
    });

    it('labels every generated field, so a screen reader can name it', () => {
        const fields = Array.from(document.querySelectorAll('.ui-num, .ui-hex'));
        expect(fields.length).toBeGreaterThan(20);
        const unlabelled = fields.filter((f) => !f.getAttribute('aria-label')).length;
        expect(unlabelled).toBe(0);
    });

    it('gives every schema entry a human label', () => {
        const unlabelled = h.CONTROL_SCHEMA.filter((e) => !e.label).map((e) => e.key);
        expect(unlabelled).toEqual([]);
    });

    it('draws the chrome with the icon set instead of emoji', () => {
        // Fifty-five distinct emoji rendered differently on every machine and
        // several of them were the only label a row had.
        const slots = Array.from(document.querySelectorAll('[data-icon]'));
        expect(slots.length).toBeGreaterThan(50);

        const unknown = slots
            .map((s) => s.getAttribute('data-icon')!)
            .filter((name) => !h.STUDIO_ICONS[name]);
        expect([...new Set(unknown)], 'data-icon names with no icon in the set').toEqual([]);

        const unfilled = slots.filter((s) => !s.firstElementChild).length;
        expect(unfilled, 'icon slots hydrateStudioIcons did not fill').toBe(0);
    });

    it('has no emoji left in the chrome markup or the preset names', () => {
        const markup = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
        const found = markup.match(new RegExp(EMOJI.source, 'gu')) || [];
        expect([...new Set(found)], 'emoji still in index.html').toEqual([]);

        const presets = fs.readFileSync(path.join(srcDir, 'studio/presets.js'), 'utf-8');
        const names = Array.from(presets.matchAll(/name: '([^']*)'/g)).map((m) => m[1]);
        const shouting = names.filter((n) => EMOJI.test(n));
        expect(shouting, 'preset names still carry emoji').toEqual([]);
    });

    it('never blocks the operator with a modal dialog', () => {
        // alert() and confirm() freeze the window; the toast asks instead and
        // offers Undo afterwards. Comments may still name them — that is how
        // the code explains what it replaced.
        for (const file of fs.readdirSync(path.join(srcDir, 'studio'))) {
            const code = stripComments(fs.readFileSync(path.join(srcDir, 'studio', file), 'utf-8'));
            expect(code, `${file} still calls alert()`).not.toMatch(/(^|[^.\w])alert\s*\(/);
            expect(code, `${file} still calls confirm()`).not.toMatch(/(^|[^.\w])confirm\s*\(/);
        }
    });

    it('has one preset system, not three', () => {
        // cg_advisory_defaults and PLAYOUT_CUSTOM_THEMES each stored six fields
        // under a different "save", so an operator could not tell which one had
        // their work. Only the migration may still name them.
        const studioSrc = fs.readdirSync(path.join(srcDir, 'studio'))
            .map((f) => ({ file: f, body: fs.readFileSync(path.join(srcDir, 'studio', f), 'utf-8') }));

        for (const { file, body } of studioSrc) {
            for (const dead of ['saveCustomThemePreset', 'loadUserCustomThemes', 'saveBroadcastDefaults']) {
                expect(body, `${file} still defines or calls ${dead}`).not.toContain(dead);
            }
        }

        // Whichever file defines the migration must be the one that names the
        // retired keys; the callers only invoke it.
        const migration = studioSrc.find((s) => s.body.includes('function migrateRetiredPresetStores'));
        expect(migration, 'the migration that rescues the old stores is missing').toBeTruthy();
        expect(migration!.body, 'the migration must still read the old defaults store').toContain('cg_advisory_defaults');
        expect(migration!.body, 'the migration must still read the old themes store').toContain('PLAYOUT_CUSTOM_THEMES');
    });

    it('shows one deploy button with a state pill, not two overlapping ones', () => {
        // "Save & Deploy" and "Set Default" both deployed, and one of them also
        // silently made the preset the startup default.
        expect(document.getElementById('btn-deploy')).toBeTruthy();
        expect(document.getElementById('deploy-state')).toBeTruthy();
        expect(document.getElementById('preset-menu')).toBeTruthy();
        expect(document.getElementById('btn-make-default'), 'the second deploy button should be gone').toBeNull();

        // Deploy must no longer set the startup default as a side effect.
        const presets = fs.readFileSync(path.join(srcDir, 'studio/presets.js'), 'utf-8');
        const deployStart = presets.indexOf('async function saveCurrentActivePreset(');
        const deployEnd = presets.indexOf('\n    /**', deployStart);
        const deployBody = presets.slice(deployStart, deployEnd);
        expect(deployBody).not.toContain('PLAYOUT_DEFAULT_PRESET_ID');
    });

    it('replaces the blind hold sliders with a timeline bar', () => {
        expect(document.getElementById('tl-bar')).toBeTruthy();
        expect(document.getElementById('tl-playhead')).toBeTruthy();
        expect(document.getElementById('tl-clock')).toBeTruthy();

        // The old preview mutated the live hold values and restored them on a
        // 7-second timer, which raced anything the operator did meanwhile.
        const controls = fs.readFileSync(path.join(srcDir, 'studio/controls.js'), 'utf-8');
        expect(controls).not.toContain('}, 7000)');
        expect(controls).not.toMatch(/currentConfig\.hold_time = 2\.0/);
    });

    it('files every control under a tier, so Basic can hide the rest', () => {
        const bad = h.CONTROL_SCHEMA.filter((e) => e.tier !== 'basic' && e.tier !== 'advanced');
        expect(bad.map((e) => e.key)).toEqual([]);

        // Basic has to be genuinely smaller, or the toggle is decoration.
        const basic = h.CONTROL_SCHEMA.filter((e) => e.tier === 'basic').length;
        const advanced = h.CONTROL_SCHEMA.filter((e) => e.tier === 'advanced').length;
        expect(advanced).toBeGreaterThan(0);
        expect(basic).toBeLessThan(h.CONTROL_SCHEMA.length);

        expect(document.querySelectorAll('.studio-tier-btn').length).toBe(2);
    });

    it('stops the display-mode bar from throwing the operator rating away', () => {
        // Audit 2.4: "Station ID only" set the rating to NONE and the other
        // modes set it back to '16' rather than to whatever it had been, so
        // switching modes silently replaced the operator's choice.
        const render = fs.readFileSync(path.join(srcDir, 'core/render.js'), 'utf-8');
        const start = render.indexOf('function setStudioDisplayMode(');
        const body = render.slice(start, render.indexOf('\n    function ', start + 40));
        expect(body).not.toMatch(/currentConfig\.rating = '16'/);
        expect(body).toContain('restoreRatingForDisplayMode()');
        expect(render).toContain('ratingBeforeLogoOnly');
    });

    it('keeps the retired console panels out of the markup', () => {
        // "Live SVG Attributes" restated a subset of the rail as text.
        expect(document.getElementById('console-live-attributes')).toBeNull();
        const markup = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
        expect(markup).not.toContain('Live SVG Attributes');
    });
});
