import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'

// Vitest shares the Vite `@` alias. Tests live under `src/**/__tests__/*` —
// the same directories tsconfig.app.json excludes from the vue-tsc build.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
