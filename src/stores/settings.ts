import { defineStore } from 'pinia';

export const useSettingsStore = defineStore('settings', {
    state: () => ({
        // OBS Studio WebSocket Connection Parameters
        obsUrl: 'ws://127.0.0.1:4455',
        obsPassword: '',

        // Media Paths
        localMediaPath: 'C:/Media',

        // URL for hosting the Greek ESR Graphic Bug (HTML Producer)
        complianceUrl: 'http://localhost/greek_ratings.html',

        // Hardware Output
        decklinkOutputName: '',

        // Station Watermark / Bug - permanent OBS overlay on all content
        watermarkPath: '',          // Absolute path to station logo image (PNG/SVG)
        watermarkEnabled: false,    // Toggle overlay on/off
        watermarkPosition: 'top-right' as 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
        watermarkOpacity: 80,       // 0-100 percent
        watermarkScale: 15,         // percent of frame width
    }),

    actions: {
        updateSettings(payload: Partial<typeof this.$state>) {
            Object.assign(this.$state, payload);
        }
    },

    persist: true
});
