import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../core/num';
import type { TalentNode } from '../data/types';
import { createMetaState } from './state';
import { allocate, canAllocate, nodePrice, nodeRank, refundAll } from './talents';
import { fixtureData, FIXTURE_TALENTS, talent } from './testing';
import { DEFAULT_ECONOMY } from './types';
import type { EconomyConfig, MetaState } from './types';

const data = fixtureData();
const node = (id: string): TalentNode => {
  const found = FIXTURE_TALENTS.find((n) => n.id === id);
  if (!found) throw new Error(`no fixture talent ${id}`);
  return found;
};

/** Integer prices (4, 8, 16, …) so currency arithmetic is exact. */
const EXACT_ECONOMY: EconomyConfig = { ...DEFAULT_ECONOMY, talentBaseShards: 4, talentGrowth: 2 };

function richMeta(shards = 1e6, cores = 100): MetaState {
  const meta = createMetaState();
  meta.shards = num(shards);
  meta.cores = cores;
  return meta;
}

describe('createMetaState', () => {
  it('starts empty', () => {
    const meta = createMetaState();
    expect(toNumber(meta.shards)).toBe(0);
    expect(meta.cores).toBe(0);
    expect(meta.allocated.size).toBe(0);
    expect(meta.ranks.size).toBe(0);
    expect(meta.maxWave).toBe(0);
    expect(meta.runs).toBe(0);
    expect(toNumber(meta.spentShards)).toBe(0);
    expect(meta.spentCores).toBe(0);
  });
});

describe('nodePrice', () => {
  const base = DEFAULT_ECONOMY.talentBaseShards;

  it('grows with the number of allocated non-repeatable nodes', () => {
    const meta = createMetaState();
    expect(toNumber(nodePrice(meta, node('b'), DEFAULT_ECONOMY).shards)).toBe(base);
    meta.allocated.add('a');
    expect(toNumber(nodePrice(meta, node('b'), DEFAULT_ECONOMY).shards)).toBeCloseTo(
      base * DEFAULT_ECONOMY.talentGrowth,
      9,
    );
    meta.allocated.add('b');
    expect(toNumber(nodePrice(meta, node('far'), DEFAULT_ECONOMY).shards)).toBeCloseTo(
      base * DEFAULT_ECONOMY.talentGrowth ** 2,
      9,
    );
  });

  it('does not count repeatable nodes toward n', () => {
    const meta = createMetaState();
    meta.allocated.add('r');
    meta.ranks.set('r', 4);
    expect(toNumber(nodePrice(meta, node('a'), DEFAULT_ECONOMY).shards)).toBe(base);
  });

  it('applies shardCostFactor and coreCost', () => {
    const meta = createMetaState();
    expect(nodePrice(meta, node('a2'), DEFAULT_ECONOMY)).toEqual({ shards: 2 * base, cores: 1 });
    expect(nodePrice(meta, node('k'), DEFAULT_ECONOMY)).toEqual({ shards: base, cores: 2 });
    expect(nodePrice(meta, node('a'), DEFAULT_ECONOMY).cores).toBe(0);
  });

  it('prices repeatable ranks by their own curve', () => {
    const meta = createMetaState();
    expect(nodePrice(meta, node('r'), DEFAULT_ECONOMY)).toEqual({ shards: 10, cores: 0 });
    meta.allocated.add('a');
    meta.allocated.add('r');
    meta.ranks.set('r', 3);
    expect(nodePrice(meta, node('r'), DEFAULT_ECONOMY)).toEqual({ shards: 80, cores: 0 });
  });

  it('adds coreCost to repeatable nodes and rejects a missing repeat curve', () => {
    const meta = createMetaState();
    const withCores = talent('rc', 'repeatable', ['start'], {
      repeat: { baseShards: 1, growth: 3 },
      coreCost: 2,
    });
    expect(nodePrice(meta, withCores, DEFAULT_ECONOMY)).toEqual({ shards: 1, cores: 2 });
    expect(() => nodePrice(meta, talent('bad', 'repeatable', []), DEFAULT_ECONOMY)).toThrow();
  });
});

describe('nodeRank', () => {
  it('is 1 for start, the rank for repeatables and 0/1 otherwise', () => {
    const meta = createMetaState();
    expect(nodeRank(meta, node('start'))).toBe(1);
    expect(nodeRank(meta, node('a'))).toBe(0);
    expect(nodeRank(meta, node('r'))).toBe(0);
    meta.allocated.add('a');
    meta.allocated.add('r');
    meta.ranks.set('r', 2);
    expect(nodeRank(meta, node('a'))).toBe(1);
    expect(nodeRank(meta, node('r'))).toBe(2);
  });
});

describe('canAllocate', () => {
  it('rejects unknown ids and the start node', () => {
    const meta = richMeta();
    expect(canAllocate(meta, 'nope', data, DEFAULT_ECONOMY)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(canAllocate(meta, 'start', data, DEFAULT_ECONOMY)).toEqual({
      ok: false,
      reason: 'start',
    });
  });

  it('allows start neighbours and rejects distant nodes', () => {
    const meta = richMeta();
    for (const id of ['a', 'b', 'r']) {
      expect(canAllocate(meta, id, data, DEFAULT_ECONOMY), id).toEqual({ ok: true });
    }
    for (const id of ['a2', 'k', 'far']) {
      expect(canAllocate(meta, id, data, DEFAULT_ECONOMY), id).toEqual({
        ok: false,
        reason: 'notAdjacent',
      });
    }
  });

  it('opens neighbours of a bought node and rejects buying it twice', () => {
    const meta = richMeta();
    allocate(meta, 'a', data, DEFAULT_ECONOMY);
    expect(canAllocate(meta, 'a2', data, DEFAULT_ECONOMY)).toEqual({ ok: true });
    expect(canAllocate(meta, 'k', data, DEFAULT_ECONOMY)).toEqual({
      ok: false,
      reason: 'notAdjacent',
    });
    expect(canAllocate(meta, 'a', data, DEFAULT_ECONOMY)).toEqual({
      ok: false,
      reason: 'allocated',
    });
  });

  it('keeps repeatable nodes buyable after the first rank', () => {
    const meta = richMeta();
    allocate(meta, 'r', data, DEFAULT_ECONOMY);
    expect(canAllocate(meta, 'r', data, DEFAULT_ECONOMY)).toEqual({ ok: true });
  });

  it('reports missing shards before missing cores', () => {
    const poor = richMeta(4.99, 0);
    expect(canAllocate(poor, 'a', data, DEFAULT_ECONOMY)).toEqual({
      ok: false,
      reason: 'notEnoughShards',
    });
    poor.allocated.add('a');
    expect(canAllocate(poor, 'a2', data, DEFAULT_ECONOMY)).toEqual({
      ok: false,
      reason: 'notEnoughShards',
    });
    const noCores = richMeta(1000, 0);
    noCores.allocated.add('a');
    expect(canAllocate(noCores, 'a2', data, DEFAULT_ECONOMY)).toEqual({
      ok: false,
      reason: 'notEnoughCores',
    });
  });

  it('allows spending exactly the available currency', () => {
    const meta = richMeta(DEFAULT_ECONOMY.talentBaseShards, 0);
    expect(canAllocate(meta, 'a', data, DEFAULT_ECONOMY)).toEqual({ ok: true });
  });
});

describe('allocate / refundAll', () => {
  it('deducts the price and tracks spent currency', () => {
    const meta = richMeta(100, 3);
    allocate(meta, 'a', data, EXACT_ECONOMY); // 4
    allocate(meta, 'a2', data, EXACT_ECONOMY); // 4 × 2 × 2 = 16, 1 core
    expect(toNumber(meta.shards)).toBe(80);
    expect(meta.cores).toBe(2);
    expect(toNumber(meta.spentShards)).toBe(20);
    expect(meta.spentCores).toBe(1);
    expect([...meta.allocated]).toEqual(['a', 'a2']);
    expect(meta.ranks.size).toBe(0);
  });

  it('stacks repeatable ranks', () => {
    const meta = richMeta(100, 0);
    for (let i = 0; i < 3; i++) allocate(meta, 'r', data, EXACT_ECONOMY); // 10 + 20 + 40
    expect(meta.ranks.get('r')).toBe(3);
    expect(meta.allocated.has('r')).toBe(true);
    expect(toNumber(meta.shards)).toBe(30);
    expect(toNumber(meta.spentShards)).toBe(70);
    // The repeatable node does not raise the price of normal nodes.
    expect(toNumber(nodePrice(meta, node('a'), EXACT_ECONOMY).shards)).toBe(4);
  });

  it('throws without changing state when the node cannot be bought', () => {
    const meta = richMeta(3, 0);
    expect(() => allocate(meta, 'a', data, EXACT_ECONOMY)).toThrow(/notEnoughShards/);
    expect(() => allocate(meta, 'far', data, EXACT_ECONOMY)).toThrow(/notAdjacent/);
    expect(toNumber(meta.shards)).toBe(3);
    expect(meta.allocated.size).toBe(0);
    expect(toNumber(meta.spentShards)).toBe(0);
  });

  it('refundAll restores the exact totals and clears the web', () => {
    const meta = richMeta(1000, 5);
    for (const id of ['a', 'b', 'a2', 'k', 'far', 'r', 'r'])
      allocate(meta, id, data, EXACT_ECONOMY);
    expect(toNumber(meta.shards)).toBeLessThan(1000);
    expect(meta.cores).toBe(2);
    refundAll(meta);
    expect(toNumber(meta.shards)).toBe(1000);
    expect(meta.cores).toBe(5);
    expect(meta.allocated.size).toBe(0);
    expect(meta.ranks.size).toBe(0);
    expect(toNumber(meta.spentShards)).toBe(0);
    expect(meta.spentCores).toBe(0);
    // Prices start over after the respec.
    expect(toNumber(nodePrice(meta, node('a'), EXACT_ECONOMY).shards)).toBe(4);
  });

  it('refundAll returns the default-economy spend within float precision', () => {
    const start = 100 * DEFAULT_ECONOMY.talentBaseShards;
    const meta = richMeta(start, 5);
    for (const id of ['a', 'b', 'a2', 'r']) allocate(meta, id, data, DEFAULT_ECONOMY);
    refundAll(meta);
    expect(toNumber(meta.shards)).toBeCloseTo(start, 9);
    expect(meta.cores).toBe(5);
  });
});
