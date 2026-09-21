#!/usr/bin/env node
/**
 * Builds the CG advisory template from templates-src/advisory/.
 *
 * CasparCG needs one self-contained HTML file plus vendor/ and fonts/. That
 * does not mean the source has to be one 6,800-line file, so the source is a
 * directory and this script concatenates it back into the two committed
 * copies, which must stay byte-identical (templatesParity.test.ts).
 *
 * The concatenation order below IS the file: these parts are spliced in
 * source order, so the emitted bytes match what the single file used to be.
 * The split is a cut, not a re-layering — the on-air and studio concerns are
 * still interleaved inside several of these parts, because untangling them
 * means moving code, which belongs with the schema refactor rather than here.
 * The file names say which side each part mostly serves.
 *
 *   node scripts/build-advisory.mjs           # write both copies
 *   node scripts/build-advisory.mjs --check   # fail if they are out of date
 *
 * The `let BAKED_DEFAULT_PRESET = {...};` line is generated from
 * advisory_default_preset.json rather than stored, so the sidecar and the
 * baked constant cannot drift. Its exact shape is load-bearing: the Rust
 * studio bridge finds it by that string anchor when it bakes a deployed
 * preset into the template (studio_server.rs, bake_preset_into_template_content).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'templates-src', 'advisory');
const PRESET = path.join(ROOT, 'public', 'templates', 'playout', 'advisory_default_preset.json');

export const OUTPUTS = [
    path.join(ROOT, 'public', 'templates', 'playout', 'advisory.html'),
    path.join(ROOT, 'src', 'assets', 'templates', 'playout', 'advisory.html'),
];

/** Stylesheet parts, in cascade order. Renaming or reordering changes the look. */
const CSS_PARTS = [
    'css/fonts.css',
    'css/studio-shell.css',
    'css/onair-foundation.css',
    'css/studio-chrome.css',
    'css/onair-stages.css',
    'css/studio-console.css',
    'css/onair-override.css',
    'css/studio-widgets.css',
];

/**
 * Script parts, in evaluation order. Everything lands in one classic <script>
 * scope, so function declarations hoist but top-level `let`/`const` do not:
 * a part that declares a table has to come before any part that reads it at
 * evaluation time.
 */
const JS_PARTS = [
    'core/state.js',
    'core/assets.js',
    'core/theme.js',
    'core/text.js',
    'core/measure.js',
    'core/config.js',
    'core/schema.js',
    'core/store.js',
    'core/render.js',
    'studio/controls.js',
    'core/timeline.js',
    'core/caspar.js',
    'studio/icons.js',
    'studio/rail.js',
    'studio/header.js',
    'studio/canvas.js',
    'studio/select.js',
    'studio/timelineBar.js',
    'studio/history.js',
    'studio/boot.js',
    'studio/presets.js',
    'core/subtitle.js',
    'studio/tags.js',
    'studio/saveAs.js',
];

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Rebuilds the baked default preset line from the sidecar JSON.
 * Keys are sorted so the output is stable whatever order the file is in.
 */
function bakedPresetLine() {
    const preset = JSON.parse(fs.readFileSync(PRESET, 'utf8'));
    const sorted = Object.fromEntries(Object.keys(preset).sort().map((k) => [k, preset[k]]));
    // Guard the </script> breakout the Rust baker also guards against.
    const json = JSON.stringify(sorted).replace(/<\/script/gi, '<\\/script');
    return `    let BAKED_DEFAULT_PRESET = ${json};`;
}

/** Splices one marker line, asserting it appears exactly once. */
function splice(source, marker, replacement) {
    const parts = source.split(marker);
    if (parts.length !== 2) {
        throw new Error(`build-advisory: marker ${marker.trim()} appears ${parts.length - 1} times, expected 1`);
    }
    return parts[0] + replacement + parts[1];
}

export function buildAdvisory() {
    let out = read('index.html');

    out = splice(out, '    /* @mode.js */\r\n', read('mode.js'));
    out = splice(out, '    /* @css */\r\n', CSS_PARTS.map(read).join(''));
    out = splice(out, '    /* @js */\r\n', JS_PARTS.map(read).join(''));

    // studio/presets.js carries a `null` placeholder so the source stays
    // syntactically valid on its own; the real constant is generated here.
    // [^\r\n] rather than `.`: the sources are CRLF and `.` would eat the \r.
    const anchor = /^ {4}let BAKED_DEFAULT_PRESET = [^\r\n]*/m;
    if (!anchor.test(out)) {
        throw new Error('build-advisory: BAKED_DEFAULT_PRESET anchor line not found in the assembled output');
    }
    out = out.replace(anchor, bakedPresetLine());

    return out;
}

function main() {
    const built = buildAdvisory();
    const check = process.argv.includes('--check');
    let stale = false;

    for (const target of OUTPUTS) {
        const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
        if (current === built) continue;
        stale = true;
        if (check) {
            console.error(`build-advisory: ${path.relative(ROOT, target)} is out of date; run "npm run build:cg"`);
        } else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, built);
            console.log(`wrote ${path.relative(ROOT, target)}`);
        }
    }

    if (check && stale) process.exit(1);
    if (!stale) console.log('build-advisory: both copies already up to date');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
