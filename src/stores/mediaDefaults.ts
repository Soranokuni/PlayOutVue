import { defineStore } from 'pinia';
import type { ComplianceRating } from './rundown';

export type LibraryIndicator = 'none' | 'spot' | 'telemarketing';

const normalizePath = (value: string) => value.replace(/\\/g, '/').toLowerCase();

export const useMediaDefaultsStore = defineStore('media-defaults', {
    state: () => ({
        complianceByPath: {} as Record<string, ComplianceRating>,
        indicatorByPath: {} as Record<string, LibraryIndicator>
    }),

    actions: {
        getCompliance(path: string): ComplianceRating {
            if (!path) return 'none';
            return this.complianceByPath[normalizePath(path)] || 'none';
        },

        getIndicator(path: string): LibraryIndicator {
            if (!path) return 'none';
            return this.indicatorByPath[normalizePath(path)] || 'none';
        },

        setCompliance(path: string, rating: ComplianceRating) {
            if (!path) return;
            const normalized = normalizePath(path);
            if (rating === 'none') {
                delete this.complianceByPath[normalized];
                return;
            }
            this.complianceByPath[normalized] = rating;
        },

        setIndicator(path: string, indicator: LibraryIndicator) {
            if (!path) return;
            const normalized = normalizePath(path);
            if (indicator === 'none') {
                delete this.indicatorByPath[normalized];
                return;
            }
            this.indicatorByPath[normalized] = indicator;
        }
    },

    persist: true
});