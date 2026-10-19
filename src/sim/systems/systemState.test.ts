/**
 * The leaf guard (docs/v3 C4 design §0.7). systemState.ts holds the ctx.sys factories that
 * createRunContext calls while systems/context.ts is still loading, so nothing it loads may
 * reach context.ts or close a cycle: its value imports are only the modules in LEAF_IMPORTS, and
 * every other import is an `import type` declaration. This test reads systemState.ts and every
 * module it value-imports, transitively, and checks that. A declaration is type-only only when
 * the whole of it is `import type …` or `export type … from`: under verbatimModuleSyntax,
 * `import { type X } from './m'` still loads './m', so it counts as a value edge.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** src/, which the module names below are relative to. */
const SRC = fileURLToPath(new URL('../../', import.meta.url));
const LEAF = 'sim/systems/systemState.ts';
const CONTEXT = 'sim/systems/context.ts';

/**
 * The modules systemState.ts may value-import (§0.7's exhaustive list: C4.6's four, and from
 * C4.14 systems/grid.ts, for the segment endpoints' grid, with the two modules it imports).
 */
const LEAF_IMPORTS = [
  'core/num.ts',
  'sim/caps.ts',
  'sim/build/sources.ts',
  'sim/build/eval.ts',
  'sim/systems/grid.ts',
  'sim/grid.ts',
  'sim/types.ts',
];

const REMAINING = 'sim/ailments/remaining.ts';

/**
 * The modules remaining.ts may value-import: §0.7's C4.10 entry, and effects/flags.ts for the
 * kill kinds bleedRemaining reads (Hoshi's Q7/F1), already in its closure through apply.ts and
 * eval.ts.
 */
const REMAINING_IMPORTS = [
  'core/num.ts',
  'sim/types.ts',
  'sim/ailments/bleed.ts',
  'sim/ailments/frost.ts',
  'sim/ailments/rings.ts',
  'sim/ailments/records.ts',
  'sim/ailments/apply.ts',
  'sim/effects/flags.ts',
];

/** The only modules that may value-import remaining.ts (§0.7's C4.10 entry). */
const REMAINING_IMPORTERS = ['sim/effects/dispatch.ts', 'sim/effects/execute.ts'];

/** One import or re-export declaration of a module: its specifier, and whether it loads it. */
interface ImportDecl {
  readonly from: string;
  readonly typeOnly: boolean;
}

/** Block comments, and line comments that take a whole line, blanked out. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
}

const IMPORT_FROM = /^\s*import\s+(type\s+)?[\w$*{},\s]+?\s+from\s+(['"])([^'"]+)\2/gm;
const EXPORT_FROM =
  /^\s*export\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[\w$,\s]*\})\s+from\s+(['"])([^'"]+)\2/gm;
const BARE_IMPORT = /^\s*import\s+(['"])([^'"]+)\1/gm;

/** The import and re-export declarations of `source`, in no particular order. */
function importsOf(source: string): ImportDecl[] {
  const code = stripComments(source);
  const decls: ImportDecl[] = [];
  for (const m of code.matchAll(IMPORT_FROM)) {
    decls.push({ from: m[3] as string, typeOnly: m[1] !== undefined });
  }
  for (const m of code.matchAll(EXPORT_FROM)) {
    decls.push({ from: m[3] as string, typeOnly: m[1] !== undefined });
  }
  for (const m of code.matchAll(BARE_IMPORT)) decls.push({ from: m[2] as string, typeOnly: false });
  return decls;
}

/** The module `from` names in `module` (relative to SRC), or null for a package. */
function resolveImport(module: string, from: string): string | null {
  if (!from.startsWith('.')) return null;
  const base = resolve(SRC, dirname(module), from);
  const candidates = [base, `${base}.ts`, resolve(base, 'index.ts')];
  const file = candidates.find((path) => existsSync(path) && statSync(path).isFile());
  if (file === undefined) throw new Error(`${module}: cannot resolve '${from}'`);
  return relative(SRC, file).replaceAll('\\', '/');
}

/** The modules `module` value-imports, relative to SRC; packages left out. */
function valueImports(module: string): string[] {
  const source = readFileSync(resolve(SRC, module), 'utf8');
  return importsOf(source)
    .filter((decl) => !decl.typeOnly)
    .flatMap((decl) => resolveImport(module, decl.from) ?? []);
}

/** The value-import graph reachable from `root`, `root` itself included. */
function closure(root: string): Map<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>();
  const pending = [root];
  for (let module = pending.pop(); module !== undefined; module = pending.pop()) {
    if (graph.has(module)) continue;
    const edges = valueImports(module);
    graph.set(module, edges);
    pending.push(...edges);
  }
  return graph;
}

/** The modules `module` loads through one value import or more. */
function reachedFrom(module: string): Set<string> {
  return new Set(valueImports(module).flatMap((next) => [...closure(next).keys()]));
}

/** A cycle of `graph` as the path that closes it, or null for none. */
function findCycle(graph: Map<string, readonly string[]>): string[] | null {
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (module: string): string[] | null => {
    const at = path.indexOf(module);
    if (at >= 0) return [...path.slice(at), module];
    if (done.has(module)) return null;
    path.push(module);
    for (const next of graph.get(module) ?? []) {
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    path.pop();
    done.add(module);
    return null;
  };
  for (const module of graph.keys()) {
    const cycle = visit(module);
    if (cycle !== null) return cycle;
  }
  return null;
}

describe('the import reader', () => {
  it('tells type-only declarations from the ones that load a module', () => {
    const source = [
      '/** import { a } from "./inComment"; */',
      "// import { b } from './inLineComment';",
      "import type { A } from './typeOnly';",
      "import { type B } from './inlineType';",
      "import { c, type C } from './mixed';",
      'import {',
      '  d,',
      '  e as f,',
      "} from './multiLine';",
      "import * as g from './namespace';",
      "import h from './default';",
      "import './bare';",
      "export type { I } from './reexportType';",
      "export { j } from './reexport';",
      "export * from './star';",
      "export const k = 'from ./notAnImport';",
    ].join('\n');
    const decls = importsOf(source).sort((a, b) => a.from.localeCompare(b.from));
    expect(decls).toEqual([
      { from: './bare', typeOnly: false },
      { from: './default', typeOnly: false },
      { from: './inlineType', typeOnly: false },
      { from: './mixed', typeOnly: false },
      { from: './multiLine', typeOnly: false },
      { from: './namespace', typeOnly: false },
      { from: './reexport', typeOnly: false },
      { from: './reexportType', typeOnly: true },
      { from: './star', typeOnly: false },
      { from: './typeOnly', typeOnly: true },
    ]);
  });

  it('finds a cycle, and none in a tree', () => {
    const tree = new Map([
      ['a', ['b', 'c']],
      ['b', ['c']],
      ['c', []],
    ]);
    expect(findCycle(tree)).toBeNull();
    tree.set('c', ['a']);
    expect(findCycle(tree)).toEqual(['a', 'b', 'c', 'a']);
  });

  it('sees the cycle systems/context.ts is in', () => {
    expect(findCycle(closure(CONTEXT))).not.toBeNull();
    expect(reachedFrom(CONTEXT).has(CONTEXT)).toBe(true);
  });
});

describe('systemState.ts stays a leaf', () => {
  const graph = closure(LEAF);

  it('value-imports only the modules on its list', () => {
    const direct = graph.get(LEAF) ?? [];
    expect(direct.length).toBeGreaterThan(0);
    for (const module of direct) expect(LEAF_IMPORTS, module).toContain(module);
  });

  it('reaches neither systems/context.ts nor itself', () => {
    const reached = reachedFrom(LEAF);
    expect(reached.has(CONTEXT)).toBe(false);
    expect(reached.has(LEAF)).toBe(false);
  });

  it('has no cycle in what it loads', () => {
    // It loads more than its list: the walk goes through eval.ts's imports.
    expect(graph.size).toBeGreaterThan(LEAF_IMPORTS.length + 1);
    expect(findCycle(graph)).toBeNull();
  });
});

describe('remaining.ts stays outside every cycle (C4.10)', () => {
  it('is not in the leaf’s closure, which reaches the stack cap readers through eval.ts', () => {
    const graph = closure(LEAF);
    for (const module of ['sim/ailments/records.ts', 'sim/ailments/shock.ts', 'sim/caps.ts']) {
      expect(graph.has(module), module).toBe(true);
    }
    expect(graph.get('sim/build/eval.ts')).toEqual(
      expect.arrayContaining(['sim/ailments/records.ts', 'sim/ailments/shock.ts']),
    );
    expect(graph.has(REMAINING)).toBe(false);
  });

  it('value-imports only the modules on its list, without a cycle or systems/context.ts', () => {
    const graph = closure(REMAINING);
    const direct = graph.get(REMAINING) ?? [];
    expect(direct.length).toBeGreaterThan(0);
    for (const module of direct) expect(REMAINING_IMPORTS, module).toContain(module);
    expect(findCycle(graph)).toBeNull();
    expect(graph.has(CONTEXT)).toBe(false);
  });

  it('is value-imported by execute.ts and dispatch.ts alone', () => {
    const modules = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));
    expect(modules.length).toBeGreaterThan(50);
    const importers = modules.filter((module) => valueImports(module).includes(REMAINING));
    expect(importers.sort()).toEqual(REMAINING_IMPORTERS);
  });
});
