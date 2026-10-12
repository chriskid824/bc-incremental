import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Directories that must stay pure, deterministic TypeScript (see docs/ARCHITECTURE.md §2).
const PURE_DIRS = ['src/core/**', 'src/data/**', 'src/sim/**', 'src/meta/**', 'src/save/**'];

export default tseslint.config(
  { ignores: ['dist', 'out', 'coverage', 'node_modules', '.claude'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: PURE_DIRS,
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pixi.js', 'pixi.js/*', '@pixi/*'],
              message: 'Pure modules must not depend on the renderer.',
            },
            {
              group: ['**/render/**', '**/ui/**', '**/platform/**', '**/app/**', 'node:*'],
              message: 'Pure modules must not import render, ui, platform, app, or Node APIs.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded RNG from src/core/rng.ts.' },
        { object: 'Date', property: 'now', message: 'Simulation time comes from ticks.' },
        { object: 'performance', property: 'now', message: 'Simulation time comes from ticks.' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Pure modules must not touch the DOM.' },
        { name: 'document', message: 'Pure modules must not touch the DOM.' },
        { name: 'setTimeout', message: 'Simulation time comes from ticks.' },
        { name: 'setInterval', message: 'Simulation time comes from ticks.' },
      ],
    },
  },
);
