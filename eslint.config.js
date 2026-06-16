import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';

export default tseslint.config(
  { ignores: ['**/dist/', '**/node_modules/', 'data/', '.claude/', '.agents/', 'site/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // SonarJS: mirrors the SonarCloud quality profile locally so the same smells
  // (cognitive complexity, nested ternaries/templates, redundant casts, …) fail
  // `pnpm lint` instead of only surfacing after a cloud scan.
  sonarjs.configs.recommended,
  {
    plugins: { unicorn },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Curated rules matched 1:1 to flagged SonarCloud findings (not unicorn's
      // full opinionated set — only the modernizers Sonar already flags).
      // Note: S3735 ("void") is covered by sonarjs/void-use; the core no-void
      // rule is intentionally NOT enabled — it over-flags idiomatic React
      // `() => void asyncFn()` fire-and-forget handlers that Sonar accepts.
      'unicorn/prefer-global-this': 'error', // S7764
      'unicorn/prefer-string-replace-all': 'error', // S7781
      'unicorn/prefer-string-raw': 'error', // S7780
      'unicorn/prefer-dom-node-dataset': 'error', // S7761
      'unicorn/no-useless-spread': 'error', // S7747
      'unicorn/prefer-top-level-await': 'error', // S7785
      'unicorn/no-negated-condition': 'error', // S7735
      'unicorn/prefer-code-point': 'error', // S7758
    },
  },
  {
    // apps/ui runs in the browser (React + Vite); everything else is Node.
    files: ['apps/ui/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Test fixtures legitimately point at internal/mock services over http://
    // (e.g. a private SearXNG instance). Test code never ships, so the
    // clear-text-protocol check does not apply to it.
    files: ['**/*.test.ts'],
    rules: {
      'sonarjs/no-clear-text-protocols': 'off',
    },
  },
);
