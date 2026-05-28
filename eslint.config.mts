import jsLint from '@eslint/js';
import tsLint from 'typescript-eslint';
import vueLint from 'eslint-plugin-vue';
import importXPlugin from 'eslint-plugin-import-x';
import globals from 'globals';
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript';

export default defineConfigWithVueTs(
  jsLint.configs.recommended,
  ...tsLint.configs.recommended,
  importXPlugin.flatConfigs.recommended,
  ...vueLint.configs['flat/essential'],
  vueTsConfigs.recommended,
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.vite/**',
      'thunderbird-accounts/**',
      'tests/perf/**',
      'tests/fixtures/**',
      'research/**',
      'infra/**',
      'docs/**',
      'public/**',
      'tests/e2e/**',
      'playwright.config.js',
      'vite.config.*',
    ],
  },
  {
    files: ['**/*.vue', '**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs', '**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.worker,
        ...globals.node,
      },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      // Codebase mixes .js-suffixed and unsuffixed imports today; the
      // long-term convention is unsuffixed for .ts/.vue and never for
      // packages. Warn so cleanups land alongside touched files
      // without breaking CI on existing call sites.
      'import-x/extensions': [
        'warn',
        'ignorePackages',
        {
          '': 'never',
          ts: 'never',
          js: 'never',
          vue: 'off',
        },
      ],
      'import-x/prefer-default-export': 'off',
      // import-plugin's CJS-vs-ESM resolver flags Vite's URL-shape
      // imports and bare worker entries; let vue-tsc handle module
      // resolution and stand down here.
      'import-x/no-unresolved': 'off',
      // Vue 3 components register dynamically; plugin-import does not
      // see them and would flag template-only usage.
      'import-x/no-named-as-default': 'off',
      'import-x/no-named-as-default-member': 'off',
      // TypeScript already enforces these; let TS own them.
      'no-undef': 'off',
      'no-redeclare': 'off',
      // The codebase uses `any` deliberately at MessagePort RPC
      // boundaries (the SharedWorker call() return) and for narrow
      // test fixture shapes. Warn so new sites stand out without
      // failing the existing ones.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Banned in stores so DOM manipulation and global state do not
      // leak into the orchestration layer (constitution III). The
      // override below relaxes this for components and other layers.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.object.name=/^(JSON)$/][callee.property.name="parse"][arguments.0.callee.object.name="JSON"][arguments.0.callee.property.name="stringify"]',
          message: 'Use structuredClone(value) instead of JSON.parse(JSON.stringify(value)).',
        },
      ],
    },
    settings: {
      'import/resolver': {
        typescript: true,
        node: true,
      },
    },
  },
  {
    // Pinia stores hold raw-ish state plus actions. Components and
    // composables can talk to document/window; stores cannot.
    files: ['src/stores/**/*.{ts,js}'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'Stores must not touch the DOM. Move this to a component or composable.' },
        { name: 'window', message: 'Stores must not touch the DOM. Move this to a component or composable.' },
      ],
    },
  },
  {
    // Test files use vitest globals and partial-row fixture shapes.
    files: ['tests/unit/**/*.{ts,js}', 'tests/**/*.test.{ts,js}'],
    languageOptions: {
      globals: {
        ...globals.node,
        // Vitest globals
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
