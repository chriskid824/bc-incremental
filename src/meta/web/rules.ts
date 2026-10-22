/**
 * The purchase rules of a character's v3 web (docs/v3 C6 design §4.5, D5, D6, D18, D20, F10, F16,
 * F51): canBuy's twelve rows, buy, the refunds and legalize, a spoke's fusion progress and the
 * fusion-slot order. Pure: each function returns a new progress and changes nothing it is given
 * (D21). B1's web UI, its run loop, C8's loader, the fuzz and calibration call them.
 */

import { add, gt, lt, min, sub, ZERO } from '../../core/num';
import type { Num } from '../../core/num';
import type { CharacterId, OuterId } from '../../data/sources';
import { boardIdOf } from '../../data/web/ids';
import type { AssembledWeb, WebNode } from '../../data/web/types';
import {
  boardCounts,
  chainOfBoard,
  isCenterBoard,
  outerOfBoard,
  rankOf,
  storedRank,
  WEB_RULES,
} from './counts';
import { canonicalCost, DEFAULT_WEB_ECONOMY, priceOf } from './price';
import { revealedOuters, viewIn } from './reveal';
import type {
  AccountProgress,
  BoardCounts,
  BuyCheck,
  ChallengeRules,
  CharacterProgress,
  GateProgress,
  Price,
  RefundPreview,
  Wallet,
  WebEconomy,
} from './types';

export { boardCounts, WEB_RULES } from './counts';

/** gd:789's limits as 初始值 (F51); the mode itself (selection, unlock, enemy speed, UI, rewards) is Q5's. */
export const CHALLENGE_RULES: ChallengeRules = { noKeystones: true, maxOuters: 1 };

/** canBuy's reasons in the order of its rows (§4.5): it returns the first that applies. */
export const BUY_REASONS = [
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
] as const;
export type BuyReason = (typeof BUY_REASONS)[number];

type Refusal = Extract<BuyCheck, { readonly ok: false }>;

const EMPTY_WALLET: Wallet = { shards: ZERO, cores: 0, resonance: 0 };

/** A character before its first purchase: nothing owned, nothing paid, no wave reached. */
export function emptyProgress(character: CharacterId): CharacterProgress {
  return {
    character,
    ranks: {},
    wallet: EMPTY_WALLET,
    spent: EMPTY_WALLET,
    bestWave: 0,
    cycleBest: 0,
    prestiges: 0,
    resonanceEarned: 0,
    ascendancy: null,
    runs: 0,
  };
}

/** Fusion slots: 2, or 3 once any character has beaten 奇點 (gd:788). */
export function fusionSlots(account: AccountProgress): number {
  return account.singularityBeaten ? WEB_RULES.fusionSlotsAfterSingularity : WEB_RULES.fusionSlots;
}

const refuse = (reason: BuyReason, gate: GateProgress | null = null): Refusal => ({
  ok: false,
  reason,
  gate,
});

/** What rows 3–5 read besides the node, found once per check or per legalize pass. */
interface Standing {
  readonly counts: BoardCounts;
  readonly revealed: ReadonlySet<OuterId>;
  /** The chosen chain: progress.ascendancy, else the chain of the first owned ascendancy node. */
  readonly chain: string | null;
}

/**
 * The chain chosen by its first purchase (F10): progress.ascendancy, which buy records. A progress
 * that owns ascendancy nodes without one recorded (only stored garbage does) counts the chain of
 * its first owned ascendancy node in web order, so it never keeps two chains.
 */
function chosenChain(web: AssembledWeb, progress: CharacterProgress): string | null {
  if (progress.ascendancy !== null) return progress.ascendancy;
  for (const node of web.nodes) {
    const chain = chainOfBoard(node.board);
    if (chain !== null && storedRank(progress, node.id) > 0) return chain;
  }
  return null;
}

function standingOf(web: AssembledWeb, progress: CharacterProgress): Standing {
  return {
    counts: boardCounts(web, progress),
    revealed: revealedOuters(web.def, progress.bestWave),
    chain: chosenChain(web, progress),
  };
}

/** `counts` without `node`'s own place in them: a node never counts toward its own gate (D18). */
function leftOut(counts: BoardCounts, node: WebNode, rank: number): BoardCounts {
  if (rank === 0) return counts;
  const outer = node.board.startsWith('outer.') ? outerOfBoard(node.board) : null;
  return {
    ...counts,
    center: counts.center - (isCenterBoard(node.board) ? 1 : 0),
    outers:
      outer === null
        ? counts.outers
        : { ...counts.outers, [outer]: (counts.outers[outer] ?? 1) - 1 },
    cores: counts.cores - (node.kind === 'core' ? 1 : 0),
    keystones: counts.keystones - (node.kind === 'keystone' ? 1 : 0),
  };
}

/**
 * Rows 3–5: the node's outer, or its fusion's, hidden or locked (§4.6); with a ChallengeRules, a ★
 * under noKeystones, and a node of an outer board while maxOuters other outer boards hold owned
 * nodes (a fusion's nodes follow through row 9); an ascendancy node without a prestige, or of the
 * chain not chosen (F10).
 */
function rows3to5(
  web: AssembledWeb,
  progress: CharacterProgress,
  node: WebNode,
  standing: Standing,
  challenge: ChallengeRules | undefined,
): Refusal | null {
  const outer = outerOfBoard(node.board);
  if (outer !== null) {
    const view = viewIn(web, standing.revealed, outer);
    if (view === 'hidden' || view === 'locked') return refuse(view);
  }
  if (challenge !== undefined) {
    if (challenge.noKeystones && node.kind === 'keystone') return refuse('challengeKeystone');
    if (challenge.maxOuters !== null && node.board.startsWith('outer.')) {
      let others = 0;
      for (const [o, count] of Object.entries(standing.counts.outers)) {
        if (o !== outer && (count ?? 0) > 0) others += 1;
      }
      if (others >= challenge.maxOuters) return refuse('challengeOuter');
    }
  }
  const chain = chainOfBoard(node.board);
  if (chain !== null) {
    if (progress.prestiges < 1) return refuse('needsPrestige');
    if (standing.chain !== null && standing.chain !== chain) return refuse('otherAscendancy');
  }
  return null;
}

/**
 * Rows 7–11, on counts that leave the node out: the center threshold below 12 counted center
 * nodes, an outer threshold below 8 on its board, a core below center 8 or its outer 6, a core with
 * every fusion slot taken, a ★ with 2 ★ owned (cores and ascendancy finals are other kinds; D6).
 */
function rows7to11(account: AccountProgress, node: WebNode, counts: BoardCounts): Refusal | null {
  if (node.kind === 'threshold') {
    if (isCenterBoard(node.board)) {
      if (counts.center < WEB_RULES.centerThreshold) {
        return refuse('centerGate', {
          center: counts.center,
          centerNeed: WEB_RULES.centerThreshold,
          outer: null,
          outerNeed: null,
        });
      }
    } else {
      const outer = outerOfBoard(node.board);
      const count = outer === null ? 0 : (counts.outers[outer] ?? 0);
      if (count < WEB_RULES.outerThreshold) {
        return refuse('outerGate', {
          center: counts.center,
          centerNeed: 0,
          outer: count,
          outerNeed: WEB_RULES.outerThreshold,
        });
      }
    }
  } else if (node.kind === 'core') {
    const outer = outerOfBoard(node.board);
    const count = outer === null ? 0 : (counts.outers[outer] ?? 0);
    if (counts.center < WEB_RULES.fusionCenter || count < WEB_RULES.fusionOuter) {
      return refuse('fusionGate', {
        center: counts.center,
        centerNeed: WEB_RULES.fusionCenter,
        outer: count,
        outerNeed: WEB_RULES.fusionOuter,
      });
    }
    if (counts.cores >= fusionSlots(account)) return refuse('noFusionSlot');
  } else if (node.kind === 'keystone' && counts.keystones >= WEB_RULES.keystonesHeld) {
    return refuse('keystoneCap');
  }
  return null;
}

/**
 * Whether `id` can take one more rank now, and its price (§4.5). The rows, the first failing one
 * answering:
 *  1. unknown: not in this web; locked when the id grammar names a board the scope locks (R1)
 *  2. owned, maxRank: the signature; an owned 1-rank node; a ranked node at its last rank
 *  3. hidden, locked: the node's outer, or its fusion's, is hidden or locked (§4.6)
 *  4. challengeKeystone, challengeOuter: only with `challenge` (F51)
 *  5. needsPrestige, otherAscendancy (F10)
 *  6. notAdjacent: rank 0 and no owned neighbour, the signature counting as owned
 *  7–11. centerGate, outerGate, fusionGate, noFusionSlot, keystoneCap
 *  12. notEnoughShards, notEnoughCores, notEnoughResonance
 * A refused gate carries its progress; every other refusal null.
 */
export function canBuy(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  id: string,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
  challenge?: ChallengeRules,
): BuyCheck {
  const node = web.byId.get(id);
  if (node === undefined) {
    // R1: a locked board has no nodes (§4.3), so its ids are found through the grammar (C6.2).
    const board = boardIdOf(id);
    const locked =
      board !== null && web.boards.some((slot) => slot.id === board && slot.status === 'locked');
    return refuse(locked ? 'locked' : 'unknown');
  }
  const rank = storedRank(progress, id);
  if (node.kind === 'signature' || (node.ranks === 1 && rank >= 1)) return refuse('owned');
  if (typeof node.ranks === 'number' && rank >= node.ranks) return refuse('maxRank');
  const standing = standingOf(web, progress);
  const early = rows3to5(web, progress, node, standing, challenge);
  if (early !== null) return early;
  if (rank === 0) {
    const neighbours = web.neighbours.get(id) ?? [];
    if (!neighbours.some((other) => other === web.root || storedRank(progress, other) > 0)) {
      return refuse('notAdjacent');
    }
  }
  const gated = rows7to11(account, node, leftOut(standing.counts, node, rank));
  if (gated !== null) return gated;
  const price = priceOf(node, standing.counts, economy);
  if (lt(progress.wallet.shards, price.shards)) return refuse('notEnoughShards');
  if (progress.wallet.cores < price.cores) return refuse('notEnoughCores');
  if (progress.wallet.resonance < price.resonance) return refuse('notEnoughResonance');
  return { ok: true, price };
}

/**
 * One more rank of `id`: canBuy, which it throws on (callers check first), then the price moved
 * from the wallet to spent, and the chain recorded on the first purchase of an ascendancy node.
 */
export function buy(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  id: string,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
  challenge?: ChallengeRules,
): CharacterProgress {
  const check = canBuy(web, progress, account, id, economy, challenge);
  if (!check.ok) {
    throw new Error(
      `buy '${id}' (character '${web.character}', scope '${web.scope.name}'): ${check.reason}`,
    );
  }
  const { price } = check;
  const { wallet, spent } = progress;
  return {
    ...progress,
    ranks: { ...progress.ranks, [id]: storedRank(progress, id) + 1 },
    wallet: {
      shards: sub(wallet.shards, price.shards),
      cores: wallet.cores - price.cores,
      resonance: wallet.resonance - price.resonance,
    },
    spent: {
      shards: add(spent.shards, price.shards),
      cores: spent.cores + price.cores,
      resonance: spent.resonance + price.resonance,
    },
    ascendancy: progress.ascendancy ?? chainOfBoard((web.byId.get(id) as WebNode).board),
  };
}

/** The nodes reachable from the root through `kept` nodes. */
function reachable(web: AssembledWeb, kept: ReadonlyMap<string, number>): Set<string> {
  const seen = new Set([web.root]);
  const queue = [web.root];
  for (let i = 0; i < queue.length; i++) {
    for (const other of web.neighbours.get(queue[i] as string) ?? []) {
      if (!seen.has(other) && kept.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return seen;
}

/**
 * legalize's fixpoint over `entries` (R4). Ids the web does not hold, the signature (never stored;
 * D5) and ranks that are not a number of at least 1 drop first, in key order, and a rank above the
 * node's count is cut to it. Then a node stays only while it is reachable from the root through
 * kept nodes and passes rows 3–5 and 7–11 as if it held rank 0 while every other kept node keeps
 * its ranks; each pass drops the last illegal node in web order, until none is.
 */
function legalRanks(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  entries: readonly (readonly [string, number])[],
  challenge: ChallengeRules | undefined,
): { readonly kept: Map<string, number>; readonly dropped: string[] } {
  const dropped: string[] = [];
  const kept = new Map<string, number>();
  for (const [id, stored] of entries) {
    const node = web.byId.get(id);
    const rank = rankOf(stored);
    if (node === undefined || node.kind === 'signature' || rank === 0) dropped.push(id);
    else kept.set(id, typeof node.ranks === 'number' ? Math.min(rank, node.ranks) : rank);
  }
  for (;;) {
    const view: CharacterProgress = { ...progress, ranks: Object.fromEntries(kept) };
    const standing = standingOf(web, view);
    const reached = reachable(web, kept);
    let last: string | null = null;
    for (const node of web.nodes) {
      const rank = kept.get(node.id);
      if (rank === undefined) continue;
      const legal =
        reached.has(node.id) &&
        rows3to5(web, view, node, standing, challenge) === null &&
        rows7to11(account, node, leftOut(standing.counts, node, rank)) === null;
      if (!legal) last = node.id;
    }
    if (last === null) return { kept, dropped };
    kept.delete(last);
    dropped.push(last);
  }
}

/** A refund of `difference` capped by what was spent: min(spent, difference), never below 0. */
function capped(spent: Num, difference: Num): Num {
  const refund = min(spent, difference);
  return gt(refund, ZERO) ? refund : ZERO;
}

/** capped for a count of cores or 迴響. */
const cappedCount = (spent: number, difference: number): number =>
  spent > 0 && difference > 0 ? Math.min(spent, difference) : 0;

/**
 * The legal progress kept from `entries` (legalRanks), with the refund of what that drops from
 * `progress`: min(spent, canonicalCost(progress) − canonicalCost(kept)) per currency.
 */
function settle(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  entries: readonly (readonly [string, number])[],
  economy: WebEconomy,
  challenge: ChallengeRules | undefined,
): { readonly progress: CharacterProgress; readonly dropped: string[]; readonly refund: Price } {
  const { kept, dropped } = legalRanks(web, progress, account, entries, challenge);
  const after: CharacterProgress = { ...progress, ranks: Object.fromEntries(kept) };
  const before = canonicalCost(web, progress, economy);
  const now = canonicalCost(web, after, economy);
  const { wallet, spent } = progress;
  const refund: Price = {
    shards: capped(spent.shards, sub(before.shards, now.shards)),
    cores: cappedCount(spent.cores, before.cores - now.cores),
    resonance: cappedCount(spent.resonance, before.resonance - now.resonance),
  };
  return {
    progress: {
      ...after,
      wallet: {
        shards: add(wallet.shards, refund.shards),
        cores: wallet.cores + refund.cores,
        resonance: wallet.resonance + refund.resonance,
      },
      spent: {
        shards: sub(spent.shards, refund.shards),
        cores: spent.cores - refund.cores,
        resonance: spent.resonance - refund.resonance,
      },
    },
    dropped,
    refund,
  };
}

/** progress.ranks without `id`. */
const entriesWithout = (progress: CharacterProgress, id: string): [string, number][] =>
  Object.entries(progress.ranks).filter(([key]) => key !== id);

/**
 * Every rank of `id` refunded, and then every node that only `id` connected or unlocked, through
 * legalize (AMB40; F16): min(spent, canonicalCost(before) − canonicalCost(after)) per currency
 * comes back. The chosen ascendancy stays (F10). An id that is not owned removes nothing.
 */
export function refundNode(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  id: string,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
  challenge?: ChallengeRules,
): CharacterProgress {
  return settle(web, progress, account, entriesWithout(progress, id), economy, challenge).progress;
}

/** What refundNode would drop, `id` first, in drop order, and refund (B1's confirm dialog). */
export function refundPreview(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  id: string,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
  challenge?: ChallengeRules,
): RefundPreview {
  const { dropped, refund } = settle(
    web,
    progress,
    account,
    entriesWithout(progress, id),
    economy,
    challenge,
  );
  return { dropped: Object.hasOwn(progress.ranks, id) ? [id, ...dropped] : dropped, refund };
}

/** Everything spent back in the wallet, nothing owned; the chosen ascendancy stays (gd:979, F10). */
export function refundAll(progress: CharacterProgress): CharacterProgress {
  const { wallet, spent } = progress;
  return {
    ...progress,
    ranks: {},
    wallet: {
      shards: add(wallet.shards, spent.shards),
      cores: wallet.cores + spent.cores,
      resonance: wallet.resonance + spent.resonance,
    },
    spent: EMPTY_WALLET,
  };
}

/**
 * The legal part of `progress` (§4.5; R4): a node stays only while it is in the web, visible,
 * reachable from the root through kept nodes and buyable again counting the other kept nodes
 * (gates, slots, the ★ cap, ascendancy and, with `challenge`, the challenge's limits), repeated to a
 * fixpoint; ties drop in reverse web order. What drops is refunded as refundNode refunds, and the
 * dropped ids come back in drop order. C8's loader and B5's loadouts call it; it never throws.
 */
export function legalize(
  web: AssembledWeb,
  progress: CharacterProgress,
  account: AccountProgress,
  economy: WebEconomy = DEFAULT_WEB_ECONOMY,
  challenge?: ChallengeRules,
): { readonly progress: CharacterProgress; readonly dropped: readonly string[] } {
  const settled = settle(
    web,
    progress,
    account,
    Object.entries(progress.ranks),
    economy,
    challenge,
  );
  return { progress: settled.progress, dropped: settled.dropped };
}

/** A spoke's 「中心 8/8・毒 3/6」 (gd:295): fusion c.o's gate and whether it is met. */
export function fusionProgress(
  web: AssembledWeb,
  progress: CharacterProgress,
  outer: OuterId,
): GateProgress & { readonly unlocked: boolean } {
  const counts = boardCounts(web, progress);
  const count = counts.outers[outer] ?? 0;
  return {
    center: counts.center,
    centerNeed: WEB_RULES.fusionCenter,
    outer: count,
    outerNeed: WEB_RULES.fusionOuter,
    unlocked: counts.center >= WEB_RULES.fusionCenter && count >= WEB_RULES.fusionOuter,
  };
}

/**
 * The owned cores' outers in fusion-slot order, which is clock order (F31): web.nodes holds the
 * fusions in clock order (assembleWeb, §4.3). 蜂巢's drone skins read it.
 */
export function fusionSlotOrder(
  web: AssembledWeb,
  progress: CharacterProgress,
): readonly OuterId[] {
  const order: OuterId[] = [];
  for (const node of web.nodes) {
    if (node.kind !== 'core' || storedRank(progress, node.id) === 0) continue;
    const outer = outerOfBoard(node.board);
    if (outer !== null) order.push(outer);
  }
  return order;
}
