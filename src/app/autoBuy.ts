/**
 * PLACEHOLDER (M0 only): spends shards between runs so progression is visible before the
 * talent web UI exists. Replaced by player allocation in M1 (docs/MILESTONES.md).
 */

import { lt } from '../core/num';
import type { GameData, TalentNode } from '../data/types';
import { allocate, canAllocate, nodePrice } from '../meta';
import type { EconomyConfig, MetaState } from '../meta';

export interface Purchase {
  readonly id: string;
  /** Purchases of this node in one autoBuy call (ranks for repeatable nodes, else 1). */
  readonly count: number;
}

/** Stops a misconfigured economy (e.g. a free repeatable node) from looping forever. */
const MAX_PURCHASES = 1000;

/**
 * Repeatedly buys the cheapest node that can be allocated (fewest shards, then fewest cores,
 * then data order) until nothing is affordable. Keystones are skipped: they are build-defining
 * choices (glassCannon sets life to 1) that a placeholder should not make for the player.
 * Returns the purchases in first-bought order.
 */
export function autoBuyTalents(
  meta: MetaState,
  data: GameData,
  economy: EconomyConfig,
): Purchase[] {
  const counts = new Map<string, number>();
  for (let n = 0; n < MAX_PURCHASES; n++) {
    const node = cheapestAffordable(meta, data, economy);
    if (node === null) break;
    allocate(meta, node.id, data, economy);
    counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
  }
  return Array.from(counts, ([id, count]) => ({ id, count }));
}

function cheapestAffordable(
  meta: Readonly<MetaState>,
  data: GameData,
  economy: EconomyConfig,
): TalentNode | null {
  let best: TalentNode | null = null;
  let bestPrice: ReturnType<typeof nodePrice> | null = null;
  for (const node of data.talents) {
    if (node.kind === 'keystone' || !canAllocate(meta, node.id, data, economy).ok) continue;
    const price = nodePrice(meta, node, economy);
    if (
      bestPrice === null ||
      lt(price.shards, bestPrice.shards) ||
      (!lt(bestPrice.shards, price.shards) && price.cores < bestPrice.cores)
    ) {
      best = node;
      bestPrice = price;
    }
  }
  return best;
}
