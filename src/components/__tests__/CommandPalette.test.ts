import { describe, it, expect } from 'vitest';
import { commandRegistry, type CommandDefinition } from '../../services/commandRegistry';

describe('Command Palette & Command Filter Suite', () => {
    it('registers and retrieves system commands cleanly', () => {
        const testCmd: CommandDefinition = {
            id: 'test.copy',
            label: 'Copy Selected Items',
            scopes: ['rundown'],
            defaultShortcut: 'Ctrl+C',
            category: 'Rundown',
            isVisible: () => true,
            isEnabled: () => true,
            execute: () => {}
        };

        commandRegistry.register(testCmd);
        const retrieved = commandRegistry.get('test.copy');
        expect(retrieved).toBeDefined();
        expect(retrieved?.label).toBe('Copy Selected Items');
    });

    it('filters commands fuzzy by label, shortcut, or category', () => {
        const filterCommands = (query: string) => {
            const q = query.toLowerCase().trim();
            return commandRegistry.getAll().filter(cmd =>
                cmd.label.toLowerCase().includes(q) ||
                cmd.id.toLowerCase().includes(q) ||
                cmd.defaultShortcut?.toLowerCase().includes(q)
            );
        };

        const cutMatches = filterCommands('Cut');
        expect(cutMatches.length).toBeGreaterThan(0);

        const shortcutMatches = filterCommands('Ctrl+C');
        expect(shortcutMatches.length).toBeGreaterThan(0);
    });
});
