import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // Fixtures are web pages for the browser tests, not part of the code.
  { ignores: ['node_modules/', 'coverage/', 'src/server/ui.html', 'test/fixtures/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Unused names are errors, except the deliberate `_` placeholder.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Empty catch blocks here are always commented "best effort" cleanups.
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Injected into the page and run there, not in Node.
    files: ['src/observe/page-serializer.js', 'src/observe/indicator-page.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    // Runs in Chrome as the extension's service worker and popup, not in Node.
    files: ['extension/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions },
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Fakes cast freely to stand in for real collaborators.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
