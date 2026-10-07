const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

// Node globals used by the CommonJS config/utility files in this package.
// Declared by hand so the config stays self-contained.
const nodeGlobals = {
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  module: 'readonly',
  process: 'readonly',
  require: 'readonly',
};

module.exports = tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      globals: nodeGlobals,
    },
    rules: {
      // CommonJS config files load their dependencies with require().
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
);
