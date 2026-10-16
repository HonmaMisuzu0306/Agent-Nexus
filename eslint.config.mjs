import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['node_modules/**', 'out/**', 'release/**', '.runtime/**', 'test-results/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly', window: 'readonly', document: 'readonly', innerWidth: 'readonly', getComputedStyle: 'readonly', fetch: 'readonly' } } }
);
