import { describe, expect, it } from 'vitest';
import { num } from '../../src/core/num';
import { loadGameData } from '../../src/data';
import type { TalentNode } from '../../src/data';
import { createMetaState, DEFAULT_ECONOMY } from '../../src/meta';
import type { MetaState } from '../../src/meta';
import { nextPurchase, nodeClass, spend, STRATEGY_IDS } from './strategies';
import type { NodeClass } from './strategies';

const data = loadGameData();
/** Fixed prices so the expectations below do not move with economy tuning. */
const ECONOMY = { ...DEFAULT_ECONOMY, talentBaseShards: 5, talentGrowth: 1.22 };
const byId = new Map(data.talents.map((node) => [node.id, node]));
const classOf = (id: string): NodeClass => nodeClass(byId.get(id) as TalentNode);

function richMeta(shards = 1e9, cores = 50): MetaState {
  const meta = createMetaState();
  meta.shards = num(shards);
  meta.cores = cores;
  return meta;
}

describe('nodeClass', () => {
  it('maps archetypes and treats the repeatable node as generic', () => {
    expect(classOf('keenEye')).toBe('crit');
    expect(classOf('flashpoint')).toBe('hybrid');
    expect(classOf('inferno')).toBe('dot');
    expect(classOf('arcStorm')).toBe('chain');
    expect(classOf('swiftness')).toBe('generic');
    const repeatable = data.talents.find((node) => node.kind === 'repeatable');
    expect(repeatable).toBeDefined();
    expect(nodeClass(repeatable as TalentNode)).toBe('generic');
  });
});

describe('spend', () => {
  it('is deterministic for every strategy', () => {
    for (const strategy of STRATEGY_IDS) {
      const a = spend(strategy, richMeta(5e4, 3), data, ECONOMY);
      const b = spend(strategy, richMeta(5e4, 3), data, ECONOMY);
      expect(a.length).toBeGreaterThan(0);
      expect(b).toEqual(a);
    }
  });

  it('stops when nothing is affordable and leaves the rest in the bank', () => {
    const meta = richMeta(0, 0);
    expect(spend('cheapest', meta, data, ECONOMY)).toEqual([]);
    expect(nextPurchase('balanced', meta, data, ECONOMY)).toBeNull();
  });

  it.each(['crit', 'dot', 'chain'] as const)(
    '%s-greedy buys its archetype, then generic, then bridge nodes, never other archetypes',
    (archetype) => {
      const bought = spend(`${archetype}-greedy`, richMeta(), data, ECONOMY);
      const classes = bought.map(classOf);
      const firstGeneric = classes.indexOf('generic');
      const firstHybrid = classes.indexOf('hybrid');
      const own = data.talents.filter((node) => nodeClass(node) === archetype).map((n) => n.id);

      expect(firstGeneric).toBe(own.length);
      expect(new Set(bought.slice(0, firstGeneric))).toEqual(new Set(own));
      expect(firstHybrid).toBeGreaterThan(firstGeneric);
      expect(classes.slice(firstGeneric, firstHybrid).every((cls) => cls === 'generic')).toBe(true);
      expect(
        classes.every((cls) => cls === archetype || cls === 'generic' || cls === 'hybrid'),
      ).toBe(true);
      expect(bought).not.toContain('glassCannon');
    },
  );

  it('skips archetype nodes that need cores it does not have', () => {
    const bought = spend('crit-greedy', richMeta(1e6, 0), data, ECONOMY);
    expect(bought).not.toContain('precision');
    expect(bought.slice(0, 3)).toEqual(['keenEye', 'sharpen', 'quickDraw']);
  });

  it('falls back to generic nodes when its archetype has nothing affordable', () => {
    const meta = richMeta(10, 0);
    for (const id of ['keenEye', 'sharpen', 'quickDraw']) meta.allocated.add(id);
    // precision needs a core; small nodes cost 5 × 1.22³ ≈ 9.08, the repeatable node 10.
    expect(nextPurchase('crit-greedy', meta, data, ECONOMY)?.id).toBe('swiftness');
    meta.allocated.add('swiftness');
    meta.allocated.add('vitality');
    // Small nodes now cost 5 × 1.22⁵ ≈ 13.5, so the repeatable node is the cheapest generic.
    expect(nextPurchase('crit-greedy', meta, data, ECONOMY)?.id).toBe('might');
  });

  it('might-only buys ranks of the repeatable node and nothing else', () => {
    const meta = richMeta(1e4, 50);
    const bought = spend('might-only', meta, data, ECONOMY);
    expect(bought.length).toBeGreaterThan(5);
    expect(new Set(bought)).toEqual(new Set(['might']));
    expect(classOf('might')).toBe('generic');
    expect(meta.ranks.get('might')).toBe(bought.length);
    expect(meta.allocated).toEqual(new Set(['might']));
    expect(meta.cores).toBe(50);
  });

  it('cheapest takes the lowest price, then data order', () => {
    expect(spend('cheapest', richMeta(5, 0), data, ECONOMY)).toEqual(['swiftness']);
  });

  it('balanced rotates crit, dot, chain while all are affordable', () => {
    const bought = spend('balanced', richMeta(), data, ECONOMY);
    expect(bought.slice(0, 6)).toEqual([
      'keenEye',
      'kindling',
      'spark',
      'sharpen',
      'fuel',
      'conductor',
    ]);
  });
});
