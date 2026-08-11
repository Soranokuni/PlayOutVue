import type { CommandDefinition } from '../services/commandRegistry';

export interface CommandSearchResult {
  command: CommandDefinition;
  score: number;
}

/**
 * Pure fuzzy search utility for command definitions.
 *
 * Scoring algorithm:
 * - 1000: Exact label match
 * - 900:  Exact command ID match
 * - 800:  Label starts with query (prefix)
 * - 700:  Word-start match in label or ID
 * - 600:  Shortcut match
 * - 500:  Substring match in label, ID, category, or description
 * - 0:    No match
 */
export function searchCommands(
  query: string,
  commands: CommandDefinition[]
): CommandSearchResult[] {
  const trimmed = query.trim().toLowerCase();

  if (!trimmed) {
    return commands.map((command) => ({ command, score: 1 }));
  }

  const results: CommandSearchResult[] = [];

  for (const command of commands) {
    const label = command.label.toLowerCase();
    const id = command.id.toLowerCase();
    const category = (command.category || '').toLowerCase();
    const shortcut = (command.defaultShortcut || '').toLowerCase();
    const description = (command.description || '').toLowerCase();

    let score = 0;

    if (label === trimmed) {
      score = 1000;
    } else if (id === trimmed) {
      score = 900;
    } else if (label.startsWith(trimmed)) {
      score = 800;
    } else if (
      label.split(/\s+/).some((word) => word.startsWith(trimmed)) ||
      id.split(/[\._\-]+/).some((part) => part.startsWith(trimmed))
    ) {
      score = 700;
    } else if (shortcut && shortcut.includes(trimmed)) {
      score = 600;
    } else if (
      label.includes(trimmed) ||
      id.includes(trimmed) ||
      category.includes(trimmed) ||
      description.includes(trimmed)
    ) {
      score = 500;
    }

    if (score > 0) {
      results.push({ command, score });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
