import { describe, expect, it, vi } from 'vitest';
import { num, toNumber } from '../../../../src/core/num';
import type { CharacterId, OuterId } from '../../../../src/data';
import type { AssembledWeb } from '../../../../src/data/web';
import { fixtureContent } from '../../../../src/data/web/testing';
import { DEFAULT_WEB_ECONOMY, emptyProgress } from '../../../../src/meta/web';
import { GATED_KINDS } from '../../../../src/meta/web/counts';
import { auditStart } from '../../../../src/meta/web/invest';
import { shortestRoute } from '../../../../src/meta/web/path';
import { webOf } from '../content';
import type { DeadBoardInput, DeadBoardReading } from '../measures';
import type { SessionSnapshot } from '../session';
import type { GreedyEvaluation } from '../strategies';
import type * as Strategies from '../strategies';
import {
  boardInvestment,
  boardPlan,
  boardSnapshot,
  boardUnits,
  DEAD_BOARD_MINUTES,
  DEAD_BOARD_NODES,
  DEAD_BOARD_TOP,
  DEAD_NODE_SHARE,
  deadBoardBase,
  deadBoardsCheck,
  deadBoardsCsv,
  deadBoardUnitId,
  deadNodes,
  deadNodesCheck,
  deadNodesCsv,
  fewOuters,
  rankOuters,
  WALLET_SHARE,
} from './boards';
import { checkSet } from './run';
import {
  ALL_C7,
  measureResults,
  merged,
  rowWith,
  sessionResult,
  sessionResults,
  snapshotSessions,
} from './testing';
import { FRESH_ACCOUNT } from './types';
import type { CheckPlan, UnitResults } from './types';

/** A seam on the outers a character sees: openOuters cut to its first `limit` while it is set. */
const view = vi.hoisted(() => ({ limit: null as number | null }));
vi.mock('../strategies', async (importOriginal) => {
  const actual = await importOriginal<typeof Strategies>();
  return {
    ...actual,
    openOuters: (web: AssembledWeb) => {
      const outers = actual.openOuters(web);
      return view.limit === null ? outers : outers.slice(0, view.limit);
    },
  };
});

const B1 = { fixture: 'B1' } as const;
const web = webOf(B1, 'fire', 'full');

/** The nightly plan of a fixture batch, one 35-min session a character. */
const planOf = (batch: 'B1' | 'B2' | 'B3'): CheckPlan =>
  checkSet(
    'nightly',
    fixtureContent(batch),
    { fixture: batch },
    { sessions: 1, minutes: 35, c7: ALL_C7 },
  );

/** The center route from nothing to outer.poison's entry, as planPath finds it. */
const ROUTE = [
  'fire.center.alpha.r1',
  'fire.center.alpha.r2',
  'fire.center.alpha.alpha-one',
  'fire.center.alpha.r3',
  'fire.center.main.c1',
  'hub.defense.r1',
];
/** outer.poison breadth-first from its entry: DEAD_BOARD_NODES nodes. */
const POISON = [
  'outer.poison.main.entry',
  'outer.poison.alpha.r1',
  'outer.poison.beta.r1',
  'outer.poison.alpha.r2',
  'outer.poison.beta.r2',
  'outer.poison.alpha.alpha-one',
  'outer.poison.beta.beta-one',
  'outer.poison.alpha.r3',
];

describe('the investment (deadBoards)', () => {
  it('starts from the snapshot at best wave 30, its wallet WALLET_SHARE of what was earned, not the bank (OWN 5)', () => {
    expect([WALLET_SHARE, DEAD_BOARD_NODES, DEAD_BOARD_TOP, DEAD_BOARD_MINUTES]).toEqual([
      0.3, 8, 5, 30,
    ]);
    const snapshot = {
      ...emptyProgress('fire'),
      bestWave: 4,
      wallet: { shards: num(100), cores: 1, resonance: 3 },
    };
    const base = deadBoardBase(web, snapshot, { shards: 10_000, cores: 5 });
    expect(base.bestWave).toBe(30);
    expect(toNumber(base.wallet.shards)).toBe(3_000);
    expect(base.wallet.cores).toBe(1.5);
    expect(base.wallet.resonance).toBe(3);
    expect(base.ranks).toBe(snapshot.ranks);
    expect(
      deadBoardBase(web, { ...snapshot, bestWave: 45 }, { shards: 0, cores: 0 }).bestWave,
    ).toBe(45);
  });

  it("orders the board's nodes breadth-first from its entry, DEAD_BOARD_NODES of them, a ◆ and its route first", () => {
    expect(boardPlan(web, 'poison')).toEqual(POISON);
    expect(boardPlan(web, 'poison', 'outer.poison.main.counter')).toEqual([
      'outer.poison.main.entry',
      'outer.poison.alpha.r1',
      'outer.poison.alpha.r2',
      'outer.poison.alpha.alpha-one',
      'outer.poison.alpha.alpha-two',
      'outer.poison.main.counter',
      'outer.poison.beta.r1',
      'outer.poison.beta.r2',
    ]);
  });

  it('never plans a threshold, a ★ or a fusion node, however many nodes it may take', () => {
    const all = boardPlan(web, 'poison', null, 100);
    expect(all).toHaveLength(16);
    for (const id of all) {
      const node = web.byId.get(id);
      expect(node?.board).toBe('outer.poison');
      expect(GATED_KINDS.has(node?.kind ?? 'threshold')).toBe(false);
    }
    expect(() => boardPlan(web, 'fire')).toThrow("deadBoard: outer 'fire' is not open on 'fire'");
  });

  it('buys the route to the entry, then the plan, at real prices', () => {
    const rich = deadBoardBase(web, auditStart(web, false), { shards: 1e9, cores: 100 });
    const invested = boardInvestment(web, rich, FRESH_ACCOUNT, DEFAULT_WEB_ECONOMY, 'poison');
    expect(invested.bought).toEqual([...ROUTE, ...POISON]);
    expect(invested.unpaid).toEqual([]);
    expect(invested.refused).toBeNull();
    for (const id of invested.bought) expect(invested.progress.ranks[id]).toBe(1);
    // Real prices: the wallet paid for them.
    expect(toNumber(invested.progress.wallet.shards)).toBeLessThan(toNumber(rich.wallet.shards));
    expect(invested.progress.wallet.cores).toBeLessThan(rich.wallet.cores);
    // The plan's owned nodes are kept: neither bought again nor unpaid.
    const ranks = Object.fromEntries([...ROUTE, ...POISON.slice(0, 2)].map((id) => [id, 1]));
    const owning = deadBoardBase(
      web,
      { ...auditStart(web, false), ranks },
      { shards: 1e9, cores: 100 },
    );
    const rest = boardInvestment(web, owning, FRESH_ACCOUNT, DEFAULT_WEB_ECONOMY, 'poison');
    expect(rest).toMatchObject({ bought: POISON.slice(2), unpaid: [], refused: null });
  });

  it('routes to the entry through no threshold, ★ or core, as planPath does', () => {
    // A ★ linked to outer.poison's entry: as near as hub.defense.r1, and earlier in web order.
    const star = 'fire.center.main.star-one';
    const entry = 'outer.poison.main.entry';
    const linked = (id: string, other: string) => [...(web.neighbours.get(id) ?? []), other];
    const shortcut: AssembledWeb = {
      ...web,
      neighbours: new Map([
        ...web.neighbours,
        [star, linked(star, entry)],
        [entry, linked(entry, star)],
      ]),
    };
    expect(shortestRoute(shortcut, emptyProgress('fire'), entry, () => true)).toContain(star);
    const rich = deadBoardBase(shortcut, auditStart(shortcut, false), { shards: 1e9, cores: 100 });
    const invested = boardInvestment(shortcut, rich, FRESH_ACCOUNT, DEFAULT_WEB_ECONOMY, 'poison');
    expect(invested.bought).toEqual([...ROUTE, ...POISON]);
  });

  it('buys fewer on a board the wallet cannot pay for, and reports the rest unpaid (OWN 5)', () => {
    // 30 % of 2,000 shards earned pays for the route's first two ranks (180 and 235.8), not its
    // third, whatever the bank holds.
    const snapshot = {
      ...auditStart(web, false),
      wallet: { shards: num(1e6), cores: 100, resonance: 0 },
    };
    const poor = deadBoardBase(web, snapshot, { shards: 2_000, cores: 100 });
    const invested = boardInvestment(web, poor, FRESH_ACCOUNT, DEFAULT_WEB_ECONOMY, 'poison');
    expect(invested.bought).toEqual(ROUTE.slice(0, 2));
    expect(invested.unpaid).toEqual([...ROUTE.slice(2), ...POISON]);
    expect(invested.refused).toBe('fire.center.alpha.alpha-one: notEnoughShards');
    // From an owned rank on, the route starts after it.
    const owned = { ...snapshot, ranks: { 'fire.center.alpha.r1': 1 } };
    const kept = boardInvestment(
      web,
      deadBoardBase(web, owned, { shards: 2_000, cores: 100 }),
      FRESH_ACCOUNT,
      DEFAULT_WEB_ECONOMY,
      'poison',
    );
    expect(kept.bought[0]).toBe('fire.center.alpha.r2');
    expect([...kept.bought, ...kept.unpaid]).not.toContain('fire.center.alpha.r1');
  });
});

describe('deadBoards (死盤)', () => {
  it('ranks outers by Δx, ties in clock order (OWN 5)', () => {
    expect(
      rankOuters([
        { outer: 'poison', delta: 1 },
        { outer: 'crit', delta: 2 },
        { outer: 'ice', delta: 1 },
        { outer: 'summon', delta: 2 },
      ]),
    ).toEqual(['crit', 'summon', 'poison', 'ice']);
  });

  it('is fewOuters while every character sees DEAD_BOARD_TOP outers or fewer', () => {
    expect([fewOuters([5, 4]), fewOuters([6]), fewOuters([5, 6]), fewOuters([])]).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  /** deadBoard readings of every unit: x = base + Δ of its board on each seed, by `delta`. */
  const readings = (
    plan: CheckPlan,
    delta: (character: CharacterId, outer: OuterId, seed: number) => number | undefined,
    base: UnitResults = snapshotSessions(plan, DEAD_BOARD_MINUTES),
  ): UnitResults =>
    merged(
      base,
      measureResults(boardUnits(plan, base), (measure, input) => {
        if (measure !== 'deadBoard') return null;
        const { character, outer, seed } = input as DeadBoardInput;
        const d = outer === null ? 0 : delta(character, outer, seed);
        if (d === undefined) return null;
        const reading: DeadBoardReading = {
          character,
          outer,
          seed,
          x: 20 + d,
          bought: outer === null ? [] : [`outer.${outer}.main.entry`],
          unpaid: [],
          refused: null,
        };
        return reading;
      }),
    );

  it('is info (fewOuters) on B1 and B2, each outer ranked', () => {
    for (const batch of ['B1', 'B2'] as const) {
      const plan = planOf(batch);
      const rows = deadBoardsCheck(
        plan,
        readings(plan, () => 1),
      );
      expect(rows.map((row) => row.status)).toEqual(rows.map(() => 'info'));
    }
    const plan = planOf('B2');
    const rows = deadBoardsCheck(
      plan,
      readings(plan, (_, outer) => (outer === 'crit' ? 2 : 1)),
    );
    expect(rows.map((row) => row.subject)).toEqual([
      'outer.fire',
      'outer.poison',
      'outer.crit',
      'outer.ice',
      'outer.summon',
    ]);
    expect(rowWith(rows, 'outer.poison').measured).toBe(
      'fire #2 (+1), summon #3 (+1); fewOuters: every character sees 5 outers or fewer, all in ' +
        'its top 5, until B3 opens more than five outers',
    );
  });

  // B3: 熔核, 霜晶 and 蜂巢, each seeing seven outers.
  const plan = planOf('B3');
  const DELTAS: Readonly<Record<string, Readonly<Partial<Record<OuterId, number>>>>> = {
    // 熔核: ice ties summon at 1, fifth by clock order; barrage last.
    fire: { poison: 5, bleed: 4, lightning: 3, crit: 2, ice: 1, summon: 1, barrage: 0 },
    // 霜晶: summon sixth (tied with barrage, clock order).
    ice: { fire: 5, poison: 4, bleed: 3, lightning: 2, crit: 1, summon: 0, barrage: 0 },
    // 蜂巢: ice sixth (tied with barrage).
    summon: { fire: 5, poison: 4, bleed: 3, lightning: 2, crit: 1, ice: 0, barrage: 0 },
  };
  const delta = (character: CharacterId, outer: OuterId, seed: number): number =>
    // One seed's outlier leaves the medians alone.
    outer === 'barrage' && seed === 7 ? 1_000 : (DELTAS[character]?.[outer] as number);

  it('reads fewOuters from the outers each character sees, never from the batch (K6)', () => {
    // B3 with every character's view cut to its first DEAD_BOARD_TOP outers: all fit, so info.
    view.limit = DEAD_BOARD_TOP;
    try {
      const rows = deadBoardsCheck(plan, readings(plan, delta));
      expect(rows.map((row) => row.subject)).toEqual([
        'outer.fire',
        'outer.poison',
        'outer.bleed',
        'outer.lightning',
        'outer.crit',
        'outer.ice',
      ]);
      expect(rows.map((row) => row.status)).toEqual(rows.map(() => 'info'));
    } finally {
      view.limit = null;
    }
  });

  it("passes an outer in some character's top DEAD_BOARD_TOP by the median Δx, ties by clock order (OWN 5)", () => {
    const rows = deadBoardsCheck(plan, readings(plan, delta));
    expect(rows.map((row) => [row.subject, row.status])).toEqual([
      ['outer.fire', 'pass'],
      ['outer.poison', 'pass'],
      ['outer.bleed', 'pass'],
      ['outer.lightning', 'pass'],
      ['outer.crit', 'pass'],
      ['outer.ice', 'pass'],
      ['outer.summon', 'FAIL'],
      ['outer.barrage', 'FAIL'],
    ]);
    expect(rowWith(rows, 'outer.ice').measured).toBe('fire #5 (+1), summon #6 (+0)');
    expect(rowWith(rows, 'outer.summon').measured).toBe('fire #6 (+1), ice #6 (+0)');
    expect(rowWith(rows, 'outer.barrage').evidence).toEqual(['dead_boards.csv: barrage']);
  });

  it('is noData for an outer no complete ranking puts in its top while a ranking is missing', () => {
    const missing = (character: CharacterId, outer: OuterId, seed: number) =>
      character === 'fire' && outer === 'crit' && seed === 0
        ? undefined
        : delta(character, outer, seed);
    const rows = deadBoardsCheck(plan, readings(plan, missing));
    expect(rowWith(rows, 'outer.barrage')).toMatchObject({
      status: 'n/a',
      reason: { id: 'noData', detail: 'fire: 7 of 8 boards measured on all seeds' },
      measured: 'fire —, ice #7 (+0), summon #7 (+0)',
    });
    expect(rowWith(rows, 'outer.poison').status).toBe('pass');
    const none = deadBoardsCheck(plan, snapshotSessions(plan, 'prestige'));
    expect(rowWith(none, 'outer.fire').reason?.detail).toBe(
      'no default session of ice has a 30-min snapshot; no default session of summon has a ' +
        '30-min snapshot',
    );
  });

  it("reads the lowest-index default session's DEAD_BOARD_MINUTES snapshot", () => {
    const three = checkSet('nightly', fixtureContent('B1'), B1, {
      sessions: 3,
      minutes: 35,
      c7: ALL_C7,
    });
    const holding = (session: number, minutes: SessionSnapshot['minutes']) =>
      sessionResult('fire', session, {
        snapshots: [
          { minutes, progress: auditStart(web, false), earned: { shards: session, cores: 0 } },
        ],
      });
    const results = sessionResults([
      holding(0, 'prestige'),
      holding(1, DEAD_BOARD_MINUTES),
      holding(2, DEAD_BOARD_MINUTES),
    ]);
    expect(boardSnapshot(three, results, 'fire')).toMatchObject({
      session: 1,
      snapshot: { minutes: DEAD_BOARD_MINUTES, earned: { shards: 1 } },
      account: FRESH_ACCOUNT,
    });
    expect(boardSnapshot(three, sessionResults([holding(0, 'prestige')]), 'fire')).toBeNull();
  });

  it("plans the base and each open outer of each character on 8 seeds, from the snapshot's session", () => {
    const b1 = planOf('B1');
    const base = snapshotSessions(b1, DEAD_BOARD_MINUTES, { shards: 500, cores: 1 });
    const units = boardUnits(b1, base);
    expect(units.map((unit) => unit.id).filter((id) => id.endsWith(':0'))).toEqual([
      'measure:deadBoard:fire:base:0',
      'measure:deadBoard:fire:poison:0',
      'measure:deadBoard:fire:crit:0',
      'measure:deadBoard:fire:ice:0',
      'measure:deadBoard:fire:summon:0',
    ]);
    expect(units).toHaveLength(5 * 8);
    expect(units[9]).toEqual({
      id: deadBoardUnitId('fire', 'poison', 1),
      job: {
        kind: 'measure',
        measure: 'deadBoard',
        input: {
          content: B1,
          character: 'fire',
          outer: 'poison',
          snapshot: auditStart(web, false),
          earned: { shards: 500, cores: 1 },
          account: FRESH_ACCOUNT,
          economy: DEFAULT_WEB_ECONOMY,
          seed: 1,
        },
      },
    });
    expect(boardUnits(b1, snapshotSessions(b1, 'prestige'))).toEqual([]);
    const pr = checkSet('pr', fixtureContent('B1'), B1, { sessions: 1, c7: ALL_C7 });
    expect(boardUnits(pr, snapshotSessions(pr, DEAD_BOARD_MINUTES))).toEqual([]);
  });

  it("gives each character's dead-board units that character's own snapshot", () => {
    const b2 = planOf('B2');
    const base = snapshotSessions(b2, DEAD_BOARD_MINUTES);
    const units = boardUnits(b2, base);
    for (const character of b2.characters) {
      const found = boardSnapshot(b2, base, character);
      if (found === null) throw new Error(character);
      const own = units.filter((unit) => unit.id.split(':')[2] === character);
      // B2: each character's base and its four open outers, on 8 seeds.
      expect(own).toHaveLength(5 * 8);
      for (const unit of own) {
        if (unit.job.kind !== 'measure') throw new Error(unit.id);
        expect(unit.job.input).toMatchObject({
          character,
          snapshot: found.snapshot.progress,
          earned: found.snapshot.earned,
          account: found.account,
          economy: found.economy,
        });
      }
    }
  });

  it('writes dead_boards.csv: one line per character, board and seed', () => {
    const b1 = planOf('B1');
    const csv = deadBoardsCsv(
      b1,
      readings(b1, (_, outer) => (outer === 'ice' ? 2 : 1)),
    );
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('character,outer,seed,x,delta,rank,bought,unpaid,refused,session');
    expect(lines).toHaveLength(1 + 5 * 8);
    expect(lines[1]).toBe('fire,base,0,20,,,,,,0');
    expect(lines[9]).toBe('fire,poison,0,21,1,2,outer.poison.main.entry,,,0');
    expect(lines[25]).toBe('fire,ice,0,22,2,1,outer.ice.main.entry,,,0');
  });
});

describe('deadNodes (死節點)', () => {
  const read = (node: string, gain: number, shards: number): GreedyEvaluation => ({
    node,
    gain,
    shards,
    cores: 0,
    minutes: 5,
  });

  it('lists the nodes no session bought and the low-value ones, against the evaluated median (OWN 6)', () => {
    const sessions = [
      sessionResult('fire', 0, {
        bought: ['fire.center.alpha.r1', 'fire.center.alpha.r2', 'fire.center.beta.r1'],
        evaluations: [
          read('fire.center.alpha.r1', 1, 100),
          read('fire.center.alpha.r2', 2, 100),
          read('fire.center.beta.r1', 0.1, 100),
        ],
      }),
      sessionResult('fire', 1, {
        bought: ['fire.center.gamma.r1', 'fire.center.alpha.r1'],
        evaluations: [read('fire.center.gamma.r1', 1.5, 100)],
      }),
    ];
    const report = deadNodes(web, sessions);
    // Gains per shard 0.01, 0.02, 0.001 and 0.015: the median is 0.0125.
    expect(report.median).toBeCloseTo(0.0125, 12);
    expect(report.evaluated).toBe(4);
    expect(report.total).toBe(web.nodes.length - 1);
    const listed = new Map(report.nodes.map((node) => [node.node, node]));
    expect(listed.get('fire.center.beta.r1')).toMatchObject({
      never: false,
      low: true,
      sessions: 1,
      evaluations: 1,
      bestGain: 0.1,
    });
    for (const id of ['fire.center.alpha.r1', 'fire.center.alpha.r2', 'fire.center.gamma.r1']) {
      expect(listed.has(id)).toBe(false);
    }
    expect(listed.get('fire.center.gamma.r2')).toMatchObject({
      never: true,
      low: false,
      sessions: 0,
      evaluations: 0,
      bestGain: null,
    });
    expect(report.nodes).toHaveLength(report.total - 4 + 1);
    expect(report.nodes.some((node) => node.kind === 'signature')).toBe(false);
    expect(DEAD_NODE_SHARE).toBe(0.2);
  });

  it('keeps the ★ out of the ratio and lists each one greedy read with its gain (OWN 6)', () => {
    const sessions = [
      sessionResult('fire', 0, {
        bought: ['fire.center.alpha.r1', 'fire.center.beta.r1', 'fire.center.main.star-one'],
        evaluations: [
          read('fire.center.alpha.r1', 1, 100),
          read('fire.center.beta.r1', 0.19, 100),
          read('fire.center.main.star-one', 5, 0),
        ],
      }),
    ];
    const report = deadNodes(web, sessions);
    // Without the ★ the median is 0.00595: beta's 0.0019 is above 0.2 × it.
    expect(report.median).toBeCloseTo(0.00595, 12);
    const listed = new Map(report.nodes.map((node) => [node.node, node]));
    expect(listed.has('fire.center.beta.r1')).toBe(false);
    expect(listed.get('fire.center.main.star-one')).toMatchObject({
      kind: 'keystone',
      never: false,
      low: false,
      bestGain: 5,
      bestPerShard: null,
    });
  });

  it('lists a node as low under DEAD_NODE_SHARE × the median, not at it', () => {
    const sessions = [
      sessionResult('fire', 0, {
        evaluations: [
          read('fire.center.alpha.r1', 50, 100),
          read('fire.center.alpha.r2', 50, 100),
          read('fire.center.gamma.r1', 50, 100),
          read('fire.center.beta.r1', 10, 100),
          read('fire.center.beta.r2', 9, 100),
        ],
      }),
    ];
    // The median is 0.5: beta.r1's 0.1 is 0.2 × it exactly, beta.r2's 0.09 under it.
    const report = deadNodes(web, sessions);
    expect(report.median).toBe(0.5);
    const low = report.nodes.filter((node) => node.low).map((node) => node.node);
    expect(low).toEqual(['fire.center.beta.r2']);
  });

  it("reads a node's best reading", () => {
    const sessions = [
      sessionResult('fire', 0, {
        bought: ['fire.center.alpha.r1', 'fire.center.alpha.r2', 'fire.center.beta.r1'],
        evaluations: [
          read('fire.center.alpha.r1', 1, 100),
          read('fire.center.alpha.r2', 1, 100),
          read('fire.center.beta.r1', 0.01, 100),
          read('fire.center.beta.r1', 0.35, 100),
        ],
      }),
    ];
    // beta's best is 0.0035 a shard, above 0.2 × the median 0.01; its first and its mean are not.
    const report = deadNodes(web, sessions);
    expect(report.median).toBeCloseTo(0.01, 12);
    expect(report.nodes.some((node) => node.node === 'fire.center.beta.r1')).toBe(false);
  });

  it('reads the legacy sessions with the default ones: a node only a legacy session bought is bought', () => {
    const plan = planOf('B1');
    const results = merged(
      sessionResults([sessionResult('fire', 0, { bought: ['fire.center.alpha.r1'] })]),
      sessionResults([sessionResult('fire', 0, { bought: ['fire.center.beta.r1'] })], true),
    );
    const [row] = deadNodesCheck(plan, results);
    expect(row?.measured).toMatch(/^never bought 153 of 155 over 2 sessions; /);
  });

  it('is one info row per character over its sessions, noData without one, and dead_nodes.csv lists them', () => {
    const plan = planOf('B1');
    const results = sessionResults([
      sessionResult('fire', 0, {
        bought: ['fire.center.alpha.r1', 'fire.center.beta.r1', 'fire.center.main.star-one'],
        evaluations: [
          read('fire.center.alpha.r1', 1, 100),
          read('fire.center.beta.r1', 0.1, 100),
          read('fire.center.alpha.r2', 2, 100),
          read('fire.center.main.star-one', 0.25, 0),
        ],
      }),
    ]);
    const [row] = deadNodesCheck(plan, results);
    expect(row).toMatchObject({
      subject: 'fire',
      status: 'info',
      measured:
        'never bought 152 of 155 over 1 sessions; 1 of 3 evaluated under 0.2 × the median ' +
        '0.01: fire.center.beta.r1; ★ fire.center.main.star-one 0.25',
      evidence: ['dead_nodes.csv: fire'],
    });
    expect(deadNodesCheck(plan, {})).toMatchObject([
      {
        subject: 'fire',
        status: 'n/a',
        reason: { id: 'noData', detail: 'no session of fire has a result' },
      },
    ]);
    const lines = deadNodesCsv(plan, results).trimEnd().split('\n');
    expect(lines[0]).toBe(
      'character,node,kind,board,never,low,sessions,evaluations,bestGain,bestGainPerShard,median',
    );
    expect(lines).toHaveLength(1 + 152 + 2);
    expect(lines).toContain(
      'fire,fire.center.beta.r1,ranked,fire.center,false,true,1,1,0.1,0.001,0.01',
    );
    expect(lines).toContain(
      'fire,fire.center.alpha.r2,ranked,fire.center,true,false,0,1,2,0.02,0.01',
    );
    expect(lines).toContain(
      'fire,fire.center.main.star-one,keystone,fire.center,false,false,1,1,0.25,,0.01',
    );
  });
});
