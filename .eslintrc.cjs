module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['react-hooks', '@typescript-eslint'],
  extends: ['eslint:recommended'],
  ignorePatterns: ['dist', 'node_modules', 'coverage', '.eslintrc.cjs', 'eslint-rules'],
  rules: {
    // Loaded via --rulesdir eslint-rules in the lint script.
    // Ratcheted to 'error' — test fixtures are excluded via file-level
    // eslint-disable comment in translationHelper.test.ts.
    'no-missing-i18n-key': 'error',
    // Inline eslint-disable comments throughout the codebase reference this
    // rule; plugin must be registered to avoid "rule not found" errors.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    // tsc owns undefined-variable detection for TS (ambient types, CSS
    // modules, import.meta.env) — no-undef on .ts/.tsx is a false-positive
    // machine, so the base rule is off and the TS-aware unused-vars rule
    // takes over. Backend overrides re-enable no-undef for plain JS.
    'no-undef': 'off',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      // Serverless functions + shared lib: CommonJS on Node. The browser
      // env from the base config is revoked here so an accidental DOM
      // reference in API code fails lint instead of silently shipping.
      files: ['api/**/*.js', 'lib/**/*.js', 'server.js'],
      env: { browser: false, node: true, es2022: true },
      parserOptions: { sourceType: 'commonjs' },
      rules: {
        'no-undef': 'error',
        '@typescript-eslint/no-unused-vars': 'off',
        'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      },
    },
    {
      // Vitest transpiles these regardless of the package's CJS default,
      // and two suites use top-level `await import(...)` — parse as ESM
      // and declare the runner globals the suites use bare.
      files: ['api/**/__tests__/**/*.js', 'lib/**/__tests__/**/*.js'],
      parserOptions: { sourceType: 'module' },
      globals: {
        describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly', beforeAll: 'readonly', afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    {
      files: ['scripts/**/*.mjs'],
      env: { node: true, es2022: true },
      parserOptions: { sourceType: 'module' },
    },
  ],
};
