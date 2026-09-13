// @ts-check
import path from 'path'
import { fileURLToPath } from 'url'

import prettier from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'
import obsidianmd from 'eslint-plugin-obsidianmd'
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * ESLint 9 flat config.
 *
 * obsidianmd/recommended already bundles:
 *   - @eslint/js recommended
 *   - typescript-eslint recommendedTypeChecked (for .ts/.tsx)
 *   - eslint-plugin-import
 *   - @microsoft/eslint-plugin-sdl
 *   - All obsidianmd rules (no-unsupported-api, prefer-destructive-button, etc.)
 *
 * We wrap everything in tseslint.config() so it can process the `extends` keys
 * that eslint-plugin-obsidianmd uses internally.
 */
export default tseslint.config(
  // ── Ignored paths ────────────────────────────────────────────────────────
  {
    ignores: [
      'main.js',
      'node_modules/',
      'dist/',
      'coverage/',
      '.nyc_output/',
      '.obsidian/',
      '.claude/',
      '**/*.log',
      '**/*.log*',
      // Build/config scripts that are not part of the TS project
      'esbuild.config.mjs',
      'jest.config.js',
      'version-bump.mjs',
      'compile-migration.js',
      'import-meta-url-shim.js',
      // Data files
      'versions.json',
      'package.json',
      'manifest.json',
      '**/*.md',
    ],
  },

  // ── obsidianmd recommended (flat config, iterable) ───────────────────────
  ...obsidianmd.configs.recommended,

  // ── React hooks ──────────────────────────────────────────────────────────
  reactHooks.configs['recommended-latest'],

  // ── Prettier (must come after all style rules) ───────────────────────────
  prettier,

  // ── Project-wide settings (globals, import ordering) ─────────────────────
  {
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      // ── Import ordering ──────────────────────────────────────────────────
      'import/no-unresolved': 'off',
      'sort-imports': [
        'error',
        {
          ignoreCase: false,
          ignoreDeclarationSort: true,
          ignoreMemberSort: false,
          memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
          allowSeparatedGroups: true,
        },
      ],
      'import/order': [
        'error',
        {
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
    },
  },

  // ── TypeScript-specific overrides (type-aware rules) ─────────────────────
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // TypeScript handles undefined-variable checking better than ESLint
      'no-undef': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/consistent-type-definitions': ['warn', 'type'],
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-useless-constructor': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Keep unsafe-* as warn (matches Obsidian bot severity)
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Extend default brands with project-specific names so sentence-case allows them
      'obsidianmd/ui/sentence-case': [
        'error',
        {
          enforceCamelCaseLower: true,
          brands: [
            ...DEFAULT_BRANDS,
            'LightRAG',
            'Neural Composer',
            'NeuralComposer',
            'Codex CLI',
          ],
        },
      ],
    },
  },
  {
    // This desktop-only CLI boundary uses erased Node types and a guarded
    // runtime loader. Its subprocess tests run in Jest's Node environment.
    files: [
      'src/core/llm/codexCliProvider.ts',
      'src/core/llm/codexCliProvider.test.ts',
    ],
    rules: {
      'import/no-nodejs-modules': [
        'error',
        {
          allow: [
            'child_process',
            'events',
            'fs',
            'fs/promises',
            'os',
            'path',
            'readline',
            'stream',
          ],
        },
      ],
    },
  },
)
