import { defineStore } from 'pinia';
const normalizePath = (value) => value.replace(/\\/g, '/').toLowerCase();
export const useMediaDefaultsStore = defineStore('media-defaults', {
    state: () => ({
        complianceByUuid: {},
        indicatorByUuid: {},
        complianceByPath: {},
        indicatorByPath: {}
    }),
    actions: {
        getCompliance(uuid, path) {
            if (uuid && this.complianceByUuid[uuid])
                return this.complianceByUuid[uuid];
            if (path)
                return this.complianceByPath[normalizePath(path)] || 'none';
            return 'none';
        },
        getIndicator(uuid, path) {
            if (uuid && this.indicatorByUuid[uuid])
                return this.indicatorByUuid[uuid];
            if (path)
                return this.indicatorByPath[normalizePath(path)] || 'none';
            return 'none';
        },
        setCompliance(uuid, path, rating) {
            if (uuid) {
                if (rating === 'none')
                    delete this.complianceByUuid[uuid];
                else
                    this.complianceByUuid[uuid] = rating;
            }
            if (path) {
                const normalized = normalizePath(path);
                if (rating === 'none')
                    delete this.complianceByPath[normalized];
                else
                    this.complianceByPath[normalized] = rating;
            }
        },
        setIndicator(uuid, path, indicator) {
            if (uuid) {
                if (indicator === 'none')
                    delete this.indicatorByUuid[uuid];
                else
                    this.indicatorByUuid[uuid] = indicator;
            }
            if (path) {
                const normalized = normalizePath(path);
                if (indicator === 'none')
                    delete this.indicatorByPath[normalized];
                else
                    this.indicatorByPath[normalized] = indicator;
            }
        }
    },
    persist: true
});
