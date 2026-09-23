/**
 * The Settings search index. The rail filter used to match the seven rail
 * labels only, so "Find a setting…" could not find a setting: "OSC", "token"
 * or "crash" found nothing. Each entry here is one `settings-section` -- its
 * title exactly as the template spells it, plus the field labels and the
 * words an operator is likely to type for it.
 *
 * `settingsSearchIndex.test.ts` reads SettingsModal.vue and fails when a
 * section title is added, renamed or moved without this list following.
 */

import type { IconName } from '../components/ui/icons';

export type SettingsSection = 'appearance' | 'playout' | 'hardware' | 'media' | 'graphics' | 'qc' | 'advanced';

/**
 * UI §4.1: the Settings rail, seven groups. SettingsModalConfirmation.test.ts
 * looks for the word "Playout" in one of these labels.
 */
export const SETTINGS_RAIL: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'graphic' },
  { id: 'playout', label: 'Playout engine', icon: 'play' },
  { id: 'hardware', label: 'Hardware', icon: 'live' },
  { id: 'media', label: 'Media & ingest', icon: 'film' },
  { id: 'graphics', label: 'Graphics (CG)', icon: 'ticker' },
  { id: 'qc', label: 'QC & compliance', icon: 'check' },
  { id: 'advanced', label: 'Advanced', icon: 'settings' },
];

const RAIL_LABEL = new Map(SETTINGS_RAIL.map((entry) => [entry.id, entry.label.toLowerCase()]));

export interface SettingsIndexEntry {
  section: SettingsSection;
  /** The section's `<h3 class="section-title">`, verbatim. */
  title: string;
  /** Field labels, option names and synonyms. Lower-case is not required. */
  terms: string[];
}

export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  { section: 'appearance', title: 'Theme', terms: ['colour', 'color', 'broadcast midnight', 'graphite', 'engineering dark', 'ember', 'studio light', 'paper', 'dark mode', 'light mode'] },
  { section: 'appearance', title: 'Density', terms: ['ui scale', 'size', 'compact', 'standard', 'comfortable', 'large', 'row height', 'font size', 'zoom'] },

  { section: 'playout', title: 'CasparCG server', terms: ['server location', 'executable', 'casparcg.exe', 'config filename', 'casparcg.config', 'validate', 'engine'] },
  { section: 'playout', title: 'Supervision', terms: ['start the server when aether launches', 'auto start', 'leave the server running', 'keep alive', '24/7', 'relaunch after a crash', 'crash loop', 'resume the clip'] },
  { section: 'playout', title: 'PlayOut recovery', terms: ['restart aether automatically', 'crash', 'hang', 'watchdog', 'resume the interrupted clip', 'join the schedule', 'countdown', 'relaunch'] },
  { section: 'playout', title: 'Connection', terms: ['osc', 'feedback port', 'udp', 'amcp', 'port'] },
  { section: 'playout', title: 'Timing', terms: ['playout profile', 'pal', '1080i50', '1080p25', 'interlaced', 'progressive', 'transition length', 'frames', 'pre-roll', 'preroll', 'buffer', 'mix'] },

  { section: 'hardware', title: 'DeckLink', terms: ['sdi', 'output', 'card', 'device', 'blackmagic', 'key', 'fill'] },
  { section: 'hardware', title: 'Media path', terms: ['local media folder', 'media directory'] },
  { section: 'hardware', title: 'Tools', terms: ['setup wizard', 'decklink wizard', 'configurator', 'casparcg config editor'] },

  { section: 'media', title: 'PlayoutTranscode API', terms: ['api base url', 'api token', 'ingestor', 'transcoder', 'test connection', '4353'] },
  { section: 'media', title: 'AI designer', terms: ['api key', 'model', 'effort', 'monthly cap', 'budget', 'anthropic', 'claude'] },
  { section: 'media', title: 'FFmpeg', terms: ['binary folder override', 'ffprobe', 'tools path'] },
  { section: 'media', title: 'Recycle Bin', terms: ['keep deleted items for', 'purge', 'empty now', 'trash', 'retention'] },

  { section: 'graphics', title: 'CG Studio', terms: ['open cg studio', 'deploy templates', 'templates folder', 'advisory graphics'] },
  { section: 'graphics', title: 'Station logo', terms: ['station id bug', 'logo', 'keep on air'] },
  { section: 'graphics', title: 'Template identifiers', terms: ['advisory template', 'layer 32', 'crawl template', 'layer 33', 'ticker'] },

  { section: 'qc', title: 'Warning sensitivity', terms: ['qc', 'compliance', 'strict', 'lenient', 'production', 'warnings'] },

  { section: 'advanced', title: 'Debug tools', terms: ['enable debug tools', 'diagnostics', 'log', 'developer'] },
  { section: 'advanced', title: 'Layout', terms: ['reset panel sizes', 'library width', 'folder tree', 'panels'] },
];

export interface SettingsSearchHit {
  section: SettingsSection;
  title: string;
  /** The rail label, shown under the title in the results. */
  sectionLabel: string;
}

/**
 * Every word of the query must appear in the entry's title, its terms or its
 * rail label. Title matches rank first, a title that starts with the query
 * first of all; ties keep index order, which is rail order.
 */
export function searchSettings(query: string): SettingsSearchHit[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const needle = words.join(' ');

  return SETTINGS_INDEX.map((entry, index) => {
    const title = entry.title.toLowerCase();
    const haystack = `${title} ${entry.terms.join(' ').toLowerCase()} ${RAIL_LABEL.get(entry.section) ?? ''}`;
    if (!words.every((word) => haystack.includes(word))) return null;
    const rank = title.startsWith(needle) ? 0 : title.includes(needle) ? 1 : 2;
    return { entry, index, rank };
  })
    .filter((hit): hit is { entry: SettingsIndexEntry; index: number; rank: number } => hit !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry }) => ({
      section: entry.section,
      title: entry.title,
      sectionLabel: SETTINGS_RAIL.find((rail) => rail.id === entry.section)?.label ?? '',
    }));
}
