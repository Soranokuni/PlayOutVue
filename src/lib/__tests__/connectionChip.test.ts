import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The control bar's engine group is one chip for the state, with the verbs in
 * its menu. "Disconnect" used to be a bar button one stray click from PLAY;
 * while the engine is connected it must only be reachable through the menu.
 * While it is not, the verb (Connect / Start / Relaunch) stays on the bar too,
 * because recovering from an outage must not be two clicks deep.
 *
 * App.vue has no mount harness (it boots the whole shell), so this reads the
 * template, the way oneButtonFamily.test.ts does.
 */
describe('connection chip', () => {
  const source = readFileSync(join(process.cwd(), 'src/App.vue'), 'utf8');
  const template = source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'));
  const engine = template.slice(template.indexOf('class="ctrl-section ctrl-engine"'), template.indexOf('<div class="ctrl-divider"></div>'));

  it('is a menu button that says the engine state', () => {
    const chip = engine.match(/<button[^>]*data-testid="connection-chip"[^>]*>/)?.[0] ?? '';
    expect(chip).toContain('aria-haspopup="menu"');
    expect(chip).toContain(':aria-expanded="showConnectionMenu"');
    expect(engine).toContain('{{ connectionShortState }}');
  });

  it('puts the connection verb in the menu', () => {
    const menu = engine.slice(engine.indexOf('data-testid="connection-menu"'));
    expect(menu).toContain('{{ connectionActionLabel }}');
    expect(menu).toContain('@click="runConnectionMenuAction"');
  });

  it('keeps the bar button for the verb only while the engine is not connected', () => {
    const barButton = engine.match(/<button\s+v-if="([^"]+)"\s+class="btn btn--ghost ctrl-btn conn-action-btn"/);
    expect(barButton?.[1]).toBe('!isPlayoutConnected');
  });
});
