import { describe, it, expect } from 'vitest';
import type { RundownItem } from '../../stores/rundown';

function generateMockItems(count: number): RundownItem[] {
    const items: RundownItem[] = [];
    for (let i = 0; i < count; i++) {
        items.push({
            id: `item-${i}`,
            playoutvueId: `uuid-${i}`,
            filename: `Clip_${i.toString().padStart(5, '0')}.mp4`,
            title: `Clip ${i}`,
            type: 'video',
            duration: 10,
            inPoint: 0,
            outPoint: 10,
            status: 'ready'
        });
    }
    return items;
}

function simulateReorder(items: RundownItem[], moveIds: string[], insertIndex: number): RundownItem[] {
    const movingSet = new Set(moveIds);
    const movingItems = items.filter(i => movingSet.has(i.id));
    const filtered = items.filter(i => !movingSet.has(i.id));
    filtered.splice(insertIndex, 0, ...movingItems);
    return filtered;
}

describe('Scale & Performance Profiling Baseline', () => {
    it('handles 100 rundown items in under 5ms', () => {
        const items = generateMockItems(100);
        const start = performance.now();
        
        const reordered = simulateReorder(items, ['item-10', 'item-11'], 50);
        const duration = performance.now() - start;

        expect(reordered.length).toBe(100);
        expect(duration).toBeLessThan(5);
    });

    it('handles 1,000 rundown items in under 15ms', () => {
        const items = generateMockItems(1000);
        const start = performance.now();

        const reordered = simulateReorder(items, ['item-100', 'item-101', 'item-102'], 500);
        const duration = performance.now() - start;

        expect(reordered.length).toBe(1000);
        expect(duration).toBeLessThan(15);
    });

    it('handles 10,000 rundown items in under 50ms', () => {
        const items = generateMockItems(10000);
        const start = performance.now();

        const reordered = simulateReorder(items, ['item-5000', 'item-5001'], 2000);
        const duration = performance.now() - start;

        expect(reordered.length).toBe(10000);
        expect(duration).toBeLessThan(50);
    });
});
