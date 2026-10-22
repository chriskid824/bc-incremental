import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../core/num';
import { assembleWeb } from '../../data/web/assemble';
import { FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import type { WebNodeKind } from '../../data/web/types';
import {
  canonicalCost,
  DEFAULT_WEB_ECONOMY,
  economyIssues,
  nextPrice,
  PRICE_CURVE_OF,
} from './price';
import { buy, emptyProgress } from './rules';
import type { AccountProgress, CharacterProgress, Price, WebEconomy } from './types';

const fire = assembleWeb(fixtureContent(), 'fire', FULL_SCOPE);
const account: AccountProgress = { singularityBeaten: false };

/** `ranks` owned, a wallet that buys anything, every outer revealed and a prestige. */
const owning = (ranks: Readonly<Record<string, number>> = {}): CharacterProgress => ({
  ...emptyProgress('fire'),
  ranks,
  wallet: { shards: num(1e30), cores: 1e6, resonance: 1e6 },
  bestWave: 30,
  prestiges: 1,
});

const relative = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);

/** k purchases of a curve: base × (g^k − 1) / (g − 1). */
const closed = (base: number, growth: number, k: number): number =>
  (base * (growth ** k - 1)) / (growth - 1);

/** `ids` bought in order from `start`, with the nextPrice of each before its purchase. */
function buyAll(
  ids: readonly string[],
  start = owning(),
): { progress: CharacterProgress; paid: Price[] } {
  let progress = start;
  const paid: Price[] = [];
  for (const id of ids) {
    paid.push(nextPrice(fire, progress, id));
    progress = buy(fire, progress, account, id);
  }
  return { progress, paid };
}

const C = 'fire.center';
/** Ten step purchases (one notable, two ranked nodes twice), and the same in another order. */
const ORDER_A = [
  `${C}.alpha.r1`,
  `${C}.alpha.r1`,
  `${C}.alpha.r2`,
  `${C}.alpha.alpha-one`,
  `${C}.beta.r1`,
  `${C}.beta.r2`,
  `${C}.beta.r2`,
  `${C}.gamma.r1`,
  `${C}.alpha.r3`,
  `${C}.main.c1`,
];
const ORDER_B = [
  `${C}.gamma.r1`,
  `${C}.beta.r1`,
  `${C}.alpha.r1`,
  `${C}.beta.r2`,
  `${C}.alpha.r2`,
  `${C}.alpha.r1`,
  `${C}.alpha.alpha-one`,
  `${C}.beta.r2`,
  `${C}.alpha.r3`,
  `${C}.main.c1`,
];

describe('step prices (D19)', () => {
  it('cost the closed form for k purchases in any order', () => {
    const a = buyAll(ORDER_A);
    const b = buyAll(ORDER_B);
    expect(a.progress.ranks).toEqual(b.progress.ranks);
    const k10 = closed(180, 1.31, 10);
    for (const { progress } of [a, b]) {
      expect(relative(toNumber(progress.spent.shards), k10)).toBeLessThan(1e-12);
      expect(progress.spent.cores).toBe(1);
      expect(relative(toNumber(canonicalCost(fire, progress).shards), k10)).toBeLessThan(1e-12);
    }
    // Purchase k costs base × growth^k, whatever node it is.
    a.paid.forEach((price, k) => expect(toNumber(price.shards)).toBe(1.31 ** k * 180));
  });

  it('make canonicalCost the sum of the nextPrices that built it', () => {
    const ids = [
      ...ORDER_A,
      `${C}.alpha.r4`,
      `${C}.alpha.alpha-two`,
      `${C}.alpha.mastery`,
      `${C}.alpha.mastery`,
      `${C}.alpha.mastery`,
      'hub.defense.r1',
      'hub.might.might',
      'hub.might.might',
      `${C}.main.star-one`,
      'fire.asc.path-one.n1',
      'fire.asc.path-one.n2',
    ];
    const { progress, paid } = buyAll(ids);
    const cost = canonicalCost(fire, progress);
    const sum = paid.reduce((total, price) => total + toNumber(price.shards), 0);
    expect(relative(toNumber(cost.shards), sum)).toBeLessThan(1e-12);
    expect(cost.cores).toBe(paid.reduce((total, price) => total + price.cores, 0));
    expect(cost.cores).toBe(1 + 1 + 3);
    expect(cost.resonance).toBe(2);
    expect(relative(toNumber(cost.shards), toNumber(progress.spent.shards))).toBeLessThan(1e-12);
    expect(cost.cores).toBe(progress.spent.cores);
    expect(cost.resonance).toBe(progress.spent.resonance);
  });

  it('count nothing for the signature or ids outside the web', () => {
    const cost = canonicalCost(fire, owning({ [fire.root]: 1, 'fire.center.alpha.nope': 2 }));
    expect(cost).toEqual({ shards: 0, cores: 0, resonance: 0 });
  });
});

describe('nextPrice', () => {
  /** Three step purchases, mastery ranks 2 and 1 (3), might rank 1. */
  const counted = owning({
    [`${C}.alpha.r1`]: 2,
    [`${C}.alpha.r2`]: 1,
    [`${C}.alpha.mastery`]: 2,
    [`${C}.beta.mastery`]: 1,
    'hub.might.might': 1,
  });
  const step = 1.31 ** 3 * 180;
  const PRICES: readonly (readonly [WebNodeKind, string, number, number, number])[] = [
    ['ranked', `${C}.beta.r1`, step, 0, 0],
    ['notable', `${C}.beta.beta-one`, step, 1, 0],
    ['threshold', `${C}.main.threshold`, step, 2, 0],
    ['entry', 'outer.poison.main.entry', step, 0, 0],
    ['core', 'fusion.fire.poison.core', step, 1, 0],
    ['mastery', `${C}.gamma.mastery`, 1.4 ** 3 * 300, 0, 0],
    ['might', 'hub.might.might', 1.4 ** 1 * 300, 0, 0],
    ['keystone', `${C}.main.star-one`, 0, 3, 0],
    ['asc', 'fire.asc.path-one.n1', 0, 0, 1],
    ['ascFinal', 'fire.asc.path-two.final', 0, 0, 1],
    ['signature', fire.root, 0, 0, 0],
  ];

  it.each(PRICES)('prices kind %s on its curve, with its cores and 迴響', (kind, id, s, c, r) => {
    expect(fire.byId.get(id)?.kind).toBe(kind);
    const price = nextPrice(fire, counted, id);
    expect({ ...price, shards: toNumber(price.shards) }).toEqual({
      shards: s,
      cores: c,
      resonance: r,
    });
  });

  it('puts every kind on one of three curves or none (★, ascendancy and signature cost no shards)', () => {
    expect(PRICE_CURVE_OF).toEqual({
      signature: null,
      ranked: 'step',
      notable: 'step',
      threshold: 'step',
      keystone: null,
      mastery: 'mastery',
      might: 'might',
      entry: 'step',
      core: 'step',
      asc: null,
      ascFinal: null,
    });
    expect(PRICES.map(([kind]) => kind).sort()).toEqual(Object.keys(PRICE_CURVE_OF).sort());
  });

  it('reads the economy it is given', () => {
    const economy: WebEconomy = {
      ...DEFAULT_WEB_ECONOMY,
      step: { base: 10, growth: 2 },
      cores: { ...DEFAULT_WEB_ECONOMY.cores, ranked: 4 },
    };
    expect(nextPrice(fire, counted, `${C}.beta.r1`, economy)).toEqual({
      shards: 80,
      cores: 4,
      resonance: 0,
    });
  });

  it('throws for an id outside the web', () => {
    expect(() => nextPrice(fire, counted, 'fire.center.alpha.nope')).toThrow(
      "nextPrice: 'fire.center.alpha.nope' is not a node of web 'fire' in scope 'full'",
    );
  });
});

describe('economyIssues (V16, S-3)', () => {
  const at = "economy 'DEFAULT_WEB_ECONOMY'";

  it('passes DEFAULT_WEB_ECONOMY and its 初始值', () => {
    expect(economyIssues(DEFAULT_WEB_ECONOMY)).toEqual([]);
    expect(DEFAULT_WEB_ECONOMY.step).toEqual({ base: 180, growth: 1.31 });
    expect(DEFAULT_WEB_ECONOMY.mastery).toEqual({ base: 300, growth: 1.4 });
    expect(DEFAULT_WEB_ECONOMY.might).toEqual({ base: 300, growth: 1.4 });
    expect(DEFAULT_WEB_ECONOMY.startWaveRatio).toBe(0.5);
    expect(DEFAULT_WEB_ECONOMY.skipRewardRate).toBe(1);
  });

  it('reports a growth of 1 with its message', () => {
    const economy = { ...DEFAULT_WEB_ECONOMY, step: { base: 180, growth: 1 } };
    expect(economyIssues(economy)).toEqual([`${at}: step.growth 1 must be above 1`]);
  });

  it.each([
    ['mastery', { base: 0, growth: 1.4 }, [`${at}: mastery.base 0 must be above 0`]],
    ['might', { base: 300, growth: 0.9 }, [`${at}: might.growth 0.9 must be above 1`]],
    [
      'step',
      { base: -1, growth: 1 },
      [`${at}: step.base -1 must be above 0`, `${at}: step.growth 1 must be above 1`],
    ],
    [
      'step',
      { base: 1e308, growth: 10 },
      [`${at}: step price Infinity at count 1 must be above 1e+308 at count 0 and finite`],
    ],
  ] as const)('reports a %s curve of %o', (curve, value, issues) => {
    expect(economyIssues({ ...DEFAULT_WEB_ECONOMY, [curve]: value })).toEqual(issues);
  });

  it('reports cores and 迴響 per kind off their pinned values, under the name given', () => {
    const economy: WebEconomy = {
      ...DEFAULT_WEB_ECONOMY,
      cores: { ...DEFAULT_WEB_ECONOMY.cores, keystone: 2, threshold: 3, notable: 0, core: 2 },
      resonance: { ...DEFAULT_WEB_ECONOMY.resonance, asc: 0, ascFinal: 2 },
    };
    expect(economyIssues(economy, 'probe')).toEqual([
      "economy 'probe': cores.keystone 2 must be 3",
      "economy 'probe': cores.threshold 3 must be 2",
      "economy 'probe': cores.notable 0 must be 1",
      "economy 'probe': cores.core 2 must be 1",
      "economy 'probe': resonance.asc 0 must be 1",
      "economy 'probe': resonance.ascFinal 2 must be 1",
    ]);
  });
});
