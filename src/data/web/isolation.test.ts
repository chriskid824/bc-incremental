/**
 * The M1 web and the v3 webs stay apart (docs/v3 C6 design D1). The M1 web is
 * loadGameData().talents; v3 content loads through src/data/web, which src/data/index.ts does
 * not re-export. The v3 web's modules are src/data/web and the content it assembles:
 * src/data/templates.ts, src/data/hub.ts, src/data/characters/, src/data/outer/ and
 * src/data/fusion/. The M1 web's consumers (its prices and stat block, the session, every balance
 * tool) import none of them, so they keep running on the M1 web, and none of them imports the M1
 * web or its loader. The guard reads each listed module's own import specifiers (direct imports,
 * type-only and dynamic ones included), not what they load in turn: tools/content, which loads v3
 * content for the snapshots, the fuzz and calibration, is not listed.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '..';
import { TALENTS } from '../talents';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB = 'src/data/web';

/** The v3 web's directories and files, src/data/web's content blocks among them (C6.5). */
const V3_DIRS = [WEB, 'src/data/characters', 'src/data/outer', 'src/data/fusion'];
const V3_FILES = ['src/data/templates', 'src/data/hub'];

/** The M1 web's consumers D1 names, and src/data/index.ts, which loads the M1 web. */
const M1_MODULES = [
  'src/meta/talents.ts',
  'src/meta/stats.ts',
  'src/app/session.ts',
  'src/data/index.ts',
];

/** What no module under src/data/web may import: the M1 web and its loader, src/data/index.ts. */
const M1_WEB = ['src/data/talents', 'src/data', 'src/data/index'];

/** The files under `dir` (relative to the repo root) whose names match `pattern`, sorted. */
function filesUnder(dir: string, pattern: RegExp): string[] {
  return readdirSync(resolve(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .map((path) => posix.join(dir, path.replaceAll('\\', '/')))
    .filter((path) => pattern.test(path))
    .sort();
}

/**
 * Comments blanked out: block comments, and line comments that start a line or follow a space,
 * as Prettier writes a trailing one (`import { a, // why`).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const IMPORT_FROM = /^\s*import\s+(?:type\s+)?[\w$*{},\s]+?\s+from\s+(['"])([^'"]+)\1/gm;
const EXPORT_FROM =
  /^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[\w$,\s]*\})\s+from\s+(['"])([^'"]+)\1/gm;
const BARE_IMPORT = /^\s*import\s+(['"])([^'"]+)\1/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g;

/** Every specifier `source` imports or re-exports from: type-only, bare and dynamic ones too. */
function specifiers(source: string): string[] {
  const code = stripComments(source);
  return [IMPORT_FROM, EXPORT_FROM, BARE_IMPORT, DYNAMIC_IMPORT].flatMap((pattern) =>
    [...code.matchAll(pattern)].map((match) => match[2] as string),
  );
}

/**
 * The repo path, without extension or query, that `specifier` names from `file`: relative to
 * `file`, or to the repo root for a '/'-rooted one; null for a package.
 */
function target(file: string, specifier: string): string | null {
  const path = specifier.split('?')[0] as string;
  if (path.startsWith('/')) return posix.normalize(path.slice(1)).replace(/\.(ts|js)$/, '');
  if (!path.startsWith('.')) return null;
  const absolute = resolve(ROOT, dirname(file), path);
  return relative(ROOT, absolute)
    .replaceAll('\\', '/')
    .replace(/\.(ts|js)$/, '');
}

/** The import targets of `file` (relative to the repo root) that `matches` picks. */
function importsOf(file: string, matches: (path: string) => boolean): string[] {
  const source = readFileSync(resolve(ROOT, file), 'utf8');
  return specifiers(source).filter((specifier) => {
    const path = target(file, specifier);
    return path !== null && matches(path);
  });
}

const inWeb = (path: string): boolean =>
  V3_FILES.includes(path) || V3_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
const isM1Web = (path: string): boolean => M1_WEB.includes(path);

/**
 * Code that reads a `talents` property: `.talents`, `?.talents`, `['talents']`, or a destructuring
 * that names it (`const { talents } = data`, `({ talents }: GameData)`, `({ talents }) =>`). An
 * object type or literal with a `talents` key that `=`, `:` or `) =>` follows matches too.
 */
const READS_TALENTS =
  /\.talents\b|\[\s*(['"])talents\1\s*\]|\{[^{}]*\btalents\b[^{}]*\}\s*(?:=(?![=>])|:|\)\s*=>)/;

describe('web isolation (D1)', () => {
  const balanceTools = filesUnder('tools/balance', /\.(ts|mjs)$/);
  const webModules = [
    ...V3_DIRS.flatMap((dir) => filesUnder(dir, /\.ts$/)),
    ...V3_FILES.map((file) => `${file}.ts`),
  ].filter((path) => !path.endsWith('.test.ts'));
  const simModules = filesUnder('src/sim', /\.ts$/).filter((path) => !path.endsWith('.test.ts'));

  it('keeps the M1 web in loadGameData().talents', () => {
    expect(loadGameData().talents.map((node) => node.id)).toEqual(TALENTS.map((node) => node.id));
  });

  it('guards every balance tool and the modules D1 names', () => {
    expect(balanceTools).toEqual(
      expect.arrayContaining([
        'tools/balance/cli.ts',
        'tools/balance/session.ts',
        'tools/balance/strategies.ts',
        'tools/balance/fingerprint.ts',
        'tools/balance/hivePreset.ts',
        'tools/balance/worker-boot.mjs',
        'tools/balance/estimates.test.ts',
      ]),
    );
    expect(M1_MODULES).toEqual(
      expect.arrayContaining(['src/meta/talents.ts', 'src/meta/stats.ts', 'src/app/session.ts']),
    );
    expect(webModules).toEqual(
      expect.arrayContaining([
        'src/data/web/ids.ts',
        'src/data/web/index.ts',
        'src/data/templates.ts',
        'src/data/hub.ts',
        'src/data/characters/fire.ts',
        'src/data/outer/index.ts',
        'src/data/fusion/generate.ts',
      ]),
    );
    expect(simModules).toEqual(
      expect.arrayContaining(['src/sim/simulation.ts', 'src/sim/build/compile.ts']),
    );
  });

  it.each([...M1_MODULES, ...balanceTools])('%s imports no module of the v3 web', (file) => {
    expect(importsOf(file, inWeb)).toEqual([]);
  });

  it('the v3 web imports neither the M1 web nor src/data/index.ts', () => {
    for (const file of webModules) expect(importsOf(file, isM1Web), file).toEqual([]);
  });

  it('nothing under src/sim reads .talents', () => {
    for (const file of simModules) {
      const code = stripComments(readFileSync(resolve(ROOT, file), 'utf8'));
      expect(READS_TALENTS.test(code), file).toBe(false);
    }
  });

  it('reads every form of import, and no comment', () => {
    const source = [
      "import { a } from '../data/web/a';",
      "import type { B } from '../data/web/b';",
      'import {',
      '  c,',
      '  type C,',
      "} from '../data/web/c';",
      "import * as d from '../data/web';",
      "export { e } from '../data/web/e';",
      "export type { F } from '../data/web/f';",
      "export * from '../data/web/g';",
      "import '../data/web/h';",
      "const i = await import('../data/web/i');",
      "import j from '../data/web/j.ts';",
      "import k from '/src/data/web/k';",
      "import l from '../data/web/snapshots/ids.txt?raw';",
      "import { m } from '../data/webby';",
      "import { CHARACTERS } from '../data/characters';",
      "import { FIRE } from '../data/characters/fire';",
      "import type { OuterDef } from '../data/outer/index.ts';",
      "import { HUB } from '../data/hub';",
      "import { generateFusion } from '../data/fusion/generate';",
      "import { center } from '../data/templates.ts';",
      "import { s } from '../data/hubby';",
      "import { t } from '../data/templates-old';",
      "import { z } from 'zod';",
      "// import { n } from '../data/web/n';",
      "/* import { o } from '../data/web/o'; */",
      'import {',
      '  p, // a trailing comment',
      '  type P, // and another',
      "} from '../data/web/p';",
      "const q = 1; // const r = await import('../data/web/q');",
    ].join('\n');
    const found = specifiers(source).filter((specifier) => {
      const path = target('src/app/x.ts', specifier);
      return path !== null && inWeb(path);
    });
    expect(found.sort()).toEqual(
      [
        '../data/web/a',
        '../data/web/b',
        '../data/web/c',
        '../data/web',
        '../data/web/e',
        '../data/web/f',
        '../data/web/g',
        '../data/web/h',
        '../data/web/i',
        '../data/web/j.ts',
        '/src/data/web/k',
        '../data/web/snapshots/ids.txt?raw',
        '../data/web/p',
        '../data/characters',
        '../data/characters/fire',
        '../data/outer/index.ts',
        '../data/hub',
        '../data/fusion/generate',
        '../data/templates.ts',
      ].sort(),
    );
    expect(
      ['../talents', '..', '../index', '../index.ts', '../schema'].map((s) =>
        isM1Web(target('src/data/web/x.ts', s) ?? ''),
      ),
    ).toEqual([true, true, true, true, false]);
  });

  it('reads .talents however it is written, and not in a comment', () => {
    for (const code of [
      'data.talents',
      'data?.talents.length',
      "data['talents']",
      'data["talents"]',
      'const { talents } = data;',
      'const { enemies, talents: list } = loadGameData();',
      'const {\n  enemies,\n  talents,\n} = data;',
      'function count({ talents }: GameData): number {',
      'datas.map(({ talents }) => talents.length);',
    ]) {
      expect(READS_TALENTS.test(stripComments(code)), code).toBe(true);
    }
    for (const code of [
      '// data.talents',
      '/* data.talents */',
      'count(); // data.talents',
      'talents: []',
      'data.talentsOwned',
      'return { enemies, waves: { ...TEST_WAVES, ...overrides.waves }, talents: [] };',
      'const empty = () => ({ enemies: [], talents: [] });',
      'type Data = { readonly talents: readonly string[] };',
      'const same = { talents } === other;',
    ]) {
      expect(READS_TALENTS.test(stripComments(code)), code).toBe(false);
    }
  });
});
