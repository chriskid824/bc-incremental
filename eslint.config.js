import { builtinModules } from 'node:module';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Directories that must stay pure, deterministic TypeScript (see docs/ARCHITECTURE.md §2).
// tests/purity-lint.test.ts checks that these rules keep rejecting what they should.
const PURE_DIRS = ['src/core/**', 'src/data/**', 'src/sim/**', 'src/meta/**', 'src/save/**'];
const NODE_MESSAGE = 'Pure modules must not import Node APIs.';
const CLOCK_MESSAGE =
  'Pure modules must not read the wall clock; time comes from ticks or the caller.';

export default tseslint.config(
  { ignores: ['dist', 'dist-steam', 'out', 'coverage', 'node_modules', '.claude'] },
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
          // Bare builtins ('fs', 'crypto', ...); 'node:*' is a pattern below.
          paths: builtinModules.map((name) => ({ name, message: NODE_MESSAGE })),
          patterns: [
            {
              group: ['pixi.js', 'pixi.js/*', '@pixi/*'],
              message: 'Pure modules must not depend on the renderer.',
            },
            {
              // The directory itself ('../render', i.e. its index) as well as anything in it.
              regex: '(^|/)(render|ui|platform|app)(/|$)',
              message: 'Pure modules must not import render, ui, platform, or app.',
            },
            { group: ['node:*'], message: NODE_MESSAGE },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'Pure modules must not load modules at run time.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: CLOCK_MESSAGE,
        },
        { selector: "CallExpression[callee.name='Date']", message: CLOCK_MESSAGE },
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
