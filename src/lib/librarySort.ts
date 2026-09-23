/**
 * Library list ordering. The rendered list and the arrow-key walk both use the
 * array this produces, so what the operator sees is what the keys step through.
 */

export type LibrarySortKey = 'name' | 'duration' | 'added';
export type LibrarySortDir = 'asc' | 'desc';

export interface LibrarySort {
    key: LibrarySortKey;
    dir: LibrarySortDir;
}

export const DEFAULT_LIBRARY_SORT: LibrarySort = { key: 'name', dir: 'asc' };

export const LIBRARY_SORT_OPTIONS: ReadonlyArray<{ key: LibrarySortKey; label: string; firstDir: LibrarySortDir }> = [
    { key: 'name', label: 'Name', firstDir: 'asc' },
    { key: 'duration', label: 'Duration', firstDir: 'desc' },
    { key: 'added', label: 'Date added', firstDir: 'desc' },
];

interface SortableAsset {
    uuid: string;
    display_name: string;
    current_path: string;
    duration_ms: number;
}

// Numeric so "Ep 2" sorts before "Ep 10"; base sensitivity so case and Greek
// accents don't split otherwise-equal names.
const collator = new Intl.Collator(['el', 'en'], { numeric: true, sensitivity: 'base' });

function nameOf(a: SortableAsset): string {
    return a.display_name || a.current_path?.split(/[/\\]/).pop() || '';
}

/** Restores a persisted value, falling back to the default for anything malformed. */
export function sanitizeLibrarySort(value: unknown): LibrarySort {
    const v = value as Partial<LibrarySort> | null;
    const key = LIBRARY_SORT_OPTIONS.some((o) => o.key === v?.key) ? v!.key! : DEFAULT_LIBRARY_SORT.key;
    const dir = v?.dir === 'asc' || v?.dir === 'desc' ? v.dir : DEFAULT_LIBRARY_SORT.dir;
    return { key, dir };
}

/** Clicking the active key flips its direction; another key starts at its natural direction. */
export function nextLibrarySort(current: LibrarySort, key: LibrarySortKey): LibrarySort {
    if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
    const option = LIBRARY_SORT_OPTIONS.find((o) => o.key === key);
    return { key, dir: option?.firstDir ?? 'asc' };
}

/**
 * Returns a sorted copy. Ties fall back to name, then uuid, so the order never
 * shuffles between polls. Assets with no known creation time sort after the
 * dated ones, in either direction.
 */
export function sortLibraryAssets<T extends SortableAsset>(
    assets: readonly T[],
    sort: LibrarySort,
    createdMs: (asset: T) => number | undefined = () => undefined,
): T[] {
    const sign = sort.dir === 'asc' ? 1 : -1;
    const byName = (a: T, b: T) => collator.compare(nameOf(a), nameOf(b)) || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);

    return [...assets].sort((a, b) => {
        if (sort.key === 'duration') {
            const d = (a.duration_ms || 0) - (b.duration_ms || 0);
            if (d !== 0) return sign * d;
            return byName(a, b);
        }
        if (sort.key === 'added') {
            const ta = createdMs(a);
            const tb = createdMs(b);
            if (ta !== undefined && tb !== undefined && ta !== tb) return sign * (ta - tb);
            if (ta === undefined && tb !== undefined) return 1;
            if (tb === undefined && ta !== undefined) return -1;
            return byName(a, b);
        }
        return sign * byName(a, b);
    });
}
