import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, OUTER_IDS } from '../sources';
import {
  BATCH_COUNTS,
  BATCH_PLANS,
  batchOf,
  DEMO_SCOPE_A,
  DEMO_SCOPE_B,
  FULL_SCOPE,
  SCOPES,
} from './scope';
import type { Batch, BatchBlocks } from './scope';
import { WebScopeSchema } from './schema';
import { fixtureContent } from './testing';
import type { WebScope } from './types';

const BATCHES: readonly Batch[] = ['B1', 'B2', 'B3', 'B4', 'B5'];

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

describe('SCOPES and the batch plans (C6.5)', () => {
  it('lists every scope a web is assembled in', () => {
    expect(SCOPES).toEqual([FULL_SCOPE, DEMO_SCOPE_A, DEMO_SCOPE_B]);
  });

  it("finds each fixture variant's batch from its registered blocks", () => {
    for (const variant of BATCHES) {
      const content = fixtureContent(variant);
      const registered: BatchBlocks = {
        centers: CHARACTER_IDS.filter((c) => content.characters[c].center !== null),
        hub: content.hub !== null,
        outers: OUTER_IDS.filter((o) => content.outers[o] !== undefined),
        ascendancies: CHARACTER_IDS.filter((c) => content.characters[c].ascendancies !== null),
      };
      expect(batchOf(registered), variant).toBe(variant);
    }
  });

  it('finds a batch of the 10/28 fallback, in any order, and none for another set', () => {
    expect(
      batchOf({
        centers: ['ice', 'fire'],
        hub: true,
        outers: ['fire', 'lightning', 'crit', 'poison', 'ice'],
        ascendancies: ['ice', 'fire'],
      }),
    ).toBe('B2');
    expect(
      batchOf({
        centers: ['fire'],
        hub: true,
        outers: ['summon', 'crit', 'poison', 'ice'],
        ascendancies: [],
      }),
    ).toBe('B1');
    // A batch half landed, the hub left out, or nothing registered.
    expect(
      batchOf({
        centers: ['fire'],
        hub: true,
        outers: ['ice', 'poison', 'crit'],
        ascendancies: [],
      }),
    ).toBeNull();
    expect(
      batchOf({
        centers: ['fire'],
        hub: false,
        outers: ['ice', 'poison', 'crit', 'summon'],
        ascendancies: [],
      }),
    ).toBeNull();
    expect(batchOf({ centers: [], hub: false, outers: [], ascendancies: [] })).toBeNull();
  });

  it("counts each plan's blocks to BATCH_COUNTS by gd §2.1's formula", () => {
    expect(BATCH_PLANS).toHaveLength(2);
    for (const plan of BATCH_PLANS) {
      const centers: string[] = [];
      const outers: string[] = [];
      let hub = false;
      let ascendancies = 0;
      for (const batch of BATCHES) {
        centers.push(...plan[batch].centers);
        outers.push(...plan[batch].outers);
        hub ||= plan[batch].hub;
        ascendancies += plan[batch].ascendancies.length;
        const fusions = centers.reduce((sum, c) => sum + outers.filter((o) => o !== c).length, 0);
        const total =
          centers.length * 40 +
          (hub ? 24 : 0) +
          outers.length * 18 +
          fusions * 5 +
          ascendancies * 6;
        expect(total, batch).toBe(BATCH_COUNTS[batch]);
      }
      expect([...centers].sort()).toEqual([...CHARACTER_IDS].sort());
      expect([...outers].sort()).toEqual([...OUTER_IDS].sort());
      expect(ascendancies).toBe(4);
    }
  });
});
