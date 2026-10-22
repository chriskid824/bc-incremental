/**
 * The leaf of src/meta/web (docs/v3 C6 design L8; the lead's ruling R2): the purchase rules'
 * numbers, the price curve of each node kind and the board counts, which price.ts, reveal.ts and
 * rules.ts all read. rules.ts re-exports WEB_RULES and boardCounts and price.ts PRICE_CURVE_OF,
 * where §3.8 puts them; this module imports types only, so no value-import cycle runs through
 * src/meta/web (src/meta/web/importOrder.test.ts). index.ts re-exports none of its helpers.
 */

import type { OuterId } from '../../data/sources';
import type { AssembledWeb, BoardId, WebNodeKind } from '../../data/web/types';
import type { BoardCounts, CharacterProgress } from './types';

/**
 * The purchase rules' numbers (impl:388-393; gd:290-306; D6, D18, D20). V10 pins fusionCenter and
 * fusionOuter (src/meta/web/rules.test.ts; src/data cannot import src/meta).
 */
export const WEB_RULES = {
  /** Counted center nodes the center threshold needs (D18). */
  centerThreshold: 12,
  /** Counted nodes of its board an outer threshold needs. */
  outerThreshold: 8,
  /** A fusion core's gate: counted center nodes, and counted nodes of its outer (impl:390). */
  fusionCenter: 8,
  fusionOuter: 6,
  fusionSlots: 2,
  /** After any character beats 奇點 (gd:788). */
  fusionSlotsAfterSingularity: 3,
  /** ★ owned at once; cores and ascendancy finals are other kinds (D6). */
  keystonesHeld: 2,
  /** Best waves that reveal revealAt15, then all 11 outers (D20). */
  revealWaves: [15, 30],
} as const;

/** The shard curve each kind's purchases take (D19); signature, ★ and ascendancy nodes cost no shards. */
export const PRICE_CURVE_OF: Readonly<Record<WebNodeKind, 'step' | 'mastery' | 'might' | null>> = {
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
};

/**
 * The kinds a path never passes through unless it is the target (§4.5): a gate, a slot, the ★ cap
 * or a prestige stands before each.
 */
export const GATED_KINDS: ReadonlySet<WebNodeKind> = new Set<WebNodeKind>([
  'threshold',
  'core',
  'keystone',
  'asc',
  'ascFinal',
]);

/**
 * The ranks a stored value means: the value rounded down when it is a finite number of at least 1,
 * else 0. Legal progress stores whole ranks of at least 1; anything else stored (C8's migrations, a
 * bad loadout) counts as not owned, and legalize drops it.
 */
export function rankOf(stored: unknown): number {
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= 1
    ? Math.floor(stored)
    : 0;
}

/** The ranks `progress` holds of `id` (rankOf its stored value). */
export function storedRank(progress: CharacterProgress, id: string): number {
  return rankOf(Object.hasOwn(progress.ranks, id) ? progress.ranks[id] : undefined);
}

/** True for a character's center board, `<c>.center` (an ascendancy's slug may be 'center'). */
export const isCenterBoard = (board: BoardId): boolean =>
  board.split('.').length === 2 && board.endsWith('.center');

/** The outer of an outer board `outer.<o>` or a fusion board `fusion.<c>.<o>`; null for any other. */
export function outerOfBoard(board: BoardId): OuterId | null {
  if (board.startsWith('outer.')) return board.slice('outer.'.length) as OuterId;
  if (board.startsWith('fusion.')) return board.slice(board.lastIndexOf('.') + 1) as OuterId;
  return null;
}

/** The slug of an ascendancy board `<c>.asc.<slug>`; null for any other board. */
export function chainOfBoard(board: BoardId): string | null {
  const parts = board.split('.');
  return parts.length === 3 && parts[1] === 'asc' ? (parts[2] as string) : null;
}

/**
 * What the gates and prices count (D18, D19): distinct owned nodes per board, the signature never
 * (D5), a node of any rank once, an outer's entry and the center's connectors, ★ and threshold
 * included, fusion nodes toward no board; the owned cores and ★; and the purchases on each price
 * curve, every rank counted. A node's own gate leaves the node out (rules.ts), not this count.
 */
export function boardCounts(web: AssembledWeb, progress: CharacterProgress): BoardCounts {
  let center = 0;
  let cores = 0;
  let keystones = 0;
  let stepPurchases = 0;
  let masteryRanks = 0;
  let mightRanks = 0;
  const outers: Partial<Record<OuterId, number>> = {};
  for (const node of web.nodes) {
    if (node.kind === 'signature') continue;
    const rank = storedRank(progress, node.id);
    if (rank === 0) continue;
    if (isCenterBoard(node.board)) center += 1;
    else if (node.board.startsWith('outer.')) {
      const outer = outerOfBoard(node.board) as OuterId;
      outers[outer] = (outers[outer] ?? 0) + 1;
    }
    if (node.kind === 'core') cores += 1;
    else if (node.kind === 'keystone') keystones += 1;
    const curve = PRICE_CURVE_OF[node.kind];
    if (curve === 'step') stepPurchases += rank;
    else if (curve === 'mastery') masteryRanks += rank;
    else if (curve === 'might') mightRanks += rank;
  }
  return { center, outers, cores, keystones, stepPurchases, masteryRanks, mightRanks };
}
