import { describe, expect, it } from 'vitest';
import { BATCH_COUNTS, DEMO_SCOPE_A, DEMO_SCOPE_B, FULL_SCOPE } from './scope';
import { WebScopeSchema } from './schema';
import type { WebScope } from './types';

/**
 * gd §2.1's counts for a scope of whole blocks: each character sees its center, the hub, the
 * scope's other outers with their fusions, and its two ascendancies.
 */
function counts(scope: WebScope): { total: number; perCharacter: number[] } {
  const characters = scope.characters === 'all' ? [] : scope.characters;
  const outers = scope.outers === 'all' ? [] : scope.outers;
  const others = (c: string) => outers.filter((o) => o !== c).length;
  return {
    total:
      characters.length * (40 + 2 * 3) +
      24 +
      outers.length * 18 +
      characters.reduce((sum, c) => sum + others(c) * 5, 0),
    perCharacter: characters.map((c) => 40 + 24 + others(c) * (18 + 5) + 2 * 3),
  };
}

describe('the scopes (D16)', () => {
  it('shows everything registered in FULL_SCOPE', () => {
    expect(FULL_SCOPE).toEqual({
      name: 'full',
      characters: 'all',
      outers: 'all',
      deferredFusions: [],
      waveCap: null,
    });
  });

  it('shows 熔核 and 蜂巢 with fire, ice, poison, crit and summon to wave 40 in the Demo', () => {
    expect(DEMO_SCOPE_A).toEqual({
      name: 'demoA',
      characters: ['fire', 'summon'],
      outers: ['fire', 'ice', 'poison', 'crit', 'summon'],
      deferredFusions: [],
      waveCap: 40,
    });
  });

  it('shows 熔核 and 霜晶 with fire, ice, poison, crit and lightning under the fallback (D29)', () => {
    expect(DEMO_SCOPE_B).toEqual({
      name: 'demoB',
      characters: ['fire', 'ice'],
      outers: ['fire', 'ice', 'poison', 'crit', 'lightning'],
      deferredFusions: [],
      waveCap: 40,
    });
  });

  it("counts 246 nodes in each Demo, 162 per character (V14's numbers)", () => {
    for (const scope of [DEMO_SCOPE_A, DEMO_SCOPE_B]) {
      expect(counts(scope), scope.name).toEqual({ total: 246, perCharacter: [162, 162] });
    }
  });

  it('has unique names and passes the strict schema', () => {
    const scopes = [FULL_SCOPE, DEMO_SCOPE_A, DEMO_SCOPE_B];
    expect(new Set(scopes.map((scope) => scope.name)).size).toBe(3);
    for (const scope of scopes) expect(WebScopeSchema.safeParse(scope).success).toBe(true);
  });
});

describe('BATCH_COUNTS (impl:281, impl:600-604)', () => {
  it('holds the assembled total after each batch', () => {
    expect(BATCH_COUNTS).toEqual({ B1: 156, B2: 246, B3: 405, B4: 632, B5: 644 });
  });

  it('adds up as the plan counts each batch', () => {
    expect(BATCH_COUNTS.B1).toBe(40 + 24 + 4 * 18 + 4 * 5);
    expect(BATCH_COUNTS.B2 - BATCH_COUNTS.B1).toBe(90);
    expect(BATCH_COUNTS.B3 - BATCH_COUNTS.B2).toBe(159);
    expect(BATCH_COUNTS.B4 - BATCH_COUNTS.B3).toBe(227);
    expect(BATCH_COUNTS.B5 - BATCH_COUNTS.B4).toBe(12);
  });
});
