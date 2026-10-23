// CI dependency gate: `npm audit` at high severity, with a short, reviewed
// list of advisories that have no fixed release and cannot reach the app.
//
// Each exemption names its advisory and why it is safe. Remove an entry as
// soon as a fix ships; the gate then blocks on it again.
import { execSync } from 'node:child_process';

const EXEMPT = new Map([
    [
        'GHSA-vfj7-8cjw-p6xm',
        // braces (all versions): stack exhaustion on deeply nested patterns.
        // Dev-only, through @vue/eslint-config-typescript -> fast-glob ->
        // micromatch; it only expands the lint globs in eslint.config.mjs.
        // No braces release fixes it (3.0.3 is the latest, 2026-10-23).
        'braces, dev-only lint glob expansion, no fixed release',
    ],
]);

const BLOCKING = new Set(['high', 'critical']);

let raw;
try {
    raw = execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
    // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
    raw = error.stdout;
}
const report = JSON.parse(raw);
const all = report.vulnerabilities ?? {};

const blocking = [];
for (const [name, vuln] of Object.entries(all)) {
    if (!BLOCKING.has(vuln.severity)) continue;
    // `via` holds advisories (objects) and the names of vulnerable dependencies
    // (strings). A package passes only when every advisory behind it is exempt.
    const open = collectAdvisories(name, new Set()).filter((a) => !EXEMPT.has(ghsa(a.url)));
    if (open.length) blocking.push({ name, severity: vuln.severity, open });
}

if (blocking.length) {
    console.error('Blocking advisories:');
    for (const b of blocking) {
        console.error(`  ${b.name} (${b.severity}): ${b.open.map((a) => `${a.title} ${a.url}`).join('; ')}`);
    }
    process.exit(1);
}
const exempted = [...EXEMPT.entries()].map(([id, why]) => `${id} (${why})`).join(', ');
console.log(`npm audit: no blocking advisories. Exempted: ${exempted}`);

function ghsa(url = '') {
    return url.split('/').pop();
}

function collectAdvisories(name, seen) {
    if (seen.has(name)) return [];
    seen.add(name);
    const out = [];
    for (const via of all[name]?.via ?? []) {
        if (typeof via === 'string') out.push(...collectAdvisories(via, seen));
        else out.push(via);
    }
    return out;
}
