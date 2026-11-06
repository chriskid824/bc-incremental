/**
 * The price factor (WebNode.priceFactor; ★守財奴, gd:503 「天賦節點價格 +50%」) and Hoshi's 2026-11-06
 * answer to item 25, 照原價退: while a character owns a factor node, every next shard price on its
 * web is the base's × F, F the product over its owned factor nodes; cores and 迴響 are not
 * factored; buy moves the factored price to spent; the refunds return the unfactored difference
 * of canonicalCost and refundAll everything spent. The fixture's greed ★ carries the factor, as
 * ★守財奴 will; a web without the field is priced against the base's own code path.
 */

import { describe, expect, it } from 'vitest';
import { add, gt, lt, mul, num, pow, sub, ZERO } from '../../core/num';
import { createRng } from '../../core/rng';
import { assembleWeb } from '../../data/web/assemble';
import { FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import type { AssembledWeb, WebNode } from '../../data/web/types';
import { boardCounts, GATED_KINDS, PRICE_CURVE_OF } from './counts';
import { auditBuy, progressFromOrder } from './invest';
import { buyPath, planPath, shortestRoute } from './path';
import { canonicalCost, DEFAULT_WEB_ECONOMY, nextPrice } from './price';
import {
  buy,
  canBuy,
  emptyProgress,
  legalize,
  refundAll,
  refundNode,
  refundPreview,
} from './rules';
import { sampleProgress } from './sample';
import type {
  AccountProgress,
  BoardCounts,
  CharacterProgress,
  Price,
  Wallet,
  WebEconomy,
} from './types';

const content = fixtureContent();
const fire = assembleWeb(content, 'fire', FULL_SCOPE);
const hive = assembleWeb(content, 'summon', FULL_SCOPE);
const account: AccountProgress = { singularityBeaten: false };
const RICH: Wallet = { shards: num(1e9), cores: 1000, resonance: 1000 };

/** The greed outer's ★, where ★守財奴 sits, on every character's web. */
const STAR = 'outer.greed.main.star';
/** A step, a mastery and a might node next to the ★'s route, bought under its factor. */
const STEP = 'outer.greed.alpha.r3';
const STEP_NEXT = 'outer.greed.alpha.r4';
const MASTERY = 'outer.greed.alpha.mastery';
const MIGHT = 'hub.might.might';
/** A ◆ on the ★'s route (1 rank, step curve, 1 core): a factor whose own purchase costs shards. */
const NOTABLE = 'fire.center.alpha.alpha-one';
const COUNTER = 'outer.greed.main.counter';

/** `web` with the listed nodes' priceFactor set, as the priceFactor helper writes it. */
function withFactors(web: AssembledWeb, factors: Readonly<Record<string, number>>): AssembledWeb {
  for (const id of Object.keys(factors)) {
    if (!web.byId.has(id)) throw new Error(`no node '${id}' on web '${web.character}'`);
  }
  const nodes = web.nodes.map((node): WebNode =>
    Object.hasOwn(factors, node.id) ? { ...node, priceFactor: factors[node.id] as number } : node,
  );
  return { ...web, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
}

/**
 * priceOf as the base (edc7023) wrote it, its countOn and curvePrice inlined: base × growth^k
 * on the node's curve, its kind's cores and 迴響. The code path a web without the field keeps,
 * and the "today's" price the factor multiplies; its counts are this tree's boardCounts'.
 */
function basePriceOf(
  node: WebNode,
  counts: BoardCounts,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
): Price {
  const curve = PRICE_CURVE_OF[node.kind];
  const k =
    curve === 'step'
      ? counts.stepPurchases
      : curve === 'mastery'
        ? counts.masteryRanks
        : counts.mightRanks;
  return {
    shards: curve === null ? ZERO : mul(pow(num(economy[curve].growth), k), economy[curve].base),
    cores: economy.cores[node.kind],
    resonance: economy.resonance[node.kind],
  };
}

/** Today's price of `id`'s next rank on `progress`: the base's code on the factorless fixture. */
const basePrice = (progress: CharacterProgress, id: string, web: AssembledWeb = fire): Price =>
  basePriceOf(web.byId.get(id) as WebNode, boardCounts(web, progress));

/** Today's price with its shards × `factor`, cores and 迴響 as they are. */
const factored = (price: Price, factor: number): Price => ({
  ...price,
  shards: mul(price.shards, factor),
});

const storedRankOf = (progress: CharacterProgress, id: string): number => progress.ranks[id] ?? 0;

const start = (character: 'fire' | 'summon' = 'fire'): CharacterProgress => ({
  ...emptyProgress(character),
  wallet: RICH,
  bestWave: 30,
  prestiges: 1,
});

/** `ids` bought in order on `web` from `from`, each through canBuy. */
const bought = (web: AssembledWeb, ids: readonly string[], from = start()): CharacterProgress =>
  ids.reduce((progress, id) => buy(web, progress, account, id), from);

/** The ★'s route from the signature (6 center and hub nodes, then greed's entry to its answer). */
const ROUTE = shortestRoute(fire, start(), STAR, (node) => !GATED_KINDS.has(node.kind)) ?? [];

const fire15 = withFactors(fire, { [STAR]: 1.5 });
/** The ★ owned, its whole route bought before it at today's prices. */
const OWNED = bought(fire15, ROUTE);
/** OWNED, then a step, a mastery and a might rank bought under the factor. */
const UNDER = bought(fire15, [STEP, MASTERY, MIGHT, MIGHT], OWNED);

describe('the factored prices (G2)', () => {
  it('buys the ★ last on its route, every purchase before it at today’s price', () => {
    expect(ROUTE).toHaveLength(13);
    expect(ROUTE.at(-1)).toBe(STAR);
    expect(OWNED.spent).toEqual(bought(fire, ROUTE).spent);
    expect(boardCounts(fire15, OWNED).priceFactor).toBe(1.5);
  });

  it('prices every next shard rank at 1.5 × today’s on each curve, cores and 迴響 unchanged', () => {
    const curves = new Set<string>();
    for (const progress of [OWNED, UNDER]) {
      for (const node of fire15.nodes) {
        const today = basePrice(progress, node.id);
        expect(nextPrice(fire15, progress, node.id), node.id).toEqual(factored(today, 1.5));
        const curve = PRICE_CURVE_OF[node.kind];
        if (curve !== null && gt(today.shards, ZERO)) curves.add(curve);
      }
      const counts = boardCounts(fire15, progress);
      expect({ ...counts, priceFactor: undefined }).toEqual(boardCounts(fire, progress));
    }
    expect([...curves].sort()).toEqual(['mastery', 'might', 'step']);
    // UNDER counts on all three curves, so each is priced at a count above 0.
    expect(boardCounts(fire, UNDER)).toMatchObject({
      stepPurchases: 13,
      masteryRanks: 1,
      mightRanks: 2,
    });
    // Named, for each curve: a step rank, a ◆ (1 core), a mastery and a might rank.
    for (const id of [STEP, STEP_NEXT, 'outer.greed.beta.beta-one', MASTERY, MIGHT]) {
      expect(nextPrice(fire15, UNDER, id), id).toEqual(factored(basePrice(UNDER, id), 1.5));
    }
    expect(nextPrice(fire15, UNDER, 'outer.greed.beta.beta-one').cores).toBe(1);
  });

  it("gives canBuy the factored price, and an accepted rank's price is nextPrice's", () => {
    for (const id of [STEP, STEP_NEXT, MASTERY, MIGHT, 'outer.greed.main.threshold']) {
      const check = canBuy(fire15, UNDER, account, id);
      if (!check.ok) continue;
      expect(check.price, id).toEqual(factored(basePrice(UNDER, id), 1.5));
      expect(check.price).toEqual(nextPrice(fire15, UNDER, id));
    }
    expect(canBuy(fire15, UNDER, account, STEP)).toEqual({
      ok: true,
      price: factored(basePrice(UNDER, STEP), 1.5),
    });
  });

  it('prices the ★ itself at ×1 before it is owned: 3 cores and no shards', () => {
    const before = bought(fire15, ROUTE.slice(0, -1));
    expect(boardCounts(fire15, before).priceFactor).toBeUndefined();
    expect(nextPrice(fire15, before, STAR)).toEqual({ shards: 0, cores: 3, resonance: 0 });
    expect(canBuy(fire15, before, account, STAR)).toEqual({
      ok: true,
      price: { shards: 0, cores: 3, resonance: 0 },
    });
    // Every other next price is today's until the ★ is owned.
    for (const node of fire15.nodes) {
      expect(nextPrice(fire15, before, node.id), node.id).toEqual(basePrice(before, node.id));
    }
    const after = buy(fire15, before, account, STAR);
    expect(after.spent).toEqual({ ...before.spent, cores: before.spent.cores + 3 });
  });

  it("prices a factor ◆'s own purchase at ×1 and every price after it × its factor", () => {
    const web = withFactors(fire, { [NOTABLE]: 1.5 });
    const route = ROUTE.slice(0, ROUTE.indexOf(NOTABLE));
    const before = bought(web, route);
    const own = basePrice(before, NOTABLE);
    expect(gt(own.shards, ZERO)).toBe(true);
    expect(nextPrice(web, before, NOTABLE)).toEqual(own);
    expect(canBuy(web, before, account, NOTABLE)).toEqual({ ok: true, price: own });
    const after = buy(web, before, account, NOTABLE);
    expect(after.spent.shards).toEqual(add(before.spent.shards, own.shards));
    const next = ROUTE[ROUTE.indexOf(NOTABLE) + 1] as string;
    expect(nextPrice(web, after, next)).toEqual(factored(basePrice(after, next), 1.5));
    expect(canBuy(web, after, account, NOTABLE)).toMatchObject({ ok: false, reason: 'owned' });
    // Under another owned factor, its own purchase takes that one alone.
    const both = withFactors(fire, { [NOTABLE]: 1.5, 'fire.center.alpha.r2': 1.2 });
    const under = bought(both, route);
    expect(nextPrice(both, under, NOTABLE)).toEqual(factored(basePrice(under, NOTABLE), 1.2));
  });

  it('multiplies two owned factors (1.5 × 1.2 = 1.8), never adds them', () => {
    const web = withFactors(fire, { [STAR]: 1.5, [NOTABLE]: 1.2 });
    const progress = bought(web, [STEP, MASTERY, MIGHT], bought(web, ROUTE));
    expect(boardCounts(web, progress).priceFactor).toBe(1.5 * 1.2);
    for (const node of web.nodes) {
      expect(nextPrice(web, progress, node.id), node.id).toEqual(
        factored(basePrice(progress, node.id), 1.5 * 1.2),
      );
    }
    const today = basePrice(progress, STEP_NEXT);
    // Never 2.7 (the sum) nor 1.7 (the two raises added: +50% and +20%).
    for (const sum of [1.5 + 1.2, 1.5 + 1.2 - 1]) {
      expect(nextPrice(web, progress, STEP_NEXT)).not.toEqual(factored(today, sum));
    }
  });

  it('prices a web without the field exactly as the base’s code path, with no factor counted', () => {
    const economy: WebEconomy = {
      ...DEFAULT_WEB_ECONOMY,
      step: { base: 10, growth: 2 },
      mastery: { base: 7, growth: 1.3 },
      cores: { ...DEFAULT_WEB_ECONOMY.cores, ranked: 4 },
    };
    const rng = createRng(503);
    const progresses = [
      emptyProgress('fire'),
      OWNED,
      UNDER,
      ...Array.from({ length: 12 }, (_, i) =>
        sampleProgress(fire, rng, {
          account,
          purchases: 10 + 15 * i,
          bestWave: 30,
          prestiged: i % 2 === 0,
        }),
      ),
    ];
    // Factors on nodes no progress here owns change nothing either.
    const unowned = withFactors(fire, { 'fire.center.gamma.gamma-three': 1.5 });
    for (const progress of progresses) {
      const counts = boardCounts(fire, progress);
      expect(Object.keys(counts)).toEqual([
        'center',
        'outers',
        'cores',
        'keystones',
        'stepPurchases',
        'masteryRanks',
        'mightRanks',
      ]);
      if (storedRankOf(progress, 'fire.center.gamma.gamma-three') === 0) {
        expect(boardCounts(unowned, progress)).toEqual(counts);
      }
      for (const node of fire.nodes) {
        expect(nextPrice(fire, progress, node.id), node.id).toEqual(basePriceOf(node, counts));
        expect(nextPrice(fire, progress, node.id, economy)).toEqual(
          basePriceOf(node, counts, economy),
        );
        const check = canBuy(fire, { ...progress, wallet: RICH }, account, node.id);
        if (check.ok) expect(check.price).toEqual(basePriceOf(node, counts));
      }
    }
  });
});

describe('what F is formed over (D5)', () => {
  it('forms none from a factor on the signature, which is never bought', () => {
    const web = withFactors(fire, { [fire.root]: 1.5 });
    expect(web.byId.get(fire.root)?.kind).toBe('signature');
    for (const progress of [start(), OWNED, UNDER]) {
      expect(boardCounts(web, progress)).toEqual(boardCounts(fire, progress));
      expect(nextPrice(web, progress, STEP_NEXT)).toEqual(nextPrice(fire, progress, STEP_NEXT));
    }
  });
});

describe('buy and canBuy under the factor (G2)', () => {
  it('adds the factored price to spent and takes it from the wallet', () => {
    const price = factored(basePrice(OWNED, STEP), 1.5);
    const after = buy(fire15, OWNED, account, STEP);
    expect(after.spent).toEqual({
      shards: add(OWNED.spent.shards, price.shards),
      cores: OWNED.spent.cores,
      resonance: OWNED.spent.resonance,
    });
    expect(after.wallet.shards).toEqual(sub(OWNED.wallet.shards, price.shards));
    // A ◆ under the factor: its shards × 1.5, its 1 core as it is.
    const beta = bought(fire15, ['outer.greed.beta.r1', 'outer.greed.beta.r2'], OWNED);
    const one = 'outer.greed.beta.beta-one';
    const own = factored(basePrice(beta, one), 1.5);
    expect(buy(fire15, beta, account, one).spent).toEqual({
      shards: add(beta.spent.shards, own.shards),
      cores: beta.spent.cores + 1,
      resonance: 0,
    });
  });

  it('refuses notEnoughShards at the factored price when the wallet holds today’s price only', () => {
    const today = basePrice(OWNED, STEP);
    const poor = (shards: typeof today.shards): CharacterProgress => ({
      ...OWNED,
      wallet: { shards, cores: 1000, resonance: 1000 },
    });
    expect(canBuy(fire15, poor(today.shards), account, STEP)).toEqual({
      ok: false,
      reason: 'notEnoughShards',
      gate: null,
    });
    expect(() => buy(fire15, poor(today.shards), account, STEP)).toThrow(
      `buy '${STEP}' (character 'fire', scope 'full'): notEnoughShards`,
    );
    // A wallet well between the two prices: refused too, so the factored shards are the test.
    expect(canBuy(fire15, poor(mul(today.shards, 1.25)), account, STEP)).toEqual({
      ok: false,
      reason: 'notEnoughShards',
      gate: null,
    });
    // Today's web takes today's price; the factored price is enough under the factor.
    expect(canBuy(fire, poor(today.shards), account, STEP)).toEqual({ ok: true, price: today });
    const enough = mul(today.shards, 1.5);
    expect(canBuy(fire15, poor(enough), account, STEP)).toEqual({
      ok: true,
      price: { ...today, shards: enough },
    });
    expect(lt(today.shards, enough)).toBe(true);
  });
});

/** `progress` with `ids` cut from its ranks by hand, nothing refunded: stored garbage. */
const cutOut = (progress: CharacterProgress, ...ids: readonly string[]): CharacterProgress => ({
  ...progress,
  ranks: Object.fromEntries(Object.entries(progress.ranks).filter(([id]) => !ids.includes(id))),
});

describe('the refunds (Hoshi’s 照原價退)', () => {
  /** UNDER with STEP's second rank and STEP_NEXT bought under the factor too. */
  const DEEP = bought(fire15, [STEP, STEP_NEXT], UNDER);
  const unfactoredDifference = (before: CharacterProgress, after: CharacterProgress): Price => {
    const a = canonicalCost(fire, before);
    const b = canonicalCost(fire, after);
    return {
      shards: sub(a.shards, b.shards),
      cores: a.cores - b.cores,
      resonance: a.resonance - b.resonance,
    };
  };

  it('returns the unfactored difference of a node bought under the factor, the rest left in spent', () => {
    const paid = sub(DEEP.spent.shards, bought(fire15, [STEP], UNDER).spent.shards);
    const after = refundNode(fire15, DEEP, account, STEP_NEXT);
    const refund = unfactoredDifference(DEEP, after);
    expect(after.ranks).toEqual(
      Object.fromEntries(Object.entries(DEEP.ranks).filter(([id]) => id !== STEP_NEXT)),
    );
    expect(refund.shards).toEqual(
      sub(canonicalCost(fire15, DEEP).shards, canonicalCost(fire15, after).shards),
    );
    expect(after.wallet).toEqual({
      ...DEEP.wallet,
      shards: add(DEEP.wallet.shards, refund.shards),
    });
    expect(after.spent).toEqual({ ...DEEP.spent, shards: sub(DEEP.spent.shards, refund.shards) });
    // About 1/1.5 of what it paid comes back; a third of the payment stays in spent.
    expect(Math.abs(refund.shards / paid - 1 / 1.5)).toBeLessThan(1e-9);
    expect(refundPreview(fire15, DEEP, account, STEP_NEXT)).toEqual({
      dropped: [STEP_NEXT],
      refund: { shards: refund.shards, cores: 0, resonance: 0 },
    });
    // canonicalCost reads no factor: the factored web's equals the factorless one's.
    for (const progress of [OWNED, UNDER, DEEP, after]) {
      expect(canonicalCost(fire15, progress)).toEqual(canonicalCost(fire, progress));
    }
    // spent holds more than the canonical cost; refundAll returns all of it.
    expect(gt(after.spent.shards, canonicalCost(fire15, after).shards)).toBe(true);
    const all = refundAll(after);
    expect(all.ranks).toEqual({});
    expect(all.spent).toEqual({ shards: 0, cores: 0, resonance: 0 });
    expect(all.wallet).toEqual({
      shards: add(after.wallet.shards, after.spent.shards),
      cores: after.wallet.cores + after.spent.cores,
      resonance: after.wallet.resonance + after.spent.resonance,
    });
    expect(Math.abs(all.wallet.shards - RICH.shards)).toBeLessThan(1e-6);
    expect(all.wallet.cores).toBe(RICH.cores);
  });

  it('refunds the ★ itself for its cores and nothing more, and drops the next prices to ×1', () => {
    const preview = refundPreview(fire15, DEEP, account, STAR);
    expect(preview).toEqual({ dropped: [STAR], refund: { shards: 0, cores: 3, resonance: 0 } });
    const after = refundNode(fire15, DEEP, account, STAR);
    expect(after.wallet).toEqual({ ...DEEP.wallet, cores: DEEP.wallet.cores + 3 });
    expect(after.spent).toEqual({ ...DEEP.spent, cores: DEEP.spent.cores - 3 });
    expect(Object.hasOwn(after.ranks, STAR)).toBe(false);
    expect(boardCounts(fire15, after).priceFactor).toBeUndefined();
    for (const node of fire15.nodes) {
      expect(nextPrice(fire15, after, node.id), node.id).toEqual(basePrice(after, node.id));
    }
    const check = canBuy(fire15, after, account, STEP_NEXT);
    expect(check).toEqual({ ok: true, price: basePrice(after, STEP_NEXT) });
    // Bought again, it prices ×1.5 once more.
    const again = buy(fire15, after, account, STAR);
    expect(nextPrice(fire15, again, STEP_NEXT)).toEqual(factored(basePrice(again, STEP_NEXT), 1.5));
  });

  it("legalizes after the ★'s refund keeping the other nodes, and refunds what drops unfactored", () => {
    const after = refundNode(fire15, DEEP, account, STAR);
    // The ★'s refund kept every node bought under it, and nothing more is illegal.
    expect(Object.keys(after.ranks).sort()).toEqual(
      Object.keys(DEEP.ranks)
        .filter((id) => id !== STAR)
        .sort(),
    );
    expect(legalize(fire15, after, account)).toEqual({ progress: after, dropped: [] });
    // A stored progress without STEP and MASTERY (cut by hand, unrefunded): STEP_NEXT hangs on
    // nothing and drops, refunded at today's price.
    const cut = cutOut(after, STEP, MASTERY);
    const legal = legalize(fire15, cut, account);
    expect(legal.dropped).toEqual([STEP_NEXT]);
    const refund = unfactoredDifference(cut, legal.progress);
    expect(gt(refund.shards, ZERO)).toBe(true);
    expect(legal.progress.wallet).toEqual({
      ...cut.wallet,
      shards: add(cut.wallet.shards, refund.shards),
    });
    expect(legal.progress.spent).toEqual({
      ...cut.spent,
      shards: sub(cut.spent.shards, refund.shards),
    });
    // With the ★ still owned, the same cut refunds the same unfactored amount.
    const owned = cutOut(DEEP, STEP, MASTERY);
    const legalOwned = legalize(fire15, owned, account);
    expect(legalOwned.dropped).toEqual([STEP_NEXT]);
    expect(unfactoredDifference(owned, legalOwned.progress)).toEqual(refund);
    expect(legalOwned.progress.wallet.shards).toEqual(add(owned.wallet.shards, refund.shards));
    expect(legalOwned.progress.spent.shards).toEqual(sub(owned.spent.shards, refund.shards));
  });

  it('legalize dropping the ★ refunds its 3 cores alone and takes its factor off', () => {
    // A stored progress whose ★ hangs on nothing: its answer ◆ is gone (cut by hand, unrefunded).
    const cut = cutOut(DEEP, COUNTER);
    expect(boardCounts(fire15, cut).priceFactor).toBe(1.5);
    const legal = legalize(fire15, cut, account);
    expect(legal.dropped).toEqual([STAR]);
    expect(legal.progress.wallet).toEqual({ ...cut.wallet, cores: cut.wallet.cores + 3 });
    expect(legal.progress.spent).toEqual({ ...cut.spent, cores: cut.spent.cores - 3 });
    expect(nextPrice(fire15, legal.progress, STEP_NEXT)).toEqual(
      basePrice(legal.progress, STEP_NEXT),
    );
  });
});

describe('only the owning character’s web (G2)', () => {
  const hive15 = withFactors(hive, { [STAR]: 1.5 });
  const HIVE = sampleProgress(hive, createRng(7), {
    account,
    purchases: 40,
    bestWave: 30,
    prestiged: true,
  });

  it("prices another character's web as today whichever web was priced before", () => {
    expect(storedRankOf(HIVE, STAR)).toBe(0);
    for (let round = 0; round < 2; round++) {
      for (const node of hive15.nodes) {
        expect(nextPrice(hive15, HIVE, node.id), node.id).toEqual(basePrice(HIVE, node.id, hive));
      }
      expect(nextPrice(fire15, UNDER, STEP_NEXT)).toEqual(
        factored(basePrice(UNDER, STEP_NEXT), 1.5),
      );
    }
    // 蜂巢 owning its own ★ is factored on its web alone.
    const route = shortestRoute(hive15, start('summon'), STAR, (n) => !GATED_KINDS.has(n.kind));
    const owner = bought(hive15, route ?? [], start('summon'));
    expect(boardCounts(hive15, owner).priceFactor).toBe(1.5);
    const fireBefore = bought(fire15, ROUTE.slice(0, -1));
    for (const node of fire15.nodes) {
      expect(nextPrice(fire15, fireBefore, node.id)).toEqual(basePrice(fireBefore, node.id));
    }
  });
});

describe('the purchase helpers under the factor (G3)', () => {
  it("credits an audit purchase (invest.ts) with the factored price, as canBuy's", () => {
    const step = auditBuy(
      fire15,
      { ...OWNED, wallet: { shards: ZERO, cores: 0, resonance: 0 } },
      account,
      STEP,
    );
    expect(step.ok).toBe(true);
    if (!step.ok) return;
    const price = factored(basePrice(OWNED, STEP), 1.5);
    expect(step.progress.spent.shards).toEqual(add(OWNED.spent.shards, price.shards));
    expect(step.progress.wallet.shards).toEqual(sub(add(ZERO, price.shards), price.shards));
  });

  it('replays an order through the ★ with every purchase after it factored (progressFromOrder)', () => {
    const order = [...ROUTE, STEP, MASTERY, MIGHT, MIGHT];
    const replayed = progressFromOrder(fire15, account, order);
    expect(replayed.ranks).toEqual(UNDER.ranks);
    expect(replayed.spent).toEqual(UNDER.spent);
    const plain = progressFromOrder(fire, account, order);
    const extra = [STEP, MASTERY, MIGHT, MIGHT].reduce((acc, id, i, ids) => {
      const before = bought(fire, ids.slice(0, i), OWNED);
      return add(acc, mul(basePrice(before, id).shards, 0.5));
    }, ZERO);
    expect(Math.abs(replayed.spent.shards - plain.spent.shards - extra)).toBeLessThan(1e-9);
  });

  it('prices a planned path through a factor ◆ step by step: ×1 up to it, × its factor after', () => {
    const web = withFactors(fire, { [NOTABLE]: 1.5 });
    const at = ROUTE.indexOf(NOTABLE);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(ROUTE.length - 1);
    // Each step at the progress the steps before it leave, not at the path's start.
    let progress = start();
    let shards = ZERO;
    ROUTE.forEach((id, k) => {
      const today = basePrice(progress, id).shards;
      shards = add(shards, k <= at ? today : mul(today, 1.5));
      progress = bought(fire, [id], progress);
    });
    expect(gt(shards, OWNED.spent.shards)).toBe(true);
    expect(planPath(web, start(), account, STAR)).toEqual({
      ok: true,
      ids: ROUTE,
      price: { ...OWNED.spent, shards },
    });
    expect(buyPath(web, start(), account, STAR).spent).toEqual({ ...OWNED.spent, shards });
  });

  it('plans a path after the ★ at the factored prices and a path to it at today’s', () => {
    const to = planPath(fire15, start(), account, STAR);
    expect(to).toEqual({ ok: true, ids: ROUTE, price: { ...OWNED.spent } });
    const after = planPath(fire15, OWNED, account, STEP_NEXT);
    const first = factored(basePrice(OWNED, STEP), 1.5);
    const second = factored(basePrice(bought(fire, [STEP], OWNED), STEP_NEXT), 1.5);
    expect(after).toEqual({
      ok: true,
      ids: [STEP, STEP_NEXT],
      price: { shards: add(first.shards, second.shards), cores: 0, resonance: 0 },
    });
    expect(buyPath(fire15, OWNED, account, STEP_NEXT).spent.shards).toEqual(
      add(OWNED.spent.shards, add(first.shards, second.shards)),
    );
  });
});
