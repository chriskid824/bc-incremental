import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../core/num';
import { createMetaState } from '../meta/state';
import { fixtureData, FIXTURE_TALENTS, talent } from '../meta/testing';
import { DEFAULT_ECONOMY } from '../meta/types';
import type { EconomyConfig, MetaState } from '../meta/types';
import { autoBuyTalents } from './autoBuy';

/** Integer prices (4, 8, 16, …) so currency arithmetic is exact. */
const ECONOMY: EconomyConfig = { ...DEFAULT_ECONOMY, talentBaseShards: 4, talentGrowth: 2 };

function metaWith(shards: number, cores: number): MetaState {
  const meta = createMetaState();
  meta.shards = num(shards);
  meta.cores = cores;
  return meta;
}

describe('autoBuyTalents', () => {
  it('buys the cheapest affordable node until nothing is affordable', () => {
    // a 4, then b 8, then repeatable r 10 (cheaper than the next normal node at 16);
    // a2 needs a core and r's next rank costs 20 > 8 shards left.
    const meta = metaWith(30, 0);
    const purchases = autoBuyTalents(meta, fixtureData(), ECONOMY);
    expect(purchases).toEqual([
      { id: 'a', count: 1 },
      { id: 'b', count: 1 },
      { id: 'r', count: 1 },
    ]);
    expect(toNumber(meta.shards)).toBe(8);
    expect(meta.ranks.get('r')).toBe(1);
  });

  it('groups repeated ranks and never buys keystones', () => {
    const meta = metaWith(1e6, 100);
    const purchases = autoBuyTalents(meta, fixtureData(), ECONOMY);
    expect(meta.allocated.has('k')).toBe(false);
    expect(meta.allocated.has('far')).toBe(false);
    expect(meta.allocated.has('a2')).toBe(true);
    const ranks = purchases.find((p) => p.id === 'r');
    expect(ranks?.count).toBe(meta.ranks.get('r'));
    expect(ranks?.count).toBeGreaterThan(1);
  });

  it('returns nothing when broke', () => {
    const meta = metaWith(0, 0);
    expect(autoBuyTalents(meta, fixtureData(), ECONOMY)).toEqual([]);
    expect(meta.allocated.size).toBe(0);
  });

  it('stops on a free repeatable node instead of looping forever', () => {
    const talents = FIXTURE_TALENTS.map((node) =>
      node.id === 'r'
        ? talent('r', 'repeatable', ['start'], { repeat: { baseShards: 0, growth: 1 } })
        : node,
    );
    const meta = metaWith(0, 0);
    const purchases = autoBuyTalents(meta, fixtureData({ talents }), ECONOMY);
    expect(purchases).toEqual([{ id: 'r', count: 1000 }]);
  });
});
