/**
 * A character session's affordability under a price factor (E17; WebNode.priceFactor, ★守財奴):
 * a visit checks and buys through canBuy and buy, so a strategy sees the factored shard prices
 * (src/meta/web/price.ts), and what it pays is what spent records.
 */

import { describe, expect, it } from 'vitest';
import { add, mul, num, sub } from '../../../src/core/num';
import { createRng } from '../../../src/core/rng';
import { characterGameData } from '../../../src/data';
import type { AssembledWeb, WebNode } from '../../../src/data/web';
import { buy, buyPath, DEFAULT_WEB_ECONOMY, emptyProgress, nextPrice } from '../../../src/meta/web';
import type { CharacterProgress } from '../../../src/meta/web';
import { webOf } from './content';
import { createStrategy, savesForShards } from './strategies';
import { openVisit } from './visit';

const ACCOUNT = { singularityBeaten: false };
const STAR = 'outer.greed.main.star';
const STEP = 'outer.greed.alpha.r3';
const web = webOf({ fixture: 'B5' }, 'fire', 'full');
const nodes = web.nodes.map((node): WebNode =>
  node.id === STAR ? { ...node, priceFactor: 1.5 } : node,
);
const priced: AssembledWeb = { ...web, nodes, byId: new Map(nodes.map((n) => [n.id, n])) };
const RICH = { shards: num(1e9), cores: 1000, resonance: 0 };

/** The ★ and its route bought, then the wallet set to `shards` (and 10 cores). */
function owning(shards: number): CharacterProgress {
  const rich: CharacterProgress = {
    ...emptyProgress('fire'),
    wallet: RICH,
    bestWave: 30,
  };
  return {
    ...buyPath(priced, rich, ACCOUNT, STAR),
    wallet: { shards: num(shards), cores: 10, resonance: 0 },
  };
}

/** A visit of `on` from `progress`, its probe fixed. */
const visitOn = (on: AssembledWeb, progress: CharacterProgress) =>
  openVisit({
    web: on,
    account: ACCOUNT,
    economy: DEFAULT_WEB_ECONOMY,
    data: characterGameData(),
    rng: createRng(1),
    minutes: 0,
    progress,
    probe: () => [10, 10],
  });

describe('a session visit under a price factor', () => {
  it('refuses a node the wallet affords at today’s price only, and buys it at the factored one', () => {
    const today = nextPrice(web, owning(0), STEP);
    const short = visitOn(priced, owning(today.shards));
    expect(short.check(STEP)).toEqual({ ok: false, reason: 'notEnoughShards', gate: null });
    expect(() => short.buy(STEP)).toThrow(`visit: '${STEP}' refused: notEnoughShards`);
    expect(visitOn(web, owning(today.shards)).check(STEP)).toEqual({ ok: true, price: today });
    // savesForShards reads the cores and 迴響 alone, which the factor leaves.
    expect(savesForShards(short, STEP, 'notEnoughShards')).toBe(true);
    const enough = visitOn(priced, owning(mul(today.shards, 1.5)));
    expect(enough.check(STEP)).toEqual({
      ok: true,
      price: { ...today, shards: mul(today.shards, 1.5) },
    });
    enough.buy(STEP);
    expect(enough.progress().wallet.shards).toEqual(
      sub(mul(today.shards, 1.5), mul(today.shards, 1.5)),
    );
  });

  it('makes `cheapest` buy fewer nodes from the same wallet, each at its factored price', () => {
    const visit = (on: AssembledWeb) => {
      const v = visitOn(on, owning(60));
      createStrategy('cheapest', on).visit(v);
      return v;
    };
    const plain = visit(web);
    const factored = visit(priced);
    expect(factored.bought.length).toBeGreaterThan(0);
    expect(factored.bought.length).toBeLessThan(plain.bought.length);
    // Each purchase cost 1.5 × today's price at its count, and spent holds their sum.
    let progress: CharacterProgress = { ...owning(60), wallet: RICH };
    let paid = progress.spent.shards;
    for (const id of factored.bought) {
      const today = nextPrice(web, progress, id);
      const price = nextPrice(priced, progress, id);
      expect(price, id).toEqual({ ...today, shards: mul(today.shards, 1.5) });
      paid = add(paid, price.shards);
      progress = buy(priced, progress, ACCOUNT, id);
    }
    expect(factored.progress().ranks).toEqual(progress.ranks);
    expect(factored.progress().spent.shards).toEqual(paid);
    // What is left would not buy the cheapest node left at its factored price.
    const left = factored.progress();
    const next = visitOn(priced, left);
    createStrategy('cheapest', priced).visit(next);
    expect(next.bought).toEqual([]);
  });
});
