/**
 * The boundary of the pure directories (eslint.config.js, CLAUDE.md): probe sources are linted
 * as if they lived there, so a loosened rule fails here instead of letting impure code in.
 */

import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('..', import.meta.url)) });

/** Rule ids of the restriction errors the source gets at `filePath`. */
async function restrictions(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? []).flatMap((message) =>
    message.ruleId?.startsWith('no-restricted-') === true ? [message.ruleId] : [],
  );
}

const PURE_DIRS = ['src/core', 'src/data', 'src/sim', 'src/meta', 'src/save'];

const REJECTED: readonly (readonly [string, string])[] = [
  ['renderer directory', "import { Renderer } from '../render';"],
  ['renderer index', "import { Renderer } from '../render/index';"],
  ['renderer module', "import { Renderer } from '../render/renderer';"],
  ['ui directory, type only', "import type { Hud } from '../ui';"],
  ['platform directory re-export', "export * from '../platform';"],
  ['app module', "export { main } from '../app/main';"],
  ['pixi.js', "import { Graphics } from 'pixi.js';"],
  ['dynamic pixi.js', "export const load = () => import('pixi.js');"],
  ['dynamic import', "export const load = () => import('./other');"],
  ['bare Node builtin', "import { readFileSync } from 'fs';"],
  ['bare Node builtin subpath', "import { readFile } from 'fs/promises';"],
  ['bare Node crypto', "import { randomBytes } from 'crypto';"],
  ['bare worker_threads', "import { Worker } from 'worker_threads';"],
  ['node: builtin', "import { randomBytes } from 'node:crypto';"],
  ['new Date()', 'export const at = new Date();'],
  ['Date()', 'export const at = Date();'],
  ['Date.now()', 'export const at = Date.now();'],
  ['performance.now()', 'export const at = performance.now();'],
  ['Math.random()', 'export const roll = Math.random();'],
  ['DOM', 'export const title = document.title;'],
];

const ALLOWED: readonly (readonly [string, string])[] = [
  ['pure modules', "import { num } from '../core/num';\nexport const one = num(1);"],
  ['zod', "import { z } from 'zod';\nexport const schema = z.number();"],
  ['a given timestamp', 'export const iso = (ms: number) => new Date(ms).toISOString();'],
];

// The first lint loads the TypeScript parser, which can take a few seconds on a cold CI runner.
describe('pure directory lint boundary', { timeout: 30_000 }, () => {
  it.each(REJECTED)('rejects %s', async (_name, source) => {
    for (const dir of PURE_DIRS) {
      const errors = await restrictions(source, `${dir}/probe.ts`);
      expect(errors, `${dir}: ${source}`).not.toHaveLength(0);
    }
  });

  it.each(ALLOWED)('allows %s', async (_name, source) => {
    for (const dir of PURE_DIRS) {
      expect(await restrictions(source, `${dir}/probe.ts`), dir).toEqual([]);
    }
  });

  it('applies only to the pure directories and not to their tests', async () => {
    const source = "import { Graphics } from 'pixi.js';\nexport const at = new Date();";
    expect(await restrictions(source, 'src/render/probe.ts')).toEqual([]);
    expect(await restrictions(source, 'src/sim/probe.test.ts')).toEqual([]);
    expect(await restrictions(source, 'src/sim/probe.ts')).toHaveLength(2);
  });
});
