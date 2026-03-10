import { defineStore } from 'pinia';
import type { ComplianceRating } from './rundown';

const normalizePath = (value: string) => value.replace(/\\/g, '/').toLowerCase();

export const useMediaDefaultsStore = defineStore('media-defaults', {
    state: () => ({
        complianceByPath: {} as Record<string, ComplianceRating>
    }),

    actions: {
        getCompliance(path: string): ComplianceRating {
            if (!path) return 'none';
            return this.complianceByPath[normalizePath(path)] || 'none';
        },

        setCompliance(path: string, rating: ComplianceRating) {
            if (!path) return;
            const normalized = normalizePath(path);
            if (rating === 'none') {
                delete this.complianceByPath[normalized];
                return;
            }
            this.complianceByPath[normalized] = rating;
        }
    },

    persist: true
});