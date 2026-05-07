/**
 * ESLint 9 flat config (P38). One block per surface:
 *   - src/** + vitest.setup.ts: browser TS/TSX; tsc owns no-undef.
 *   - api/**, lib/**, server.js: CommonJS on Node; no-undef ON.
 *   - api|lib __tests__: vitest transpiles + bare runner globals.
 *   - scripts/*.mjs: ESM on Node.
 * The local no-missing-i18n-key rule loads as the `local` plugin —
 * ESLint 9 removed --rulesdir.
 */
const js = require('@eslint/js');
const globals = require('globals');
const reactHooks = require('eslint-plugin-react-hooks');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const localRules = require('./eslint-rules');

const tsUnusedVars = ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' }];
const jsUnusedVars = tsUnusedVars;
const vitestGlobals = {
  describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly',
  beforeEach: 'readonly', afterEach: 'readonly', beforeAll: 'readonly', afterAll: 'readonly',
  vi: 'readonly',
};

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint-rules/**'] },
  {
    // Base for every surface: the recommended set plus the local rule and
    // the two react-hooks rules, exactly like the legacy top-level rules.
    plugins: {
      local: localRules,
      'react-hooks': reactHooks,
    },
    rules: {
      'local/no-missing-i18n-key': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    ...js.configs.recommended,
    rules: {
      ...js.configs.recommended.rules,
      // tsc owns undefined-variable detection for TS (ambient types, CSS
      // modules, import.meta.env) — no-undef on .ts/.tsx is a false-positive
      // machine. The TS-aware unused-vars rule takes over; backend blocks
      // re-enable the base pair for plain JS.
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'vitest.setup.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': tsUnusedVars,
    },
  },
  {
    // Serverless functions + shared lib: CommonJS on Node. The browser env
    // from the frontend block does not reach here (files-keyed blocks do
    // not overlap), and no-undef stays armed so an accidental DOM reference
    // in API code fails lint instead of silently shipping.
    files: ['api/**/*.js', 'lib/**/*.js', 'server.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': jsUnusedVars,
    },
  },
  {
    // Vitest transpiles these regardless of the package's CJS default, and
    // two suites use top-level `await import(...)` — parse as ESM.
    files: ['api/**/__tests__/**/*.js', 'lib/**/__tests__/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...vitestGlobals },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
