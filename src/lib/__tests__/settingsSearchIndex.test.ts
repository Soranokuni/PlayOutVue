import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_INDEX, SETTINGS_RAIL, searchSettings } from '../settingsSearch';

/**
 * "Find a setting…" searches a hand-kept index, so the index must follow the
 * template. This reads SettingsModal.vue, collects every section title under
 * each `activeSection === '…'` pane, and compares the two both ways.
 */
function sectionTitlesByPane(): Map<string, string[]> {
  const source = readFileSync(join(process.cwd(), 'src/components/SettingsModal.vue'), 'utf8');
  const template = source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'));
  const panes = new Map<string, string[]>();
  const paneStarts = [...template.matchAll(/<div v-if="activeSection === '([a-z]+)'">/g)];
  paneStarts.forEach((match, i) => {
    const body = template.slice(match.index!, paneStarts[i + 1]?.index ?? template.length);
    const titles = [...body.matchAll(/<h3 class="section-title">([^<]+)<\/h3>/g)].map((m) => m[1]!.trim());
    panes.set(match[1]!, titles);
  });
  return panes;
}

describe('Settings search index', () => {
  const panes = sectionTitlesByPane();

  it('finds every rail pane in the template', () => {
    expect([...panes.keys()].sort()).toEqual(SETTINGS_RAIL.map((r) => r.id).sort());
  });

  it('indexes every section title, under the pane that holds it, and nothing else', () => {
    const fromTemplate = [...panes].flatMap(([pane, titles]) => titles.map((t) => `${pane}:${t}`)).sort();
    const fromIndex = SETTINGS_INDEX.map((e) => `${e.section}:${e.title}`).sort();
    expect(fromIndex).toEqual(fromTemplate);
  });

  it('finds settings by their field labels, not just by rail section', () => {
    expect(searchSettings('osc')[0]?.title).toBe('Connection');
    expect(searchSettings('token')[0]?.title).toBe('PlayoutTranscode API');
    expect(searchSettings('crawl')[0]?.title).toBe('Template identifiers');
    expect(searchSettings('reset panel')[0]?.title).toBe('Layout');
  });

  it('ranks a title match above a term match, and needs every word', () => {
    // "recovery" is a title word for PlayOut recovery and only a synonym elsewhere.
    expect(searchSettings('recovery')[0]?.title).toBe('PlayOut recovery');
    expect(searchSettings('crash loop').map((h) => h.title)).toEqual(['Supervision']);
    expect(searchSettings('osc banana')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('matches a rail label, and reports it with each hit', () => {
    const hits = searchSettings('hardware');
    expect(hits.map((h) => h.title)).toEqual(['DeckLink', 'Media path', 'Tools']);
    expect(hits.every((h) => h.sectionLabel === 'Hardware')).toBe(true);
  });
});
