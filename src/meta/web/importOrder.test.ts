/**
 * Import order for src/meta/web (docs/v3 C6 design L8; the lead's ruling R2). Its rule tables are
 * module-level consts (WEB_RULES, PRICE_CURVE_OF and GATED_KINDS in counts.ts, BUY_REASONS and
 * CHALLENGE_RULES in rules.ts, DEFAULT_WEB_ECONOMY in price.ts), which is safe only while no
 * module of src/meta/web sits in a value-import cycle: entered from inside one, a module would run
 * before another's body and meet a const in the temporal dead zone. So the value imports among
 * the modules (an `import type` is erased) must form no cycle, and with each module imported
 * first into a fresh module registry, every const must be defined and a purchase must work.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/** src/meta/web's modules but the tests, by name. */
const MODULES = readdirSync(new URL('./', import.meta.url))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .map((file) => file.slice(0, -'.ts'.length))
  .sort();

/** The modules of src/meta/web that `name` imports or re-exports values from. */
function valueImports(name: string): string[] {
  const text = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
  const found = new Set<string>();
  for (const match of text.matchAll(/^(?:import|export)(\s+type)?\s[^;]*?from '\.\/(\w+)';/gm)) {
    if (match[1] === undefined) found.add(match[2] as string);
  }
  return [...found].sort();
}

/** The entries of a const: a record's values, a list's or a set's members. */
const entriesOf = (value: object): [string, unknown][] =>
  value instanceof Set
    ? [...(value as Set<unknown>)].map((member, i): [string, unknown] => [String(i), member])
    : Object.entries(value);

describe('src/meta/web import order (L8, R2)', () => {
  it('has no value-import cycle among its modules', () => {
    const graph = new Map(MODULES.map((name) => [name, valueImports(name)]));
    expect(graph.get('counts')).toEqual([]);
    expect(graph.get('types')).toEqual([]);
    expect(graph.get('index')).toEqual(
      expect.arrayContaining(['build', 'buyable', 'invest', 'path', 'price', 'reveal', 'rules']),
    );
    const done = new Set<string>();
    const visit = (name: string, trail: readonly string[]): void => {
      expect(trail, `cycle ${[...trail, name].join(' → ')}`).not.toContain(name);
      if (done.has(name)) return;
      for (const next of graph.get(name) ?? []) visit(next, [...trail, name]);
      done.add(name);
    };
    for (const name of MODULES) visit(name, []);
    expect(done.size).toBe(MODULES.length);
  });

  it.each(MODULES)('defines every const when %s is imported first', async (name) => {
    vi.resetModules();
    // A computed path: @vite-ignore keeps Vite from rewriting it into a glob.
    await import(/* @vite-ignore */ `./${name}`);
    const web = await import('./index');
    const { GATED_KINDS } = await import('./counts');
    const consts: Record<string, object> = {
      WEB_RULES: web.WEB_RULES,
      PRICE_CURVE_OF: web.PRICE_CURVE_OF,
      GATED_KINDS,
      BUY_REASONS: web.BUY_REASONS,
      CHALLENGE_RULES: web.CHALLENGE_RULES,
      DEFAULT_WEB_ECONOMY: web.DEFAULT_WEB_ECONOMY,
    };
    for (const [id, value] of Object.entries(consts)) {
      expect(value, id).toBeDefined();
      for (const [key, entry] of entriesOf(value)) expect(entry, `${id}.${key}`).toBeDefined();
    }
    expect(web.BUY_REASONS).toHaveLength(18);
    const { assembleWeb } = await import('../../data/web/assemble');
    const { FULL_SCOPE } = await import('../../data/web/scope');
    const { fixtureContent } = await import('../../data/web/testing');
    const fire = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
    const account = { singularityBeaten: false };
    const progress = web.progressFromOrder(fire, account, ['fire.center.alpha.r1']);
    expect(web.canBuy(fire, progress, account, 'fire.center.alpha.r2')).toMatchObject({
      ok: false,
      reason: 'notEnoughShards',
    });
    expect(web.boardCounts(fire, progress).center).toBe(1);
  });
});
