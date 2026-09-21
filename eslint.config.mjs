// Audit T1-13: lint gate for the Vue/TypeScript tree. Runs in CI and from the
// lefthook pre-commit hook. Rules start conservative — correctness and
// security-relevant checks are errors, stylistic ones are off — so the gate
// can be enabled on an existing codebase without a mass rewrite.
import pluginVue from 'eslint-plugin-vue'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

export default defineConfigWithVueTs(
  {
    name: 'app/files-to-lint',
    files: ['**/*.{ts,mts,tsx,vue}'],
  },
  {
    name: 'app/files-to-ignore',
    ignores: [
      '**/dist/**',
      '**/dist-ssr/**',
      '**/coverage/**',
      '**/node_modules/**',
      'src-tauri/**',
      'public/**',
      'src/assets/templates/**',
      // Fragments of the CG advisory template, not modules: they are
      // concatenated into one classic <script> scope by
      // scripts/build-advisory.mjs, so every cross-part reference reads as an
      // undefined global and every handler as an unused function. The template's
      // own guard tests cover it (advisoryBuild, advisoryOnAir, templatesParity).
      'templates-src/**',
    ],
  },
  pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  skipFormatting,
  {
    name: 'app/rules',
    rules: {
      // Operator-safety and correctness: keep as errors.
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'vue/no-v-html': 'error',
      'vue/no-v-text-v-html-on-component': 'error',
      'vue/multi-word-component-names': 'off',
      // Pre-existing patterns; tighten these over time.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      'no-case-declarations': 'warn',
      'vue/no-mutating-props': 'warn',
      'vue/no-unused-vars': 'warn',
      'vue/require-v-for-key': 'warn',
      'vue/valid-v-for': 'warn',
      'vue/no-side-effects-in-computed-properties': 'warn',
    },
  },
  {
    // The one place `v-html` is allowed. AppIcon interpolates a value from the
    // frozen ICONS map in src/components/ui/icons.ts: a compile-time constant,
    // never a store value, a file path, an Ingestor response, or anything else
    // an operator or the network can influence. Serving the glyphs as a runtime
    // sprite instead would add a fetch and a CSP surface to a broadcast control
    // surface for no security gain.
    name: 'app/icon-primitive',
    files: ['src/components/ui/AppIcon.vue'],
    rules: {
      'vue/no-v-html': 'off',
    },
  },
)
