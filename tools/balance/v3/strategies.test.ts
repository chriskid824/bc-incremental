import { describe, expect, it } from 'vitest';
import { num, toNumber } from '../../../src/core/num';
import { createRng } from '../../../src/core/rng';
import { characterGameData, OUTER_IDS, stdHpAt } from '../../../src/data';
import {
  buy,
  canBuy,
  DEFAULT_WEB_ECONOMY,
  emptyProgress,
  nextPrice,
  PRICE_CURVE_OF,
} from '../../../src/meta/web';
import type { AssembledWeb, WebNode } from '../../../src/data/web';
import type { CharacterProgress } from '../../../src/meta/web';
import { GATED_KINDS } from '../../../src/meta/web/counts';
import { shortestRoute } from '../../../src/meta/web/path';
import { webOf } from './content';
import {
  BASE_WEB_STRATEGIES,
  createStrategy,
  focusOuter,
  GREEDY_CANDIDATES,
  GREEDY_PER_BOARD,
  insideOutOrder,
  isWebStrategyId,
  openNodes,
  webStrategiesFor,
  WALLET_REASONS,
} from './strategies';
import type { WebStrategyId } from './strategies';
import { openVisit } from './visit';

const ACCOUNT = { singularityBeaten: false };
const web = webOf({ fixture: 'B5' }, 'fire', 'full');

const withWallet = (progress: CharacterProgress, shards: number, cores = 0): CharacterProgress => ({
  ...progress,
  wallet: { shards: num(shards), cores, resonance: 0 },
});
const funded = (shards: number, cores = 0) => withWallet(emptyProgress('fire'), shards, cores);

/** The route to each target and the target bought, with an empty wallet after. */
function owning(targets: readonly string[]): CharacterProgress {
  let progress = funded(1e30, 1000);
  for (const target of targets) {
    const route = shortestRoute(web, progress, target, (node) => !GATED_KINDS.has(node.kind));
    for (const id of route ?? []) progress = buy(web, progress, ACCOUNT, id, DEFAULT_WEB_ECONOMY);
  }
  return withWallet(progress, 0);
}

/**
 * One visit of `id` from `progress`; the probe reads x = 10 + Σ weight × rank, so a node's gain
 * is fixed by its weight.
 */
function visitOf(
  id: WebStrategyId,
  progress: CharacterProgress,
  { seed = 1, weights = new Map<string, number>() } = {},
) {
  const visit = openVisit({
    web,
    account: ACCOUNT,
    economy: DEFAULT_WEB_ECONOMY,
    data: characterGameData(),
    rng: createRng(seed),
    minutes: 0,
    progress,
    probe: (p) => {
      let x = 10;
      for (const [node, rank] of Object.entries(p.ranks)) x += (weights.get(node) ?? 0) * rank;
      return [x, x];
    },
  });
  const strategy = createStrategy(id, web);
  strategy.visit(visit);
  return { bought: visit.bought, progress: visit.progress(), evaluations: strategy.evaluations };
}

const C = 'fire.center.';

describe('web strategy ids', () => {
  it('parses focus:<o> against OUTER_IDS', () => {
    expect(isWebStrategyId('default')).toBe(true);
    expect(isWebStrategyId('might-only')).toBe(true);
    expect(isWebStrategyId('focus:ice')).toBe(true);
    expect(isWebStrategyId('focus:')).toBe(false);
    expect(isWebStrategyId('focus:frost')).toBe(false);
    expect(isWebStrategyId('crit-greedy')).toBe(false);
    expect(OUTER_IDS.map((o) => focusOuter(`focus:${o}`))).toEqual([...OUTER_IDS]);
    expect(focusOuter('ice')).toBeNull();
  });

  it('lists the base strategies and a focus per open outer, and refuses a focus on one it lacks', () => {
    const outers = OUTER_IDS.filter((o) => o !== 'fire');
    expect(webStrategiesFor(web)).toEqual([
      ...BASE_WEB_STRATEGIES,
      ...outers.map((o) => `focus:${o}`),
    ]);
    expect(() => createStrategy('focus:fire', web)).toThrow(/outer 'fire' is not open/);
    const demo = webOf({ fixture: 'B5' }, 'fire', 'demoA');
    expect(webStrategiesFor(demo).filter((id) => id.startsWith('focus:'))).toEqual([
      'focus:poison',
      'focus:crit',
      'focus:ice',
      'focus:summon',
    ]);
  });
});

describe('default', () => {
  const order = insideOutOrder(web);

  it('builds the inside-out order: breadth-first from the root, no gated kind, then ranks', () => {
    expect(order.slice(0, 9)).toEqual([
      `${C}alpha.r1`,
      `${C}beta.r1`,
      `${C}gamma.r1`,
      `${C}alpha.r2`,
      `${C}beta.r2`,
      `${C}gamma.r2`,
      `${C}alpha.alpha-one`,
      `${C}beta.beta-one`,
      `${C}gamma.gamma-one`,
    ]);
    const firsts = [...new Set(order)];
    const seen = new Set([web.root]);
    for (const id of firsts) {
      const node = web.byId.get(id);
      expect(node && !GATED_KINDS.has(node.kind), id).toBe(true);
      expect(
        (web.neighbours.get(id) ?? []).some((other) => seen.has(other)),
        id,
      ).toBe(true);
      seen.add(id);
    }
    expect(order.slice(0, firsts.length)).toEqual(firsts);
    const counts = new Map<string, number>();
    for (const id of order) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, count] of counts) {
      const ranks = web.byId.get(id)?.ranks;
      expect(count, id).toBe(ranks === 'unlimited' ? 3 : ranks);
    }
  });

  it('takes each breadth-first level in web order, whatever order the edges are listed in', () => {
    const node = (id: string, ranks: number): WebNode =>
      ({
        id,
        kind: id === 'root' ? 'signature' : 'ranked',
        board: 'fire.center',
        ranks,
      }) as WebNode;
    const nodes = [node('root', 1), node('a', 2), node('b', 1), node('c', 1)];
    const edges: [string, string[]][] = [
      ['root', ['b', 'a']],
      ['a', ['root', 'c']],
      ['b', ['root']],
      ['c', ['a']],
    ];
    const tiny = {
      root: 'root',
      nodes,
      byId: new Map(nodes.map((n) => [n.id, n])),
      neighbours: new Map(edges),
    } as unknown as AssembledWeb;
    expect(insideOutOrder(tiny)).toEqual(['a', 'b', 'c', 'a']);
  });

  it('buys the order and saves on a wallet refusal, retrying the refused entry first', () => {
    // alpha-one, the seventh entry, takes a core: with none, the visit ends there.
    const first = visitOf('default', funded(1e30, 0));
    expect(first.bought).toEqual(order.slice(0, 6));
    const next = visitOf('default', withWallet(first.progress, 1e30, 1));
    expect(next.bought).toEqual([`${C}alpha.alpha-one`]);
  });

  it('parks an entry canBuy refuses for a structural reason and buys it once legal', () => {
    const all = visitOf('default', funded(1e300, 1e6));
    const parked = order.filter((id, i) => order.indexOf(id) === i && !(id in all.progress.ranks));
    expect(parked.length).toBeGreaterThan(0);
    for (const id of parked) {
      const check = canBuy(web, all.progress, ACCOUNT, id, DEFAULT_WEB_ECONOMY);
      expect(check.ok || WALLET_REASONS.has(check.reason), id).toBe(false);
    }
    // Best wave 15 reveals poison (revealAt15): its entry comes first in the next visit.
    const revealed = visitOf('default', { ...all.progress, bestWave: 15 });
    expect(revealed.bought[0]).toBe('outer.poison.main.entry');
    expect(parked).toContain('outer.poison.main.entry');
  });
});

describe('greedy', () => {
  it('buys the best gain per shard first, by the probe, never a gain of 0', () => {
    const weights = new Map([
      ['hub.might.might', 0.5],
      ['hub.defense.r1', 0.6],
      [`${C}alpha.r1`, 0.2],
      [`${C}alpha.r2`, 0.3],
    ]);
    const { bought, evaluations } = visitOf(
      'greedy',
      withWallet(owning(['hub.might.might']), 1e6),
      {
        weights,
      },
    );
    // Might's 420 shards against the step nodes' 910: the lower gain first.
    expect(bought).toEqual(['hub.might.might', 'hub.defense.r1', `${C}alpha.r2`, `${C}alpha.r1`]);
    expect(evaluations.map((e) => e.node)).toEqual([
      `${C}alpha.r1`,
      'hub.might.might',
      `${C}alpha.r2`,
      'hub.defense.r1',
    ]);
    // x now: 10 plus the owned alpha.r1, alpha.r2, defense.r1 and might, one rank each.
    for (const e of evaluations) {
      const w = weights.get(e.node) as number;
      expect(e.gain).toBeCloseTo(stdHpAt(11.6 + w) / stdHpAt(11.6) - 1, 10);
    }
    const ratios = bought.map((id) => {
      const e = evaluations.find((entry) => entry.node === id);
      return (e?.gain ?? 0) / (e?.shards ?? 1);
    });
    expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);

    const flat = visitOf('greedy', withWallet(owning(['hub.might.might']), 1e6));
    expect(flat.evaluations.length).toBeGreaterThan(0);
    expect(flat.bought).toEqual([]);
  });

  it('probes at most GREEDY_CANDIDATES nodes, GREEDY_PER_BOARD a board, the boards in turn', () => {
    const entries = ['outer.ice.main.entry', 'outer.crit.main.entry', 'outer.summon.main.entry'];
    const progress = withWallet(owning(entries), 1e6, 10);
    const { evaluations } = visitOf('greedy', progress);
    expect([GREEDY_CANDIDATES, GREEDY_PER_BOARD]).toEqual([8, 2]);
    expect(evaluations.map((e) => web.byId.get(e.node)?.board)).toEqual([
      'fire.center',
      'hub',
      'outer.crit',
      'outer.ice',
      'outer.summon',
      'fire.center',
      'hub',
      'outer.crit',
    ]);
    // Owned nodes' next ranks come before new nodes on a board.
    const center = evaluations.filter((e) => e.node.startsWith(C)).map((e) => e.node);
    expect(center.every((id) => (progress.ranks[id] ?? 0) > 0)).toBe(true);
  });

  it('buys the best ★ with a gain first', () => {
    // 500 shards: might (420) yes, the step nodes (910) no; 3 cores: one ★.
    const weights = new Map([
      ['hub.might.might', 0.5],
      ['hub.rules.rule-one', 0.3],
      [`${C}main.star-one`, 0.1],
    ]);
    const { bought, evaluations } = visitOf(
      'greedy',
      withWallet(owning(['hub.might.might']), 500, 3),
      { weights },
    );
    expect(evaluations.map((e) => e.node).sort()).toEqual(
      [`${C}main.star-one`, 'hub.might.might', 'hub.rules.rule-one'].sort(),
    );
    expect(bought).toEqual(['hub.rules.rule-one', 'hub.might.might']);
    expect(PRICE_CURVE_OF.keystone).toBeNull();
  });
});

describe('random', () => {
  it('draws uniformly among the nodes canBuy accepts, the same for the same seed', () => {
    const rich = funded(1e6, 10);
    const one = visitOf('random', rich, { seed: 1 });
    expect(one.bought.slice(0, 10)).toEqual([
      `${C}beta.r1`,
      `${C}gamma.r1`,
      `${C}gamma.r1`,
      `${C}beta.r2`,
      `${C}gamma.r2`,
      `${C}gamma.gamma-one`,
      `${C}gamma.r3`,
      `${C}gamma.r5`,
      `${C}beta.beta-one`,
      `${C}beta.r1`,
    ]);
    expect(visitOf('random', rich, { seed: 1 }).bought).toEqual(one.bought);
    expect(visitOf('random', rich, { seed: 2 }).bought.slice(0, 10)).not.toEqual(
      one.bought.slice(0, 10),
    );
    // It stops only when nothing open is accepted.
    for (const node of openNodes(web, one.progress)) {
      expect(canBuy(web, one.progress, ACCOUNT, node.id, DEFAULT_WEB_ECONOMY).ok, node.id).toBe(
        false,
      );
    }
  });
});

describe('cheapest, balanced, might-only and focus', () => {
  const rich = funded(1e6, 10);

  it('cheapest buys by shards, then cores, then web order', () => {
    const repeat = (id: string, n: number) => Array.from({ length: n }, () => `${C}${id}`);
    expect(visitOf('cheapest', rich).bought.slice(0, 10)).toEqual([
      ...repeat('alpha.r1', 3),
      ...repeat('alpha.r2', 3),
      ...repeat('beta.r1', 3),
      `${C}beta.r2`,
    ]);
    // Same shards: the notable's core makes it dearer than the ranked nodes.
    const { bought } = visitOf('cheapest', rich);
    expect(bought.indexOf(`${C}alpha.alpha-one`)).toBeGreaterThan(bought.indexOf(`${C}gamma.r2`));
  });

  it('balanced takes the center, the hub and each open outer in turn', () => {
    const { bought } = visitOf('balanced', withWallet(owning(['outer.ice.main.entry']), 1e6, 10));
    expect(bought.slice(0, 10)).toEqual([
      `${C}alpha.r1`,
      'hub.defense.r4',
      'outer.crit.main.entry',
      'outer.ice.alpha.r1',
      `${C}alpha.r1`,
      'hub.rules.rule-two',
      'outer.crit.alpha.r1',
      'outer.ice.alpha.r1',
      `${C}alpha.r1`,
      'hub.defense.r3',
    ]);
  });

  it('balanced carries its turn from one visit to the next', () => {
    const balanced = createStrategy('balanced', web);
    let progress = owning(['outer.ice.main.entry']);
    const firsts: string[] = [];
    for (let visit = 0; visit < 3; visit++) {
      // Enough for one step node: each visit buys one, on the board whose turn it is.
      const price = nextPrice(web, progress, `${C}alpha.r1`, DEFAULT_WEB_ECONOMY).shards;
      const v = openVisit({
        web,
        account: ACCOUNT,
        economy: DEFAULT_WEB_ECONOMY,
        data: characterGameData(),
        rng: createRng(1),
        minutes: 0,
        progress: withWallet(progress, toNumber(price)),
        probe: () => [0, 0],
      });
      balanced.visit(v);
      expect(v.bought).toHaveLength(1);
      firsts.push(v.bought[0] as string);
      progress = v.progress();
    }
    expect(firsts).toEqual([`${C}alpha.r1`, 'hub.defense.r4', 'outer.crit.main.entry']);
  });

  it('balanced takes the open outers in clock order', () => {
    // defense.r1–r4 and economy.r1 owned, and best wave 15: the entries open are poison's,
    // lightning's and crit's (bleed's and combo's stay hidden until wave 30).
    const progress = { ...owning(['hub.defense.r1', 'hub.economy.r1']), bestWave: 15 };
    const { bought } = visitOf('balanced', withWallet(progress, 1e6, 10));
    const round = ['fire.center', 'hub', 'outer.poison', 'outer.lightning', 'outer.crit'];
    expect(bought.slice(0, 10).map((id) => web.byId.get(id)?.board)).toEqual([...round, ...round]);
  });

  it('might-only routes around gated kinds, then buys might alone and saves the rest', () => {
    const MIGHT = 'hub.might.might';
    const progress = withWallet(owning([`${C}beta.r5`]), 1e6, 10);
    const route = shortestRoute(web, progress, MIGHT, (node) => !GATED_KINDS.has(node.kind)) ?? [];
    // The shortest route with gated kinds allowed runs through the center ★ star-one.
    expect(shortestRoute(web, progress, MIGHT, () => true)).toContain(`${C}main.star-one`);
    expect(route).not.toContain(`${C}main.star-one`);
    const { bought, progress: after } = visitOf('might-only', progress);
    expect(bought.slice(0, route.length)).toEqual(route);
    expect(bought.length).toBeGreaterThan(route.length);
    expect(bought.slice(route.length).every((id) => id === MIGHT)).toBe(true);
    // Might's next rank is refused, yet a cheaper open node would be accepted.
    expect(canBuy(web, after, ACCOUNT, MIGHT, DEFAULT_WEB_ECONOMY).ok).toBe(false);
    expect(
      openNodes(web, after).some(
        (node) => canBuy(web, after, ACCOUNT, node.id, DEFAULT_WEB_ECONOMY).ok,
      ),
    ).toBe(true);
  });

  it("might-only buys planPath's route to might, then might's ranks", () => {
    expect(visitOf('might-only', rich).bought.slice(0, 10)).toEqual([
      `${C}alpha.r1`,
      `${C}alpha.r2`,
      `${C}alpha.alpha-one`,
      `${C}alpha.r3`,
      `${C}main.c1`,
      'hub.defense.r1',
      'hub.might.might',
      'hub.might.might',
      'hub.might.might',
      'hub.might.might',
    ]);
  });

  it("focus buys the center's first eight, the route to its outer's entry, then that board", () => {
    const centerEight = [
      `${C}alpha.r1`,
      `${C}beta.r1`,
      `${C}gamma.r1`,
      `${C}alpha.r2`,
      `${C}beta.r2`,
      `${C}gamma.r2`,
      `${C}alpha.alpha-one`,
      `${C}beta.beta-one`,
    ];
    expect(visitOf('focus:ice', rich).bought.slice(0, 15)).toEqual([
      ...centerEight,
      `${C}beta.r3`,
      `${C}main.c3`,
      'hub.economy.r1',
      'hub.economy.r2',
      'outer.ice.main.entry',
      'outer.ice.alpha.r1',
      'outer.ice.beta.r1',
    ]);
    expect(visitOf('focus:crit', rich).bought.slice(0, 13)).toEqual([
      ...centerEight,
      `${C}beta.r3`,
      `${C}main.c3`,
      'hub.economy.r1',
      'outer.crit.main.entry',
      'outer.crit.alpha.r1',
    ]);
    // A core short of the eighth: the visit saves, buying nothing past the seven it can.
    const short = visitOf('focus:ice', funded(1e6, 1));
    expect(short.bought).toEqual(centerEight.slice(0, 7));
  });
});
