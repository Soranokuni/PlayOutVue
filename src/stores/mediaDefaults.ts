import { defineStore } from 'pinia';
import type { ComplianceRating } from './rundown';

export type LibraryIndicator = 'none' | 'spot' | 'telemarketing';

const normalizePath = (value: string) => value.replace(/\\/g, '/').toLowerCase();

export const useMediaDefaultsStore = defineStore('media-defaults', {
    state: () => ({
        complianceByUuid: {} as Record<string, ComplianceRating>,
        indicatorByUuid: {} as Record<string, LibraryIndicator>,
        complianceByPath: {} as Record<string, ComplianceRating>,
        indicatorByPath: {} as Record<string, LibraryIndicator>
    }),

    actions: {
        getCompliance(uuid?: string, path?: string): ComplianceRating {
            if (uuid && this.complianceByUuid[uuid]) return this.complianceByUuid[uuid];
            if (path) return this.complianceByPath[normalizePath(path)] || 'none';
            return 'none';
        },

        getIndicator(uuid?: string, path?: string): LibraryIndicator {
            if (uuid && this.indicatorByUuid[uuid]) return this.indicatorByUuid[uuid];
            if (path) return this.indicatorByPath[normalizePath(path)] || 'none';
            return 'none';
        },

        setCompliance(uuid: string | undefined, path: string | undefined, rating: ComplianceRating) {
            if (uuid) {
                if (rating === 'none') delete this.complianceByUuid[uuid];
                else this.complianceByUuid[uuid] = rating;
            }
            if (path) {
                const normalized = normalizePath(path);
                if (rating === 'none') delete this.complianceByPath[normalized];
                else this.complianceByPath[normalized] = rating;
            }
        },

        setIndicator(uuid: string | undefined, path: string | undefined, indicator: LibraryIndicator) {
            if (uuid) {
                if (indicator === 'none') delete this.indicatorByUuid[uuid];
                else this.indicatorByUuid[uuid] = indicator;
            }
            if (path) {
                const normalized = normalizePath(path);
                if (indicator === 'none') delete this.indicatorByPath[normalized];
                else this.indicatorByPath[normalized] = indicator;
            }
        }
    },

    persist: true
});
