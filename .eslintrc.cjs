module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  ignorePatterns: ['dist', 'node_modules', 'coverage', '.eslintrc.cjs', 'eslint-rules'],
  rules: {
    // Loaded via --rulesdir eslint-rules in the lint script.
    // Ratcheted to 'error' — test fixtures are excluded via file-level
    // eslint-disable comment in translationHelper.test.ts.
    'no-missing-i18n-key': 'error',
  },
};
