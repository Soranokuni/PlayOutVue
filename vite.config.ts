import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    vue(),
    // Dev-server only (the plugin is `apply: 'serve'` internally); gated here
    // so the intent is explicit.
    ...(command === 'serve' ? [vueDevTools()] : []),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  // PERF F-15: the only runtime is Tauri's WebView2 (evergreen Chromium), so
  // target a modern engine instead of the generic baseline, and split the
  // stable vendor code from the app code so a UI-only change does not
  // re-parse Vue/Pinia. Compile-time Vue flags drop the Options API shim and
  // the prod devtools hook; the codebase is 100% `<script setup>`.
  build: {
    target: 'chrome120',
    cssCodeSplit: true,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        // Vite 8 bundles with rolldown, whose native chunking API is
        // `advancedChunks` (the `manualChunks` shim regroups on its own).
        // First matching group wins.
        advancedChunks: {
          groups: [
            { name: 'vue', test: /[\\/]node_modules[\\/](@vue|vue|pinia|pinia-plugin-persistedstate)[\\/]/ },
            { name: 'vendor', test: /[\\/]node_modules[\\/]/ },
          ],
        },
      },
    },
  },
  define: {
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
}))
