import { describe, expect, it } from 'vitest';
import { add, num, sub, toNumber, ZERO } from '../../core/num';
import { assembleWeb } from '../../data/web/assemble';
import { DEMO_SCOPE_A, FULL_SCOPE } from '../../data/web/scope';
import { fixtureContent } from '../../data/web/testing';
import type { AssembledWeb, BoardId } from '../../data/web/types';
import { canonicalCost, DEFAULT_WEB_ECONOMY } from './price';
import {
  boardCounts,
  BUY_REASONS,
  buy,
  canBuy,
  CHALLENGE_RULES,
  emptyProgress,
  fusionProgress,
  fusionSlotOrder,
  fusionSlots,
  legalize,
  refundAll,
  refundNode,
  refundPreview,
  WEB_RULES,
} from './rules';
import type { BuyReason } from './rules';
import type {
  AccountProgress,
  BuyCheck,
  ChallengeRules,
  CharacterProgress,
  GateProgress,
  Wallet,
  WebEconomy,
} from './types';

const content = fixtureContent();
const fire = assembleWeb(content, 'fire', FULL_SCOPE);
const fireA = assembleWeb(content, 'fire', DEMO_SCOPE_A);
const account: AccountProgress = { singularityBeaten: false };
const beaten: AccountProgress = { singularityBeaten: true };
const RICH: Wallet = { shards: num(1e6), cores: 1000, resonance: 1000 };
const EMPTY: Wallet = { shards: ZERO, cores: 0, resonance: 0 };

const ones = (...ids: readonly string[]): Record<string, number> =>
  Object.fromEntries(ids.map((id) => [id, 1]));

/** `ranks` owned (hand-built, legal or not), a wallet that buys anything, best wave 30. */
const owning = (
  ranks: Readonly<Record<string, number>>,
  extra: Partial<CharacterProgress> = {},
): CharacterProgress => ({ ...emptyProgress('fire'), ranks, wallet: RICH, bestWave: 30, ...extra });

/** `ids` bought in order, each through canBuy. */
const bought = (ids: readonly string[], start = owning({}), acc = account): CharacterProgress =>
  ids.reduce((progress, id) => buy(fire, progress, acc, id), start);

const relative = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);
/** k step purchases: 180 × (1.31^k − 1) / 0.31. */
const steps = (k: number): number => (180 * (1.31 ** k - 1)) / 0.31;

const C = 'fire.center';
const MIGHT = 'hub.might.might';
const THRESHOLD = `${C}.main.threshold`;
const STAR_ONE = `${C}.main.star-one`;
const STAR_TWO = `${C}.main.star-two`;
const RULE_ONE = 'hub.rules.rule-one';
const ROUTE_C1 = [
  `${C}.alpha.r1`,
  `${C}.alpha.r2`,
  `${C}.alpha.alpha-one`,
  `${C}.alpha.r3`,
  `${C}.main.c1`,
];
const ROUTE_C3 = [
  `${C}.beta.r1`,
  `${C}.beta.r2`,
  `${C}.beta.beta-one`,
  `${C}.beta.r3`,
  `${C}.main.c3`,
];
const ROUTE_MIGHT = [...ROUTE_C1, 'hub.defense.r1', MIGHT];
/** Eight center nodes, c1 (next to the poison spoke) among them. */
const CENTER_8 = [...ROUTE_C1, `${C}.alpha.r4`, `${C}.alpha.r5`, `${C}.beta.r1`];
/** Twelve center nodes, c3 (next to the threshold) among them, in an order buy accepts. */
const CENTER_12 = [...ROUTE_C3, ...ROUTE_C1, `${C}.alpha.r4`, `${C}.gamma.r1`];
const CENTER_11 = CENTER_12.slice(0, 11);
/** outer.poison from its entry, in an order buy accepts (the counter sits next to its threshold). */
const POISON = [
  'outer.poison.main.entry',
  'outer.poison.alpha.r1',
  'outer.poison.alpha.r2',
  'outer.poison.alpha.alpha-one',
  'outer.poison.alpha.alpha-two',
  'outer.poison.main.counter',
  'outer.poison.beta.r1',
  'outer.poison.beta.r2',
] as const;
const POISON_THRESHOLD = 'outer.poison.main.threshold';
const PATH_ONE = [
  'fire.asc.path-one.n1',
  'fire.asc.path-one.n2',
  'fire.asc.path-one.final',
] as const;
const PATH_TWO = [
  'fire.asc.path-two.n1',
  'fire.asc.path-two.n2',
  'fire.asc.path-two.final',
] as const;
const core = (outer: string): string => `fusion.fire.${outer}.core`;
/** Crit's entry owned through the beta branch and the economy ring; ice's entry next to it. */
const CRIT_OWNED = [...ROUTE_C3, 'hub.economy.r1', 'hub.economy.r2', 'outer.crit.main.entry'];

interface Args {
  readonly web?: AssembledWeb;
  readonly progress: CharacterProgress;
  readonly id: string;
  readonly account?: AccountProgress;
  readonly challenge?: ChallengeRules;
}
const check = (args: Args): BuyCheck =>
  canBuy(
    args.web ?? fire,
    args.progress,
    args.account ?? account,
    args.id,
    undefined,
    args.challenge,
  );

interface Row {
  readonly reason: BuyReason;
  /** canBuy's arguments that fail this row and no other. */
  readonly fails: Args;
  /** The same with the row's cause taken away: canBuy says ok. */
  readonly passes: Args;
  readonly gate?: GateProgress;
}

/** One fixture per reason of §4.5's rows, in their order. */
const ROWS: readonly Row[] = [
  {
    reason: 'unknown',
    fails: { progress: owning({}), id: `${C}.alpha.nope` },
    passes: { progress: owning({}), id: `${C}.alpha.r1` },
  },
  {
    reason: 'owned',
    fails: { progress: owning(ones(...ROUTE_C1)), id: `${C}.alpha.alpha-one` },
    passes: { progress: owning(ones(...ROUTE_C1.slice(0, 2))), id: `${C}.alpha.alpha-one` },
  },
  {
    reason: 'maxRank',
    fails: { progress: owning({ [`${C}.alpha.r1`]: 3 }), id: `${C}.alpha.r1` },
    passes: { progress: owning({ [`${C}.alpha.r1`]: 2 }), id: `${C}.alpha.r1` },
  },
  {
    reason: 'hidden',
    fails: {
      progress: owning(ones(...ROUTE_C1, 'hub.defense.r1'), { bestWave: 14 }),
      id: 'outer.poison.main.entry',
    },
    passes: {
      progress: owning(ones(...ROUTE_C1, 'hub.defense.r1'), { bestWave: 15 }),
      id: 'outer.poison.main.entry',
    },
  },
  {
    // R1: a locked board has no nodes, so the id is not in the web.
    reason: 'locked',
    fails: {
      web: fireA,
      progress: owning(ones(...ROUTE_C1, 'hub.defense.r1', 'hub.defense.r2')),
      id: 'outer.bleed.main.entry',
    },
    passes: {
      progress: owning(ones(...ROUTE_C1, 'hub.defense.r1', 'hub.defense.r2')),
      id: 'outer.bleed.main.entry',
    },
  },
  {
    reason: 'challengeKeystone',
    fails: { progress: owning(ones(...ROUTE_C1)), id: STAR_ONE, challenge: CHALLENGE_RULES },
    passes: { progress: owning(ones(...ROUTE_C1)), id: STAR_ONE },
  },
  {
    reason: 'challengeOuter',
    fails: {
      progress: owning(ones(...CRIT_OWNED)),
      id: 'outer.ice.main.entry',
      challenge: CHALLENGE_RULES,
    },
    passes: { progress: owning(ones(...CRIT_OWNED)), id: 'outer.ice.main.entry' },
  },
  {
    reason: 'needsPrestige',
    fails: { progress: owning(ones(...ROUTE_MIGHT)), id: PATH_ONE[0] },
    passes: { progress: owning(ones(...ROUTE_MIGHT), { prestiges: 1 }), id: PATH_ONE[0] },
  },
  {
    reason: 'otherAscendancy',
    fails: {
      progress: owning(ones(...ROUTE_MIGHT, PATH_ONE[0]), {
        prestiges: 1,
        ascendancy: 'path-one',
      }),
      id: PATH_TWO[0],
    },
    passes: { progress: owning(ones(...ROUTE_MIGHT), { prestiges: 1 }), id: PATH_TWO[0] },
  },
  {
    reason: 'notAdjacent',
    fails: { progress: owning({}), id: `${C}.alpha.r2` },
    passes: { progress: owning(ones(`${C}.alpha.r1`)), id: `${C}.alpha.r2` },
  },
  {
    reason: 'centerGate',
    fails: { progress: owning(ones(...CENTER_11)), id: THRESHOLD },
    passes: { progress: owning(ones(...CENTER_12)), id: THRESHOLD },
    gate: { center: 11, centerNeed: 12, outer: null, outerNeed: null },
  },
  {
    reason: 'outerGate',
    fails: {
      progress: owning(ones(...ROUTE_C1, 'hub.defense.r1', ...POISON.slice(0, 7))),
      id: POISON_THRESHOLD,
    },
    passes: {
      progress: owning(ones(...ROUTE_C1, 'hub.defense.r1', ...POISON)),
      id: POISON_THRESHOLD,
    },
    gate: { center: 5, centerNeed: 0, outer: 7, outerNeed: 8 },
  },
  {
    reason: 'fusionGate',
    fails: {
      progress: owning(ones(...CENTER_8.slice(0, 7), 'hub.defense.r1', ...POISON.slice(0, 6))),
      id: core('poison'),
    },
    passes: {
      progress: owning(ones(...CENTER_8, 'hub.defense.r1', ...POISON.slice(0, 6))),
      id: core('poison'),
    },
    gate: { center: 7, centerNeed: 8, outer: 6, outerNeed: 6 },
  },
  {
    reason: 'noFusionSlot',
    fails: {
      progress: owning(
        ones(...CENTER_8, 'hub.defense.r1', ...POISON.slice(0, 6), core('ice'), core('crit')),
      ),
      id: core('poison'),
    },
    passes: {
      progress: owning(
        ones(...CENTER_8, 'hub.defense.r1', ...POISON.slice(0, 6), core('ice'), core('crit')),
      ),
      id: core('poison'),
      account: beaten,
    },
  },
  {
    reason: 'keystoneCap',
    fails: { progress: owning(ones(...ROUTE_C1, STAR_TWO, RULE_ONE)), id: STAR_ONE },
    passes: { progress: owning(ones(...ROUTE_C1, STAR_TWO)), id: STAR_ONE },
  },
  {
    reason: 'notEnoughShards',
    fails: {
      progress: owning({}, { wallet: { ...EMPTY, shards: num(179.99) } }),
      id: `${C}.alpha.r1`,
    },
    passes: {
      progress: owning({}, { wallet: { ...EMPTY, shards: num(180) } }),
      id: `${C}.alpha.r1`,
    },
  },
  {
    reason: 'notEnoughCores',
    fails: {
      progress: owning(ones(...ROUTE_C1.slice(0, 2)), { wallet: { ...RICH, cores: 0 } }),
      id: `${C}.alpha.alpha-one`,
    },
    passes: {
      progress: owning(ones(...ROUTE_C1.slice(0, 2)), { wallet: { ...RICH, cores: 1 } }),
      id: `${C}.alpha.alpha-one`,
    },
  },
  {
    reason: 'notEnoughResonance',
    fails: {
      progress: owning(ones(...ROUTE_MIGHT), { prestiges: 1, wallet: EMPTY }),
      id: PATH_ONE[0],
    },
    passes: {
      progress: owning(ones(...ROUTE_MIGHT), { prestiges: 1, wallet: { ...EMPTY, resonance: 1 } }),
      id: PATH_ONE[0],
    },
  },
];

describe('canBuy (§4.5)', () => {
  it('has a reason per row, in the order of the rows', () => {
    expect(BUY_REASONS).toEqual([
      'unknown',
      'owned',
      'maxRank',
      'hidden',
      'locked',
      'challengeKeystone',
      'challengeOuter',
      'needsPrestige',
      'otherAscendancy',
      'notAdjacent',
      'centerGate',
      'outerGate',
      'fusionGate',
      'noFusionSlot',
      'keystoneCap',
      'notEnoughShards',
      'notEnoughCores',
      'notEnoughResonance',
    ]);
    expect(ROWS.map((row) => row.reason)).toEqual(BUY_REASONS);
  });

  it.each(ROWS)('refuses $reason on a fixture failing that row alone', (row) => {
    expect(check(row.fails)).toEqual({ ok: false, reason: row.reason, gate: row.gate ?? null });
    expect(check(row.passes)).toMatchObject({ ok: true });
  });

  /** Fixtures failing two rows, answered by the first. */
  const FIRSTS: readonly (readonly [string, BuyReason, Args])[] = [
    [
      'owned before hidden',
      'owned',
      {
        progress: owning(ones(...ROUTE_C1, 'hub.defense.r1', POISON[0]), { bestWave: 0 }),
        id: POISON[0],
      },
    ],
    [
      'maxRank before hidden',
      'maxRank',
      {
        progress: owning({ ...ones(POISON[0]), [POISON[1]]: 3 }, { bestWave: 0 }),
        id: POISON[1],
      },
    ],
    [
      'hidden before the challenge rows',
      'hidden',
      {
        progress: owning({}, { bestWave: 0 }),
        id: 'outer.poison.main.star',
        challenge: CHALLENGE_RULES,
      },
    ],
    [
      'hidden before notAdjacent',
      'hidden',
      { progress: owning({}, { bestWave: 0 }), id: 'fusion.fire.poison.r1' },
    ],
    [
      'challengeKeystone before challengeOuter',
      'challengeKeystone',
      {
        progress: owning(ones(...CRIT_OWNED)),
        id: 'outer.ice.main.star',
        challenge: CHALLENGE_RULES,
      },
    ],
    [
      'challengeKeystone before notAdjacent',
      'challengeKeystone',
      { progress: owning({}), id: STAR_ONE, challenge: CHALLENGE_RULES },
    ],
    [
      'challengeOuter before notAdjacent',
      'challengeOuter',
      {
        progress: owning(ones('outer.crit.main.entry')),
        id: 'outer.ice.alpha.r1',
        challenge: CHALLENGE_RULES,
      },
    ],
    [
      'needsPrestige before otherAscendancy',
      'needsPrestige',
      {
        progress: owning(ones(...ROUTE_MIGHT, PATH_ONE[0]), { ascendancy: 'path-one' }),
        id: PATH_TWO[0],
      },
    ],
    [
      'needsPrestige before notAdjacent',
      'needsPrestige',
      { progress: owning({}), id: PATH_ONE[1] },
    ],
    [
      'otherAscendancy before notAdjacent',
      'otherAscendancy',
      {
        progress: owning(ones(PATH_ONE[0]), { prestiges: 1, ascendancy: 'path-one' }),
        id: PATH_TWO[1],
      },
    ],
    ['notAdjacent before centerGate', 'notAdjacent', { progress: owning({}), id: THRESHOLD }],
    ['notAdjacent before outerGate', 'notAdjacent', { progress: owning({}), id: POISON_THRESHOLD }],
    ['notAdjacent before fusionGate', 'notAdjacent', { progress: owning({}), id: core('poison') }],
    [
      'notAdjacent before keystoneCap',
      'notAdjacent',
      { progress: owning(ones(STAR_TWO, RULE_ONE)), id: STAR_ONE },
    ],
    [
      'notAdjacent before the wallet',
      'notAdjacent',
      { progress: owning({}, { wallet: EMPTY }), id: `${C}.alpha.r2` },
    ],
    [
      'fusionGate before noFusionSlot',
      'fusionGate',
      {
        progress: owning(ones(...ROUTE_C1, 'hub.defense.r1', core('ice'), core('crit'))),
        id: core('poison'),
      },
    ],
    [
      'centerGate before the wallet',
      'centerGate',
      { progress: owning(ones(...CENTER_11), { wallet: EMPTY }), id: THRESHOLD },
    ],
    [
      'outerGate before the wallet',
      'outerGate',
      {
        progress: owning(ones(...ROUTE_C1, 'hub.defense.r1', ...POISON.slice(0, 7)), {
          wallet: EMPTY,
        }),
        id: POISON_THRESHOLD,
      },
    ],
    [
      'noFusionSlot before the wallet',
      'noFusionSlot',
      {
        progress: owning(
          ones(...CENTER_8, 'hub.defense.r1', ...POISON.slice(0, 6), core('ice'), core('crit')),
          { wallet: EMPTY },
        ),
        id: core('poison'),
      },
    ],
    [
      'keystoneCap before the wallet',
      'keystoneCap',
      { progress: owning(ones(...ROUTE_C1, STAR_TWO, RULE_ONE), { wallet: EMPTY }), id: STAR_ONE },
    ],
    [
      'notEnoughShards before notEnoughCores',
      'notEnoughShards',
      {
        progress: owning(ones(...ROUTE_C1.slice(0, 2)), { wallet: EMPTY }),
        id: `${C}.alpha.alpha-one`,
      },
    ],
  ];

  it.each(FIRSTS)('answers with the first failing row: %s', (_name, reason, args) => {
    expect(check(args)).toMatchObject({ ok: false, reason });
  });

  it('answers row 12 in its order, shards, cores, 迴響, on an economy charging all three', () => {
    // No kind of DEFAULT_WEB_ECONOMY costs both cores and 迴響; this one charges a ◆ 1 迴響 too.
    const economy: WebEconomy = {
      ...DEFAULT_WEB_ECONOMY,
      resonance: { ...DEFAULT_WEB_ECONOMY.resonance, notable: 1 },
    };
    const at = (wallet: Wallet): BuyCheck =>
      canBuy(
        fire,
        owning(ones(...ROUTE_C1.slice(0, 2)), { wallet }),
        account,
        `${C}.alpha.alpha-one`,
        economy,
      );
    const shards = num(1e6);
    expect(at(EMPTY)).toMatchObject({ ok: false, reason: 'notEnoughShards' });
    expect(at({ ...EMPTY, shards })).toMatchObject({ ok: false, reason: 'notEnoughCores' });
    expect(at({ ...EMPTY, shards, cores: 1 })).toMatchObject({
      ok: false,
      reason: 'notEnoughResonance',
    });
    expect(at({ shards, cores: 1, resonance: 1 })).toMatchObject({
      ok: true,
      price: { cores: 1, resonance: 1 },
    });
  });

  it('resolves ids outside the web through the id grammar (R1)', () => {
    const progress = owning({});
    const at = (web: AssembledWeb, id: string): string => {
      const result = canBuy(web, progress, account, id);
      return result.ok ? 'ok' : result.reason;
    };
    // demoA locks bleed, its fusion and every node either would have.
    expect(at(fireA, 'outer.bleed.main.entry')).toBe('locked');
    expect(at(fireA, 'outer.bleed.alpha.nope')).toBe('locked');
    expect(at(fireA, 'fusion.fire.bleed.core')).toBe('locked');
    // An open board, an absent one (B1 has not registered bleed) and no board at all: unknown.
    expect(at(fireA, 'outer.poison.alpha.nope')).toBe('unknown');
    const fireB1 = assembleWeb(fixtureContent('B1'), 'fire', FULL_SCOPE);
    expect(fireB1.boards.find((board) => board.id === 'outer.bleed')?.status).toBe('absent');
    expect(at(fireB1, 'outer.bleed.main.entry')).toBe('unknown');
    // A deferred fusion's board is locked (§4.5 row 3); its outer stays open.
    const deferred = assembleWeb(content, 'fire', {
      ...FULL_SCOPE,
      name: 'deferred',
      deferredFusions: ['fire.poison'],
    });
    expect(at(deferred, 'fusion.fire.poison.core')).toBe('locked');
    expect(at(deferred, 'fusion.fire.poison.r1')).toBe('locked');
    expect(deferred.byId.has('outer.poison.main.entry')).toBe(true);
    expect(at(fire, 'nope')).toBe('unknown');
    expect(at(fire, '')).toBe('unknown');
  });

  it('refuses the signature, and never a mastery or 強化∞ for its rank', () => {
    expect(canBuy(fire, owning({}), account, fire.root)).toMatchObject({ reason: 'owned' });
    const deep = owning(
      { ...ones(...ROUTE_MIGHT), [`${C}.alpha.r4`]: 3, [`${C}.alpha.alpha-two`]: 1 },
      { wallet: { ...RICH, shards: num(1e30) } },
    );
    expect(
      canBuy(
        fire,
        { ...deep, ranks: { ...deep.ranks, [`${C}.alpha.mastery`]: 50 } },
        account,
        `${C}.alpha.mastery`,
      ).ok,
    ).toBe(true);
    expect(
      canBuy(fire, { ...deep, ranks: { ...deep.ranks, [MIGHT]: 50 } }, account, MIGHT).ok,
    ).toBe(true);
  });

  it('never fires a challenge row without a ChallengeRules (F51)', () => {
    const open: ChallengeRules = { noKeystones: false, maxOuters: null };
    for (const row of ROWS.filter((r) => r.reason.startsWith('challenge'))) {
      expect(check({ ...row.fails, challenge: open }).ok).toBe(true);
      expect(check({ progress: row.fails.progress, id: row.fails.id }).ok).toBe(true);
    }
    expect(CHALLENGE_RULES).toEqual({ noKeystones: true, maxOuters: 1 });
    // Under the challenge, its own board stays open; a fusion's nodes follow through row 9.
    const crit = owning(ones(...CRIT_OWNED));
    expect(
      check({ progress: crit, id: 'outer.crit.alpha.r1', challenge: CHALLENGE_RULES }).ok,
    ).toBe(true);
    expect(
      check({
        progress: owning(ones(...CRIT_OWNED, ...CENTER_8)),
        id: core('ice'),
        challenge: CHALLENGE_RULES,
      }),
    ).toEqual({
      ok: false,
      reason: 'fusionGate',
      gate: { center: 12, centerNeed: 8, outer: 0, outerNeed: 6 },
    });
  });

  it('refuses only a ★ under noKeystones: a core and an ascendancy final follow their own rows', () => {
    const fused = owning(ones(...CENTER_8, 'hub.defense.r1', ...POISON.slice(0, 6)));
    expect(check({ progress: fused, id: core('poison'), challenge: CHALLENGE_RULES }).ok).toBe(
      true,
    );
    const ascended = owning(ones(...ROUTE_MIGHT, PATH_ONE[0], PATH_ONE[1]), { prestiges: 1 });
    expect(
      check({ progress: ascended, id: PATH_ONE[2], challenge: CHALLENGE_RULES }),
    ).toMatchObject({ ok: true, price: { resonance: 1 } });
  });

  it('carries a gate only on the gate rows', () => {
    for (const row of ROWS) {
      const result = check(row.fails);
      const gated = ['centerGate', 'outerGate', 'fusionGate'].includes(row.reason);
      expect(!result.ok && result.gate !== null, row.reason).toBe(gated);
    }
    expect(
      check({
        progress: owning(ones(...CENTER_8, 'hub.defense.r1', ...POISON.slice(0, 5))),
        id: core('poison'),
      }),
    ).toEqual({
      ok: false,
      reason: 'fusionGate',
      gate: { center: 8, centerNeed: 8, outer: 5, outerNeed: 6 },
    });
  });
});

describe('gates count distinct nodes (D18)', () => {
  it('counts nothing on empty progress', () => {
    expect(boardCounts(fire, emptyProgress('fire'))).toEqual({
      center: 0,
      outers: {},
      cores: 0,
      keystones: 0,
      stepPurchases: 0,
      masteryRanks: 0,
      mightRanks: 0,
    });
  });

  it('never counts the signature', () => {
    expect(boardCounts(fire, owning({ [fire.root]: 1 })).center).toBe(0);
    const signed = owning({ ...ones(...CENTER_11), [fire.root]: 1 });
    expect(check({ progress: signed, id: THRESHOLD })).toMatchObject({
      reason: 'centerGate',
      gate: { center: 11 },
    });
  });

  it('counts a node of any rank once, and every rank on its price curve', () => {
    expect(
      boardCounts(fire, owning({ [`${C}.alpha.mastery`]: 3, [`${C}.alpha.r1`]: 2, [MIGHT]: 4 })),
    ).toEqual({
      center: 2,
      outers: {},
      cores: 0,
      keystones: 0,
      stepPurchases: 2,
      masteryRanks: 3,
      mightRanks: 4,
    });
    const mastered = owning({ ...ones(...CENTER_12.slice(0, 10)), [`${C}.alpha.mastery`]: 3 });
    expect(check({ progress: mastered, id: THRESHOLD })).toMatchObject({
      reason: 'centerGate',
      gate: { center: 11 },
    });
  });

  it('counts no ascendancy node toward the center, whatever its slug', () => {
    // 'center' is a legal ascendancy slug (isSlug), which makes the board fire.asc.center.
    const renamed = (id: string): string => id.replace('fire.asc.path-one', 'fire.asc.center');
    const nodes = fire.nodes.map((node) => ({
      ...node,
      id: renamed(node.id),
      board: renamed(node.board) as BoardId,
    }));
    const web: AssembledWeb = {
      ...fire,
      nodes,
      byId: new Map(nodes.map((n) => [n.id, n])),
      neighbours: new Map(
        [...fire.neighbours].map(([id, list]) => [renamed(id), list.map(renamed)]),
      ),
    };
    const progress = owning(ones(...CENTER_11, 'fire.asc.center.n1'), { prestiges: 1 });
    expect(boardCounts(web, progress).center).toBe(11);
    expect(check({ web, progress, id: THRESHOLD })).toMatchObject({
      reason: 'centerGate',
      gate: { center: 11 },
    });
  });

  it('counts an outer node of any rank once toward its board and its fusion gate', () => {
    const ranked = owning({
      ...ones(...CENTER_8, 'hub.defense.r1', ...POISON.slice(0, 4)),
      'outer.poison.alpha.r1': 3,
    });
    expect(boardCounts(fire, ranked).outers).toEqual({ poison: 4 });
    expect(fusionProgress(fire, ranked, 'poison')).toMatchObject({ outer: 4, unlocked: false });
    expect(check({ progress: ranked, id: core('poison') })).toMatchObject({
      reason: 'fusionGate',
      gate: { outer: 4 },
    });
  });

  it('counts entries, connectors, ★ and thresholds on their boards, fusion and hub nodes on none', () => {
    const counts = boardCounts(
      fire,
      owning(
        ones(
          `${C}.main.c1`,
          STAR_ONE,
          THRESHOLD,
          'outer.poison.main.entry',
          'outer.poison.main.star',
          POISON_THRESHOLD,
          'outer.ice.main.entry',
          core('poison'),
          'fusion.fire.poison.r1',
          'fusion.fire.poison.mastery',
          'hub.defense.r1',
          RULE_ONE,
          PATH_ONE[0],
          PATH_ONE[2],
        ),
      ),
    );
    expect(counts).toEqual({
      center: 3,
      outers: { poison: 3, ice: 1 },
      cores: 1,
      keystones: 3,
      stepPurchases: 8,
      masteryRanks: 1,
      mightRanks: 0,
    });
  });

  it('counts no fusion node toward its outer', () => {
    const fused = owning({
      ...ones(...ROUTE_C1, 'hub.defense.r1', ...POISON.slice(0, 7), core('poison')),
      'fusion.fire.poison.r1': 3,
    });
    expect(check({ progress: fused, id: POISON_THRESHOLD })).toMatchObject({
      reason: 'outerGate',
      gate: { outer: 7 },
    });
  });

  it('counts an outer threshold toward its fusion gate', () => {
    const counted = owning(
      ones(...CENTER_8, 'hub.defense.r1', ...POISON.slice(0, 5), POISON_THRESHOLD),
    );
    expect(fusionProgress(fire, counted, 'poison')).toMatchObject({ outer: 6, unlocked: true });
    expect(check({ progress: counted, id: core('poison') }).ok).toBe(true);
  });

  it('never counts a threshold toward its own gate (legalize checks it as if not owned)', () => {
    const center = owning(ones(...CENTER_11, THRESHOLD));
    expect(legalize(fire, center, account).dropped).toEqual([THRESHOLD]);
    const outer = owning(
      ones(...ROUTE_C1, 'hub.defense.r1', ...POISON.slice(0, 7), POISON_THRESHOLD),
    );
    expect(legalize(fire, outer, account).dropped).toEqual([POISON_THRESHOLD]);
  });

  it('reads a stored rank that is not a number of at least 1 as not owned, and floors the rest', () => {
    const odd = owning({
      [`${C}.alpha.r1`]: 0,
      [`${C}.alpha.r2`]: -2,
      [`${C}.alpha.alpha-one`]: Number.NaN,
      [`${C}.alpha.r3`]: Infinity,
      [`${C}.beta.r1`]: 2.7,
      [`${C}.beta.r2`]: '3' as unknown as number,
    });
    expect(boardCounts(fire, odd)).toMatchObject({ center: 1, stepPurchases: 2 });
  });
});

describe('fusion slots and the ★ cap', () => {
  it('gives two fusion slots, three once any character has beaten 奇點', () => {
    expect(fusionSlots(account)).toBe(2);
    expect(fusionSlots(beaten)).toBe(3);
    const three = owning(
      ones(
        ...CENTER_8,
        'hub.defense.r1',
        ...POISON.slice(0, 6),
        core('ice'),
        core('crit'),
        core('greed'),
      ),
    );
    expect(check({ progress: three, id: core('poison'), account: beaten })).toEqual({
      ok: false,
      reason: 'noFusionSlot',
      gate: null,
    });
  });

  it('leaves a held core or ★ out of its own cap: legalize keeps two of each', () => {
    const capped = owning(
      ones(
        ...CENTER_8,
        ...ROUTE_C3,
        'hub.defense.r1',
        'hub.economy.r1',
        MIGHT,
        ...POISON.slice(0, 6),
        ...POISON.slice(0, 6).map((id) => id.replace('poison', 'crit')),
        core('poison'),
        core('crit'),
        STAR_ONE,
        RULE_ONE,
      ),
    );
    expect(boardCounts(fire, capped)).toMatchObject({ cores: 2, keystones: 2 });
    expect(legalize(fire, capped, account).dropped).toEqual([]);
  });

  it('caps ★ at two, cores and ascendancy finals being other kinds', () => {
    const others = owning(
      ones(...ROUTE_C1, STAR_TWO, core('ice'), core('crit'), PATH_ONE[2], PATH_TWO[2]),
    );
    expect(check({ progress: others, id: STAR_ONE }).ok).toBe(true);
    const hubStar = owning(ones(...ROUTE_MIGHT, STAR_ONE, 'outer.poison.main.star'));
    expect(check({ progress: hubStar, id: RULE_ONE })).toMatchObject({ reason: 'keystoneCap' });
  });
});

describe('ascendancy rules (F10)', () => {
  const prestiged = owning(ones(...ROUTE_MIGHT), {
    prestiges: 1,
    wallet: { ...RICH, resonance: 3 },
  });

  it('chooses the chain by its first purchase, at 1 迴響 a node', () => {
    const chosen = buy(fire, prestiged, account, PATH_ONE[0]);
    expect(chosen.ascendancy).toBe('path-one');
    expect(chosen.wallet.resonance).toBe(2);
    expect(chosen.spent.resonance).toBe(1);
    expect(check({ progress: chosen, id: PATH_TWO[0] })).toMatchObject({
      reason: 'otherAscendancy',
    });
    const final = bought(PATH_ONE.slice(1), chosen);
    expect(final.ascendancy).toBe('path-one');
    expect(final.wallet.resonance).toBe(0);
    expect(final.spent).toMatchObject({ shards: prestiged.spent.shards, cores: 0, resonance: 3 });
    // A purchase off the ascendancy boards chooses nothing.
    expect(buy(fire, prestiged, account, `${C}.alpha.r4`).ascendancy).toBeNull();
  });

  it('keeps the chain through refundNode and refundAll', () => {
    const chosen = bought(PATH_ONE.slice(0, 2), prestiged);
    const refunded = refundNode(fire, chosen, account, PATH_ONE[0]);
    expect(refunded.ranks).toEqual(prestiged.ranks);
    expect(refunded.ascendancy).toBe('path-one');
    expect(refunded.wallet.resonance).toBe(3);
    expect(check({ progress: refunded, id: PATH_TWO[0] })).toMatchObject({
      reason: 'otherAscendancy',
    });
    expect(refundAll(chosen).ascendancy).toBe('path-one');
  });

  it('reads the chain of the first owned ascendancy node when none is recorded', () => {
    const stored = owning(ones(...ROUTE_MIGHT, PATH_TWO[0]), { prestiges: 1 });
    expect(check({ progress: stored, id: PATH_ONE[0] })).toMatchObject({
      reason: 'otherAscendancy',
    });
    expect(check({ progress: stored, id: PATH_TWO[1] }).ok).toBe(true);
  });
});

describe('buy', () => {
  it('moves the price from the wallet to spent and adds one rank', () => {
    const start = owning({}, { wallet: { shards: num(10000), cores: 5, resonance: 0 } });
    const one = buy(fire, start, account, `${C}.alpha.r1`);
    expect(one.ranks).toEqual({ [`${C}.alpha.r1`]: 1 });
    expect(one.wallet).toEqual({ shards: 9820, cores: 5, resonance: 0 });
    expect(one.spent).toEqual({ shards: 180, cores: 0, resonance: 0 });
    const two = bought([`${C}.alpha.r1`, `${C}.alpha.r2`, `${C}.alpha.alpha-one`], one);
    expect(two.ranks).toEqual({
      [`${C}.alpha.r1`]: 2,
      [`${C}.alpha.r2`]: 1,
      [`${C}.alpha.alpha-one`]: 1,
    });
    const paid = 180 + 180 * 1.31 + 180 * 1.31 ** 2 + 180 * 1.31 ** 3;
    expect(relative(toNumber(two.spent.shards), paid)).toBeLessThan(1e-12);
    expect(relative(toNumber(two.wallet.shards), 10000 - paid)).toBeLessThan(1e-12);
    expect(two.wallet.cores).toBe(4);
    expect(two.spent.cores).toBe(1);
  });

  it('throws on a refusal with the reason, and changes nothing it is given', () => {
    const start = Object.freeze(owning({}));
    expect(() => buy(fire, start, account, `${C}.alpha.r2`)).toThrow(
      "buy 'fire.center.alpha.r2' (character 'fire', scope 'full'): notAdjacent",
    );
    expect(() =>
      buy(fire, owning(ones(...ROUTE_C1)), account, STAR_ONE, undefined, CHALLENGE_RULES),
    ).toThrow('challengeKeystone');
    const snapshot = structuredClone(start);
    buy(fire, start, account, `${C}.alpha.r1`);
    expect(start).toEqual(snapshot);
  });
});

/** `ranks` without `ids`. */
const without = (ranks: Readonly<Record<string, number>>, ids: readonly string[]) =>
  Object.fromEntries(Object.entries(ranks).filter(([id]) => !ids.includes(id)));

describe('refunds (F16)', () => {
  const ORDER_A = [
    `${C}.alpha.r1`,
    `${C}.alpha.r2`,
    `${C}.beta.r1`,
    `${C}.gamma.r1`,
    `${C}.gamma.r2`,
  ];
  const ORDER_B = [
    `${C}.gamma.r1`,
    `${C}.beta.r1`,
    `${C}.gamma.r2`,
    `${C}.alpha.r1`,
    `${C}.alpha.r2`,
  ];

  it('do not depend on purchase order', () => {
    const a = bought(ORDER_A);
    const b = bought(ORDER_B);
    for (const [id, refund] of [
      [`${C}.beta.r1`, 180 * 1.31 ** 4],
      [`${C}.gamma.r2`, 180 * 1.31 ** 4],
      [`${C}.alpha.r1`, steps(5) - steps(3)],
    ] as const) {
      const fromA = refundPreview(fire, a, account, id);
      expect(fromA).toEqual(refundPreview(fire, b, account, id));
      expect(relative(toNumber(fromA.refund.shards), refund)).toBeLessThan(1e-12);
      expect(refundNode(fire, a, account, id).ranks).toEqual(
        refundNode(fire, b, account, id).ranks,
      );
    }
  });

  it('return min(spent, canonicalCost(before) − canonicalCost(after)) per currency', () => {
    const progress = bought([...ROUTE_C1, 'hub.defense.r1', MIGHT, STAR_ONE]);
    const after = refundNode(fire, progress, account, `${C}.main.c1`);
    expect(after.ranks).toEqual(ones(...ROUTE_C1.slice(0, 4)));
    const before = canonicalCost(fire, progress);
    const now = canonicalCost(fire, after);
    expect(after.wallet.shards).toBe(add(progress.wallet.shards, sub(before.shards, now.shards)));
    expect(after.wallet.cores - progress.wallet.cores).toBe(3);
    expect(after.spent.cores).toBe(1);
    // Never more than was spent.
    const unpaid = { ...progress, spent: { shards: num(100), cores: 1, resonance: 0 } };
    const capped = refundPreview(fire, unpaid, account, `${C}.main.c1`).refund;
    expect(capped).toEqual({ shards: 100, cores: 1, resonance: 0 });
  });

  it('price what drops on the economy given', () => {
    const cheap: WebEconomy = { ...DEFAULT_WEB_ECONOMY, step: { base: 100, growth: 1.31 } };
    const progress = bought(ORDER_A);
    const preview = refundPreview(fire, progress, account, `${C}.beta.r1`, cheap);
    expect(preview.dropped).toEqual([`${C}.beta.r1`]);
    expect(relative(toNumber(preview.refund.shards), 100 * 1.31 ** 4)).toBeLessThan(1e-12);
    expect(refundNode(fire, progress, account, `${C}.beta.r1`, cheap).wallet.shards).toBe(
      add(progress.wallet.shards, preview.refund.shards),
    );
  });

  it('drop every node only the refunded one connected or unlocked, as refundPreview says', () => {
    const chain = bought([...ROUTE_C1, `${C}.beta.r1`]);
    const preview = refundPreview(fire, chain, account, `${C}.alpha.r1`);
    expect(preview.dropped).toEqual([
      `${C}.alpha.r1`,
      `${C}.main.c1`,
      `${C}.alpha.r3`,
      `${C}.alpha.alpha-one`,
      `${C}.alpha.r2`,
    ]);
    const gated = bought([...CENTER_12, THRESHOLD]);
    expect(refundPreview(fire, gated, account, `${C}.gamma.r1`)).toMatchObject({
      dropped: [`${C}.gamma.r1`, THRESHOLD],
      refund: { cores: 2, resonance: 0 },
    });
    expect(
      relative(
        toNumber(refundPreview(fire, gated, account, `${C}.gamma.r1`).refund.shards),
        steps(13) - steps(11),
      ),
    ).toBeLessThan(1e-12);
  });

  it('make refundPreview equal to what refundNode then does', () => {
    const progress = bought([...CENTER_12, THRESHOLD, 'hub.economy.r1', 'outer.crit.main.entry']);
    for (const id of [
      `${C}.gamma.r1`,
      `${C}.beta.r1`,
      `${C}.main.c3`,
      'hub.economy.r1',
      THRESHOLD,
      `${C}.gamma.r2`,
    ]) {
      const preview = refundPreview(fire, progress, account, id);
      const after = refundNode(fire, progress, account, id);
      expect(after.ranks, id).toEqual(without(progress.ranks, preview.dropped));
      expect(after.wallet).toEqual({
        shards: add(progress.wallet.shards, preview.refund.shards),
        cores: progress.wallet.cores + preview.refund.cores,
        resonance: progress.wallet.resonance + preview.refund.resonance,
      });
      expect(after.spent).toEqual({
        shards: sub(progress.spent.shards, preview.refund.shards),
        cores: progress.spent.cores - preview.refund.cores,
        resonance: progress.spent.resonance - preview.refund.resonance,
      });
    }
  });

  it('remove nothing for an id not owned', () => {
    const progress = bought(ROUTE_C1);
    expect(refundNode(fire, progress, account, `${C}.gamma.r1`)).toEqual(progress);
    expect(refundPreview(fire, progress, account, 'nope')).toEqual({
      dropped: [],
      refund: { shards: 0, cores: 0, resonance: 0 },
    });
  });

  it('refundAll returns spent exactly, empties ranks and keeps the ascendancy', () => {
    const progress = {
      ...bought([...ROUTE_MIGHT, STAR_ONE, PATH_ONE[0]], owning({}, { prestiges: 1 })),
      runs: 4,
    };
    const all = refundAll(progress);
    expect(all).toEqual({
      ...progress,
      ranks: {},
      wallet: {
        shards: add(progress.wallet.shards, progress.spent.shards),
        cores: progress.wallet.cores + progress.spent.cores,
        resonance: progress.wallet.resonance + progress.spent.resonance,
      },
      spent: { shards: 0, cores: 0, resonance: 0 },
    });
    expect(all.ascendancy).toBe('path-one');
  });
});

describe('legalize (R4)', () => {
  const threeStars = owning(
    ones(
      ...ROUTE_MIGHT,
      `${C}.gamma.r1`,
      `${C}.gamma.r2`,
      `${C}.gamma.gamma-one`,
      `${C}.gamma.r3`,
      `${C}.main.c5`,
      STAR_ONE,
      STAR_TWO,
      RULE_ONE,
    ),
  );
  const paid = (progress: CharacterProgress): CharacterProgress => ({
    ...progress,
    spent: canonicalCost(fire, progress),
  });

  it('keeps legal progress as it is', () => {
    const progress = bought([...CENTER_12, THRESHOLD, 'hub.defense.r1', ...POISON]);
    expect(legalize(fire, progress, account)).toEqual({ progress, dropped: [] });
  });

  it('drops in reverse web order: the later of three ★', () => {
    expect(legalize(fire, threeStars, account).dropped).toEqual([RULE_ONE]);
    expect(
      legalize(
        fire,
        owning(ones(`${C}.alpha.r2`, `${C}.alpha.alpha-one`, `${C}.alpha.r3`)),
        account,
      ).dropped,
    ).toEqual([`${C}.alpha.r3`, `${C}.alpha.alpha-one`, `${C}.alpha.r2`]);
  });

  it('refunds as refundNode does', () => {
    const progress = paid(threeStars);
    expect(legalize(fire, progress, account).progress).toEqual(
      refundNode(fire, progress, account, RULE_ONE),
    );
  });

  it('reaches a fixpoint', () => {
    const tangled = paid(
      owning(
        ones(
          ...CENTER_11,
          THRESHOLD,
          `${C}.alpha.r2`,
          `${C}.gamma.mastery`,
          ...POISON,
          POISON_THRESHOLD,
          core('poison'),
        ),
      ),
    );
    const once = legalize(fire, tangled, account);
    expect(once.dropped.length).toBeGreaterThan(0);
    expect(legalize(fire, once.progress, account)).toEqual({
      progress: once.progress,
      dropped: [],
    });
  });

  it('drops, on a later pass, what only a node dropped for its gate connected', () => {
    // The core misses its gate (outer 5 of 6); fusion r1 hangs off the core alone.
    const fused = paid(
      owning(
        ones(
          ...CENTER_8,
          'hub.defense.r1',
          ...POISON.slice(0, 5),
          core('poison'),
          'fusion.fire.poison.r1',
        ),
      ),
    );
    expect(legalize(fire, fused, account).dropped).toEqual([
      core('poison'),
      'fusion.fire.poison.r1',
    ]);
    // The threshold misses its gate (11 of 12, c4 counted); c4 hangs off the threshold alone.
    const past = paid(owning(ones(...CENTER_12.slice(0, 10), THRESHOLD, `${C}.main.c4`)));
    expect(legalize(fire, past, account).dropped).toEqual([THRESHOLD, `${C}.main.c4`]);
  });

  it('drops a threshold whose gate is no longer met (a moved gate), with its price', () => {
    const progress = paid(owning(ones(...CENTER_11, THRESHOLD)));
    const { progress: after, dropped } = legalize(fire, progress, account);
    expect(dropped).toEqual([THRESHOLD]);
    expect(
      relative(toNumber(after.wallet.shards) - toNumber(progress.wallet.shards), 180 * 1.31 ** 11),
    ).toBeLessThan(1e-9);
    expect(after.wallet.cores - progress.wallet.cores).toBe(2);
  });

  it('drops what is hidden, locked, unprestiged or over a challenge limit', () => {
    const poisoned = owning(ones(...ROUTE_C1, 'hub.defense.r1', ...POISON.slice(0, 2)), {
      bestWave: 0,
    });
    expect(legalize(fire, poisoned, account).dropped).toEqual([POISON[1], POISON[0]]);
    const locked = owning(
      ones(...ROUTE_C1, 'hub.defense.r1', 'hub.defense.r2', 'outer.bleed.main.entry'),
    );
    expect(legalize(fireA, locked, account).dropped).toEqual(['outer.bleed.main.entry']);
    const unprestiged = owning(ones(...ROUTE_MIGHT, ...PATH_ONE));
    expect(legalize(fire, unprestiged, account).dropped).toEqual([
      PATH_ONE[2],
      PATH_ONE[1],
      PATH_ONE[0],
    ]);
    const twoBoards = owning(ones(...CRIT_OWNED, 'outer.ice.main.entry', 'outer.ice.alpha.r1'));
    expect(legalize(fire, twoBoards, account).dropped).toEqual([]);
    expect(legalize(fire, twoBoards, account, undefined, CHALLENGE_RULES).dropped).toEqual([
      'outer.ice.alpha.r1',
      'outer.ice.main.entry',
    ]);
  });

  it('never throws: ids outside the web and odd ranks drop first, in key order', () => {
    const garbage = owning(
      {
        [`${C}.alpha.nope`]: 2,
        [`${C}.alpha.r1`]: 2.7,
        [`${C}.alpha.r2`]: Number.NaN,
        [fire.root]: 1,
        [`${C}.beta.r1`]: 99,
        [`${C}.beta.r2`]: -1,
        [`${C}.gamma.r1`]: 'x' as unknown as number,
        [`${C}.alpha.mastery`]: Infinity,
        [`${C}.beta.beta-one`]: 2,
      },
      { spent: { shards: num(1000), cores: 5, resonance: 0 } },
    );
    const { progress, dropped } = legalize(fire, garbage, account);
    expect(dropped).toEqual([
      `${C}.alpha.nope`,
      `${C}.alpha.r2`,
      fire.root,
      `${C}.beta.r2`,
      `${C}.gamma.r1`,
      `${C}.alpha.mastery`,
      `${C}.beta.beta-one`,
    ]);
    expect(progress.ranks).toEqual({ [`${C}.alpha.r1`]: 2, [`${C}.beta.r1`]: 3 });
    // Nothing paid is lost or made: what drops comes back, capped by spent; the 1-rank ◆ stored at
    // rank 2 gives back the cores of both stored ranks.
    expect(progress.wallet.cores).toBe(RICH.cores + 2);
    expect(progress.wallet.cores + progress.spent.cores).toBe(RICH.cores + 5);
    expect(toNumber(progress.wallet.shards) + toNumber(progress.spent.shards)).toBe(1e6 + 1000);
    expect(progress.spent.shards).toBe(0);
    const odds: readonly Record<string, unknown>[] = [
      { [`${C}.alpha.r1`]: null },
      { '': 1 },
      { [`${C}.alpha.r1`]: {} },
    ];
    for (const odd of odds) {
      expect(() => legalize(fire, owning(odd as Record<string, number>), account)).not.toThrow();
    }
  });
});

describe('fusion progress and slot order', () => {
  it('reports a spoke’s center and outer counts against 8 and 6', () => {
    expect(
      fusionProgress(fire, owning(ones(...CENTER_8, ...POISON.slice(0, 3))), 'poison'),
    ).toEqual({
      center: 8,
      centerNeed: 8,
      outer: 3,
      outerNeed: 6,
      unlocked: false,
    });
    expect(
      fusionProgress(
        fire,
        owning(ones(...CENTER_8.slice(0, 7), ...POISON.slice(0, 6), core('poison'))),
        'poison',
      ),
    ).toEqual({ center: 7, centerNeed: 8, outer: 6, outerNeed: 6, unlocked: false });
    expect(
      fusionProgress(fire, owning(ones(...CENTER_8, ...POISON.slice(0, 6))), 'poison').unlocked,
    ).toBe(true);
  });

  it('lists the owned cores in clock order', () => {
    const progress = owning(ones(core('greed'), core('poison'), core('ice')));
    expect(fusionSlotOrder(fire, progress)).toEqual(['poison', 'ice', 'greed']);
    expect(fusionSlotOrder(fire, owning(ones(...CENTER_8)))).toEqual([]);
  });
});

describe('WEB_RULES', () => {
  it('pins V10’s unlock, 8 center and 6 outer nodes, beside the other rules', () => {
    expect(WEB_RULES.fusionCenter).toBe(8);
    expect(WEB_RULES.fusionOuter).toBe(6);
    expect(WEB_RULES).toEqual({
      centerThreshold: 12,
      outerThreshold: 8,
      fusionCenter: 8,
      fusionOuter: 6,
      fusionSlots: 2,
      fusionSlotsAfterSingularity: 3,
      keystonesHeld: 2,
      revealWaves: [15, 30],
    });
  });

  it('starts a character with nothing owned or paid', () => {
    expect(emptyProgress('ice')).toEqual({
      character: 'ice',
      ranks: {},
      wallet: { shards: 0, cores: 0, resonance: 0 },
      spent: { shards: 0, cores: 0, resonance: 0 },
      bestWave: 0,
      cycleBest: 0,
      prestiges: 0,
      resonanceEarned: 0,
      ascendancy: null,
      runs: 0,
    });
  });
});
