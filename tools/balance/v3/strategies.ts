/**
 * Purchase strategies of character sessions (docs/v3 C10 design §1.3, C10/F1): the 預設 build
 * (defaultOrder, else the inside-out order), greedy by short probe runs on the main curve, random
 * among the nodes canBuy accepts, cheapest, balanced over the boards, might-only, and focus on one
 * outer and its fusion. A strategy buys only through its Visit, which checks every purchase with
 * canBuy, and draws only from the Visit's rng, so a session stays a pure function of its config.
 * M1's six strategies stay in tools/balance/strategies.ts for M1 sessions.
 */

import { eq, lt, toNumber } from '../../../src/core/num';
import { stdHpAt } from '../../../src/data';
import { OUTER_IDS } from '../../../src/data/sources';
import type { OuterId } from '../../../src/data/sources';
import type { AssembledWeb, BoardId, WebNode } from '../../../src/data/web';
import { boardCounts, buy, nextPrice, PRICE_CURVE_OF, WEB_RULES } from '../../../src/meta/web';
import type { BuyReason, CharacterProgress, Price } from '../../../src/meta/web';
import { median } from '../../../src/meta/web/calibrate';
import { GATED_KINDS, storedRank } from '../../../src/meta/web/counts';
import { shortestRoute } from '../../../src/meta/web/path';
import type { Visit } from './visit';

export const BASE_WEB_STRATEGIES = [
  'default',
  'greedy',
  'random',
  'cheapest',
  'balanced',
  'might-only',
] as const;
export type BaseWebStrategyId = (typeof BASE_WEB_STRATEGIES)[number];
export type WebStrategyId = BaseWebStrategyId | `focus:${OuterId}`;

const FOCUS = 'focus:';

/** The outer a `focus:<o>` id names, o one of OUTER_IDS; null for any other text. */
export function focusOuter(text: string): OuterId | null {
  if (!text.startsWith(FOCUS)) return null;
  const outer = text.slice(FOCUS.length);
  return (OUTER_IDS as readonly string[]).includes(outer) ? (outer as OuterId) : null;
}

export const isWebStrategyId = (text: string): text is WebStrategyId =>
  (BASE_WEB_STRATEGIES as readonly string[]).includes(text) || focusOuter(text) !== null;

/** The outers whose board the web shows open (built and in scope), in clock order. */
export function openOuters(web: AssembledWeb): OuterId[] {
  return web.boards
    .filter((board) => board.kind === 'outer' && board.status === 'open')
    .map((board) => board.id.slice('outer.'.length) as OuterId);
}

/** `--strategy all` on a web: the base strategies, then focus:<o> per open outer, clock order. */
export function webStrategiesFor(web: AssembledWeb): WebStrategyId[] {
  return [...BASE_WEB_STRATEGIES, ...openOuters(web).map((o): WebStrategyId => `${FOCUS}${o}`)];
}

/** Greedy's candidates a visit (初始值): a visit stays under ~3 s at 20 µs a tick. */
export const GREEDY_CANDIDATES = 8;
/** At most this many candidates from one board (初始值), so the candidates spread over boards. */
export const GREEDY_PER_BOARD = 2;
/** Seeds each candidate is probed on (初始值), the same ~3 s budget. */
export const GREEDY_SEEDS = 2;
/** A probe run's length (初始值): 2 minutes, as late runs last 1–3 min (CLAUDE.md:7). */
export const GREEDY_PROBE_TICKS = 7_200;

/** canBuy's wallet refusals (src/meta/web/rules.ts); every other reason is structural. */
export const WALLET_REASONS: ReadonlySet<BuyReason> = new Set<BuyReason>([
  'notEnoughShards',
  'notEnoughCores',
  'notEnoughResonance',
]);

/** One greedy reading, kept for the dead-node report (C10.3): the gain of a node bought now. */
export interface GreedyEvaluation {
  readonly node: string;
  readonly gain: number;
  readonly shards: number;
  readonly cores: number;
  readonly minutes: number;
}

export interface WebStrategy {
  readonly id: WebStrategyId;
  visit(v: Visit): void;
  /** Greedy's readings so far, in visit order; empty for a strategy that never ran greedy's rule. */
  readonly evaluations: readonly GreedyEvaluation[];
}

const orders = new WeakMap<AssembledWeb, ReadonlyMap<string, number>>();

/** Each node's index in web.nodes: web order. */
function webOrder(web: AssembledWeb): ReadonlyMap<string, number> {
  let order = orders.get(web);
  if (order === undefined) {
    order = new Map(web.nodes.map((node, index) => [node.id, index]));
    orders.set(web, order);
  }
  return order;
}

/**
 * The nodes canBuy can accept (rows 2 and 6, as sampleProgress reads them): owned ones below their
 * last rank, and unowned ones next to the root or an owned node; in web order.
 */
export function openNodes(web: AssembledWeb, progress: CharacterProgress): WebNode[] {
  return web.nodes.filter((node) => {
    if (node.kind === 'signature') return false;
    const rank = storedRank(progress, node.id);
    if (rank > 0) return node.ranks === 'unlimited' || rank < node.ranks;
    return (web.neighbours.get(node.id) ?? []).some(
      (other) => other === web.root || storedRank(progress, other) > 0,
    );
  });
}

/**
 * Breadth-first from `starts`, a level at a time in web order, over the neighbours `admits` lets
 * in; the nodes found, starts excluded, in the order found.
 */
export function breadthFirst(
  web: AssembledWeb,
  starts: readonly string[],
  admits: (node: WebNode) => boolean,
): string[] {
  const order = webOrder(web);
  const byOrder = (a: string, b: string): number =>
    (order.get(a) as number) - (order.get(b) as number);
  const seen = new Set(starts);
  const found: string[] = [];
  let level = [...starts];
  while (level.length > 0) {
    const next: string[] = [];
    for (const id of level) {
      for (const other of web.neighbours.get(id) ?? []) {
        const node = web.byId.get(other);
        if (node === undefined || seen.has(other) || !admits(node)) continue;
        seen.add(other);
        next.push(other);
      }
    }
    level = next.sort(byOrder);
    found.push(...level);
  }
  return found;
}

/**
 * Ranks round-robin after `ids` at rank 1: pass k (from 2) lists each id whose node has k ranks or
 * more, unlimited ones in every pass, up to the most ranks any listed node has.
 */
function rankPasses(web: AssembledWeb, ids: readonly string[]): string[] {
  const nodes = ids.map((id) => web.byId.get(id) as WebNode);
  const most = Math.max(1, ...nodes.map((node) => (node.ranks === 'unlimited' ? 1 : node.ranks)));
  const passes: string[] = [];
  for (let k = 2; k <= most; k++) {
    for (const node of nodes) {
      if (node.ranks === 'unlimited' || node.ranks >= k) passes.push(node.id);
    }
  }
  return passes;
}

/**
 * The inside-out order, the 預設 build of a character whose defaultOrder is empty (the fixture,
 * C6 F26): every node of every board but the gated kinds, breadth-first from the root a level at a
 * time in web order (invest.ts' boardOrder rule, over every board at once), each at rank 1; then
 * ranks round-robin (rankPasses).
 */
export function insideOutOrder(web: AssembledWeb): string[] {
  const firsts = breadthFirst(web, [web.root], (node) => !GATED_KINDS.has(node.kind));
  return [...firsts, ...rankPasses(web, firsts)];
}

/** defaultOrder, or the inside-out order when it is empty. */
export function presetOrder(web: AssembledWeb): readonly string[] {
  return web.def.defaultOrder.length > 0 ? web.def.defaultOrder : insideOutOrder(web);
}

/** a cheaper than b: fewer shards, then fewer cores. */
const cheaper = (a: Price, b: Price): boolean =>
  lt(a.shards, b.shards) || (eq(a.shards, b.shards) && a.cores < b.cores);

/** The accepted node of `nodes` with the fewest shards, then cores, then the first in web order. */
function cheapestOf(v: Visit, nodes: readonly WebNode[]): string | null {
  let best: string | null = null;
  let bestPrice: Price | null = null;
  for (const node of nodes) {
    const check = v.check(node.id);
    if (!check.ok) continue;
    if (bestPrice === null || cheaper(check.price, bestPrice)) {
      best = node.id;
      bestPrice = check.price;
    }
  }
  return best;
}

/** Whether refusing `id` for `reason` ends the visit, saving for it; else the entry parks. */
export type SaveRule = (v: Visit, id: string, reason: BuyReason) => boolean;

/** `default`'s rule (§1.3): every wallet refusal saves. */
export const savesOnWallet: SaveRule = (_v, _id, reason) => WALLET_REASONS.has(reason);

/**
 * `focus:<o>`'s rule, M1's (savingsFor, tools/balance/strategies.ts:5-8, :83-104): it saves only
 * for a node short of shards alone, whose cores and 迴響 the wallet holds; one short of cores
 * parks, as a core comes only from a kill and the shards kept for it bring it no nearer.
 */
export const savesForShards: SaveRule = (v, id, reason) => {
  if (reason !== 'notEnoughShards') return false;
  const { wallet } = v.progress();
  const price = nextPrice(v.web, v.progress(), id, v.economy);
  return price.cores <= wallet.cores && price.resonance <= wallet.resonance;
};

/**
 * Buys `order`'s entries not yet owned (ids, ranks by repetition: an id's k-th entry is its rank
 * k). A refusal `saves` says saves (a wallet refusal, by default) ends the visit and returns
 * false; any other parks the entry, which the next visit retries first, since every visit walks
 * from the start. True when the walk reached the order's end.
 */
function walk(v: Visit, order: readonly string[], saves: SaveRule = savesOnWallet): boolean {
  const entries = new Map<string, number>();
  for (const id of order) {
    const rank = (entries.get(id) ?? 0) + 1;
    entries.set(id, rank);
    if (storedRank(v.progress(), id) >= rank) continue;
    const check = v.check(id);
    if (check.ok) v.buy(id);
    else if (saves(v, id, check.reason)) return false;
  }
  return true;
}

const notGated = (node: WebNode): boolean => !GATED_KINDS.has(node.kind);

/**
 * Buys the route to `target` (planPath's: shortest, ties in web order, never through a gated
 * kind), one step at a time from what is owned now. False when a refusal `saves` says saves (a
 * wallet refusal, by default) ended the visit; any other refusal, or no route, parks the target.
 */
function routeTo(v: Visit, target: string, saves: SaveRule = savesOnWallet): boolean {
  while (storedRank(v.progress(), target) === 0) {
    const route = shortestRoute(v.web, v.progress(), target, notGated);
    const id = route?.[0];
    if (id === undefined) return true;
    const check = v.check(id);
    if (!check.ok) return !saves(v, id, check.reason);
    v.buy(id);
  }
  return true;
}

/**
 * What greedy's rule keeps from visit to visit (one per strategy, as `evaluations`): each node
 * whose last probe read no gain (gain ≤ 0, or none), with the rank and prestiges it was probed at
 * and the number of the visit. Without it the candidates are a function of the progress (owned
 * first, then web order), so a node with no gain kept its place in every visit, and a visit
 * whose candidates all read none bought nothing, left the progress as it was and probed the same
 * ones again: a stat the early waves do not read (蜂巢's drone and turret damage while they kill
 * in one hit; 熔核's burn stacks and spread radius) held greedy at wave 3–5 for a whole session.
 */
export interface GreedyMemory {
  /** Greedy's rule's visits so far. */
  visits: number;
  readonly passed: Map<
    string,
    { readonly rank: number; readonly prestiges: number; readonly visit: number }
  >;
}

export const greedyMemory = (): GreedyMemory => ({ visits: 0, passed: new Map() });

/**
 * Greedy's candidates: the nodes canBuy accepts now, at most GREEDY_PER_BOARD a board, owned ones
 * (their next rank) before new ones, each in web order; boards taken round-robin in web order up
 * to GREEDY_CANDIDATES. A node passed in `memory` (its last probe, at the rank and prestiges it
 * holds now, read no gain) comes after its board's other accepted nodes, the longest passed
 * first; a board whose accepted nodes are all passed comes after the other boards, by its first
 * candidate's visit. With nothing passed this is the order above.
 */
function greedyCandidates(
  v: Visit,
  memory: GreedyMemory,
): { readonly node: WebNode; readonly price: Price }[] {
  const progress = v.progress();
  /** The visit `node` was passed in at its rank now, or −1. */
  const passedAt = (node: WebNode): number => {
    const entry = memory.passed.get(node.id);
    return entry !== undefined &&
      entry.rank === storedRank(progress, node.id) &&
      entry.prestiges === progress.prestiges
      ? entry.visit
      : -1;
  };
  type Candidate = { node: WebNode; price: Price; owned: boolean; at: number };
  const boards = new Map<BoardId, Candidate[]>();
  for (const node of openNodes(v.web, progress)) {
    const check = v.check(node.id);
    if (!check.ok) continue;
    const list = boards.get(node.board) ?? [];
    const owned = storedRank(progress, node.id) > 0;
    list.push({ node, price: check.price, owned, at: passedAt(node) });
    boards.set(node.board, list);
  }
  // Sorts are stable, so ties keep web order.
  const lists = [...boards.values()]
    .map((list) =>
      [...list]
        .sort((a, b) => a.at - b.at || Number(!a.owned) - Number(!b.owned))
        .slice(0, GREEDY_PER_BOARD),
    )
    .sort((a, b) => (a[0] as Candidate).at - (b[0] as Candidate).at);
  const picks: { node: WebNode; price: Price }[] = [];
  for (let k = 0; k < GREEDY_PER_BOARD; k++) {
    for (const list of lists) {
      const pick = list[k];
      if (pick === undefined) continue;
      picks.push({ node: pick.node, price: pick.price });
      if (picks.length === GREEDY_CANDIDATES) return picks;
    }
  }
  return picks;
}

/**
 * Greedy's rule (§1.3): each candidate's gain = median over seeds of stdHpAt(x with it) ÷
 * stdHpAt(x now) − 1, from one probe of the progress now and one with the candidate bought; the best
 * ★ with a gain above 0 first, then the shard-priced candidates with a gain above 0 by gain per
 * shard, each bought if canBuy accepts it then. No re-probe, no saving. Every reading goes to
 * `evaluations`, and `memory` passes each candidate that read no gain, so the next visits probe
 * the others first.
 */
function greedyRule(v: Visit, evaluations: GreedyEvaluation[], memory: GreedyMemory): void {
  const progress = v.progress();
  const visit = memory.visits;
  memory.visits += 1;
  const candidates = greedyCandidates(v, memory);
  if (candidates.length === 0) return;
  const base = v.probe(progress);
  const order = webOrder(v.web);
  const scored = candidates.map(({ node, price }) => {
    const xs = v.probe(buy(v.web, progress, v.account, node.id, v.economy));
    const gain = median(xs.map((x, s) => stdHpAt(x) / stdHpAt(base[s] as number))) - 1;
    const shards = toNumber(price.shards);
    evaluations.push({ node: node.id, gain, shards, cores: price.cores, minutes: v.minutes });
    if (gain > 0) memory.passed.delete(node.id);
    else {
      const rank = storedRank(progress, node.id);
      memory.passed.set(node.id, { rank, prestiges: progress.prestiges, visit });
    }
    return { node, gain, shards };
  });
  let star: (typeof scored)[number] | null = null;
  for (const entry of scored) {
    if (entry.node.kind !== 'keystone' || !(entry.gain > 0)) continue;
    if (star === null || entry.gain > star.gain) star = entry;
  }
  if (star !== null && v.check(star.node.id).ok) v.buy(star.node.id);
  const priced = scored
    .filter((entry) => PRICE_CURVE_OF[entry.node.kind] !== null && entry.gain > 0)
    .sort(
      (a, b) =>
        b.gain / b.shards - a.gain / a.shards ||
        (order.get(a.node.id) as number) - (order.get(b.node.id) as number),
    );
  for (const entry of priced) if (v.check(entry.node.id).ok) v.buy(entry.node.id);
}

/** The node ids of `board` in a breadth-first order from `start`, every kind, start first. */
function boardFrom(web: AssembledWeb, board: BoardId, start: string): string[] {
  return [start, ...breadthFirst(web, [start], (node) => node.board === board)];
}

/**
 * `focus:<o>` (§1.3): the 預設 order's center nodes, each once, while fewer than 8 center nodes are
 * counted (the fusion gate's, counts.ts); the route to o's entry; o's board breadth-first from the
 * entry, gated kinds bought once legal; o's fusion core, then its ranks; then the 預設 order; then
 * greedy's rule. Saves like `default` for a node short of shards alone (savesForShards); a node
 * short of cores parks like one not yet legal, so the visit goes on to the rest and in the end to
 * the 預設 order and greedy, as it does past an outer not yet revealed. Saving for the cores of the
 * center's seventh node, a ◆, held 熔核 and 蜂巢 at six rank-1 nodes, short of the wave-5 elite
 * whose core it waited for, with thousands of shards banked.
 */
function focusVisit(
  web: AssembledWeb,
  outer: OuterId,
  evaluations: GreedyEvaluation[],
  memory: GreedyMemory,
): (v: Visit) => void {
  const preset = presetOrder(web);
  const center = `${web.character}.center`;
  const centerIds = [...new Set(preset)].filter((id) => web.byId.get(id)?.board === center);
  const board: BoardId = `outer.${outer}`;
  const entry = web.nodes.find((node) => node.board === board && node.slot.at === 'outerEntry');
  const outerOrder = entry === undefined ? [] : boardFrom(web, board, entry.id);
  const fusionBoard: BoardId = `fusion.${web.character}.${outer}`;
  const core = web.nodes.find((node) => node.board === fusionBoard && node.kind === 'core');
  const fusionIds = core === undefined ? [] : boardFrom(web, fusionBoard, core.id);
  const fusionOrder = [...fusionIds, ...rankPasses(web, fusionIds)];

  const saves = savesForShards;
  const centerFirst = (v: Visit): boolean => {
    for (const id of centerIds) {
      if (boardCounts(v.web, v.progress()).center >= WEB_RULES.fusionCenter) return true;
      if (storedRank(v.progress(), id) > 0) continue;
      const check = v.check(id);
      if (check.ok) v.buy(id);
      else if (saves(v, id, check.reason)) return false;
    }
    return true;
  };
  return (v) => {
    if (!centerFirst(v)) return;
    if (entry !== undefined && !routeTo(v, entry.id, saves)) return;
    if (!walk(v, outerOrder, saves) || !walk(v, fusionOrder, saves) || !walk(v, preset, saves)) {
      return;
    }
    greedyRule(v, evaluations, memory);
  };
}

/**
 * The hub's ★, its 規則 spur (玻璃大砲, 巨大化): no character's and no outer's, the v3 kin of M1's
 * generic keystones, which M1's bots never take blind (tools/balance/strategies.ts:61-62:
 * 玻璃大砲's life of 1 is a gamble, impl:485 「玻璃大砲維持賭博」).
 */
export const isRulesKeystone = (node: WebNode): boolean =>
  node.kind === 'keystone' && node.board === 'hub';

/**
 * `balanced`: center, hub and the open outers in turn, each turn that board's cheapest accepted
 * node, the hub's 規則 ★ left out (isRulesKeystone): a ★ costs no shards, so it was the hub's
 * cheapest the moment 3 cores were in the wallet, and 熔核 with 玻璃大砲 at wave 7 died to its
 * first leak at the start wave 3 in every run after, never again reaching the wave-5 elite.
 */
function balancedVisit(web: AssembledWeb): (v: Visit) => void {
  const boards = web.boards
    .filter(
      (board) =>
        board.status === 'open' &&
        (board.kind === 'center' || board.kind === 'hub' || board.kind === 'outer'),
    )
    .map((board) => board.id);
  // The turn carries over from visit to visit: round-robin over the session.
  let turn = 0;
  return (v) => {
    let misses = 0;
    while (misses < boards.length) {
      const board = boards[turn % boards.length] as BoardId;
      turn += 1;
      const id = cheapestOf(
        v,
        openNodes(v.web, v.progress()).filter(
          (node) => node.board === board && !isRulesKeystone(node),
        ),
      );
      if (id === null) {
        misses += 1;
      } else {
        v.buy(id);
        misses = 0;
      }
    }
  };
}

/**
 * `might-only`: the route to the nearest might (planPath's), then might ranks only. Every route
 * from the root to the hub runs through a center ◆, which takes a core, and a core comes only
 * from a kill (the elite every 5 waves first): while the route's next step waits on one, the
 * visit buys the cheapest accepted node that costs no cores (cheapestOf: the center's first
 * ranks), the least build that earns it, then goes back to the route. The route's two rank-1
 * nodes saving for the ◆ never reached wave 5; nor did those two at their last rank (熔核).
 */
function mightOnlyVisit(v: Visit): void {
  const mights = v.web.nodes.filter((node) => node.kind === 'might');
  for (;;) {
    let route: readonly string[] | null = null;
    for (const might of mights) {
      const found = shortestRoute(v.web, v.progress(), might.id, notGated);
      if (found !== null && (route === null || found.length < route.length)) route = found;
    }
    const id = route?.[0];
    if (id === undefined) return;
    const check = v.check(id);
    if (check.ok) {
      v.buy(id);
      continue;
    }
    if (check.reason !== 'notEnoughCores') return;
    const earner = cheapestOf(
      v,
      openNodes(v.web, v.progress()).filter((node) => v.economy.cores[node.kind] === 0),
    );
    if (earner === null) return;
    v.buy(earner);
  }
}

/** `cheapest`: the cheapest accepted node (shards, cores, web order), again and again. */
function cheapestVisit(v: Visit): void {
  for (;;) {
    const id = cheapestOf(v, openNodes(v.web, v.progress()));
    if (id === null) return;
    v.buy(id);
  }
}

/**
 * `random`: a node drawn uniformly among those canBuy accepts, until none is accepted: drawn from
 * the open nodes in web order, a refused draw dropped and the draw repeated, as sampleProgress
 * draws (whose pool is in the order the nodes opened).
 */
function randomVisit(v: Visit): void {
  for (;;) {
    const pool = openNodes(v.web, v.progress()).map((node) => node.id);
    let bought = false;
    while (pool.length > 0 && !bought) {
      const i = v.rng.int(pool.length);
      const id = pool[i] as string;
      if (v.check(id).ok) {
        v.buy(id);
        bought = true;
      } else {
        pool[i] = pool[pool.length - 1] as string;
        pool.pop();
      }
    }
    if (!bought) return;
  }
}

/**
 * The ascendancy chain a visit buys after a prestige (gd §1.7, F10): the chosen chain's nodes,
 * else the first open chain's in web order (n1, n2, final); empty before a prestige or on a web
 * without ascendancies.
 */
export function ascendancyOrder(web: AssembledWeb, progress: CharacterProgress): string[] {
  if (progress.prestiges < 1) return [];
  const chosen = progress.ascendancy;
  const board = web.boards.find(
    (slot) =>
      slot.kind === 'asc' &&
      slot.status === 'open' &&
      (chosen === null || slot.id === `${web.character}.asc.${chosen}`),
  );
  if (board === undefined) return [];
  const step = (node: WebNode): number => (node.slot.at === 'asc' ? node.slot.step : 0);
  return web.nodes
    .filter((node) => node.board === board.id)
    .sort((a, b) => step(a) - step(b))
    .map((node) => node.id);
}

/**
 * Every strategy's first step after a prestige but random's (which draws them among the rest) and
 * cheapest's (they cost no shards, so it takes them first anyway): the route to the chain's first
 * node, then the chain, bought with 迴響. A refusal leaves the rest of the chain to a later visit;
 * the strategy's own rule runs either way.
 */
function ascendancyVisit(v: Visit): void {
  const order = ascendancyOrder(v.web, v.progress());
  const first = order[0];
  if (first === undefined) return;
  if (!routeTo(v, first) || storedRank(v.progress(), first) === 0) return;
  walk(v, order);
}

/** The strategy `id` for one session on `web`; it may keep state from visit to visit. */
export function createStrategy(id: WebStrategyId, web: AssembledWeb): WebStrategy {
  const evaluations: GreedyEvaluation[] = [];
  const memory = greedyMemory();
  const of = (visit: (v: Visit) => void): WebStrategy => ({
    id,
    visit: (v) => {
      ascendancyVisit(v);
      visit(v);
    },
    evaluations,
  });
  const outer = focusOuter(id);
  if (outer !== null) {
    if (!openOuters(web).includes(outer)) {
      throw new Error(`${id}: outer '${outer}' is not open on web '${web.character}'`);
    }
    return of(focusVisit(web, outer, evaluations, memory));
  }
  switch (id as BaseWebStrategyId) {
    case 'default': {
      const order = presetOrder(web);
      return of((v) => {
        if (walk(v, order)) greedyRule(v, evaluations, memory);
      });
    }
    case 'greedy':
      return of((v) => greedyRule(v, evaluations, memory));
    case 'random':
      return { id, visit: randomVisit, evaluations };
    case 'cheapest':
      return { id, visit: cheapestVisit, evaluations };
    case 'balanced':
      return of(balancedVisit(web));
    case 'might-only':
      return of(mightOnlyVisit);
  }
}
