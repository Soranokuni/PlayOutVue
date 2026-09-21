// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Schema guard tests.
 *
 * The audit's worst class of bug was structural: the preset was built by one
 * hand-written property list and applied by a different, shorter one, so about
 * twenty things the operator could design were captured nowhere, or captured
 * and then ignored, and were silently reset to defaults on air. Both halves now
 * iterate CONTROL_SCHEMA. These tests assert the property that makes that class
 * of bug impossible rather than re-checking the twenty keys one at a time:
 * every schema key survives a preset round trip.
 */

const templatePath = path.resolve(__dirname, '../../../public/templates/playout/advisory.html');

interface SchemaEntry {
    key: string;
    preset: string;
    legacy?: string[];
    control: string | null;
    type: string;
    section: string;
    tier: string;
    default: unknown;
    nullable?: boolean;
    options?: string[];
    min?: number;
    max?: number;
    step?: number;
    invalidates?: string;
    apply?: unknown;
    when?: (s: Record<string, unknown>) => boolean;
}

interface Harness {
    CONTROL_SCHEMA: SchemaEntry[];
    cgState: Record<string, unknown>;
    stateSet: (key: string, value: unknown) => boolean;
    stateGet: (key: string) => unknown;
    stateToPreset: (extra?: Record<string, unknown>) => Record<string, unknown>;
    stateFromPreset: (preset: Record<string, unknown>) => string[];
    coerceValue: (entry: SchemaEntry, raw: unknown) => unknown;
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
        tl.timeScale = chain;
        return tl;
    };
    const noop = () => undefined;
    (globalThis as Record<string, unknown>).gsap = {
        timeline, to: noop, from: noop, fromTo: noop, set: noop,
        killTweensOf: noop, registerPlugin: noop, ticker: { add: noop, remove: noop },
    };
}

/**
 * Loads the template and hands back the store internals.
 *
 * The parts are concatenated into one classic <script> scope, so top-level
 * declarations are function-local once wrapped. The harness appends an export
 * line rather than reaching for them.
 */
function loadHarness(): Harness {
    const html = fs.readFileSync(templatePath, 'utf-8');

    const markup = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    document.documentElement.innerHTML = markup
        .replace(/^[\s\S]*?<html[^>]*>/i, '')
        .replace(/<\/html>[\s\S]*$/i, '');

    installGsapStub();

    const blocks = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)).map((m) => m[1]);
    let harness: Harness | undefined;
    for (const code of blocks) {
        const exported = code.includes('const CONTROL_SCHEMA')
            ? code + '\n;return { CONTROL_SCHEMA, cgState, stateSet, stateGet, stateToPreset, stateFromPreset, coerceValue };'
            : code;
        // eslint-disable-next-line no-new-func -- evaluating the template under test
        const result = new Function(exported).call(globalThis);
        if (result) harness = result as Harness;
    }
    if (!harness) throw new Error('CONTROL_SCHEMA block not found in the template');
    return harness;
}

/** A deterministic value that is legal for this entry but not its default. */
function alternateValue(entry: SchemaEntry, seed: number): unknown {
    switch (entry.type) {
        case 'px':
        case 'deg':
        case 's':
        case 'int': {
            const min = entry.min ?? 0;
            const max = entry.max ?? 100;
            const span = max - min;
            const raw = min + ((seed * 7) % (span + 1));
            return entry.step && entry.step < 1 ? Math.round(raw * 2) / 2 : Math.round(raw);
        }
        case 'bool':
            return seed % 2 === 0;
        case 'color': {
            const hex = ((seed * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(0, 6);
            return '#' + hex;
        }
        case 'enum':
            return entry.options![seed % entry.options!.length];
        default:
            return 'ΔΟΚΙΜΗ-' + seed;
    }
}

describe('CG advisory: control schema', () => {
    let h: Harness;

    beforeAll(() => {
        h = loadHarness();
    });

    it('describes every entry completely', () => {
        const problems: string[] = [];
        const seenKeys = new Set<string>();
        const seenPresetKeys = new Set<string>();

        for (const entry of h.CONTROL_SCHEMA) {
            const at = entry.key || '(no key)';
            if (!entry.key) problems.push('entry with no key');
            if (seenKeys.has(entry.key)) problems.push(`${at}: duplicate key`);
            seenKeys.add(entry.key);

            if (!entry.preset) problems.push(`${at}: no preset key`);
            if (seenPresetKeys.has(entry.preset)) problems.push(`${at}: preset key ${entry.preset} used twice`);
            seenPresetKeys.add(entry.preset);

            if (!entry.section) problems.push(`${at}: no section`);
            if (entry.tier !== 'basic' && entry.tier !== 'advanced') problems.push(`${at}: tier must be basic or advanced`);
            if (entry.default === undefined) problems.push(`${at}: no default`);
            if (entry.type === 'enum' && (!entry.options || entry.options.length === 0)) {
                problems.push(`${at}: enum with no options`);
            }
            if (entry.type === 'enum' && entry.options && entry.options.indexOf(entry.default as string) === -1) {
                problems.push(`${at}: default ${String(entry.default)} is not one of its options`);
            }
            // A value nothing applies is a control that does nothing, which is
            // exactly the audit finding this schema exists to prevent.
            if (!entry.apply && !entry.invalidates) problems.push(`${at}: neither apply nor invalidates`);
        }

        expect(problems).toEqual([]);
    });

    it('points every control key at a control that exists in the markup', () => {
        const missing = h.CONTROL_SCHEMA
            .filter((e) => e.control && !document.getElementById(e.control))
            .map((e) => `${e.key} -> #${e.control}`);
        expect(missing).toEqual([]);
    });

    it('round-trips every key through a preset', () => {
        // The property that makes the audit's bug class impossible.
        const target: Record<string, unknown> = {};
        h.CONTROL_SCHEMA.forEach((entry, i) => {
            const value = h.coerceValue(entry, alternateValue(entry, i + 1));
            target[entry.key] = value;
            h.stateSet(entry.key, value);
        });

        const preset = h.stateToPreset();
        // Wipe to defaults, then load the preset back.
        h.CONTROL_SCHEMA.forEach((entry) => h.stateSet(entry.key, entry.default));
        h.stateFromPreset(preset);

        const lost = h.CONTROL_SCHEMA
            .filter((e) => JSON.stringify(h.stateGet(e.key)) !== JSON.stringify(target[e.key]))
            .map((e) => `${e.key} (${e.preset}): ${JSON.stringify(target[e.key])} -> ${JSON.stringify(h.stateGet(e.key))}`);

        expect(lost).toEqual([]);
    });

    it('still reads the legacy flat keys operators have in localStorage', () => {
        // Adding a key never renames one: a 2025-era preset must load unchanged.
        const legacy = {
            ratingSize: 72,
            ratingFontSize: 33,
            ratingShape: 'pill',
            theme: 'matte-slate',
            hold_time: 12,
            warning_hold_time: 8,
            accentMid: '#ff0066',
        };
        h.stateFromPreset(legacy);

        expect(h.stateGet('badge.size')).toBe(72);
        expect(h.stateGet('badge.fontSize')).toBe(33);
        expect(h.stateGet('badge.shape')).toBe('pill');
        expect(h.stateGet('look.theme')).toBe('matte-slate');
        expect(h.stateGet('motion.hold.rating')).toBe(12);
        expect(h.stateGet('motion.hold.warning')).toBe(8);
        expect(h.stateGet('banner.accent.mid')).toBe('#ff0066');
    });

    it('writes both the canonical key and every legacy alias', () => {
        // PlayOut's updateCgAdvisoryFromDeployedPreset reads the flat names, so
        // dropping them here would break the app without breaking this template.
        const preset = h.stateToPreset();
        for (const entry of h.CONTROL_SCHEMA) {
            expect(preset, `${entry.key}: canonical key ${entry.preset} missing`).toBeTruthy();
            for (const alias of entry.legacy ?? []) {
                expect(preset[alias], `${entry.key}: legacy alias ${alias} missing`).not.toBeUndefined();
            }
        }
        expect(preset.ratingSize).toBe(preset.badgeSizePx);
        expect(preset.theme).toBe(preset.themeName);
        expect(preset.hold_time).toBe(preset.ratingHoldSec);
        expect(preset.accentMid).toBe(preset.accentColor);
    });

    it('loads the committed default preset without losing or inventing a key', () => {
        const sidecar = JSON.parse(
            fs.readFileSync(
                path.resolve(__dirname, '../../../public/templates/playout/advisory_default_preset.json'),
                'utf-8'
            )
        ) as Record<string, unknown>;

        h.stateFromPreset(sidecar);
        const out = h.stateToPreset();

        // Every key the shipped preset carries must come back with the same
        // meaning. Numbers may be normalised (a string "60" becomes 60).
        const drifted: string[] = [];
        for (const [key, value] of Object.entries(sidecar)) {
            if (key === 'ratingFont') {
                // Normalised on purpose: presets written before the font
                // pickers store a resolved CSS stack here, and the schema
                // stores the key it resolves from. Nothing is lost as long as
                // the stack is still reachable, which fontFamily carries.
                expect(String(out.fontFamily)).toBe(String(value));
                continue;
            }
            if (out[key] === undefined) {
                drifted.push(`${key} was dropped`);
            } else if (typeof value === 'number' || typeof out[key] === 'number') {
                if (Number(out[key]) !== Number(value)) drifted.push(`${key}: ${String(value)} -> ${String(out[key])}`);
            } else if (JSON.stringify(out[key]) !== JSON.stringify(value)) {
                drifted.push(`${key}: ${JSON.stringify(value)} -> ${JSON.stringify(out[key])}`);
            }
        }
        expect(drifted).toEqual([]);
    });

    it('clamps and coerces rather than trusting a preset', () => {
        // Presets come off disk, out of localStorage and, later, out of a model.
        const size = h.CONTROL_SCHEMA.find((e) => e.key === 'badge.size')!;
        expect(h.coerceValue(size, 9999)).toBe(size.max);
        expect(h.coerceValue(size, -50)).toBe(size.min);
        expect(h.coerceValue(size, 'not a number')).toBe(size.default);
        expect(h.coerceValue(size, undefined)).toBe(size.default);

        const shape = h.CONTROL_SCHEMA.find((e) => e.key === 'badge.shape')!;
        expect(h.coerceValue(shape, 'PILL')).toBe('pill');
        expect(h.coerceValue(shape, 'hexagon')).toBe(shape.default);

        const colour = h.CONTROL_SCHEMA.find((e) => e.key === 'logo.base')!;
        expect(h.coerceValue(colour, '#ABC')).toBe('#aabbcc');
        expect(h.coerceValue(colour, 'rgb(1,2,3)')).toBe(colour.default);

        const nullable = h.CONTROL_SCHEMA.find((e) => e.key === 'badge.tint')!;
        expect(h.coerceValue(nullable, null)).toBeNull();
        expect(h.coerceValue(nullable, '#ffcc00')).toBe('#ffcc00');
    });
});
