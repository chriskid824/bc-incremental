import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, OUTER_IDS } from '../../data/sources';
import type { CharacterId } from '../../data/sources';
import { assembleWeb } from '../../data/web/assemble';
import { DEMO_SCOPE_A, FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import type { AssembledWeb, WebScope } from '../../data/web/types';
import { GATED_KINDS } from './counts';
import { defaultProgress, progressFromOrder, unlockInvestment } from './invest';
import { canonicalCost, nextPrice } from './price';
import { boardCounts, canBuy, fusionProgress } from './rules';
import type { AccountProgress, CharacterProgress } from './types';

const content = fixtureContent();
const fire = assembleWeb(content, 'fire', FULL_SCOPE);
const account: AccountProgress = { singularityBeaten: false };

/** `c`'s web with `defaultOrder` set on a copy of its fixture def (the fixture's is []). */
function withOrder(
  order: readonly string[],
  scope: WebScope = FULL_SCOPE,
  c: CharacterId = 'fire',
) {
  const def = { ...content.characters[c], defaultOrder: order };
  return assembleWeb({ ...content, characters: { ...content.characters, [c]: def } }, c, scope);
}

/** `web` without the edges between each pair. */
function cut(web: AssembledWeb, pairs: readonly (readonly [string, string])[]): AssembledWeb {
  const gone = new Set(pairs.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  const neighbours = new Map(
    [...web.neighbours].map(([id, list]) => [
      id,
      list.filter((other) => !gone.has(`${id}|${other}`)),
    ]),
  );
  return { ...web, edges: web.edges.filter(([a, b]) => !gone.has(`${a}|${b}`)), neighbours };
}

/** The audits' purchases end with an empty wallet and spent at the true cost (R3). */
function expectAudited(web: AssembledWeb, progress: CharacterProgress): void {
  expect(progress.wallet).toEqual({ shards: 0, cores: 0, resonance: 0 });
  const cost = canonicalCost(web, progress);
  expect(Math.abs(progress.spent.shards - cost.shards)).toBeLessThan(
    1e-9 * Math.max(1, cost.shards),
  );
  expect(progress.spent.cores).toBe(cost.cores);
  expect(progress.spent.resonance).toBe(cost.resonance);
}

const C = 'fire.center';
const ROUTE_C1 = [
  `${C}.alpha.r1`,
  `${C}.alpha.r2`,
  `${C}.alpha.alpha-one`,
  `${C}.alpha.r3`,
  `${C}.main.c1`,
];
const ROUTE_MIGHT = [...ROUTE_C1, 'hub.defense.r1', 'hub.might.might'];
/** An outer filled breadth-first from its entry to 6 counted nodes. */
const outerSix = (o: string): string[] => [
  `outer.${o}.alpha.r1`,
  `outer.${o}.beta.r1`,
  `outer.${o}.alpha.r2`,
  `outer.${o}.beta.r2`,
  `outer.${o}.alpha.alpha-one`,
];

describe('unlockInvestment (D26)', () => {
  it('buys fire.poison’s gate: the route through the hub, the center to 8, the outer to 6', () => {
    const progress = unlockInvestment(fire, account, 'poison');
    expect(Object.entries(progress.ranks)).toEqual(
      [
        ...ROUTE_C1,
        'hub.defense.r1',
        'outer.poison.main.entry',
        `${C}.alpha.r4`,
        `${C}.alpha.r5`,
        `${C}.beta.r1`,
        ...outerSix('poison'),
      ].map((id) => [id, 1]),
    );
    expect(fusionProgress(fire, progress, 'poison')).toEqual({
      center: 8,
      centerNeed: 8,
      outer: 6,
      outerNeed: 6,
      unlocked: true,
    });
    const core = 'fusion.fire.poison.core';
    const price = nextPrice(fire, progress, core);
    const credited = {
      ...progress,
      wallet: { ...progress.wallet, shards: price.shards, cores: price.cores },
    };
    expect(canBuy(fire, credited, account, core).ok).toBe(true);
    expect(progress).toMatchObject({ bestWave: 30, prestiges: 0, ascendancy: null });
    expectAudited(fire, progress);
  });

  it('buys fire.ice’s gate through the economy ring', () => {
    expect(Object.keys(unlockInvestment(fire, account, 'ice').ranks)).toEqual([
      `${C}.beta.r1`,
      `${C}.beta.r2`,
      `${C}.beta.beta-one`,
      `${C}.beta.r3`,
      `${C}.main.c3`,
      'hub.economy.r1',
      'hub.economy.r2',
      'outer.ice.main.entry',
      `${C}.alpha.r1`,
      `${C}.beta.r4`,
      `${C}.beta.r5`,
      ...outerSix('ice'),
    ]);
  });

  it('takes defaultOrder’s center nodes first, each once, while fewer than 8 are counted', () => {
    const order = [
      `${C}.gamma.r1`,
      `${C}.gamma.r2`,
      `${C}.gamma.r2`,
      'hub.echo.r1',
      `${C}.gamma.gamma-one`,
      `${C}.gamma.r3`,
      `${C}.main.c5`,
    ];
    expect(Object.entries(unlockInvestment(withOrder(order), account, 'summon').ranks)).toEqual(
      [
        `${C}.gamma.r1`,
        `${C}.gamma.r2`,
        `${C}.gamma.gamma-one`,
        `${C}.gamma.r3`,
        `${C}.main.c5`,
        'hub.echo.r2',
        'outer.summon.main.entry',
        `${C}.alpha.r1`,
        `${C}.beta.r1`,
        `${C}.gamma.r4`,
        ...outerSix('summon'),
      ].map((id) => [id, 1]),
    );
    // A refused one (c4 before its neighbour) is passed over; the ninth is never reached; the
    // route's own center node still counts as it comes.
    const long = [
      `${C}.main.c4`,
      `${C}.gamma.r1`,
      `${C}.gamma.r2`,
      `${C}.gamma.gamma-one`,
      `${C}.gamma.r5`,
      `${C}.gamma.r3`,
      `${C}.gamma.r4`,
      `${C}.gamma.gamma-two`,
      `${C}.gamma.r6`,
      `${C}.gamma.gamma-three`,
    ];
    const progress = unlockInvestment(withOrder(long), account, 'summon');
    expect(Object.keys(progress.ranks).slice(0, 10)).toEqual([
      ...long.slice(1, 9),
      `${C}.main.c5`,
      'hub.echo.r2',
    ]);
    expect(boardCounts(fire, progress).center).toBe(9);
  });

  it('routes round a gated kind on a tie: fire.lightning from c1 by the defense ring, not ★ one', () => {
    const progress = unlockInvestment(withOrder(ROUTE_C1), account, 'lightning');
    expect(Object.entries(progress.ranks)).toEqual(
      [
        ...ROUTE_C1,
        'hub.defense.r1',
        'hub.defense.r2',
        'hub.defense.r3',
        'outer.lightning.main.entry',
        `${C}.alpha.r4`,
        `${C}.alpha.r5`,
        `${C}.beta.r1`,
        ...outerSix('lightning'),
      ].map((id) => [id, 1]),
    );
  });

  it('meets every fusion’s gate with 8 center and 6 outer nodes at rank 1, no core and no gated kind', () => {
    for (const c of CHARACTER_IDS) {
      const web = assembleWeb(content, c, FULL_SCOPE);
      for (const o of OUTER_IDS.filter((outer) => outer !== c)) {
        const progress = unlockInvestment(web, account, o);
        const counts = boardCounts(web, progress);
        expect([counts.center, counts.outers[o]], `${c}.${o}`).toEqual([8, 6]);
        expect(counts.cores + counts.keystones, `${c}.${o}`).toBe(0);
        for (const [id, rank] of Object.entries(progress.ranks)) {
          expect(rank, id).toBe(1);
          expect(GATED_KINDS.has(web.byId.get(id)?.kind ?? 'core'), id).toBe(false);
        }
      }
    }
  });

  it('throws when the fusion is not in the web or its gate cannot be met', () => {
    expect(() =>
      unlockInvestment(assembleWeb(content, 'fire', DEMO_SCOPE_A), account, 'bleed'),
    ).toThrow(
      "unlockInvestment 'fire.bleed' (scope 'demoA'): the fusion or its outer's entry is not in web 'fire'",
    );
    const entry = 'outer.poison.main.entry';
    const island = cut(fire, [['hub.defense.r1', entry]]);
    expect(() => unlockInvestment(island, account, 'poison')).toThrow(`no path reaches '${entry}'`);
    const bare = cut(fire, [
      [entry, 'outer.poison.alpha.r1'],
      [entry, 'outer.poison.beta.r1'],
    ]);
    expect(() => unlockInvestment(bare, account, 'poison')).toThrow(
      "unlockInvestment 'fire.poison' (scope 'full'): its gate is not met, center 8 of 8 and 'outer.poison' 1 of 6",
    );
  });
});

describe('defaultProgress', () => {
  const order = [
    `${C}.alpha.r1`,
    `${C}.alpha.r1`,
    `${C}.alpha.r2`,
    `${C}.alpha.alpha-one`,
    `${C}.beta.r1`,
    `${C}.gamma.r1`,
  ];
  const web = withOrder(order);

  it('buys the first count purchases of defaultOrder, or all of them', () => {
    expect(defaultProgress(web, account, 3).ranks).toEqual({
      [`${C}.alpha.r1`]: 2,
      [`${C}.alpha.r2`]: 1,
    });
    const all = defaultProgress(web, account);
    expect(all.ranks).toEqual({
      [`${C}.alpha.r1`]: 2,
      [`${C}.alpha.r2`]: 1,
      [`${C}.alpha.alpha-one`]: 1,
      [`${C}.beta.r1`]: 1,
      [`${C}.gamma.r1`]: 1,
    });
    expectAudited(web, all);
    expect(defaultProgress(web, account, 99)).toEqual(all);
    expect(defaultProgress(web, account, 0).ranks).toEqual({});
    expect(defaultProgress(web, account, -1).ranks).toEqual({});
    expect(defaultProgress(fire, account).ranks).toEqual({});
  });
});

describe('progressFromOrder', () => {
  it('buys an order from empty, ranks by repetition, at the audits’ best wave', () => {
    const order = [
      ...ROUTE_C1,
      `${C}.alpha.r1`,
      'hub.defense.r1',
      'hub.defense.r2',
      'outer.bleed.main.entry',
    ];
    const progress = progressFromOrder(fire, account, order);
    expect(progress.ranks[`${C}.alpha.r1`]).toBe(2);
    expect(progress).toMatchObject({ bestWave: 30, prestiges: 0, cycleBest: 0, runs: 0 });
    expectAudited(fire, progress);
    // The best wave is 30, or the scope's cap below it.
    const capped = assembleWeb(content, 'fire', { ...FULL_SCOPE, name: 'capped', waveCap: 20 });
    expect(() => progressFromOrder(capped, account, order)).toThrow(
      "progressFromOrder (character 'fire', scope 'capped'): order[8] 'outer.bleed.main.entry' refused: hidden",
    );
  });

  it.each([
    [[`${C}.alpha.r1`, `${C}.alpha.alpha-one`], 1, 'notAdjacent'],
    [[`${C}.alpha.r1`, `${C}.alpha.r1`, `${C}.alpha.r1`, `${C}.alpha.r1`], 3, 'maxRank'],
    [['nope'], 0, 'unknown'],
    [[...ROUTE_C1, `${C}.main.threshold`], 5, 'notAdjacent'],
    [[...ROUTE_C1, `${C}.main.star-one`, `${C}.main.star-one`], 6, 'owned'],
  ] as const)('throws at the first refusal with its reason: %o', (order, index, reason) => {
    expect(() => progressFromOrder(fire, account, order)).toThrow(
      `progressFromOrder (character 'fire', scope 'full'): order[${index}] '${order[index]}' refused: ${reason}`,
    );
  });

  it('gives an order with an ascendancy node a prestige, its chain chosen first (R3)', () => {
    const progress = progressFromOrder(fire, account, [
      ...ROUTE_MIGHT,
      'fire.asc.path-one.n1',
      'fire.asc.path-one.n2',
    ]);
    expect(progress).toMatchObject({
      prestiges: 1,
      ascendancy: 'path-one',
      spent: { resonance: 2 },
    });
    expect(() =>
      progressFromOrder(fire, account, [
        ...ROUTE_MIGHT,
        'fire.asc.path-one.n1',
        'fire.asc.path-two.n1',
      ]),
    ).toThrow("order[8] 'fire.asc.path-two.n1' refused: otherAscendancy");
  });

  it('changes nothing it is given', () => {
    const order = Object.freeze([...ROUTE_MIGHT]);
    const frozen = Object.freeze({ ...account });
    expect(() => progressFromOrder(fire, frozen, order)).not.toThrow();
    expect(order).toEqual(ROUTE_MIGHT);
  });
});
